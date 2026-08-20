import type { Chart, ChartCoordinates, ChartItem, RelatedLayer, StoredChart } from '../types'
import { optimizeImageBlob, readBlobAsDataUrl } from './files'

const DB_NAME = 'thoughtslibrary-assets'
const DB_VERSION = 1
const STORE_NAME = 'images'
const LOCAL_ASSET_PREFIX = 'local-asset://'
const objectUrlCache = new Map<string, string>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function isDataUrl(url: string): boolean {
  return url.startsWith('data:')
}

function cloneChartItem(item: ChartItem, updates: Partial<ChartItem>): ChartItem {
  return {
    ...item,
    ...updates,
  }
}

function cloneCoordinates(
  coordinates: ChartCoordinates | undefined,
  transform: (item: ChartItem) => Promise<ChartItem>,
): Promise<ChartCoordinates | undefined> {
  if (!coordinates) {
    return Promise.resolve(undefined)
  }

  return Promise.all(
    Object.entries(coordinates).map(async ([key, item]) => [key, await transform(item)] as const),
  ).then(entries => Object.fromEntries(entries))
}

function cloneItems(
  items: Array<ChartItem | null>,
  transform: (item: ChartItem) => Promise<ChartItem>,
): Promise<Array<ChartItem | null>> {
  return Promise.all(items.map(async item => (item ? await transform(item) : null)))
}

function cloneRelatedLayers(
  relatedLayers: Record<string, RelatedLayer> | undefined,
  transform: (item: ChartItem) => Promise<ChartItem>,
): Promise<Record<string, RelatedLayer> | undefined> {
  if (!relatedLayers) {
    return Promise.resolve(undefined)
  }

  return Promise.all(
    Object.entries(relatedLayers).map(async ([parentId, layer]) => [parentId, await cloneCoordinates(layer, transform)] as const),
  ).then(entries => Object.fromEntries(entries))
}

function openAssetDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null)
  }

  // One shared connection for the lifetime of the page. This used to open a new
  // one on every single read and write and never close any of them.
  if (dbPromise) {
    return dbPromise
  }

  dbPromise = new Promise<IDBDatabase | null>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      dbPromise = null
      reject(request.error || new Error('Failed to open asset database'))
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // A version change elsewhere invalidates this handle; drop it so the next
      // caller opens a fresh one instead of using a closing connection.
      db.onclose = () => {
        dbPromise = null
      }
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
  })

  return dbPromise
}

function extractAssetId(url: string): string | null {
  return url.startsWith(LOCAL_ASSET_PREFIX) ? url.slice(LOCAL_ASSET_PREFIX.length) : null
}

export function isLocalAssetUrl(url?: string | null): boolean {
  return typeof url === 'string' && url.startsWith(LOCAL_ASSET_PREFIX)
}

export function buildLocalAssetUrl(id: string): string {
  return `${LOCAL_ASSET_PREFIX}${id}`
}

async function readAssetBlob(id: string): Promise<Blob | null> {
  const db = await openAssetDb()
  if (!db) {
    return null
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(id)

    request.onerror = () => {
      reject(request.error || new Error('Failed to read asset'))
    }

    request.onsuccess = () => {
      resolve((request.result as Blob | undefined) || null)
    }
  })
}

async function writeAssetBlob(blob: Blob): Promise<string> {
  const db = await openAssetDb()
  if (!db) {
    throw new Error('IndexedDB is not available')
  }

  const id = crypto.randomUUID()

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.put(blob, id)

    request.onerror = () => {
      reject(request.error || new Error('Failed to store asset'))
    }

    request.onsuccess = () => {
      resolve(id)
    }
  })
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  return await response.blob()
}

export async function storeLocalImage(file: Blob): Promise<string> {
  const optimized = await optimizeImageBlob(file)

  if (!hasIndexedDb()) {
    return readBlobAsDataUrl(optimized)
  }

  const id = await writeAssetBlob(optimized)
  return buildLocalAssetUrl(id)
}

export async function resolveStoredImageUrl(url?: string | null): Promise<string> {
  if (!url) {
    return ''
  }

  if (!isLocalAssetUrl(url)) {
    return url
  }

  const assetId = extractAssetId(url)
  if (!assetId) {
    return ''
  }

  const cachedUrl = objectUrlCache.get(assetId)
  if (cachedUrl) {
    return cachedUrl
  }

  const blob = await readAssetBlob(assetId)
  if (!blob) {
    return ''
  }

  const objectUrl = URL.createObjectURL(blob)
  objectUrlCache.set(assetId, objectUrl)
  return objectUrl
}

export async function inlineStoredImageUrl(url?: string | null): Promise<string> {
  if (!url) {
    return ''
  }

  if (!isLocalAssetUrl(url)) {
    return url
  }

  const assetId = extractAssetId(url)
  if (!assetId) {
    return ''
  }

  const blob = await readAssetBlob(assetId)
  if (!blob) {
    return ''
  }

  return await readBlobAsDataUrl(blob)
}

export async function persistImageUrl(url?: string | null): Promise<string> {
  if (!url) {
    return ''
  }

  if (isLocalAssetUrl(url)) {
    return url
  }

  if (!isDataUrl(url)) {
    return url
  }

  if (!hasIndexedDb()) {
    return url
  }

  const blob = await dataUrlToBlob(url)
  return await storeLocalImage(blob)
}

async function persistChartItemAssets(item: ChartItem): Promise<ChartItem> {
  return cloneChartItem(item, {
    coverURL: await persistImageUrl(item.coverURL),
    attachmentURL: await persistImageUrl(item.attachmentURL),
  })
}

async function inlineChartItemAssets(item: ChartItem): Promise<ChartItem> {
  return cloneChartItem(item, {
    coverURL: await inlineStoredImageUrl(item.coverURL),
    attachmentURL: await inlineStoredImageUrl(item.attachmentURL),
  })
}

// Every local-asset id a chart still points at, across the grid, the flat items
// array and every related layer.
export function collectChartAssetIds(chart: Chart, into: Set<string> = new Set()): Set<string> {
  const visit = (item?: ChartItem | null) => {
    if (!item) {
      return
    }
    for (const url of [item.coverURL, item.attachmentURL]) {
      const id = url ? extractAssetId(url) : null
      if (id) {
        into.add(id)
      }
    }
  }

  chart.items?.forEach(visit)
  Object.values(chart.coordinates || {}).forEach(visit)
  Object.values(chart.relatedLayers || {}).forEach(layer => Object.values(layer).forEach(visit))

  return into
}

// Deletes every stored blob no longer referenced by any chart, and releases the
// object URLs handed out for them. Deleting a tile or a chart only ever removed
// the reference, so the blobs accumulated forever with no way to reclaim them.
export async function collectUnusedAssets(referencedIds: Set<string>): Promise<number> {
  const db = await openAssetDb()
  if (!db) {
    return 0
  }

  const storedIds = await new Promise<string[]>((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys()
    request.onsuccess = () => resolve((request.result as IDBValidKey[]).map(String))
    request.onerror = () => resolve([])
  })

  const stale = storedIds.filter(id => !referencedIds.has(id))
  if (stale.length === 0) {
    return 0
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    stale.forEach(id => store.delete(id))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
  })

  for (const id of stale) {
    const objectUrl = objectUrlCache.get(id)
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrlCache.delete(id)
    }
  }

  return stale.length
}

export async function persistChartAssets(chart: Chart): Promise<Chart> {
  const [items, coordinates, relatedLayers] = await Promise.all([
    cloneItems(chart.items, persistChartItemAssets),
    cloneCoordinates(chart.coordinates, persistChartItemAssets),
    cloneRelatedLayers(chart.relatedLayers, persistChartItemAssets),
  ])

  return {
    ...chart,
    items,
    coordinates,
    ...(relatedLayers ? { relatedLayers } : {}),
  }
}

export async function inlineChartAssets(chart: Chart): Promise<Chart> {
  const [items, coordinates, relatedLayers] = await Promise.all([
    cloneItems(chart.items, inlineChartItemAssets),
    cloneCoordinates(chart.coordinates, inlineChartItemAssets),
    cloneRelatedLayers(chart.relatedLayers, inlineChartItemAssets),
  ])

  return {
    ...chart,
    items,
    coordinates,
    ...(relatedLayers ? { relatedLayers } : {}),
  }
}

export async function inlineStoredChartAssets(chart: StoredChart): Promise<StoredChart> {
  return {
    ...chart,
    data: await inlineChartAssets(chart.data),
  }
}

export interface ExportAsset {
  /** File name, unique within the export and safe to use as a path segment. */
  name: string
  blob: Blob
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
}

// A cover the app serves itself, like the `/thought_tile.svg` thought icon.
// These resolve only against the running app, so a standalone export has to
// carry them rather than keep the path.
function isAppRelativeUrl(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//')
}

function absoluteAppUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href
  }
  catch {
    return url
  }
}

async function fetchAppAsset(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url)
    return response.ok ? await response.blob() : null
  }
  catch {
    return null
  }
}

/**
 * Gathers the stored assets an export needs, reading each distinct one exactly
 * once and handing back the chart with its URLs pointing at them.
 *
 * `inlineChartAssets` walks `items`, `coordinates` and `relatedLayers`
 * separately with no cache, so every cover is read out of IndexedDB and
 * base64-encoded once per *reference* — twice over for each grid tile, since
 * `items` and `coordinates` hold the same items. Exports draw the grid from
 * `items`, so `coordinates` is dropped rather than inlined.
 *
 * Assets stay as blobs instead of becoming data URLs: a data URL is repeated in
 * full at every `<img src>` that uses it and costs a third again in base64, so
 * a chart with a few thousand tiles built a document hundreds of megabytes
 * long. `toUrl` turns each asset into whatever reference the caller can serve
 * it from — a file beside the document, or an object URL.
 */
export async function collectChartExportAssets(
  chart: Chart,
  toUrl: (asset: ExportAsset) => string,
): Promise<{ chart: Chart, assets: ExportAsset[] }> {
  const assets: ExportAsset[] = []
  const resolved = new Map<string, Promise<string>>()

  const resolve = (url?: string | null): Promise<string> => {
    if (!url) {
      return Promise.resolve('')
    }

    // Remote and data URLs already resolve on their own wherever the document
    // is opened; stored assets and the app's own bundled ones do not.
    if (!isLocalAssetUrl(url) && !isAppRelativeUrl(url)) {
      return Promise.resolve(url)
    }

    const cached = resolved.get(url)
    if (cached) {
      return cached
    }

    const pending = (async () => {
      const blob = isLocalAssetUrl(url)
        ? await readAssetBlob(extractAssetId(url) || '')
        : await fetchAppAsset(url)

      if (!blob) {
        // An app asset that could not be read is still worth pointing at
        // absolutely; a missing stored one has nothing left to point at.
        return isAppRelativeUrl(url) ? absoluteAppUrl(url) : ''
      }

      const asset: ExportAsset = {
        name: `a${assets.length}.${MIME_EXTENSIONS[blob.type] || 'bin'}`,
        blob,
      }
      assets.push(asset)
      return toUrl(asset)
    })()

    resolved.set(url, pending)
    return pending
  }

  const resolveItem = async (item: ChartItem): Promise<ChartItem> => cloneChartItem(item, {
    coverURL: await resolve(item.coverURL),
    attachmentURL: await resolve(item.attachmentURL),
  })

  // Each pass resolves concurrently, so names follow completion order rather
  // than a stable sequence — fine, since names only need to be unique within
  // this one document.
  const items = await cloneItems(chart.items, resolveItem)
  const relatedLayers = await cloneRelatedLayers(chart.relatedLayers, resolveItem)
  const backgroundUrl = await resolve(chart.backgroundUrl)

  const { coordinates: _coordinates, ...rest } = chart

  return {
    chart: {
      ...rest,
      items,
      backgroundUrl,
      ...(relatedLayers ? { relatedLayers } : {}),
    },
    assets,
  }
}
