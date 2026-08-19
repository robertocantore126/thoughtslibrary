<script setup lang="ts">
import type { ComputedRef, CSSProperties } from 'vue'
import type { ChartItem } from '../../../types'
import { BIconX } from 'bootstrap-icons-vue'
import { v4 as uuidv4 } from 'uuid'
import { computed } from 'vue'
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'
import { storeLocalImage } from '../../../helpers/assets'
import { useStore } from '../../../store'

const props = defineProps(['item', 'index', 'title', 'number', 'visualRow'])

const store = useStore()
const BASE_ITEM_SIZE_PX = 130
const SUPPORTED_IMAGE_EXTENSIONS = /\.(?:jpg|jpeg|png|webp)(?:[?#].*)?$/i

function getTileScale(_row: number): number {
  return 1
}

const imgStyle: ComputedRef<CSSProperties> = computed(() => ({
  borderRadius: store.chart.roundCorners ? '10px' : '',
  boxShadow: store.chart.shadows ? '2px 2px 4px rgba(0,0,0,0.6)' : '',
}))

const tileCoordinates = computed(() => ({
  x: (props.index % store.chart.size.x) + 1,
  y: Math.floor(props.index / store.chart.size.x) + 1,
}))
const tileScale = computed(() => getTileScale(Number(props.visualRow) || tileCoordinates.value.y))
const tileSizePx = computed(() => Math.round(BASE_ITEM_SIZE_PX * tileScale.value))
const itemStyle: ComputedRef<CSSProperties> = computed(() => ({
  width: `${tileSizePx.value}px`,
  minWidth: `${tileSizePx.value}px`,
}))
const coverFrameStyle: ComputedRef<CSSProperties> = computed(() => ({
  width: `${tileSizePx.value}px`,
  height: `${tileSizePx.value}px`,
}))
const titleStyle: ComputedRef<CSSProperties> = computed(() => ({
  fontSize: `${Math.max(0.62, 0.62 * Math.min(tileScale.value, 1.2))}rem`,
  lineHeight: `${Math.max(1.2, 1.2 * Math.min(tileScale.value, 1.1))}`,
}))

const tileKey = computed(() => `${tileCoordinates.value.x},${tileCoordinates.value.y}`)
const isActiveTile = computed(() => store.activeTileKey === tileKey.value)
const isFocusedTile = computed(() => !!props.item && store.focusedTileId === props.item.id)
const isDimmed = computed(() => !!store.focusedTileId && !isFocusedTile.value)
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

    const scaledSize = tileSizePx.value
    container.style.height = `${scaledSize}px`
    container.style.width = `${scaledSize}px`

    const appEl = document.querySelector('#app')
    appEl?.appendChild(container)

    ev.dataTransfer.effectAllowed = 'move'
    ev.dataTransfer.setData('application/json', dragData)
    ev.dataTransfer.setDragImage(container, scaledSize / 2, scaledSize / 2)
  }
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

async function handleDrop(ev: DragEvent) {
  ev.preventDefault()

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
</script>

<template>
  <div
    :key="props.item ? props.item.coverURL : props.index"
    :class="`item ${props.item ? '' : 'placeholder'} ${isFocusedTile ? 'focused' : ''} ${isDimmed ? 'dimmed' : ''}`"
    :data-index="props.index"
    :style="props.item ? itemStyle : { ...itemStyle, ...imgStyle }"
    @click="handleTileClick"
    @contextmenu.prevent="handleContextMenu"
    @dragover="allowDrop"
    @drop="handleDrop"
  >
    <!-- The cover is the drag handle rather than the whole tile, so the title
    below stays selectable. Text inside a draggable element can't be selected -
    a mousedown-drag there starts a drag instead. Drops still land anywhere on
    the tile. -->
    <div
      :class="`cover-frame ${isActiveTile ? 'active-tile' : ''}`"
      :style="coverFrameStyle"
      :draggable="props.item ? 'true' : 'false'"
      @dragstart="handleDragStart"
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
  opacity: 0.10;
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
}
</style>
