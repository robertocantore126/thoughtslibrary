import type { ClipboardPayload } from './clipboard'
import type { NodeSize } from './layout'
import type { Op } from './ops'
import type { MindNode, Sheet } from './types'
/**
 * The editing commands (MINDMAP_S4_AGENT_BRIEF §C.5).
 *
 * Every one of them is a pure op builder that ends in a single
 * `store.commit(...)` — the seam §0.2 documents. That is what keeps a whole
 * gesture to ONE undo entry (§T.2) and what lets this module exist at all
 * without a line changing in `store.ts`.
 *
 * Nothing here invents an op type: `ops.ts` already ships 24 with their
 * inverses, and a subtree insertion is `restoreNode` whether the subtree was
 * just deleted, just duplicated or just pasted.
 */
import { remapIds, serialiseSubtrees, topLevelIds } from './clipboard'
import { cloneNode, makeOp } from './ops'

/**
 * The slice of the mindmap store a command needs. Structural rather than the
 * store's own type so a command is testable against anything that satisfies
 * it — and so this module never has to name a type `store.ts` does not export.
 */
export interface CommandStore {
  sheet: Sheet | null
  commit: (ops: Op[]) => void
}

/**
 * A node and everything under it, pre-order, root first.
 *
 * Walks `childrenIds`, not the `parentId` chain, because that is the direction
 * `layoutSheet` walks: a cycle that hangs layout is a cycle in the children
 * links. The `seen` guard means a damaged sheet loaded before validation
 * existed still terminates here.
 */
export function subtreeIds(sheet: Sheet, rootId: string): Set<string> {
  const seen = new Set<string>()
  const walk = (id: string) => {
    if (seen.has(id) || !sheet.nodes[id]) {
      return
    }
    seen.add(id)
    for (const childId of sheet.nodes[id].childrenIds) {
      walk(childId)
    }
  }
  walk(rootId)
  return seen
}

function collectSubtree(sheet: Sheet, rootId: string): MindNode[] {
  return [...subtreeIds(sheet, rootId)].map(id => cloneNode(sheet.nodes[id]))
}

/** The same walk over a clipboard payload, which is a tree without a sheet. */
function collectPayloadSubtree(payload: ClipboardPayload, rootId: string): MindNode[] {
  const byId = new Map(payload.nodes.map(node => [node.id, node]))
  const out: MindNode[] = []
  const seen = new Set<string>()
  const walk = (id: string) => {
    const node = byId.get(id)
    if (!node || seen.has(id)) {
      return
    }
    seen.add(id)
    out.push(node)
    for (const childId of node.childrenIds) {
      walk(childId)
    }
  }
  walk(rootId)
  return out
}

/**
 * Builds the `moveNode` ops for reparenting `ids` under `toParentId`.
 *
 * `index` names a slot in the destination's children AS THEY STAND NOW, which
 * is what a drop indicator between two topics naturally produces. The op's own
 * `toIndex` is a FINAL index (see ops.ts), so the movers already sitting
 * before that slot are subtracted here rather than at every call site.
 *
 * Returns an empty list — and therefore commits nothing — when the move is a
 * no-op or would build a cycle. A cycle is not a cosmetic problem: it sends
 * `layoutSheet`'s recursive walk into a stack overflow and the map never
 * renders again (§C.3).
 */
function buildMoveOps(sheet: Sheet, ids: string[], toParentId: string, index: number): Op[] {
  if (!sheet.nodes[toParentId]) {
    return []
  }
  const movers = topLevelIds(sheet, ids).filter(id => id !== sheet.rootNodeId)
  if (movers.length === 0) {
    return []
  }
  for (const id of movers) {
    if (subtreeIds(sheet, id).has(toParentId)) {
      return []
    }
  }

  // A scratch copy of only the child lists this batch touches, so each mover's
  // indices are computed against the tree as the previous movers left it.
  const kids: Record<string, string[]> = {}
  const childrenOf = (parentId: string): string[] => {
    if (!kids[parentId]) {
      kids[parentId] = [...(sheet.nodes[parentId]?.childrenIds ?? [])]
    }
    return kids[parentId]
  }
  const moved: Record<string, string> = {}
  const parentOf = (id: string): string | null => moved[id] ?? sheet.nodes[id].parentId

  const before = [...childrenOf(toParentId)]
  const base = Math.max(0, Math.min(index, before.length))
  const vacating = movers.filter((id) => {
    const at = before.indexOf(id)
    return at >= 0 && at < base
  }).length

  const ops: Op[] = []
  let unchanged = true
  movers.forEach((id, offset) => {
    const fromParentId = parentOf(id)
    const source = fromParentId === null ? [] : childrenOf(fromParentId)
    const fromIndex = source.indexOf(id)
    if (fromIndex >= 0) {
      source.splice(fromIndex, 1)
    }
    const destination = childrenOf(toParentId)
    const toIndex = Math.max(0, Math.min(base - vacating + offset, destination.length))
    destination.splice(toIndex, 0, id)
    moved[id] = toParentId
    if (fromParentId !== toParentId || fromIndex !== toIndex) {
      unchanged = false
    }
    ops.push(makeOp('moveNode', { id, fromParentId, fromIndex, toParentId, toIndex }))
  })

  // A drag that lands where it started must not leave an undo entry behind.
  return unchanged ? [] : ops
}

/** Reparents one node. See `buildMoveOps` for what `index` means. */
export function moveNode(store: CommandStore, id: string, toParentId: string, index: number): void {
  moveNodes(store, [id], toParentId, index)
}

/**
 * Reparents several nodes as ONE undo entry — a drag with a multi-selection.
 * Ids already inside another moved node's subtree are dropped: moving a parent
 * already carries its children.
 */
export function moveNodes(store: CommandStore, ids: string[], toParentId: string, index: number): void {
  const sheet = store.sheet
  if (!sheet) {
    return
  }
  const ops = buildMoveOps(sheet, ids, toParentId, index)
  if (ops.length > 0) {
    store.commit(ops)
  }
}

/**
 * Copies the subtree with fresh ids and inserts it after the original.
 *
 * ONE `restoreNode` op, not a createNode per node: `createNode` builds a topic
 * from a title and a style and would silently drop the notes, labels, markers
 * and collapsed state of everything it copied, and a batch of them makes an
 * inverse per node where one delete would do.
 *
 * Relationships are deliberately not duplicated — a copy of a topic is not a
 * second party to the original's connections.
 */
export function duplicateNode(store: CommandStore, id: string): string | null {
  const sheet = store.sheet
  const node = sheet?.nodes[id]
  if (!sheet || !node || node.parentId === null) {
    return null
  }
  const parent = sheet.nodes[node.parentId]
  if (!parent) {
    return null
  }
  const copy = remapIds(serialiseSubtrees(sheet, [id]))
  const newRootId = copy.roots[0]
  if (!newRootId) {
    return null
  }
  const subtree = collectPayloadSubtree(copy, newRootId)
  subtree[0].parentId = node.parentId
  store.commit([makeOp('restoreNode', {
    id: newRootId,
    parentId: node.parentId,
    index: parent.childrenIds.indexOf(id) + 1,
    subtree,
    removedRelationships: [],
  })])
  return newRootId
}

/**
 * Inserts a new topic between `id` and its parent, taking `id` as its only
 * child. Refuses the root, which has no parent to insert between.
 */
export function createParent(store: CommandStore, id: string): string | null {
  const sheet = store.sheet
  const node = sheet?.nodes[id]
  if (!sheet || !node || node.parentId === null) {
    return null
  }
  const parent = sheet.nodes[node.parentId]
  if (!parent) {
    return null
  }
  const newId = crypto.randomUUID()
  const index = parent.childrenIds.indexOf(id)
  store.commit([
    makeOp('createNode', {
      id: newId,
      nodeType: node.parentId === sheet.rootNodeId ? 'main' : 'subtopic',
      parentId: node.parentId,
      index,
      title: 'New topic',
    }),
    makeOp('moveNode', {
      id,
      fromParentId: node.parentId,
      // The createNode above pushed `id` one slot along; the inverse of this
      // move has to put it back where it will actually be sitting.
      fromIndex: index + 1,
      toParentId: newId,
      toIndex: 0,
    }),
  ])
  return newId
}

/** Expands `id` and every collapsed node beneath it, as one undo entry. */
export function expandAll(store: CommandStore, id: string): void {
  const sheet = store.sheet
  if (!sheet || !sheet.nodes[id]) {
    return
  }
  const ops: Op[] = []
  for (const nodeId of subtreeIds(sheet, id)) {
    if (sheet.nodes[nodeId].collapsed) {
      ops.push(makeOp('setCollapsed', { id: nodeId, collapsed: false, prev: true }))
    }
  }
  if (ops.length > 0) {
    store.commit(ops)
  }
}

/**
 * Deletes a set of nodes as one undo entry.
 *
 * Two orderings matter here, and both are invisible until undo runs:
 *
 *  - Any id already inside another selected node's subtree is dropped, or the
 *    batch emits two overlapping subtree snapshots of the same nodes.
 *  - Siblings are deleted in DESCENDING index order. Undo replays a batch's
 *    inverses in reverse (history.ts), so descending deletes restore in
 *    ascending order and each `restoreNode` splices back at an index that
 *    still means what it meant — restore them the other way round and the
 *    siblings come back permuted.
 *
 * A relationship spanning two deleted subtrees is claimed by exactly one op,
 * or undo would push it back twice.
 */
export function removeMany(store: CommandStore, ids: string[]): void {
  const sheet = store.sheet
  if (!sheet) {
    return
  }
  const indexOf = (id: string): number => {
    const parentId = sheet.nodes[id]?.parentId
    return parentId ? sheet.nodes[parentId]?.childrenIds.indexOf(id) ?? 0 : 0
  }
  const targets = topLevelIds(sheet, ids)
    .filter(id => id !== sheet.rootNodeId)
    .sort((a, b) => indexOf(b) - indexOf(a))
  if (targets.length === 0) {
    return
  }
  const claimed = new Set<string>()
  const ops: Op[] = []
  for (const id of targets) {
    const node = sheet.nodes[id]
    const subtree = collectSubtree(sheet, id)
    const removed = new Set(subtree.map(n => n.id))
    const relationships = sheet.relationships.filter(
      r => (removed.has(r.fromId) || removed.has(r.toId)) && !claimed.has(r.id),
    )
    for (const relationship of relationships) {
      claimed.add(relationship.id)
    }
    ops.push(makeOp('deleteNode', {
      id,
      parentId: node.parentId,
      index: indexOf(id),
      subtree,
      removedRelationships: relationships,
    }))
  }
  store.commit(ops)
}

/**
 * Pastes a payload's subtrees as children of `intoParentId` and returns their
 * new root ids.
 *
 * `remapIds` is not optional. Pasting a payload with its original ids back
 * into the sheet it came from overwrites those nodes and corrupts
 * `childrenIds` on both sides, and it does it silently because the map still
 * draws something. It also happens to be what makes "paste into a node you
 * copied" safe: after the remap the destination cannot be inside the payload.
 */
export function pasteSubtrees(store: CommandStore, payload: ClipboardPayload, intoParentId: string): string[] {
  const sheet = store.sheet
  const parent = sheet?.nodes[intoParentId]
  if (!sheet || !parent) {
    return []
  }
  const fresh = remapIds(payload)
  const ops: Op[] = []
  const created: string[] = []
  let index = parent.childrenIds.length
  for (const rootId of fresh.roots) {
    const subtree = collectPayloadSubtree(fresh, rootId)
    if (subtree.length === 0) {
      continue
    }
    subtree[0].parentId = intoParentId
    // A direct child of the central topic is a 'main' topic; every rank below
    // it keeps whatever type it was copied with.
    subtree[0].type = intoParentId === sheet.rootNodeId ? 'main' : 'subtopic'
    ops.push(makeOp('restoreNode', {
      id: rootId,
      parentId: intoParentId,
      index,
      subtree,
      removedRelationships: [],
    }))
    created.push(rootId)
    index += 1
  }
  if (ops.length === 0) {
    return []
  }
  store.commit(ops)
  return created
}

/** The four geometric directions arrow navigation can ask for. */
export type NavDirection = 'up' | 'down' | 'left' | 'right'

/**
 * The next node to move to from `fromId`, by geometry rather than by tree
 * walk (S4 §C.2).
 *
 * A pure parent/child/sibling walk feels wrong the moment the map has two
 * sides: a branch on the far side of the central topic is never "up" in tree
 * terms, but it is what the eye wants when the user presses the arrow.
 *
 * Candidates are the nodes whose CENTRE lies in the half-plane the direction
 * names, and the winner is the one with the smallest
 * `perp² × 3 + parallel²` score — the perpendicular (off-axis) distance is
 * weighted more heavily, so a node slightly out of line but much closer
 * loses to one the arrow points at. Returns null when nothing is in that
 * half-plane or when `fromId` is not in the sheet.
 */
export function navigateTo(
  sheet: Sheet,
  sizes: Record<string, NodeSize>,
  fromId: string,
  direction: NavDirection,
): string | null {
  const from = sheet.nodes[fromId]
  const fromSize = sizes[fromId]
  if (!from || !fromSize) {
    return null
  }
  const fromCx = from.position.x + fromSize.w / 2
  const fromCy = from.position.y + fromSize.h / 2
  const horizontal = direction === 'left' || direction === 'right'
  const sign = direction === 'right' || direction === 'down' ? 1 : -1

  let best: string | null = null
  let bestScore = Infinity
  for (const node of Object.values(sheet.nodes)) {
    if (node.id === fromId) {
      continue
    }
    const size = sizes[node.id]
    if (!size) {
      continue
    }
    const cx = node.position.x + size.w / 2
    const cy = node.position.y + size.h / 2
    const along = horizontal ? cx - fromCx : cy - fromCy
    // "In the half-plane" means strictly in the direction pressed; a node
    // exactly level with the current one is not a candidate for up/down.
    if (sign * along <= 0) {
      continue
    }
    const perpendicular = horizontal ? Math.abs(cy - fromCy) : Math.abs(cx - fromCx)
    const parallel = Math.abs(along)
    // Perpendicular distance dominates the score (squared, times four) while
    // parallel distance counts once: a topic 5px to the side but 400px ahead
    // must not beat one that is 600px ahead in a straight line.
    const score = perpendicular * perpendicular * 4 + parallel
    if (score < bestScore) {
      bestScore = score
      best = node.id
    }
  }
  return best
}

/** The three ways a drop can land relative to the target topic's box. */
export type DropZone = 'before' | 'child' | 'after'

export interface DropPlacement {
  parentId: string
  /** A slot in the parent's CURRENT childrenIds — what `buildMoveOps` expects. */
  index: number
}

/**
 * Where a drag over `targetId`'s box lands, from which third of the box the
 * pointer is in (S4 §C.3): top third is a sibling before it, bottom third a
 * sibling after it, the middle a child of it.
 *
 * The index is computed in the CURRENT childrenIds of the destination, and
 * `buildMoveOps` subtracts the movers that vacate a slot before it — so a
 * reorder within one parent works without this function knowing the movers
 * beyond their ids. Null when the placement is impossible: the target is one
 * of the dragged nodes, or the zone is before/after the root, which has no
 * sibling slot.
 */
export function dropPlacement(
  sheet: Sheet,
  draggedIds: Iterable<string>,
  targetId: string,
  zone: DropZone,
): DropPlacement | null {
  const target = sheet.nodes[targetId]
  if (!target) {
    return null
  }
  const dragged = new Set(draggedIds)
  if (dragged.has(targetId)) {
    return null
  }
  if (zone === 'child') {
    return { parentId: targetId, index: target.childrenIds.length }
  }
  if (target.parentId === null) {
    return null
  }
  const parent = sheet.nodes[target.parentId]
  if (!parent) {
    return null
  }
  const at = parent.childrenIds.indexOf(targetId)
  if (at < 0) {
    return null
  }
  return { parentId: target.parentId, index: zone === 'after' ? at + 1 : at }
}
