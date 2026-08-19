<script setup lang="ts">
import { BIconSticky, BIconX } from 'bootstrap-icons-vue'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useStore } from '../../store'

const store = useStore()

const popupEl = ref<HTMLElement | null>(null)
const pos = reactive({ left: 0, top: 0 })

const note = computed(() => store.notesPopupNote)
const tileTitle = computed(() => {
  const active = store.activeTile
  if (!active) {
    return ''
  }

  return active.item.title || `Tile (${active.x}, ${active.y})`
})

function positionPopup() {
  if (!popupEl.value || !note.value) {
    return
  }

  const active = store.activeTile
  if (!active) {
    return
  }

  const index = (active.y - 1) * store.chart.size.x + (active.x - 1)
  const tileEl = document.querySelector(`.item[data-index="${index}"]`) as HTMLElement | null
  const host = popupEl.value.offsetParent as HTMLElement | null
  if (!tileEl || !host) {
    return
  }

  const tileRect = tileEl.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  const gap = 12
  const popupWidth = popupEl.value.offsetWidth
  const popupHeight = popupEl.value.offsetHeight

  let left = tileRect.left - hostRect.left + tileRect.width + gap
  if (left + popupWidth > hostRect.width - 8) {
    left = tileRect.left - hostRect.left - popupWidth - gap
  }
  left = Math.max(8, Math.min(left, hostRect.width - popupWidth - 8))

  const top = Math.max(8, Math.min(tileRect.top - hostRect.top, hostRect.height - popupHeight - 8))

  pos.left = left
  pos.top = top
}

watch(note, () => {
  if (!note.value) {
    return
  }

  nextTick(positionPopup)
})

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && store.notesPopupNote) {
    store.closeNotesPopup()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('scroll', positionPopup, true)
  window.addEventListener('resize', positionPopup)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('scroll', positionPopup, true)
  window.removeEventListener('resize', positionPopup)
})
</script>

<template>
  <div
    v-if="note"
    ref="popupEl"
    class="notes-popup"
    :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
    data-html2canvas-ignore
  >
    <div class="notes-popup-header">
      <span class="notes-popup-icon" aria-hidden="true"><BIconSticky /></span>
      <span class="notes-popup-title">{{ tileTitle }}</span>
      <button
        class="notes-popup-close"
        type="button"
        title="Close notes"
        aria-label="Close notes"
        @click="store.closeNotesPopup"
      >
        <BIconX />
      </button>
    </div>
    <div class="notes-popup-body">
      {{ note }}
    </div>
  </div>
</template>

<style scoped>
.notes-popup {
  position: absolute;
  width: 320px;
  max-width: calc(100% - 24px);
  z-index: 50;
  background: #1c1c1e;
  border: 1px solid rgba(255, 127, 80, 0.6);
  border-radius: 12px;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.65);
  overflow: hidden;
  animation: notes-popup-in 0.16s ease-out;
}

@keyframes notes-popup-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.notes-popup-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  background: rgba(255, 127, 80, 0.12);
  border-bottom: 1px solid rgba(255, 127, 80, 0.3);
}

.notes-popup-icon {
  display: inline-flex;
  color: var(--accent);
}

.notes-popup-title {
  flex: 1;
  min-width: 0;
  font-size: 0.85rem;
  font-weight: 700;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.notes-popup-close {
  appearance: none;
  border: none;
  background: transparent;
  color: #cccccc;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  padding: 0;
}

.notes-popup-close:hover {
  cursor: pointer;
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.notes-popup-body {
  padding: 12px 14px;
  max-height: 42vh;
  overflow-y: auto;
  font-size: 0.88rem;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
