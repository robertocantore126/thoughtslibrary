/**
 * Operation system, ported from r-node's src/core/ops.ts.
 *
 * Every meaningful edit is expressed as an Operation. Operations are
 * self-contained (carry the data needed to apply AND to reverse), so undo is a
 * replay of stored inverse ops rather than a snapshot. A sheet is a
 * Record<string, MindNode> mutated in place; snapshotting several hundred
 * nodes on every keystroke is a different proposition from the chart store's
 * wholesale replacement (MINDMAP_NATIVE_AGENT_BRIEF Lane A), which is why ops
 * exist here at all.
 *
 * r-node's envelope (opId/actorId/ts) is deliberately dropped: nothing in this
 * app feeds a collaboration layer, and the frozen contract's Op type is
 * unadorned — Lane D builds plain objects and batches them itself.
 */
import type {
  AttachmentInfo,
  Group,
  ImageSlot,
  MindNode,
  Position,
  Relationship,
  Sheet,
  StructureConfig,
  Style,
  Summary,
  TaskInfo,
  TextRun,
} from './types'

// ---------------------------------------------------------------------------
// Op definitions
// ---------------------------------------------------------------------------

/**
 * The frozen contract's op: any payload, distinguished by `type`. `OpShape`
 * below is the typed union of everything applyWithInverse understands; a
 * producer (Lane D) builds an object matching one member and hands it over.
 */
// The frozen contract (§0.3) fixes this exact alias and its loose index
// signature; an interface would change the shape the other lanes compile
// against.
// eslint-disable-next-line ts/consistent-type-definitions
export type Op = { type: string, [k: string]: unknown }

type OpShape =
  | { type: 'createNode', id: string, nodeType: MindNode['type'], parentId: string | null, index: number, title: string, titleRuns?: TextRun[], style?: Style, task?: TaskInfo | null, position?: { x: number, y: number, manual: boolean } }
  | { type: 'restoreNode', id: string, parentId: string | null, index: number, subtree: MindNode[], removedRelationships: Relationship[] }
  | { type: 'deleteNode', id: string, parentId: string | null, index: number, subtree: MindNode[], removedRelationships: Relationship[] }
  | { type: 'setTitle', id: string, title: string, prev: string, titleRuns?: TextRun[], prevRuns?: TextRun[] }
  | { type: 'setStyle', id: string, style: Style, prev: Style }
  | { type: 'setNodeImage', nodeId: string, imageId: string | null, prevImageId: string | null, position?: ImageSlot }
  | { type: 'setPosition', id: string, x: number, y: number, manual: boolean, offsetX?: number, offsetY?: number, prev: Position }
  | { type: 'setCollapsed', id: string, collapsed: boolean, prev: boolean }
  | { type: 'moveNode', id: string, fromParentId: string | null, fromIndex: number, toParentId: string | null, toIndex: number }
  | { type: 'sortSiblings', parentId: string, order: string[], prevOrder: string[] }
  | { type: 'setTask', id: string, task: TaskInfo | null, prev: TaskInfo | null }
  | { type: 'setNotes', id: string, notes: string, prev: string }
  | { type: 'setSheetTitle', title: string, prev: string }
  | { type: 'setStructure', config: StructureConfig, prev: StructureConfig }
  | { type: 'createRelationship', relationship: Relationship }
  | { type: 'deleteRelationship', id: string, relationship: Relationship }
  | { type: 'setRelationship', id: string, relationship: Relationship, prev: Relationship }
  | { type: 'createGroup', group: Group }
  | { type: 'deleteGroup', id: string, group: Group }
  | { type: 'setGroup', id: string, group: Group, prev: Group }
  | { type: 'createSummary', summary: Summary }
  | { type: 'deleteSummary', id: string, summary: Summary }
  | { type: 'setSummary', id: string, summary: Summary, prev: Summary }
  | { type: 'setAttachments', attachments: AttachmentInfo[], prev: AttachmentInfo[] }

/** Build an op with the payload filled in and the type tag in place. */
export function makeOp<T extends OpShape>(type: T['type'], payload: Omit<T, 'type'>): Op {
  return { type, ...payload }
}

/** Style field that holds the attachment id for a given image slot. */
function slotKey(slot: ImageSlot): 'image' | 'imageBottom' | 'imageLeft' | 'imageRight' {
  return slot === 'top' ? 'image' : slot === 'bottom' ? 'imageBottom' : slot === 'left' ? 'imageLeft' : 'imageRight'
}

/**
 * Every attachment id a node references — the four edge slots AND the cells
 * of a gallery topic (T25).
 *
 * The single answer to "what does a node reference". The asset garbage
 * collector's root set derives from it — `collectSheetAssetIds`
 * (src/helpers/assets.ts) calls this per node — so an id missing here is an
 * id no node claims, and the GC deletes the bytes. A slot added to `Style`
 * must be added here, or the sweep silently deletes live images long after
 * the edit that caused it. The gallery half is not optional politeness for
 * exactly that reason.
 */
export function nodeImageIds(n: MindNode): string[] {
  const out: string[] = []
  for (const slot of ['top', 'bottom', 'left', 'right'] as const) {
    const id = n.style[slotKey(slot)]
    if (id) {
      out.push(id)
    }
  }
  for (const item of n.style.gallery?.items ?? []) {
    if (item.id) {
      out.push(item.id)
    }
  }
  return out
}

export function cloneNode(n: MindNode): MindNode {
  return {
    ...n,
    childrenIds: [...n.childrenIds],
    // style is spread, not deep-cloned, EXCEPT the gallery: its cells are
    // plain objects (and S4 will edit them), so a clone must not share the
    // live array. A deleted subtree held for undo that aliases the sheet's
    // gallery would corrupt the sheet the day galleries become editable.
    style: {
      ...n.style,
      ...(n.style.gallery
        ? { gallery: { ...n.style.gallery, items: n.style.gallery.items.map(item => ({ ...item })) } }
        : {}),
    },
    labels: [...n.labels],
    markers: [...n.markers],
    task: n.task ? { ...n.task } : null,
    metadata: { ...n.metadata },
    position: { ...n.position },
    titleRuns: n.titleRuns ? n.titleRuns.map(r => ({ ...r })) : undefined,
  }
}

// r-node imported nowIso from src/core/doc.ts; Lane A owns no other file, so
// the helper lives here.
function nowIso(): string {
  return new Date().toISOString()
}

function clampIndex(i: number, len: number): number {
  return Math.max(0, Math.min(i, len))
}

// ---------------------------------------------------------------------------
// applyOp
// ---------------------------------------------------------------------------

function applyOp(sheet: Sheet, op: OpShape): void {
  const nodes = sheet.nodes
  switch (op.type) {
    // Copy-on-write discipline: ops run on a draft whose node objects are
    // SHARED with the previously published sheet (draftOf in store.ts), so a
    // node is cloned before it is mutated in place and the clone replaces the
    // original. The published sheet is never touched.
    case 'createNode': {
      const parent = op.parentId ? nodes[op.parentId] : undefined
      const node: MindNode = {
        id: op.id,
        type: op.nodeType,
        parentId: op.parentId,
        childrenIds: [],
        title: op.title,
        titleRuns: op.titleRuns ? op.titleRuns.map(r => ({ ...r })) : undefined,
        position: op.position ?? { x: 0, y: 0, manual: false },
        style: op.style ?? {},
        collapsed: false,
        labels: [],
        markers: [],
        notes: '',
        task: op.task ?? null,
        metadata: { createdAt: nowIso(), updatedAt: nowIso() },
      }
      nodes[op.id] = node
      if (parent) {
        const p = cloneNode(parent)
        p.childrenIds.splice(clampIndex(op.index, p.childrenIds.length), 0, op.id)
        nodes[op.parentId] = p
      }
      break
    }
    case 'restoreNode': {
      for (const n of op.subtree) {
        nodes[n.id] = cloneNode(n)
      }
      if (op.parentId) {
        const parent = nodes[op.parentId]
        if (parent) {
          const p = cloneNode(parent)
          p.childrenIds.splice(clampIndex(op.index, p.childrenIds.length), 0, op.id)
          nodes[op.parentId] = p
        }
      }
      for (const rel of op.removedRelationships) {
        sheet.relationships.push(rel)
      }
      break
    }
    case 'deleteNode': {
      for (const n of op.subtree) {
        delete nodes[n.id]
      }
      if (op.parentId) {
        const parent = nodes[op.parentId]
        if (parent) {
          const p = cloneNode(parent)
          const idx = p.childrenIds.indexOf(op.id)
          if (idx >= 0) {
            p.childrenIds.splice(idx, 1)
          }
          nodes[op.parentId] = p
        }
      }
      sheet.relationships = sheet.relationships.filter(r => !op.removedRelationships.some(rr => rr.id === r.id))
      break
    }
    case 'setTitle': {
      const node = cloneNode(nodes[op.id])
      node.title = op.title
      // Title and runs are kept in sync on every mutation (see MindNode.title
      // in types.ts): a plain rename must clear any stale styled runs, or the
      // next styled edit would carry yesterday's segments forward.
      if (op.titleRuns) {
        node.titleRuns = op.titleRuns.map(r => ({ ...r }))
      }
      else {
        delete node.titleRuns
      }
      nodes[op.id] = node
      break
    }
    case 'setStyle': {
      const node = cloneNode(nodes[op.id])
      node.style = { ...op.style }
      nodes[op.id] = node
      break
    }
    case 'setNodeImage': {
      const node = nodes[op.nodeId]
      if (!node) {
        break
      }
      // The op carries ONLY the id — never image bytes. The position defaults
      // to 'top' so ops written before the side slots existed (and saved
      // documents containing them) still apply.
      const slot = op.position ?? 'top'
      const key = slotKey(slot)
      const style = { ...node.style }
      if (op.imageId) {
        style[key] = op.imageId
      }
      else {
        delete style[key]
      }
      const next = cloneNode(node)
      next.style = style
      nodes[op.nodeId] = next
      break
    }
    case 'setPosition': {
      const node = cloneNode(nodes[op.id])
      node.position = { x: op.x, y: op.y, manual: op.manual, offsetX: op.offsetX, offsetY: op.offsetY }
      nodes[op.id] = node
      break
    }
    case 'setCollapsed': {
      const node = cloneNode(nodes[op.id])
      node.collapsed = op.collapsed
      nodes[op.id] = node
      break
    }
    case 'moveNode': {
      // fromIndex/toIndex are FINAL indices: toIndex is the position the node
      // will occupy in the destination array after removal. Producers compute
      // them by simulating removal first, so applyOp needs no adjustment.
      const moved = nodes[op.id]
      if (!moved) {
        break
      }
      if (op.fromParentId && nodes[op.fromParentId]) {
        const from = nodes[op.fromParentId]
        const idx = from.childrenIds.indexOf(op.id)
        if (idx < 0) {
          break
        }
        const nextFrom = cloneNode(from)
        nextFrom.childrenIds.splice(idx, 1)
        nodes[op.fromParentId] = nextFrom
      }
      else if (moved.parentId !== null) {
        break
      }
      if (op.toParentId && nodes[op.toParentId]) {
        // Reads the map AFTER the removal above, so a same-parent move
        // splices into the already-updated clone.
        const to = cloneNode(nodes[op.toParentId])
        to.childrenIds.splice(clampIndex(op.toIndex, to.childrenIds.length), 0, op.id)
        nodes[op.toParentId] = to
      }
      const nextMoved = cloneNode(moved)
      nextMoved.parentId = op.toParentId
      nodes[op.id] = nextMoved
      break
    }
    case 'sortSiblings': {
      const parent = nodes[op.parentId]
      if (!parent) {
        break
      }
      const next = cloneNode(parent)
      next.childrenIds = [...op.order]
      nodes[op.parentId] = next
      break
    }
    case 'setTask': {
      const node = cloneNode(nodes[op.id])
      node.task = op.task ? { ...op.task } : null
      nodes[op.id] = node
      break
    }
    case 'setNotes': {
      const node = cloneNode(nodes[op.id])
      node.notes = op.notes
      nodes[op.id] = node
      break
    }
    case 'setSheetTitle':
      sheet.title = op.title
      break
    case 'setStructure':
      sheet.structure = { ...op.config }
      break
    case 'createRelationship':
      sheet.relationships.push({ ...op.relationship })
      break
    case 'deleteRelationship':
      sheet.relationships = sheet.relationships.filter(r => r.id !== op.id)
      break
    case 'setRelationship': {
      const idx = sheet.relationships.findIndex(r => r.id === op.id)
      if (idx >= 0) {
        sheet.relationships[idx] = { ...op.relationship }
      }
      break
    }
    case 'createGroup':
      sheet.boundaries.push({ ...op.group, memberIds: [...op.group.memberIds] })
      break
    case 'deleteGroup':
      sheet.boundaries = sheet.boundaries.filter(g => g.id !== op.id)
      break
    case 'setGroup': {
      const idx = sheet.boundaries.findIndex(g => g.id === op.id)
      if (idx >= 0) {
        sheet.boundaries[idx] = { ...op.group, memberIds: [...op.group.memberIds] }
      }
      break
    }
    case 'createSummary':
      sheet.summaries.push({ ...op.summary, memberIds: [...op.summary.memberIds] })
      break
    case 'deleteSummary':
      sheet.summaries = sheet.summaries.filter(s => s.id !== op.id)
      break
    case 'setSummary': {
      const idx = sheet.summaries.findIndex(s => s.id === op.id)
      if (idx >= 0) {
        sheet.summaries[idx] = { ...op.summary, memberIds: [...op.summary.memberIds] }
      }
      break
    }
    case 'setAttachments':
      // Whole-list replacement: the ONLY writer of this op is the orphan GC,
      // which removes the unreferenced cards in one undoable step. The op
      // carries the full previous list (`prev`), so undo restores the cards
      // exactly — the images they point to, however, are gone (the blob
      // deletion is not undoable); the GC confirmation says so explicitly.
      sheet.attachments = op.attachments.map(a => ({ ...a }))
      break
  }
}

// ---------------------------------------------------------------------------
// inverseOf — self-contained reversals used by undo
// ---------------------------------------------------------------------------

function inverseOf(op: OpShape): Op[] {
  switch (op.type) {
    case 'createNode':
      // Unreachable from applyWithInverse (which captures the created node
      // itself), but kept so inverseOf is total over the op set.
      return [makeOp('deleteNode', { id: op.id, parentId: op.parentId, index: op.index, subtree: [], removedRelationships: [] })]
    case 'deleteNode':
      return [makeOp('restoreNode', { id: op.id, parentId: op.parentId, index: op.index, subtree: op.subtree, removedRelationships: op.removedRelationships })]
    case 'restoreNode':
      return [makeOp('deleteNode', { id: op.id, parentId: op.parentId, index: op.index, subtree: op.subtree, removedRelationships: op.removedRelationships })]
    case 'setTitle':
      return [makeOp('setTitle', { id: op.id, title: op.prev, prev: op.title, titleRuns: op.prevRuns, prevRuns: op.titleRuns })]
    case 'setStyle':
      return [makeOp('setStyle', { id: op.id, style: op.prev, prev: op.style })]
    case 'setNodeImage':
      return [makeOp('setNodeImage', { nodeId: op.nodeId, imageId: op.prevImageId, prevImageId: op.imageId, position: op.position })]
    case 'setPosition':
      return [makeOp('setPosition', {
        id: op.id,
        x: op.prev.x,
        y: op.prev.y,
        manual: op.prev.manual,
        offsetX: op.prev.offsetX,
        offsetY: op.prev.offsetY,
        prev: { x: op.x, y: op.y, manual: op.manual, offsetX: op.offsetX, offsetY: op.offsetY },
      })]
    case 'setCollapsed':
      return [makeOp('setCollapsed', { id: op.id, collapsed: op.prev, prev: op.collapsed })]
    case 'moveNode':
      return [makeOp('moveNode', { id: op.id, fromParentId: op.toParentId, fromIndex: op.toIndex, toParentId: op.fromParentId, toIndex: op.fromIndex })]
    case 'sortSiblings':
      return [makeOp('sortSiblings', { parentId: op.parentId, order: op.prevOrder, prevOrder: op.order })]
    case 'setTask':
      return [makeOp('setTask', { id: op.id, task: op.prev, prev: op.task })]
    case 'setNotes':
      return [makeOp('setNotes', { id: op.id, notes: op.prev, prev: op.notes })]
    case 'setSheetTitle':
      return [makeOp('setSheetTitle', { title: op.prev, prev: op.title })]
    case 'setStructure':
      return [makeOp('setStructure', { config: op.prev, prev: op.config })]
    case 'createRelationship':
      return [makeOp('deleteRelationship', { id: op.relationship.id, relationship: op.relationship })]
    case 'deleteRelationship':
      return [makeOp('createRelationship', { relationship: op.relationship })]
    case 'setRelationship':
      return [makeOp('setRelationship', { id: op.id, relationship: op.prev, prev: op.relationship })]
    case 'createGroup':
      return [makeOp('deleteGroup', { id: op.group.id, group: op.group })]
    case 'deleteGroup':
      return [makeOp('createGroup', { group: op.group })]
    case 'setGroup':
      return [makeOp('setGroup', { id: op.id, group: op.prev, prev: op.group })]
    case 'createSummary':
      return [makeOp('deleteSummary', { id: op.summary.id, summary: op.summary })]
    case 'deleteSummary':
      return [makeOp('createSummary', { summary: op.summary })]
    case 'setSummary':
      return [makeOp('setSummary', { id: op.id, summary: op.prev, prev: op.summary })]
    case 'setAttachments':
      return [makeOp('setAttachments', { attachments: op.prev, prev: op.attachments })]
  }
}

/**
 * Apply an op and return the ops that undo it (for the history stack).
 * createNode's inverse needs the actual node after creation, so it is captured
 * here with sheet access; every other op is self-contained.
 */
export function applyWithInverse(sheet: Sheet, op: Op): Op[] {
  const o = op as OpShape
  applyOp(sheet, o)
  // The one inverse that is NOT self-contained: it must capture the node as it
  // exists AFTER creation, because later ops may have hung children off it,
  // and undoing the creation then has to remove the whole subtree. A
  // deleteNode with an empty subtree would leave an orphan.
  if (o.type === 'createNode') {
    const node = sheet.nodes[o.id]
    return [makeOp('deleteNode', {
      id: o.id,
      parentId: o.parentId,
      index: o.index,
      subtree: node ? [cloneNode(node)] : [],
      removedRelationships: [],
    })]
  }
  return inverseOf(o)
}
