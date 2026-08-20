/* eslint-disable no-alert */

// Functions related to importing and exporting charts

import type { Chart, ChartItem, StoredChart, StoredCharts, StoredPremigrationChart } from '../types'
import { MAX_CHART_DIMENSION, useStore } from '../store'
import { BackgroundTypes } from '../types'
import { collectChartExportAssets, inlineStoredChartAssets, persistChartAssets } from './assets'
import { forceRefresh } from './chart'
import { type ExportTrace, startExportTrace, summariseChart } from './exportTrace'
import { ensureWritePermission, getRememberedFileHandle, rememberFileHandle, type StoredFileHandle } from './fileHandles'
import { appendChart, findByUuid, getActiveChart, getActiveChartUuid, getNewestChartUuid, getRememberedChartFilePath, migrateChart, rememberChartFilePath, setActiveChart, updateStoredChart } from './localStorage'
import { renderMarkdown } from './markdown'
import { renderFrameToPdf } from './pdfFromDom'
import { buildPrintDocument, paperSizePx } from './printDocument'

// The live Pinia store is the source of truth. Reading the chart back out of
// localStorage races the debounced write in LocalStorageWatcher, so a save or
// export issued right after typing would capture the previous version.
function getActiveChartForOutput(): StoredChart {
  const stored = getActiveChart()

  return {
    timestamp: stored?.timestamp ?? Date.now(),
    data: useStore().chart,
  }
}

function getWindowApi() {
  return (window as Window & typeof globalThis & {
    electronAPI?: {
      saveChartFile: (payload: {
        filePath?: string
        suggestedName?: string
        content: string
        mode: 'save' | 'save-as'
      }) => Promise<{
        success: boolean
        canceled?: boolean
        filePath?: string
        error?: string
      }>
      readChartFile?: (filePath: string) => Promise<{
        success: boolean
        content?: string | null
        error?: string
      }>
      getPathForFile?: (file: File) => string
    }
  }).electronAPI
}

function normalizeChartTitle(title: string) {
  return (title || 'chart')
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/(^-|-$)/g, '') || 'chart'
}

function asBuffer(data: Uint8Array) {
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
}

async function unzlib(data: Uint8Array) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(asBuffer(data))
      controller.close()
    },
  }).pipeThrough(new DecompressionStream('deflate') as never)

  return new Uint8Array(await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer())
}

async function zlib(data: Uint8Array) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(asBuffer(data))
      controller.close()
    },
  }).pipeThrough(new CompressionStream('deflate') as never)

  return new Uint8Array(await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer())
}

function downloadChartData(data: string, title: string, timestamp: number) {
  const blob = new Blob([data])

  const blobUrl = URL.createObjectURL(blob)

  const link = document.createElement('a')

  link.href = blobUrl
  link.download = `${title || `Untitled ${timestamp}`}.topster`
  document.body.appendChild(link)

  link.click()
  link.remove()
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''

  for (let i = 0; i < bytes.length; i += 0x8000) {
    const chunk = bytes.subarray(i, i + 0x8000)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
}

function base64ToBytes(text: string): Uint8Array {
  const decoded = atob(text.trim())

  if (/^[\d,\s]+$/.test(decoded) && decoded.includes(',')) {
    return Uint8Array.from(
      decoded
        .split(',')
        .map(num => Number.parseInt(num.trim(), 10))
        .filter(num => !Number.isNaN(num)),
    )
  }

  return Uint8Array.from(decoded, char => char.charCodeAt(0))
}

export async function exportCurrentChart() {
  const uuid = getActiveChartUuid()
  const activeChart = await inlineStoredChartAssets(getActiveChartForOutput())

  const exportObj: StoredCharts = {
    [uuid]: activeChart,
  }

  const str = JSON.stringify(exportObj)
  const arr = new TextEncoder().encode(str)
  const zlibbed = await zlib(arr)
  const compressed = bytesToBase64(zlibbed)

  downloadChartData(compressed, exportObj[uuid].data.title, exportObj[uuid].timestamp)
}

function sanitizePdfText(value: string | undefined) {
  return (value || '').replace(/\s+/g, ' ').trim()
}

function getPdfExportApi() {
  return (window as Window & typeof globalThis & {
    electronAPI?: {
      printChartToPdf: (payload: {
        html: string
        title: string
        assets: Array<{ name: string, bytes: Uint8Array }>
        trace: unknown
      }) => Promise<{
        success: boolean
        canceled?: boolean
        filePath?: string
        error?: string
        tracePath?: string
        pdf?: Record<string, unknown>
      }>
    }
  }).electronAPI
}

// Where the print document expects its images to sit relative to itself once
// the main process has written them out beside it.
const PRINT_ASSET_DIR = 'assets'

// How long the print document may wait for fonts and remote cover images
// before it is printed without them, and how long its own fit pass gets.
const PRINT_RESOURCE_TIMEOUT_MS = 20000
// Kept in step with the margin the print document declares for its @page rule.
const PRINT_MARGIN_MM = 12
const PRINT_FIT_TIMEOUT_MS = 10000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntil(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (ready()) {
      return true
    }
    await delay(50)
  }

  return ready()
}

// What the print document looks like right now: the numbers that told us the
// document was being laid out one pixel wide, and which covers never arrived.
function describePrintDocument(frame: HTMLIFrameElement): Record<string, unknown> {
  const doc = frame.contentDocument
  if (!doc) {
    return { documentReachable: false }
  }

  const images = Array.from(doc.images)
  const entry = doc.querySelector('.pl-entry')

  return {
    layoutViewportWidth: frame.contentWindow?.innerWidth ?? null,
    documentHeight: doc.documentElement.scrollHeight,
    entryWidth: entry ? Math.round(entry.getBoundingClientRect().width) : null,
    tiles: doc.querySelectorAll('.pl-item').length,
    entries: doc.querySelectorAll('.pl-entry').length,
    images: images.length,
    imagesPending: images.filter(img => !img.complete).length,
    imagesBroken: images.filter(img => img.complete && img.naturalWidth === 0).length,
  }
}

// Lays the print document out in a hidden frame at the page's content width,
// writes the PDF from that layout, and saves it. No dialog, no preview.
//
// Remote covers are pulled in as blobs first: the renderer needs the actual
// bytes to embed, and an <img> drawn from another origin would taint the canvas
// it has to go through.
async function renderChartPdfInBrowser(
  html: string,
  chartTitle: string,
  trace: ExportTrace,
): Promise<Record<string, unknown>> {
  const paper = paperSizePx()
  const margin = PRINT_MARGIN_MM * 96 / 25.4

  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  // The content box, not the sheet: laid out at any other width, every note
  // would wrap somewhere other than where it ends up in the PDF.
  frame.style.cssText = `position:fixed;left:-10000px;top:0;border:0;`
    + `width:${paper.width - margin * 2}px;height:${paper.height}px;`
  document.body.appendChild(frame)

  try {
    const fullyLoaded = new Promise<void>((resolve) => {
      frame.addEventListener('load', () => resolve(), { once: true })
    })
    frame.srcdoc = html
    trace.mark('frame:srcdoc-set', { htmlBytes: html.length, width: paper.width - margin * 2 })

    const fitted = await waitUntil(
      () => !!frame.contentDocument?.documentElement.hasAttribute('data-fitted'),
      PRINT_FIT_TIMEOUT_MS,
    )
    trace.mark('document:fitted', { fitted, ...describePrintDocument(frame) })

    let everyResourceArrived = false
    await Promise.race([
      fullyLoaded.then(() => { everyResourceArrived = true }),
      delay(PRINT_RESOURCE_TIMEOUT_MS),
    ])
    trace.mark('resources:settled', { everyResourceArrived, ...describePrintDocument(frame) })

    const rendered = await renderFrameToPdf(frame, {
      paper,
      margin,
      onProgress: (stage, data) => trace.mark(stage, data),
    })

    saveBlob(rendered.blob, `${normalizeChartTitle(chartTitle)}.pdf`)

    return {
      pages: rendered.pages,
      images: rendered.images,
      textRuns: rendered.textRuns,
      bytes: rendered.blob.size,
      failedImages: rendered.failedImages,
      writtenBy: 'in-page renderer',
    }
  }
  finally {
    frame.remove()
  }
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()

  setTimeout(() => URL.revokeObjectURL(url), 10000)
}

export async function exportCurrentChartToPdf() {
  const trace = startExportTrace()

  try {
    const source = getActiveChartForOutput().data
    const chartTitle = sanitizePdfText(source.title) || 'chart'
    const printApi = getPdfExportApi()?.printChartToPdf
    trace.mark('chart:read', summariseChart(source))

    if (printApi) {
      // Desktop: the assets travel as bytes and the main process writes them
      // beside the document, so the HTML carries a short path per image instead
      // of a full copy of it.
      const { chart, assets } = await collectChartExportAssets(
        source,
        asset => `${PRINT_ASSET_DIR}/${asset.name}`,
      )
      trace.mark('assets:collected', {
        distinctAssets: assets.length,
        totalBytes: assets.reduce((total, asset) => total + asset.blob.size, 0),
        types: assets.reduce<Record<string, number>>((counts, asset) => {
          const type = asset.blob.type || 'unknown'
          counts[type] = (counts[type] || 0) + 1
          return counts
        }, {}),
      })

      const html = buildPrintDocument(chart, {
        renderNotes: renderMarkdown,
        title: chartTitle,
        // Only the desktop path gets a chart sheet of its own: it runs on a
        // known Chromium, whereas named-page support is uneven across browsers
        // and one that ignores it would print the chart onto the wrong sheet.
        posterPage: 'exact',
      })
      trace.mark('document:built', { htmlBytes: html.length, posterPage: 'exact' })

      const payload = await Promise.all(assets.map(async asset => ({
        name: asset.name,
        bytes: new Uint8Array(await asset.blob.arrayBuffer()),
      })))
      trace.mark('assets:serialized', {
        count: payload.length,
        bytes: payload.reduce((total, asset) => total + asset.bytes.byteLength, 0),
      })

      const result = await printApi({
        html,
        title: chartTitle,
        assets: payload,
        // The main process appends what it sees and writes the whole thing out.
        trace: trace.snapshot(),
      })
      trace.mark('main:returned', {
        success: result.success,
        canceled: result.canceled || false,
        error: result.error || null,
        tracePath: result.tracePath || null,
        ...(result.pdf || {}),
      })

      if (!result.success) {
        if (result.canceled) {
          trace.finish('canceled')
          return
        }
        throw new Error(result.error || 'Failed to export PDF')
      }

      trace.finish('ok', { savedTo: result.filePath || null })
      return
    }

    // Web: no print dialog. The document is laid out in a hidden frame at the
    // page's content width, and the PDF is written from that layout directly,
    // so the file is saved without a preview and without a destination to pick.
    const objectUrls: string[] = []
    const release = () => objectUrls.forEach(URL.revokeObjectURL)

    try {
      const { chart } = await collectChartExportAssets(
        source,
        (asset) => {
          const url = URL.createObjectURL(asset.blob)
          objectUrls.push(url)
          return url
        },
      )
      trace.mark('assets:collected', { distinctAssets: objectUrls.length })

      const html = buildPrintDocument(chart, {
        renderNotes: renderMarkdown,
        title: chartTitle,
        posterPage: 'off',
      })
      trace.mark('document:built', { htmlBytes: html.length, posterPage: 'off' })

      const result = await renderChartPdfInBrowser(html, chartTitle, trace)
      const failedImages = Number(result.failedImages || 0)
      if (failedImages > 0) {
        // A cover that fails to fetch (usually CORS on a user-entered URL)
        // used to vanish from the PDF with only a counter in the trace.
        alert(`Some covers could not be loaded and were left out of the PDF (${failedImages} image(s)). Check the export trace for details.`)
      }
      trace.finish('ok', result)
    }
    catch (error) {
      release()
      throw error
    }

    release()
  }
  catch (error) {
    trace.fail('export', error)
    trace.finish('failed')
    throw error
  }
}

type SaveChartMode = 'save' | 'save-as'

// Extracts the chart uuid stored inside a .topster backup. Returns null when
// the content isn't a parseable single-chart backup.
async function getStoredChartUuid(content: string): Promise<string | null> {
  try {
    const decoded = await parseUploadedText(content)
    const parsed = JSON.parse(decoded) as Record<string, unknown>
    const keys = Object.keys(parsed)
    return keys.length === 1 ? keys[0] : null
  }
  catch {
    return null
  }
}

// A plain "save" writes straight through the chart's remembered path without
// any dialog. Before doing that, verify the file on disk still belongs to this
// chart: if it now contains a different chart, or content that isn't a chart
// backup, refuse to overwrite so a same-named file is never silently clobbered.
async function assertNoSaveConflict(uuid: string, filePath: string): Promise<void> {
  const api = getWindowApi()
  if (!api?.readChartFile) {
    return
  }

  const result = await api.readChartFile(filePath)

  // File is missing (or unreadable / no path support): nothing to protect.
  if (!result.success || result.content == null) {
    return
  }

  const existingUuid = await getStoredChartUuid(result.content)
  if (existingUuid === uuid) {
    return
  }

  if (existingUuid === null) {
    throw new Error(`Save blocked: "${filePath}" exists but is not a chart backup, so it was not overwritten. Use "Save as..." to pick a different location.`)
  }

  throw new Error(`Save blocked: "${filePath}" now contains a different chart and was not overwritten. Use "Save as..." to pick a different location.`)
}

// Saves the active chart to its own remembered path (if it has one).
// Returns the resolved file path on success, or null if the user canceled.
export async function saveCurrentChartToFile(): Promise<string | null> {
  return saveChartToFile({ mode: 'save' })
}

// Always shows the save dialog, even if this chart has a remembered path.
export async function saveCurrentChartAs(): Promise<string | null> {
  return saveChartToFile({ mode: 'save-as' })
}

async function saveChartToFile({ mode }: { mode: SaveChartMode }): Promise<string | null> {
  // The Ctrl+S hotkey lives on window, outside the gate that keeps the app
  // unrendered until the initial load finishes, so it can fire while the store
  // still holds the blank default chart. Writing that through would overwrite
  // the user's saved file with an empty chart: the uuid comes from storage and
  // matches, so the "still the same chart" check below would wave it past.
  if (!useStore().chartLoaded) {
    return null
  }

  const uuid = getActiveChartUuid()

  // Resolve the browser write target FIRST, before the asset inlining and
  // compression below. Reusing a stored handle can require requestPermission,
  // which only works while the page holds transient user activation - and the
  // Ctrl+S keypress that granted it expires in a few seconds, which that work
  // can easily outlast on a chart with many images.
  let writeHandle: StoredFileHandle | null = null
  if (mode === 'save' && !getWindowApi()?.saveChartFile) {
    const stored = await getRememberedFileHandle(uuid)
    if (stored && await ensureWritePermission(stored)) {
      writeHandle = stored
    }
  }

  const activeChart = await inlineStoredChartAssets(getActiveChartForOutput())

  const exportObj: StoredCharts = {
    [uuid]: activeChart,
  }

  const str = JSON.stringify(exportObj)
  const arr = new TextEncoder().encode(str)
  const zlibbed = await zlib(arr)
  const compressed = bytesToBase64(zlibbed)

  // Only a plain "save" may reuse this chart's own remembered path. "Save As"
  // always goes through the dialog, and the main process is told which mode
  // this is so it never silently overwrites a file it wasn't explicitly asked to.
  const rememberedPath = getRememberedChartFilePath(uuid)
  const filePath = mode === 'save' && rememberedPath ? rememberedPath : undefined

  // Before a dialog-free write-through, make sure the file on disk still
  // belongs to this chart; refuse if it now holds something else.
  if (filePath) {
    await assertNoSaveConflict(uuid, filePath)
  }

  // Set when the browser File System Access path handled the write. Its
  // "filePath" is only a file name, never a real path, so it must not be
  // remembered as one.
  let savedViaHandle = false

  const result = await (async () => {
    const api = getWindowApi()

    if (api?.saveChartFile) {
      return api.saveChartFile({
        filePath,
        suggestedName: `${normalizeChartTitle(activeChart.data.title)}.topster`,
        content: compressed,
        mode,
      })
    }

    const windowWithPicker = window as Window & typeof globalThis & {
      showSaveFilePicker?: (options: {
        suggestedName?: string
        types?: Array<{
          description: string
          accept: Record<string, string[]>
        }>
      }) => Promise<{
        name: string
        createWritable: () => Promise<{
          write: (data: string) => Promise<void>
          close: () => Promise<void>
        }>
      }>
    }

    // Browser write-through: reuse the handle this chart was last saved with,
    // so a plain "save" never reopens the picker. Resolved above, while the
    // save gesture's user activation was still valid.
    if (writeHandle) {
      const writable = await writeHandle.createWritable()
      await writable.write(compressed)
      await writable.close()
      savedViaHandle = true
      return { success: true, filePath: writeHandle.name }
    }

    if (typeof windowWithPicker.showSaveFilePicker === 'function') {
      const handle = await windowWithPicker.showSaveFilePicker({
        suggestedName: `${normalizeChartTitle(activeChart.data.title)}.topster`,
        types: [{
          description: 'Topster files',
          accept: {
            'text/plain': ['.topster'],
          },
        }],
      })
      const writable = await handle.createWritable()
      await writable.write(compressed)
      await writable.close()
      // Keep the handle so the next plain save writes straight through.
      await rememberFileHandle(uuid, handle as unknown as StoredFileHandle)
      savedViaHandle = true
      return { success: true, filePath: handle.name }
    }

    return { success: false, error: 'File save API unavailable in this context' }
  })()

  if (!result.success) {
    if ('canceled' in result && result.canceled) {
      return null
    }

    throw new Error('error' in result ? result.error : 'Failed to save chart file')
  }

  const savedPath = 'filePath' in result ? result.filePath || '' : ''
  if (savedPath && !savedViaHandle) {
    rememberChartFilePath(uuid, savedPath)
  }

  // Reaching here means the write succeeded - cancels and failures returned or
  // threw above. Drives the transient "Saved" confirmation in the top bar.
  useStore().markChartSaved()

  return savedPath || null
}

export async function parseUploadedText(text: string) {
  const textDecoder = new TextDecoder()
  const uintArray = base64ToBytes(text)
  const unzlibbed = await unzlib(uintArray)

  const decoded = textDecoder.decode(unzlibbed)

  return decoded
}

// A .topster decodes to plain JSON, so a file can parse cleanly and still be
// structurally wrong. Everything here runs BEFORE the chart is written to
// storage and made active: previously a malformed chart was persisted and
// activated first and only then blew up, so the failure repeated on every
// startup and there was no way back without clearing storage by hand.
function assertImportableChart(json: unknown, uuid: string | undefined): asserts json is StoredCharts {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('This file does not contain a chart.')
  }

  if (!uuid) {
    throw new Error('This file contains no charts.')
  }

  const entry = (json as Record<string, unknown>)[uuid] as { data?: unknown } | undefined
  const data = entry?.data as Partial<Chart> | undefined

  if (!data || typeof data !== 'object') {
    throw new Error('This chart is missing its data and was not imported.')
  }

  const hasUsableSize = Number.isFinite(Number(data.size?.x)) && Number.isFinite(Number(data.size?.y))
  const hasUsableContent = Array.isArray(data.items) || (!!data.coordinates && typeof data.coordinates === 'object')

  if (!hasUsableSize || !hasUsableContent) {
    throw new Error('This chart is malformed and was not imported.')
  }
}

export async function importChart(event: Event) {
  const files = (event.target as HTMLInputElement).files

  try {
    const text = await files[0].text()
    const results = await parseUploadedText(text)

    // Resolve the picked file's real on-disk path. Electron 32 removed File.path;
    // webUtils.getPathForFile (exposed through the preload) is the replacement.
    // Only available in the desktop build, and only for files picked from disk.
    let importedFilePath: string | undefined
    try {
      importedFilePath = getWindowApi()?.getPathForFile?.(files[0])
    }
    catch (error) {
      console.warn('Could not resolve imported file path:', error)
    }

    const json = JSON.parse(results) as StoredCharts

    const newChartUuid = Object.keys(json)[0]
    assertImportableChart(json, newChartUuid)

    const existingChart = findByUuid(newChartUuid)
    const newChart = json[newChartUuid] as StoredPremigrationChart

    migrateChart(newChart)
    newChart.data = await persistChartAssets(newChart.data)

    let overwriteConsent = false

    if (existingChart) {
      if (window.confirm('This chart already exists locally. Do you want to overwrite it?')) {
        overwriteConsent = true
        updateStoredChart(newChart, newChartUuid)
        setActiveChart(newChartUuid)
        forceRefresh()
      }
    }
    else {
      overwriteConsent = true
      appendChart(newChart, newChartUuid)
      setActiveChart(newChartUuid)
      forceRefresh()
    }

    if (overwriteConsent) {
      // Remember the imported file's path for this specific chart so a
      // subsequent "Save current chart" writes back to the same file.
      if (importedFilePath) {
        rememberChartFilePath(newChartUuid, importedFilePath)
      }
      alert(`"${newChart.data.title}" imported successfully!`)
    }
  }
  catch (e) {
    console.error(e)
    alert(`Failed to import charts: ${e}`)
  }
}

export async function importTopsters2(event: Event) {
  if (event.target === null)
    return
  const files = (event.target as HTMLInputElement).files
  if (files === null)
    return
  const fileReader = new FileReader()
  fileReader.addEventListener('load', async () => {
    try {
      // Topsters 2 exports have their charcodes shifted up
      // 17 points, and then are encoded in base64. This
      // may have been a response to our import feature lol.
      const unshifted = atob((fileReader.result as string)
        .split('')
        .map(char => String.fromCharCode(char.charCodeAt(0) - 17))
        .join(''))

      // Parse JSON file
      const charts = JSON.parse(unshifted)[0]
      const options = JSON.parse(charts.options)

      // Import each chart
      const newCharts: StoredChart[] = []
      const failed = []
      for (const chart of Object.entries(options.charts)) {
        let prefix = `${chart[0]}-`
        if (prefix === 'cards-')
          prefix = ''
        const name = chart[1] as string

        try {
          const custom = JSON.parse(charts[`${prefix}custom`])
          const size = charts[`${prefix}size`]
          const chartSize = { x: 3, y: 3 }
          switch (size) {
            case '25': // Collage
              chartSize.x = custom.columns
              chartSize.y = custom.rows
              break
            case '40': // Top 40
              chartSize.x = 5
              chartSize.y = 8
              break
            case '42': // Top 42
              chartSize.x = 6
              chartSize.y = 7
              break
            case '100': // Top 100
              chartSize.x = 10
              chartSize.y = 10
              break
            default: // This should not happen, but set it to the max size just in case
              chartSize.x = MAX_CHART_DIMENSION
              chartSize.y = MAX_CHART_DIMENSION
              break
          }

          // Get background and parse if it's an image
          let background = charts[`${prefix}background`]
          let backgroundImg = null
          if (!background.startsWith('#')) {
            try {
              // Parse URL
              const imgURL = background.match(/url\("(.+?)"\)/)
              if (imgURL === null)
                throw new Error('image URL is empty')
              background = imgURL[1]
              backgroundImg = new Image()
              backgroundImg.src = background
            }
            catch (e) {
              // eslint-disable-next-line no-console
              console.log(e)
              // Invalid URL format, set background color to black as fallback
              background = '#000000'
            }
          }

          const textDecoder = new TextDecoder()

          // Chart cards are compressed with zlib + encoded with base64
          const chartCards = charts[`${prefix}cards`] // Get base64 string
          const cardsCompressed = Uint8Array.from(atob(chartCards.substring(1, chartCards.length - 1)), c => c.charCodeAt(0)) // Convert base64 to bytes
          const unzlibbed = await unzlib(cardsCompressed)
          const cardsDecompressed = textDecoder.decode(unzlibbed) // Decompress and convert to text
          const cards = JSON.parse(cardsDecompressed) // Parse cards

          // Create chart items
          const items: Array<ChartItem | null> = []
          for (const card of cards) {
            // Empty card
            if (card.src === '') {
              items.push(null)
              continue
            }

            // Create item image
            const img = new Image()
            img.src = card.src

            // Create item
            const item: ChartItem = {
              id: crypto.randomUUID(),
              title: card.title,
              coverURL: card.src,
            }
            items.push(item)
          }

          // Create new chart
          const newChart: StoredChart = {
            timestamp: new Date().getTime(),
            data: {
              title: '',
              items,
              size: chartSize,
              backgroundColor: background.startsWith('#') ? background : '#000000',
              backgroundType: background.startsWith('#') ? BackgroundTypes.Color : BackgroundTypes.Image,
              backgroundUrl: background.startsWith('#') ? '' : background,
              shadows: custom.shadowed,
              showNumbers: charts[`${prefix}numbered`] === 'true',
              showTitles: charts[`${prefix}titled`] === 'true',
              gap: custom.padding * 5,
              font: custom.fontFamily,
              roundCorners: false,
            },
          }

          newCharts.push(newChart)
        }
        catch (e) {
          console.error(e)
          failed.push(name)
        }
      }

      if (failed.length > 0) {
        alert(`Failed to import the following charts: ${failed.join(', ')}`)
      }
      else {
        alert('Charts imported successfully!')
      }

      newCharts.forEach(ch => appendChart(ch))

      // Set the newly imported chart to currently active
      setActiveChart(getNewestChartUuid())
      forceRefresh()
    }
    catch (e) {
      console.error(e)
      alert(`The file selected is not a valid Topsters 2 backup: ${e}`)
    }
  })

  fileReader.readAsText(files[0])
}
