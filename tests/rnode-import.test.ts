import { describe, expect, it } from 'vitest'
import { importRnode } from '../src/helpers/rnodeImport'
import { readSheet } from '../src/mindmap/storage'
import 'fake-indexeddb/auto'

/**
 * A minimal but representative RnodeDocument, mirroring the shape of the real
 * files in Downloads (esempio.rnode.json: schemaVersion 0.1.0, a sheets array
 * whose [0] is a full Sheet carrying a nodes record and a resolving root).
 * Unit tests must not depend on a machine-local path, so the doc is inline;
 * the real 37-topic file is exercised live against the actual app in M4's
 * integration check.
 */
function rnodeDoc(): string {
  return JSON.stringify({
    schemaVersion: '0.1.0',
    documentId: 'doc-32',
    title: 'Roadmap',
    sheets: [
      {
        sheetId: 'file-sheet-abc',
        title: 'Roadmap',
        structure: {
          structureType: 'mindmap',
          orientation: 'horizontal',
          spacing: 180,
          branchSpacing: 14,
          padding: 18,
          compactMode: false,
          autoBalance: true,
          freePositioningBranches: false,
          allowManualPositioning: true,
          connectorStyle: 'curved',
        },
        rootNodeId: 'root',
        nodes: {
          root: {
            id: 'root',
            type: 'central',
            parentId: null,
            childrenIds: ['a'],
            title: 'Root',
            position: { x: 0, y: 0, manual: false },
            style: {},
            collapsed: false,
            labels: [],
            markers: [],
            notes: '',
            task: null,
            metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
          },
          a: {
            id: 'a',
            type: 'main',
            parentId: 'root',
            childrenIds: [],
            title: 'Image topic',
            // An image id with no bytes on this machine — must survive the import
            // untouched so a later stage can resolve it (M4: do not strip).
            style: { image: 'sha256-deadbeef' },
            position: { x: 0, y: 0, manual: false },
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
        attachments: [{ id: 'sha256-deadbeef', mime: 'image/png', w: 100, h: 100, bytes: 1234 }],
        comments: [],
        presentation: {},
      },
    ],
  })
}

describe('rnode import — happy path', () => {
  it('imports sheets[0] under a fresh id and returns its metadata', async () => {
    const result = await importRnode(rnodeDoc())
    expect(result.nodeCount).toBe(2)
    expect(result.title).toBe('Roadmap')
    expect(result.sheetId).toBeTruthy()
    expect(result.sheetId).not.toBe('file-sheet-abc') // never reuse the file's id
  })

  it('writes a sheet that reads back equal to the source, with the fresh id', async () => {
    const result = await importRnode(rnodeDoc())
    const stored = await readSheet(result.sheetId)
    expect(stored).not.toBeNull()
    expect(stored!.sheetId).toBe(result.sheetId)
    expect(stored!.nodes.a.title).toBe('Image topic')
    // Image references survive intact — not silently stripped.
    expect(stored!.nodes.a.style.image).toBe('sha256-deadbeef')
    expect(stored!.attachments[0].id).toBe('sha256-deadbeef')
    expect(stored!.rootNodeId).toBe('root')
  })
})

describe('rnode import — validation', () => {
  it('rejects text that is not JSON at all', async () => {
    await expect(importRnode('this is not json {')).rejects.toThrow(/not valid JSON/i)
  })

  it('rejects a document with no sheets', async () => {
    await expect(importRnode('{"title":"nope"}')).rejects.toThrow(/no sheets/i)
  })

  it('rejects a sheet whose rootNodeId does not resolve', async () => {
    const bad = rnodeDoc().replace('"rootNodeId":"root"', '"rootNodeId":"missing"')
    await expect(importRnode(bad)).rejects.toThrow(/no valid sheet/i)
  })

  it('rejects an unrelated schema major', async () => {
    const bad = rnodeDoc().replace('"schemaVersion":"0.1.0"', '"schemaVersion":"9.0.0"')
    await expect(importRnode(bad)).rejects.toThrow(/schema version/i)
  })

  it('accepts an absent schemaVersion (a compatible doc that simply omits it)', async () => {
    const noVersion = rnodeDoc().replace(/"schemaVersion":"0\.1\.0",/, '')
    const result = await importRnode(noVersion)
    expect(result.nodeCount).toBe(2)
  })
})
