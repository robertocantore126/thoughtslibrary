<script setup lang="ts">
import type { Viewport } from '../../../mindmap/cull'
import type { NodeSize } from '../../../mindmap/layout'
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { readClipboard, serialiseSubtrees, toOutlineText, writeClipboard } from '../../../mindmap/clipboard'
import {
  createParent,
  dropPlacement,
  type DropPlacement,
  type DropZone,
  duplicateNode,
  expandAll,
  moveNodes,
  type NavDirection,
  navigateTo,
  pasteSubtrees,
  removeMany,
  subtreeIds,
} from '../../../mindmap/commands'
import { type Command, resolveCommand } from '../../../mindmap/keymap'
import { removeGroup, removeRelationship } from '../../../mindmap/relationCommands'
import { useMindmapStore } from '../../../mindmap/store'

const props = defineProps<{
  viewport: Viewport | null
  sizes: Record<string, NodeSize>
}>()

const store = useMindmapStore()
const root = ref<HTMLElement | null>(null)

// ---------------------------------------------------------------------------
// Transient state
// ---------------------------------------------------------------------------
// Declared at the top because every gesture handler below reads them, and the
// lint rule (ts/no-use-before-define) wants a single declaration point.

/** The marquee box, in canvas-screen coordinates. */
const marquee = reactive({ active: false, ctrl: false, x0: 0, y0: 0, x1: 0, y1: 0 })
let marqueePointer = -1

interface DropIndicator extends DropPlacement {
  targetId: string
  zone: DropZone
}

/** Where a drag would land, shown until pointerup. */
const dropIndicator = ref<DropIndicator | null>(null)

/** The right-click menu, positioned in canvas-screen coordinates. */
const contextMenu = ref<{ x: number, y: number, nodeId: string } | null>(null)

// ---------------------------------------------------------------------------
// Screen ↔ world
// ---------------------------------------------------------------------------
// screen = world * scale + camera (the single CSS transform in MindmapCanvas),
// so the world point under a client point is found by subtracting the canvas
// origin, then the camera, then dividing by the scale.
function screenToWorld(clientX: number, clientY: number): { x: number, y: number } {
  const rect = root.value?.getBoundingClientRect()
  if (!rect) {
    return { x: 0, y: 0 }
  }
  const { x, y, scale } = store.camera
  return { x: (clientX - rect.left - x) / scale, y: (clientY - rect.top - y) / scale }
}

function canvasSize(): { w: number, h: number } {
  const el = root.value
  return el ? { w: el.clientWidth, h: el.clientHeight } : { w: 0, h: 0 }
}

/**
 * Re-runs derived layout with the sizes the map already has.
 *
 * Layout is derived data that never enters an op or history (§T.3), and the
 * measure layer only calls applySizes when a SIZE changed — a move or delete
 * changes the tree and no size, so without this the map would sit on its stale
 * positions until some unrelated edit happened to re-measure. The interaction
 * controller is the one place a structural gesture ends, so it is the one
 * place a re-layout after one can be asked for.
 */
function relayout() {
  if (Object.keys(props.sizes).length > 0) {
    store.applySizes(props.sizes)
  }
}

// ---------------------------------------------------------------------------
// Keyboard (C.1/C.2)
// ---------------------------------------------------------------------------

function onKeydown(event: KeyboardEvent) {
  // Escape closes the context menu, and ONLY it: without stopImmediatePropagation
  // the overlay's own Escape handler — a separate window listener — would close
  // the whole map underneath the menu.
  if (contextMenu.value && event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    contextMenu.value = null
    return
  }
  const command = resolveCommand(event)
  if (!command) {
    return
  }
  // Every handled key is consumed: Space must not re-activate a focused
  // toolbar button, and arrows must not scroll anything behind the map.
  event.preventDefault()
  dispatch(command, event.key)
}

function dispatch(command: Command, key: string) {
  const primary = store.primaryNodeId
  const sheet = store.sheet
  switch (command) {
    case 'sibling': {
      if (!primary) {
        return
      }
      const created = store.createSibling(primary)
      if (created) {
        store.select({ kind: 'node', id: created })
        store.requestEdit(created)
        relayout()
      }
      break
    }
    case 'child': {
      const parentId = primary ?? sheet?.rootNodeId
      if (!parentId) {
        return
      }
      const created = store.createChild(parentId)
      if (created) {
        store.select({ kind: 'node', id: created })
        store.requestEdit(created)
        relayout()
      }
      break
    }
    case 'delete':
      deletePrimary()
      break
    case 'edit':
      if (primary) {
        store.requestEdit(primary)
      }
      break
    case 'toggle':
      if (primary) {
        store.toggleCollapse(primary)
        relayout()
      }
      break
    case 'navUp':
    case 'navDown':
    case 'navLeft':
    case 'navRight':
      navigate(primary, command.slice(3).toLowerCase() as NavDirection)
      break
    case 'undo':
      if (store.undo()) {
        relayout()
      }
      break
    case 'redo':
      if (store.redo()) {
        relayout()
      }
      break
    case 'copy':
      void copySelection(false)
      break
    case 'cut':
      void copySelection(true)
      break
    case 'paste':
      void pasteFromClipboard()
      break
    case 'copyOutline':
      void copyOutline()
      break
    case 'duplicate': {
      if (!primary) {
        return
      }
      const created = duplicateNode(store, primary)
      if (created) {
        store.select({ kind: 'node', id: created })
        relayout()
      }
      break
    }
    case 'expandAll':
      if (primary) {
        expandAll(store, primary)
        relayout()
      }
      break
    case 'fit': {
      const size = canvasSize()
      store.fit(size.w, size.h)
      break
    }
    case 'zoomIn':
      zoom(1.25)
      break
    case 'zoomOut':
      zoom(1 / 1.25)
      break
    case 'zoomReset':
      zoom(1 / store.camera.scale)
      break
    case 'typeToEdit':
      if (primary) {
        store.requestEdit(primary, key)
      }
      break
  }
}

// Delete acts on the PRIMARY selection's kind: a topic deletes its subtree,
// a relationship deletes the relationship, a boundary deletes the boundary.
function deletePrimary() {
  const selection = store.selection
  const primary = selection[selection.length - 1]
  if (!primary) {
    return
  }
  if (primary.kind === 'node') {
    removeMany(store, store.selectedNodeIds)
    relayout()
  }
  else if (primary.kind === 'relationship') {
    removeRelationship(store, primary.id)
  }
  else {
    removeGroup(store, primary.id)
  }
}

function navigate(fromId: string | null, direction: NavDirection) {
  const sheet = store.sheet
  if (!sheet || !fromId) {
    return
  }
  const next = navigateTo(sheet, props.sizes, fromId, direction)
  if (next) {
    store.select({ kind: 'node', id: next })
  }
}

function zoom(factor: number) {
  const size = canvasSize()
  store.zoomAt(size.w / 2, size.h / 2, factor)
}

// ---------------------------------------------------------------------------
// Clipboard (C.5)
// ---------------------------------------------------------------------------

async function copySelection(cut: boolean) {
  const sheet = store.sheet
  const ids = store.selectedNodeIds
  if (!sheet || ids.length === 0) {
    return
  }
  await writeClipboard(serialiseSubtrees(sheet, ids), toOutlineText(sheet, ids))
  if (cut) {
    removeMany(store, ids)
    relayout()
  }
}

// Mod+Shift+C is the outline ALONE: no structured flavour, no in-process copy,
// so a later paste cannot resurrect rich content the user deliberately
// exported as plain text.
async function copyOutline() {
  const sheet = store.sheet
  const ids = store.selectedNodeIds
  if (!sheet || ids.length === 0) {
    return
  }
  try {
    await navigator.clipboard?.writeText(toOutlineText(sheet, ids))
  }
  catch (error) {
    console.warn('Could not write the outline:', error)
  }
}

async function pasteFromClipboard() {
  const sheet = store.sheet
  if (!sheet) {
    return
  }
  const payload = await readClipboard()
  if (!payload) {
    return
  }
  const targetId = store.primaryNodeId ?? sheet.rootNodeId
  const created = pasteSubtrees(store, payload, targetId)
  if (created.length > 0) {
    store.selectMany(created.map(id => ({ kind: 'node' as const, id })))
    relayout()
  }
}

// ---------------------------------------------------------------------------
// Node drag, by delegation (C.3)
// ---------------------------------------------------------------------------
// One listener on the window catches every pointerdown; the target resolves
// through `data-node-id`, which Round 0 put on the topic root exactly so this
// component never has to touch MindmapNode. The drag itself is built from
// pointer capture on the topic, so it keeps tracking outside the window.

interface DragState {
  pointerId: number
  startX: number
  startY: number
  nodeId: string
  /** The nodes the gesture moves: the pointer-down node, or the selection. */
  ids: string[]
  dragging: boolean
}

let drag: DragState | null = null
// A pointerup that ended a real drag is followed by a click on the topic; the
// click must not ALSO select, or a node dragged out of a multi-selection gets
// added back to it. The capture-phase click listener below swallows exactly one.
let suppressNextClick = false

const DRAG_THRESHOLD = 4

function onPointerDown(event: PointerEvent) {
  // Any pointerdown outside an open menu closes it; the menu's own buttons
  // resolve as inside it and leave it alone.
  const target = event.target as HTMLElement
  if (contextMenu.value && !target.closest?.('.mindmap-context-menu')) {
    contextMenu.value = null
  }
  if (event.button !== 0) {
    return
  }
  // Text selection inside the rename editor must keep working: a pointerdown
  // on a contenteditable starts no drag (the keymap bails on the same targets).
  if (target.closest?.('[contenteditable], input, textarea')) {
    return
  }
  const nodeEl = target.closest?.('[data-node-id]') as HTMLElement | null
  const nodeId = nodeEl?.dataset.nodeId
  const sheet = store.sheet
  if (nodeId && sheet?.nodes[nodeId] && nodeId !== sheet.rootNodeId) {
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      nodeId,
      ids: [nodeId],
      dragging: false,
    }
    nodeEl?.setPointerCapture?.(event.pointerId)
    return
  }
  if (target.closest?.('.mindmap-ground') && event.shiftKey) {
    // Shift+drag on the ground is the marquee (C.4). MindmapCanvas's pan
    // handler bails on Shift, so the two gestures never fight over one pointer.
    const rect = root.value?.getBoundingClientRect()
    if (!rect) {
      return
    }
    marquee.active = true
    marquee.ctrl = event.ctrlKey || event.metaKey
    marquee.x0 = marquee.y0 = event.clientX - rect.left
    marquee.x1 = marquee.y1 = event.clientY - rect.top
    marqueePointer = event.pointerId
    target.setPointerCapture?.(event.pointerId)
  }
}

function onPointerMove(event: PointerEvent) {
  if (drag && event.pointerId === drag.pointerId) {
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
    if (!drag.dragging && moved > DRAG_THRESHOLD) {
      drag.dragging = true
      // A drag that started on an UNSELECTED node selects it, so the gesture
      // visibly moves what it is about to move. A drag on a selected node
      // keeps the whole selection — that is what moves the group, as one
      // undo entry (C.3).
      if (!store.isSelected({ kind: 'node', id: drag.nodeId })) {
        store.select({ kind: 'node', id: drag.nodeId })
      }
      const selected = store.selectedNodeIds.filter(id => id !== store.sheet?.rootNodeId)
      drag.ids = selected.length > 0 ? selected : [drag.nodeId]
      setDraggingClass(drag.ids, true)
    }
    if (drag.dragging) {
      updateDropIndicator(event)
    }
    return
  }
  if (marquee.active && event.pointerId === marqueePointer) {
    const rect = root.value?.getBoundingClientRect()
    if (!rect) {
      return
    }
    marquee.x1 = event.clientX - rect.left
    marquee.y1 = event.clientY - rect.top
  }
}

/**
 * The drop target under the pointer: the nearest topic — the one under the
 * pointer when there is one, the nearest by centre distance on empty ground —
 * and which third of its box the pointer is in: top is a sibling before it,
 * bottom a sibling after it, the middle a child of it (C.3).
 */
function updateDropIndicator(event: PointerEvent) {
  const sheet = store.sheet
  if (!sheet || !drag) {
    return
  }
  const world = screenToWorld(event.clientX, event.clientY)
  // A drop onto the dragged nodes' own descendants would build a cycle; they
  // are not candidates, so no indicator shows over them.
  const blocked = new Set<string>()
  for (const id of drag.ids) {
    for (const nodeId of subtreeIds(sheet, id)) {
      blocked.add(nodeId)
    }
  }
  let target: { id: string, zone: DropZone } | null = null
  let best = Infinity
  for (const node of store.visibleNodes) {
    if (blocked.has(node.id)) {
      continue
    }
    const size = props.sizes[node.id]
    if (!size) {
      continue
    }
    const cx = node.position.x + size.w / 2
    const cy = node.position.y + size.h / 2
    const distance = (cx - world.x) ** 2 + (cy - world.y) ** 2
    if (distance >= best) {
      continue
    }
    best = distance
    const relY = world.y - node.position.y
    const zone: DropZone = relY < size.h / 3 ? 'before' : relY > (size.h * 2) / 3 ? 'after' : 'child'
    target = { id: node.id, zone }
  }
  if (!target) {
    dropIndicator.value = null
    return
  }
  const placement = dropPlacement(sheet, drag.ids, target.id, target.zone)
  dropIndicator.value = placement ? { targetId: target.id, zone: target.zone, ...placement } : null
}

function onPointerUp(event: PointerEvent) {
  if (drag && event.pointerId === drag.pointerId) {
    if (drag.dragging) {
      setDraggingClass(drag.ids, false)
      const placement = dropIndicator.value
      if (placement) {
        // ONE commit for the whole gesture (§T.2): every pointermove between
        // the threshold and here built nothing.
        moveNodes(store, drag.ids, placement.parentId, placement.index)
        relayout()
      }
      suppressNextClick = true
    }
    drag = null
    dropIndicator.value = null
    return
  }
  if (marquee.active && event.pointerId === marqueePointer) {
    applyMarquee()
    marquee.active = false
  }
}

function onPointerCancel(event: PointerEvent) {
  if (drag && event.pointerId === drag.pointerId) {
    setDraggingClass(drag.ids, false)
    drag = null
    dropIndicator.value = null
  }
  if (marquee.active && event.pointerId === marqueePointer) {
    marquee.active = false
  }
}

function onClickCapture(event: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }
}

function setDraggingClass(ids: string[], on: boolean) {
  const el = root.value
  if (!el) {
    return
  }
  // Array.from: the project's TS lib has no DOM.Iterable, so a NodeList is
  // not directly iterable.
  for (const topic of Array.from(el.querySelectorAll<HTMLElement>('[data-node-id]'))) {
    if (ids.includes(topic.dataset.nodeId ?? '')) {
      topic.classList.toggle('dragging', on)
    }
  }
}

// ---------------------------------------------------------------------------
// Marquee (C.4)
// ---------------------------------------------------------------------------

const marqueeStyle = computed(() => ({
  left: `${Math.min(marquee.x0, marquee.x1)}px`,
  top: `${Math.min(marquee.y0, marquee.y1)}px`,
  width: `${Math.abs(marquee.x1 - marquee.x0)}px`,
  height: `${Math.abs(marquee.y1 - marquee.y0)}px`,
}))

/** Topics hidden under a collapsed ancestor must not be selectable blind. */
function hiddenUnderCollapsed(): Set<string> {
  const sheet = store.sheet
  const set = new Set<string>()
  if (!sheet) {
    return set
  }
  const walk = (id: string, under: boolean) => {
    const node = sheet.nodes[id]
    if (!node) {
      return
    }
    if (under) {
      set.add(id)
    }
    const childUnder = under || node.collapsed
    for (const childId of node.childrenIds) {
      walk(childId, childUnder)
    }
  }
  walk(sheet.rootNodeId, false)
  return set
}

function applyMarquee() {
  const sheet = store.sheet
  if (!sheet) {
    return
  }
  // A shift-CLICK on the ground (no drag) is not a marquee; leaving the
  // selection alone beats wiping it with an empty box.
  if (Math.abs(marquee.x1 - marquee.x0) < DRAG_THRESHOLD && Math.abs(marquee.y1 - marquee.y0) < DRAG_THRESHOLD) {
    return
  }
  const rect = root.value?.getBoundingClientRect()
  if (!rect) {
    return
  }
  const a = screenToWorld(rect.left + Math.min(marquee.x0, marquee.x1), rect.top + Math.min(marquee.y0, marquee.y1))
  const b = screenToWorld(rect.left + Math.max(marquee.x0, marquee.x1), rect.top + Math.max(marquee.y0, marquee.y1))
  const hidden = hiddenUnderCollapsed()
  const refs = store.visibleNodes
    .filter((node) => {
      if (hidden.has(node.id)) {
        return false
      }
      const size = props.sizes[node.id]
      if (!size) {
        return false
      }
      return node.position.x < b.x && node.position.x + size.w > a.x
        && node.position.y < b.y && node.position.y + size.h > a.y
    })
    .map(node => ({ kind: 'node' as const, id: node.id }))
  // Ctrl/Cmd makes the marquee additive; otherwise it replaces the selection.
  if (marquee.ctrl) {
    store.selectMany([...store.selection, ...refs])
  }
  else {
    store.selectMany(refs)
  }
}

// ---------------------------------------------------------------------------
// Drop indicator (C.3) and context menu (C.4)
// ---------------------------------------------------------------------------

const worldStyle = computed(() => ({
  transform: `translate(${store.camera.x}px, ${store.camera.y}px) scale(${store.camera.scale})`,
}))

const dropRect = computed(() => {
  const indicator = dropIndicator.value
  const sheet = store.sheet
  if (!indicator || !sheet) {
    return null
  }
  const node = sheet.nodes[indicator.targetId]
  const size = props.sizes[indicator.targetId]
  if (!node || !size) {
    return null
  }
  return { x: node.position.x, y: node.position.y, w: size.w, h: size.h }
})

const dropIndicatorStyle = computed(() => {
  const rect = dropRect.value
  const zone = dropIndicator.value?.zone
  if (!rect) {
    return null
  }
  if (zone === 'child') {
    return { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, height: `${rect.h}px` }
  }
  // before: a line over the target's top edge; after: under its bottom edge.
  const y = zone === 'before' ? rect.y - 3 : rect.y + rect.h - 3
  return { left: `${rect.x}px`, top: `${y}px`, width: `${rect.w}px` }
})

function onContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement
  const nodeEl = target.closest?.('[data-node-id]') as HTMLElement | null
  const nodeId = nodeEl?.dataset.nodeId
  const sheet = store.sheet
  if (!nodeId || !sheet?.nodes[nodeId]) {
    // Right-click on the ground closes any open menu.
    contextMenu.value = null
    return
  }
  // The menu acts on the topic it opened on; select it so its commands and
  // the Delete key agree about what "the selection" is.
  store.select({ kind: 'node', id: nodeId })
  event.preventDefault()
  event.stopPropagation()
  const rect = root.value?.getBoundingClientRect()
  if (!rect) {
    return
  }
  contextMenu.value = { x: event.clientX - rect.left, y: event.clientY - rect.top, nodeId }
}

function menuCommand(action: (nodeId: string) => void) {
  const menu = contextMenu.value
  if (!menu) {
    return
  }
  contextMenu.value = null
  action(menu.nodeId)
}

function menuAddChild() {
  menuCommand((nodeId) => {
    const created = store.createChild(nodeId)
    if (created) {
      store.select({ kind: 'node', id: created })
      store.requestEdit(created)
      relayout()
    }
  })
}

function menuAddSibling() {
  menuCommand((nodeId) => {
    const created = store.createSibling(nodeId)
    if (created) {
      store.select({ kind: 'node', id: created })
      relayout()
    }
  })
}

function menuDuplicate() {
  menuCommand((nodeId) => {
    const created = duplicateNode(store, nodeId)
    if (created) {
      store.select({ kind: 'node', id: created })
      relayout()
    }
  })
}

function menuCreateParent() {
  menuCommand((nodeId) => {
    const created = createParent(store, nodeId)
    if (created) {
      store.select({ kind: 'node', id: created })
      relayout()
    }
  })
}

function menuExpandAll() {
  menuCommand((nodeId) => {
    expandAll(store, nodeId)
    relayout()
  })
}

function menuDelete() {
  menuCommand((nodeId) => {
    removeMany(store, [nodeId])
    relayout()
  })
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
// Capture-phase window listeners, so the controller sees every event before
// any component in the map handles it. It must, or the drag delegation would
// miss a pointerdown that a topic's own handler already consumed.

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('pointermove', onPointerMove, { capture: true })
  window.addEventListener('pointerup', onPointerUp, { capture: true })
  window.addEventListener('pointercancel', onPointerCancel, { capture: true })
  window.addEventListener('click', onClickCapture, { capture: true })
  window.addEventListener('contextmenu', onContextMenu, { capture: true })
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('pointerdown', onPointerDown, { capture: true })
  window.removeEventListener('pointermove', onPointerMove, { capture: true })
  window.removeEventListener('pointerup', onPointerUp, { capture: true })
  window.removeEventListener('pointercancel', onPointerCancel, { capture: true })
  window.removeEventListener('click', onClickCapture, { capture: true })
  window.removeEventListener('contextmenu', onContextMenu, { capture: true })
})
</script>

<template>
  <div ref="root" class="mindmap-interaction">
    <!-- The marquee is drawn in screen space: it is a box around screen
    positions, and putting it inside the transformed world would make it grow
    and shrink with the zoom. -->
    <div v-if="marquee.active" class="mindmap-marquee" :style="marqueeStyle" />
    <!-- The drop indicator IS world geometry (it wraps a topic's box), so it
    sits inside a container carrying the same camera transform as the world. -->
    <div class="mindmap-interaction-world" :style="worldStyle">
      <div
        v-if="dropIndicator && dropRect"
        class="mindmap-drop-indicator"
        :class="dropIndicator.zone"
        :style="dropIndicatorStyle"
      />
    </div>
    <div
      v-if="contextMenu"
      class="mindmap-context-menu"
      :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
      role="menu"
    >
      <button role="menuitem" @click="menuAddChild">
        Add child
      </button>
      <button role="menuitem" @click="menuAddSibling">
        Add sibling
      </button>
      <button role="menuitem" @click="menuDuplicate">
        Duplicate
      </button>
      <button role="menuitem" @click="menuCreateParent">
        Create parent
      </button>
      <button role="menuitem" @click="menuExpandAll">
        Expand all
      </button>
      <button role="menuitem" @click="menuDelete">
        Delete
      </button>
    </div>
  </div>
</template>

<style scoped>
.mindmap-interaction {
  position: absolute;
  inset: 0;
  /* The controller catches nothing itself: pointer-events none lets every
     pointerdown reach the topics and the pan ground, and the window capture
     listeners do the catching. Only the context menu re-enables. */
  pointer-events: none;
  z-index: 2;
}

.mindmap-interaction-world {
  position: absolute;
  left: 0;
  top: 0;
  transform-origin: 0 0;
}

.mindmap-marquee {
  position: absolute;
  border: 1px solid #ff7f50;
  background: rgba(255, 127, 80, 0.12);
}

.mindmap-drop-indicator.child {
  position: absolute;
  border: 2px dashed #ff7f50;
  border-radius: 10px;
}

.mindmap-drop-indicator.before,
.mindmap-drop-indicator.after {
  position: absolute;
  height: 3px;
  margin-top: -1.5px;
  background: #ff7f50;
  border-radius: 2px;
}

.mindmap-context-menu {
  position: absolute;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: 4px;
  background: rgba(10, 10, 10, 0.95);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 6px;
  pointer-events: auto;
  z-index: 3;
}

.mindmap-context-menu button {
  appearance: none;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  padding: 6px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12.5px;
}

.mindmap-context-menu button:hover {
  background: rgba(255, 255, 255, 0.12);
}

/* The dragged topics get a transient dim; the class is toggled on their
   elements by the drag code, so it must reach past this component's scope. */
:global(.mindmap-node.dragging) {
  opacity: 0.45;
}
</style>
