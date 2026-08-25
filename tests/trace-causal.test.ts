/**
 * The test the tracer exists to pass.
 *
 * Not "does it record events" — the core tests cover that. This asks the only
 * question that matters about a flight recorder: given one exported trace of a
 * race, and nothing else, can the causal sequence be reconstructed without
 * reproducing the bug?
 *
 * The race here is the real one this codebase produced: two opens overlapping
 * inside a single IndexedDB round trip, where both reads succeed and the loser
 * is invisible in a flat log because nothing about it looks like a failure.
 */

import type { Sheet } from '../src/mindmap/types'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { causalChain, clearEvents, events, formatEvent, setLevel } from '../src/dev/traceCore'
import { useMindmapStore } from '../src/mindmap/store'

vi.mock('../src/mindmap/layout', () => ({
  layoutSheet: vi.fn(),
}))

vi.mock('../src/mindmap/storage', async () => {
  const core = await import('../src/dev/traceCore')
  return {
    readSheetResult: vi.fn(),
    listSheetIds: vi.fn(),
    deleteSheet: vi.fn(),
    // The real writeSheet emits its own span; the double keeps that, because
    // the whole point is that the trace shows the write under its cause.
    writeSheet: vi.fn(async (id: string, sheet: Sheet, parentId?: string) => {
      const span = core.beginOp('WRITE', 'persist', { key: id }, parentId)
      if (sheet.sheetId !== id) {
        core.emit('persist', 'persistence:identity-mismatch', {
          storageKey: id,
          documentSheetId: sheet.sheetId,
        }, { traceId: span.id, phase: 'error', min: 'error' })
      }
      span.end({ ok: true })
      return { ok: true }
    }),
    blankSheet: vi.fn((title: string) => makeSheet(`blank-${Math.random().toString(36).slice(2, 7)}`, title)),
  }
})

function makeSheet(sheetId: string, title: string): Sheet {
  return {
    sheetId,
    title,
    rootNodeId: 'root',
    nodes: {
      root: {
        id: 'root',
        type: 'central',
        parentId: null,
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
      },
    },
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    structure: { structureType: 'mindmap', spacing: 180, levelSpacing: 60 },
    presentation: {},
  } as unknown as Sheet
}

/** A read that resolves only when the test releases it. */
function deferredRead(sheetId: string) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    release,
    result: gate.then(() => ({ kind: 'ok' as const, sheet: makeSheet(sheetId, sheetId) })),
  }
}

const reachedTheRead = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  setActivePinia(createPinia())
  clearEvents()
  setLevel('info')
})

describe('reconstructing a race from the trace alone', () => {
  it('shows which open won, which was overtaken, and in what order', async () => {
    const { readSheetResult } = await import('../src/mindmap/storage')
    const slow = deferredRead('sheet-A')
    const fast = deferredRead('sheet-B')
    vi.mocked(readSheetResult)
      .mockReturnValueOnce(slow.result)
      .mockReturnValueOnce(fast.result)

    const store = useMindmapStore()
    const first = store.open('sheet-A')
    await reachedTheRead()
    const second = store.open('sheet-B')

    fast.release()
    await second
    slow.release()
    await first

    // ---- from here on, only the trace is consulted ----
    const recorded = events()
    const opens = recorded.filter(e => e.what === 'open' && e.phase === 'start')
    expect(opens).toHaveLength(2)

    // Order of observation is settled by seq, not by timestamp: both opens
    // start inside the same millisecond.
    expect(opens[0].seq).toBeLessThan(opens[1].seq)
    const [openA, openB] = opens.map(e => e.traceId as string)

    const staleEvents = recorded.filter(e => e.phase === 'stale')
    expect(staleEvents).toHaveLength(1)
    expect(staleEvents[0].traceId).toBe(openA)
    expect(staleEvents[0].detail).toMatchObject({ at: 'after-read', requested: 'sheet-A' })

    // The winner published; the loser never did.
    const published = recorded.filter(e => e.phase === 'end' && e.what === 'open')
    expect(published.map(e => e.traceId)).toEqual([openB])

    // And the loser's read genuinely SUCCEEDED — which is what makes this
    // invisible without the tracer: nothing in it looks like a failure.
    const loserRead = causalChain(openA).find(e => e.what === 'read:end')
    expect(loserRead?.detail).toMatchObject({ kind: 'ok' })
  })

  it('puts the write under the operation that caused it', async () => {
    const { readSheetResult } = await import('../src/mindmap/storage')
    vi.mocked(readSheetResult).mockResolvedValue({ kind: 'missing' })

    const store = useMindmapStore()
    const result = await store.open('gone')
    expect(result.ok).toBe(true)

    const openId = events().find(e => e.what === 'open' && e.phase === 'start')?.traceId as string
    const chain = causalChain(openId)

    // "What caused this write?" is answerable from the chain alone.
    const write = chain.find(e => e.what === 'write' && e.phase === 'start')
    expect(write).toBeDefined()
    expect(write?.parentId).toBe(openId)
  })

  it('flags a write whose key is not the document id, at the moment it happens', async () => {
    const { readSheetResult, writeSheet } = await import('../src/mindmap/storage')
    vi.mocked(readSheetResult).mockResolvedValue({ kind: 'missing' })

    const store = useMindmapStore()
    await store.open('x')

    // A sheet saved under someone else's key: the divergence this codebase
    // could previously only discover long afterwards.
    await writeSheet('key-a', makeSheet('claims-to-be-b', 'Divergent'))

    const mismatch = events().find(e => e.what === 'persistence:identity-mismatch')
    expect(mismatch).toBeDefined()
    expect(mismatch?.detail).toMatchObject({ storageKey: 'key-a', documentSheetId: 'claims-to-be-b' })
  })

  it('renders the chain as readable lines, ordered by sequence', async () => {
    const { readSheetResult } = await import('../src/mindmap/storage')
    vi.mocked(readSheetResult).mockResolvedValue({ kind: 'missing' })

    const store = useMindmapStore()
    await store.open('some-sheet')

    const openId = events().find(e => e.what === 'open' && e.phase === 'start')?.traceId as string
    const lines = causalChain(openId).map(formatEvent)

    expect(lines[0]).toContain(`[${openId}]`)
    expect(lines.join('\n')).toContain('write')
    const seqs = causalChain(openId).map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })
})
