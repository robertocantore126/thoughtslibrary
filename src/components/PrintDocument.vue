<script setup lang="ts">
import type { Chart, ChartItem } from '../types'
import { computed } from 'vue'
import { renderMarkdown } from '../helpers/markdown'

const props = defineProps<{
  chart: Chart
  chartImage: string
}>()

const MINI_TILE_SIZE_PX = 96

// The rating colour ramp in Item.vue — a print document must show the same
// stars the chart does, so the two exports agree.
function starColorOf(item: ChartItem): string {
  if (item.title.trim().toLowerCase() === 'frusciante') {
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

function ratingOf(item: ChartItem): number {
  const raw = item.rating
  if (!raw) {
    return 0
  }

  return Math.max(1, Math.min(7, Math.round(raw)))
}

function titleOf(item: ChartItem): string {
  return [item.creator, item.title].filter(Boolean).join(' - ') || 'Untitled'
}

// App-relative assets (e.g. the `/thought_tile.svg` thought icon) only resolve
// against the running app; bake in the absolute URL so they survive
// serialization into the standalone print window.
function coverSrc(item: ChartItem): string {
  if (!item.coverURL.startsWith('/')) {
    return item.coverURL
  }

  try {
    return new URL(item.coverURL, window.location.origin).href
  }
  catch {
    return item.coverURL
  }
}

interface CellView {
  dx: number
  dy: number
  item: ChartItem
  isParent: boolean
  title: string
  stars: number
  starColor: string
}

interface TextBlock {
  coord: string
  item: ChartItem
  title: string
  stars: number
  starColor: string
}

interface Entry {
  key: string
  item: ChartItem
  hasLayer: boolean
  cells: CellView[]
  blocks: TextBlock[]
  bounds: {
    minX: number
    minY: number
    cols: number
    rows: number
  }
}

function toCell(item: ChartItem, dx: number, dy: number, isParent: boolean): CellView {
  return {
    dx,
    dy,
    item,
    isParent,
    title: titleOf(item),
    stars: ratingOf(item),
    starColor: starColorOf(item),
  }
}

function toBlock(item: ChartItem, coord: string): TextBlock {
  return {
    coord,
    item,
    title: titleOf(item),
    stars: ratingOf(item),
    starColor: starColorOf(item),
  }
}

// Every non-null grid tile in reading order (chart.items is derived from the
// coordinates, so this matches how the grid renders). Tiles with a layer keep
// the layer's cells and a text block per tile; tiles without one become a
// single text block.
const entries = computed<Entry[]>(() => {
  const layers = props.chart.relatedLayers || {}
  const width = props.chart.size.x
  const result: Entry[] = []

  // The coordinate comes from the index, not from a lookup in `coordinates`.
  // `items` is built by itemsFromCoordinates at exactly (y-1)*width + (x-1), so
  // the index IS the position. Searching `coordinates` by object identity used
  // to be the way, and it silently matched nothing: asset inlining clones
  // `items` and `coordinates` separately, so the two never share an object and
  // every tile was skipped, leaving the PDF with only its chart image.
  props.chart.items.forEach((item, index) => {
    if (!item) {
      return
    }

    const key = `${(index % width) + 1},${Math.floor(index / width) + 1}`

    const layer = layers[item.id]
    const hasLayer = !!layer && Object.keys(layer).length > 0

    const cells: CellView[] = [toCell(item, 0, 0, true)]
    const blocks: TextBlock[] = [toBlock(item, `Tile ${key}`)]

    let minX = 0
    let maxX = 0
    let minY = 0
    let maxY = 0

    if (hasLayer) {
      const layerCells: CellView[] = []

      for (const [offset, layerItem] of Object.entries(layer)) {
        const [dxRaw, dyRaw] = offset.split(',')
        const dx = Number.parseInt(dxRaw, 10)
        const dy = Number.parseInt(dyRaw, 10)

        if (Number.isNaN(dx) || Number.isNaN(dy)) {
          continue
        }

        layerCells.push(toCell(layerItem, dx, dy, false))
      }

      // Reading order for both the mini render and the tile text below it.
      layerCells.sort((a, b) => a.dy - b.dy || a.dx - b.dx)

      for (const cell of layerCells) {
        minX = Math.min(minX, cell.dx)
        maxX = Math.max(maxX, cell.dx)
        minY = Math.min(minY, cell.dy)
        maxY = Math.max(maxY, cell.dy)
        cells.push(cell)
        blocks.push(toBlock(cell.item, `Tile ${key} + (${cell.dx},${cell.dy})`))
      }
    }

    result.push({
      key,
      item,
      hasLayer,
      cells,
      blocks,
      bounds: {
        minX,
        minY,
        cols: maxX - minX + 1,
        rows: maxY - minY + 1,
      },
    })
  })

  return result
})

function miniGridStyle(entry: Entry) {
  const gap = Math.max(8, Math.round(props.chart.gap / 2))
  const rowGap = Math.max(4, Math.round(gap / 2))

  return {
    gridTemplateColumns: `repeat(${entry.bounds.cols}, ${MINI_TILE_SIZE_PX}px)`,
    gridTemplateRows: `repeat(${entry.bounds.rows}, ${MINI_TILE_SIZE_PX}px)`,
    gap: `${rowGap}px ${gap}px`,
    fontFamily: `${props.chart.font || 'monospace'}, monospace`,
  }
}

function miniTileStyle(entry: Entry, cell: CellView) {
  return {
    gridColumn: cell.dx - entry.bounds.minX + 1,
    gridRow: cell.dy - entry.bounds.minY + 1,
  }
}
</script>

<template>
  <div class="print-doc-root">
    <section class="print-doc-cover">
      <img
        v-if="chartImage"
        class="print-doc-chart-image"
        :src="chartImage"
        alt="Chart"
      >
    </section>

    <h1 v-if="chart.title" class="print-doc-heading">
      {{ chart.title }}
    </h1>

    <section
      v-for="entry in entries"
      :key="entry.key"
      class="print-doc-group"
    >
      <div v-if="entry.hasLayer" class="print-doc-mini">
        <div class="print-doc-mini-grid" :style="miniGridStyle(entry)">
          <div
            v-for="cell in entry.cells"
            :key="`${cell.dx},${cell.dy}`"
            class="print-doc-mini-tile"
            :class="{ 'is-parent': cell.isParent }"
            :style="miniTileStyle(entry, cell)"
          >
            <div class="print-doc-mini-frame">
              <span v-if="cell.stars > 0" class="print-doc-mini-rating" aria-label="Item rating">
                <span
                  v-for="star in cell.stars"
                  :key="`star-${star}`"
                  :style="{ color: cell.starColor }"
                >
                  {{ '\u2605' }}
                </span>
              </span>
              <span v-if="cell.item.notes?.trim()" class="print-doc-mini-notes" aria-hidden />
              <img
                v-if="cell.item.itemType === 'thought' && cell.item.attachmentURL"
                class="print-doc-mini-attachment"
                :src="cell.item.attachmentURL"
                alt="Thought attachment"
              >
              <img
                class="print-doc-mini-cover"
                :src="coverSrc(cell.item)"
                alt=""
              >
            </div>
            <p v-if="chart.showTitles" class="print-doc-mini-title">
              {{ cell.title }}
            </p>
          </div>
        </div>
      </div>

      <div class="print-doc-text">
        <div
          v-for="block in entry.blocks"
          :key="block.coord"
          class="print-doc-entry"
        >
          <p class="print-doc-coord">
            {{ block.coord }}
          </p>
          <h2 class="print-doc-entry-title">
            {{ block.title }}
          </h2>
          <p v-if="block.stars > 0" class="print-doc-entry-rating" aria-label="Item rating">
            <span
              v-for="star in block.stars"
              :key="`star-${star}`"
              :style="{ color: block.starColor }"
            >
              {{ '\u2605' }}
            </span>
          </p>
          <div
            v-if="block.item.notes?.trim()"
            class="print-doc-notes"
            v-html="renderMarkdown(block.item.notes)"
          />
          <img
            v-if="block.item.itemType === 'thought' && block.item.attachmentURL"
            class="print-doc-attachment"
            :src="block.item.attachmentURL"
            alt="Thought attachment"
          >
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.print-doc-root {
  display: block;
  color: #111111;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 12px;
  line-height: 1.5;
  background: #ffffff;
}

.print-doc-cover {
  break-after: page;
  page-break-after: always;
  margin: 0;
}

.print-doc-chart-image {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}

.print-doc-heading {
  margin: 0 0 18px;
  padding-bottom: 8px;
  border-bottom: 2px solid #dddddd;
  color: #111111;
  font-size: 24px;
}

.print-doc-group {
  break-after: page;
  page-break-after: always;
}

.print-doc-group:last-child {
  break-after: auto;
  page-break-after: auto;
}

.print-doc-mini {
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 0 0 20px;
}

.print-doc-mini-grid {
  display: grid;
  width: max-content;
}

.print-doc-mini-tile {
  position: relative;
  min-width: 0;
}

.print-doc-mini-frame {
  position: relative;
  width: 96px;
  height: 96px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.print-doc-mini-tile.is-parent .print-doc-mini-frame {
  outline: 3px solid #ff7f50;
  outline-offset: -2px;
}

.print-doc-mini-cover {
  max-width: 100%;
  max-height: 100%;
  height: inherit;
}

.print-doc-mini-rating {
  position: absolute;
  top: 2px;
  left: 2px;
  display: flex;
  gap: 1px;
  background: rgba(0, 0, 0, 0.58);
  border-radius: 3px;
  padding: 1px 3px 2px;
  z-index: 2;
}

.print-doc-mini-rating span {
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.print-doc-mini-notes {
  position: absolute;
  right: 4px;
  bottom: 4px;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: #ff7f50;
  z-index: 2;
}

.print-doc-mini-attachment {
  position: absolute;
  bottom: 3px;
  left: 3px;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: cover;
  border: 1px solid rgba(255, 255, 255, 0.8);
  z-index: 3;
}

.print-doc-mini-title {
  margin: 4px 0 0;
  font-size: 9px;
  line-height: 1.25;
  text-align: left;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.print-doc-text {
  margin: 0;
}

.print-doc-entry {
  break-inside: avoid;
  page-break-inside: avoid;
  margin: 0 0 18px;
  padding: 10px 12px;
  border-left: 3px solid #ff7f50;
  background: #f7f7f7;
}

.print-doc-coord {
  margin: 0 0 2px;
  color: #777777;
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.print-doc-entry-title {
  margin: 0 0 2px;
  color: #111111;
  font-size: 16px;
}

.print-doc-entry-rating {
  margin: 0 0 4px;
}

.print-doc-entry-rating span {
  font-size: 14px;
  font-weight: 700;
}

.print-doc-notes {
  margin: 6px 0 0;
}

.print-doc-notes p {
  margin: 0 0 6px;
}

.print-doc-notes h1,
.print-doc-notes h2,
.print-doc-notes h3,
.print-doc-notes h4,
.print-doc-notes h5,
.print-doc-notes h6 {
  margin: 8px 0 4px;
  color: #111111;
}

.print-doc-notes ul,
.print-doc-notes ol {
  margin: 0 0 6px;
  padding-left: 20px;
}

.print-doc-notes a {
  color: #0b5cad;
}

.print-doc-notes blockquote {
  margin: 0 0 6px;
  padding-left: 10px;
  border-left: 3px solid #cccccc;
  color: #444444;
}

.print-doc-notes code {
  padding: 1px 3px;
  border-radius: 3px;
  background: #eeeeee;
  font-size: 0.9em;
}

.print-doc-notes pre {
  padding: 8px;
  border-radius: 4px;
  background: #eeeeee;
  overflow: hidden;
  white-space: pre-wrap;
}

.print-doc-notes img {
  max-width: 100%;
}

.print-doc-attachment {
  display: block;
  max-width: 120px;
  max-height: 120px;
  margin-top: 6px;
  border-radius: 6px;
}
</style>

<!--
  Plain (unscoped) block: the rules that must apply beyond this component's own
  subtree. `@media print` hides the running app so the web fallback
  (`window.print()`) prints only the document, and `@page` fixes the paper size
  for both that fallback and the Electron print window (the renderer carries
  `@page` over when it serializes these styles).
-->
<style>
@media screen {
  .print-doc-root {
    display: none;
  }
}

@media print {
  body > *:not(.print-doc-root) {
    display: none !important;
  }

  .print-doc-root {
    display: block !important;
  }
}

@page {
  size: A4;
  margin: 12mm;
}
</style>
