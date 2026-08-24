<script setup lang="ts">
import type { ComputedRef, CSSProperties } from 'vue'
import type { ChartItem } from '../../../types'
import { BIconDiagram3, BIconX } from 'bootstrap-icons-vue'
import { v4 as uuidv4 } from 'uuid'
import { computed } from 'vue'
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'
import { resolveDroppedImage } from '../../../helpers/imageDrop'
import { isLinkDrag, readLinkSourceId, startLinkDrag } from '../../../helpers/linkDrag'
import { useStore } from '../../../store'
import MindmapOverlay from './MindmapOverlay.vue'

const props = defineProps(['item', 'index', 'title', 'number'])

const store = useStore()
const BASE_ITEM_SIZE_PX = 130
let dragImageContainer: HTMLElement | null = null

const imgStyle: ComputedRef<CSSProperties> = computed(() => ({
  borderRadius: store.chart.roundCorners ? '10px' : '',
  boxShadow: store.chart.shadows ? '2px 2px 4px rgba(0,0,0,0.6)' : '',
}))

const tileCoordinates = computed(() => ({
  x: (props.index % store.chart.size.x) + 1,
  y: Math.floor(props.index / store.chart.size.x) + 1,
}))
const itemStyle: CSSProperties = {
  width: `${BASE_ITEM_SIZE_PX}px`,
  minWidth: `${BASE_ITEM_SIZE_PX}px`,
}
const coverFrameStyle: CSSProperties = {
  width: `${BASE_ITEM_SIZE_PX}px`,
  height: `${BASE_ITEM_SIZE_PX}px`,
}
const titleStyle: CSSProperties = {
  fontSize: '0.62rem',
  lineHeight: '1.2',
}

const tileKey = computed(() => `${tileCoordinates.value.x},${tileCoordinates.value.y}`)
const isActiveTile = computed(() => store.activeTileKey === tileKey.value)
const isFocusedTile = computed(() => !!props.item && store.focusedTileId === props.item.id)
const isDimmed = computed(() => !!store.focusedTileId && !isFocusedTile.value)
// The one tile whose mindmap is open hosts the overlay; the chart store's
// mindmapKey is the Selection, so only the matching Item mounts it.
const isMindmapHost = computed(() => !!props.item && store.mindmapKey?.kind === 'tile' && store.mindmapKey.key === tileKey.value)
const hasMindmap = computed(() => !!props.item && !!store.chart.mindmaps?.[props.item.id])
const rawThoughtAttachmentUrl = computed(() => {
  const isThoughtLike = props.item?.itemType === 'thought' || props.item?.coverURL === '/thought_tile.svg'
  if (!isThoughtLike) {
    return ''
  }

  return props.item.attachmentURL || ''
})
const itemCoverUrl = useResolvedImageUrl(() => props.item?.coverURL)
const thoughtAttachmentUrl = useResolvedImageUrl(() => rawThoughtAttachmentUrl.value)
const normalizedRating = computed(() => {
  const raw = props.item?.rating
  if (!raw) {
    return 0
  }

  return Math.max(1, Math.min(7, Math.round(raw)))
})
const shownStars = computed(() => Array.from({ length: normalizedRating.value }, (_, i) => i + 1))
const ratingColor = computed(() => {
  if (props.item?.title?.trim().toLowerCase() === 'frusciante') {
    return '#000000'
  }

  if (normalizedRating.value <= 4) {
    return '#ffd84d'
  }
  if (normalizedRating.value === 5) {
    return '#ff9b3d'
  }
  if (normalizedRating.value === 6) {
    return '#b17bff'
  }
  return '#63ecff'
})

function allowDrop(ev: DragEvent) {
  ev.preventDefault()

  // A link drag is answered from `types` alone, before the payload is
  // readable. An empty tile has no item to point at, so it refuses.
  if (isLinkDrag(ev.dataTransfer)) {
    ev.dataTransfer!.dropEffect = props.item ? 'link' : 'none'
    return
  }

  if (ev.dataTransfer) {
    const isInternalDrag = Array.from(ev.dataTransfer.types).includes('application/json')
    let dropEffect: DataTransfer['dropEffect'] = isInternalDrag ? 'move' : 'copy'

    if (isInternalDrag) {
      try {
        const dragData = JSON.parse(ev.dataTransfer.getData('application/json') || 'null')

        // A layer-tile drag never lands on the grid.
        if (dragData && typeof dragData.parentId === 'string') {
          dropEffect = 'none'
        }
        else if (dragData && Number.isInteger(dragData.originalIndex) && !store.canMoveTile(dragData.originalIndex, props.index)) {
          // Moving here would push a layer tile out of bounds.
          dropEffect = 'none'
        }
      }
      catch {
        // Malformed payload: keep the default effect.
      }
    }

    ev.dataTransfer.dropEffect = dropEffect
  }
}

function handleDragStart(ev: DragEvent) {
  if (!props.item) {
    return null
  }

  // The notes popup is anchored to its tile, so it would hang over a stale
  // position for the whole drag. Close it as soon as the drag begins.
  store.closeNotesPopup()

  // Shift turns the drag into a link gesture: same grab, different meaning, so
  // the move payload is never written and the tile cannot be relocated by it.
  if (ev.shiftKey) {
    startLinkDrag(ev, props.item.id)
    return
  }

  const dragData = JSON.stringify({
    originalIndex: props.index,
  })

  if (ev.dataTransfer) {
    const dragImg = new Image()
    dragImg.classList.add('dnd-img')
    dragImg.src = itemCoverUrl.value || props.item.coverURL

    const container = document.createElement('div')
    container.classList.add('dnd-container')
    container.appendChild(dragImg)

    const scaledSize = BASE_ITEM_SIZE_PX
    container.style.height = `${scaledSize}px`
    container.style.width = `${scaledSize}px`

    const appEl = document.querySelector('#app')
    appEl?.appendChild(container)
    dragImageContainer = container

    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('application/json', dragData)
    ev.dataTransfer.setDragImage(container, scaledSize / 2, scaledSize / 2)
  }
}

// The drag image has to be a real element in the document for setDragImage to
// use it, so it is parked offscreen by .dnd-container. Without this it stayed
// there forever, leaking a node and a decoded image on every single drag.
function handleDragEnd() {
  dragImageContainer?.remove()
  dragImageContainer = null
}

function addDroppedImageToTile(coverURL: string, title: string) {
  store.addItem({
    item: {
      id: uuidv4(),
      title: title || 'Dropped image',
      coverURL,
    },
    index: props.index,
  })
}

function isChartItem(value: unknown): value is ChartItem {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<ChartItem>
  return typeof candidate.title === 'string' && typeof candidate.coverURL === 'string'
}

async function tryHandleExternalImageDrop(ev: DragEvent): Promise<boolean> {
  const dropped = await resolveDroppedImage(ev)
  if (!dropped) {
    return false
  }

  addDroppedImageToTile(dropped.coverURL, dropped.title)
  return true
}

async function handleDrop(ev: DragEvent) {
  ev.preventDefault()

  if (isLinkDrag(ev.dataTransfer)) {
    const sourceId = readLinkSourceId(ev)
    if (sourceId && props.item) {
      store.addTileLink({ from: sourceId, to: props.item.id })
    }
    return
  }

  let dragData: { item?: unknown, originalIndex?: number } | null = null
  try {
    dragData = JSON.parse(ev.dataTransfer?.getData('application/json') || 'null')
  }
  catch {
    dragData = null
  }

  if (dragData && Number.isInteger(dragData.originalIndex)) {
    store.moveItem({ oldIndex: dragData.originalIndex, newIndex: props.index })
    return
  }

  if (dragData && isChartItem(dragData.item)) {
    store.addItem({ item: dragData.item, index: props.index })
    return
  }

  await tryHandleExternalImageDrop(ev)
}

function handleTileClick(event: MouseEvent) {
  if ((event.ctrlKey || event.metaKey) && props.item) {
    event.preventDefault()
    event.stopPropagation()
    deleteItem()
    return
  }

  if (!props.item) {
    return
  }

  store.selectTile(tileCoordinates.value)
}

function handleContextMenu() {
  if (!props.item) {
    return
  }

  store.toggleFocus(props.item.id)
}

function deleteItem() {
  store.addItem({ item: null, index: props.index })
}

// The entry point that opens a mindmap for this grid tile, following how the
// notes popup is opened: select the tile first, then open — openMindmap reads
// the selection. Related-layer tiles never carry a mindmap (Lane F).
function openMindmap() {
  if (!props.item) {
    return
  }
  store.selectTile(tileCoordinates.value)
  store.openMindmap()
}
</script>

<template>
  <div
    :key="props.item ? props.item.coverURL : props.index"
    :class="`item ${props.item ? '' : 'placeholder'} ${isFocusedTile ? 'focused' : ''} ${isDimmed ? 'dimmed' : ''}`"
    :data-index="props.index"
    :style="props.item ? itemStyle : { ...itemStyle, ...imgStyle }"
    @click="handleTileClick"
    @dragover="allowDrop"
    @drop="handleDrop"
  >
    <!-- The cover is the drag handle and the right-click target rather than the
    whole tile, so the title below stays selectable and keeps the browser's own
    context menu for copying. Text inside a draggable element can't be selected -
    a mousedown-drag there starts a drag instead. Drops still land anywhere on
    the tile. -->
    <div
      :class="`cover-frame ${isActiveTile ? 'active-tile' : ''}`"
      :data-item-id="props.item ? props.item.id : undefined"
      :style="coverFrameStyle"
      :draggable="props.item ? 'true' : 'false'"
      @dragstart="handleDragStart"
      @dragend="handleDragEnd"
      @contextmenu.prevent="handleContextMenu"
    >
      <div v-if="shownStars.length > 0" class="rating-indicator" aria-label="Item rating">
        <span
          v-for="star in shownStars"
          :key="`star-${star}`"
          class="rating-star"
          :style="{ color: ratingColor }"
        >
          {{ '\u2605' }}
        </span>
      </div>
      <span v-if="props.item && store.tileHasLayer(props.item.id)" class="layer-indicator" aria-hidden />
      <span v-else-if="props.item?.notes?.trim()" class="notes-indicator" aria-hidden />
      <span v-if="hasMindmap" class="mindmap-indicator" aria-hidden />
      <img
        v-if="thoughtAttachmentUrl"
        :src="thoughtAttachmentUrl"
        :data-stored-src="rawThoughtAttachmentUrl"
        class="thought-attachment"
        alt="Thought attachment"
      >
      <button
        v-if="props.item"
        class="delete-button"
        data-html2canvas-ignore
        title="Delete item"
        @click.stop="deleteItem"
      >
        <BIconX />
      </button>
      <button
        v-if="props.item"
        class="mindmap-button"
        data-html2canvas-ignore
        :title="hasMindmap ? 'Open mindmap' : 'New mindmap'"
        @click.stop="openMindmap"
      >
        <BIconDiagram3 />
      </button>
      <img
        v-if="item"
        :src="itemCoverUrl"
        :data-stored-src="props.item?.coverURL || ''"
        class="item-img"
        :style="imgStyle"
      >
    </div>
    <p v-if="props.item && store.chart.showTitles" class="item-title" :style="titleStyle">
      {{ store.chart.showNumbers && props.number ? `${props.number}. ` : '' }}{{ props.title }}
    </p>
    <MindmapOverlay v-if="isMindmapHost" />
  </div>
</template>

<style scoped>
.item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 4px;
  touch-action: pinch-zoom;
  transition: opacity 200ms ease;
}

.item.dimmed {
  /* 0.15 per the related-layers brief; the overlay's backdrop wash darkens
     the field behind the layer on top of this. */
  opacity: 0.15;
}

.item.focused {
  z-index: 2;
}

.cover-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.cover-frame.active-tile {
  outline: 3px solid #ff7f50;
  outline-offset: -2px;
}

.notes-indicator {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: #ff7f50;
  pointer-events: none;
  z-index: 2;
}

.layer-indicator {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid #ffd700;
  background: transparent;
  pointer-events: none;
  z-index: 2;
}

.mindmap-indicator {
  /* Above the notes/layer dots so a tile can carry a map and notes at once. */
  position: absolute;
  right: 6px;
  bottom: 22px;
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: #63ecff;
  pointer-events: none;
  z-index: 2;
}

.rating-indicator {
  position: absolute;
  top: 4px;
  left: 4px;
  display: flex;
  gap: 1px;
  background: rgba(0, 0, 0, 0.58);
  border-radius: 3px;
  padding: 1px 3px 2px;
  pointer-events: none;
  z-index: 2;
}

.rating-star {
  font-size: 0.76rem;
  font-weight: 700;
  line-height: 1;
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.85);
}

.item-img {
  max-height: 100%;
  max-width: 100%;
  height: inherit;
}

.thought-attachment {
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
  pointer-events: none;
}

.item-img:hover {
  cursor: pointer;
}

.delete-button {
  display: none;
  position: absolute;
  top: 5px;
  right: 5px;
  height: 30px;
  width: 30px;
  appearance: none;
  background-color: rgba(0, 0, 0, 0.6);
  border-radius: 5px;
  color: #ffffff;
  border: none;
}

.delete-button:hover {
  cursor: pointer;
}

.delete-button svg {
  height: 100%;
  width: 100%;
}

.item:hover .delete-button {
  display: initial;
}

.mindmap-button {
  /* Beside the delete button, which owns the top-right corner. */
  display: none;
  position: absolute;
  top: 5px;
  right: 38px;
  height: 30px;
  width: 30px;
  align-items: center;
  justify-content: center;
  padding: 0;
  appearance: none;
  background-color: rgba(0, 0, 0, 0.6);
  border-radius: 5px;
  color: #ffffff;
  border: none;
  cursor: pointer;
}

.mindmap-button:hover {
  cursor: pointer;
}

.mindmap-button svg {
  height: 100%;
  width: 100%;
}

.item:hover .mindmap-button {
  display: flex;
}

.placeholder {
  background-color: rgba(90, 90, 90, 0.6);
  touch-action: auto;
}

.item-title {
  /* Selectable for copying, but never editable - editing stays in the sidebar. */
  user-select: text;
  cursor: text;
  margin: 0;
  font-size: 0.62rem;
  line-height: 1.2;
  text-align: left;
  white-space: normal;
  overflow: visible;
  text-overflow: initial;
  overflow-wrap: anywhere;
  word-break: break-word;
}

@media (hover: none) {
  .delete-button {
    display: initial;
  }

  .mindmap-button {
    display: flex;
  }
}
</style>
