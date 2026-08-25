<script setup lang="ts">
import type { NodeSize } from '../../../mindmap/layout'
import { computed, ref } from 'vue'
import { EXPORT_MARGIN, exportSheetPng, exportSheetSvg, type ExportTheme, sheetBounds } from '../../../mindmap/exportMap'
import { addGroup, addRelationship, removeGroup, removeRelationship, updateGroup, updateRelationship } from '../../../mindmap/relationCommands'
import { DEFAULT_RELATIONSHIP_COLOR } from '../../../mindmap/relations'
import { useMindmapStore } from '../../../mindmap/store'
import { type ConnectorStyle, DEFAULT_GROUP_BORDER_WIDTH, type Group, type Relationship } from '../../../mindmap/types'

// The inspector section for relationships and boundaries (S4 §B.4), plus the
// map export buttons (§B.5). It renders per selection kind: two or more topics
// → group / connect; a relationship → its properties; a group → its
// properties. The export row is NOT selection-dependent — a map must be
// exportable with nothing selected — so it is the one always-present section,
// and "nothing relevant selected → nothing at all" applies to the editing
// sections, not to an empty frame.
//
// Every control goes through relationCommands.ts, which builds one op and
// commits it, so Ctrl+Z undoes a colour change like any other edit.
const store = useMindmapStore()

// The store exposes the sizes cache at runtime (state.sizes) but the frozen
// §0.3 type omits it — it is internal to the measurement machinery. One
// scoped cast here beats widening a contract the other lanes compile against.
const sizes = computed(() => (store as unknown as { sizes: Record<string, NodeSize> }).sizes)

// Export bounds come from the union of ALL node rects, not the viewport
// (exportMap.ts sheetBounds): a map is exported whole whatever is on screen.
const bounds = computed(() => {
  const sheet = store.sheet
  return sheet ? sheetBounds(sheet, sizes.value, EXPORT_MARGIN) : null
})

// The last selection entry is the primary one — the thing the inspector edits
// and Delete acts on (store.ts).
const primary = computed(() => store.selection[store.selection.length - 1] ?? null)
const selectedNodes = computed(() => store.selectedNodeIds)
const rel = computed<Relationship | undefined>(() => {
  const p = primary.value
  return p?.kind === 'relationship' ? store.sheet?.relationships.find(r => r.id === p.id) : undefined
})
const group = computed<Group | undefined>(() => {
  const p = primary.value
  return p?.kind === 'group' ? store.sheet?.boundaries.find(g => g.id === p.id) : undefined
})

function groupSelection() {
  const id = addGroup(store, store.selectedNodeIds)
  if (id) {
    store.select({ kind: 'group', id })
  }
}

function connectSelection() {
  const ids = store.selectedNodeIds
  if (ids.length !== 2) {
    return
  }
  const id = addRelationship(store, ids[0], ids[1])
  if (id) {
    store.select({ kind: 'relationship', id })
  }
}

function applyRel(patch: Partial<Relationship>) {
  const current = rel.value
  if (current) {
    updateRelationship(store, current.id, patch)
  }
}

function applyGroup(patch: Partial<Group>) {
  const current = group.value
  if (current) {
    updateGroup(store, current.id, patch)
  }
}

function deleteRel() {
  if (rel.value) {
    removeRelationship(store, rel.value.id)
  }
}

function deleteGroup() {
  if (group.value) {
    removeGroup(store, group.value.id)
  }
}

// ---------------------------------------------------------------------------
// Export (§B.5)
// ---------------------------------------------------------------------------
const rootEl = ref<HTMLElement | null>(null)
const exporting = ref(false)

// The chart look the map inherits, read off the live overlay so the exported
// document carries the same font, text colour and backdrop the canvas shows
// (R09 — the theme is read from the running map, not hard-coded here).
const theme = computed<ExportTheme | null>(() => {
  const overlay = rootEl.value?.closest('.mindmap-overlay')
  if (!overlay) {
    return null
  }
  const cs = getComputedStyle(overlay)
  const backdrop = overlay.querySelector<HTMLElement>('.mindmap-overlay-backdrop')
  return {
    fontFamily: cs.fontFamily,
    textColor: cs.color,
    background: backdrop ? getComputedStyle(backdrop).backgroundColor : 'rgba(5, 5, 5, 0.95)',
  }
})

function download(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function sheetBaseName(): string {
  return (store.sheet?.title ?? 'mindmap').replace(/[\s/\\:*?"<>|]+/g, '-') || 'mindmap'
}

async function exportMap(kind: 'png' | 'svg') {
  const sheet = store.sheet
  const b = bounds.value
  if (!sheet || !b || exporting.value) {
    return
  }
  exporting.value = true
  try {
    const base = sheetBaseName()
    if (kind === 'svg') {
      const svg = await exportSheetSvg(sheet, sizes.value, b, theme.value ?? undefined)
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
      download(url, `${base}-mindmap.svg`)
      // The click has been dispatched; the anchor no longer needs the URL.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }
    else {
      download(await exportSheetPng(sheet, sizes.value, b, theme.value ?? undefined), `${base}-mindmap.png`)
    }
  }
  finally {
    exporting.value = false
  }
}
</script>

<template>
  <div
    v-if="store.sheet"
    ref="rootEl"
    class="relpanel"
  >
    <div class="relpanel-section relpanel-export">
      <span class="relpanel-heading">Map</span>
      <div class="relpanel-row">
        <button class="relpanel-btn" :disabled="exporting" @click="exportMap('png')">
          Export PNG
        </button>
        <button class="relpanel-btn" :disabled="exporting" @click="exportMap('svg')">
          Export SVG
        </button>
      </div>
    </div>

    <!-- 2+ topics selected: a boundary around them, or a link between exactly
    two of them. -->
    <div v-if="selectedNodes.length >= 2" class="relpanel-section">
      <div class="relpanel-row">
        <button class="relpanel-btn" @click="groupSelection">
          Group selection
        </button>
        <button v-if="selectedNodes.length === 2" class="relpanel-btn" @click="connectSelection">
          Connect
        </button>
      </div>
    </div>

    <div v-else-if="rel" class="relpanel-section">
      <div class="relpanel-row">
        <label>Label</label>
        <input
          class="relpanel-input"
          type="text"
          :value="rel.label ?? ''"
          placeholder="Label the line"
          @change="applyRel({ label: ($event.target as HTMLInputElement).value || undefined })"
        >
      </div>
      <div class="relpanel-row">
        <label>Colour</label>
        <input
          type="color"
          :value="rel.color ?? DEFAULT_RELATIONSHIP_COLOR"
          @change="applyRel({ color: ($event.target as HTMLInputElement).value })"
        >
        <button class="relpanel-reset" title="Use the default" @click="applyRel({ color: undefined })">
          ↺
        </button>
      </div>
      <div class="relpanel-row">
        <label>Style</label>
        <select
          :value="rel.lineStyle ?? 'solid'"
          @change="applyRel({ lineStyle: ($event.target as HTMLSelectElement).value as Relationship['lineStyle'] })"
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
      <div class="relpanel-row">
        <label>Connector</label>
        <select
          :value="rel.connector ?? 'curved'"
          @change="applyRel({ connector: ($event.target as HTMLSelectElement).value as ConnectorStyle })"
        >
          <option value="curved">
            Curved
          </option>
          <option value="straight">
            Straight
          </option>
          <option value="elbow">
            Elbow
          </option>
        </select>
      </div>
      <label class="relpanel-check">
        <span>Bidirectional</span>
        <input
          type="checkbox"
          :checked="!!rel.bidirectional"
          @change="applyRel({ bidirectional: ($event.target as HTMLInputElement).checked })"
        >
      </label>
      <div class="relpanel-row">
        <button class="relpanel-danger" @click="deleteRel">
          Delete relationship
        </button>
      </div>
    </div>

    <div v-else-if="group" class="relpanel-section">
      <div class="relpanel-row">
        <label>Label</label>
        <input
          class="relpanel-input"
          type="text"
          :value="group.label ?? ''"
          placeholder="Label the boundary"
          @change="applyGroup({ label: ($event.target as HTMLInputElement).value || undefined })"
        >
      </div>
      <div class="relpanel-row">
        <label>Colour</label>
        <!-- The default is a translucent grey the swatch cannot show; a solid
        stand-in keeps the picker from snapping to black. -->
        <input
          type="color"
          :value="group.color ?? '#c9c9c9'"
          @change="applyGroup({ color: ($event.target as HTMLInputElement).value })"
        >
        <button class="relpanel-reset" title="Use the default" @click="applyGroup({ color: undefined })">
          ↺
        </button>
      </div>
      <div class="relpanel-row">
        <label>Border</label>
        <input
          class="relpanel-num"
          type="number"
          min="0.5"
          max="8"
          step="0.5"
          :value="group.borderWidth ?? DEFAULT_GROUP_BORDER_WIDTH"
          @change="applyGroup({ borderWidth: Number(($event.target as HTMLInputElement).value) })"
        >
        <button class="relpanel-reset" title="Use the default" @click="applyGroup({ borderWidth: undefined })">
          ↺
        </button>
      </div>
      <div class="relpanel-row">
        <button class="relpanel-danger" @click="deleteGroup">
          Delete group
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The same visual language as the style inspector in MindmapOverlay: a dark
   floating panel over the canvas, here at the top-left so it never collides
   with the inspector's right column. */
.relpanel {
  position: absolute;
  top: 54px;
  left: 12px;
  z-index: 5;
  width: 224px;
  background: rgba(10, 10, 10, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  padding: 8px 10px;
  color: inherit;
  font-size: 12.5px;
}

.relpanel-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.relpanel-section:first-of-type {
  border-top: none;
  padding-top: 0;
}

.relpanel-heading {
  font-weight: 700;
}

.relpanel-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.relpanel-row label {
  flex: 1;
  opacity: 0.85;
}

.relpanel-btn {
  appearance: none;
  flex: 1;
  border: 1px solid rgba(255, 255, 255, 0.35);
  background: rgba(255, 255, 255, 0.08);
  color: inherit;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: inherit;
  cursor: pointer;
}

.relpanel-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}

.relpanel-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.relpanel-input,
.relpanel-num,
.relpanel-row select {
  width: 96px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: inherit;
  border-radius: 4px;
  padding: 3px 5px;
}

.relpanel-row input[type='color'] {
  width: 34px;
  height: 24px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.relpanel-reset {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.6;
  padding: 0 2px;
}

.relpanel-reset:hover {
  opacity: 1;
}

.relpanel-check {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.relpanel-check span {
  flex: 1;
  opacity: 0.85;
}

.relpanel-danger {
  appearance: none;
  flex: 1;
  border: 1px solid rgba(255, 127, 80, 0.7);
  background: rgba(255, 127, 80, 0.1);
  color: #ff7f50;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: inherit;
  cursor: pointer;
}

.relpanel-danger:hover {
  background: rgba(255, 127, 80, 0.2);
}
</style>
