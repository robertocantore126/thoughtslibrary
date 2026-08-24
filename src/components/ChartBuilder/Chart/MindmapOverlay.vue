<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useMindmapStore } from '../../../mindmap/store'
import { useStore } from '../../../store'
import MindmapCanvas from './MindmapCanvas.vue'

const store = useStore()
const mindmap = useMindmapStore()

// The host tile comes from the chart store's mindmapKey. This component is
// mounted by that tile's Item, so a fixed backdrop here covers the whole app
// while the map is open.
const tileKey = computed(() => (store.mindmapKey?.kind === 'tile' ? store.mindmapKey.key : null))
const hostItemId = computed(() => {
  if (!tileKey.value) {
    return undefined
  }
  return store.chart.coordinates?.[tileKey.value]?.id
})

// Inherit the chart's own font and text colour so the map looks like the
// chart it lives in — the main thing a native build buys over embedding a
// canvas renderer (Lane E).
const overlayStyle = computed(() => ({
  fontFamily: store.chart.font || 'monospace',
  color: store.chart.textColor || '#ffffff',
}))

const bodyRef = ref<HTMLElement | null>(null)

function fitToView() {
  const el = bodyRef.value
  if (!el) {
    return
  }
  mindmap.fit(el.clientWidth, el.clientHeight)
}

// Fit once when the map's first layout lands. open() publishes the sheet
// with every node still piled at the origin; the canvas then measures and
// calls applySizes, whose layout pass moves the nodes off it — that
// republish is what this watch sees. After an edit the camera should stay
// where the user left it; Fit is always one click away.
let didAutoFit = false
watch(
  () => mindmap.sheet,
  () => {
    if (didAutoFit || !mindmap.sheet) {
      return
    }
    const laidOut = mindmap.visibleNodes.some(n => n.position.x !== 0 || n.position.y !== 0)
    if (!laidOut) {
      return
    }
    didAutoFit = true
    fitToView()
  },
)

const selection = computed(() => mindmap.selection)
const canDelete = computed(() => {
  const sheet = mindmap.sheet
  return !!selection.value && !!sheet && selection.value !== sheet.rootNodeId
})
const canAddSibling = computed(() => {
  const sheet = mindmap.sheet
  if (!selection.value || !sheet) {
    return false
  }
  const node = sheet.nodes[selection.value]
  return !!node && node.parentId !== null
})

function addChild() {
  const sheet = mindmap.sheet
  if (!sheet) {
    return
  }
  const parentId = selection.value ?? sheet.rootNodeId
  const id = mindmap.createChild(parentId)
  if (id) {
    mindmap.select(id)
  }
}

function addSibling() {
  const id = selection.value
  if (!id) {
    return
  }
  const created = mindmap.createSibling(id)
  if (created) {
    mindmap.select(created)
  }
}

function deleteSelected() {
  const id = selection.value
  if (id) {
    mindmap.remove(id)
  }
}

function closeOverlay() {
  store.closeMindmap()
}

// Escape closes the overlay — unless the focus is inside a rename editor,
// whose own Escape handler stops propagation before this window listener runs.
function onWindowKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape') {
    return
  }
  const active = document.activeElement as HTMLElement | null
  if (active?.isContentEditable) {
    return
  }
  store.closeMindmap()
}

onMounted(async () => {
  window.addEventListener('keydown', onWindowKeydown)
  // Flush whatever the map was doing before this session too — open() does
  // that itself — then load the tile's existing sheet, or create one.
  const itemId = hostItemId.value
  const existing = itemId ? store.chart.mindmaps?.[itemId] : null
  await mindmap.open(existing ?? null)
  const created = mindmap.sheet?.sheetId
  if (itemId && created && created !== existing) {
    // A brand-new sheet must be reachable after a reload: record its id on
    // the chart now, before the first autosave writes the sheet to storage.
    store.setMindmapSheetId(itemId, created)
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', onWindowKeydown)
  // The last edit must survive the overlay closing even if its debounce
  // never fired; close() flushes before dropping the sheet.
  void mindmap.close()
})
</script>

<template>
  <!-- Clicks must never reach the host tile beneath: the overlay mounts inside
  its .item element, whose @click selects the tile and, via selectTile,
  closes this very overlay. Stopping propagation here keeps every toolbar and
  canvas interaction inside the modal (Lane F). -->
  <div class="mindmap-overlay" data-html2canvas-ignore :style="overlayStyle" @click.stop>
    <div class="mindmap-overlay-backdrop" />
    <div class="mindmap-overlay-chrome">
      <div class="mindmap-toolbar">
        <span class="mindmap-title">{{ mindmap.sheet?.title || 'Mindmap' }}</span>
        <div class="mindmap-toolbar-actions">
          <button title="Add a child to the selected topic (or the root)" @click="addChild">
            Add child
          </button>
          <button :disabled="!canAddSibling" title="Add a sibling next to the selected topic" @click="addSibling">
            Add sibling
          </button>
          <button :disabled="!canDelete" title="Delete the selected topic and its subtree" @click="deleteSelected">
            Delete
          </button>
          <button title="Frame the whole map in the view" @click="fitToView">
            Fit
          </button>
          <button class="mindmap-close" title="Close (Esc)" @click="closeOverlay">
            Close
          </button>
        </div>
      </div>
      <div ref="bodyRef" class="mindmap-body">
        <MindmapCanvas />
      </div>
    </div>
  </div>
</template>

<style scoped>
.mindmap-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  font-size: 14px;
}

/* Near-opaque, NOT the 45% wash focus mode uses. That wash exists because
   related-layer tiles line up with the grid cells beneath them; a mindmap
   pans and zooms freely, so a half-visible grid behind it lines up with
   nothing and reads as a rendering bug (Lane F). */
.mindmap-overlay-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(5, 5, 5, 0.95);
}

.mindmap-overlay-chrome {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 12px;
}

.mindmap-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex: none;
  min-height: 34px;
}

.mindmap-title {
  font-size: 15px;
  font-weight: 600;
  opacity: 0.9;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mindmap-toolbar-actions {
  display: flex;
  gap: 6px;
  flex: none;
}

.mindmap-toolbar-actions button {
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  border-radius: 5px;
  padding: 5px 10px;
  font-size: 12.5px;
  cursor: pointer;
}

.mindmap-toolbar-actions button:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}

.mindmap-toolbar-actions button:disabled {
  opacity: 0.4;
  cursor: default;
}

.mindmap-toolbar-actions .mindmap-close {
  border-color: rgba(255, 127, 80, 0.7);
  color: #ff7f50;
}

.mindmap-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
</style>
