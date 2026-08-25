<script lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useMindmapStore } from '../../../mindmap/store'

/**
 * The window-event protocol between this bar and the open title editor
 * (MindmapNode). Both files belong to S4 Lane A; they talk through events
 * rather than a store field because the only thing that crosses is a mark
 * name that does not outlive one keystroke, and a store field for it would be
 * a change to a file this lane does not own.
 *
 * The bar is the VISIBLE twin of MindmapNode's Ctrl+B/I/U handling. Both ends
 * route through richtext.ts's toggleMark/setRunColor, so neither can become
 * the only way to reach a mark, and neither can format text the other would
 * format differently.
 */

/** Editor → bar: an editor opened on this node. */
export const EDIT_OPENED = 'mindmap:edit-opened'
/** Editor → bar: the editor closed, by commit or by cancel. */
export const EDIT_CLOSED = 'mindmap:edit-closed'
/** Editor → bar: which marks the current selection already carries. */
export const EDIT_SELECTION = 'mindmap:edit-selection'
/** Bar → editor: apply this mark, or this colour, to the selection. */
export const EDIT_FORMAT = 'mindmap:edit-format'

export interface SelectionMarks {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

/** Exactly one of the two is set: a mark to toggle, or a colour to apply. */
export interface FormatRequest {
  mark?: 'bold' | 'italic' | 'underline' | 'strike'
  color?: string
}
</script>

<script setup lang="ts">
const store = useMindmapStore()

const nodeId = ref<string | null>(null)
const marks = ref<SelectionMarks>({ bold: false, italic: false, underline: false, strike: false })

const node = computed(() => (nodeId.value ? store.sheet?.nodes[nodeId.value] ?? null : null))

/**
 * Screen position, from the node's world position.
 *
 * The whole map is drawn under ONE CSS transform, so screen = world * scale +
 * camera — the same relation the store's fitToView and zoomAt use. The bar
 * sits above the topic and is translated by its own half-width rather than
 * being measured, because measuring it would be a second layout pass on every
 * camera change for a box whose size never varies.
 */
const barStyle = computed(() => {
  const target = node.value
  if (!target) {
    return undefined
  }
  const { x, y, scale } = store.camera
  return {
    left: `${target.position.x * scale + x}px`,
    top: `${target.position.y * scale + y}px`,
  }
})

function onOpened(event: Event) {
  nodeId.value = (event as CustomEvent<{ nodeId: string }>).detail.nodeId
}

function onClosed() {
  nodeId.value = null
}

function onSelection(event: Event) {
  marks.value = (event as CustomEvent<SelectionMarks>).detail
}

window.addEventListener(EDIT_OPENED, onOpened)
window.addEventListener(EDIT_CLOSED, onClosed)
window.addEventListener(EDIT_SELECTION, onSelection)
onBeforeUnmount(() => {
  window.removeEventListener(EDIT_OPENED, onOpened)
  window.removeEventListener(EDIT_CLOSED, onClosed)
  window.removeEventListener(EDIT_SELECTION, onSelection)
})

function request(detail: FormatRequest) {
  window.dispatchEvent(new CustomEvent(EDIT_FORMAT, { detail }))
}

// mousedown, not click: a click would have to steal focus from the editor
// first, and a contenteditable that loses focus commits. Preventing the
// default on mousedown leaves the caret exactly where the user left it.
function onButtonDown(event: MouseEvent, detail: FormatRequest) {
  event.preventDefault()
  request(detail)
}

const SWATCHES = ['#ffffff', '#ff7f50', '#ffd166', '#4cc9f0', '#8ac926', '#ef476f']
</script>

<template>
  <div v-if="node" class="mindmap-text-toolbar" :style="barStyle">
    <button
      :class="{ active: marks.bold }"
      title="Bold (Ctrl+B)"
      @mousedown="onButtonDown($event, { mark: 'bold' })"
    >
      <b>B</b>
    </button>
    <button
      :class="{ active: marks.italic }"
      title="Italic (Ctrl+I)"
      @mousedown="onButtonDown($event, { mark: 'italic' })"
    >
      <i>I</i>
    </button>
    <button
      :class="{ active: marks.underline }"
      title="Underline (Ctrl+U)"
      @mousedown="onButtonDown($event, { mark: 'underline' })"
    >
      <u>U</u>
    </button>
    <button
      :class="{ active: marks.strike }"
      title="Strikethrough"
      @mousedown="onButtonDown($event, { mark: 'strike' })"
    >
      <s>S</s>
    </button>
    <span class="separator" />
    <button
      v-for="swatch in SWATCHES"
      :key="swatch"
      class="swatch"
      :style="{ background: swatch }"
      :title="`Colour ${swatch}`"
      @mousedown="onButtonDown($event, { color: swatch })"
    />
    <button
      class="swatch clear"
      title="Clear colour"
      @mousedown="onButtonDown($event, { color: undefined })"
    >
      x
    </button>
  </div>
</template>

<style scoped>
.mindmap-text-toolbar {
  position: absolute;
  /* Translated up by its own height rather than positioned from the node's
     measured box: the node's height is not known here (it lives in the
     canvas's size cache) and reading it back would tie this bar to the
     measurement pass. */
  transform: translate(-50%, calc(-100% - 10px));
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 6px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  background: rgba(18, 18, 20, 0.94);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
  z-index: 6;
  white-space: nowrap;
}

.mindmap-text-toolbar button {
  min-width: 24px;
  height: 24px;
  padding: 0 5px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: #ffffff;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.mindmap-text-toolbar button:hover {
  background: rgba(255, 255, 255, 0.14);
}

.mindmap-text-toolbar button.active {
  border-color: #ff7f50;
  color: #ff7f50;
}

.separator {
  width: 1px;
  height: 16px;
  margin: 0 3px;
  background: rgba(255, 255, 255, 0.22);
}

.mindmap-text-toolbar button.swatch {
  min-width: 16px;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.35);
}

.mindmap-text-toolbar button.swatch.clear {
  background: transparent;
  font-size: 11px;
}
</style>
