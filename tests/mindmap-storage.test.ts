import type { MindNode, Sheet } from '../src/mindmap/types'
import { describe, expect, it } from 'vitest'
import { blankSheet, deleteSheet, listSheetIds, readSheet, readSheetResult, writeSheet } from '../src/mindmap/storage'
import 'fake-indexeddb/auto'

/**
 * A single-root sheet with one child and one relationship, so the round-trip
 * exercises nested objects and arrays, not just the root.
 */
function fixtureSheet(): Sheet {
  const sheet = blankSheet('My map')
  const child: MindNode = {
    id: 'child-1',
    type: 'main',
    parentId: sheet.rootNodeId,
    childrenIds: [],
    title: 'Child',
    position: { x: 10, y: 20, manual: false },
    style: { fill: '#ff0000' },
    collapsed: false,
    labels: ['tag'],
    markers: [],
    notes: 'note',
    task: { status: 'in-progress', priority: 'high', progress: 40 },
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
  sheet.nodes[child.id] = child
  sheet.nodes[sheet.rootNodeId].childrenIds.push(child.id)
  sheet.relationships = [{ id: 'rel-1', fromId: sheet.rootNodeId, toId: child.id }]
  return sheet
}

describe('blankSheet', () => {
  it('returns a valid single-root sheet', () => {
    const sheet = blankSheet('My map')
    const root = sheet.nodes[sheet.rootNodeId]
    expect(root.type).toBe('central')
    expect(root.parentId).toBeNull()
    expect(root.childrenIds).toEqual([])
    expect(root.title).toBe('My map')
    expect(sheet.title).toBe('My map')
    expect(sheet.structure.structureType).toBe('mindmap')
    expect(sheet.relationships).toEqual([])
  })
})

describe('storage', () => {
  it('round-trips a sheet through IndexedDB unchanged', async () => {
    const sheet = fixtureSheet()
    await writeSheet(sheet.sheetId, sheet)
    const read = await readSheet(sheet.sheetId)
    expect(read).toEqual(sheet)
  })

  it('returns null for an unknown id', async () => {
    await expect(readSheet('does-not-exist')).resolves.toBeNull()
  })

  it('deleteSheet removes the sheet and listSheetIds tracks the store', async () => {
    const a = blankSheet('A')
    const b = blankSheet('B')
    await writeSheet(a.sheetId, a)
    await writeSheet(b.sheetId, b)

    const ids = await listSheetIds()
    expect(ids).toContain(a.sheetId)
    expect(ids).toContain(b.sheetId)

    await deleteSheet(a.sheetId)
    await expect(readSheet(a.sheetId)).resolves.toBeNull()
    await expect(readSheet(b.sheetId)).resolves.toEqual(b)

    const after = await listSheetIds()
    expect(after).not.toContain(a.sheetId)
    expect(after).toContain(b.sheetId)
  })

  it('overwrites an existing sheet on write', async () => {
    const sheet = fixtureSheet()
    await writeSheet(sheet.sheetId, sheet)
    const edited = { ...sheet, title: 'Renamed' }
    await writeSheet(sheet.sheetId, edited)
    await expect(readSheet(sheet.sheetId)).resolves.toEqual(edited)
  })
})

describe('missing IndexedDB', () => {
  it('degrades instead of throwing', async () => {
    const original = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
    try {
      await expect(readSheet('x')).resolves.toBeNull()
      await expect(writeSheet('x', blankSheet('t'))).resolves.toEqual({ ok: false, error: 'Storage is unavailable' })
      await expect(deleteSheet('x')).resolves.toBeUndefined()
      await expect(listSheetIds()).resolves.toEqual([])
    }
    finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true })
    }
  })
})

/**
 * `readSheet` collapses every failure into `null`, which is why a momentary
 * IndexedDB outage used to look exactly like "this sheet does not exist" and a
 * blank map took an existing one's place. `readSheetResult` is the API that
 * keeps the four answers apart; these lock that apart-ness in.
 */
describe('readSheetResult', () => {
  it('reports a stored sheet as ok', async () => {
    const sheet = fixtureSheet()
    await writeSheet(sheet.sheetId, sheet)

    const result = await readSheetResult(sheet.sheetId)
    expect(result.kind).toBe('ok')
    expect(result.kind === 'ok' && result.sheet).toEqual(sheet)
  })

  it('reports an unknown id as missing, not as a failure', async () => {
    const result = await readSheetResult('no-such-sheet')
    expect(result).toEqual({ kind: 'missing' })
  })

  it('reports an unreachable database as unavailable, NOT as missing', async () => {
    const original = globalThis.indexedDB
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true })
    try {
      const result = await readSheetResult('any-id')
      expect(result.kind).toBe('unavailable')
      expect(result.kind === 'unavailable' && result.error).toBeTruthy()
    }
    finally {
      Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true })
    }
  })

  it('reports a record with no readable topics as invalid, NOT as missing', async () => {
    await writeSheet('damaged', { title: 'nothing here' } as unknown as Sheet)

    const result = await readSheetResult('damaged')
    expect(result.kind).toBe('invalid')
  })

  it('aligns a sheetId that disagrees with the key it lives under, and writes it back', async () => {
    const sheet = fixtureSheet()
    // The document claims one identity while living under another: left alone,
    // the next save would write it back under the id it CLAIMS, stranding a
    // copy at the key everything else still reads from.
    await writeSheet('key-a', { ...sheet, sheetId: 'claims-to-be-b' })

    const result = await readSheetResult('key-a')
    expect(result.kind === 'ok' && result.sheet.sheetId).toBe('key-a')

    // Paid for once: the repair is on disk, not just in the returned object.
    const again = await readSheetResult('key-a')
    expect(again.kind === 'ok' && again.sheet.sheetId).toBe('key-a')
    await expect(readSheet('claims-to-be-b')).resolves.toBeNull()
  })
})
