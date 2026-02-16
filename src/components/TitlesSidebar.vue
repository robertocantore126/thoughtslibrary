<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { fileToDataUrl } from '../helpers/files'
import { useStore } from '../store'

const store = useStore()
const THOUGHT_ICON_URL = '/thought_tile.svg'

const titledItems = computed(() =>
  store.items
    .filter(item => item?.data && item.title)
    .map(item => ({
      number: item?.number,
      title: item?.title,
    })),
)

const activeTile = computed(() => store.activeTile)
const isThoughtTile = computed(() => activeTile.value?.item.itemType === 'thought' || activeTile.value?.item.coverURL === THOUGHT_ICON_URL)

const activeTileNote = computed({
  get: () => store.activeTileNote,
  set: (value: string) => store.setActiveTileNote(value),
})

const activeTileRating = computed({
  get: () => store.activeTileRating,
  set: (value: number) => store.setActiveTileRating(value === 0 ? null : value),
})

const activeTileAttachment = computed({
  get: () => store.activeTileAttachment,
  set: (value: string) => store.setActiveTileAttachment(value),
})

function updateTitle(event: Event) {
  store.setActiveTileTitle((event.target as HTMLInputElement).value)
}

function updateCreator(event: Event) {
  store.setActiveTileCreator((event.target as HTMLInputElement).value)
}

function setRating(rating: number) {
  if (activeTileRating.value === rating) {
    activeTileRating.value = 0
    return
  }

  activeTileRating.value = rating
}

async function onAttachmentFilePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) {
    return
  }

  if (!file.type.startsWith('image/')) {
    return
  }

  try {
    const dataUrl = await fileToDataUrl(file)
    activeTileAttachment.value = dataUrl
  }
  catch (e) {
    console.error(e)
  }
}

function clearAttachment() {
  activeTileAttachment.value = ''
}

function ratingColor(rating: number): string {
  if (activeTile.value?.item.title?.trim().toLowerCase() === 'frusciante') {
    return '#000000'
  }

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

function handleUndoHotkey(event: KeyboardEvent) {
  const isUndo = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z'
  if (!isUndo) {
    return
  }

  const activeEl = document.activeElement as HTMLElement | null
  const isTextField = !!activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')
  if (!isTextField) {
    return
  }

  event.preventDefault()
  store.undoTextEdit()
}

onMounted(() => {
  window.addEventListener('keydown', handleUndoHotkey)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleUndoHotkey)
})
</script>

<template>
  <aside class="titles-sidebar">
    <template v-if="activeTile">
      <div class="properties-header">
        <h2>Tile Properties</h2>
        <button class="close-button" @click="store.clearActiveTile">
          X
        </button>
      </div>
      <div class="selected-tile">
        <img :src="activeTile.item.coverURL" :alt="activeTile.item.title">
        <label class="field-label" for="tileTitle">Title</label>
        <input id="tileTitle" :value="activeTile.item.title" class="field-input" type="text" placeholder="Item title" @input="updateTitle">
        <label v-if="!isThoughtTile" class="field-label" for="tileCreator">Creator (optional)</label>
        <input v-if="!isThoughtTile" id="tileCreator" :value="activeTile.item.creator || ''" class="field-input" type="text" placeholder="Artist / Author / Director" @input="updateCreator">
        <p class="selected-coords">
          Tile: ({{ activeTile.x }}, {{ activeTile.y }})
        </p>
      </div>
      <template v-if="isThoughtTile">
        <label class="notes-label" for="tileAttachment">Attachment image URL</label>
        <input id="tileAttachment" v-model="activeTileAttachment" class="field-input" type="text" placeholder="https://example.com/image.jpg">
        <div class="attachment-actions">
          <input
            id="tileAttachmentFile"
            type="file"
            accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
            @change="onAttachmentFilePicked"
          >
          <button class="clear-attachment" type="button" @click="clearAttachment">
            Clear attachment
          </button>
        </div>
      </template>
      <label class="notes-label" for="tileNotes">Notes</label>
      <textarea id="tileNotes" v-model="activeTileNote" class="notes-area" placeholder="Write notes for this tile..." />
      <label class="notes-label">Rating</label>
      <div class="rating-row">
        <button
          v-for="star in 7"
          :key="star"
          class="rating-star"
          :class="{ active: star <= activeTileRating }"
          :style="{ color: star <= activeTileRating ? ratingColor(activeTileRating) : '#777777' }"
          :title="`Set rating to ${star}`"
          @click="setRating(star)"
        >
          {{ star <= activeTileRating ? '\u2605' : '\u2606' }}
        </button>
      </div>
    </template>
    <template v-else>
      <h2>General Titles</h2>
      <ol class="titles-list">
        <li v-for="(item, idx) in titledItems" :key="idx">
          {{ store.chart.showNumbers && item.number ? `${item.number}. ` : '' }}{{ item.title }}
        </li>
      </ol>
    </template>
  </aside>
</template>

<style scoped>
.titles-sidebar {
  height: 100%;
  background: rgba(20, 20, 20, 0.9);
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  padding: 16px;
  overflow-y: auto;
}

h2 {
  margin: 0 0 10px;
  font-size: 1.1rem;
}

.properties-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.close-button {
  height: 28px;
  width: 28px;
  border-radius: 6px;
  border: none;
  background: #2d2d2d;
  color: #ffffff;
}

.close-button:hover {
  cursor: pointer;
  background: #3a3a3a;
}

.selected-tile {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}

.selected-tile img {
  width: 120px;
  height: 120px;
  object-fit: cover;
}

.selected-coords {
  margin: 0;
  opacity: 0.8;
  font-size: 0.78rem;
}

.field-label {
  font-size: 0.8rem;
}

.field-input {
  width: 100%;
  height: 34px;
  background: #1e1e1e;
  color: #ffffff;
  border: 1px solid #444444;
  border-radius: 6px;
}

.attachment-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
  align-items: center;
}

.clear-attachment {
  height: 34px;
  border-radius: 6px;
  border: 1px solid #444444;
  background: #1f1f1f;
  color: #ffffff;
  padding: 0 10px;
}

.clear-attachment:hover {
  cursor: pointer;
  border-color: #666666;
}

.notes-label {
  display: block;
  margin-bottom: 6px;
  font-size: 0.85rem;
}

.notes-area {
  width: 100%;
  min-height: 140px;
  resize: vertical;
  background: #1e1e1e;
  color: #ffffff;
  border: 1px solid #444444;
  border-radius: 6px;
  padding: 8px;
  font-family: "Nunito", sans-serif;
  font-size: 0.9rem;
}

.rating-row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-top: 2px;
}

.rating-star {
  appearance: none;
  border: 1px solid #3b3b3b;
  border-radius: 5px;
  background: #1b1b1b;
  width: 28px;
  height: 28px;
  line-height: 1;
  font-size: 1.08rem;
  font-weight: 700;
  padding: 0;
}

.rating-star:hover {
  cursor: pointer;
  border-color: #666666;
}

.rating-star.active {
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.12);
}

.titles-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 0.9rem;
  line-height: 1.3;
}
</style>
