<script setup lang="ts">
import { BIconDiagram3 } from 'bootstrap-icons-vue'
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useStore } from '../../../store'
import LayerTile from './LayerTile.vue'
import TileLinks from './TileLinks.vue'

const store = useStore()

// True while a layer tile is mid-drag. The empty-cell drop targets below are
// inert until then, so they never swallow the backdrop clicks that exit focus.
const isDraggingLayerTile = ref(false)

// ---------------------------------------------------------------------------
// The reserved mindmap spot ("il primo tile in basso a destra")
// ---------------------------------------------------------------------------
// A fixed cell in the focused tile's layer, preferred at the parent's
// bottom-right (offset +1,+1), that no layer tile can occupy. It hosts the
// "Has mindmap?" Yes/No for first-layer (grid) tiles; once Yes is clicked the
// spot shows only the mindmap icon — there is no way back to No. Clicking the
// icon opens the map (the old hover icon on the grid tile is gone).
const spotOffset = computed(() => store.focusedMindmapSpotOffset)
const hasFocusedMindmap = computed(() => !!store.focusedTileId && !!store.chart.mindmaps?.[store.focusedTileId])
// "No" collapses the toggle for this focus session; the spot offers the
// choice again the next time the layer is opened.
const spotDismissed = ref(false)

// "Yes": create the blank sheet and record it on the focused tile. The spot
// then flips to the mindmap icon (hasFocusedMindmap turns true). A refused
// write leaves the toggle in place.
async function createFocusedMindmap() {
  const itemId = store.focusedTileId
  if (!itemId) {
    return
  }
  await store.createMindmapForTile(itemId)
}

// The spot's icon: select the focused grid tile, then open — openMindmap
// reads the selection, exactly like the old grid-tile button did.
function openFocusedMindmap() {
  const coord = store.focusedTileCoord
  if (!coord) {
    return
  }
  store.selectTile(coord)
  store.openMindmap()
}

// A fresh focus session brings the toggle back after a previous "No".
watch(() => store.focusedTileId, () => {
  spotDismissed.value = false
})

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
// are both invisible and unable to receive the drop. The reserved mindmap spot
// is not a drop target either — it is not a layer cell.
const emptyOffsets = computed(() => {
  const parent = focusedTileCoord.value
  if (!parent) {
    return []
  }

  const occupied = new Set(['0,0', ...layerEntries.value.map(entry => entry.offset)])
  if (spotOffset.value) {
    occupied.add(spotOffset.value)
  }
  const offsets: string[] = []

  for (let y = 1; y <= store.chart.size.y; y += 1) {
    for (let x = 1; x <= store.chart.size.x; x += 1) {
      const key = `${x - parent.x},${y - parent.y}`
      if (!occupied.has(key)) {
        offsets.push(key)
      }
    }
  }

  return offsets
})

// Rendered only during a layer-tile drag, when they are actually drop
// targets; at rest they would be ~3,600 hidden absolutely-positioned boxes.
const dropCellOffsets = computed(() => (isDraggingLayerTile.value ? emptyOffsets.value : []))

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

// Geometry is re-read on scroll and resize; both listeners are rAF-throttled
// so a 60x60 chart doesn't run thousands of getBoundingClientRect calls on
// every scroll tick.
let geometryFrame: number | null = null

function scheduleGeometryUpdate() {
  if (geometryFrame !== null) {
    return
  }
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = null
    updateGeometry()
  })
}

function parseOffset(offset: string): { x: number, y: number } {
  const [xRaw, yRaw] = offset.split(',')
  const x = Number.parseInt(xRaw)
  const y = Number.parseInt(yRaw)
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return { x: 0, y: 0 }
  }
  return { x, y }
}

function getCellRect(offset: string): { left: number, top: number } {
  const parent = focusedTileCoord.value
  if (!parent) {
    return { left: 0, top: 0 }
  }

  const { x, y } = parseOffset(offset)
  const absX = parent.x + x
  const absY = parent.y + y
  const index = (absY - 1) * store.chart.size.x + (absX - 1)
  const cell = document.querySelector(`.item[data-index="${index}"]`)
  if (!cell) {
    return { left: 0, top: 0 }
  }

  const rect = cell.getBoundingClientRect()
  return { left: rect.left, top: rect.top }
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

  // Empty drop cells are only measured while a drag is live; measuring them
  // at rest was a getBoundingClientRect per cell on every scroll tick. The
  // reserved mindmap spot is always measured — it renders at rest.
  const offsets = ['0,0', ...layerEntries.value.map(entry => entry.offset)]
  if (spotOffset.value) {
    offsets.push(spotOffset.value)
  }
  if (isDraggingLayerTile.value) {
    offsets.push(...emptyOffsets.value)
  }
  for (const offset of offsets) {
    const cellRect = getCellRect(offset)
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

// The reserved mindmap spot, anchored to the same grid cell as a layer tile
// would be — it reads as a reserved cell of the layer.
const spotPos = computed(() => (spotOffset.value ? positions[spotOffset.value] : null))

function spotStyle(): Record<string, string> {
  const pos = spotPos.value
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
  // With the mindmap overlay open (opened from the reserved spot) Escape
  // belongs to the map: the first press closes it, only the next leaves focus.
  if (event.key === 'Escape' && store.focusedTileId && !store.notesPopupVisible && !store.mindmapKey) {
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
    () => store.chart.title,
    () => store.chart.showTitles,
    () => store.chart.font,
  ],
  updateGeometry,
  { immediate: true },
)

// Drop cells come and go with the drag; their positions need a fresh
// measurement on each transition.
watch(isDraggingLayerTile, () => {
  scheduleGeometryUpdate()
})

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('scroll', scheduleGeometryUpdate, true)
  window.addEventListener('resize', scheduleGeometryUpdate)
})

onUnmounted(() => {
  if (geometryFrame !== null) {
    cancelAnimationFrame(geometryFrame)
    geometryFrame = null
  }
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('scroll', scheduleGeometryUpdate, true)
  window.removeEventListener('resize', scheduleGeometryUpdate)
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
      v-for="offset in dropCellOffsets"
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
    <!-- The reserved mindmap spot: "Has mindmap?" Yes/No while the focused
    grid tile has no map, then only the mindmap icon (no way back to No).
    Rendered after the tiles so it paints above them; not a drop target. -->
    <div
      v-if="spotOffset && !spotDismissed"
      class="mindmap-spot"
      :style="spotStyle()"
    >
      <template v-if="hasFocusedMindmap">
        <button
          class="mindmap-spot-icon"
          title="Open mindmap"
          @click.stop="openFocusedMindmap"
        >
          <BIconDiagram3 />
        </button>
      </template>
      <template v-else>
        <span class="mindmap-spot-label">Mindmap?</span>
        <div class="mindmap-spot-toggle" role="group" aria-label="Has mindmap">
          <button type="button" @click.stop="createFocusedMindmap">
            Yes
          </button>
          <button type="button" @click.stop="spotDismissed = true">
            No
          </button>
        </div>
      </template>
    </div>
    <!-- Last, so the arrows paint over the tiles they cross on the way. Only
    this layer's own links: the getter filters to ids inside it, and the query
    is scoped to this host, so the grid's arrows never appear here. -->
    <TileLinks :links="store.focusedLayerLinks" />
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

/* The reserved mindmap spot — same footprint as a layer tile so it reads as a
   reserved cell, but it is chrome (never a layer entry): the backdrop can't
   exit focus through it, and layer-tile drags can't land on it. */
.mindmap-spot {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  z-index: 42;
  pointer-events: auto;
  background: rgba(20, 20, 20, 0.72);
  border: 1px dashed rgba(99, 236, 255, 0.7);
  border-radius: 10px;
  color: #ffffff;
  animation: layer-tile-in 0.18s ease-out both;
}

.mindmap-spot-label {
  font-size: 0.72rem;
  opacity: 0.9;
}

.mindmap-spot-toggle {
  display: flex;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  overflow: hidden;
}

.mindmap-spot-toggle button {
  appearance: none;
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: #ffffff;
  padding: 6px 16px;
  font-size: 0.78rem;
  line-height: 1.2;
  cursor: pointer;
}

.mindmap-spot-toggle button:hover {
  background: rgba(255, 255, 255, 0.2);
}

.mindmap-spot-icon {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: none;
  border-radius: 12px;
  background: rgba(99, 236, 255, 0.18);
  color: #63ecff;
  cursor: pointer;
}

.mindmap-spot-icon:hover {
  background: rgba(99, 236, 255, 0.32);
}

.mindmap-spot-icon svg {
  width: 30px;
  height: 30px;
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
