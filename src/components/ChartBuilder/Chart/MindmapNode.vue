<script setup lang="ts">
import type { MindNode } from '../../../mindmap/types'
import { computed, nextTick, ref } from 'vue'
import { topicBoxStyle, topicVisualStyle } from '../../../mindmap/nodeStyle'
import { useMindmapStore } from '../../../mindmap/store'

// The canvas renders one of these per visible node. Position is per-instance
// here; every box-affecting style comes from topicBoxStyle, the SAME helper the
// hidden measure layer uses (MINDMAP_S2_AGENT_BRIEF M1.2/M2 — one stylesheet for
// one box, so layout measures the exact browser wrap). Chart look is the
// default: fontFamily/textColor inherit from the overlay (chart.font /
// chart.textColor), so this component sets them only when node.style sets them.
const props = defineProps<{
  node: MindNode
}>()

const store = useMindmapStore()

const isSelected = computed(() => store.selection === props.node.id)

const nodeStyle = computed(() => ({
  left: `${props.node.position.x}px`,
  top: `${props.node.position.y}px`,
  ...topicBoxStyle(props.node),
  // Visual style is non-box (M2): a fill/opacity change must not re-invalidate
  // measurement, hence it lives apart from topicBoxStyle.
  ...topicVisualStyle(props.node),
}))

// --- rename in place ------------------------------------------------------
// The editor is a contenteditable div, the same choice the notes editor made:
// the browser owns its text history, so Ctrl+Z inside a rename never fights
// the map's undo stack (the hotkey's contenteditable check returns first).
const editor = ref<HTMLDivElement | null>(null)
const editing = ref(false)

async function startEdit() {
  editing.value = true
  await nextTick()
  const el = editor.value
  if (!el) {
    return
  }
  el.textContent = props.node.title
  el.focus()
  // Select-all: the user is about to type a replacement, and a caret stranded
  // at the end of a long title is the one place everyone immediately re-seeks.
  const range = document.createRange()
  range.selectNodeContents(el)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

// Blur and Enter both commit; Escape cancels. commitEdit flips `editing` off
// first so the blur that follows an Enter-commit cannot commit twice.
function commitEdit() {
  if (!editing.value) {
    return
  }
  editing.value = false
  const text = editor.value?.textContent ?? ''
  const trimmed = text.trim()
  if (trimmed && trimmed !== props.node.title) {
    store.rename(props.node.id, trimmed)
  }
}

function cancelEdit() {
  editing.value = false
}

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    commitEdit()
    editor.value?.blur()
  }
  else if (event.key === 'Escape') {
    event.preventDefault()
    // Stop the overlay's Escape-to-close from firing on the same key.
    event.stopPropagation()
    cancelEdit()
    editor.value?.blur()
  }
}

function onNodeClick() {
  if (editing.value) {
    return
  }
  store.select(props.node.id)
}

function onNodeDblclick() {
  if (!editing.value) {
    void startEdit()
  }
}

function toggleCollapsed() {
  store.toggleCollapse(props.node.id)
}
</script>

<template>
  <div
    class="mindmap-node"
    :class="{ selected: isSelected }"
    :style="nodeStyle"
    @click="onNodeClick"
    @dblclick="onNodeDblclick"
  >
    <span v-if="!editing" class="mindmap-node-title">{{ props.node.title }}</span>
    <div
      v-else
      ref="editor"
      class="mindmap-node-editor"
      contenteditable="true"
      spellcheck="false"
      @keydown="onEditorKeydown"
      @blur="commitEdit"
    />
    <button
      v-if="props.node.childrenIds.length > 0"
      class="mindmap-node-toggle"
      :class="{ collapsed: props.node.collapsed }"
      :title="props.node.collapsed ? 'Expand' : 'Collapse'"
      @click.stop="toggleCollapsed"
    >
      {{ props.node.collapsed ? '+' : '-' }}
    </button>
  </div>
</template>

<style scoped>
.mindmap-node.selected {
  outline: 2px solid #ff7f50;
  outline-offset: 2px;
}

/* Box-affecting rules live in the SHARED `.mindmap-node` class in global.css,
   not here — see MINDMAP_S2_AGENT_BRIEF M1.2's "one stylesheet" rule. */

.mindmap-node-editor {
  outline: none;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  user-select: text;
  min-width: 0;
}

.mindmap-node-toggle {
  position: absolute;
  top: -9px;
  right: -9px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.45);
  background: rgba(0, 0, 0, 0.78);
  color: #ffffff;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}

.mindmap-node-toggle.collapsed {
  border-color: #ff7f50;
  color: #ff7f50;
}
</style>
