<script setup lang="ts">
import type { ComputedRef, CSSProperties } from 'vue'
import type { ChartItem } from '../../../types'
import { BIconX } from 'bootstrap-icons-vue'
import { computed } from 'vue'
import { fileToDataUrl } from '../../../helpers/files'
import { useStore } from '../../../store'

const props = defineProps(['item', 'index', 'title', 'number'])

const store = useStore()
const ITEM_SIZE_PX = 130
const SUPPORTED_IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|webp)(\?.*)?(#.*)?$/i

function allowDrop(ev: DragEvent) {
  ev.preventDefault()
  if (ev.dataTransfer) {
    const isInternalDrag = Array.from(ev.dataTransfer.types).includes('application/json')
    ev.dataTransfer.dropEffect = isInternalDrag ? 'move' : 'copy'
  }
}

function handleDragStart(ev: DragEvent) {
  if (!props.item) {
    return null
  }

  const dragData = JSON.stringify({
    originalIndex: props.index,
  })

  if (ev.dataTransfer) {
    const dragImg = new Image()
    dragImg.classList.add('dnd-img')
    dragImg.src = props.item.coverURL

    const container = document.createElement('div')
    container.classList.add('dnd-container')
    container.appendChild(dragImg)

    const scaledSize = ITEM_SIZE_PX
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
      const dataUrl = await fileToDataUrl(firstSupportedFile)
      addDroppedImageToTile(dataUrl, extractTitleFromPath(firstSupportedFile.name))
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

  if (await tryHandleExternalImageDrop(ev)) {
    return
  }
}

const imgStyle: ComputedRef<CSSProperties> = computed(() => ({
  borderRadius: store.chart.roundCorners ? '10px' : '',
  boxShadow: store.chart.shadows ? '2px 2px 4px rgba(0,0,0,0.6)' : '',
}))

const tileCoordinates = computed(() => ({
  x: (props.index % store.chart.size.x) + 1,
  y: Math.floor(props.index / store.chart.size.x) + 1,
}))

const tileKey = computed(() => `${tileCoordinates.value.x},${tileCoordinates.value.y}`)
const isActiveTile = computed(() => store.activeTileKey === tileKey.value)
const thoughtAttachmentUrl = computed(() => {
  const isThoughtLike = props.item?.itemType === 'thought' || props.item?.coverURL === '/thought_tile.svg'
  if (!isThoughtLike) {
    return ''
  }

  return props.item.attachmentURL || ''
})
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

function selectTile() {
  if (!props.item) {
    return
  }

  store.selectTile(tileCoordinates.value)
}

function deleteItem() {
  store.addItem({ item: null, index: props.index })
}
</script>

<template>
  <div
    :key="props.item ? props.item.coverURL : props.index"
    :class="`item ${props.item ? '' : 'placeholder'}`"
    :data-index="props.index"
    :draggable="props.item ? 'true' : 'false'"
    :style="props.item ? undefined : imgStyle"
    @click="selectTile"
    @dragstart="handleDragStart"
    @dragover="allowDrop"
    @drop="handleDrop"
  >
    <div :class="`cover-frame ${isActiveTile ? 'active-tile' : ''}`">
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
      <span v-if="props.item?.notes?.trim()" class="notes-indicator" aria-hidden />
      <img
        v-if="thoughtAttachmentUrl"
        :src="thoughtAttachmentUrl"
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
        :src="item.coverURL"
        class="item-img"
        :style="imgStyle"
      >
    </div>
    <p v-if="props.item && store.chart.showTitles" class="item-title">
      {{ store.chart.showNumbers && props.number ? `${props.number}. ` : '' }}{{ props.title }}
    </p>
  </div>
</template>

<style scoped>
.item {
  width: 130px;
  min-width: 130px;
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  gap: 4px;
  touch-action: pinch-zoom;
}

.cover-frame {
  height: 130px;
  width: 130px;
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
  margin: 0;
  font-size: 0.62rem;
  line-height: 1.2;
  height: 0.75rem;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

@media (hover: none) {
  .delete-button {
    display: initial;
  }
}
</style>
