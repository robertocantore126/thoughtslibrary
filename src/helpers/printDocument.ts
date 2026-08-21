// Builds the standalone HTML document that Chromium turns into the exported PDF.
//
// The document is produced from chart *data*, never by scraping the running
// app: it carries its own stylesheet, so nothing depends on the editor's CSS
// being present, and no editor-only state (tile selection, focus dimming) can
// leak into the export. The same string is handed to Electron's `printToPDF`
// and to `window.print()` on the web.
//
// The chart page is reconstructed as real HTML rather than rasterized, so tile
// titles stay selectable text and covers stay embedded images at their own
// resolution. Chromium's print pipeline then emits vector text plus one
// embedded copy of each distinct image.

import type { Chart, ChartItem } from '../types'
import { BackgroundTypes } from '../types'

// Geometry mirrored from the editor (Chart/index.vue, Row.vue, Item.vue). The
// grid is reproduced at 1:1 CSS pixels and scaled as a whole, so every relative
// position and dimension is preserved exactly.
const TILE_PX = 130
const ITEM_STACK_GAP_PX = 4
const CHART_TITLE_PX = 50
const ROOT_FONT_PX = 16

// Widest a layer scene may be drawn in the text column, and tallest before it
// is scaled down, both in CSS pixels.
const LAYER_MAX_HEIGHT_PX = 340

// How far a chart may be enlarged to fill a sheet that was not sized around it.
// Past roughly double, magnifying a cover starts to show.
const MAX_POSTER_UPSCALE = 2

// Longest side a chart sheet may reach before the chart is scaled down onto it.
// 3400px is a shade over A0's long edge, which is as large as a printable sheet
// gets; below it the chart is laid out at its own size.
const MAX_POSTER_PX = 3400

// Paper sizes in CSS pixels at 96dpi, which is the unit Chromium's print box
// works in.
const PAPER = {
  A4: { width: 794, height: 1123 },
  Letter: { width: 816, height: 1056 },
} as const

export type PaperName = keyof typeof PAPER

/**
 * The paper's size in CSS pixels.
 *
 * A print document has to be laid out at the width it will be printed at. Given
 * a viewport narrower than the page, the browser reflows every paragraph to
 * that width first, and the print pipeline then has to redo the whole layout.
 */
export function paperSizePx(paper: PaperName = 'A4'): { width: number, height: number } {
  return PAPER[paper]
}

export interface PrintDocumentOptions {
  /**
   * Renders a note's Markdown to sanitized HTML. Injected rather than imported
   * so this module stays free of DOM-only dependencies and can be exercised
   * outside a browser.
   */
  renderNotes: (markdown: string) => string
  title?: string
  paper?: PaperName
  /** Margin around every page, in millimetres. */
  marginMm?: number
  /**
   * Lets the chart page take a sheet of its own: `fit` picks the orientation
   * that wastes least, `exact` gives the sheet the chart's own proportions so
   * there is no letterboxing at all. Requires CSS named-page support, so it is
   * only enabled on the Electron path; the web fallback keeps one paper size
   * for the whole document and simply scales the chart into it.
   */
  posterPage?: 'off' | 'fit' | 'exact'
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}

function escapeHtml(value: string): string {
  return String(value ?? '').replace(/[&<>"']/g, char => HTML_ESCAPES[char])
}

// A stored colour or font name goes into a declaration, where a semicolon or
// brace would start one of its own.
function cssValue(value: string): string {
  return String(value ?? '').replace(/[;{}()]/g, '').trim()
}

// Guards against a stored URL closing the CSS url() around it.
function escapeCssUrl(value: string): string {
  return String(value ?? '').replace(/["\\]/g, char => `\\${char}`).replace(/[\n\r]/g, '')
}

/**
 * Renders a built-up declaration list as a `style` attribute.
 *
 * The escaping happens here, on the whole string, rather than on the values
 * going into it: CSS quotes its own url() arguments, and a raw `"` from one of
 * those would otherwise close the attribute and take the rest of the
 * declarations with it — which is exactly what happened to image backgrounds.
 */
function styleAttribute(declarations: string): string {
  return `style="${escapeHtml(declarations)}"`
}

function ratingOf(item: ChartItem): number {
  const raw = item.rating
  return raw ? Math.max(1, Math.min(7, Math.round(raw))) : 0
}

// The rating ramp from Item.vue, kept identical so the chart page and the
// detail pages agree with what the editor shows.
function ratingColorOf(item: ChartItem): string {
  if (item.title?.trim().toLowerCase() === 'frusciante') {
    return '#000000'
  }

  const rating = ratingOf(item)
  if (rating <= 4) {
    return '#ffd84d'
  }
  if (rating === 5) {
    return '#ff9b3d'
  }
  if (rating === 6) {
    return '#b17bff'
  }
  return '#63ecff'
}

function titleOf(item: ChartItem): string {
  return [item.creator, item.title].filter(Boolean).join(' - ') || 'Untitled'
}

function hasNotes(item: ChartItem): boolean {
  return !!item.notes?.trim()
}

function starsHtml(item: ChartItem, className: string): string {
  const count = ratingOf(item)
  if (count === 0) {
    return ''
  }

  const star = `<span class="pl-star" ${styleAttribute(`color:${cssValue(ratingColorOf(item))}`)}>\u2605</span>`
  return `<span class="${className}" aria-label="Item rating">${star.repeat(count)}</span>`
}

export interface ChartGeometry {
  columnGap: number
  rowGap: number
  padding: number
  paddingTop: number
}

// Row.vue puts half the chart gap between items in a row (floored at 6) while
// the column of rows uses the full gap; the grid is inset by the gap, with a
// half gap above it when the chart has a title.
export function chartGeometry(chart: Chart): ChartGeometry {
  const gap = chart.gap
  return {
    columnGap: Math.max(6, gap / 2),
    rowGap: gap,
    padding: gap,
    paddingTop: chart.title ? gap / 2 : gap,
  }
}

interface ItemContext {
  chart: Chart
  hasLayer: (item: ChartItem) => boolean
}

// One grid tile, reproducing Item.vue's structure: a fixed 130px cover frame
// carrying the rating badge, the layer/notes marker and any thought
// attachment, with the wrapping title beneath. Empty tiles still render the
// frame so they hold their place in the row exactly as the editor does, but
// stay invisible, the way both existing exports draw them.
function tileHtml(item: ChartItem | null, number: number | null, ctx: ItemContext): string {
  if (!item) {
    return '<div class="pl-item"><div class="pl-cover-frame"></div></div>'
  }

  const { chart } = ctx

  const marker = ctx.hasLayer(item)
    ? '<span class="pl-layer-marker"></span>'
    : hasNotes(item)
      ? '<span class="pl-notes-marker"></span>'
      : ''

  const attachment = item.itemType === 'thought' && item.attachmentURL
    ? `<img class="pl-attachment" src="${escapeHtml(item.attachmentURL)}" alt="">`
    : ''

  const cover = item.coverURL
    ? `<img class="pl-cover" src="${escapeHtml(item.coverURL)}" alt="">`
    : ''

  const prefix = chart.showNumbers && number ? `${number}. ` : ''
  const title = chart.showTitles
    ? `<p class="pl-item-title">${escapeHtml(prefix + titleOf(item))}</p>`
    : ''

  return `<div class="pl-item"><div class="pl-cover-frame">${
    starsHtml(item, 'pl-rating')
  }${marker
  }${attachment
  }${cover
  }</div>${
    title
  }</div>`
}

function chartBackgroundCss(chart: Chart): string {
  if (chart.backgroundType === BackgroundTypes.Color) {
    return `background-color:${cssValue(chart.backgroundColor || '#000000')};`
  }

  // Chart/index.vue falls back to black when the image background has no URL.
  if (!chart.backgroundUrl) {
    return 'background-color:#000000;'
  }

  return `background-image:url("${escapeCssUrl(chart.backgroundUrl)}");`
    + 'background-repeat:no-repeat;background-position:center;background-size:cover;'
}

// Families the browser resolves on its own; anything else is a named face the
// print window has never heard of, because it is a fresh document rather than
// the running app.
const GENERIC_FONT_FAMILIES = new Set([
  'monospace',
  'serif',
  'sans-serif',
  'system-ui',
  'ui-monospace',
  'ui-serif',
  'ui-sans-serif',
  'cursive',
  'fantasy',
  'math',
  'inherit',
  'initial',
])

/**
 * A Google Fonts stylesheet for the chart's font, so the chart page prints in
 * the face the editor shows rather than falling back to monospace. The app
 * already serves its own UI font from there, and the family is only ever
 * requested when it reads as a plain font name.
 */
function webFontLink(font?: string): string {
  const family = (font || '').trim()
  if (!family || GENERIC_FONT_FAMILIES.has(family.toLowerCase())) {
    return ''
  }

  // Only a bare family name: a stored value carrying quotes, commas or a URL
  // is not something to paste into a request.
  if (!/^[a-z0-9][a-z0-9 -]*$/i.test(family)) {
    return ''
  }

  const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}&display=swap`
  return '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + `<link rel="stylesheet" href="${escapeHtml(href)}">`
}

function chartFontCss(chart: Chart): string {
  return `font-family:${cssValue(chart.font || 'monospace')},monospace;`
    + `color:${cssValue(chart.textColor || '#ffffff')};`
}

// The chart at 1:1 with the editor. The wrapper is measured and scaled by the
// document's own fit script once the browser has laid it out.
function chartHtml(chart: Chart, ctx: ItemContext): string {
  const geometry = chartGeometry(chart)
  const width = chart.size.x
  const rows: string[] = []

  // `number` counts non-empty tiles in reading order, matching the store's
  // `items` getter, so a numbered chart numbers the same tiles the editor does.
  let counter = 1

  for (let y = 0; y < chart.size.y; y += 1) {
    const tiles: string[] = []
    for (let x = 0; x < width; x += 1) {
      const item = chart.items[y * width + x] || null
      tiles.push(tileHtml(item, item ? counter : null, ctx))
      if (item) {
        counter += 1
      }
    }
    rows.push(`<div class="pl-row" style="gap:${geometry.columnGap}px">${tiles.join('')}</div>`)
  }

  const style = chartFontCss(chart)
    + (chart.shadows ? 'text-shadow:2px 2px 4px rgba(0,0,0,0.6);' : 'text-shadow:none;')
    + (chart.roundCorners ? 'border-radius:10px;' : 'border-radius:0;')
    + chartBackgroundCss(chart)

  const title = chart.title
    ? `<p class="pl-chart-title" style="margin-top:${geometry.paddingTop}px">${escapeHtml(chart.title)}</p>`
    : ''

  return `<div class="pl-chart" id="pl-chart" ${styleAttribute(style)}>${
    title
  }<div class="pl-rows" style="gap:${geometry.rowGap}px;padding:${geometry.padding}px;padding-top:${geometry.paddingTop}px">${
    rows.join('')
  }</div></div>`
}

interface LayerCell {
  dx: number
  dy: number
  item: ChartItem
  isParent: boolean
}

export interface DetailEntry {
  coord: string
  item: ChartItem
  /** Set on the parent tile of a layer: the cells to draw above its text. */
  layer: LayerCell[] | null
  layerBounds: { minX: number, minY: number, cols: number, rows: number } | null
}

/**
 * Every non-empty tile in reading order, each followed by its layer members.
 *
 * The coordinate comes from the array index rather than a lookup in
 * `coordinates`: the store builds `items` at exactly (y-1)*width + (x-1), so
 * the index *is* the position, and the two objects are cloned separately
 * during asset inlining so they never share item identities.
 */
export function detailEntries(chart: Chart): DetailEntry[] {
  const layers = chart.relatedLayers || {}
  const width = chart.size.x
  const entries: DetailEntry[] = []

  chart.items.forEach((item, index) => {
    if (!item) {
      return
    }

    const coord = `${(index % width) + 1},${Math.floor(index / width) + 1}`
    const layer = layers[item.id]
    const cells: LayerCell[] = []

    if (layer) {
      for (const [offset, layerItem] of Object.entries(layer)) {
        const [dxRaw, dyRaw] = offset.split(',')
        const dx = Number.parseInt(dxRaw, 10)
        const dy = Number.parseInt(dyRaw, 10)
        if (Number.isNaN(dx) || Number.isNaN(dy)) {
          continue
        }
        cells.push({ dx, dy, item: layerItem, isParent: false })
      }
    }

    // Reading order, matching how the layer reads on the chart.
    cells.sort((a, b) => a.dy - b.dy || a.dx - b.dx)

    if (cells.length === 0) {
      entries.push({ coord, item, layer: null, layerBounds: null })
      return
    }

    const all: LayerCell[] = [{ dx: 0, dy: 0, item, isParent: true }, ...cells]
    const xs = all.map(cell => cell.dx)
    const ys = all.map(cell => cell.dy)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)

    entries.push({
      coord,
      item,
      layer: all,
      layerBounds: {
        minX,
        minY,
        cols: Math.max(...xs) - minX + 1,
        rows: Math.max(...ys) - minY + 1,
      },
    })

    for (const cell of cells) {
      entries.push({
        coord: `${coord} + (${cell.dx},${cell.dy})`,
        item: cell.item,
        layer: null,
        layerBounds: null,
      })
    }
  })

  return entries
}

// A layer drawn at the chart's own tile size and gaps, so its shape matches
// what focus mode shows in the editor, then scaled down as a block by the fit
// script rather than rebuilt smaller — which keeps its proportions honest.
//
// A grid, not absolute positions: rows size themselves to the tallest tile in
// them, exactly as the chart's own rows do, so a wrapped title pushes the row
// below it down instead of overlapping or being clipped.
function layerHtml(entry: DetailEntry, chart: Chart, ctx: ItemContext): string {
  if (!entry.layer || !entry.layerBounds) {
    return ''
  }

  const geometry = chartGeometry(chart)
  const bounds = entry.layerBounds

  const cells = entry.layer.map((cell) => {
    const column = cell.dx - bounds.minX + 1
    const row = cell.dy - bounds.minY + 1
    const parentClass = cell.isParent ? ' is-parent' : ''
    return `<div class="pl-layer-cell${parentClass}" style="grid-column:${column};grid-row:${row}">${
      tileHtml(cell.item, null, ctx)
    }</div>`
  }).join('')

  const sceneStyle = `grid-template-columns:repeat(${bounds.cols},${TILE_PX}px);`
    + `grid-template-rows:repeat(${bounds.rows},auto);`
    + `gap:${geometry.rowGap}px ${geometry.columnGap}px;${
      chartFontCss(chart)
    }${chartBackgroundCss(chart)}`

  return `<div class="pl-layer">`
    + `<div class="pl-layer-scene" ${styleAttribute(sceneStyle)}>${cells}</div></div>`
}

function detailHtml(chart: Chart, ctx: ItemContext, options: PrintDocumentOptions): string {
  const entries = detailEntries(chart)
  if (entries.length === 0) {
    return ''
  }

  const blocks = entries.map((entry) => {
    const { item } = entry
    const notes = hasNotes(item)
      ? `<div class="pl-notes">${options.renderNotes(item.notes as string)}</div>`
      : ''
    const attachment = item.itemType === 'thought' && item.attachmentURL
      ? `<img class="pl-entry-attachment" src="${escapeHtml(item.attachmentURL)}" alt="">`
      : ''

    return `<article class="pl-entry">${
      layerHtml(entry, chart, ctx)
    }<p class="pl-coord">Tile ${escapeHtml(entry.coord)}</p>`
    + `<h2 class="pl-entry-title">${escapeHtml(titleOf(item))}</h2>${
      starsHtml(item, 'pl-entry-rating')
    }${notes
    }${attachment
    }</article>`
  })

  const heading = chart.title
    ? `<h1 class="pl-heading">${escapeHtml(chart.title)}</h1>`
    : ''

  return `<main class="pl-details">${heading}${blocks.join('')}</main>`
}

function stylesheet(paperName: PaperName, marginMm: number, posterPage: boolean): string {
  // A sheet of its own for the chart, sized by the fit script. Without named
  // page support the declaration is simply ignored and the chart is scaled
  // into the normal page instead, which is why the fit script always measures
  // against the same content box.
  const posterRules = posterPage
    ? `.pl-poster { page: poster; }\n@page poster { size: ${paperName}; margin: ${marginMm}mm; }`
    : ''

  return `
html { font-size: ${ROOT_FONT_PX}px; }
html, body { margin: 0; padding: 0; background: #ffffff; }
body {
  color: #111111;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ---- chart page ------------------------------------------------------ */
.pl-poster { break-after: page; page-break-after: always; }
.pl-poster:last-child { break-after: auto; page-break-after: auto; }
.pl-poster-fit { display: flex; align-items: center; justify-content: center; overflow: hidden; }
/* Scaled as one block, so every tile keeps its exact relative position and the
   chart is never clipped by the page edge. Never shrunk to the viewport: the
   fit script has to measure the chart at its natural size first. */
.pl-poster-scale { transform-origin: top left; flex: 0 0 auto; width: max-content; }
.pl-chart { display: inline-block; position: relative; }
/* Normal leading, not the document's 1.5, so the title takes the same height
   it does in the editor, where nothing sets a line-height above it. */
.pl-chart-title { font-size: ${CHART_TITLE_PX}px; line-height: normal; padding: 0; margin: 0; }
.pl-rows { display: flex; flex-flow: column; margin: 0; width: max-content; }
.pl-row { display: flex; justify-content: flex-start; align-items: flex-start; width: max-content; }

.pl-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: ${ITEM_STACK_GAP_PX}px;
  width: ${TILE_PX}px;
  min-width: ${TILE_PX}px;
}
.pl-cover-frame {
  position: relative;
  width: ${TILE_PX}px;
  height: ${TILE_PX}px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pl-cover { max-width: 100%; max-height: 100%; height: inherit; }
.pl-item-title {
  margin: 0;
  font-size: 0.62rem;
  line-height: 1.2;
  text-align: left;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.pl-rating {
  position: absolute;
  top: 4px;
  left: 4px;
  display: flex;
  gap: 1px;
  background: rgba(0, 0, 0, 0.58);
  border-radius: 3px;
  padding: 1px 3px 2px;
  z-index: 2;
}
.pl-rating .pl-star { font-size: 0.76rem; font-weight: 700; line-height: 1; text-shadow: 0 0 2px rgba(0, 0, 0, 0.85); }
.pl-notes-marker, .pl-layer-marker {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 10px;
  height: 10px;
  z-index: 2;
}
.pl-notes-marker { border-radius: 2px; background: #ff7f50; }
.pl-layer-marker { border-radius: 50%; border: 2px solid #ffd700; background: transparent; }
.pl-attachment {
  position: absolute;
  bottom: 5px;
  left: 5px;
  width: 36px;
  height: 36px;
  border-radius: 6px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.8);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.55);
  z-index: 3;
}

/* ---- detail pages ---------------------------------------------------- */
.pl-heading {
  margin: 0 0 18px;
  padding-bottom: 8px;
  border-bottom: 2px solid #dddddd;
  color: #111111;
  font-size: 24px;
}
/* Entries flow: a page holds as many as fit, and only an individual entry is
   held together. */
.pl-entry {
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 0 0 14px;
  padding: 10px 12px;
  border-left: 3px solid #ff7f50;
  background: #f7f7f7;
}
.pl-coord { margin: 0 0 2px; color: #777777; font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; }
.pl-entry-title { margin: 0 0 2px; color: #111111; font-size: 15px; }
.pl-entry-rating { display: block; margin: 0 0 4px; }
.pl-entry-rating .pl-star { font-size: 13px; font-weight: 700; }

.pl-layer { margin: 0 0 10px; overflow: hidden; }
.pl-layer-scene { display: grid; width: max-content; transform-origin: top left; }
.pl-layer-cell { min-width: 0; }
.pl-layer-cell.is-parent .pl-cover-frame { outline: 3px solid #ff7f50; outline-offset: -2px; }

.pl-notes { margin: 6px 0 0; }
.pl-notes p { margin: 0 0 6px; }
.pl-notes h1, .pl-notes h2, .pl-notes h3, .pl-notes h4, .pl-notes h5, .pl-notes h6 { margin: 8px 0 4px; color: #111111; }
.pl-notes h1 { font-size: 18px; }
.pl-notes h2 { font-size: 16px; }
.pl-notes h3 { font-size: 14px; }
.pl-notes ul, .pl-notes ol { margin: 0 0 6px; padding-left: 20px; }
.pl-notes a { color: #0b5cad; }
.pl-notes blockquote { margin: 0 0 6px; padding-left: 10px; border-left: 3px solid #cccccc; color: #444444; }
.pl-notes code { padding: 1px 3px; border-radius: 3px; background: #eeeeee; font-size: 0.9em; }
.pl-notes pre { padding: 8px; border-radius: 4px; background: #eeeeee; white-space: pre-wrap; overflow-wrap: anywhere; }
.pl-notes pre code { padding: 0; background: none; }
.pl-notes img { max-width: 100%; height: auto; }
.pl-notes table { border-collapse: collapse; max-width: 100%; }
.pl-notes th, .pl-notes td { border: 1px solid #dddddd; padding: 3px 6px; }
.pl-entry-attachment { display: block; max-width: 160px; max-height: 160px; margin-top: 6px; border-radius: 6px; }

@page { size: ${paperName}; margin: ${marginMm}mm; }
${posterRules}
`
}

// Runs inside the print document once layout is done. Wrapped tile titles make
// the chart's height impossible to predict from the data alone, so the chart is
// measured as the browser actually laid it out and only then scaled. Doing this
// inside the document means the Electron and web paths get the same result
// without a round trip.
function fitScript(paper: { width: number, height: number }, marginMm: number, posterPage: 'off' | 'fit' | 'exact'): string {
  const config = JSON.stringify({
    paper,
    marginMm,
    posterPage,
    layerMaxHeight: LAYER_MAX_HEIGHT_PX,
    maxPosterPx: MAX_POSTER_PX,
    maxUpscale: MAX_POSTER_UPSCALE,
  })

  return `
(function () {
  var CFG = ${config};
  var MARGIN = CFG.marginMm * 96 / 25.4;
  var BOX = { w: CFG.paper.width - MARGIN * 2, h: CFG.paper.height - MARGIN * 2 };

  // One reusable rule: the fit runs again once late resources settle, and a
  // second @page block appended beside the first would only confuse things.
  function setPosterPageSize(w, h) {
    var sheet = document.getElementById('pl-poster-page');
    if (!sheet) {
      sheet = document.createElement('style');
      sheet.id = 'pl-poster-page';
      document.head.appendChild(sheet);
    }
    sheet.textContent = '@page poster { size: ' + Math.round(w) + 'px ' + Math.round(h) + 'px; margin: ' + CFG.marginMm + 'mm; }';
  }

  function fitPoster() {
    var chart = document.getElementById('pl-chart');
    var scaleBox = document.querySelector('.pl-poster-scale');
    var fitBox = document.querySelector('.pl-poster-fit');
    if (!chart || !scaleBox || !fitBox) { return; }

    var w = chart.offsetWidth;
    var h = chart.offsetHeight;
    if (!w || !h) { return; }

    var box = { w: BOX.w, h: BOX.h };

    if (CFG.posterPage === 'exact') {
      // The sheet takes the chart's own proportions and, up to the cap, its own
      // size: no letterboxing, and no scaling that would resample the covers.
      // Only a chart too large for any sheet is scaled, and only down.
      var longest = Math.max(w, h);
      var k = longest > CFG.maxPosterPx ? CFG.maxPosterPx / longest : 1;
      box = { w: w * k, h: h * k };
      setPosterPageSize(box.w + MARGIN * 2, box.h + MARGIN * 2);
    }
    else if (CFG.posterPage === 'fit') {
      // Whichever orientation lets the chart come out larger.
      var land = { w: BOX.h, h: BOX.w };
      if (Math.min(land.w / w, land.h / h) > Math.min(BOX.w / w, BOX.h / h)) {
        box = land;
        setPosterPageSize(CFG.paper.height, CFG.paper.width);
      }
    }

    // A sheet the chart was measured against needs no growing; a fixed sheet
    // does, or a small chart would sit marooned in one corner of it. Capped
    // either way, past which the covers visibly soften.
    var scale = Math.min(box.w / w, box.h / h);
    var ceiling = CFG.posterPage === 'exact' ? 1 : CFG.maxUpscale;
    if (scale > ceiling) { scale = ceiling; }

    fitBox.style.width = box.w + 'px';
    fitBox.style.height = box.h + 'px';
    scaleBox.style.transform = 'scale(' + scale + ')';
    scaleBox.style.width = (w * scale) + 'px';
    scaleBox.style.height = (h * scale) + 'px';
    document.documentElement.setAttribute('data-poster', w + 'x' + h + '@' + scale.toFixed(4));
  }

  // Layer scenes are built at the chart's real pitch, then scaled to the text
  // column so their proportions survive.
  function fitLayers() {
    var scenes = document.querySelectorAll('.pl-layer-scene');
    for (var i = 0; i < scenes.length; i++) {
      var scene = scenes[i];
      var w = scene.offsetWidth;
      var h = scene.offsetHeight;
      if (!w || !h) { continue; }
      var scale = Math.min(1, BOX.w / w, CFG.layerMaxHeight / h);
      scene.style.transform = 'scale(' + scale + ')';
      scene.parentNode.style.width = Math.ceil(w * scale) + 'px';
      scene.parentNode.style.height = Math.ceil(h * scale) + 'px';
    }
  }

  function run() {
    fitLayers();
    fitPoster();
    document.documentElement.setAttribute('data-fitted', '1');
  }

  // Fit as soon as the DOM is parsed rather than waiting on 'load'. Every tile
  // is a fixed 130px frame and every row is sized by its text, so no image has
  // any say in the geometry — and waiting for a slow remote cover would leave
  // the chart unfitted for as long as that cover took, or forever. The second
  // pass on 'load' only re-checks once everything has settled.
  function schedule() {
    run();
    window.addEventListener('load', run, { once: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule, { once: true });
  }
  else {
    schedule();
  }
})();
`
}

/**
 * Builds the complete, self-contained print document for a chart.
 *
 * The chart must already have its stored assets inlined (see
 * `inlineChartAssetsForExport`) or the print window has no way to resolve
 * `local-asset://` URLs.
 */
export function buildPrintDocument(chart: Chart, options: PrintDocumentOptions): string {
  const paperName: PaperName = options.paper || 'A4'
  const marginMm = options.marginMm ?? 12
  const posterPage = options.posterPage || 'off'
  const paper = PAPER[paperName]
  const fontLink = webFontLink(chart.font)

  const layerParents = new Set(
    Object.entries(chart.relatedLayers || {})
      .filter(([, layer]) => layer && Object.keys(layer).length > 0)
      .map(([parentId]) => parentId),
  )
  const ctx: ItemContext = { chart, hasLayer: item => layerParents.has(item.id) }

  const poster = `<section class="pl-poster"><div class="pl-poster-fit"><div class="pl-poster-scale">${
    chartHtml(chart, ctx)
  }</div></div></section>`

  const details = detailHtml(chart, ctx, options)

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">`
    + `<title>${escapeHtml(options.title || chart.title || 'chart')}</title>${
      fontLink
    }<style>${stylesheet(paperName, marginMm, posterPage !== 'off')}</style>`
    + `</head><body>${
      poster
    }${details
    }<script>${fitScript(paper, marginMm, posterPage)}</script>`
    + `</body></html>`
}
