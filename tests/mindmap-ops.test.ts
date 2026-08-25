import { describe, expect, it } from 'vitest'
import { History } from '../src/mindmap/history'
import { applyWithInverse, cloneNode, makeOp, nodeImageIds } from '../src/mindmap/ops'
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from '../src/mindmap/types'

function makeNode(id: string, parentId: string | null, title: string, type: MindNode['type']): MindNode {
  return {
    id,
    type,
    parentId,
    childrenIds: [],
    title,
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

function makeSheet(): Sheet {
  return {
    sheetId: 'sheet-1',
    title: 'Sheet',
    structure: { ...DEFAULT_STRUCTURE },
    rootNodeId: 'root',
    nodes: {
      root: makeNode('root', null, 'Root', 'central'),
    },
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
  }
}

/**
 * A small tree with two levels of depth under one branch, plus one
 * relationship, boundary and summary so every op type has a target.
 *
 *   root
 *   ├── a            (main)
 *   │   ├── a1       (subtopic)
 *   │   └── a2       (subtopic)
 *   │       └── a2x  (subtopic)
 *   └── b            (main)
 */
function makeFixture(): Sheet {
  const sheet = makeSheet()
  const a = makeNode('a', 'root', 'Alpha', 'main')
  const a1 = makeNode('a1', 'a', 'Alpha one', 'subtopic')
  const a2 = makeNode('a2', 'a', 'Alpha two', 'subtopic')
  const a2x = makeNode('a2x', 'a2', 'Alpha two x', 'subtopic')
  const b = makeNode('b', 'root', 'Bravo', 'main')
  a.childrenIds = ['a1', 'a2']
  a2.childrenIds = ['a2x']
  sheet.nodes = { root: sheet.nodes.root, a, a1, a2, a2x, b }
  sheet.nodes.root.childrenIds = ['a', 'b']
  sheet.relationships = [{ id: 'rel-a', fromId: 'a', toId: 'b' }]
  sheet.boundaries = [{ id: 'g1', memberIds: ['a1', 'a2'] }]
  sheet.summaries = [{ id: 's1', memberIds: ['a1', 'a2'] }]
  return sheet
}

/** Pre-order walk of a node and all its descendants, as a delete op needs it. */
function collectSubtree(sheet: Sheet, id: string): MindNode[] {
  const out: MindNode[] = []
  const walk = (nodeId: string) => {
    const n = sheet.nodes[nodeId]
    if (!n) {
      return
    }
    out.push({ ...n, childrenIds: [...n.childrenIds] })
    for (const childId of n.childrenIds) {
      walk(childId)
    }
  }
  walk(id)
  return out
}

describe('schema', () => {
  it('loads a sheet shape with a root node', () => {
    const sheet = makeSheet()
    expect(sheet.nodes.root.type).toBe('central')
    expect(sheet.nodes.root.parentId).toBeNull()
    expect(DEFAULT_STRUCTURE.structureType).toBe('mindmap')
  })
})

describe('applyWithInverse', () => {
  interface OpCase {
    name: string
    make: () => { sheet: Sheet, op: Parameters<typeof applyWithInverse>[1] }
  }

  const opCases: OpCase[] = [
    {
      name: 'createNode',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('createNode', { id: 'n1', nodeType: 'subtopic', parentId: 'root', index: 0, title: 'New topic' }),
      }),
    },
    {
      name: 'deleteNode',
      make: () => {
        const sheet = makeFixture()
        return {
          sheet,
          op: makeOp('deleteNode', { id: 'a', parentId: 'root', index: 0, subtree: collectSubtree(sheet, 'a'), removedRelationships: [...sheet.relationships] }),
        }
      },
    },
    {
      name: 'restoreNode',
      make: () => {
        const sheet = makeFixture()
        const subtree = collectSubtree(sheet, 'a')
        const removedRelationships = [...sheet.relationships]
        // Remove the branch first so restoreNode is undoing a real deletion,
        // not re-adding nodes that are already there.
        sheet.nodes.root.childrenIds = ['b']
        for (const n of subtree) {
          delete sheet.nodes[n.id]
        }
        sheet.relationships = []
        return {
          sheet,
          op: makeOp('restoreNode', { id: 'a', parentId: 'root', index: 0, subtree, removedRelationships }),
        }
      },
    },
    {
      name: 'setTitle',
      make: () => ({
        sheet: makeFixture(),
        // titleRuns travels with the rename so the styled-segments path is
        // exercised, not just the plain-text one.
        op: makeOp('setTitle', { id: 'a', title: 'Renamed', prev: 'Alpha', titleRuns: [{ text: 'Renamed' }] }),
      }),
    },
    {
      name: 'setStyle',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setStyle', { id: 'a', style: { fill: '#ff0000', fontSize: 20 }, prev: {} }),
      }),
    },
    {
      name: 'setNodeImage',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setNodeImage', { nodeId: 'a', imageId: 'img-1', prevImageId: null }),
      }),
    },
    {
      name: 'setPosition',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setPosition', { id: 'a', x: 300, y: 200, manual: true, prev: { x: 0, y: 0, manual: false } }),
      }),
    },
    {
      name: 'setCollapsed',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setCollapsed', { id: 'a', collapsed: true, prev: false }),
      }),
    },
    {
      name: 'moveNode',
      make: () => ({
        sheet: makeFixture(),
        // toIndex is the FINAL position after removal: 'a' lands at the end
        // of b's (empty) child list.
        op: makeOp('moveNode', { id: 'a', fromParentId: 'root', fromIndex: 0, toParentId: 'b', toIndex: 1 }),
      }),
    },
    {
      name: 'sortSiblings',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('sortSiblings', { parentId: 'root', order: ['b', 'a'], prevOrder: ['a', 'b'] }),
      }),
    },
    {
      name: 'setTask',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setTask', { id: 'a', task: { status: 'in-progress', priority: 'high', progress: 40 }, prev: null }),
      }),
    },
    {
      name: 'setNotes',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setNotes', { id: 'a', notes: 'Some notes', prev: '' }),
      }),
    },
    {
      name: 'setSheetTitle',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setSheetTitle', { title: 'Renamed sheet', prev: 'Sheet' }),
      }),
    },
    {
      name: 'setStructure',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setStructure', { config: { ...DEFAULT_STRUCTURE, spacing: 300 }, prev: { ...DEFAULT_STRUCTURE } }),
      }),
    },
    {
      name: 'createRelationship',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('createRelationship', { relationship: { id: 'rel-2', fromId: 'b', toId: 'a' } }),
      }),
    },
    {
      name: 'deleteRelationship',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('deleteRelationship', { id: 'rel-a', relationship: { id: 'rel-a', fromId: 'a', toId: 'b' } }),
      }),
    },
    {
      name: 'setRelationship',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setRelationship', { id: 'rel-a', relationship: { id: 'rel-a', fromId: 'a', toId: 'b', label: 'updated' }, prev: { id: 'rel-a', fromId: 'a', toId: 'b' } }),
      }),
    },
    {
      name: 'createGroup',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('createGroup', { group: { id: 'g2', memberIds: ['b'] } }),
      }),
    },
    {
      name: 'deleteGroup',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('deleteGroup', { id: 'g1', group: { id: 'g1', memberIds: ['a1', 'a2'] } }),
      }),
    },
    {
      name: 'setGroup',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setGroup', { id: 'g1', group: { id: 'g1', memberIds: ['a1', 'a2'], label: 'updated' }, prev: { id: 'g1', memberIds: ['a1', 'a2'] } }),
      }),
    },
    {
      name: 'createSummary',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('createSummary', { summary: { id: 's2', memberIds: ['b'] } }),
      }),
    },
    {
      name: 'deleteSummary',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('deleteSummary', { id: 's1', summary: { id: 's1', memberIds: ['a1', 'a2'] } }),
      }),
    },
    {
      name: 'setSummary',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setSummary', { id: 's1', summary: { id: 's1', memberIds: ['a1', 'a2'], label: 'updated' }, prev: { id: 's1', memberIds: ['a1', 'a2'] } }),
      }),
    },
    {
      name: 'setAttachments',
      make: () => ({
        sheet: makeFixture(),
        op: makeOp('setAttachments', { attachments: [{ id: 'att-1', mime: 'image/png', w: 10, h: 10, bytes: 100 }], prev: [] }),
      }),
    },
  ]

  for (const c of opCases) {
    it(`the inverse of ${c.name} restores the sheet exactly`, () => {
      const { sheet, op } = c.make()
      const before = structuredClone(sheet)
      const inverses = applyWithInverse(sheet, op)
      expect(inverses.length).toBeGreaterThan(0)
      for (const inv of inverses) {
        applyWithInverse(sheet, inv)
      }
      expect(sheet).toEqual(before)
    })
  }

  it('mutates only the nodes an op touches (copy-on-write)', () => {
    const sheet = makeFixture()
    // Draft-like shallow copy, exactly as the store's draftOf builds it: node
    // objects shared with the previously published sheet.
    const draft = {
      ...sheet,
      nodes: { ...sheet.nodes },
      relationships: [...sheet.relationships],
      boundaries: [...sheet.boundaries],
      summaries: [...sheet.summaries],
      attachments: [...sheet.attachments],
    }
    // The ops touch only 'a', root and b: 'a' (renamed, collapsed, moved) and
    // its two parents (childrenIds change). Everything deeper is shared with
    // the published sheet and must remain the very same object.
    const untouched = sheet.nodes.a2
    const untouchedLeaf = sheet.nodes.a2x

    applyWithInverse(draft, makeOp('setTitle', { id: 'a', title: 'Renamed', prev: 'Alpha' }))
    applyWithInverse(draft, makeOp('setCollapsed', { id: 'a', collapsed: true, prev: false }))
    applyWithInverse(draft, makeOp('moveNode', { id: 'a', fromParentId: 'root', fromIndex: 0, toParentId: 'b', toIndex: 1 }))

    // Nodes the ops never touched are still the very objects of the sheet the
    // draft was built from — nothing was mutated in place behind the store's
    // back, in the draft OR in the published sheet.
    expect(draft.nodes.a2).toBe(untouched)
    expect(draft.nodes.a2x).toBe(untouchedLeaf)
    expect(sheet.nodes.a2).toBe(untouched)
    expect(sheet.nodes.a2x).toBe(untouchedLeaf)
    expect(sheet.nodes.a.title).toBe('Alpha')
    expect(sheet.nodes.a.collapsed).toBe(false)
    expect(sheet.nodes.a.parentId).toBe('root')
    expect(sheet.nodes.root.childrenIds).toEqual(['a', 'b'])
    // The draft saw the move: 'a' left root and now hangs under b.
    expect(draft.nodes.root.childrenIds).toEqual(['b'])
    expect(draft.nodes.a.parentId).toBe('b')
  })

  it('deleteNode removes the whole subtree and its inverse restores it, child order included', () => {
    const sheet = makeFixture()
    const before = structuredClone(sheet)
    const subtree = collectSubtree(sheet, 'a')
    expect(subtree.map(n => n.id)).toEqual(['a', 'a1', 'a2', 'a2x'])

    const inverses = applyWithInverse(sheet, makeOp('deleteNode', {
      id: 'a',
      parentId: 'root',
      index: 0,
      subtree,
      removedRelationships: [...sheet.relationships],
    }))

    for (const id of ['a', 'a1', 'a2', 'a2x']) {
      expect(sheet.nodes[id]).toBeUndefined()
    }
    expect(sheet.nodes.root.childrenIds).toEqual(['b'])
    expect(sheet.relationships).toEqual([])

    expect(inverses).toHaveLength(1)
    applyWithInverse(sheet, inverses[0])

    expect(sheet).toEqual(before)
    expect(sheet.nodes.root.childrenIds).toEqual(['a', 'b'])
    expect(sheet.nodes.a.childrenIds).toEqual(['a1', 'a2'])
    expect(sheet.nodes.a2.childrenIds).toEqual(['a2x'])
  })
})

describe('cloneNode', () => {
  it('deep-copies the gallery so a clone never aliases the source cells', () => {
    const node = makeNode('a', 'root', 'Alpha', 'main')
    node.style = { gallery: { items: [{ id: 'img-1', caption: 'one' }] } }

    const clone = cloneNode(node)
    expect(clone.style.gallery?.items[0]).toEqual({ id: 'img-1', caption: 'one' })
    expect(clone.style.gallery).not.toBe(node.style.gallery)
    expect(clone.style.gallery?.items[0]).not.toBe(node.style.gallery?.items[0])

    // Mutating the clone's cell must not touch the source — the aliasing that
    // would corrupt a sheet the day S4 makes galleries editable.
    clone.style.gallery!.items[0].caption = 'changed'
    expect(node.style.gallery!.items[0].caption).toBe('one')
  })
})

describe('nodeImageIds', () => {
  it('lists the four image slots plus the gallery cells', () => {
    const node = makeNode('a', 'root', 'Alpha', 'main')
    node.style = {
      image: 'local-asset://aaa',
      imageBottom: 'local-asset://bbb',
      imageLeft: 'local-asset://ccc',
      imageRight: 'local-asset://ddd',
      gallery: { items: [{ id: 'g1' }, { id: 'g2' }] },
    }

    expect(nodeImageIds(node).sort()).toEqual([
      'g1',
      'g2',
      'local-asset://aaa',
      'local-asset://bbb',
      'local-asset://ccc',
      'local-asset://ddd',
    ])
  })
})

describe('history', () => {
  it('undo returns batches latest-first and redo replays them in order', () => {
    const h = new History()
    const opA = { type: 'setTitle', id: 'a', title: '1', prev: '0' }
    const invA = { type: 'setTitle', id: 'a', title: '0', prev: '1' }
    const opB = { type: 'setCollapsed', id: 'a', collapsed: true, prev: false }
    const invB = { type: 'setCollapsed', id: 'a', collapsed: false, prev: true }

    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBeNull()

    h.push([opA], [[invA]])
    h.push([opB], [[invB]])
    expect(h.canUndo).toBe(true)

    expect(h.undo()).toEqual([invB])
    expect(h.undo()).toEqual([invA])
    expect(h.undo()).toBeNull()
    expect(h.canRedo).toBe(true)

    expect(h.redo()).toEqual([opA])
    expect(h.redo()).toEqual([opB])
    expect(h.redo()).toBeNull()
    expect(h.canRedo).toBe(false)
  })

  it('flattens one batch of inverses into undo order', () => {
    const h = new History()
    h.push([{ type: 'setTitle', id: 'a', title: '1', prev: '0' }], [
      [{ type: 'setTitle', id: 'a', title: '0', prev: '1' }],
      [{ type: 'setCollapsed', id: 'a', collapsed: false, prev: true }],
    ])
    expect(h.undo()).toEqual([
      { type: 'setCollapsed', id: 'a', collapsed: false, prev: true },
      { type: 'setTitle', id: 'a', title: '0', prev: '1' },
    ])
    expect(h.redo()).toEqual([{ type: 'setTitle', id: 'a', title: '1', prev: '0' }])
  })

  it('pushing after an undo clears the redo stack', () => {
    const h = new History()
    h.push([{ type: 'setTitle', id: 'a', title: '1', prev: '0' }], [[{ type: 'setTitle', id: 'a', title: '0', prev: '1' }]])
    h.undo()
    expect(h.canRedo).toBe(true)

    h.push([{ type: 'setTitle', id: 'a', title: '2', prev: '1' }], [[{ type: 'setTitle', id: 'a', title: '1', prev: '2' }]])
    expect(h.canRedo).toBe(false)
    expect(h.redo()).toBeNull()
  })

  it('clear empties both stacks', () => {
    const h = new History()
    h.push([{ type: 'setTitle', id: 'a', title: '1', prev: '0' }], [[{ type: 'setTitle', id: 'a', title: '0', prev: '1' }]])
    h.undo()
    h.clear()
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBeNull()
  })
})
