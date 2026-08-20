<script setup lang="ts">
import type { ComputedRef, CSSProperties } from 'vue'
import type { ChartItem, Direction } from '../../../types'
import { BIconX } from 'bootstrap-icons-vue'
import { v4 as uuidv4 } from 'uuid'
import { computed } from 'vue'
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'
import { storeLocalImage } from '../../../helpers/assets'
import { useStore } from '../../../store'

const props = defineProps<{
  item: ChartItem
  offset: string
  parentId: string
  isParent?: boolean
}>()

// Lets the overlay arm its empty-cell drop targets only while a drag is live.
const emit = defineEmits<{
  dragStateChange: [dragging: boolean]
}>()

const store = useStore()
const BASE_ITEM_SIZE_PX = 130
let dragImageContainer: HTMLElement | null = null
const SUPPORTED_IMAGE_EXTENSIONS = /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i

// Canonical direction deltas — must match types.ts Direction.
const ADD_DIRECTIONS: Array<{ dir: Direction, dx: number, dy: number }> = [
  { dir: 'n', dx: 0, dy: -1 },
  { dir: 'ne', dx: 1, dy: -1 },
  { dir: 'e', dx: 1, dy: 0 },
  { dir: 'se', dx: 1, dy: 1 },
  { dir: 's', dx: 0, dy: 1 },
  { dir: 'sw', dx: -1, dy: 1 },
  { dir: 'w', dx: -1, dy: 0 },
  { dir: 'nw', dx: -1, dy: -1 },
]

function parseOffset(offset: string): { x: number, y: number } {
  const [xRaw, yRaw] = offset.split(',')
  const x = Number.parseInt(xRaw)
  const y = Number.parseInt(yRaw)
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return { x: 0, y: 0 }
  }
  return { x, y }
}

const displayTitle = computed(() => [props.item.creator, props.item.title].filter(Boolean).join(' - '))
const imgStyle: ComputedRef<CSSProperties> = computed(() => ({
  borderRadius: store.chart.roundCorners ? '10px' : '',
  boxShadow: store.chart.shadows ? '2px 2px 4px rgba(0,0,0,0.6)' : '',
}))
const itemStyle: ComputedRef<CSSProperties> = computed(() => ({
  width: `${BASE_ITEM_SIZE_PX}px`,
  minWidth: `${BASE_ITEM_SIZE_PX}px`,
}))
const coverFrameStyle: ComputedRef<CSSProperties> = computed(() => ({
  width: `${BASE_ITEM_SIZE_PX}px`,
  height: `${BASE_ITEM_SIZE_PX}px`,
}))
const titleStyle: ComputedRef<CSSProperties> = computed(() => ({
  fontSize: '0.62rem',
  lineHeight: '1.2',
}))

const rawThoughtAttachmentUrl = computed(() => {
  const isThoughtLike = props.item.itemType === 'thought' || props.item.coverURL === '/thought_tile.svg'
  if (!isThoughtLike) {
    return ''
  }

  return props.item.attachmentURL || ''
})
const itemCoverUrl = useResolvedImageUrl(() => props.item.coverURL)
const thoughtAttachmentUrl = useResolvedImageUrl(() => rawThoughtAttachmentUrl.value)
const normalizedRating = computed(() => {
  const raw = props.item.rating
  if (!raw) {
    return 0
  }

  return Math.max(1, Math.min(7, Math.round(raw)))
})
const shownStars = computed(() => Array.from({ length: normalizedRating.value }, (_, i) => i + 1))
const ratingColor = computed(() => {
  if (props.item.title?.trim().toLowerCase() === 'frusciante') {
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

const isSelected = computed(() =>
  store.selection?.kind === 'layer'
  && store.selection.parentId === props.parentId
  && store.selection.offset === props.offset,
)

// The cell a direction points at, relative to this tile's offset.
function targetOffset(direction: Direction): { x: number, y: number } {
  const delta = ADD_DIRECTIONS.find(d => d.dir === direction)
  const { x, y } = parseOffset(props.offset)
  return { x: x + (delta?.dx || 0), y: y + (delta?.dy || 0) }
}

// Whether the cell in `direction` from this tile is empty and in bounds.
// This is display logic only — the store still guards every write.
function isDirectionAvailable(direction: Direction): boolean {
  const target = targetOffset(direction)
  const parent = store.focusedTileCoord
  if (!parent) {
    return false
  }

  const absX = parent.x + target.x
  const absY = parent.y + target.y
  if (absX < 1 || absX > store.chart.size.x || absY < 1 || absY > store.chart.size.y) {
    return false
  }

  if (target.x === 0 && target.y === 0) {
    return false
  }

  return !store.focusedLayer?.[`${target.x},${target.y}`]
}

function addTile(direction: Direction) {
  if (!isDirectionAvailable(direction)) {
    return
  }

  store.addLayerTile({ parentId: props.parentId, fromOffset: props.offset, direction })
}

function handleTileClick(event: MouseEvent) {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault()
    event.stopPropagation()
    deleteLayerTile()
    return
  }

  // The parent is a grid tile, not a member of its own layer - offset "0,0" is
  // never stored, so selectLayerTile would find nothing and select nothing,
  // leaving the focused tile's own notes and rating unreachable while focused.
  if (props.isParent) {
    const coord = store.focusedTileCoord
    if (coord) {
      store.selectTile(coord)
    }
    return
  }

  store.selectLayerTile({ parentId: props.parentId, offset: props.offset })
}

// The overlay covers the focused grid tile, so Item.vue's own contextmenu
// handler can never fire while focus mode is on. Right-clicking the parent
// here is what actually toggles focus back off. Layer tiles are leaves, so
// on those we only suppress the native menu.
function handleContextMenu() {
  if (props.isParent) {
    store.exitFocus()
  }
}

function deleteLayerTile() {
  if (props.isParent) {
    // The parent is a grid tile: deleting it removes the tile itself and the
    // whole layer, so leave focus mode first.
    const coord = store.focusedTileCoord
    store.exitFocus()
    if (coord) {
      const index = (coord.y - 1) * store.chart.size.x + (coord.x - 1)
      store.addItem({ item: null, index })
    }
    return
  }

  store.setLayerTileItem({ parentId: props.parentId, offset: props.offset, item: null })
}

function parseDragData(ev: DragEvent): { item?: unknown, originalIndex?: number, parentId?: unknown, offset?: unknown } | null {
  try {
    return JSON.parse(ev.dataTransfer?.getData('application/json') || 'null')
  }
  catch {
    return null
  }
}

function isLayerDrag(dragData: unknown): dragData is { parentId: string, offset: string } {
  const candidate = dragData as { parentId?: unknown, offset?: unknown }
  return typeof candidate?.parentId === 'string' && typeof candidate?.offset === 'string'
}

function isChartItem(value: unknown): value is ChartItem {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<ChartItem>
  return typeof candidate.title === 'string' && typeof candidate.coverURL === 'string'
}

function handleDragStart(ev: DragEvent) {
  if (props.isParent) {
    return
  }

  // Same as the grid tiles: the popup is anchored, so drop it on drag start.
  store.closeNotesPopup()
  emit('dragStateChange', true)

  if (ev.dataTransfer) {
    const dragData = JSON.stringify({ parentId: props.parentId, offset: props.offset })

    const dragImg = new Image()
    dragImg.classList.add('dnd-img')
    dragImg.src = itemCoverUrl.value || props.item.coverURL

    const container = document.createElement('div')
    container.classList.add('dnd-container')
    container.appendChild(dragImg)

    container.style.height = `${BASE_ITEM_SIZE_PX}px`
    container.style.width = `${BASE_ITEM_SIZE_PX}px`

    const appEl = document.querySelector('#app')
    appEl?.appendChild(container)
    dragImageContainer = container

    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('application/json', dragData)
    ev.dataTransfer.setDragImage(container, BASE_ITEM_SIZE_PX / 2, BASE_ITEM_SIZE_PX / 2)
  }
}

// Accepts external images, search-result drops, and tiles dragged from this
// same layer - dropping onto an occupied tile swaps the two. The parent is a
// grid tile rather than a layer member, so it never takes a layer drop.
function allowDrop(ev: DragEvent) {
  ev.preventDefault()
  const dataTransfer = ev.dataTransfer
  if (!dataTransfer) {
    return
  }

  // getData() is unreadable here: the drag data store stays in protected mode
  // until the drop event, so the payload cannot be inspected during dragover.
  // Only types and effectAllowed are available, and reporting an effect the
  // source did not allow - 'copy' against an effectAllowed of 'move' - makes
  // the browser reject the drop outright. handleDrop does the real validation,
  // once the payload is actually readable.
  const carriesJson = Array.from(dataTransfer.types).includes('application/json')
  // Tile drags set effectAllowed 'move' at dragstart; search-result drags leave
  // it uninitialized, so they still read as a copy and show the right cursor.
  const isTileDrag = carriesJson && ['move', 'copyMove', 'linkMove'].includes(dataTransfer.effectAllowed)

  // The parent is a grid tile, not a layer member, so it takes no tile drags.
  // Answering 'copy' to a move-only drag is what refuses it.
  dataTransfer.dropEffect = isTileDrag && !props.isParent ? 'move' : 'copy'
}

async function handleDrop(ev: DragEvent) {
  ev.preventDefault()

  const dragData = parseDragData(ev)

  // A tile from this same layer: swap the two. Covers dropping onto an empty
  // tile created with +, which is a real layer entry and so renders as a tile
  // rather than as one of the overlay's empty drop cells.
  if (isLayerDrag(dragData)) {
    if (!props.isParent && dragData.parentId === props.parentId && dragData.offset !== props.offset) {
      store.moveLayerTile({
        parentId: props.parentId,
        fromOffset: dragData.offset,
        toOffset: props.offset,
      })
    }
    return
  }

  if (dragData && Number.isInteger(dragData.originalIndex)) {
    return // grid drags are out of scope for layers
  }

  if (dragData && isChartItem(dragData.item)) {
    // The parent is a grid tile, not a layer member, so it takes no layer
    // drops: writing one here would create a phantom "0,0" entry — invisible,
    // unreachable, and it pins the chart's minimum size. A no-op.
    if (!props.isParent) {
      store.setLayerTileItem({ parentId: props.parentId, offset: props.offset, item: dragData.item })
    }
    return
  }

  if (!props.isParent) {
    await tryHandleExternalImageDrop(ev)
  }
}

// Releases the offscreen drag image and disarms the overlay's drop targets.
// Without the removal the container stayed in the document forever, leaking a
// node and a decoded image on every drag.
function handleDragEnd() {
  dragImageContainer?.remove()
  dragImageContainer = null
  emit('dragStateChange', false)
}

function getFileExtension(name: string): string {
  const parts = name.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function isSupportedImageFile(file: File): boolean {
  const validMime = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)
  const validExtension = ['jpg', 'jpeg', 'png', 'webp'].includes(getFileExtension(file.name))
  return validMime || validExtension
}

function extractTitleFromPath(pathOrName: string): string {
  const lastSegment = pathOrName.split('/').pop() || ''
  const decoded = decodeURIComponent(lastSegment)
  const withoutExt = decoded.replace(/\.[^.]+$/, '')
  return withoutExt || 'Dropped image'
}

function isSupportedImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false
    }

    return SUPPORTED_IMAGE_EXTENSIONS.test(url.pathname + url.search + url.hash)
  }
  catch {
    return false
  }
}

function addDroppedImageToTile(coverURL: string, title: string) {
  store.setLayerTileItem({
    parentId: props.parentId,
    offset: props.offset,
    item: {
      id: uuidv4(),
      title: title || 'Dropped image',
      coverURL,
    },
  })
}

function getDroppedImageUrlFromDataTransfer(dataTransfer: DataTransfer): string | null {
  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    const candidate = uriList
      .split('\n')
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#') && isSupportedImageUrl(line))

    if (candidate) {
      return candidate
    }
  }

  const html = dataTransfer.getData('text/html')
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const image = doc.querySelector('img')
    const src = image?.getAttribute('src')
    if (src && isSupportedImageUrl(src)) {
      return src
    }
  }

  const plainText = dataTransfer.getData('text/plain')
  if (plainText && isSupportedImageUrl(plainText.trim())) {
    return plainText.trim()
  }

  return null
}

async function tryHandleExternalImageDrop(ev: DragEvent): Promise<boolean> {
  const dataTransfer = ev.dataTransfer
  if (!dataTransfer) {
    return false
  }

  const firstSupportedFile = Array.from(dataTransfer.files).find(file => isSupportedImageFile(file))
  if (firstSupportedFile) {
    try {
      const storedUrl = await storeLocalImage(firstSupportedFile)
      addDroppedImageToTile(storedUrl, extractTitleFromPath(firstSupportedFile.name))
      return true
    }
    catch (e) {
      console.error(e)
    }
  }

  const droppedImageUrl = getDroppedImageUrlFromDataTransfer(dataTransfer)
  if (droppedImageUrl) {
    addDroppedImageToTile(droppedImageUrl, extractTitleFromPath(new URL(droppedImageUrl).pathname))
    return true
  }

  return false
}
</script>

<template>
  <div
    class="layer-tile"
    :style="itemStyle"
    @click="handleTileClick"
    @dragover="allowDrop"
    @drop="handleDrop"
  >
    <!-- Drag and right-click belong to the cover, not the whole tile, so the
    title below stays selectable and keeps its native context menu. See the
    matching note in Item.vue. -->
    <div
      :class="`cover-frame ${isSelected ? 'active-tile' : ''}`"
      :style="coverFrameStyle"
      :draggable="!isParent"
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
      <span v-if="props.item.notes?.trim()" class="notes-indicator" aria-hidden />
      <img
        v-if="thoughtAttachmentUrl"
        :src="thoughtAttachmentUrl"
        :data-stored-src="rawThoughtAttachmentUrl"
        class="thought-attachment"
        alt="Thought attachment"
      >
      <button
        class="delete-button"
        data-html2canvas-ignore
        title="Delete item"
        @click.stop="deleteLayerTile"
      >
        <BIconX />
      </button>
      <img
        v-if="props.item.coverURL"
        :src="itemCoverUrl"
        :data-stored-src="props.item.coverURL"
        class="item-img"
        :style="imgStyle"
      >
      <div v-else class="empty-cover" :style="coverFrameStyle" aria-hidden="true" />
      <template v-for="d in ADD_DIRECTIONS" :key="d.dir">
        <button
          class="add-button" :class="[`add-${d.dir}`]"
          :disabled="!isDirectionAvailable(d.dir)"
          :title="`Add tile ${d.dir}`"
          data-html2canvas-ignore
          @mousedown.stop.prevent
          @click.stop="addTile(d.dir)"
        >
          +
        </button>
      </template>
    </div>
    <p v-if="store.chart.showTitles" class="item-title" :style="titleStyle">
      {{ displayTitle }}
    </p>
  </div>
</template>

<style scoped>
.layer-tile {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 4px;
  touch-action: pinch-zoom;
  pointer-events: auto;
  animation: layer-tile-in 0.18s ease-out both;
}

@keyframes layer-tile-in {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
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

.empty-cover {
  background-color: rgba(90, 90, 90, 0.6);
  border-radius: 6px;
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
  z-index: 5;
}

.delete-button:hover {
  cursor: pointer;
}

.delete-button svg {
  height: 100%;
  width: 100%;
}

.layer-tile:hover .delete-button {
  display: initial;
}

.add-button {
  display: none;
  position: absolute;
  width: 26px;
  height: 26px;
  padding: 0;
  align-items: center;
  justify-content: center;
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  background: rgba(20, 20, 20, 0.85);
  color: #ffffff;
  font-size: 1rem;
  line-height: 1;
  z-index: 6;
}

.add-button:not(:disabled):hover {
  cursor: pointer;
  background: var(--accent);
  border-color: var(--accent);
}

.add-button:disabled {
  opacity: 0.3;
}

.layer-tile:hover .add-button {
  display: flex;
}

.add-n {
  top: -13px;
  left: 50%;
  transform: translateX(-50%);
}

.add-ne {
  top: -13px;
  right: -13px;
}

.add-e {
  top: 50%;
  right: -13px;
  transform: translateY(-50%);
}

.add-se {
  bottom: -13px;
  right: -13px;
}

.add-s {
  bottom: -13px;
  left: 50%;
  transform: translateX(-50%);
}

.add-sw {
  bottom: -13px;
  left: -13px;
}

.add-w {
  top: 50%;
  left: -13px;
  transform: translateY(-50%);
}

.add-nw {
  top: -13px;
  left: -13px;
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

  .add-button {
    display: flex;
  }
}
</style>
