import type { Sheet, Style } from '../mindmap/types'
import type { Chart, ChartCoordinates, ChartItem, RelatedLayer, StoredChart } from '../types'
import { readSheet, writeSheet } from '../mindmap/storage'
import { INLINE_ASSET_BUDGET, optimizeImageBlob, readBlobAsDataUrl, STORED_ASSET_BUDGET } from './files'

const DB_NAME = 'thoughtslibrary-assets'
const DB_VERSION = 2
const STORE_NAME = 'images'
// When each blob was written. The orphan sweep reads charts out of localStorage
// and deletes every blob they do not reference, so a blob written by another
// window a moment ago - whose chart write is still inside its 300ms debounce -
// looks exactly like an orphan. Nothing younger than the grace period below is
// ever collected.
const META_STORE_NAME = 'imageMeta'
const COLLECTION_GRACE_MS = 10 * 60 * 1000
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
  items: Array<ChartItem | null> | undefined,
  transform: (item: ChartItem) => Promise<ChartItem>,
): Promise<Array<ChartItem | null>> {
  // Typed as always present, but stored charts predate the field and an
  // interrupted write can leave it off. Every caller here runs at startup.
  if (!Array.isArray(items)) {
    return Promise.resolve([])
  }

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
      if (!db.objectStoreNames.contains(META_STORE_NAME)) {
        db.createObjectStore(META_STORE_NAME)
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
    // Blob and write time go in together: a blob whose timestamp did not land
    // would look older than the grace period and could be collected while the
    // chart that references it was still being written.
    const transaction = db.transaction([STORE_NAME, META_STORE_NAME], 'readwrite')
    transaction.objectStore(STORE_NAME).put(blob, id)
    transaction.objectStore(META_STORE_NAME).put({ createdAt: Date.now() }, id)

    transaction.oncomplete = () => {
      resolve(id)
    }

    transaction.onerror = () => {
      reject(transaction.error || new Error('Failed to store asset'))
    }

    transaction.onabort = () => {
      reject(transaction.error || new Error('Failed to store asset'))
    }
  })
}

async function dataUrlToBlob(url: string): Promise<Blob> {
  const response = await fetch(url)
  return await response.blob()
}

export async function storeLocalImage(file: Blob): Promise<string> {
  // Where the bytes are going decides how hard they are squeezed. The asset
  // store has room to keep the picture; a data URL in localStorage does not.
  const storable = hasIndexedDb()
  const optimized = await optimizeImageBlob(file, storable ? STORED_ASSET_BUDGET : INLINE_ASSET_BUDGET)

  if (!storable) {
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

export function isRemoteHttpUrl(url?: string | null): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url)
}

/**
 * Copies a remote cover into the asset store and returns its `local-asset://`
 * URL, or null if it could not be fetched.
 *
 * Imported covers are stored as plain remote URLs, which makes every chart a
 * permanent dependency on someone else's server. covers.openlibrary.org rate
 * limits per IP, so a chart with many covers loads them all at once, some come
 * back rejected, and those tiles render as a broken image until the page is
 * reloaded. Adopting the bytes once removes the dependency entirely — and with
 * it the link rot when a URL is eventually retired.
 *
 * A failure here is not an error: the caller keeps the remote URL and the tile
 * carries on working exactly as before. Not every image host allows a
 * cross-origin read, and no chart should be worse off for one that doesn't.
 */
export async function adoptRemoteImage(url: string): Promise<string | null> {
  if (!hasIndexedDb() || !isRemoteHttpUrl(url)) {
    return null
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      return null
    }

    const blob = await response.blob()
    if (!blob.size || !blob.type.startsWith('image/')) {
      return null
    }

    return await storeLocalImage(blob)
  }
  catch {
    // A blocked cross-origin read, an offline machine, or a rate-limited host.
    return null
  }
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

  try {
    const blob = await dataUrlToBlob(url)
    return await storeLocalImage(blob)
  }
  catch (error) {
    // A malformed `data:` URL makes fetch reject, and a full asset store makes
    // the write reject. Neither is a reason to fail the caller: this runs over
    // every chart at startup, behind the gate that keeps the app unrendered, so
    // a rejection here used to leave a permanently blank page with every chart
    // still in storage and no way to reach it. The URL is kept as it was.
    console.error('Could not move an image into the asset store:', error)
    return url
  }
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
export function collectChartAssetIds(chart: Chart | undefined, into: Set<string> = new Set()): Set<string> {
  if (!chart) {
    return into
  }

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

// Every local-asset id a SHEET still points at — the one place that answers
// "what does this sheet reference", the way r-node's referencedAssetIds does.
// The orphan sweep's root set must include these (S3 Part B): the moment a
// topic stores an image, that blob is invisible to collectChartAssetIds, and
// an invisible reference is deleted ten minutes later.
//
// Walks all four image slots and the gallery cells even though S3 authors
// only the top slot: this is the single source of truth for the question, and
// the other slots already exist in the schema waiting for S4. Gallery cells
// carry raw ids rather than URLs, so no prefix to strip there.
export function collectSheetAssetIds(sheet: Sheet | undefined | null, into: Set<string> = new Set()): Set<string> {
  if (!sheet) {
    return into
  }

  const visitStyle = (style?: Style) => {
    if (!style) {
      return
    }
    for (const url of [style.image, style.imageBottom, style.imageLeft, style.imageRight]) {
      const id = url ? extractAssetId(url) : null
      if (id) {
        into.add(id)
      }
    }
    for (const cell of style.gallery?.items ?? []) {
      if (cell.id) {
        into.add(cell.id)
      }
    }
  }

  for (const node of Object.values(sheet.nodes)) {
    visitStyle(node.style)
  }

  return into
}

// When each stored blob was written, for every id that has a record. Blobs
// written before the meta store existed have none and are treated as old.
async function readAssetWriteTimes(db: IDBDatabase): Promise<Map<string, number>> {
  return new Promise((resolve) => {
    const times = new Map<string, number>()

    try {
      const store = db.transaction(META_STORE_NAME, 'readonly').objectStore(META_STORE_NAME)
      const keysRequest = store.getAllKeys()
      const valuesRequest = store.getAll()

      keysRequest.onerror = () => resolve(times)
      valuesRequest.onerror = () => resolve(times)

      valuesRequest.onsuccess = () => {
        const keys = (keysRequest.result as IDBValidKey[]) || []
        const values = (valuesRequest.result as Array<{ createdAt?: number }>) || []

        keys.forEach((key, index) => {
          const createdAt = values[index]?.createdAt
          if (typeof createdAt === 'number') {
            times.set(String(key), createdAt)
          }
        })

        resolve(times)
      }
    }
    catch {
      resolve(times)
    }
  })
}

/**
 * Deletes every stored blob no longer referenced by any chart, and releases the
 * object URLs handed out for them. Deleting a tile or a chart only ever removed
 * the reference, so the blobs accumulated forever with no way to reclaim them.
 *
 * The root set is a snapshot of the charts in localStorage, which makes this a
 * garbage collector that cannot see references still in flight: a blob written
 * moments ago by this window or another one, whose chart write is still inside
 * its debounce, is indistinguishable from an orphan. Anything written within
 * the grace period is therefore left alone - it will still be there for the
 * next sweep, by which time its chart has certainly been written.
 *
 * The caller is responsible for not running this at all while another window is
 * open, since that window's root set is invisible from here entirely.
 */
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

  const writeTimes = await readAssetWriteTimes(db)
  const youngerThanGrace = Date.now() - COLLECTION_GRACE_MS

  const stale = storedIds.filter((id) => {
    if (referencedIds.has(id)) {
      return false
    }

    return (writeTimes.get(id) ?? 0) <= youngerThanGrace
  })

  if (stale.length === 0) {
    return 0
  }

  await new Promise<void>((resolve) => {
    const transaction = db.transaction([STORE_NAME, META_STORE_NAME], 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const metaStore = transaction.objectStore(META_STORE_NAME)
    stale.forEach((id) => {
      store.delete(id)
      metaStore.delete(id)
    })
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
  // An entry written by an older or interrupted build can have no `data` at
  // all. Dereferencing it here threw before the app was rendered, which took
  // out the whole startup pass along with every other chart in it.
  if (!chart || typeof chart !== 'object') {
    return chart
  }

  // Restore any file-carried mindmaps first (a no-op for every live chart —
  // see the gate in restoreChartMindmaps), then move the grid images.
  const chartAfterRestore = await restoreChartMindmaps(chart)

  const target = chartAfterRestore

  const [items, coordinates, relatedLayers] = await Promise.all([
    cloneItems(target.items, persistChartItemAssets),
    cloneCoordinates(target.coordinates, persistChartItemAssets),
    cloneRelatedLayers(target.relatedLayers, persistChartItemAssets),
  ])

  return {
    ...target,
    items,
    coordinates,
    ...(relatedLayers ? { relatedLayers } : {}),
  }
}

export async function inlineChartAssets(chart: Chart): Promise<Chart> {
  if (!chart || typeof chart !== 'object') {
    return chart
  }

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
    data: await inlineChartMindmaps(await inlineChartAssets(chart.data)),
  }
}

// ---------------------------------------------------------------------------
// Mindmaps in the save file (S3 Parts A + C.4)
// ---------------------------------------------------------------------------
// `Chart.mindmaps` holds sheet ids into the mindmaps IndexedDB database, so
// until S3 every exported or file-saved chart carried ids that pointed at
// records which never left the machine — silent live data loss. The rule is
// exactly the one tile covers follow: out-of-line while live (IndexedDB),
// inlined in the file, restored under fresh ids on import.

/**
 * Export side. Reads every sheet named in `chart.mindmaps` and attaches them
 * as `chart.mindmapSheets`; gathers each carried sheet's image references and
 * inlines their bytes as `chart.mindmapAssets`, shared by asset id so a
 * picture used by two maps travels once.
 *
 * A mindmaps entry whose sheet is missing from IndexedDB is skipped, not
 * fatal — and its `mindmaps` entry is dropped with it, so the file never
 * references a sheet it does not carry. A dangling id is what created the
 * original bug. Missing image bytes are likewise skipped: the sheet keeps its
 * reference (it renders as absent, not corrupt) but no bytes are attached.
 *
 * Only ever called from inlineStoredChartAssets — the export choke point both
 * exportCurrentChart and saveChartToFile funnel through. It runs on a clone,
 * never the live chart.
 */
async function inlineChartMindmaps(chart: Chart): Promise<Chart> {
  if (!chart || typeof chart !== 'object') {
    return chart
  }

  const mindmaps = chart.mindmaps
  if (!mindmaps || Object.keys(mindmaps).length === 0) {
    return chart
  }

  const sheets: Record<string, Sheet> = {}
  const keptMindmaps: Record<string, string> = {}
  for (const [itemId, sheetId] of Object.entries(mindmaps)) {
    const sheet = await readSheet(sheetId)
    // A sheet that cannot be read has nothing to inline; carrying the id
    // alone would recreate the empty-map-on-another-machine bug.
    if (!sheet) {
      continue
    }
    sheets[sheetId] = sheet
    keptMindmaps[itemId] = sheetId
  }

  const assets: Record<string, string> = {}
  for (const sheet of Object.values(sheets)) {
    for (const assetId of collectSheetAssetIds(sheet)) {
      if (assetId in assets) {
        continue
      }
      const dataUri = await inlineStoredImageUrl(buildLocalAssetUrl(assetId))
      if (!dataUri) {
        continue
      }
      assets[assetId] = dataUri
    }
  }

  return {
    ...chart,
    ...(Object.keys(keptMindmaps).length > 0 ? { mindmaps: keptMindmaps } : {}),
    ...(Object.keys(sheets).length > 0 ? { mindmapSheets: sheets } : {}),
    ...(Object.keys(assets).length > 0 ? { mindmapAssets: assets } : {}),
  }
}

/**
 * Import side, mirrored against A.3: writes each carried sheet under a
 * freshly generated id, rewrites `chart.mindmaps` to point at it, restores
 * each carried image into the asset store under fresh local ids and rewrites
 * the sheets' Style.image URLs to match, then strips both inline fields so
 * they never reach localStorage.
 *
 * Sheet ids are per-machine IndexedDB keys, not content addresses: importing
 * the same file twice must produce new ids, or the second import overwrites
 * the first one's maps and the user loses a map by opening a file.
 *
 * GATED on `mindmapSheets`/`mindmapAssets` being present (S3 trap 1): only a
 * file ever carries them, while persistChartAssets also runs over every live
 * stored chart at startup — without the gate it would re-key every sheet id
 * on every launch.
 */
async function restoreChartMindmaps(chart: Chart): Promise<Chart> {
  if (!chart || typeof chart !== 'object') {
    return chart
  }

  const carriedSheets = chart.mindmapSheets
  const carriedAssets = chart.mindmapAssets
  if (!carriedSheets && !carriedAssets) {
    return chart
  }

  // Bytes first, so the sheet rewrite below can point at the fresh ids.
  // Keyed by the file's asset id → the freshly written local id; several
  // sheets (and nodes) may share one picture, so each is written once.
  const idMap = new Map<string, string>()
  let missingBytes = 0
  if (carriedAssets) {
    for (const [assetId, dataUri] of Object.entries(carriedAssets)) {
      try {
        const blob = await dataUrlToBlob(dataUri)
        const freshUrl = await storeLocalImage(blob)
        const freshId = extractAssetId(freshUrl)
        if (freshId) {
          idMap.set(assetId, freshId)
        }
        else {
          missingBytes += 1
        }
      }
      catch {
        missingBytes += 1
      }
    }
  }

  const remapImage = (style?: Style): Style | undefined => {
    if (!style || !style.image) {
      return style
    }
    const oldId = extractAssetId(style.image)
    if (!oldId) {
      return style
    }
    const freshId = idMap.get(oldId)
    // Bytes that never travelled keep their reference untouched — a dangling
    // image renders as absent, which beats corrupting the style.
    return freshId ? { ...style, image: buildLocalAssetUrl(freshId) } : style
  }

  const nextMindmaps: Record<string, string> = {}
  if (carriedSheets) {
    for (const [itemId, oldSheetId] of Object.entries(chart.mindmaps || {})) {
      const carried = carriedSheets[oldSheetId]
      // An entry pointing at a sheet the file does not carry stays dropped:
      // restoring it would put a dangling id back into localStorage.
      if (!carried) {
        continue
      }
      const freshId = crypto.randomUUID()
      const clone = structuredClone(carried)
      clone.sheetId = freshId
      for (const node of Object.values(clone.nodes)) {
        node.style = remapImage(node.style) ?? {}
      }
      await writeSheet(freshId, clone)
      nextMindmaps[itemId] = freshId
    }
  }

  if (missingBytes > 0) {
    console.warn(`Imported ${missingBytes} mindmap image(s) whose bytes were missing from the file; their references were left as-is.`)
  }

  const { mindmapSheets: _sheets, mindmapAssets: _assets, ...rest } = chart
  return {
    ...rest,
    ...(Object.keys(nextMindmaps).length > 0 ? { mindmaps: nextMindmaps } : {}),
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
