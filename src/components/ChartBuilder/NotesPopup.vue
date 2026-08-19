<script setup lang="ts">
import {
  BIconLink45deg,
  BIconListOl,
  BIconListUl,
  BIconQuote,
  BIconSticky,
  BIconSubtract,
  BIconTextIndentLeft,
  BIconTextIndentRight,
  BIconTypeBold,
  BIconTypeItalic,
  BIconTypeStrikethrough,
  BIconTypeUnderline,
  BIconX,
} from 'bootstrap-icons-vue'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { htmlToMarkdown, renderMarkdown } from '../../helpers/markdown'
import { useStore } from '../../store'

const store = useStore()

const popupEl = ref<HTMLElement | null>(null)
const editorEl = ref<HTMLElement | null>(null)
const pos = reactive({ left: 0, top: 0 })

const visible = computed(() => store.notesPopupVisible)
const note = computed(() => store.activeTileNote)
const tileTitle = computed(() => {
  const active = store.activeTile
  if (!active) {
    return ''
  }

  return active.item.title || `Tile (${active.x}, ${active.y})`
})

function positionPopup() {
  if (!popupEl.value || !visible.value) {
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

function syncEditorContent() {
  if (!editorEl.value) {
    return
  }

  // Never clobber the editor while the user is typing in it.
  if (document.activeElement === editorEl.value) {
    return
  }

  editorEl.value.innerHTML = renderMarkdown(note.value)
}

function onEditorInput() {
  if (!editorEl.value) {
    return
  }

  store.setActiveTileNote(htmlToMarkdown(editorEl.value.innerHTML))
}

function exec(command: string, value?: string) {
  editorEl.value?.focus()
  document.execCommand(command, false, value)
}

function toggleHeading() {
  const selection = window.getSelection()
  let block: HTMLElement | null = selection?.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode as HTMLElement
    : (selection?.anchorNode?.parentElement || null)

  while (block && !['P', 'H1', 'H2', 'H3', 'H4', 'DIV', 'BLOCKQUOTE', 'LI'].includes(block.tagName)) {
    block = block.parentElement
  }

  const isHeading = !!block && /^H[1-6]$/.test(block.tagName)
  exec('formatBlock', isHeading ? 'P' : 'H2')
}

function addLink() {
  // eslint-disable-next-line no-alert
  const url = window.prompt('Link URL', 'https://')
  if (url) {
    exec('createLink', url)
  }
}

// Opening the native color picker wipes the document selection, so capture the
// editor's range before the picker shows and restore it when a color is picked.
const savedColorRange = ref<Range | null>(null)

function captureSelectionForColor() {
  const selection = window.getSelection()
  const editor = editorEl.value
  if (!selection || !editor || selection.rangeCount === 0) {
    savedColorRange.value = null
    return
  }

  const range = selection.getRangeAt(0)
  if (editor.contains(range.commonAncestorContainer)) {
    savedColorRange.value = range.cloneRange()
  }
  else {
    savedColorRange.value = null
  }
}

function applyColor(event: Event, command: 'foreColor' | 'hiliteColor') {
  const value = (event.target as HTMLInputElement).value
  const editor = editorEl.value
  if (!editor) {
    return
  }

  if (savedColorRange.value) {
    editor.focus()
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(savedColorRange.value)
    savedColorRange.value = null
  }

  exec(command, value)
}

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key === 'Tab') {
    event.preventDefault()
    exec(event.shiftKey ? 'outdent' : 'indent')
  }

  if (event.key === 'Escape') {
    store.closeNotesPopup()
  }
}

watch(visible, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      positionPopup()
      syncEditorContent()
    })
  }
})

watch(note, () => {
  nextTick(() => {
    positionPopup()
    syncEditorContent()
  })
})

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && store.notesPopupVisible) {
    store.closeNotesPopup()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('scroll', positionPopup, true)
  window.addEventListener('resize', positionPopup)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('scroll', positionPopup, true)
  window.removeEventListener('resize', positionPopup)
})
</script>

<template>
  <div
    v-if="visible"
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
    <div class="notes-toolbar" role="toolbar" aria-label="Note formatting">
      <button type="button" title="Bold" aria-label="Bold" @mousedown.prevent @click="exec('bold')">
        <BIconTypeBold />
      </button>
      <button type="button" title="Italic" aria-label="Italic" @mousedown.prevent @click="exec('italic')">
        <BIconTypeItalic />
      </button>
      <button type="button" title="Underline" aria-label="Underline" @mousedown.prevent @click="exec('underline')">
        <BIconTypeUnderline />
      </button>
      <button type="button" title="Strikethrough" aria-label="Strikethrough" @mousedown.prevent @click="exec('strikeThrough')">
        <BIconTypeStrikethrough />
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" title="Heading" aria-label="Heading" @mousedown.prevent @click="toggleHeading">
        H2
      </button>
      <button type="button" title="Bulleted list" aria-label="Bulleted list" @mousedown.prevent @click="exec('insertUnorderedList')">
        <BIconListUl />
      </button>
      <button type="button" title="Numbered list" aria-label="Numbered list" @mousedown.prevent @click="exec('insertOrderedList')">
        <BIconListOl />
      </button>
      <button type="button" title="Quote" aria-label="Quote" @mousedown.prevent @click="exec('formatBlock', 'BLOCKQUOTE')">
        <BIconQuote />
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" title="Indent" aria-label="Indent" @mousedown.prevent @click="exec('indent')">
        <BIconTextIndentRight />
      </button>
      <button type="button" title="Outdent" aria-label="Outdent" @mousedown.prevent @click="exec('outdent')">
        <BIconTextIndentLeft />
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <button type="button" title="Link" aria-label="Link" @mousedown.prevent @click="addLink">
        <BIconLink45deg />
      </button>
      <button type="button" title="Horizontal rule" aria-label="Horizontal rule" @mousedown.prevent @click="exec('insertHorizontalRule')">
        <BIconSubtract />
      </button>
      <span class="toolbar-divider" aria-hidden="true" />
      <label class="color-control" title="Text color" @mousedown="captureSelectionForColor">
        <input
          type="color"
          value="#ffffff"
          aria-label="Text color"
          @change="(event) => applyColor(event, 'foreColor')"
        >
      </label>
      <label class="color-control" title="Highlight (background) color" @mousedown="captureSelectionForColor">
        <input
          type="color"
          value="#ffff00"
          aria-label="Highlight color"
          @change="(event) => applyColor(event, 'hiliteColor')"
        >
      </label>
    </div>
    <div
      ref="editorEl"
      class="notes-editor"
      contenteditable="true"
      data-placeholder="Write notes... (Tab indents, Shift+Tab outdents)"
      @input="onEditorInput"
      @keydown="onEditorKeydown"
    />
  </div>
</template>

<style scoped>
.notes-popup {
  position: absolute;
  width: 500px;
  max-width: calc(100% - 24px);
  max-height: 72vh;
  display: flex;
  flex-direction: column;
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

.notes-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: #17171a;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.notes-toolbar button {
  appearance: none;
  border: none;
  background: transparent;
  color: #cccccc;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0;
}

.notes-toolbar button:hover {
  cursor: pointer;
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.toolbar-divider {
  width: 1px;
  height: 18px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 4px;
}

.color-control {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  cursor: pointer;
}

.color-control:hover {
  background: rgba(255, 255, 255, 0.12);
}

.color-control input[type='color'] {
  appearance: none;
  -webkit-appearance: none;
  border: none;
  padding: 0;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
}

.color-control input[type='color']::-webkit-color-swatch-wrapper {
  padding: 0;
}

.color-control input[type='color']::-webkit-color-swatch {
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 4px;
}

.notes-editor {
  flex: 1;
  min-height: 240px;
  max-height: calc(72vh - 96px);
  overflow-y: auto;
  padding: 12px 14px;
  outline: none;
  font-size: 0.9rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
  caret-color: var(--accent);
}

.notes-editor:empty::before {
  content: attr(data-placeholder);
  color: #666666;
  pointer-events: none;
}

.notes-editor :deep(p) {
  margin: 0 0 0.5em;
}

.notes-editor :deep(p:last-child) {
  margin-bottom: 0;
}

.notes-editor :deep(h1),
.notes-editor :deep(h2),
.notes-editor :deep(h3),
.notes-editor :deep(h4) {
  margin: 0.4em 0 0.3em;
  color: var(--accent);
  line-height: 1.25;
}

.notes-editor :deep(h1) {
  font-size: 1.15rem;
}

.notes-editor :deep(h2) {
  font-size: 1.05rem;
}

.notes-editor :deep(h3),
.notes-editor :deep(h4) {
  font-size: 0.95rem;
}

.notes-editor :deep(ul),
.notes-editor :deep(ol) {
  margin: 0 0 0.5em;
  padding-left: 1.5em;
}

.notes-editor :deep(li) {
  margin-bottom: 0.15em;
}

.notes-editor :deep(blockquote) {
  margin: 0 0 0.5em;
  padding-left: 0.8em;
  border-left: 3px solid var(--accent);
  opacity: 0.9;
}

.notes-editor :deep(code) {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 4px;
  padding: 0.1em 0.35em;
  font-size: 0.85em;
}

.notes-editor :deep(pre) {
  background: rgba(0, 0, 0, 0.5);
  border-radius: 8px;
  padding: 10px;
  overflow-x: auto;
  margin: 0 0 0.5em;
}

.notes-editor :deep(pre code) {
  background: transparent;
  padding: 0;
}

.notes-editor :deep(a) {
  color: #7fd4ff;
}

.notes-editor :deep(hr) {
  border: none;
  border-top: 1px solid rgba(255, 255, 255, 0.25);
  margin: 0.6em 0;
}

.notes-editor :deep(table) {
  border-collapse: collapse;
  margin: 0 0 0.5em;
}

.notes-editor :deep(th),
.notes-editor :deep(td) {
  border: 1px solid rgba(255, 255, 255, 0.2);
  padding: 4px 8px;
}

.notes-editor :deep(del) {
  opacity: 0.6;
}

.notes-editor :deep(img) {
  max-width: 100%;
  border-radius: 6px;
}

@media screen and (max-width: 1000px) {
  .notes-popup {
    width: auto;
    left: 8px !important;
    right: 8px;
    top: 8px !important;
    max-width: none;
  }
}
</style>
