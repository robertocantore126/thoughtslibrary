<script setup lang="ts">
import type { Mark } from '../../../mindmap/richtext'
import type { MindNode, TextRun } from '../../../mindmap/types'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { topicBoxStyle, topicVisualStyle } from '../../../mindmap/nodeStyle'
import {
  plainOffsetOf,
  plainPointOf,
  plainToRuns,
  runParagraphs,
  runsFromDom,
  runsFromHtml,
  runsToPlain,
  runStyle,
  setRunColor,
  toggleMark,
} from '../../../mindmap/richtext'
import { useMindmapStore } from '../../../mindmap/store'
import {
  EDIT_CLOSED,
  EDIT_FORMAT,
  EDIT_OPENED,
  EDIT_SELECTION,
  type FormatRequest,
  type SelectionMarks,
} from './MindmapTextToolbar.vue'
import MindmapTopicContent from './MindmapTopicContent.vue'

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

const isSelected = computed(() => store.isSelected({ kind: 'node', id: props.node.id }))

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
//
// From S4 Lane A the editor is RICH: it is seeded with the rendered runs, not
// with textContent, and committed by reading its DOM back through the same
// walker the paste path uses (richtext.runsFromDom). Both directions go
// through richtext.ts, so the editor and the topic cannot disagree about what
// a run looks like.
const editor = ref<HTMLDivElement | null>(null)
const editing = ref(false)

// The title the editor opened on. Escape needs nothing else — the store is
// never touched until commit, so cancelling is just closing the editor — but
// the empty-title rule below has to know whether the title was ever set.
const openedTitle = ref('')

/** The node's runs, or the single implicit run an unstyled title stands for. */
function currentRuns(): TextRun[] {
  return props.node.titleRuns?.length ? props.node.titleRuns : plainToRuns(props.node.title)
}

/**
 * Paint `runs` into the editor as real elements.
 *
 * Built node by node with createElement and textContent. Nothing is ever
 * assigned through innerHTML — not the node's own title and least of all a
 * paste — because the moment pasted markup is allowed into the live document
 * the sanitisation stops being total and becomes a blocklist someone has to
 * keep ahead of (§A.3). The runs are the only thing that crosses.
 *
 * `data-indent` and `data-fs` are the read-back hints: a bullet drawn in CSS
 * carries no `<li>` to count, and a font size inferred from a `font-size`
 * declaration would misread every pasted document. The walker trusts these
 * two attributes and infers everything else.
 */
function paintEditor(el: HTMLElement, runs: TextRun[]) {
  el.textContent = ''
  for (const para of runParagraphs(runs)) {
    const line = el.ownerDocument.createElement('div')
    line.className = 'mindmap-editor-para'
    if (para.listIndent > 0) {
      line.dataset.indent = String(para.listIndent)
      line.style.paddingLeft = `${para.listIndent * 11}px`
    }
    for (const run of para.runs) {
      const span = el.ownerDocument.createElement('span')
      Object.assign(span.style, runStyle(run))
      if (run.fontSize) {
        span.dataset.fs = String(run.fontSize)
      }
      span.textContent = run.text
      line.append(span)
    }
    // An empty paragraph collapses to nothing and the caret cannot land in
    // it, so it keeps a <br> the way every contenteditable does.
    if (!line.textContent) {
      line.append(el.ownerDocument.createElement('br'))
    }
    el.append(line)
  }
  if (!el.firstChild) {
    el.append(el.ownerDocument.createElement('div'))
  }
}

/** The editor's content as runs, through the walker the paste path uses. */
function readEditor(): TextRun[] {
  const el = editor.value
  // preserveWhitespace: the editor box is pre-wrap, so the newlines the user
  // typed are content. Collapsing them would flatten a multi-line title on
  // every commit.
  return el ? runsFromDom(el, true) : []
}

function selectAll(el: HTMLElement, collapseToEnd: boolean) {
  const range = el.ownerDocument.createRange()
  range.selectNodeContents(el)
  if (collapseToEnd) {
    range.collapse(false)
  }
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

// `seed` replaces the title outright and leaves the caret after it: that is
// type-to-edit, where the character the user pressed IS the new title. Without
// a seed the existing title is selected whole, because the user is about to
// type a replacement and a caret stranded at the end of a long title is the one
// place everyone immediately re-seeks.
async function startEdit(seed = '') {
  openedTitle.value = props.node.title
  editing.value = true
  // Only the open editor listens for the bar's requests. Registering at setup
  // would put one listener on the window per mounted topic, which on a large
  // map is a few thousand of them for a bar that talks to exactly one.
  window.addEventListener(EDIT_FORMAT, onFormatRequest)
  await nextTick()
  const el = editor.value
  if (!el) {
    return
  }
  // A seed discards the formatting along with the text, which is right: the
  // user typed a character over the whole title and means to replace it.
  paintEditor(el, seed ? plainToRuns(seed) : currentRuns())
  el.focus()
  selectAll(el, !!seed)
  window.dispatchEvent(new CustomEvent(EDIT_OPENED, { detail: { nodeId: props.node.id } }))
  reportSelection()
}

/**
 * Blur and Enter both commit; Escape cancels. commitEdit flips `editing` off
 * first so the blur that follows an Enter-commit cannot commit twice.
 *
 * The empty title (F26): a node created and then abandoned blank stays an
 * empty box forever. On an empty commit the node is deleted when it is a
 * childless leaf whose title was never set; anything else keeps its previous
 * title untouched. Deletion goes through store.remove, so it is one op in the
 * same history as everything else and Ctrl+Z brings the node back — someone
 * who blanked a title by accident must never be left without a way back.
 */
function commitEdit() {
  if (!editing.value) {
    return
  }
  const runs = readEditor()
  editing.value = false
  closeToolbar()

  const trimmed = trimRuns(runs)
  const plain = runsToPlain(trimmed)
  if (!plain) {
    // "Never set" includes the creation placeholder: a topic created and then
    // blanked without ever being named is the empty box F26 exists to remove,
    // while a topic that HAD a real title keeps it untouched. Both outcomes
    // are recoverable — removal through store.remove (one undo restores the
    // node), the title by never having been renamed.
    const neverTitled = openedTitle.value.trim() === '' || openedTitle.value === 'New topic'
    if (neverTitled && props.node.childrenIds.length === 0) {
      store.remove(props.node.id)
    }
    return
  }

  // A title with no formatting left keeps titleRuns UNDEFINED (§A.1), so a map
  // that never used formatting does not grow a parallel copy of itself in
  // every save file. A single unmarked run is exactly that case — and `plain`
  // is still computed from the runs either way, so the two cannot disagree.
  const plainOnly = trimmed.length <= 1 && trimmed.every(run => Object.keys(run).length === 1)
  store.rename(props.node.id, plain, plainOnly ? undefined : trimmed)
}

/**
 * Trim leading and trailing whitespace across the run sequence.
 *
 * The title handed to `store.rename` is `runsToPlain` of these runs, so
 * trimming the string alone would leave the two out of step by exactly the
 * whitespace the user happened to type — the invariant breaking in the one
 * place nothing would ever look.
 */
function trimRuns(runs: TextRun[]): TextRun[] {
  const out = runs.map(run => ({ ...run }))
  while (out.length > 0) {
    out[0].text = out[0].text.replace(/^\s+/, '')
    if (out[0].text) {
      break
    }
    out.shift()
  }
  while (out.length > 0) {
    const last = out[out.length - 1]
    last.text = last.text.replace(/\s+$/, '')
    if (last.text) {
      break
    }
    out.pop()
  }
  return out
}

function cancelEdit() {
  editing.value = false
  closeToolbar()
}

// --- formatting -----------------------------------------------------------

/**
 * The caret's position as PLAIN-TEXT offsets into the editor's content.
 *
 * richtext.ts's range functions take plain-text offsets because that is the
 * only coordinate system a DOM Selection reduces to without teaching every
 * caller about run splitting. plainOffsetOf shares the traversal with
 * runsFromDom, so these offsets index exactly the string
 * runsToPlain(runsFromDom(el, true)) builds — a hand-written walk here would
 * drift from it by one newline per `<br>` or empty paragraph, which is how
 * Ctrl+B ends up formatting the wrong word.
 */
function selectionOffsets(): { start: number, end: number } | null {
  const el = editor.value
  const selection = window.getSelection()
  if (!el || !selection || selection.rangeCount === 0) {
    return null
  }
  const range = selection.getRangeAt(0)
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) {
    return null
  }
  const start = plainOffsetOf(el, { node: range.startContainer, offset: range.startOffset })
  const end = plainOffsetOf(el, { node: range.endContainer, offset: range.endOffset })
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/** Re-seed the editor after a range edit, keeping the same text selected. */
function applyToSelection(edit: (runs: TextRun[], start: number, end: number) => TextRun[]) {
  const el = editor.value
  const range = selectionOffsets()
  if (!el || !range || range.start === range.end) {
    return
  }
  const next = edit(readEditor(), range.start, range.end)
  paintEditor(el, next)
  restoreOffsets(el, range.start, range.end)
  reportSelection()
}

/** Put the selection back on the same plain-text range after a re-paint. */
function restoreOffsets(el: HTMLElement, start: number, end: number) {
  const startPoint = plainPointOf(el, start)
  const endPoint = plainPointOf(el, end)
  if (!startPoint || !endPoint) {
    return
  }
  // The points are always on text nodes; the DomLike view is this module's
  // structural reading of the same real nodes the range needs.
  const range = el.ownerDocument.createRange()
  range.setStart(startPoint.node as unknown as Text, startPoint.offset)
  range.setEnd(endPoint.node as unknown as Text, endPoint.offset)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Tell the toolbar which marks the current selection already carries. */
function reportSelection() {
  const range = selectionOffsets()
  const marks: SelectionMarks = { bold: false, italic: false, underline: false, strike: false }
  if (range && range.start !== range.end) {
    const runs = readEditor()
    let cursor = 0
    let sawAny = false
    const all = { bold: true, italic: true, underline: true, strike: true }
    for (const run of runs) {
      const from = cursor
      cursor += run.text.length
      if (cursor <= range.start || from >= range.end) {
        continue
      }
      sawAny = true
      all.bold &&= !!run.bold
      all.italic &&= !!run.italic
      all.underline &&= !!run.underline
      all.strike &&= !!run.strike
    }
    if (sawAny) {
      Object.assign(marks, all)
    }
  }
  window.dispatchEvent(new CustomEvent(EDIT_SELECTION, { detail: marks }))
}

function closeToolbar() {
  window.removeEventListener(EDIT_FORMAT, onFormatRequest)
  window.dispatchEvent(new CustomEvent(EDIT_CLOSED))
}

/**
 * The toolbar's half of the protocol.
 *
 * The format bar and this editor are two components in the same lane, and
 * they talk through window events rather than a shared module because the
 * only thing that crosses is a mark name — a store field for it would be a
 * change to a file this lane does not own, for a message that never outlives
 * one keystroke.
 */
function onFormatRequest(event: Event) {
  if (!editing.value) {
    return
  }
  const detail = (event as CustomEvent<FormatRequest>).detail
  if (detail.mark) {
    applyToSelection((runs, start, end) => toggleMark(runs, start, end, detail.mark as Mark))
  }
  else {
    applyToSelection((runs, start, end) => setRunColor(runs, start, end, detail.color))
  }
  editor.value?.focus()
}

// A topic can be unmounted with its editor open — culling scrolls it out of
// view, or Lane C deletes it. Without this the bar would stay on screen over
// a node that no longer exists, and the format listener would outlive it.
onBeforeUnmount(() => {
  if (editing.value) {
    closeToolbar()
  }
})

const MARK_KEYS: Record<string, Mark> = { b: 'bold', i: 'italic', u: 'underline' }

function onEditorKeydown(event: KeyboardEvent) {
  // An IME composition is not done: Enter confirms the candidate, and a
  // character key is still building it. Acting on either would commit or
  // format half a word (audit T15 — the reference has the same gap, but it is
  // one guard to close here).
  if (event.isComposing) {
    return
  }
  // Ctrl/Cmd+B/I/U format the selection. The browser's own bold on a
  // contenteditable would inject <b> elements this component never rendered
  // and the walker would then have to guess at them, so the default is
  // suppressed and the mark goes through richtext.toggleMark like every other
  // route to it.
  const mark = (event.ctrlKey || event.metaKey) && !event.altKey ? MARK_KEYS[event.key.toLowerCase()] : undefined
  if (mark) {
    event.preventDefault()
    applyToSelection((runs, start, end) => toggleMark(runs, start, end, mark))
    return
  }

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
  // Ctrl+Z is deliberately NOT handled: the contenteditable owns its own text
  // history and the map's undo must not fight it (§A.4).
}

/**
 * Paste, intercepted.
 *
 * The browser's default would insert the source's markup straight into this
 * live contenteditable, which is exactly what §A.3 forbids. Instead the
 * payload is parsed into runs in an inert document, and the editor is
 * repainted from those runs — so a `<script>`, an `onerror` or a
 * `javascript:` href has no path into the page even in principle.
 */
function onEditorPaste(event: ClipboardEvent) {
  const el = editor.value
  if (!el) {
    return
  }
  event.preventDefault()
  const html = event.clipboardData?.getData('text/html') ?? ''
  const plain = event.clipboardData?.getData('text/plain') ?? ''
  const pasted = html ? runsFromHtml(html) : plainToRuns(plain)
  if (pasted.length === 0) {
    return
  }

  const range = selectionOffsets()
  const existing = readEditor()
  const before = range ? sliceRuns(existing, 0, range.start) : existing
  const after = range ? sliceRuns(existing, range.end, runsToPlain(existing).length) : []
  const next = [...before, ...pasted, ...after]
  paintEditor(el, next)

  const caret = runsToPlain(before).length + runsToPlain(pasted).length
  restoreOffsets(el, caret, caret)
  reportSelection()
}

/** The runs covering a plain-text range, splitting the ones that straddle it. */
function sliceRuns(runs: TextRun[], start: number, end: number): TextRun[] {
  const out: TextRun[] = []
  let cursor = 0
  for (const run of runs) {
    const from = cursor
    const to = cursor + run.text.length
    cursor = to
    if (to <= start || from >= end) {
      continue
    }
    const text = run.text.slice(Math.max(0, start - from), Math.min(run.text.length, end - from))
    if (!text) {
      continue
    }
    const piece = { ...run, text }
    // A piece that starts mid-run is the TAIL of its paragraph: the block
    // boundary belongs to the paragraph's start, and carrying it onto the
    // tail would open a new paragraph in the middle of the pasted line.
    if (start - from > 0) {
      delete piece.paraGap
      delete piece.listIndent
    }
    out.push(piece)
  }
  return out
}

function onNodeClick(event: MouseEvent) {
  if (editing.value) {
    return
  }
  // Shift/Ctrl extends the selection; a plain click replaces it.
  store.select({ kind: 'node', id: props.node.id }, event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
}

// The one channel from the interaction controller into this editor (S4 §0.3):
// type-to-edit, F2 and the context menu all set store.pendingEdit rather than
// reaching into this component, and the matching node opens seeded with it.
watch(() => store.pendingEdit, (pending) => {
  if (pending?.nodeId !== props.node.id || editing.value) {
    return
  }
  store.clearPendingEdit()
  void startEdit(pending.seed)
}, { immediate: true })

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
    :data-node-id="props.node.id"
    @click="onNodeClick"
    @dblclick="onNodeDblclick"
  >
    <MindmapTopicContent :node="props.node" :hide-title="editing" />
    <div
      v-if="editing"
      ref="editor"
      class="mindmap-node-editor"
      contenteditable="true"
      spellcheck="false"
      @keydown="onEditorKeydown"
      @keyup="reportSelection"
      @mouseup="reportSelection"
      @paste="onEditorPaste"
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

/* The editor mirrors MindmapTopicContent's paragraph rules so formatting does
   not visibly shift the moment the editor opens over a topic. It is NOT a
   measured box — the editor only ever exists on the live node, never in the
   measure layer — so these live here rather than beside the shared rules. */
.mindmap-node-editor :deep(.mindmap-editor-para) {
  display: block;
  white-space: pre-wrap;
}

.mindmap-node-editor :deep(.mindmap-editor-para[data-indent]) {
  text-indent: -11px;
}

.mindmap-node-editor :deep(.mindmap-editor-para[data-indent])::before {
  content: '• ';
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
