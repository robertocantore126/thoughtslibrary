import type { MindNode, Sheet } from './types'
/**
 * The mindmap store — the single owner of the open sheet, the selection, the
 * camera and the undo/redo history (MINDMAP_NATIVE_AGENT_BRIEF Lane D).
 *
 * The frozen contract in §0.3 fixes this store's shape exactly; Lanes E and F
 * compile against it before this file exists. It deliberately does NOT know
 * how to lay a sheet out or where sheets live: layout arrives through
 * `applySizes` (the DOM measurements Lane E feeds in) and persistence through
 * the storage module, both per §0.3.
 */
import { defineStore, type StoreDefinition } from 'pinia'
import { shallowRef } from 'vue'
import { History } from './history'
import { layoutSheet, type NodeSize } from './layout'
import { applyWithInverse, makeOp, type Op } from './ops'
import { blankSheet, readSheet, writeSheet } from './storage'

export interface MindmapState {
  sheet: Sheet | null
  selection: string | null
  camera: { x: number, y: number, scale: number }
  canUndo: boolean
  canRedo: boolean
}

export interface MindmapGetters {
  visibleNodes: (state: MindmapState) => MindNode[]
}

export interface MindmapActions {
  open: (sheetId: string | null) => Promise<void>
  close: () => Promise<void>
  applySizes: (sizes: Record<string, NodeSize>) => void
  createChild: (parentId: string) => string
  createSibling: (nodeId: string) => string
  rename: (nodeId: string, title: string) => void
  remove: (nodeId: string) => void
  toggleCollapse: (nodeId: string) => void
  select: (nodeId: string | null) => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (sx: number, sy: number, factor: number) => void
  fit: (viewW: number, viewH: number) => void
  undo: () => boolean
  redo: () => boolean
}

// Autosave debounce, mirroring the chart store's own settle-then-write trade
// (LocalStorageWatcher flushes 300ms after the last mutation). A keystroke
// must not write the sheet on every character.
const AUTOSAVE_DELAY = 500
// Zoom bounds. Symmetric so a zoom-out marathon cannot lose the map and a
// zoom-in marathon cannot push past the text renderer's crisp range.
const MIN_ZOOM = 0.1
const MAX_ZOOM = 4
// fit() needs node sizes, which only Lane E's DOM measurements can provide.
// Before the first applySizes arrives, fall back to a rough topic box.
const FALLBACK_NODE_SIZE: NodeSize = { w: 120, h: 40 }

// History is deliberately NOT state. Pinia would deep-react it (proxying every
// op batch) and its UnwrapRef typing strips a class instance to its public
// properties, which would hide push/undo/redo. There is exactly one mindmap
// session at a time, and open()/close() clear it, so a module singleton is
// safe — and a fresh pinia in tests still starts clean because open() clears.
const history = new History()
// Same reasoning for the save timer: a Timeout handle must not sit in the
// reactive graph (a proxied Timeout is not a Timeout). Matches the module-level
// timer LocalStorageWatcher uses.
let saveTimer: ReturnType<typeof setTimeout> | null = null

// Ops mutate a sheet in place, but the published sheet is replaced, never
// mutated — the chart store's idiom (MINDMAP_NATIVE_AGENT_BRIEF Lane D). Every
// edit therefore runs on a fresh clone and publishes that clone; the reference
// change is what makes Vue's change detection cheap and lets `sheet` stay a
// shallowRef.
function draftOf(sheet: Sheet): Sheet {
  return structuredClone(sheet)
}

// Pre-order walk of a node and its descendants, exactly as a delete op needs
// its subtree snapshot (see the ops tests). Deep-cloned so the op never
// references nodes the sheet may mutate later.
function collectSubtree(sheet: Sheet, id: string): MindNode[] {
  const out: MindNode[] = []
  const walk = (nodeId: string) => {
    const node = sheet.nodes[nodeId]
    if (!node) {
      return
    }
    out.push(structuredClone(node))
    for (const childId of node.childrenIds) {
      walk(childId)
    }
  }
  walk(id)
  return out
}

// The store is declared as the frozen contract type rather than pinia's inferred
// one: inference sees the raw state shape (ShallowRef<Sheet>, the literal
// `false` of the canUndo/canRedo initialisers), which is not what Lanes E and F
// compile against. The double cast is the standard escape hatch for this
// options-store friction — the runtime object is unaffected.
export const useMindmapStore = defineStore('mindmap', {
  state: () => ({
    sheet: shallowRef<Sheet | null>(null),
    selection: null as string | null,
    camera: { x: 0, y: 0, scale: 1 },
    canUndo: false,
    canRedo: false,
    // Last measured sizes, kept only so fit() can frame the map. Not part of
    // the frozen contract; shallow so a several-hundred-entry record is never
    // proxied (the same rule the brief applies to the node map).
    sizes: shallowRef<Record<string, NodeSize>>({}),
  }),
  getters: {
    // Everything in the sheet, in document order (parents before children).
    // S1 renders all of it; the getter exists so viewport culling later is one
    // change here rather than a restructuring of Lane E's components.
    visibleNodes(state: MindmapState): MindNode[] {
      const sheet = state.sheet
      if (!sheet) {
        return []
      }
      const seen = new Set<string>()
      const out: MindNode[] = []
      const walk = (nodeId: string) => {
        const node = sheet.nodes[nodeId]
        if (!node || seen.has(nodeId)) {
          return
        }
        seen.add(nodeId)
        out.push(node)
        for (const childId of node.childrenIds) {
          walk(childId)
        }
      }
      walk(sheet.rootNodeId)
      // Floating nodes nothing reaches from the root (legacy imports, hand-edited
      // JSON) would otherwise vanish from the canvas; append them so the map
      // renders everything it holds.
      for (const node of Object.values(sheet.nodes)) {
        if (!seen.has(node.id)) {
          out.push(node)
        }
      }
      return out
    },
  },
  actions: {
    // Republishes a structural draft and drops a selection that no longer
    // points at anything (a removed node, or a node an undo just deleted).
    publish(draft: Sheet) {
      this.sheet = draft
      if (this.selection && !this.sheet.nodes[this.selection]) {
        this.selection = null
      }
    },
    // Applies a batch of already-built ops to a fresh draft, records their
    // inverses in history and republishes. Every editing action funnels
    // through here so no path can forget history or the save timer.
    commit(ops: Op[]) {
      const sheet = this.sheet
      if (!sheet) {
        return
      }
      const draft = draftOf(sheet)
      const inverses: Op[][] = []
      for (const op of ops) {
        inverses.push(applyWithInverse(draft, op))
      }
      history.push(ops, inverses)
      this.publish(draft)
      this.canUndo = history.canUndo
      this.canRedo = history.canRedo
      this.scheduleSave()
    },
    // Applies the ops undo()/redo() returned from history, publishing a fresh
    // draft. Their inverses are deliberately discarded: History has already
    // moved the batch to the other stack, so recording them again would
    // double-enter the same entry.
    applyOps(ops: Op[]) {
      const sheet = this.sheet
      if (!sheet) {
        return
      }
      const draft = draftOf(sheet)
      for (const op of ops) {
        applyWithInverse(draft, op)
      }
      this.publish(draft)
    },
    async open(sheetId: string | null) {
      // Commit whatever write is still pending to the sheet it belongs to
      // before swapping it out — the same rule LocalStorageWatcher's pending
      // write follows, so an edit made just before switching is never lost to
      // the sheet that replaces it.
      this.flushSave()
      const loaded = sheetId === null ? null : await readSheet(sheetId)
      const sheet = loaded ?? blankSheet('Untitled')
      if (!loaded) {
        // A brand-new sheet must exist before the chart store points at it;
        // the caller reads its id from `sheet` once open resolves.
        await writeSheet(sheet.sheetId, sheet)
      }
      history.clear()
      this.sheet = sheet
      this.selection = null
      this.sizes = {}
      this.canUndo = false
      this.canRedo = false
      this.camera = { x: 0, y: 0, scale: 1 }
    },
    async close() {
      // The last edit must survive the overlay closing even if its debounce
      // never fired; flush, then drop the sheet.
      this.flushSave()
      history.clear()
      this.sheet = null
      this.selection = null
      this.sizes = {}
      this.canUndo = false
      this.canRedo = false
      this.camera = { x: 0, y: 0, scale: 1 }
    },
    // Lane E measured the DOM and hands the sizes over. Layout runs here
    // because it is derived data — it never enters an op and never enters
    // history (trap §T.2) — so this republishes the sheet without touching
    // the undo stacks.
    applySizes(sizes: Record<string, NodeSize>) {
      const sheet = this.sheet
      if (!sheet) {
        return
      }
      this.sizes = sizes
      const draft = draftOf(sheet)
      layoutSheet(draft, sizes)
      this.sheet = draft
    },
    createChild(parentId: string): string {
      const sheet = this.sheet
      const parent = sheet?.nodes[parentId]
      if (!sheet || !parent) {
        return ''
      }
      const id = crypto.randomUUID()
      this.commit([makeOp('createNode', {
        id,
        nodeType: parentId === sheet.rootNodeId ? 'main' : 'subtopic',
        parentId,
        index: parent.childrenIds.length,
        title: 'New topic',
      })])
      return id
    },
    createSibling(nodeId: string): string {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node || node.parentId === null) {
        return ''
      }
      const parent = sheet.nodes[node.parentId]
      if (!parent) {
        return ''
      }
      const id = crypto.randomUUID()
      this.commit([makeOp('createNode', {
        id,
        nodeType: node.parentId === sheet.rootNodeId ? 'main' : 'subtopic',
        parentId: node.parentId,
        index: parent.childrenIds.indexOf(nodeId) + 1,
        title: 'New topic',
      })])
      return id
    },
    rename(nodeId: string, title: string) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node || node.title === title) {
        return
      }
      this.commit([makeOp('setTitle', { id: nodeId, title, prev: node.title })])
    },
    remove(nodeId: string) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node || nodeId === sheet.rootNodeId) {
        return
      }
      const subtree = collectSubtree(sheet, nodeId)
      const removedIds = new Set(subtree.map(n => n.id))
      const removedRelationships = sheet.relationships.filter(r => removedIds.has(r.fromId) || removedIds.has(r.toId))
      const parent = node.parentId ? sheet.nodes[node.parentId] : undefined
      this.commit([makeOp('deleteNode', {
        id: nodeId,
        parentId: node.parentId,
        index: parent ? parent.childrenIds.indexOf(nodeId) : 0,
        subtree,
        removedRelationships,
      })])
    },
    toggleCollapse(nodeId: string) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node) {
        return
      }
      this.commit([makeOp('setCollapsed', { id: nodeId, collapsed: !node.collapsed, prev: node.collapsed })])
    },
    select(nodeId: string | null) {
      if (nodeId !== null && !this.sheet?.nodes[nodeId]) {
        return
      }
      this.selection = nodeId
    },
    panBy(dx: number, dy: number) {
      this.camera = { ...this.camera, x: this.camera.x + dx, y: this.camera.y + dy }
    },
    zoomAt(sx: number, sy: number, factor: number) {
      // Anchor the zoom at the screen point (sx, sy): the world coordinate
      // under the cursor stays under the cursor. Clamped so a map cannot be
      // zoomed into oblivion or away to a speck.
      const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.camera.scale * factor))
      const applied = scale / this.camera.scale
      this.camera = {
        scale,
        x: sx - (sx - this.camera.x) * applied,
        y: sy - (sy - this.camera.y) * applied,
      }
    },
    fit(viewW: number, viewH: number) {
      const sheet = this.sheet
      if (!sheet) {
        return
      }
      const nodes = this.visibleNodes
      if (nodes.length === 0) {
        return
      }
      const sizes = this.sizes
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const node of nodes) {
        const size = sizes[node.id] ?? FALLBACK_NODE_SIZE
        minX = Math.min(minX, node.position.x)
        minY = Math.min(minY, node.position.y)
        maxX = Math.max(maxX, node.position.x + size.w)
        maxY = Math.max(maxY, node.position.y + size.h)
      }
      const width = Math.max(1, maxX - minX)
      const height = Math.max(1, maxY - minY)
      const padding = 40
      const scale = Math.min(
        MAX_ZOOM,
        Math.max(1, viewW - padding * 2) / width,
        Math.max(1, viewH - padding * 2) / height,
      )
      // screen = world * scale + camera, so centering the map's bounds means
      // camera = viewport / 2 - center * scale.
      this.camera = {
        scale,
        x: viewW / 2 - (minX + width / 2) * scale,
        y: viewH / 2 - (minY + height / 2) * scale,
      }
    },
    undo(): boolean {
      const sheet = this.sheet
      if (!sheet) {
        return false
      }
      const ops = history.undo()
      if (!ops) {
        return false
      }
      this.applyOps(ops)
      this.canUndo = history.canUndo
      this.canRedo = history.canRedo
      this.scheduleSave()
      return true
    },
    redo(): boolean {
      const sheet = this.sheet
      if (!sheet) {
        return false
      }
      const ops = history.redo()
      if (!ops) {
        return false
      }
      this.applyOps(ops)
      this.canUndo = history.canUndo
      this.canRedo = history.canRedo
      this.scheduleSave()
      return true
    },
    scheduleSave() {
      const sheet = this.sheet
      if (!sheet) {
        return
      }
      if (saveTimer) {
        clearTimeout(saveTimer)
      }
      saveTimer = setTimeout(() => {
        saveTimer = null
        this.flushSave()
      }, AUTOSAVE_DELAY)
    },
    // Writes the current sheet, clearing any pending debounce. Safe to call at
    // any time; a failed write degrades silently rather than throwing — the
    // storage lane mirrors this posture, so an unavailable IndexedDB must
    // never take the UI down with it.
    flushSave() {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      const sheet = this.sheet
      if (!sheet) {
        return
      }
      void writeSheet(sheet.sheetId, sheet).catch(() => {})
    },
  },
}) as unknown as StoreDefinition<'mindmap', MindmapState, MindmapGetters, MindmapActions>
