// Writes a PDF in the browser, with no print dialog in the way.
//
// The layout is still the browser's. The print document is laid out in a hidden
// frame at exactly the page's content width, and this walks the *result* —
// every line box, image and filled rectangle the browser produced — and writes
// each one into a PDF at its measured position. jsPDF is only the writer; it is
// never asked to decide where anything goes.
//
// That distinction is the whole point. The export this replaced on the web went
// through `window.print()`, which means a preview, a dialog, and a destination
// the page cannot choose — pick a virtual printer there and every word becomes
// a picture. Laying out text by hand instead, the way the original jsPDF export
// did, produces the other failure: a layout engine that disagrees with the one
// the user is looking at.

import type { jsPDF } from 'jspdf'

const PT_PER_PX = 72 / 96

/** Paint order within the document: positioned boxes sit above flow content. */
interface Painted {
  layer: number
  order: number
}

interface BoxItem extends Painted {
  kind: 'box'
  x: number
  y: number
  width: number
  height: number
  radius: number
  color: [number, number, number]
}

interface TextItem extends Painted {
  kind: 'text'
  x: number
  y: number
  text: string
  sizePx: number
  font: 'helvetica' | 'courier' | 'times'
  style: 'normal' | 'bold' | 'italic' | 'bolditalic'
  color: [number, number, number]
  /** List markers hang in the gutter and are set against its right edge. */
  align?: 'left' | 'right'
}

interface ImageItem extends Painted {
  kind: 'image'
  x: number
  y: number
  width: number
  height: number
  element: HTMLImageElement
}

/**
 * A run of text the built-in fonts cannot spell, drawn from a canvas instead.
 *
 * jsPDF's standard fonts are Latin-1 only. Rather than let a rating turn into
 * `&&&&&&&` or a name into mojibake, the browser draws that run with the font
 * it laid it out in and the picture goes in at the same position. It is no
 * longer selectable, but it is still the right glyphs.
 */
interface GlyphItem extends Painted {
  kind: 'glyph'
  x: number
  y: number
  width: number
  height: number
  text: string
  sizePx: number
  fontCss: string
  color: [number, number, number]
}

type DrawItem = BoxItem | TextItem | ImageItem | GlyphItem

export interface PdfRenderOptions {
  /** Page size in CSS pixels. */
  paper: { width: number, height: number }
  /** Page margin in CSS pixels. */
  margin: number
  onProgress?: (stage: string, data?: Record<string, unknown>) => void
}

function parseColor(value: string): [number, number, number] | null {
  const match = value.match(/rgba?\(([^)]+)\)/)
  if (!match) {
    return null
  }

  const parts = match[1].split(',').map(part => Number.parseFloat(part.trim()))
  const alpha = parts.length > 3 ? parts[3] : 1
  if (!(alpha > 0.02)) {
    return null
  }

  return [parts[0], parts[1], parts[2]]
}

function fontFor(family: string): TextItem['font'] {
  const lower = family.toLowerCase()
  if (/mono|consol|courier/.test(lower)) {
    return 'courier'
  }
  if (/serif/.test(lower) && !/sans-serif/.test(lower)) {
    return 'times'
  }
  return 'helvetica'
}

function styleFor(weight: string, style: string): TextItem['style'] {
  const bold = Number.parseInt(weight, 10) >= 600 || weight === 'bold'
  const italic = style === 'italic' || style === 'oblique'
  if (bold && italic) {
    return 'bolditalic'
  }
  if (bold) {
    return 'bold'
  }
  if (italic) {
    return 'italic'
  }
  return 'normal'
}

// Punctuation the editor produces that has an exact Latin-1 counterpart. Worth
// substituting so a curly quote does not cost a whole line its selectability.
const PUNCTUATION_FALLBACKS: Record<string, string> = {
  '\u2018': '\'',
  '\u2019': '\'',
  '\u201A': '\'',
  '\u201C': '"',
  '\u201D': '"',
  '\u201E': '"',
  '\u2013': '-',
  '\u2014': '--',
  '\u2026': '...',
  '\u00A0': ' ',
  '\u2022': '\u00B7',
  '\u2212': '-',
}

function simplifyPunctuation(text: string): string {
  return text.replace(/[\u2018\u2019\u201A\u201C\u201D\u201E\u2013\u2014\u2026\u00A0\u2022\u2212]/g, char => PUNCTUATION_FALLBACKS[char])
}

// WinAnsi is what the built-in fonts cover; anything above it has to be drawn.
function isRepresentable(text: string): boolean {
  for (const char of text) {
    if (char.codePointAt(0)! > 0xFF) {
      return false
    }
  }
  return true
}

/**
 * How far above the flow an element paints.
 *
 * Only an explicit numeric z-index counts. Treating every positioned element as
 * raised put the chart's own background — which is `position: relative` — above
 * the tiles inside it, and painted the whole chart out.
 */
function layerOf(style: CSSStyleDeclaration): number {
  const zIndex = style.zIndex
  return /^-?\d+$/.test(zIndex) ? Number.parseInt(zIndex, 10) : 0
}

// The gap the browser leaves between an outside marker and its content.
const MARKER_GAP_PX = 4

function sizeOf(style: CSSStyleDeclaration): number {
  return Number.parseFloat(style.fontSize) || 12
}

function markerTextFor(element: HTMLElement, style: CSSStyleDeclaration): string {
  if (style.listStyleType === 'none') {
    return ''
  }

  const parent = element.parentElement
  if (parent && parent.tagName === 'OL') {
    const start = Number.parseInt(parent.getAttribute('start') || '1', 10) || 1
    const index = Array.from(parent.children).indexOf(element)
    return `${start + index}.`
  }

  return '•'
}

function radiusOf(style: CSSStyleDeclaration, scale: number): number {
  const radius = Number.parseFloat(style.borderTopLeftRadius) || 0
  return radius * scale
}

/**
 * Splits a text node into the lines the browser actually produced.
 *
 * Ranges are measured word by word and a new line starts wherever the box
 * jumps: the browser's own line breaking is read back rather than recomputed,
 * which is what keeps the PDF agreeing with what was on screen.
 */
function lineRunsOf(node: Text, doc: Document): Array<{ text: string, rect: DOMRect }> {
  const text = node.data
  if (!text.trim()) {
    return []
  }

  const range = doc.createRange()
  const runs: Array<{ text: string, rect: DOMRect }> = []

  // Word boundaries, keeping the whitespace with the preceding word so the
  // offsets stay exact.
  const boundaries: number[] = []
  const pattern = /\S+\s*/g
  let match = pattern.exec(text)
  while (match) {
    boundaries.push(match.index, match.index + match[0].length)
    match = pattern.exec(text)
  }

  let lineStart = -1
  let lineEnd = -1
  let lineTop: number | null = null

  const flush = () => {
    if (lineStart < 0) {
      return
    }
    range.setStart(node, lineStart)
    range.setEnd(node, lineEnd)
    const rect = range.getBoundingClientRect()
    const value = text.slice(lineStart, lineEnd).trim()
    if (value && rect.width > 0) {
      runs.push({ text: value, rect })
    }
  }

  for (let i = 0; i < boundaries.length; i += 2) {
    const start = boundaries[i]
    const end = boundaries[i + 1]
    range.setStart(node, start)
    range.setEnd(node, end)
    const rect = range.getBoundingClientRect()

    if (lineTop === null || Math.abs(rect.top - lineTop) > 1) {
      flush()
      lineStart = start
      lineTop = rect.top
    }
    lineEnd = end
  }

  flush()
  return runs
}

/**
 * Every visible thing inside `root`, in painting order, positioned relative to
 * `origin`.
 *
 * `scale` carries any CSS transform above this subtree: the chart is drawn at
 * full size and scaled as a block, and a transform moves the boxes the browser
 * reports but not the font sizes it computes.
 */
function collectItems(
  root: HTMLElement,
  origin: { x: number, y: number },
  scale: number,
): DrawItem[] {
  const doc = root.ownerDocument
  const view = doc.defaultView
  if (!view) {
    return []
  }

  const items: DrawItem[] = []
  let order = 0

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  let node: Node | null = root

  while (node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement
      const style = view.getComputedStyle(element)

      if (style.display === 'none' || style.visibility === 'hidden' || Number.parseFloat(style.opacity) < 0.05) {
        // Skip the whole subtree.
        let next = walker.nextNode()
        while (next && element.contains(next)) {
          next = walker.nextNode()
        }
        node = next
        continue
      }

      const rect = element.getBoundingClientRect()
      const layer = layerOf(style)

      const background = parseColor(style.backgroundColor)
      if (background && rect.width > 0 && rect.height > 0) {
        items.push({
          kind: 'box',
          x: rect.left - origin.x,
          y: rect.top - origin.y,
          width: rect.width,
          height: rect.height,
          radius: radiusOf(style, scale),
          color: background,
          layer,
          order: order++,
        })
      }

      // Borders are drawn as thin filled rectangles; the document only ever
      // uses solid single-colour ones.
      for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
        const width = Number.parseFloat(style[`border${side}Width` as 'borderTopWidth']) || 0
        if (width <= 0) {
          continue
        }
        const color = parseColor(style[`border${side}Color` as 'borderTopColor'])
        if (!color) {
          continue
        }
        const scaled = width * scale
        const box = {
          Top: { x: rect.left, y: rect.top, width: rect.width, height: scaled },
          Bottom: { x: rect.left, y: rect.bottom - scaled, width: rect.width, height: scaled },
          Left: { x: rect.left, y: rect.top, width: scaled, height: rect.height },
          Right: { x: rect.right - scaled, y: rect.top, width: scaled, height: rect.height },
        }[side]

        items.push({
          kind: 'box',
          x: box.x - origin.x,
          y: box.y - origin.y,
          width: box.width,
          height: box.height,
          radius: 0,
          color,
          layer,
          order: order++,
        })
      }

      // List markers are generated content, so there is no text node to walk;
      // a notes page full of bullet points would otherwise come out as bare
      // indented lines.
      if (style.display === 'list-item') {
        const marker = markerTextFor(element, style)
        if (marker) {
          const lineHeight = Number.parseFloat(style.lineHeight) || sizeOf(style) * 1.2
          items.push({
            kind: 'text',
            x: rect.left - origin.x - MARKER_GAP_PX * scale,
            y: rect.top - origin.y + (lineHeight * scale) / 2,
            text: marker,
            sizePx: sizeOf(style) * scale,
            font: fontFor(style.fontFamily),
            style: styleFor(style.fontWeight, style.fontStyle),
            color: parseColor(style.color) || [0, 0, 0],
            align: 'right',
            layer,
            order: order++,
          })
        }
      }

      if (element instanceof view.HTMLImageElement && element.naturalWidth > 0) {
        items.push({
          kind: 'image',
          x: rect.left - origin.x,
          y: rect.top - origin.y,
          width: rect.width,
          height: rect.height,
          element,
          layer,
          order: order++,
        })
      }
    }
    else if (node.nodeType === Node.TEXT_NODE) {
      const textNode = node as Text
      const parent = textNode.parentElement
      if (parent) {
        const style = view.getComputedStyle(parent)
        const color = parseColor(style.color) || [0, 0, 0]
        const sizePx = (Number.parseFloat(style.fontSize) || 12) * scale
        const font = fontFor(style.fontFamily)
        const textStyle = styleFor(style.fontWeight, style.fontStyle)
        const layer = layerOf(style)

        for (const run of lineRunsOf(textNode, doc)) {
          const simplified = simplifyPunctuation(run.text)

          if (!isRepresentable(simplified)) {
            items.push({
              kind: 'glyph',
              x: run.rect.left - origin.x,
              y: run.rect.top - origin.y,
              width: run.rect.width,
              height: run.rect.height,
              text: run.text,
              sizePx,
              fontCss: `${style.fontStyle} ${style.fontWeight} ${sizePx}px ${style.fontFamily}`,
              color,
              layer,
              order: order++,
            })
            continue
          }

          items.push({
            kind: 'text',
            x: run.rect.left - origin.x,
            // Vertically centred in its line box, which holds up whatever the
            // line-height is.
            y: run.rect.top - origin.y + run.rect.height / 2,
            text: simplified,
            sizePx,
            font,
            style: textStyle,
            color,
            layer,
            order: order++,
          })
        }
      }
    }

    node = walker.nextNode()
  }

  // Stable sort: flow content first, then positioned boxes by z-index.
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => a.item.layer - b.item.layer || a.index - b.index)
    .map(entry => entry.item)
}

/** A block that should not be split across pages if it can be helped. */
interface Block {
  top: number
  height: number
  items: DrawItem[]
}

function blocksFrom(container: HTMLElement, origin: { x: number, y: number }): Block[] {
  return Array.from(container.children).map((child) => {
    const element = child as HTMLElement
    const rect = element.getBoundingClientRect()
    return {
      top: rect.top - origin.y,
      height: rect.height,
      items: collectItems(element, origin, 1),
    }
  })
}

/**
 * Where each page starts, in the flow's own coordinates.
 *
 * A block is kept whole where it fits on a page of its own; one that is taller
 * than a page is broken at the nearest item boundary above the limit, so a line
 * of text is never cut in half.
 */
function pageBreaksFor(blocks: Block[], contentHeight: number): number[] {
  const breaks = [0]
  let top = 0

  for (const block of blocks) {
    const bottom = block.top + block.height
    if (bottom - top <= contentHeight) {
      continue
    }

    if (block.height <= contentHeight) {
      if (block.top > top) {
        top = block.top
        breaks.push(top)
      }
      continue
    }

    const candidates = block.items.map(item => item.y).sort((a, b) => a - b)
    while (bottom - top > contentHeight) {
      const limit = top + contentHeight
      let next = -1
      for (const candidate of candidates) {
        if (candidate > top && candidate <= limit) {
          next = candidate
        }
      }
      top = next > 0 ? next : limit
      breaks.push(top)
    }
  }

  return breaks
}

function pageIndexFor(breaks: number[], y: number): number {
  let index = 0
  for (let i = 1; i < breaks.length; i += 1) {
    if (y >= breaks[i] - 0.5) {
      index = i
    }
  }
  return index
}

function drawItems(doc: jsPDF, items: DrawItem[], offsetX: number, offsetY: number, imageData: Map<HTMLImageElement, EncodedImage>): void {
  for (const item of items) {
    const x = (item.x + offsetX) * PT_PER_PX
    const y = (item.y + offsetY) * PT_PER_PX

    if (item.kind === 'box') {
      doc.setFillColor(item.color[0], item.color[1], item.color[2])
      const width = item.width * PT_PER_PX
      const height = item.height * PT_PER_PX
      const radius = Math.min(item.radius * PT_PER_PX, width / 2, height / 2)
      if (radius > 0.5) {
        doc.roundedRect(x, y, width, height, radius, radius, 'F')
      }
      else {
        doc.rect(x, y, width, height, 'F')
      }
      continue
    }

    if (item.kind === 'image') {
      const encoded = imageData.get(item.element)
      if (!encoded) {
        continue
      }
      try {
        doc.addImage(encoded.data, encoded.format, x, y, item.width * PT_PER_PX, item.height * PT_PER_PX, undefined, 'FAST')
      }
      catch {
        // A single unreadable cover is not worth failing the export over.
      }
      continue
    }

    if (item.kind === 'glyph') {
      const rendered = renderGlyphRun(item)
      if (rendered) {
        doc.addImage(rendered, 'PNG', x, y, item.width * PT_PER_PX, item.height * PT_PER_PX, undefined, 'FAST')
      }
      continue
    }

    doc.setTextColor(item.color[0], item.color[1], item.color[2])
    doc.setFont(item.font, item.style)
    doc.setFontSize(item.sizePx * PT_PER_PX)
    doc.text(item.text, x, y, { baseline: 'middle', align: item.align || 'left' })
  }
}

const glyphCache = new Map<string, string>()

/** Draws one unrepresentable run at 4x and hands back a transparent PNG. */
function renderGlyphRun(item: GlyphItem): string | null {
  const key = `${item.fontCss}|${item.color.join(',')}|${item.text}`
  const cached = glyphCache.get(key)
  if (cached) {
    return cached
  }

  const scale = 4
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(item.width * scale))
  canvas.height = Math.max(1, Math.ceil(item.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    return null
  }

  context.scale(scale, scale)
  context.font = item.fontCss
  context.fillStyle = `rgb(${item.color[0]},${item.color[1]},${item.color[2]})`
  context.textBaseline = 'middle'
  context.fillText(item.text, 0, item.height / 2)

  const data = canvas.toDataURL('image/png')
  glyphCache.set(key, data)
  return data
}

export interface PdfRenderResult {
  blob: Blob
  pages: number
  images: number
  textRuns: number
  /** Covers that could not be fetched or decoded and were left out. */
  failedImages: number
}

/**
 * Renders an already laid-out print document to a PDF.
 *
 * `frame` must contain the document, sized to the page's content box.
 */
export async function renderFrameToPdf(
  frame: HTMLIFrameElement,
  options: PdfRenderOptions,
): Promise<PdfRenderResult> {
  const doc = frame.contentDocument
  const view = frame.contentWindow
  if (!doc || !view) {
    throw new Error('The print document is not reachable')
  }

  const { jsPDF: JsPdf } = await import('jspdf')
  const report = options.onProgress || (() => {})

  const pdf = new JsPdf({
    unit: 'pt',
    format: [options.paper.width * PT_PER_PX, options.paper.height * PT_PER_PX],
    orientation: options.paper.width > options.paper.height ? 'landscape' : 'portrait',
    compress: true,
  })

  const contentHeight = options.paper.height - options.margin * 2
  const pages: DrawItem[][] = []

  // --- the chart, on a page of its own -----------------------------------
  const poster = doc.querySelector('.pl-poster') as HTMLElement | null
  const scaleBox = doc.querySelector('.pl-poster-scale') as HTMLElement | null

  if (poster && scaleBox) {
    const posterRect = scaleBox.getBoundingClientRect()
    const chart = doc.getElementById('pl-chart')
    // The fit script scales the chart as one block; read that back so text
    // inside it is drawn at the size it appears, not the size it was authored.
    const chartScale = chart && chart.offsetWidth
      ? chart.getBoundingClientRect().width / chart.offsetWidth
      : 1

    pages.push(collectItems(scaleBox, { x: posterRect.left, y: posterRect.top }, chartScale))
    report('poster:collected', { items: pages[0].length, chartScale })
  }

  // --- the notes, flowing ------------------------------------------------
  const details = doc.querySelector('.pl-details') as HTMLElement | null
  if (details) {
    const detailsRect = details.getBoundingClientRect()
    const blocks = blocksFrom(details, { x: detailsRect.left, y: detailsRect.top })
    const breaks = pageBreaksFor(blocks, contentHeight)
    report('details:collected', { blocks: blocks.length, pages: breaks.length })

    const detailPages: DrawItem[][] = breaks.map(() => [])

    // Assigned by position rather than by walking in order: items come out in
    // painting order, which is not the order they appear down the page, so
    // stepping through them and moving the page boundary as we went stranded
    // whole pages' worth of content off the sheet.
    for (const block of blocks) {
      for (const item of block.items) {
        const page = pageIndexFor(breaks, item.y)
        detailPages[page].push({ ...item, y: item.y - breaks[page] } as DrawItem)
      }
    }

    for (const page of detailPages) {
      if (page.length > 0) {
        pages.push(page)
      }
    }
  }

  // --- images, once each -------------------------------------------------
  const imageDataResult = await encodeImages(pages, report)
  const imageData = imageDataResult.encoded

  // --- emit --------------------------------------------------------------
  let textRuns = 0
  pages.forEach((items, index) => {
    if (index > 0) {
      pdf.addPage()
    }
    textRuns += items.filter(item => item.kind === 'text').length

    // The chart page centres its block; the notes sit at the margin.
    const offsetX = options.margin
    const offsetY = options.margin
    drawItems(pdf, items, offsetX, offsetY, imageData)
  })

  report('pdf:emitted', { pages: pages.length, textRuns, images: imageData.size })

  return {
    blob: pdf.output('blob'),
    pages: pages.length,
    images: imageData.size,
    textRuns,
    failedImages: imageDataResult.failed,
  }
}

/**
 * Turns each distinct image into bytes jsPDF can embed.
 *
 * JPEG and PNG go in as they are — jsPDF stores those formats directly, so
 * there is nothing to gain from touching the pixels. WebP does not: jsPDF
 * decodes and re-encodes it in JavaScript, which is far slower than asking the
 * browser to do the same work natively through a canvas.
 */
async function encodeImages(
  pages: DrawItem[][],
  report: (stage: string, data?: Record<string, unknown>) => void,
): Promise<{ encoded: Map<HTMLImageElement, EncodedImage>, failed: number }> {
  const encoded = new Map<HTMLImageElement, EncodedImage>()
  const bySource = new Map<string, Promise<EncodedImage>>()
  const elements: HTMLImageElement[] = []

  for (const page of pages) {
    for (const item of page) {
      if (item.kind === 'image') {
        elements.push(item.element)
      }
    }
  }

  // One job per distinct source, run a few at a time: the remote covers are
  // network-bound and serialising them was the whole cost of this stage.
  const sources = [...new Set(elements.map(element => element.src))]
  const byElement = new Map<string, HTMLImageElement>()
  for (const element of elements) {
    if (!byElement.has(element.src)) {
      byElement.set(element.src, element)
    }
  }

  const CONCURRENCY = 8
  let cursor = 0
  const workers = Array.from({ length: Math.min(CONCURRENCY, sources.length) }, async () => {
    while (cursor < sources.length) {
      const src = sources[cursor++]
      const element = byElement.get(src)
      if (!element) {
        continue
      }
      const job = encodeImage(element).catch(() => null)
      bySource.set(src, job as Promise<EncodedImage>)
      await job
    }
  })
  await Promise.all(workers)

  let failed = 0
  for (const element of elements) {
    const result = await bySource.get(element.src)
    if (result) {
      encoded.set(element, result)
    }
    else {
      failed += 1
    }
  }

  report('images:encoded', { distinct: sources.length, references: elements.length, failed })
  return { encoded, failed }
}

interface EncodedImage {
  data: string
  format: string
}

async function encodeImage(element: HTMLImageElement): Promise<EncodedImage> {
  const response = await fetch(element.src)
  const blob = await response.blob()

  // Stored as-is: jsPDF writes these straight into the file.
  if (blob.type === 'image/jpeg') {
    return { data: await blobToDataUrl(blob), format: 'JPEG' }
  }
  if (blob.type === 'image/png') {
    return { data: await blobToDataUrl(blob), format: 'PNG' }
  }

  const canvas = document.createElement('canvas')
  canvas.width = element.naturalWidth
  canvas.height = element.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('No 2d context')
  }
  context.drawImage(element, 0, 0)

  return usesAlpha(element)
    ? { data: canvas.toDataURL('image/png'), format: 'PNG' }
    : { data: canvas.toDataURL('image/jpeg', 0.86), format: 'JPEG' }
}

/**
 * Whether the image needs its alpha channel kept.
 *
 * Probed on a 32x32 downscale: reading a full-size pixel buffer for every cover
 * cost more than everything else in the export put together, and a cover either
 * has transparency across it or none at all.
 */
function usesAlpha(element: HTMLImageElement): boolean {
  const probe = document.createElement('canvas')
  probe.width = 32
  probe.height = 32
  const context = probe.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return true
  }

  context.drawImage(element, 0, 0, 32, 32)
  const { data } = context.getImageData(0, 0, 32, 32)

  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) {
      return true
    }
  }

  return false
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error || new Error('Could not read image'))
    reader.readAsDataURL(blob)
  })
}
