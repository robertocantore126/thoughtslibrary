import { inlineStoredImageUrl, isLocalAssetUrl } from '../helpers/assets'
import { rectOf } from './cull'
import { edgePath, type Rect } from './geometry'
import { type NodeSize, TEXT_INSET } from './layout'
import { resolveNodeFill } from './nodeStyle'
import {
  arrowheadPath,
  DEFAULT_GROUP_COLOR,
  DEFAULT_RELATIONSHIP_COLOR,
  GROUP_DASH,
  GROUP_PAD,
  GROUP_RADIUS,
  groupBounds,
  LABEL_BG,
  LABEL_FONT_SIZE,
  labelWidth,
  memberRectsOf,
  relationshipDash,
  relationshipMidpoint,
  relationshipPath,
  relationshipPoints,
} from './relations'
import { listIndentPx, paraGapPx } from './richtext'
import { DEFAULT_GROUP_BORDER_WIDTH, type MindNode, type Sheet, type TextRun } from './types'

/**
 * Visual export of the whole mindmap (S4 §B.5, E04/E05).
 *
 * §B.5 prescribes cloning the live world element into an
 * `<svg><foreignObject>` and calling it done. That pipeline cannot ship:
 *
 *  - The canvas rasterisation is the whole PNG path, and modern Chromium
 *    treats a foreignObject-bearing SVG as a tainted image source, so
 *    `canvas.toDataURL()` throws for every map. Pure SVG rasterises cleanly.
 *  - The live DOM mounts only viewport-CULLED nodes (MindmapCanvas
 *    `renderedNodes`). A clone of it is a picture of the window, not of the
 *    map — the very thing §B.5's bounds rule exists to forbid.
 *  - The clone carries the layers' scoped stylesheet classes
 *    (.mindmap-edge-*, .mindmap-rel-*, .mindmap-group-*) with no stylesheet
 *    in the exported document, so edges and labels would lose their strokes.
 *
 * So this module re-draws the model in pure SVG instead. That is exactly the
 * case the shared constants and helpers were built for: every layer component
 * (MindmapEdges, MindmapRelations, MindmapGroups) reads the same
 * `edgePath`/`relationshipPath`/`groupBounds`/arrowhead/label constants this
 * file reads, so the picture cannot disagree with the canvas about where a
 * line is or what it looks like — the failure mode being an export that
 * documents a map the user does not have. Rich titles are read straight from
 * `titleRuns` (Lane A's data), so formatting appears without this module
 * depending on Lane A's renderer, and collapsed-subtree filtering follows the
 * layers' hiddenIds rule so a folded branch is hidden here exactly as on the
 * canvas.
 */

/** How much empty space frames the map in the export. */
export const EXPORT_MARGIN = 40

/** The chart look the map inherits, read off the live overlay by the panel. */
export interface ExportTheme {
  /** The chart's font (MindmapOverlay's overlayStyle), for the whole map. */
  fontFamily: string
  /** The chart's text colour — the default topic text when Style says nothing. */
  textColor: string
  /** The overlay backdrop colour, drawn behind the map so the document is readable on any surface. */
  background: string
}

/**
 * The world rect the whole sheet occupies: the union of every node's box plus
 * a margin. Deliberately NOT the viewport — exporting whatever happens to be
 * on screen is not exporting the map (§B.5). Sizes come from the store's
 * measured cache, which covers culled nodes too (the measure layer sizes every
 * topic, not only the mounted ones).
 */
export function sheetBounds(sheet: Sheet, sizes: Record<string, NodeSize>, pad: number): Rect {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of Object.values(sheet.nodes)) {
    const r = rectOf(node, sizes)
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  // An empty sheet (no nodes at all) has nothing to frame; a zero rect still
  // exports an empty document rather than throwing.
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

// ---------------------------------------------------------------------------
// The look — mirrored from the layer components' scoped styles, so the export
// paints exactly what the canvas paints.
// ---------------------------------------------------------------------------

// Edges match the live canvas (MindmapEdges' light-theme rules): a dark line
// on the light map, with a faint halo behind it. The pre-light-theme white
// line would vanish on the white export background.
const EDGE_HALO = 'rgba(0, 0, 0, 0.14)'
const EDGE_HALO_W = 5
const EDGE_LINE = 'rgba(0, 0, 0, 0.6)'
const EDGE_LINE_W = 2

const REL_LINE_W = 2

const NODE_BORDER = 'rgba(255, 255, 255, 0.28)'
const NODE_BORDER_W = 1
const NODE_RADIUS = 10
const IMG_RADIUS = 6

const SHADOW_FILTER_ID = 'mm-shadow'

/** Two decimals is under a tenth of a device pixel at any export size. */
function round(n: number): number {
  return Math.round(n * 100) / 100
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&apos;',
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, ch => XML_ESCAPES[ch])
}

/** Collapsed subtrees are pruned from layout and hidden; the export hides them too. */
function hiddenIds(sheet: Sheet): Set<string> {
  const set = new Set<string>()
  const walk = (id: string, underCollapsed: boolean) => {
    const node = sheet.nodes[id]
    if (!node) {
      return
    }
    if (underCollapsed) {
      set.add(id)
    }
    const childHidden = underCollapsed || node.collapsed
    for (const childId of node.childrenIds) {
      walk(childId, childHidden)
    }
  }
  walk(sheet.rootNodeId, false)
  return set
}

/** Every node, parents before children (the store's visibleNodes order). */
function nodesInOrder(sheet: Sheet): MindNode[] {
  const seen = new Set<string>()
  const out: MindNode[] = []
  const walk = (id: string) => {
    const node = sheet.nodes[id]
    if (!node || seen.has(id)) {
      return
    }
    seen.add(id)
    out.push(node)
    for (const childId of node.childrenIds) {
      walk(childId)
    }
  }
  walk(sheet.rootNodeId)
  for (const node of Object.values(sheet.nodes)) {
    if (!seen.has(node.id)) {
      out.push(node)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tree edges — MindmapEdges' halo + line pair, for every visible parent-child
// pair, in the same world-only geometry (edgePath).
// ---------------------------------------------------------------------------

function edgeElements(sheet: Sheet, sizes: Record<string, NodeSize>, hidden: Set<string>): string {
  const out: string[] = []
  for (const node of nodesInOrder(sheet)) {
    if (hidden.has(node.id) || node.collapsed) {
      continue
    }
    for (const childId of node.childrenIds) {
      if (hidden.has(childId)) {
        continue
      }
      const child = sheet.nodes[childId]
      if (!child) {
        continue
      }
      const d = edgePath(rectOf(node, sizes), rectOf(child, sizes))
      out.push(`<path d="${d}" fill="none" stroke="${EDGE_HALO}" stroke-width="${EDGE_HALO_W}"/>`)
      out.push(`<path d="${d}" fill="none" stroke="${EDGE_LINE}" stroke-width="${EDGE_LINE_W}"/>`)
    }
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// Boundaries — MindmapGroups' dashed rounded rect, minus the selection glow
// and hit stroke (interaction chrome has no place in a picture of the map).
// ---------------------------------------------------------------------------

function groupElements(sheet: Sheet, sizes: Record<string, NodeSize>): string {
  const out: string[] = []
  for (const group of sheet.boundaries) {
    const b = groupBounds(memberRectsOf(sheet.nodes, group.memberIds, sizes), GROUP_PAD)
    // A boundary whose members are all gone draws NOTHING (groupBounds).
    if (!b) {
      continue
    }
    const color = group.color ?? DEFAULT_GROUP_COLOR
    const width = group.borderWidth ?? DEFAULT_GROUP_BORDER_WIDTH
    out.push(`<rect x="${round(b.x)}" y="${round(b.y)}" width="${round(b.w)}" height="${round(b.h)}" rx="${GROUP_RADIUS}" fill="none" stroke="${color}" stroke-width="${width}" stroke-dasharray="${GROUP_DASH}"/>`)
    if (group.label) {
      const w = labelWidth(group.label)
      out.push(`<rect x="${round(b.x + 6)}" y="${round(b.y + 6)}" width="${round(w)}" height="${LABEL_FONT_SIZE + 6}" rx="4" fill="${LABEL_BG}"/>`)
      out.push(`<text x="${round(b.x + 6 + 7)}" y="${round(b.y + 6 + LABEL_FONT_SIZE)}" font-size="${LABEL_FONT_SIZE}" fill="#ffffff">${escapeXml(group.label)}</text>`)
    }
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// Relationships — MindmapRelations' line, arrowheads and label, minus the
// selection glow, hit stroke, drag anchor and preview.
// ---------------------------------------------------------------------------

function relationshipElements(sheet: Sheet, sizes: Record<string, NodeSize>, hidden: Set<string>): string {
  const out: string[] = []
  for (const rel of sheet.relationships) {
    if (hidden.has(rel.fromId) || hidden.has(rel.toId)) {
      continue
    }
    const from = sheet.nodes[rel.fromId]
    const to = sheet.nodes[rel.toId]
    if (!from || !to) {
      continue
    }
    const fromRect = rectOf(from, sizes)
    const toRect = rectOf(to, sizes)
    const d = relationshipPath(fromRect, toRect, rel.connector)
    const pts = relationshipPoints(fromRect, toRect, rel.connector)
    const color = rel.color ?? DEFAULT_RELATIONSHIP_COLOR
    const dash = relationshipDash(rel.lineStyle)
    out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${REL_LINE_W}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`)
    // The arrowhead points at the path's target; bidirectional points both
    // ways (R05). The last/first sample is the trimmed border point.
    const toArrow = arrowheadPath(pts[pts.length - 1], pts[pts.length - 2])
    if (toArrow) {
      out.push(`<path d="${toArrow}" fill="${color}"/>`)
    }
    if (rel.bidirectional) {
      const fromArrow = arrowheadPath(pts[0], pts[1])
      if (fromArrow) {
        out.push(`<path d="${fromArrow}" fill="${color}"/>`)
      }
    }
    if (rel.label) {
      const mid = relationshipMidpoint(fromRect, toRect, rel.connector)
      const w = labelWidth(rel.label)
      out.push(`<rect x="${round(mid.x - w / 2)}" y="${round(mid.y - LABEL_FONT_SIZE / 2 - 3)}" width="${round(w)}" height="${LABEL_FONT_SIZE + 6}" rx="4" fill="${LABEL_BG}"/>`)
      out.push(`<text x="${round(mid.x)}" y="${round(mid.y + 4)}" text-anchor="middle" font-size="${LABEL_FONT_SIZE}" fill="#ffffff">${escapeXml(rel.label)}</text>`)
    }
  }
  return out.join('')
}

// ---------------------------------------------------------------------------
// Topic boxes — the shared .mindmap-node look (global.css) plus the
// nodeStyle.ts helpers' overrides, drawn from the measured sizes cache so a
// culled node exports exactly as the canvas would paint it.
// ---------------------------------------------------------------------------

interface RunStyle {
  fs: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  color: string | undefined
  fontFamily: string | undefined
}

/** A run's marks as drawn — node-level Style flags join the run's own. */
function runStyleOf(run: TextRun, node: MindNode): RunStyle {
  const s = node.style
  return {
    fs: run.fontSize ?? s.fontSize ?? 14,
    bold: !!run.bold || (s.fontWeight ?? 400) >= 600,
    italic: !!run.italic || !!s.italic,
    underline: !!run.underline || !!s.underline || s.shape === 'underline',
    strike: !!run.strike || !!s.strikethrough,
    color: run.color ?? s.textColor,
    fontFamily: run.fontFamily,
  }
}

/** One styled run of one wrapped line. */
interface Segment {
  text: string
  style: RunStyle
}

/** One wrapped line of a paragraph. */
interface TextLine {
  segments: Segment[]
  /** The largest run font size on the line — drives the line box. */
  fs: number
}

/** One paragraph of a title, ready to draw. */
interface TextPara {
  lines: TextLine[]
  /** >0 → a bullet at this depth, with the hanging indent. */
  listIndent: number
  /** Opens a new paragraph, so it takes the extra leading gap (not first). */
  paraGap: boolean
}

/**
 * The plain-title fallback: a title with no runs renders as a single plain
 * paragraph, byte for byte what the unstyled renderer draws (§A.1).
 */
function paragraphsOf(node: MindNode, boxW: number): TextPara[] {
  const runs = node.titleRuns && node.titleRuns.length > 0 ? node.titleRuns : [{ text: node.title }]
  // Group a flat run list into paragraphs exactly like Lane A's
  // runParagraphs: a run starts a new paragraph when it opens one (paraGap)
  // or changes the list depth, and a paragraph-opening newline is the plain
  // encoding of the break, so it is stripped before drawing.
  const paras: { runs: TextRun[], listIndent: number, paraGap: boolean }[] = []
  for (const run of runs) {
    const indent = run.listIndent ?? 0
    const previous = paras[paras.length - 1]
    const starts = !previous || !!run.paraGap || indent !== previous.listIndent
    const text = run.paraGap && run.text.startsWith('\n') ? run.text.slice(1) : run.text
    if (starts) {
      paras.push({ runs: [{ ...run, text }], listIndent: indent, paraGap: !!run.paraGap })
    }
    else {
      previous.runs.push({ ...run, text })
    }
  }
  return paras.map(para => wrapParagraph(para.runs, para.listIndent, para.paraGap, node, boxW))
}

/**
 * Greedy word wrap. The DOM wraps at overflow-wrap:anywhere against the
 * measured box; replicating the browser's shaping exactly would need a text
 * measure, so widths come from the project's own char model (the 0.55em
 * heuristicSize in MindmapCanvas) plus a wide-char table for CJK/emoji — a
 * wrapped line a few pixels off the browser's is invisible; a line that
 * overflows the measured box is not.
 */
function wrapParagraph(runs: TextRun[], listIndent: number, paraGap: boolean, node: MindNode, boxW: number): TextPara {
  const pad = node.style.padding ?? TEXT_INSET
  const maxWidth = Math.max(40, boxW - pad * 2)
  const styled = runs.map(run => ({ run, style: runStyleOf(run, node) }))
  const lines: TextLine[] = []
  let current: Segment[] = []
  let currentW = 0

  const flush = () => {
    if (current.length > 0) {
      lines.push({ segments: current, fs: Math.max(...current.map(seg => seg.style.fs)) })
      current = []
      currentW = 0
    }
  }

  const pushWord = (text: string, style: RunStyle) => {
    const w = widthOf(text, style)
    if (currentW + w <= maxWidth) {
      current.push({ text, style })
      currentW += w
      return
    }
    // The word alone is wider than a line: break it by characters rather
    // than overflowing (word-break: break-word).
    if (currentW === 0 || w > maxWidth) {
      let rest = text
      while (rest.length > 0) {
        let take = rest.length
        while (take > 1 && widthOf(rest.slice(0, take), style) > maxWidth) {
          take--
        }
        flush()
        current.push({ text: rest.slice(0, take), style })
        currentW = widthOf(rest.slice(0, take), style)
        rest = rest.slice(take)
      }
      return
    }
    flush()
    current.push({ text, style })
    currentW = w
  }

  for (const { run, style } of styled) {
    // A soft line break inside a run is real text (pre-wrap) — a hard break.
    const parts = run.text.split('\n')
    parts.forEach((part, i) => {
      if (i > 0) {
        flush()
      }
      // Whitespace runs collapse in HTML (white-space normal → pre-wrap only
      // preserves the run's own newlines); split into word tokens.
      for (const token of part.split(/(\s+)/)) {
        if (!token) {
          continue
        }
        if (/^\s+$/.test(token)) {
          // A space only joins a line that already has content; leading
          // whitespace is dropped exactly as the browser drops it.
          if (current.length > 0) {
            const spaceW = widthOf(' ', style)
            if (currentW + spaceW <= maxWidth) {
              current.push({ text: ' ', style })
              currentW += spaceW
            }
          }
          continue
        }
        pushWord(token, style)
      }
    })
  }
  flush()
  return { lines, listIndent, paraGap }
}

/** Rough width of text under a run's marks. */
function widthOf(text: string, style: RunStyle): number {
  let w = 0
  for (const ch of text) {
    if (ch === ' ') {
      w += style.fs * 0.3
    }
    else if (isWideChar(ch)) {
      w += style.fs
    }
    else {
      w += style.fs * (style.bold ? 0.62 : 0.55)
    }
  }
  return w
}

/** Unicode East-Asian Wide/Fullwidth ranges plus emoji: ~1em per char. */
function isWideChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return (code >= 0x1100 && code <= 0x115F)
    || code === 0x2329 || code === 0x232A
    || (code >= 0x2E80 && code <= 0xA4CF && code !== 0x303F)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFE10 && code <= 0xFE19)
    || (code >= 0xFE30 && code <= 0xFE6F)
    || (code >= 0xFF00 && code <= 0xFF60)
    || (code >= 0xFFE0 && code <= 0xFFE6)
    || (code >= 0x1F300 && code <= 0x1FAFF)
}

/** The topic box shape, mirroring topicBoxStyle: rect/capsule are exact, underline/none drop the box. */
function boxShape(node: MindNode, h: number): { rx: number, draw: boolean } {
  const shape = node.style.shape ?? 'rounded'
  if (shape === 'underline' || shape === 'none') {
    return { rx: 0, draw: false }
  }
  if (shape === 'rect') {
    return { rx: 0, draw: true }
  }
  if (shape === 'capsule') {
    return { rx: h / 2, draw: true }
  }
  return { rx: node.style.cornerRadius ?? NODE_RADIUS, draw: true }
}

/**
 * One topic as SVG: the box (per nodeStyle), the top image slot, and the
 * title wrapped to the measured width. `images` maps style image URLs to
 * their portable data URIs; the map is the store's `sizes` cache.
 */
function nodeElement(node: MindNode, size: NodeSize, theme: ExportTheme, images: Map<string, string>, shadowUsed: { value: boolean }, sheet: Sheet): string {
  const s = node.style
  const pad = s.padding ?? TEXT_INSET
  const parts: string[] = []
  const groupAttrs = [`transform="translate(${round(node.position.x)} ${round(node.position.y)})"`]
  if (s.opacity !== undefined) {
    groupAttrs.push(`opacity="${s.opacity}"`)
  }

  const shape = boxShape(node, size.h)
  if (shape.draw) {
    // Same fill rule as the live topic: explicit Style wins, else the r-node
    // branch palette (root white, branch colours by depth, deep white).
    const fill = s.fill ?? resolveNodeFill(node, sheet)
    const stroke = s.stroke ?? NODE_BORDER
    const width = s.borderWidth ?? NODE_BORDER_W
    const attrs = [`x="0"`, `y="0"`, `width="${round(size.w)}"`, `height="${round(size.h)}"`, `rx="${round(shape.rx)}"`, `fill="${fill}"`, `stroke="${stroke}"`, `stroke-width="${width}"`]
    if (s.borderStyle === 'dashed') {
      attrs.push('stroke-dasharray="6 4"')
    }
    else if (s.borderStyle === 'dotted') {
      attrs.push('stroke-dasharray="1 4"', 'stroke-linecap="round"')
    }
    if (s.shadow) {
      shadowUsed.value = true
      attrs.push(`filter="url(#${SHADOW_FILTER_ID})"`)
    }
    parts.push(`<rect ${attrs.join(' ')}/>`)
  }

  // The TOP image slot: a box from imageWidth × imageAspect alone (S3 C.2b),
  // clipped to the same rounded corners the shared class gives it.
  const imageUrl = s.image
  if (imageUrl) {
    const w = Math.max(1, Math.round(s.imageWidth ?? 120))
    const h = Math.max(1, Math.round(w * (s.imageAspect ?? 0.75)))
    const src = images.get(imageUrl) ?? imageUrl
    parts.push(`<clipPath id="mm-clip-${node.id}"><rect width="${w}" height="${h}" rx="${IMG_RADIUS}"/></clipPath>`)
    parts.push(`<image x="${pad}" y="${pad}" width="${w}" height="${h}" clip-path="url(#mm-clip-${node.id})" preserveAspectRatio="xMidYMid slice" href="${escapeXml(src)}"/>`)
  }

  // The title: paragraphs wrapped to the measured width, below the image.
  const textX = pad
  const textTop = pad + (imageUrl ? Math.max(1, Math.round((s.imageWidth ?? 120) * (s.imageAspect ?? 0.75))) : 0)
  const textColor = s.textColor ?? theme.textColor
  const fontFamily = s.fontFamily ?? theme.fontFamily
  const paras = paragraphsOf(node, size.w)
  let cursor = textTop
  const baseFont = s.fontSize ?? 14
  paras.forEach((para, index) => {
    if (para.paraGap && index > 0) {
      cursor += paraGapPx(baseFont)
    }
    const indent = listIndentPx(para.listIndent, baseFont)
    const lineX = textX + indent
    para.lines.forEach((line, lineIndex) => {
      const baseline = cursor + line.fs * 0.8
      if (para.listIndent > 0 && lineIndex === 0) {
        // The bullet hangs in the margin the paragraph reserves (the CSS
        // text-indent), so wrapped lines align under the text.
        parts.push(`<text x="${round(lineX - indent)}" y="${round(baseline)}" font-size="${line.fs}" fill="${textColor}">•</text>`)
      }
      const spans = line.segments.map((seg) => {
        const attrs = [`font-size="${seg.style.fs}"`]
        if (seg.style.bold) {
          attrs.push('font-weight="700"')
        }
        if (seg.style.italic) {
          attrs.push('font-style="italic"')
        }
        if (seg.style.underline || seg.style.strike) {
          attrs.push(`text-decoration="${[seg.style.underline ? 'underline' : '', seg.style.strike ? 'line-through' : ''].filter(Boolean).join(' ')}"`)
        }
        if (seg.style.fontFamily) {
          attrs.push(`font-family="${escapeXml(seg.style.fontFamily)}"`)
        }
        const fill = seg.style.color ?? textColor
        if (fill !== textColor) {
          attrs.push(`fill="${fill}"`)
        }
        return `<tspan ${attrs.join(' ')}>${escapeXml(seg.text)}</tspan>`
      }).join('')
      parts.push(`<text x="${round(lineX)}" y="${round(baseline)}" font-size="${line.fs}" font-family="${escapeXml(fontFamily)}" fill="${textColor}">${spans}</text>`)
      cursor += line.fs * 1.25
    })
  })

  return `<g ${groupAttrs.join(' ')}>${parts.join('')}</g>`
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Resolve every local-asset image URL to a data URI (they die with the session). */
async function resolveImages(sheet: Sheet): Promise<Map<string, string>> {
  const urls = new Set<string>()
  for (const node of Object.values(sheet.nodes)) {
    const url = node.style.image
    if (url && isLocalAssetUrl(url)) {
      urls.add(url)
    }
  }
  const out = new Map<string, string>()
  await Promise.all([...urls].map(async (url) => {
    const dataUri = await inlineStoredImageUrl(url)
    if (dataUri) {
      out.set(url, dataUri)
    }
  }))
  return out
}

/**
 * The whole map as a standalone SVG document — pure SVG, no foreignObject,
 * so it rasterises cleanly (see the header for why that matters).
 *
 * Async because resolving stored images to data URIs reads IndexedDB; the
 * caller awaits it before showing a download.
 */
export async function exportSheetSvg(
  sheet: Sheet,
  sizes: Record<string, NodeSize>,
  bounds: Rect,
  theme?: Partial<ExportTheme>,
): Promise<string> {
  const resolved = await resolveImages(sheet)
  const fullTheme: ExportTheme = {
    fontFamily: theme?.fontFamily ?? 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    textColor: theme?.textColor ?? '#141414',
    background: theme?.background ?? '',
  }

  const hidden = hiddenIds(sheet)
  const shadowUsed = { value: false }
  const defs: string[] = []

  const nodeParts = nodesInOrder(sheet)
    .filter(n => !hidden.has(n.id))
    .map((n) => {
      const size = sizes[n.id] ?? { w: 84, h: 40 }
      return nodeElement(n, size, fullTheme, resolved, shadowUsed, sheet)
    })

  if (shadowUsed.value) {
    defs.push(`<filter id="${SHADOW_FILTER_ID}" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#000000" flood-opacity="0.45"/></filter>`)
  }

  const w = Math.max(1, Math.ceil(bounds.w))
  const h = Math.max(1, Math.ceil(bounds.h))

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${escapeXml(fullTheme.fontFamily)}" fill="${fullTheme.textColor}">`)
  if (defs.length > 0) {
    parts.push(`<defs>${defs.join('')}</defs>`)
  }
  if (fullTheme.background) {
    parts.push(`<rect width="${w}" height="${h}" fill="${fullTheme.background}"/>`)
  }
  parts.push(`<g transform="translate(${round(-bounds.x)} ${round(-bounds.y)})">`)
  // Stacking order IS render order, matching MindmapCanvas: boundaries
  // beneath the tree, relationships above the topics.
  parts.push(groupElements(sheet, sizes))
  parts.push(edgeElements(sheet, sizes, hidden))
  parts.push(nodeParts.join(''))
  parts.push(relationshipElements(sheet, sizes, hidden))
  parts.push('</g>')
  parts.push('</svg>')
  return parts.join('')
}

// Rasterising pure SVG is a browser render: load the serialised document as an
// image and draw it onto a canvas. The canvas caps at 8192px per side, so a
// very large map is scaled down proportionally rather than failing to allocate.
const MAX_PNG_DIMENSION = 8192

/** The whole map as a PNG data URL, through the same SVG as exportSheetSvg. */
export async function exportSheetPng(
  sheet: Sheet,
  sizes: Record<string, NodeSize>,
  bounds: Rect,
  theme?: Partial<ExportTheme>,
): Promise<string> {
  const svg = await exportSheetSvg(sheet, sizes, bounds, theme)
  const scale = Math.min(1, MAX_PNG_DIMENSION / Math.max(1, bounds.w, bounds.h))
  const w = Math.max(1, Math.round(bounds.w * scale))
  const h = Math.max(1, Math.round(bounds.h * scale))
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = await loadImage(url)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('Could not create a canvas for the export')
    }
    ctx.drawImage(image, 0, 0, w, h)
    return canvas.toDataURL('image/png')
  }
  finally {
    URL.revokeObjectURL(url)
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not rasterise the map'))
    img.src = src
  })
}
