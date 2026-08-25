import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { layoutSheet } from '../src/mindmap/layout'
import { addGroup, addRelationship, removeGroup, removeRelationship, updateGroup, updateRelationship } from '../src/mindmap/relationCommands'
import { groupBounds, memberRectsOf, relationshipHit } from '../src/mindmap/relations'
import { blankSheet, readSheet, writeSheet } from '../src/mindmap/storage'
import { useMindmapStore } from '../src/mindmap/store'
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from '../src/mindmap/types'

// The store imports the storage and layout modules per the frozen §0.3
// contract; these tests exercise the geometry and the relation commands, so
// the store's persistence and layout bridges are mocked away exactly as the
// store's own tests do (mock factories run during import evaluation, before
// the test body).
vi.mock('../src/mindmap/layout', () => ({
  layoutSheet: vi.fn(),
}))

vi.mock('../src/mindmap/storage', () => ({
  readSheet: vi.fn(),
  writeSheet: vi.fn(),
  deleteSheet: vi.fn(),
  listSheetIds: vi.fn(),
  blankSheet: vi.fn((title: string) => {
    const root = {
      id: 'root',
      type: 'central',
      parentId: null,
      childrenIds: [],
      title: 'Root',
      position: { x: 0, y: 0, manual: false },
      style: {},
      collapsed: false,
      labels: [],
      markers: [],
      notes: '',
      task: null,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    return {
      sheetId: `sheet-${Math.random().toString(36).slice(2)}`,
      title,
      structure: { ...DEFAULT_STRUCTURE },
      rootNodeId: 'root',
      nodes: { root },
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
  }),
}))

function makeNode(id: string, parentId: string | null, title: string, type: MindNode['type'], x = 0, y = 0): MindNode {
  return {
    id,
    type,
    parentId,
    childrenIds: [],
    title,
    position: { x, y, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: '',
    task: null,
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
}

/**
 * A small tree with a relationship and a boundary on it, so every command has
 * a target and the delete rules have something to check.
 *
 *   root
 *   ├── a            (main)
 *   │   └── a1       (subtopic)
 *   └── b            (main)
 */
function makeFixture(): Sheet {
  const root = makeNode('root', null, 'Root', 'central')
  const a = makeNode('a', 'root', 'Alpha', 'main')
  const a1 = makeNode('a1', 'a', 'Alpha one', 'subtopic')
  const b = makeNode('b', 'root', 'Bravo', 'main')
  a.childrenIds = ['a1']
  root.childrenIds = ['a', 'b']
  return {
    sheetId: 'fixture',
    title: 'Fixture',
    structure: { ...DEFAULT_STRUCTURE },
    rootNodeId: 'root',
    nodes: { root, a, a1, b },
    relationships: [{ id: 'rel-1', fromId: 'a', toId: 'b' }],
    boundaries: [{ id: 'g1', memberIds: ['a', 'a1'] }],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
  }
}

async function openFixture() {
  vi.mocked(readSheet).mockResolvedValue(makeFixture())
  const store = useMindmapStore()
  await store.open('fixture')
  return store
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(readSheet).mockReset()
  vi.mocked(writeSheet).mockReset()
  vi.mocked(readSheet).mockResolvedValue(null)
  vi.mocked(writeSheet).mockResolvedValue({ ok: true })
  vi.mocked(layoutSheet).mockClear()
  vi.mocked(blankSheet).mockClear()
})

describe('relationshipHit', () => {
  // Two boxes side by side with identical heights: the curved relationship
  // between their centres is the straight horizontal line y = 20, trimmed to
  // the borders at x = 100 and x = 400.
  const from = { x: 0, y: 0, w: 100, h: 40 }
  const to = { x: 400, y: 0, w: 100, h: 40 }

  it('hits within tolerance of the curved path and misses just outside it', () => {
    expect(relationshipHit(from, to, 'curved', 250, 20, 10)).toBe(true)
    // 8 world units off the line is inside a 10-unit grab radius…
    expect(relationshipHit(from, to, 'curved', 250, 28, 10)).toBe(true)
    // …and 11 is outside it.
    expect(relationshipHit(from, to, 'curved', 250, 31, 10)).toBe(false)
  })

  it('stays equally hittable at another zoom scale', () => {
    // A 2.5x zoom scales every coordinate AND the tolerance; the physical
    // distance from the pointer to the line is unchanged, so the answers must
    // match the unscaled case exactly.
    const s = 2.5
    const scaledFrom = { x: from.x * s, y: from.y * s, w: from.w * s, h: from.h * s }
    const scaledTo = { x: to.x * s, y: to.y * s, w: to.w * s, h: to.h * s }
    expect(relationshipHit(scaledFrom, scaledTo, 'curved', 250 * s, 20 * s, 10 * s)).toBe(true)
    expect(relationshipHit(scaledFrom, scaledTo, 'curved', 250 * s, 28 * s, 10 * s)).toBe(true)
    expect(relationshipHit(scaledFrom, scaledTo, 'curved', 250 * s, 31 * s, 10 * s)).toBe(false)
  })

  it('answers the same way for straight and elbow connectors', () => {
    expect(relationshipHit(from, to, 'straight', 250, 20, 10)).toBe(true)
    expect(relationshipHit(from, to, 'straight', 250, 31, 10)).toBe(false)
    expect(relationshipHit(from, to, 'elbow', 250, 20, 10)).toBe(true)
    expect(relationshipHit(from, to, 'elbow', 250, 31, 10)).toBe(false)
  })
})

describe('groupBounds', () => {
  it('returns null for an empty member list, never a zero rect', () => {
    expect(groupBounds([], 12)).toBeNull()
  })

  it('skips members that no longer resolve and encloses the rest', () => {
    const root = makeNode('root', null, 'Root', 'central')
    const a = makeNode('a', 'root', 'Alpha', 'main', 0, 0)
    const b = makeNode('b', 'root', 'Bravo', 'main', 200, 0)
    const nodes = { root, a, b }
    const sizes = { root: { w: 100, h: 40 }, a: { w: 100, h: 40 }, b: { w: 100, h: 40 } }

    // 'ghost' was deleted; its id stays in memberIds (undo brings it back)
    // and rendering simply skips it.
    const rects = memberRectsOf(nodes, ['a', 'ghost', 'b'], sizes)
    expect(rects).toHaveLength(2)

    const bounds = groupBounds(rects, 12)
    expect(bounds).toEqual({ x: -12, y: -12, w: 324, h: 64 })
  })
})

describe('relationCommands', () => {
  it('addRelationship then undo drops it; redo restores the same id', async () => {
    const store = await openFixture()
    // 'a1' -> 'b' is not the fixture's existing rel-1, so this really creates.
    const id = addRelationship(store, 'a1', 'b')
    expect(id).toBeTruthy()
    expect(store.sheet.relationships.map(r => r.id)).toEqual(['rel-1', id])

    expect(store.undo()).toBe(true)
    expect(store.sheet.relationships.map(r => r.id)).toEqual(['rel-1'])

    expect(store.redo()).toBe(true)
    expect(store.sheet.relationships.map(r => r.id)).toEqual(['rel-1', id])
  })

  it('refuses a self-loop and returns the existing id for a duplicate', async () => {
    const store = await openFixture()
    expect(addRelationship(store, 'a', 'a')).toBe('')
    const id = addRelationship(store, 'a', 'b')
    // Two identical lines between the same pair are indistinguishable on the
    // map; the second click returns the first relationship rather than
    // drawing a second one.
    expect(addRelationship(store, 'b', 'a')).toBe(id)
    expect(store.sheet.relationships).toHaveLength(1)
  })

  it('a colour change is one undo entry, and clearing removes the field', async () => {
    const store = await openFixture()
    const id = addRelationship(store, 'a1', 'b')

    updateRelationship(store, id, { color: '#ff0000' })
    expect(store.sheet.relationships[1].color).toBe('#ff0000')
    expect(store.undo()).toBe(true)
    // Undo restores the pre-colour relationship, where the field is absent.
    expect(store.sheet.relationships[1].color).toBeUndefined()

    updateRelationship(store, id, { color: '#00ff00' })
    updateRelationship(store, id, { color: undefined })
    expect(store.sheet.relationships[1].color).toBeUndefined()
    expect('color' in store.sheet.relationships[1]).toBe(false)
  })

  it('a no-op update does not add an undo step', async () => {
    const store = await openFixture()
    const id = addRelationship(store, 'a1', 'b')
    updateRelationship(store, id, { label: 'x' })
    updateRelationship(store, id, { label: 'x' })

    // Two committed edits, not three: the duplicate update was skipped.
    expect(store.undo()).toBe(true)
    expect(store.sheet.relationships[1].label).toBeUndefined()
    expect(store.undo()).toBe(true)
    expect(store.sheet.relationships.map(r => r.id)).toEqual(['rel-1'])
    expect(store.undo()).toBe(false)
  })

  it('deleting a topic drops its relationships but keeps group membership; undo restores both', async () => {
    const store = await openFixture()
    store.remove('a')

    // deleteNode removes every relationship that touches the subtree…
    expect(store.sheet.relationships).toEqual([])
    // …but leaves the boundary's memberIds alone: restoreNode puts 'a' and
    // 'a1' back on undo and the boundary re-encloses them for free.
    expect(store.sheet.boundaries).toEqual([{ id: 'g1', memberIds: ['a', 'a1'] }])

    expect(store.undo()).toBe(true)
    expect(store.sheet.nodes.a).toBeDefined()
    expect(store.sheet.nodes.a1).toBeDefined()
    expect(store.sheet.relationships).toEqual([{ id: 'rel-1', fromId: 'a', toId: 'b' }])
    expect(store.sheet.boundaries).toEqual([{ id: 'g1', memberIds: ['a', 'a1'] }])
  })

  it('addGroup needs two resolvable members and drops ids that do not exist', async () => {
    const store = await openFixture()
    expect(addGroup(store, ['a'])).toBe('')
    expect(addGroup(store, ['a', 'ghost'])).toBe('')

    const id = addGroup(store, ['a', 'ghost', 'a1'])
    expect(id).toBeTruthy()
    // Creation drops what does not resolve (the boundary must start out
    // enclosing something), which is a different rule from rendering's skip.
    expect(store.sheet.boundaries.find(g => g.id === id)?.memberIds).toEqual(['a', 'a1'])

    expect(store.undo()).toBe(true)
    expect(store.sheet.boundaries.map(g => g.id)).toEqual(['g1'])
  })

  it('removeRelationship and removeGroup undo with their full payloads', async () => {
    const store = await openFixture()
    const rid = addRelationship(store, 'a1', 'b')
    updateRelationship(store, rid, { label: 'links', color: '#00ff00' })
    removeRelationship(store, rid)
    expect(store.sheet.relationships.map(r => r.id)).toEqual(['rel-1'])
    expect(store.undo()).toBe(true)
    // The delete op carried the whole relationship, so undo restores the
    // label and colour too.
    expect(store.sheet.relationships[1]).toMatchObject({ id: rid, label: 'links', color: '#00ff00' })

    const gid = addGroup(store, ['a', 'b'])
    updateGroup(store, gid, { borderWidth: 4 })
    removeGroup(store, gid)
    expect(store.sheet.boundaries.map(g => g.id)).toEqual(['g1'])
    expect(store.undo()).toBe(true)
    expect(store.sheet.boundaries).toHaveLength(2)
    expect(store.sheet.boundaries.find(g => g.id === gid)).toMatchObject({ id: gid, borderWidth: 4 })
  })
})
