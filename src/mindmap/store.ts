import type { MindNode, SelRef, Sheet, Style, TextRun } from './types'
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
import { blankSheet, readSheetResult, type WriteResult, writeSheet } from './storage'

/**
 * Where the debounced write has got to. `pending` means edits exist that the
 * timer has not written yet; `error` means the last attempt failed and is the
 * only state the UI must make impossible to miss (S4 Round 0 job 5).
 */
export type SaveState = 'clean' | 'pending' | 'saving' | 'error'

/**
 * A request to open the inline title editor on a node, seeded with `seed` (the
 * character that triggered type-to-edit, or '' for F2). It lives in the store
 * because the component that asks — the interaction controller — and the
 * component that obeys — MindmapNode — are owned by different S4 lanes and
 * must not import each other. The node clears it once its editor is open.
 */
export interface PendingEdit {
  nodeId: string
  seed: string
}

export interface MindmapState {
  sheet: Sheet | null
  /**
   * The selection, in the order the user built it — the LAST entry is the
   * primary one, which is what the inspector edits and what Delete acts on.
   * Typed refs rather than bare ids because relationships and boundaries are
   * selectable too and share the id space with nothing.
   */
  selection: SelRef[]
  camera: { x: number, y: number, scale: number }
  canUndo: boolean
  canRedo: boolean
  saveState: SaveState
  saveError: string | null
  pendingEdit: PendingEdit | null
}

export interface MindmapGetters {
  visibleNodes: (state: MindmapState) => MindNode[]
  selectedNodeIds: (state: MindmapState) => string[]
  primaryNodeId: (state: MindmapState) => string | null
}

/**
 * Why an open did not produce a map. A refusal leaves the store exactly as it
 * was — no blank sheet, nothing written — so the caller can say what happened
 * without the chart having already moved on.
 */
// `error?: undefined` on the success arm for the same reason WriteResult
// carries it: without it the union is not reliably discriminated through
// pinia's action typing, and `result.error` fails to narrow in the else branch.
export type OpenResult =
  | { ok: true, created: boolean, sheetId: string, error?: undefined, superseded?: false }
  // `superseded` separates "this open failed" from "this open was overtaken".
  // Only the first is the user's problem: the second means a later open (or a
  // close) already decided what the store holds, so the caller must drop its
  // result silently rather than report a failure nobody caused.
  | { ok: false, error: string, superseded: boolean }

export interface MindmapActions {
  open: (sheetId: string | null) => Promise<OpenResult>
  close: () => Promise<void>
  applySizes: (sizes: Record<string, NodeSize>) => void
  createChild: (parentId: string) => string
  createSibling: (nodeId: string) => string
  rename: (nodeId: string, title: string, runs?: TextRun[]) => void
  remove: (nodeId: string) => void
  toggleCollapse: (nodeId: string) => void
  /**
   * Fixes a node's absolute position in world units and marks it manual, so
   * layout flows around it (position.manual is the engine's promise: only an
   * explicit auto-layout clears it). One `setPosition` op, so Ctrl+Z undoes a
   * manual placement like any other edit.
   */
  setPosition: (nodeId: string, x: number, y: number) => void
  setNodeStyle: (nodeId: string, patch: Partial<Style>) => void
  clearNodeStyle: (nodeId: string, fields: (keyof Style)[]) => void
  select: (ref: SelRef | null, mode?: 'replace' | 'toggle') => void
  selectMany: (refs: SelRef[]) => void
  clearSelection: () => void
  isSelected: (ref: SelRef) => boolean
  refExists: (ref: SelRef) => boolean
  requestEdit: (nodeId: string, seed?: string) => void
  clearPendingEdit: () => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (sx: number, sy: number, factor: number) => void
  fit: (viewW: number, viewH: number) => void
  undo: () => boolean
  redo: () => boolean
  /**
   * The extension seam (S4 §0.2). It builds the copy-on-write draft, applies
   * each op, records the inverses in history, republishes and schedules the
   * save — so a new command is a pure op builder in its own module that ends
   * here, and does not need a new action on this store.
   */
  commit: (ops: Op[]) => void
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

// Generation ticket for the session. open() and close() both suspend — on the
// flush, on the read, on the write of a fresh sheet — and the store they come
// back to is a singleton. Each call takes a ticket up front; a step that
// resolves holding a stale one has been overtaken by a later open() or close()
// and must publish nothing. Without it the LAST write wins rather than the
// last CALL: two opens racing meant whichever read finished last decided which
// map the store held, and an open still in flight when the overlay unmounted
// republished a sheet that close() had just dropped.
//
// close() already guards itself by sheet id; this is the same idea reaching
// across the two, so a close can invalidate an open and not only the reverse.
let sessionGeneration = 0

// The published sheet is replaced, never mutated — the chart store's idiom
// (MINDMAP_NATIVE_AGENT_BRIEF Lane D). Every edit runs on a draft and
// publishes it; the reference change is what makes Vue's change detection
// cheap and lets `sheet` stay a shallowRef.
//
// The draft is COPY-ON-WRITE, not a deep clone: node objects and the
// collection arrays are shared with the published sheet, and applyOp /
// layoutSheet clone only what an op actually touches (each node at most once
// per batch). A rename on a 3,000-node map clones one node instead of
// structuredClone-ing the sheet — the per-keystroke snapshot cost the ops
// design exists to avoid (see ops.ts). The share is safe because every
// mutation path replaces before it mutates: nodes go through cloneNode, and
// the arrays below are the draft's own copies.
function draftOf(sheet: Sheet): Sheet {
  return {
    ...sheet,
    nodes: { ...sheet.nodes },
    relationships: [...sheet.relationships],
    boundaries: [...sheet.boundaries],
    summaries: [...sheet.summaries],
    attachments: [...sheet.attachments],
  }
}

// Pre-order walk of a node and its descendants, exactly as a delete op needs
// its subtree snapshot (see the ops tests). Deep-cloned so the op never
// references nodes the sheet may mutate later.
function collectSubtree(sheet: Sheet, id: string): MindNode[] {
  const out: MindNode[] = []
  const seen = new Set<string>()
  const walk = (nodeId: string) => {
    if (seen.has(nodeId)) {
      return
    }
    const node = sheet.nodes[nodeId]
    if (!node) {
      return
    }
    seen.add(nodeId)
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
    selection: [] as SelRef[],
    camera: { x: 0, y: 0, scale: 1 },
    canUndo: false,
    canRedo: false,
    saveState: 'clean' as SaveState,
    saveError: null as string | null,
    pendingEdit: null as PendingEdit | null,
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
    // The node ids of the selection, in selection order. Almost every caller
    // wants this rather than the raw refs — relationships and boundaries are
    // selected far more rarely than topics are.
    selectedNodeIds(state: MindmapState): string[] {
      return state.selection.filter(ref => ref.kind === 'node').map(ref => ref.id)
    },
    // The topic the inspector edits: the LAST node selected, not the first.
    // Shift-clicking a second topic must move the inspector to it, or the
    // panel keeps editing something the user stopped looking at.
    primaryNodeId(state: MindmapState): string | null {
      for (let i = state.selection.length - 1; i >= 0; i--) {
        const ref = state.selection[i]
        if (ref.kind === 'node') {
          return ref.id
        }
      }
      return null
    },
  },
  actions: {
    // Republishes a structural draft and drops selection entries that no longer
    // point at anything (a removed node, a relationship an undo just deleted).
    // Every kind is checked: before S4 only nodes were selectable, and a stale
    // relationship ref would leave the inspector editing a ghost.
    publish(draft: Sheet) {
      this.sheet = draft
      const sheet = this.sheet
      const alive = (ref: SelRef) => {
        if (ref.kind === 'node') {
          return !!sheet.nodes[ref.id]
        }
        if (ref.kind === 'relationship') {
          return sheet.relationships.some(r => r.id === ref.id)
        }
        return sheet.boundaries.some(g => g.id === ref.id)
      }
      if (this.selection.some(ref => !alive(ref))) {
        this.selection = this.selection.filter(alive)
      }
      // An editor open on a node that just vanished has nothing to commit to.
      if (this.pendingEdit && !sheet.nodes[this.pendingEdit.nodeId]) {
        this.pendingEdit = null
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
      // This call's ticket. Checked after every suspension below; see
      // sessionGeneration.
      const generation = ++sessionGeneration
      const overtaken: OpenResult = { ok: false, error: 'A newer open replaced this one', superseded: true }

      // Commit whatever write is still pending to the sheet it belongs to
      // before swapping it out — the same rule LocalStorageWatcher's pending
      // write follows, so an edit made just before switching is never lost to
      // the sheet that replaces it. The write is AWAITED: flushSave normally
      // fires and forgets, but readSheet below would race it — a read that
      // wins returns the pre-edit sheet and the last edit silently vanishes.
      await this.flushSave()
      if (generation !== sessionGeneration) {
        return overtaken
      }

      let sheet: Sheet
      let created: boolean

      if (sheetId === null) {
        sheet = blankSheet('Untitled')
        created = true
      }
      else {
        const result = await readSheetResult(sheetId)
        if (generation !== sessionGeneration) {
          return overtaken
        }
        if (result.kind === 'ok') {
          sheet = result.sheet
          created = false
        }
        else if (result.kind === 'missing') {
          // The chart points at a sheet that genuinely is not there any more —
          // a dangling id from an import that half-landed, or a store cleared
          // by hand. A fresh map is the honest thing to open.
          sheet = blankSheet('Untitled')
          created = true
        }
        else {
          // Storage is down, or the record is unreadable. Both used to arrive
          // here as `null` and become a blank map, which the overlay then
          // recorded on the chart — pointing the tile at an empty sheet while
          // the real one sat on disk, unreferenced. Refuse instead, and leave
          // every byte of state alone so nothing has moved on when the caller
          // decides what to say.
          return { ok: false, error: result.error, superseded: false }
        }
      }

      // A brand-new sheet must exist on disk BEFORE anything points at it. If
      // the write fails there is nothing worth opening: publishing it anyway
      // would show a map that vanishes on the next reload.
      if (created) {
        const write = await writeSheet(sheet.sheetId, sheet)
        if (generation !== sessionGeneration) {
          // Overtaken while the fresh sheet was being written. It is on disk
          // and nothing references it — an orphan the sweep cannot see, since
          // it collects image blobs and not sheets. Rare enough to accept and
          // small enough not to chase with a delete that could itself race.
          return overtaken
        }
        if (!write.ok) {
          return { ok: false, error: write.error, superseded: false }
        }
      }

      history.clear()
      this.sheet = sheet
      this.selection = []
      this.pendingEdit = null
      this.sizes = {}
      this.canUndo = false
      this.canRedo = false
      this.saveState = 'clean'
      this.saveError = null
      this.camera = { x: 0, y: 0, scale: 1 }
      // The id travels back in the result rather than being read off
      // `this.sheet` afterwards: a caller that awaits open() and then reads the
      // store singleton is reading whatever the LAST open put there, which on
      // a fast tile switch is a different map's id.
      return { ok: true, created, sheetId: sheet.sheetId }
    },
    async close() {
      // Taking a ticket here is what stops an open() still in flight from
      // republishing the sheet this close is about to drop — the overlay
      // unmounts with `void mindmap.close()`, so the two really do overlap.
      ++sessionGeneration
      // The last edit must survive the overlay closing even if its debounce
      // never fired; flush, then drop the sheet.
      const closingId = this.sheet?.sheetId ?? null
      await this.flushSave()
      // Generation guard: close() awaits the flush, and nothing today can
      // swap the sheet while it is in flight (the overlay is modal). The day
      // a switch-map path exists, an in-flight close must not null the sheet
      // an open() just put in place — bail if it changed under us.
      if ((this.sheet?.sheetId ?? null) !== closingId) {
        return
      }
      history.clear()
      this.sheet = null
      this.selection = []
      this.pendingEdit = null
      this.sizes = {}
      this.canUndo = false
      this.canRedo = false
      this.saveState = 'clean'
      this.saveError = null
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
    // `runs` carries the styled version of the same title. `title` stays the
    // plain-text projection of it and is what the rest of the product reads
    // (types.ts MindNode.title) — so a caller passing runs must pass the
    // matching plain text, and the setTitle op carries both plus their
    // predecessors, which is what makes Ctrl+Z restore the formatting too.
    //
    // The early-out compares runs as well: bolding a word leaves `title`
    // identical, and bailing on that would silently drop the edit.
    rename(nodeId: string, title: string, runs?: TextRun[]) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node) {
        return
      }
      const sameRuns = JSON.stringify(node.titleRuns ?? null) === JSON.stringify(runs ?? null)
      if (node.title === title && sameRuns) {
        return
      }
      this.commit([makeOp('setTitle', {
        id: nodeId,
        title,
        prev: node.title,
        titleRuns: runs,
        prevRuns: node.titleRuns,
      })])
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
    setPosition(nodeId: string, x: number, y: number) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node) {
        return
      }
      // No-op when the node is already exactly there (and already manual): a
      // drag that lands where it started must not leave an undo entry behind.
      if (node.position.manual && node.position.x === x && node.position.y === y) {
        return
      }
      this.commit([makeOp('setPosition', {
        id: nodeId,
        x,
        y,
        manual: true,
        prev: node.position,
      })])
    },
    // Style edits are ops, not mutations (S2 M3 trap 5): a field merged into a
    // fresh style object and committed through `setStyle` — whose PREV is the
    // whole old style — so Ctrl+Z undoes a style change like any other edit and
    // the same commit path marks dirty and debounces the save.
    setNodeStyle(nodeId: string, patch: Partial<Style>) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node || Object.keys(patch).length === 0) {
        return
      }
      const next: Style = { ...node.style }
      let changed = false
      for (const key of Object.keys(patch) as (keyof Style)[]) {
        const value = patch[key]
        if (next[key] !== value) {
          next[key] = value as never
          changed = true
        }
      }
      if (!changed) {
        return
      }
      this.commit([makeOp('setStyle', { id: nodeId, style: next, prev: node.style })])
    },
    // Removes fields entirely (not sets them to undefined) so a cleared colour
    // genuinely falls back to the chart default rather than carrying an
    // explicit-undefined through export.
    clearNodeStyle(nodeId: string, fields: (keyof Style)[]) {
      const sheet = this.sheet
      const node = sheet?.nodes[nodeId]
      if (!sheet || !node || fields.length === 0) {
        return
      }
      const next: Style = { ...node.style }
      let changed = false
      for (const key of fields) {
        if (key in next) {
          delete next[key]
          changed = true
        }
      }
      if (!changed) {
        return
      }
      this.commit([makeOp('setStyle', { id: nodeId, style: next, prev: node.style })])
    },
    // `replace` (the default) is a plain click; `toggle` is a Shift/Ctrl click,
    // which adds the ref or removes it if it was already there. Passing null
    // clears, so the pre-S4 `select(null)` call sites keep working unchanged.
    select(ref: SelRef | null, mode: 'replace' | 'toggle' = 'replace') {
      if (ref === null) {
        this.selection = []
        return
      }
      if (!this.refExists(ref)) {
        return
      }
      if (mode === 'replace') {
        this.selection = [ref]
        return
      }
      const without = this.selection.filter(r => !(r.kind === ref.kind && r.id === ref.id))
      // Re-adding an already-selected ref pushes it to the end rather than
      // leaving it where it was: the last entry is the primary one, and a
      // Shift-click the user just made is what they mean to be editing.
      this.selection = without.length === this.selection.length ? [...without, ref] : without
    },
    selectMany(refs: SelRef[]) {
      const seen = new Set<string>()
      this.selection = refs.filter((ref) => {
        const key = `${ref.kind}:${ref.id}`
        if (seen.has(key) || !this.refExists(ref)) {
          return false
        }
        seen.add(key)
        return true
      })
    },
    clearSelection() {
      this.selection = []
    },
    isSelected(ref: SelRef): boolean {
      return this.selection.some(r => r.kind === ref.kind && r.id === ref.id)
    },
    // Whether a ref points at something the open sheet actually holds. Selection
    // has always refused ids that do not resolve; this keeps that rule for all
    // three kinds rather than only for nodes.
    refExists(ref: SelRef): boolean {
      const sheet = this.sheet
      if (!sheet) {
        return false
      }
      if (ref.kind === 'node') {
        return !!sheet.nodes[ref.id]
      }
      if (ref.kind === 'relationship') {
        return sheet.relationships.some(r => r.id === ref.id)
      }
      return sheet.boundaries.some(g => g.id === ref.id)
    },
    // The one channel between the interaction controller and the inline editor
    // (S4 §0.3): type-to-edit, F2 and the context menu all land here, and
    // MindmapNode watches it, opens its editor seeded with `seed`, and clears
    // it. Neither side imports the other.
    requestEdit(nodeId: string, seed = '') {
      if (!this.sheet?.nodes[nodeId]) {
        return
      }
      this.pendingEdit = { nodeId, seed }
    },
    clearPendingEdit() {
      this.pendingEdit = null
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
      // Unsaved edits exist from this moment, not from when the timer fires.
      // A previous failure stays visible until a write actually succeeds: an
      // error that clears itself the instant the user types again is an error
      // nobody ever reads.
      if (this.saveState !== 'error') {
        this.saveState = 'pending'
      }
      if (saveTimer) {
        clearTimeout(saveTimer)
      }
      saveTimer = setTimeout(() => {
        saveTimer = null
        this.flushSave()
      }, AUTOSAVE_DELAY)
    },
    // Folds a WriteResult into the visible save state. One place, so no write
    // path can report success by forgetting to report anything.
    recordWrite(result: WriteResult) {
      if (result.ok) {
        this.saveState = 'clean'
        this.saveError = null
      }
      else {
        this.saveState = 'error'
        this.saveError = result.error
      }
    },
    // Writes the current sheet, clearing any pending debounce. Safe to call at
    // any time; a failed write still never throws — an unavailable IndexedDB
    // must not take the UI down with it — but it is now RECORDED rather than
    // swallowed. Returns a promise so open()/close() can await the write
    // before a read or teardown depends on it.
    flushSave(): Promise<void> {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      const sheet = this.sheet
      if (!sheet) {
        return Promise.resolve()
      }
      this.saveState = 'saving'
      return writeSheet(sheet.sheetId, sheet)
        .then((result) => {
          // The sheet may have been swapped or closed while the write was in
          // flight; reporting "saved" then would describe a sheet that is no
          // longer open.
          if (this.sheet?.sheetId === sheet.sheetId) {
            this.recordWrite(result)
          }
        })
        .catch((error: unknown) => {
          if (this.sheet?.sheetId === sheet.sheetId) {
            this.recordWrite({ ok: false, error: error instanceof Error ? error.message : 'Save failed' })
          }
        })
    },
  },
}) as unknown as StoreDefinition<'mindmap', MindmapState, MindmapGetters, MindmapActions>
