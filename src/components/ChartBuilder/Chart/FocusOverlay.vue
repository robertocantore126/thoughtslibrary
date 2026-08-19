<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { layerReachOf, useStore } from '../../../store'
import LayerTile from './LayerTile.vue'

const store = useStore()

// True while a layer tile is mid-drag. The empty-cell drop targets below are
// inert until then, so they never swallow the backdrop clicks that exit focus.
const isDraggingLayerTile = ref(false)

const isFocusMode = computed(() => !!store.focusedTileId)
const focusedTileId = computed(() => store.focusedTileId || '')
const focusedTileCoord = computed(() => store.focusedTileCoord)

// Flat index of the focused tile's grid cell, used to locate its DOM element.
const focusedTileIndex = computed(() => {
  const coord = focusedTileCoord.value
  if (!coord) {
    return -1
  }
  return (coord.y - 1) * store.chart.size.x + (coord.x - 1)
})

// The parent renders in the overlay too (at "0,0"), with its + buttons.
const parentItem = computed(() => {
  const index = focusedTileIndex.value
  if (index < 0) {
    return null
  }
  return store.items[index]?.data ?? null
})

// Layer tiles other than the parent's own cell ("0,0" is never stored).
const layerEntries = computed(() => {
  const layer = store.focusedLayer
  if (!layer) {
    return []
  }
  return Object.entries(layer)
    .filter(([offset]) => offset !== '0,0')
    .map(([offset, item]) => ({ offset, item }))
})

// Every empty in-bounds cell of the layer, as a drop target for moving a tile.
// The + buttons can't serve this: they only appear on :hover, and hover states
// are suppressed for the whole duration of an HTML5 drag, so during a move they
// are both invisible and unable to receive the drop.
const emptyOffsets = computed(() => {
  if (!focusedTileCoord.value) {
    return []
  }

  const occupied = new Set(['0,0', ...layerEntries.value.map(entry => entry.offset)])
  const reach = layerReachOf(store.chart)
  const offsets: string[] = []

  // The layer is its own space around the parent, so this spans the reach
  // rather than the chart's cells.
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      const key = `${dx},${dy}`
      if (!occupied.has(key)) {
        offsets.push(key)
      }
    }
  }

  return offsets
})

function handleDropCellDragOver(event: DragEvent) {
  if (!isDraggingLayerTile.value || !event.dataTransfer) {
    return
  }

  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

function handleDropCellDrop(event: DragEvent, offset: string) {
  event.preventDefault()
  isDraggingLayerTile.value = false

  let dragData: { parentId?: unknown, offset?: unknown } | null = null
  try {
    dragData = JSON.parse(event.dataTransfer?.getData('application/json') || 'null')
  }
  catch {
    return
  }

  if (typeof dragData?.parentId !== 'string' || typeof dragData?.offset !== 'string') {
    return
  }

  if (dragData.parentId !== focusedTileId.value) {
    return
  }

  store.moveLayerTile({
    parentId: dragData.parentId,
    fromOffset: dragData.offset,
    toOffset: offset,
  })
}

const hostStyle = reactive({ left: 0, top: 0, width: 0, height: 0 })
const positions = reactive<Record<string, { left: number, top: number }>>({})

function parseOffset(offset: string): { x: number, y: number } {
  const [xRaw, yRaw] = offset.split(',')
  const x = Number.parseInt(xRaw)
  const y = Number.parseInt(yRaw)
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return { x: 0, y: 0 }
  }
  return { x, y }
}

// The parent's own grid cell is the anchor, and every other cell is stepped off
// it arithmetically. Looking each cell up by grid index cannot work any more: a
// layer reaches past the chart, where no `.item` element exists, and worse, the
// index arithmetic wraps - a cell one column past the right edge resolves to a
// real element on the next row, silently placing the tile in the wrong spot.
function getLayerOrigin(): { left: number, top: number, pitchX: number, pitchY: number } | null {
  const index = focusedTileIndex.value
  if (index < 0) {
    return null
  }

  const cell = document.querySelector(`.item[data-index="${index}"]`)
  if (!cell) {
    return null
  }

  const rect = cell.getBoundingClientRect()
  const gap = store.chart.gap

  return {
    left: rect.left,
    top: rect.top,
    // Matches Row.vue: columns are separated by max(6, gap / 2), rows by gap.
    // Taking the height from the parent's own cell keeps the layer aligned with
    // the grid wherever titles wrap to the same number of lines.
    pitchX: rect.width + Math.max(6, gap / 2),
    pitchY: rect.height + gap,
  }
}

function getCellRect(offset: string): { left: number, top: number } | null {
  const origin = getLayerOrigin()
  if (!origin) {
    return null
  }

  const { x, y } = parseOffset(offset)
  return {
    left: origin.left + x * origin.pitchX,
    top: origin.top + y * origin.pitchY,
  }
}

// Anchors every layer tile to the exact bounding box of the grid cell beneath
// it, so alignment survives wrapped titles, the chart title, and any gap
// combination. The host is clipped to the chart viewport so tiles never leak
// over other UI when the user scrolls mid-focus.
function updateGeometry() {
  const builder = document.querySelector('.chart-builder') as HTMLElement | null
  const viewport = document.querySelector('.chart-viewport') as HTMLElement | null
  if (!builder) {
    return
  }

  const builderRect = builder.getBoundingClientRect()
  const vpRect = viewport?.getBoundingClientRect() ?? builderRect

  hostStyle.left = vpRect.left - builderRect.left
  hostStyle.top = vpRect.top - builderRect.top
  hostStyle.width = vpRect.width
  hostStyle.height = vpRect.height

  const hostLeft = vpRect.left
  const hostTop = vpRect.top

  const offsets = ['0,0', ...layerEntries.value.map(entry => entry.offset), ...emptyOffsets.value]
  for (const offset of offsets) {
    const cellRect = getCellRect(offset)
    if (!cellRect) {
      delete positions[offset]
      continue
    }
    positions[offset] = {
      left: cellRect.left - hostLeft,
      top: cellRect.top - hostTop,
    }
  }
}

function tileStyle(offset: string, stagger: number): Record<string, string> {
  const pos = positions[offset]
  if (!pos) {
    return { animationDelay: `${stagger * 30}ms` }
  }
  return {
    left: `${pos.left}px`,
    top: `${pos.top}px`,
    animationDelay: `${stagger * 30}ms`,
  }
}

// Escape dismisses an open note first and only leaves focus mode on a second
// press. Clicking the backdrop behaves the same way, so a click meant to close
// a note doesn't also tear down the layer behind it. The note itself is closed
// by NotesPopup's own outside-click handler; this only records whether one was
// open when the press started, since by click time it has already gone.
let noteOpenAtPress = false

function handleBackdropMousedown() {
  noteOpenAtPress = store.notesPopupVisible
}

function handleBackdropClick() {
  if (noteOpenAtPress) {
    noteOpenAtPress = false
    return
  }

  store.exitFocus()
}

// Matches BASE_ITEM_SIZE_PX in LayerTile / Item, so a drop cell covers exactly
// the grid cell beneath it.
const CELL_SIZE_PX = 130

function dropCellStyle(offset: string): Record<string, string> {
  const pos = positions[offset]
  if (!pos) {
    return { display: 'none' }
  }

  return {
    left: `${pos.left}px`,
    top: `${pos.top}px`,
    width: `${CELL_SIZE_PX}px`,
    height: `${CELL_SIZE_PX}px`,
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && store.focusedTileId && !store.notesPopupVisible) {
    store.exitFocus()
  }
}

watch(
  [
    isFocusMode,
    layerEntries,
    focusedTileCoord,
    () => store.chart.size,
    () => store.chart.gap,
    () => store.chart.layerReach,
    () => store.chart.title,
    () => store.chart.showTitles,
    () => store.chart.font,
  ],
  updateGeometry,
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('scroll', updateGeometry, true)
  window.addEventListener('resize', updateGeometry)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('scroll', updateGeometry, true)
  window.removeEventListener('resize', updateGeometry)
})
</script>

<template>
  <div
    v-if="isFocusMode"
    class="focus-overlay"
    :style="{
      left: `${hostStyle.left}px`,
      top: `${hostStyle.top}px`,
      width: `${hostStyle.width}px`,
      height: `${hostStyle.height}px`,
    }"
  >
    <!-- Clicking anywhere that isn't a layer tile leaves focus mode. The tiles
    are later siblings, so they paint above this and swallow their own clicks. -->
    <div
      class="focus-backdrop"
      @mousedown="handleBackdropMousedown"
      @click="handleBackdropClick"
      @contextmenu.prevent="store.exitFocus()"
    />
    <!-- Drop targets for moving a tile within the layer. Inert until a drag
    starts, so they don't intercept the backdrop clicks that exit focus. -->
    <div
      v-for="offset in emptyOffsets"
      :key="`empty-${offset}`"
      class="layer-drop-cell"
      :class="{ active: isDraggingLayerTile }"
      :style="dropCellStyle(offset)"
      @dragover="handleDropCellDragOver"
      @drop="handleDropCellDrop($event, offset)"
    />
    <LayerTile
      v-if="parentItem"
      :item="parentItem"
      offset="0,0"
      :parent-id="focusedTileId"
      is-parent
      :style="tileStyle('0,0', 0)"
      @drag-state-change="isDraggingLayerTile = $event"
    />
    <LayerTile
      v-for="(entry, index) in layerEntries"
      :key="entry.offset"
      :item="entry.item"
      :offset="entry.offset"
      :parent-id="focusedTileId"
      :style="tileStyle(entry.offset, index + 1)"
      @drag-state-change="isDraggingLayerTile = $event"
    />
  </div>
</template>

<style scoped>
.focus-overlay {
  position: absolute;
  z-index: 40;
  overflow: hidden;
  pointer-events: none;
}

/* Tile opacity alone only fades tiles toward the chart's own background, which
   may be light. This wash darkens the whole field behind the layer regardless
   of what the chart background is set to. */
.focus-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.45);
  animation: focus-backdrop-in 200ms ease;
}

.layer-drop-cell {
  position: absolute;
  pointer-events: none;
  border-radius: 4px;
  z-index: 41;
}

.layer-drop-cell.active {
  pointer-events: auto;
  border: 2px dashed rgba(255, 216, 77, 0.5);
}

.layer-drop-cell.active:hover {
  border-color: rgba(255, 216, 77, 0.95);
  background: rgba(255, 216, 77, 0.12);
}

@keyframes focus-backdrop-in {
  from {
    background: rgba(0, 0, 0, 0);
  }
  to {
    background: rgba(0, 0, 0, 0.45);
  }
}
</style>
