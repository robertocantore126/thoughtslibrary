import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { layoutSheet } from '../src/mindmap/layout'
import { blankSheet, readSheet, writeSheet } from '../src/mindmap/storage'
import { useMindmapStore } from '../src/mindmap/store'
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from '../src/mindmap/types'

// Lanes B and C have not merged yet — src/mindmap/layout.ts and
// src/mindmap/storage.ts do not exist. The store imports them per the frozen
// §0.3 contract, so the tests mock them with factories; vitest never loads the
// real modules. The blankSheet factory is self-contained (no outer bindings)
// because mock factories run during import evaluation, before the test body.
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

function makeSheet(sheetId: string, title: string): Sheet {
  return {
    sheetId,
    title,
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.mocked(readSheet).mockReset()
  vi.mocked(writeSheet).mockReset()
  vi.mocked(readSheet).mockResolvedValue(null)
  vi.mocked(writeSheet).mockResolvedValue(undefined)
  vi.mocked(layoutSheet).mockClear()
  vi.mocked(blankSheet).mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('mindmap store — open and history', () => {
  it('open → createChild → undo → redo round-trips', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s1', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s1')

    expect(store.sheet).not.toBeNull()
    expect(store.undo()).toBe(false)

    const before = store.sheet
    const id = store.createChild('root')
    expect(id).toBeTruthy()
    expect(store.sheet).not.toBe(before)
    expect(store.sheet.nodes[id].parentId).toBe('root')
    expect(store.sheet.nodes.root.childrenIds).toContain(id)
    expect(store.canUndo).toBe(true)

    expect(store.undo()).toBe(true)
    expect(store.sheet.nodes[id]).toBeUndefined()
    expect(store.sheet.nodes.root.childrenIds).not.toContain(id)
    expect(store.canRedo).toBe(true)

    expect(store.redo()).toBe(true)
    expect(store.sheet.nodes[id]).toBeDefined()
    expect(store.sheet.nodes.root.childrenIds).toContain(id)
  })

  it('undo() reports exhaustion on a freshly opened sheet, true after one edit', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s2', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s2')

    expect(store.undo()).toBe(false)
    expect(store.redo()).toBe(false)

    store.createChild('root')
    expect(store.undo()).toBe(true)
    expect(store.undo()).toBe(false)
  })

  it('open(null) creates and persists a blank sheet', async () => {
    const store = useMindmapStore()
    await store.open(null)

    expect(store.sheet).not.toBeNull()
    expect(store.sheet.rootNodeId).toBeTruthy()
    expect(vi.mocked(blankSheet)).toHaveBeenCalledWith('Untitled')
    expect(vi.mocked(writeSheet)).toHaveBeenCalledWith(store.sheet.sheetId, store.sheet)
  })

  it('open() with an unknown id creates a blank sheet in its place', async () => {
    vi.mocked(readSheet).mockResolvedValue(null)
    const store = useMindmapStore()
    await store.open('missing')

    expect(vi.mocked(readSheet)).toHaveBeenCalledWith('missing')
    expect(vi.mocked(blankSheet)).toHaveBeenCalledWith('Untitled')
    expect(vi.mocked(writeSheet)).toHaveBeenCalledTimes(1)
  })

  it('close() flushes a pending autosave and drops the sheet', async () => {
    vi.useFakeTimers()
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s8', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s8')
    vi.mocked(writeSheet).mockClear()

    store.createChild('root')
    await store.close()

    expect(vi.mocked(writeSheet)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeSheet)).toHaveBeenCalledWith('s8', expect.anything())
    expect(store.sheet).toBeNull()
    expect(store.selection).toBeNull()
    expect(store.undo()).toBe(false)
  })

  it('close() does not null a sheet that open() swapped in while its flush was in flight', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('sB', 'Sheet B'))
    const store = useMindmapStore()
    await store.open('sA')

    // Make every flush hang until released, so close() sits mid-await while
    // open() runs — the switch-map path that does not exist today but must
    // not corrupt the store the day it does.
    const releases: Array<() => void> = []
    vi.mocked(writeSheet).mockImplementation(() => new Promise((resolve) => {
      releases.push(() => resolve(undefined))
    }))

    const closing = store.close()
    const opening = store.open('sB')

    // open()'s flush resolves first: it reads and publishes sB while close()
    // is still awaiting its own flush.
    releases[1]()
    releases[0]()
    await Promise.all([closing, opening])

    // The guard bailed: the newly opened sheet survived the stale close.
    expect(store.sheet?.sheetId).toBe('sB')
    expect(store.sheet).not.toBeNull()
  })
})

describe('mindmap store — editing actions', () => {
  it('createSibling inserts a new node after its sibling, and the root has no sibling', async () => {
    const sheet = makeSheet('s3', 'Sheet')
    const a = makeNode('a', 'root', 'Alpha', 'main')
    const b = makeNode('b', 'root', 'Bravo', 'main')
    sheet.nodes = { root: sheet.nodes.root, a, b }
    sheet.nodes.root.childrenIds = ['a', 'b']
    vi.mocked(readSheet).mockResolvedValue(sheet)
    const store = useMindmapStore()
    await store.open('s3')

    const id = store.createSibling('a')
    expect(store.sheet.nodes.root.childrenIds).toEqual(['a', id, 'b'])
    expect(store.sheet.nodes[id].parentId).toBe('root')
    expect(store.sheet.nodes[id].type).toBe('main')

    expect(store.createSibling('root')).toBe('')
  })

  it('remove deletes the subtree and clears a selection inside it', async () => {
    const sheet = makeSheet('s4', 'Sheet')
    const a = makeNode('a', 'root', 'Alpha', 'main')
    const a1 = makeNode('a1', 'a', 'Alpha one', 'subtopic')
    a.childrenIds = ['a1']
    sheet.nodes = { root: sheet.nodes.root, a, a1 }
    sheet.nodes.root.childrenIds = ['a']
    sheet.relationships = [{ id: 'rel-1', fromId: 'a', toId: 'a1' }]
    vi.mocked(readSheet).mockResolvedValue(sheet)
    const store = useMindmapStore()
    await store.open('s4')

    store.select('a1')
    store.remove('a')
    expect(store.sheet.nodes.a).toBeUndefined()
    expect(store.sheet.nodes.a1).toBeUndefined()
    expect(store.sheet.nodes.root.childrenIds).toEqual([])
    expect(store.sheet.relationships).toEqual([])
    expect(store.selection).toBeNull()

    // The root is not removable — a sheet must keep its central node.
    store.remove('root')
    expect(store.sheet.nodes.root).toBeDefined()

    // Undo restores the whole subtree, relationships included.
    expect(store.undo()).toBe(true)
    expect(store.sheet.nodes.a).toBeDefined()
    expect(store.sheet.nodes.a1).toBeDefined()
    expect(store.sheet.nodes.root.childrenIds).toEqual(['a'])
    expect(store.sheet.relationships).toEqual([{ id: 'rel-1', fromId: 'a', toId: 'a1' }])
  })

  it('rename and toggleCollapse record undoable edits', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s5', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s5')

    store.rename('root', 'Renamed')
    expect(store.sheet.nodes.root.title).toBe('Renamed')
    expect(store.undo()).toBe(true)
    expect(store.sheet.nodes.root.title).toBe('Root')

    store.toggleCollapse('root')
    expect(store.sheet.nodes.root.collapsed).toBe(true)
    expect(store.undo()).toBe(true)
    expect(store.sheet.nodes.root.collapsed).toBe(false)
  })

  it('rename of the same title is a no-op that does not touch history', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s13', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s13')

    store.rename('root', 'Root')
    expect(store.canUndo).toBe(false)
    expect(store.undo()).toBe(false)
  })

  it('select ignores ids that are not in the sheet', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s11', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s11')

    store.select('root')
    expect(store.selection).toBe('root')
    store.select('missing')
    expect(store.selection).toBe('root')
    store.select(null)
    expect(store.selection).toBeNull()
  })

  it('publishes a new sheet reference on every edit', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s12', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s12')

    const first = store.sheet
    store.createChild('root')
    expect(store.sheet).not.toBe(first)

    const second = store.sheet
    store.rename('root', 'Renamed')
    expect(store.sheet).not.toBe(first)
    expect(store.sheet).not.toBe(second)
  })
})

describe('mindmap store — layout bridge', () => {
  it('applySizes runs layoutSheet on a fresh draft and republishes it', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s6', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s6')

    const before = store.sheet
    const sizes = { root: { w: 200, h: 60 } }
    store.applySizes(sizes)

    expect(vi.mocked(layoutSheet)).toHaveBeenCalledTimes(1)
    const [draft, passedSizes] = vi.mocked(layoutSheet).mock.calls[0]
    expect(passedSizes).toEqual(sizes)
    expect(draft).not.toBe(before)
    expect(store.sheet).toBe(draft)

    // Derived data: layout never enters history, so undo stays untouched.
    expect(store.canUndo).toBe(false)
    expect(store.undo()).toBe(false)
  })

  it('applySizes is a no-op with no open sheet', () => {
    const store = useMindmapStore()
    store.applySizes({ root: { w: 10, h: 10 } })
    expect(vi.mocked(layoutSheet)).not.toHaveBeenCalled()
  })

  it('autosaves the sheet on a debounce after an edit', async () => {
    vi.useFakeTimers()
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s7', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s7')
    vi.mocked(writeSheet).mockClear()

    store.createChild('root')
    expect(vi.mocked(writeSheet)).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(500)
    expect(vi.mocked(writeSheet)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(writeSheet)).toHaveBeenCalledWith('s7', store.sheet)
  })
})

describe('mindmap store — camera and view', () => {
  it('panBy and zoomAt update the camera, zoom anchored at the screen point', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s9', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s9')

    store.panBy(10, -20)
    expect(store.camera).toEqual({ x: 10, y: -20, scale: 1 })

    const c = store.camera
    store.zoomAt(400, 300, 2)
    expect(store.camera.scale).toBe(2)
    expect(store.camera.x).toBeCloseTo(400 - (400 - c.x) * 2)
    expect(store.camera.y).toBeCloseTo(300 - (300 - c.y) * 2)
  })

  it('fit frames the map bounds in the viewport, using measured sizes', async () => {
    vi.mocked(readSheet).mockResolvedValue(makeSheet('s10', 'Sheet'))
    const store = useMindmapStore()
    await store.open('s10')

    store.applySizes({ root: { w: 100, h: 50 } })
    store.fit(1000, 800)

    // The root sits at 0,0, so the map's centre is (50,25). 1000x800 with
    // 40px padding fits a 100x50 map at scale 8, clamped to MAX_ZOOM (4).
    expect(store.camera).toEqual({ scale: 4, x: 300, y: 300 })
  })

  it('visibleNodes lists every node in document order, and nothing when closed', async () => {
    const sheet = makeSheet('s14', 'Sheet')
    const a = makeNode('a', 'root', 'Alpha', 'main')
    const a1 = makeNode('a1', 'a', 'Alpha one', 'subtopic')
    const b = makeNode('b', 'root', 'Bravo', 'main')
    a.childrenIds = ['a1']
    sheet.nodes = { root: sheet.nodes.root, a, a1, b }
    sheet.nodes.root.childrenIds = ['a', 'b']
    vi.mocked(readSheet).mockResolvedValue(sheet)
    const store = useMindmapStore()
    await store.open('s14')

    expect(store.visibleNodes.map(n => n.id)).toEqual(['root', 'a', 'a1', 'b'])

    await store.close()
    expect(store.visibleNodes).toEqual([])
  })
})
