import type { MindNode, Sheet } from '../src/mindmap/types'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serialiseSubtrees } from '../src/mindmap/clipboard'
import {
  createParent,
  dropPlacement,
  duplicateNode,
  expandAll,
  moveNode,
  moveNodes,
  navigateTo,
  pasteSubtrees,
  removeMany,
} from '../src/mindmap/commands'
import { layoutSheet } from '../src/mindmap/layout'
import { blankSheet, readSheet, repairSheet, writeSheet } from '../src/mindmap/storage'
import { useMindmapStore } from '../src/mindmap/store'
import { SCHEMA_VERSION } from '../src/mindmap/types'
// Nothing here is mocked: the commands run against the real store, the real
// ops layer and a real (fake-backed) IndexedDB. A hand-written store double
// would agree with whatever this lane misunderstood about `commit`, which is
// the one thing these tests exist to check.
import 'fake-indexeddb/auto'

type Store = ReturnType<typeof useMindmapStore>

let store: Store
let root: string
let a: string
let a1: string
let a2: string
let b: string

function node(id: string, parentId: string | null, childrenIds: string[]): MindNode {
  return {
    id,
    type: 'subtopic',
    parentId,
    childrenIds,
    title: id,
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: '',
    task: null,
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
}

/** Every node the root can actually reach through childrenIds. */
function reachable(sheet: Sheet): Set<string> {
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
  walk(sheet.rootNodeId)
  return seen
}

/**
 * The tree every test starts from, built through the real editing actions:
 *
 *   root
 *   ├── A
 *   │   ├── A1
 *   │   └── A2
 *   └── B
 */
beforeEach(async () => {
  setActivePinia(createPinia())
  store = useMindmapStore()
  await store.open(null)
  root = store.sheet.rootNodeId
  a = store.createChild(root)
  store.rename(a, 'A')
  a1 = store.createChild(a)
  store.rename(a1, 'A1')
  a2 = store.createChild(a)
  store.rename(a2, 'A2')
  b = store.createChild(root)
  store.rename(b, 'B')
})

// Every commit arms the autosave debounce; close() flushes it, so no timer
// outlives the test that started it.
afterEach(async () => {
  await store.close()
})

interface Snapshot {
  parent: string | null
  children: string[]
  title: string
  collapsed: boolean
}

/**
 * Everything undo has to restore, in a form a snapshot comparison can see.
 * `collapsed` is in here because expandAll changes nothing else — a helper
 * that only reads the shape of the tree would pass that command blind.
 */
function topology(sheet: Sheet): Record<string, Snapshot> {
  const out: Record<string, Snapshot> = {}
  for (const node of Object.values(sheet.nodes)) {
    out[node.id] = {
      parent: node.parentId,
      children: [...node.childrenIds],
      title: node.title,
      collapsed: node.collapsed,
    }
  }
  return out
}

/**
 * Runs `act`, then asserts a SINGLE undo puts the sheet back exactly as it
 * was — the only honest test of "one gesture, one undo entry" (§T.2). Counting
 * commits alone would pass a command that committed once per node.
 */
function expectOneUndoEntry(act: () => void) {
  const before = topology(store.sheet)
  const commit = vi.spyOn(store, 'commit')
  act()
  expect(commit).toHaveBeenCalledTimes(1)
  commit.mockRestore()
  expect(topology(store.sheet)).not.toEqual(before)
  expect(store.undo()).toBe(true)
  expect(topology(store.sheet)).toEqual(before)
}

describe('moveNode', () => {
  it('reparents a node and undoes in one step', () => {
    expectOneUndoEntry(() => moveNode(store, a1, b, 0))
    // Re-run it now that undo has restored the tree, to check where it landed.
    moveNode(store, a1, b, 0)
    expect(store.sheet.nodes[a1].parentId).toBe(b)
    expect(store.sheet.nodes[b].childrenIds).toEqual([a1])
    expect(store.sheet.nodes[a].childrenIds).toEqual([a2])
  })

  // A cycle is not cosmetic: layoutSheet recurses through childrenIds, so a
  // node parented to its own child hangs the map for the rest of the session.
  it('refuses to drop a node onto its own descendant', () => {
    const before = topology(store.sheet)
    const commit = vi.spyOn(store, 'commit')
    moveNode(store, a, a1, 0)
    expect(commit).not.toHaveBeenCalled()
    expect(topology(store.sheet)).toEqual(before)
    commit.mockRestore()
  })

  it('refuses to drop a node onto itself', () => {
    const commit = vi.spyOn(store, 'commit')
    moveNode(store, a, a, 0)
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })

  it('refuses to move the root', () => {
    const commit = vi.spyOn(store, 'commit')
    moveNode(store, root, a, 0)
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })

  it('commits nothing when the node lands where it already was', () => {
    const commit = vi.spyOn(store, 'commit')
    moveNode(store, a1, a, 0)
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })

  // `index` names a slot in the destination as it stands now; within one
  // parent the node vacates a slot before it re-enters, and the op needs the
  // final index rather than that one.
  it('reorders within a parent using the pre-move slot number', () => {
    moveNode(store, a1, a, 2)
    expect(store.sheet.nodes[a].childrenIds).toEqual([a2, a1])
    store.undo()
    expect(store.sheet.nodes[a].childrenIds).toEqual([a1, a2])
  })

  it('inserts at the requested slot in a new parent', () => {
    moveNode(store, b, a, 1)
    expect(store.sheet.nodes[a].childrenIds).toEqual([a1, b, a2])
  })
})

describe('moveNodes', () => {
  it('moves a multi-selection as one undo entry, in order', () => {
    expectOneUndoEntry(() => moveNodes(store, [a1, a2], b, 0))
    moveNodes(store, [a1, a2], b, 0)
    expect(store.sheet.nodes[b].childrenIds).toEqual([a1, a2])
    expect(store.sheet.nodes[a].childrenIds).toEqual([])
  })

  // Moving A already carries A1; listing both would move A1 twice.
  it('drops ids already inside another moved subtree', () => {
    moveNodes(store, [a, a1], b, 0)
    expect(store.sheet.nodes[b].childrenIds).toEqual([a])
    expect(store.sheet.nodes[a].childrenIds).toEqual([a1, a2])
  })

  it('refuses the whole batch when any mover would swallow the destination', () => {
    const commit = vi.spyOn(store, 'commit')
    moveNodes(store, [b, a], a2, 0)
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })
})

describe('duplicateNode', () => {
  it('copies the subtree with entirely fresh ids, next to the original', () => {
    const originals = new Set(Object.keys(store.sheet.nodes))
    let copyId: string | null = null
    expectOneUndoEntry(() => {
      copyId = duplicateNode(store, a)
    })
    copyId = duplicateNode(store, a)

    expect(copyId).toBeTruthy()
    expect(originals.has(copyId)).toBe(false)
    const copy = store.sheet.nodes[copyId]
    expect(copy.title).toBe('A')
    expect(copy.parentId).toBe(root)
    expect(store.sheet.nodes[root].childrenIds).toEqual([a, copyId, b])
    expect(copy.childrenIds).toHaveLength(2)
    for (const childId of copy.childrenIds) {
      expect(originals.has(childId)).toBe(false)
      expect(store.sheet.nodes[childId].parentId).toBe(copyId)
    }
    expect(store.sheet.nodes[copy.childrenIds[0]].title).toBe('A1')
    expect(store.sheet.nodes[copy.childrenIds[1]].title).toBe('A2')
    // The original is untouched.
    expect(store.sheet.nodes[a].childrenIds).toEqual([a1, a2])
  })

  // createNode carries only a title and a style, so a duplicate built from it
  // would quietly lose everything else the topic held.
  it('carries the fields a createNode-based copy would drop', () => {
    store.setNodeStyle(a1, { fill: '#123456' })
    store.toggleCollapse(a1)
    const copyId = duplicateNode(store, a)
    const copied = store.sheet.nodes[store.sheet.nodes[copyId].childrenIds[0]]
    expect(copied.style.fill).toBe('#123456')
    expect(copied.collapsed).toBe(true)
  })

  it('refuses the root, which has no sibling slot to go in', () => {
    expect(duplicateNode(store, root)).toBeNull()
  })
})

describe('createParent', () => {
  it('inserts a topic between the target and its parent, in one undo entry', () => {
    let newId: string | null = null
    expectOneUndoEntry(() => {
      newId = createParent(store, a1)
    })
    newId = createParent(store, a1)

    expect(store.sheet.nodes[newId].parentId).toBe(a)
    expect(store.sheet.nodes[newId].childrenIds).toEqual([a1])
    expect(store.sheet.nodes[a1].parentId).toBe(newId)
    // It takes the target's old slot, so the sibling order is preserved.
    expect(store.sheet.nodes[a].childrenIds).toEqual([newId, a2])
  })

  it('refuses the root', () => {
    const commit = vi.spyOn(store, 'commit')
    expect(createParent(store, root)).toBeNull()
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })
})

describe('expandAll', () => {
  it('expands every collapsed descendant as one undo entry', () => {
    store.toggleCollapse(a)
    store.toggleCollapse(a1)
    expectOneUndoEntry(() => expandAll(store, a))
    expandAll(store, a)
    expect(store.sheet.nodes[a].collapsed).toBe(false)
    expect(store.sheet.nodes[a1].collapsed).toBe(false)
  })

  it('commits nothing when the subtree is already open', () => {
    const commit = vi.spyOn(store, 'commit')
    expandAll(store, a)
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })
})

describe('removeMany', () => {
  // Deleting A already deletes A1; a second op for A1 would snapshot the same
  // nodes twice and restore them twice on undo.
  it('emits one delete for a parent and its own child', () => {
    const commit = vi.spyOn(store, 'commit')
    removeMany(store, [a, a1])
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][0]).toHaveLength(1)
    commit.mockRestore()
    expect(store.sheet.nodes[a]).toBeUndefined()
    expect(store.sheet.nodes[a1]).toBeUndefined()
    expect(store.sheet.nodes[a2]).toBeUndefined()
  })

  it('deletes a multi-selection and undoes it in one step', () => {
    expectOneUndoEntry(() => removeMany(store, [a1, b]))
  })

  // Undo replays a batch's inverses in reverse, so the sibling order only
  // survives if the deletes were emitted in descending index order.
  it('restores deleted siblings in their original order', () => {
    const c = store.createChild(root)
    store.rename(c, 'C')
    expect(store.sheet.nodes[root].childrenIds).toEqual([a, b, c])
    removeMany(store, [a, b, c])
    expect(store.sheet.nodes[root].childrenIds).toEqual([])
    store.undo()
    expect(store.sheet.nodes[root].childrenIds).toEqual([a, b, c])
  })

  it('never deletes the root', () => {
    const commit = vi.spyOn(store, 'commit')
    removeMany(store, [root])
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
    expect(store.sheet.nodes[root]).toBeDefined()
  })

  // A relationship spanning two deleted subtrees belongs to exactly one op, or
  // undo pushes it back twice and the map grows a duplicate line.
  it('restores a relationship spanning two deleted subtrees exactly once', () => {
    store.sheet.relationships.push({ id: 'rel-1', fromId: a1, toId: b })
    removeMany(store, [a, b])
    expect(store.sheet.relationships).toHaveLength(0)
    store.undo()
    expect(store.sheet.relationships).toHaveLength(1)
  })
})

describe('pasteSubtrees', () => {
  it('pastes into the source sheet with entirely new ids, originals intact', () => {
    const payload = serialiseSubtrees(store.sheet, [a])
    const originals = new Set(Object.keys(store.sheet.nodes))

    let created: string[] = []
    expectOneUndoEntry(() => {
      created = pasteSubtrees(store, payload, b)
    })
    created = pasteSubtrees(store, payload, b)

    expect(created).toHaveLength(1)
    for (const id of Object.keys(store.sheet.nodes)) {
      if (!originals.has(id)) {
        expect(store.sheet.nodes[id].parentId === null || !!store.sheet.nodes[store.sheet.nodes[id].parentId]).toBe(true)
      }
    }
    expect(originals.has(created[0])).toBe(false)
    expect(store.sheet.nodes[b].childrenIds).toEqual(created)
    // The subtree the payload was taken from is untouched.
    expect(store.sheet.nodes[a].childrenIds).toEqual([a1, a2])
    expect(store.sheet.nodes[a1].title).toBe('A1')
    const pasted = store.sheet.nodes[created[0]]
    expect(pasted.title).toBe('A')
    expect(pasted.childrenIds).toHaveLength(2)
    expect(pasted.childrenIds).not.toContain(a1)
  })

  it('pastes several roots as one undo entry, appended in order', () => {
    const payload = serialiseSubtrees(store.sheet, [a, b])
    let created: string[] = []
    expectOneUndoEntry(() => {
      created = pasteSubtrees(store, payload, a2)
    })
    created = pasteSubtrees(store, payload, a2)
    expect(created).toHaveLength(2)
    expect(store.sheet.nodes[a2].childrenIds).toEqual(created)
    expect(store.sheet.nodes[created[0]].title).toBe('A')
    expect(store.sheet.nodes[created[1]].title).toBe('B')
  })

  it('types a root pasted under the central topic as a main topic', () => {
    const payload = serialiseSubtrees(store.sheet, [a1])
    const [created] = pasteSubtrees(store, payload, root)
    expect(store.sheet.nodes[created].type).toBe('main')
  })

  it('does nothing for an unknown destination', () => {
    const payload = serialiseSubtrees(store.sheet, [a])
    const commit = vi.spyOn(store, 'commit')
    expect(pasteSubtrees(store, payload, 'nope')).toEqual([])
    expect(commit).not.toHaveBeenCalled()
    commit.mockRestore()
  })
})

/**
 * §C.6's load-time validation. These belong beside the other storage tests,
 * but `tests/mindmap-storage.test.ts` is a Round 0 file no lane owns (§0.4) —
 * so they live here, in a Lane C file, rather than not existing. Worth moving
 * at merge.
 */
describe('repairSheet — load-time topology validation (X05)', () => {
  // A cycle is the failure this exists for: layoutSheet recurses through
  // childrenIds, so a sheet with one loads fine, renders nothing, and blows
  // the stack with no clue in the console.
  it('breaks a cycle and still lays the sheet out', () => {
    const sheet = blankSheet('Cyclic')
    const rootId = sheet.rootNodeId
    sheet.nodes.x = node('x', rootId, ['y'])
    sheet.nodes.y = node('y', 'x', ['x'])
    sheet.nodes[rootId].childrenIds = ['x']

    const { sheet: repaired, repairs } = repairSheet(sheet)
    expect(repairs.some(line => line.includes('cycle'))).toBe(true)
    expect(repaired.nodes.y.childrenIds).toEqual([])
    expect(repaired.nodes.x.childrenIds).toEqual(['y'])
    expect(() => layoutSheet(repaired, {})).not.toThrow()
  })

  it('breaks a cycle that never touches the root', () => {
    const sheet = blankSheet('Floating cycle')
    sheet.nodes.p = node('p', 'q', ['q'])
    sheet.nodes.q = node('q', 'p', ['p'])

    const { sheet: repaired } = repairSheet(sheet)
    expect(() => layoutSheet(repaired, {})).not.toThrow()
    // Both survive, one of them now hanging off the central topic.
    expect(repaired.nodes.p).toBeDefined()
    expect(repaired.nodes.q).toBeDefined()
    expect(reachable(repaired)).toEqual(new Set(Object.keys(repaired.nodes)))
  })

  it('re-parents an unreachable node to the root', () => {
    const sheet = blankSheet('Orphan')
    sheet.nodes.lost = node('lost', 'gone-parent', [])

    const { sheet: repaired, repairs } = repairSheet(sheet)
    expect(repairs.some(line => line.includes('unreachable'))).toBe(true)
    expect(repaired.nodes.lost.parentId).toBe(repaired.rootNodeId)
    expect(repaired.nodes[repaired.rootNodeId].childrenIds).toContain('lost')
  })

  // Attaching every unreachable node individually would flatten a detached
  // branch into a row of siblings.
  it('keeps a detached branch together when re-attaching it', () => {
    const sheet = blankSheet('Branch')
    sheet.nodes.top = node('top', 'gone', ['leaf'])
    sheet.nodes.leaf = node('leaf', 'top', [])

    const { sheet: repaired } = repairSheet(sheet)
    expect(repaired.nodes[repaired.rootNodeId].childrenIds).toEqual(['top'])
    expect(repaired.nodes.top.childrenIds).toEqual(['leaf'])
    expect(repaired.nodes.leaf.parentId).toBe('top')
  })

  it('drops a child entry pointing at a node that is not there', () => {
    const sheet = blankSheet('Dangling')
    sheet.nodes[sheet.rootNodeId].childrenIds = ['ghost']

    const { sheet: repaired, repairs } = repairSheet(sheet)
    expect(repaired.nodes[repaired.rootNodeId].childrenIds).toEqual([])
    expect(repairs).toHaveLength(1)
  })

  it('makes parentId agree with the parent that actually lists the child', () => {
    const sheet = blankSheet('Disagreement')
    sheet.nodes.c = node('c', 'somebody-else', [])
    sheet.nodes[sheet.rootNodeId].childrenIds = ['c']

    const { sheet: repaired } = repairSheet(sheet)
    expect(repaired.nodes.c.parentId).toBe(repaired.rootNodeId)
  })

  it('keeps only the first parent of a node listed under two', () => {
    const sheet = blankSheet('Shared')
    const rootId = sheet.rootNodeId
    sheet.nodes.p1 = node('p1', rootId, ['shared'])
    sheet.nodes.p2 = node('p2', rootId, ['shared'])
    sheet.nodes.shared = node('shared', 'p1', [])
    sheet.nodes[rootId].childrenIds = ['p1', 'p2']

    const { sheet: repaired } = repairSheet(sheet)
    expect(repaired.nodes.p1.childrenIds).toEqual(['shared'])
    expect(repaired.nodes.p2.childrenIds).toEqual([])
  })

  it('replaces collections a truncated file left out, rather than crashing on them', () => {
    const sheet = blankSheet('Truncated') as unknown as Record<string, unknown>
    delete sheet.relationships
    delete sheet.boundaries

    const { sheet: repaired } = repairSheet(sheet)
    expect(repaired.relationships).toEqual([])
    expect(repaired.boundaries).toEqual([])
  })

  it('drops a relationship whose endpoint is gone', () => {
    const sheet = blankSheet('Dangling link')
    sheet.relationships = [{ id: 'r1', fromId: sheet.rootNodeId, toId: 'vanished' }]

    const { sheet: repaired } = repairSheet(sheet)
    expect(repaired.relationships).toEqual([])
  })

  it('reports nothing to repair on a sound sheet', () => {
    const sheet = blankSheet('Fine')
    sheet.nodes.k = node('k', sheet.rootNodeId, [])
    sheet.nodes[sheet.rootNodeId].childrenIds = ['k']
    expect(repairSheet(sheet).repairs).toEqual([])
  })

  it('gives up only when there is nothing to show', () => {
    expect(repairSheet(null).sheet).toBeNull()
    expect(repairSheet({ nodes: {} }).sheet).toBeNull()
    expect(repairSheet('not a sheet').sheet).toBeNull()
  })
})

describe('dropPlacement', () => {
  it('places a child at the end of the target\'s list', () => {
    const placement = dropPlacement(store.sheet, [b], a, 'child')
    expect(placement).toEqual({ parentId: a, index: 2 })
  })

  it('places a sibling before or after the target, by its current slot', () => {
    expect(dropPlacement(store.sheet, [b], a1, 'before')).toEqual({ parentId: a, index: 0 })
    expect(dropPlacement(store.sheet, [b], a2, 'after')).toEqual({ parentId: a, index: 2 })
  })

  // buildMoveOps subtracts a mover already sitting before the slot, so the
  // same index that means "after" in the current list is the final index too.
  it('is consistent with moveNode when reordering within one parent', () => {
    const placement = dropPlacement(store.sheet, [a1], a2, 'after')
    moveNode(store, a1, placement.parentId, placement.index)
    expect(store.sheet.nodes[a].childrenIds).toEqual([a2, a1])
  })

  it('refuses before/after the root, which has no sibling slot', () => {
    expect(dropPlacement(store.sheet, [a], root, 'before')).toBeNull()
    expect(dropPlacement(store.sheet, [a], root, 'after')).toBeNull()
  })

  it('refuses a drop onto one of the dragged nodes themselves', () => {
    expect(dropPlacement(store.sheet, [a, a1], a, 'child')).toBeNull()
  })
})

describe('navigateTo', () => {
  /** Places nodes by hand — the tree shape is set, geometry is what is tested. */
  function place(id: string, x: number, y: number) {
    store.sheet.nodes[id].position = { x, y, manual: false }
  }

  function sizes(): Record<string, { w: number, h: number }> {
    const out: Record<string, { w: number, h: number }> = {}
    for (const id of Object.keys(store.sheet.nodes)) {
      out[id] = { w: 80, h: 40 }
    }
    return out
  }

  it('picks the nearest node whose centre lies in the half-plane', () => {
    place(root, 0, 0)
    place(a, 300, 0)
    place(a1, 600, 0)
    place(a2, 600, 100)
    place(b, -300, 0)
    expect(navigateTo(store.sheet, sizes(), a, 'right')).toBe(a1)
    expect(navigateTo(store.sheet, sizes(), a, 'left')).toBe(root)
    expect(navigateTo(store.sheet, sizes(), root, 'left')).toBe(b)
  })

  // Perpendicular distance dominates the score, so a topic slightly out of
  // line but much closer must lose to one the arrow points straight at.
  it('weights perpendicular distance more heavily than parallel distance', () => {
    place(root, 0, 0)
    place(a, 200, 0)
    place(a1, 800, 0)
    place(a2, 320, 150)
    expect(navigateTo(store.sheet, sizes(), a, 'right')).toBe(a1)
  })

  it('returns null when nothing is in that half-plane, or from is unknown', () => {
    place(root, 0, 0)
    place(a, 200, 0)
    expect(navigateTo(store.sheet, sizes(), a, 'right')).toBeNull()
    expect(navigateTo(store.sheet, sizes(), a, 'up')).toBeNull()
    expect(navigateTo(store.sheet, sizes(), 'ghost', 'right')).toBeNull()
  })
})

describe('migration (S05)', () => {
  it('stamps a sheet written before the field existed, and writes it back', async () => {
    const stale = blankSheet('Old') as Sheet & { schemaVersion?: string }
    delete stale.schemaVersion
    await writeSheet(stale.sheetId, stale)

    const loaded = await readSheet(stale.sheetId)
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION)
    // Written back, so the stamp is paid for once rather than on every open.
    expect((await readSheet(stale.sheetId)).schemaVersion).toBe(SCHEMA_VERSION)
  })

  it('leaves a sheet that already carries the version alone', async () => {
    const sheet = blankSheet('Current')
    expect(sheet.schemaVersion).toBe(SCHEMA_VERSION)
    await writeSheet(sheet.sheetId, sheet)
    expect(await readSheet(sheet.sheetId)).toEqual(sheet)
  })
})
