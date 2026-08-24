<script setup lang="ts">
import type { Style } from '../../../mindmap/types'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { importRnode } from '../../../helpers/rnodeImport'
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

// Fit once when the canvas reports its first measurement settled. A freshly
// opened sheet has no sizes, so "has any node moved" is the wrong signal: an
// imported sheet carries r-node's own positions, so nodes are laid out BEFORE
// the first measurement — fitting then frames an empty sizes record (every box
// falls back to 120x40) and part of the map opens off-screen. The canvas knows
// when every node that needed one has a real size (its measure queue is empty)
// and emits 'settled'; fit on that. After an edit the camera stays where the
// user left it; Fit is always one click away.
let didAutoFit = false
let fitBackstop: ReturnType<typeof setTimeout> | null = null
function onMeasureSettled() {
  if (didAutoFit) {
    return
  }
  didAutoFit = true
  if (fitBackstop) {
    clearTimeout(fitBackstop)
    fitBackstop = null
  }
  fitToView()
}

// Backstop for a node that somehow never measures: a best-effort frame beats a
// map stuck unframed. Re-armed on every open and import.
function armFitBackstop() {
  if (fitBackstop) {
    clearTimeout(fitBackstop)
  }
  fitBackstop = setTimeout(() => {
    if (!didAutoFit) {
      didAutoFit = true
      fitToView()
    }
  }, 1500)
}

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

// ---------------------------------------------------------------------------
// M3 — the style inspector
// ---------------------------------------------------------------------------
// A panel driven by store.selection, editing the M2 Style fields on the
// selected topic. Every edit goes through a store action and therefore through
// a setStyle op (S2 M3 trap 5), so Ctrl+Z undoes a style change like any other
// edit and the same commit path marks dirty and debounces the save. The colour
// inputs are the app's native `<input type="color">` picker (reused, per §T.7).
const selectedNode = computed(() => {
  const id = selection.value
  return id ? mindmap.sheet?.nodes[id] : undefined
})

// The chart offer no topic-fill default of their own; the topic box falls back
// to the shared translucent box seen in the map. These are just the swatch
// stand-ins for a colour that has not been set (inspectable, not persisted).
const CHART_BG = '#161616'
const CHART_TEXT = store.chart.textColor || '#ffffff'

function applyStyle(field: string, value: unknown) {
  const node = selectedNode.value
  if (!node) {
    return
  }
  mindmap.setNodeStyle(node.id, { [field]: value })
}

function applyToggle(field: string, value: boolean) {
  applyStyle(field, value)
}

// Returning a field to the chart default means removing it, so it falls through
// to whatever the map inherits rather than carrying an empty value forever.
function clearStyle(...fields: (keyof Style)[]) {
  const node = selectedNode.value
  if (!node || fields.length === 0) {
    return
  }
  mindmap.clearNodeStyle(node.id, fields)
}

// ---------------------------------------------------------------------------
// M4 — .rnode import
// ---------------------------------------------------------------------------
// Importing an existing r-node map moves the user's documents onto this tile:
// read a .rnode.json, store it under a FRESH sheet id (never the file's — S1
// §T.6), point the tile's chart.mindmaps entry at it, and open the result.
// Image references travel as-is; S2 leaves them for a later stage to resolve.
const fileInput = ref<HTMLInputElement | null>(null)
const importError = ref<string | null>(null)

function triggerImport() {
  importError.value = null
  fileInput.value?.click()
}

async function onImportPicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // allow picking the same file again
  if (!file) {
    return
  }
  try {
    const result = await importRnode(await file.text())
    const itemId = hostItemId.value
    if (itemId) {
      store.setMindmapSheetId(itemId, result.sheetId)
    }
    // A fresh map deserves a fresh framing, not the old sheet's camera. Re-arm
    // the backstop so the previous sheet's timer cannot frame this one early.
    didAutoFit = false
    await mindmap.open(result.sheetId)
    armFitBackstop()
  }
  catch (err) {
    importError.value = err instanceof Error ? err.message : 'Import failed.'
  }
}

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
  armFitBackstop()
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
          <button title="Import an existing r-node map (.rnode.json)" @click="triggerImport">
            Import…
          </button>
          <button class="mindmap-close" title="Close (Esc)" @click="closeOverlay">
            Close
          </button>
        </div>
      </div>
      <input
        ref="fileInput"
        class="mindmap-import-input"
        type="file"
        accept=".json,application/json"
        @change="onImportPicked"
      >
      <div v-if="importError" class="mindmap-import-error">
        {{ importError }}
      </div>
      <div ref="bodyRef" class="mindmap-body">
        <MindmapCanvas @settled="onMeasureSettled" />
      </div>
      <div v-if="selectedNode" class="mindmap-inspector">
        <div class="mindmap-inspector-head">
          <span>Style</span>
          <button class="inspector-close" title="Close inspector" @click="mindmap.select(null)">
            X
          </button>
        </div>

        <div class="inspector-section">
          <div class="inspector-row">
            <label>Fill</label>
            <input
              type="color"
              :value="selectedNode.style.fill ?? CHART_BG"
              @change="applyStyle('fill', ($event.target as HTMLInputElement).value)"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('fill')">
              ↺
            </button>
          </div>
          <div class="inspector-row">
            <label>Text</label>
            <input
              type="color"
              :value="selectedNode.style.textColor ?? CHART_TEXT"
              @change="applyStyle('textColor', ($event.target as HTMLInputElement).value)"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('textColor')">
              ↺
            </button>
          </div>
          <div class="inspector-row">
            <label>Border</label>
            <input
              type="color"
              :value="selectedNode.style.stroke ?? CHART_TEXT"
              @change="applyStyle('stroke', ($event.target as HTMLInputElement).value)"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('stroke')">
              ↺
            </button>
          </div>
        </div>

        <div class="inspector-section">
          <div class="inspector-row">
            <label>Radius</label>
            <input
              class="inspector-num"
              type="number"
              min="0"
              max="40"
              :value="selectedNode.style.cornerRadius ?? 10"
              @change="applyStyle('cornerRadius', Number(($event.target as HTMLInputElement).value))"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('cornerRadius')">
              ↺
            </button>
          </div>
          <div class="inspector-row">
            <label>Border width</label>
            <input
              class="inspector-num"
              type="number"
              min="0"
              max="12"
              :value="selectedNode.style.borderWidth ?? 1"
              @change="applyStyle('borderWidth', Number(($event.target as HTMLInputElement).value))"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('borderWidth', 'borderStyle')">
              ↺
            </button>
          </div>
          <div class="inspector-row">
            <label>Border style</label>
            <select
              :value="selectedNode.style.borderStyle ?? 'solid'"
              @change="applyStyle('borderStyle', ($event.target as HTMLSelectElement).value)"
            >
              <option value="solid">
                Solid
              </option>
              <option value="dashed">
                Dashed
              </option>
              <option value="dotted">
                Dotted
              </option>
            </select>
          </div>
          <div class="inspector-row">
            <label>Font size</label>
            <input
              class="inspector-num"
              type="number"
              min="8"
              max="48"
              :value="selectedNode.style.fontSize ?? 14"
              @change="applyStyle('fontSize', Number(($event.target as HTMLInputElement).value))"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('fontSize')">
              ↺
            </button>
          </div>
          <div class="inspector-row">
            <label>Weight</label>
            <select
              :value="selectedNode.style.fontWeight ?? 400"
              @change="applyStyle('fontWeight', Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="400">
                Normal
              </option>
              <option :value="700">
                Bold
              </option>
            </select>
          </div>
          <div class="inspector-row">
            <label>Opacity</label>
            <input
              class="inspector-range"
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              :value="selectedNode.style.opacity ?? 1"
              @change="applyStyle('opacity', Number(($event.target as HTMLInputElement).value))"
            >
            <button class="inspector-reset" title="Use the chart default" @click="clearStyle('opacity')">
              ↺
            </button>
          </div>
        </div>

        <div class="inspector-section inspector-flags">
          <label class="inspector-check">
            <span>Bold</span>
            <input
              type="checkbox"
              :checked="!!(selectedNode.style.fontWeight && selectedNode.style.fontWeight > 400)"
              @change="applyStyle('fontWeight', ($event.target as HTMLInputElement).checked ? 700 : 400)"
            >
          </label>
          <label class="inspector-check">
            <span>Italic</span>
            <input
              type="checkbox"
              :checked="!!selectedNode.style.italic"
              @change="applyToggle('italic', ($event.target as HTMLInputElement).checked)"
            >
          </label>
          <label class="inspector-check">
            <span>Underline</span>
            <input
              type="checkbox"
              :checked="!!selectedNode.style.underline || selectedNode.style.shape === 'underline'"
              @change="applyToggle('underline', ($event.target as HTMLInputElement).checked)"
            >
          </label>
          <label class="inspector-check">
            <span>Strike</span>
            <input
              type="checkbox"
              :checked="!!selectedNode.style.strikethrough"
              @change="applyToggle('strikethrough', ($event.target as HTMLInputElement).checked)"
            >
          </label>
          <label class="inspector-check">
            <span>Shadow</span>
            <input
              type="checkbox"
              :checked="!!selectedNode.style.shadow"
              @change="applyToggle('shadow', ($event.target as HTMLInputElement).checked)"
            >
          </label>
        </div>

        <div class="inspector-section">
          <div class="inspector-row">
            <label>Shape</label>
            <select
              :value="selectedNode.style.shape ?? 'rounded'"
              @change="applyStyle('shape', ($event.target as HTMLSelectElement).value)"
            >
              <option value="rounded">
                Rounded
              </option>
              <option value="rect">
                Rect
              </option>
              <option value="capsule">
                Capsule
              </option>
              <option value="underline">
                Underline
              </option>
              <option value="none">
                None
              </option>
            </select>
          </div>
        </div>
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

.mindmap-import-input {
  display: none;
}

.mindmap-import-error {
  flex: none;
  color: #ff7f50;
  font-size: 12.5px;
  padding: 0 4px;
}

.mindmap-body {
  position: relative;
  flex: 1;
  min-height: 0;
}

.mindmap-inspector {
  position: absolute;
  top: 10px;
  right: 12px;
  width: 232px;
  max-height: calc(100% - 20px);
  overflow: auto;
  z-index: 5;
  background: rgba(10, 10, 10, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  padding: 10px;
  color: inherit;
  font-size: 12.5px;
}

.mindmap-inspector-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 700;
  margin-bottom: 8px;
}

.inspector-close {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  opacity: 0.7;
}

.inspector-close:hover {
  opacity: 1;
}

.inspector-section {
  padding: 6px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.inspector-section:first-of-type {
  border-top: none;
  padding-top: 0;
}

.inspector-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 5px 0;
}

.inspector-row label {
  flex: 1;
  opacity: 0.85;
}

.inspector-row input[type='color'] {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.inspector-num,
.inspector-row select {
  width: 74px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: inherit;
  border-radius: 4px;
  padding: 3px 5px;
}

.inspector-range {
  flex: 1;
}

.inspector-reset {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
  padding: 0 2px;
}

.inspector-reset:hover {
  opacity: 1;
}

.inspector-flags {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inspector-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.inspector-check span {
  flex: 1;
}
</style>
