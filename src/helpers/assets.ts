import type { Chart, ChartCoordinates, ChartItem, StoredChart } from '../types'
import { optimizeImageBlob, readBlobAsDataUrl } from './files'

const DB_NAME = 'thoughtslibrary-assets'
const DB_VERSION = 1
const STORE_NAME = 'images'
const LOCAL_ASSET_PREFIX = 'local-asset://'
const objectUrlCache = new Map<string, string>()

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

function openAssetDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null)
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(request.error || new Error('Failed to open asset database'))
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }
  })
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

export async function persistChartAssets(chart: Chart): Promise<Chart> {
  const [items, coordinates] = await Promise.all([
    cloneItems(chart.items, persistChartItemAssets),
    cloneCoordinates(chart.coordinates, persistChartItemAssets),
  ])

  return {
    ...chart,
    items,
    coordinates,
  }
}

export async function inlineChartAssets(chart: Chart): Promise<Chart> {
  const [items, coordinates] = await Promise.all([
    cloneItems(chart.items, inlineChartItemAssets),
    cloneCoordinates(chart.coordinates, inlineChartItemAssets),
  ])

  return {
    ...chart,
    items,
    coordinates,
  }
}

export async function inlineStoredChartAssets(chart: StoredChart): Promise<StoredChart> {
  return {
    ...chart,
    data: await inlineChartAssets(chart.data),
  }
}
