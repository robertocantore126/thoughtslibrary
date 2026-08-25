import type { Sheet } from '../src/mindmap/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectChartAssetIds,
  collectSheetAssetIds,
  collectUnusedAssets,
  inlineStoredChartAssets,
  persistChartAssets,
  storeLocalImage,
} from '../src/helpers/assets'
import { blankSheet, readSheet, writeSheet } from '../src/mindmap/storage'
import { BackgroundTypes, type Chart } from '../src/types'
import 'fake-indexeddb/auto'

// The asset store's own database names/stores, mirrored here so the grace
// period can be bypassed by ageing a blob's write time directly (assets.ts
// deliberately does not export its internals).
const ASSET_DB = 'thoughtslibrary-assets'

function baseChart(): Chart {
  return {
    backgroundUrl: '',
    backgroundColor: '#000000',
    backgroundType: BackgroundTypes.Color,
    title: 'Save format',
    items: [],
    size: { x: 3, y: 3 },
    showNumbers: false,
    showTitles: true,
    gap: 4,
    roundCorners: false,
  }
}

async function storedSheet(title: string): Promise<Sheet> {
  const sheet = blankSheet(title)
  await writeSheet(sheet.sheetId, sheet)
  return sheet
}

// Reads the asset store directly: "is the bytes still there". Deliberately
// not routed through inlineStoredImageUrl, whose data-URI step needs
// FileReader — unavailable under the node test runner.
function assetBlobExists(id: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      try {
        const getRequest = db.transaction('images', 'readonly').objectStore('images').get(id)
        getRequest.onsuccess = () => {
          db.close()
          resolve(getRequest.result != null)
        }
        getRequest.onerror = () => {
          db.close()
          reject(getRequest.error)
        }
      }
      catch (error) {
        db.close()
        reject(error)
      }
    }
  })
}

function assetIdOf(url: string): string {
  return url.slice('local-asset://'.length)
}

// Marks every asset blob older than the sweep's ten-minute grace period, so a
// test can run a real collection without waiting. Opens the same DB/version
// the asset helper uses; fake-indexeddb serves both connections.
function ageAllAssets(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      try {
        const tx = db.transaction('imageMeta', 'readwrite')
        const store = tx.objectStore('imageMeta')
        const keysRequest = store.getAllKeys()
        keysRequest.onsuccess = () => {
          for (const key of keysRequest.result) {
            store.put({ createdAt: Date.now() - 11 * 60 * 1000 }, key)
          }
        }
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => {
          db.close()
          reject(tx.error)
        }
      }
      catch (error) {
        db.close()
        reject(error)
      }
    }
  })
}

// Fresh storage per test. Both helpers cache their connection but listen for
// versionchange (deleteDatabase fires it) and drop the handle, so each test
// opens a newly created database pair.
afterEach(async () => {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('thoughtslibrary-mindmaps')
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(ASSET_DB)
    req.onsuccess = req.onerror = req.onblocked = () => resolve()
  })
})

describe('part A — export inlines mindmap sheets', () => {
  it('attaches every named sheet as mindmapSheets and keeps the ids', async () => {
    const a = await storedSheet('Trip')
    const b = await storedSheet('Reading')

    const chart = baseChart()
    chart.mindmaps = { 'tile-a': a.sheetId, 'tile-b': b.sheetId }

    const exported = await inlineStoredChartAssets({ timestamp: 1, data: chart })

    expect(Object.keys(exported.data.mindmapSheets ?? {}).sort()).toEqual([a.sheetId, b.sheetId].sort())
    expect(exported.data.mindmapSheets?.[a.sheetId]?.title).toBe('Trip')
    expect(exported.data.mindmapSheets?.[b.sheetId]?.title).toBe('Reading')
    expect(exported.data.mindmaps).toEqual({ 'tile-a': a.sheetId, 'tile-b': b.sheetId })
  })

  it('drops a mindmaps entry whose sheet is missing instead of exporting a dangling id', async () => {
    const a = await storedSheet('Kept')

    const chart = baseChart()
    chart.mindmaps = { 'tile-a': a.sheetId, 'tile-b': 'no-such-sheet' }

    const exported = await inlineStoredChartAssets({ timestamp: 1, data: chart })

    expect(exported.data.mindmaps).toEqual({ 'tile-a': a.sheetId })
    expect(Object.keys(exported.data.mindmapSheets ?? {})).toEqual([a.sheetId])
  })

  it('leaves a chart with no mindmaps untouched (adds no keys)', async () => {
    const chart = baseChart()
    const exported = await inlineStoredChartAssets({ timestamp: 1, data: chart })

    expect(exported.data).toEqual(chart)
    expect('mindmapSheets' in exported.data).toBe(false)
    expect('mindmapAssets' in exported.data).toBe(false)
  })
})

describe('part A — import restores sheets under fresh ids', () => {
  it('rewrites mindmaps to freshly generated ids and strips the inline copies', async () => {
    const sheet = await storedSheet('Imported')
    const chart = baseChart()
    chart.mindmaps = { 'tile-1': sheet.sheetId }

    const exported = await inlineStoredChartAssets({ timestamp: 1, data: chart })
    const restored = await persistChartAssets(structuredClone(exported.data))

    expect(restored.mindmapSheets).toBeUndefined()
    expect(restored.mindmapAssets).toBeUndefined()

    const freshId = restored.mindmaps?.['tile-1']
    expect(freshId).toBeTruthy()
    expect(freshId).not.toBe(sheet.sheetId)

    const reopened = await readSheet(freshId!)
    expect(reopened?.title).toBe('Imported')
    expect(reopened?.sheetId).toBe(freshId)
  })

  it('gives a second import of the same file its own ids', async () => {
    const sheet = await storedSheet('Twice')
    const chart = baseChart()
    chart.mindmaps = { 'tile-1': sheet.sheetId }

    const exported = await inlineStoredChartAssets({ timestamp: 1, data: chart })

    const first = await persistChartAssets(structuredClone(exported.data))
    const second = await persistChartAssets(structuredClone(exported.data))

    const id1 = first.mindmaps?.['tile-1']
    const id2 = second.mindmaps?.['tile-1']
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
    expect(id1).not.toBe(sheet.sheetId)
    expect(id2).not.toBe(sheet.sheetId)
    expect((await readSheet(id1!))?.title).toBe('Twice')
    expect((await readSheet(id2!))?.title).toBe('Twice')
  })

  it('does not mutate the chart being exported (restore runs on a copy)', async () => {
    const sheet = await storedSheet('Original')
    const chart = baseChart()
    chart.mindmaps = { 'tile-1': sheet.sheetId }

    const before = structuredClone(chart)
    await inlineStoredChartAssets({ timestamp: 1, data: chart })

    expect(chart).toEqual(before)
  })
})

describe('trap 1 — the autosave/startup pass must not re-key live sheets', () => {
  it('leaves mindmaps ids alone when mindmapSheets is absent (the live-chart shape)', async () => {
    const sheet = await storedSheet('Live')
    const chart = baseChart()
    chart.mindmaps = { 'tile-1': sheet.sheetId }

    const persisted = await persistChartAssets(structuredClone(chart))

    // This runs over EVERY stored chart on every launch. Re-keying here would
    // rewrite sheet ids on each startup and orphan the maps the overlays point at.
    expect(persisted.mindmaps).toEqual({ 'tile-1': sheet.sheetId })
    expect('mindmapSheets' in persisted).toBe(false)
    expect(await readSheet(sheet.sheetId)).not.toBeNull()
  })

  it('strips stray mindmapSheets/mindmapAssets even without a mindmaps rewrite', async () => {
    const chart = baseChart()
    // A malformed file that carries assets but no sheets must still not reach
    // localStorage holding data URIs.
    chart.mindmapAssets = { 'some-asset': 'data:image/png;base64,AAA' }

    const persisted = await persistChartAssets(structuredClone(chart))

    expect(persisted.mindmapAssets).toBeUndefined()
    expect('mindmapSheets' in persisted).toBe(false)
  })
})

describe('part B — the orphan sweep protects sheet images', () => {
  it('an image referenced by a mindmap topic survives a sweep with the grace period bypassed', async () => {
    // The deletion-style test the brief asks for: if the sweep cannot see
    // sheet references, THIS assertion fails ten simulated minutes later.
    const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })
    const url = await storeLocalImage(blob)
    expect(url.startsWith('local-asset://')).toBe(true)
    await ageAllAssets()

    const sheet = await storedSheet('With image')
    const rootNode = sheet.nodes[sheet.rootNodeId]
    rootNode.style.image = url
    await writeSheet(sheet.sheetId, sheet)

    const chart = baseChart()
    chart.mindmaps = { 'tile-1': sheet.sheetId }

    // The root set exactly as LocalStorageWatcher builds it after this change:
    // chart references plus every referenced sheet's references.
    const referenced = collectChartAssetIds(chart)
    const loaded = await readSheet(sheet.sheetId)
    expect(loaded).not.toBeNull()
    collectSheetAssetIds(loaded!, referenced)

    await collectUnusedAssets(referenced)

    // Still there: the bytes survive in the store.
    expect(await assetBlobExists(assetIdOf(url))).toBe(true)
  })

  it('still collects genuinely orphaned blobs (the sweep did not stop working)', async () => {
    const orphanUrl = await storeLocalImage(new Blob([new Uint8Array([1])], { type: 'image/png' }))
    const keptUrl = await storeLocalImage(new Blob([new Uint8Array([2])], { type: 'image/png' }))
    await ageAllAssets()

    // Only `keptUrl` is referenced, and through a tile cover — the ordinary path.
    const chart = baseChart()
    chart.items = [{ id: 'i1', title: 'Tile', coverURL: keptUrl }]
    const referenced = collectChartAssetIds(chart)
    await collectUnusedAssets(referenced)

    expect(await assetBlobExists(assetIdOf(orphanUrl))).toBe(false)
    expect(await assetBlobExists(assetIdOf(keptUrl))).toBe(true)
  })

  it('collectSheetAssetIds finds image references wherever they sit on a node', async () => {
    const sheet = blankSheet('Refs')
    const root = sheet.nodes[sheet.rootNodeId]
    root.style.image = 'local-asset://aaa'
    root.style.imageBottom = 'local-asset://bbb'
    root.style.imageLeft = 'local-asset://ccc'
    root.style.imageRight = ''
    root.style.gallery = { items: [{ id: 'ddd' }] }

    const into = new Set<string>()
    collectSheetAssetIds(sheet, into)

    expect([...into].sort()).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
  })

  it('collectSheetAssetIds tolerates an absent sheet and an empty into-set default', () => {
    expect(collectSheetAssetIds(null).size).toBe(0)
    expect(collectSheetAssetIds(undefined).size).toBe(0)
  })
})
