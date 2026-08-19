/* eslint-disable no-alert */

// Functions related to importing and exporting charts

import type { ChartItem, StoredChart, StoredCharts, StoredPremigrationChart } from '../types'
import { createApp } from 'vue'
import { backendBaseUrl } from '../api/config'
import PrintDocument from '../components/PrintDocument.vue'
import { MAX_CHART_DIMENSION, useStore } from '../store'
import { BackgroundTypes } from '../types'
import { inlineStoredChartAssets, inlineStoredImageUrl, isLocalAssetUrl, persistChartAssets } from './assets'
import { forceRefresh } from './chart'
import { ensureWritePermission, getRememberedFileHandle, rememberFileHandle, type StoredFileHandle } from './fileHandles'
import { appendChart, findByUuid, getActiveChart, getActiveChartUuid, getNewestChartUuid, getRememberedChartFilePath, migrateChart, rememberChartFilePath, setActiveChart, updateStoredChart } from './localStorage'

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
      }) => Promise<{
        success: boolean
        canceled?: boolean
        filePath?: string
        error?: string
      }>
    }
  }).electronAPI
}

async function waitForImageLoad(img: HTMLImageElement) {
  if (img.complete && img.naturalWidth > 0) {
    return
  }

  await new Promise<void>((resolve) => {
    const onDone = () => {
      img.removeEventListener('load', onDone)
      img.removeEventListener('error', onDone)
      resolve()
    }

    img.addEventListener('load', onDone, { once: true })
    img.addEventListener('error', onDone, { once: true })
  })
}

async function inlineLocalImagesForPdfExport(element: HTMLElement): Promise<() => void> {
  const images = Array.from(element.querySelectorAll('img[data-stored-src]')) as HTMLImageElement[]
  const originals: Array<{ img: HTMLImageElement, src: string }> = []

  for (const img of images) {
    const storedSrc = img.dataset.storedSrc || ''
    if (!isLocalAssetUrl(storedSrc)) {
      continue
    }

    const inlineSrc = await inlineStoredImageUrl(storedSrc)
    if (!inlineSrc) {
      continue
    }

    originals.push({ img, src: img.src })
    img.src = inlineSrc
    await waitForImageLoad(img)
  }

  return () => {
    for (const entry of originals) {
      entry.img.src = entry.src
    }
  }
}

// The PDF export builds the chart as a hidden print document and hands it to
// Chromium: in Electron a hidden window runs `printToPDF` on the serialized
// HTML; on web the same document is printed with `window.print()`. Only rules
// naming the `print-doc-*` classes are carried over, so the app's own CSS can
// never leak into the PDF.
const PRINT_DOC_BASE_CSS = `
  html, body { margin: 0; padding: 0; background: #ffffff; }
`

// Serialize the print document's styles: everything the PrintDocument
// component compiled (scoped and plain blocks alike, in dev via injected
// <style> tags and in production via the extracted CSS files) plus its @page
// rule. Cross-origin stylesheets (e.g. Google Fonts) are skipped — the print
// window has no use for them.
function collectPrintDocumentStyles(): string {
  const seen = new Set<string>()
  const rules: string[] = []

  for (const sheet of Array.from(document.styleSheets)) {
    let cssRules: CSSRule[]
    try {
      cssRules = Array.from(sheet.cssRules)
    }
    catch {
      continue
    }

    for (const rule of cssRules) {
      const text = rule.cssText
      if ((text.includes('print-doc') || text.startsWith('@page')) && !seen.has(text)) {
        seen.add(text)
        rules.push(text)
      }
    }
  }

  return rules.join('\n')
}

// Page 1 of the PDF is the chart exactly as the PNG export renders it, so the
// same html2canvas rasterization is reused (identical options, including the
// transform-stripping onclone that keeps the full chart in frame).
async function renderChartImageForPdf(chartElement: HTMLElement): Promise<string> {
  const restoreChartImages = await inlineLocalImagesForPdfExport(chartElement)
  const html2Canvas = await import('html2canvas')

  const onclone = (doc: Document) => {
    const chart = doc.querySelector('#chart') as HTMLElement | null
    if (chart) {
      chart.style.transform = 'none'
      chart.style.maxHeight = '10000px'
      chart.style.maxWidth = '10000px'
    }

    const placeholders = doc.querySelectorAll('.placeholder')
    placeholders.forEach((placeholder) => {
      const placeholderElement = placeholder as HTMLElement
      placeholderElement.classList.remove('placeholder')
      placeholderElement.style.boxShadow = 'none'
    })
  }

  try {
    const canvas = await html2Canvas.default(chartElement, {
      useCORS: true,
      onclone,
      proxy: `${backendBaseUrl}/api/proxy`,
      backgroundColor: '#ffffff',
      scale: 2,
    })

    return canvas.toDataURL('image/png')
  }
  finally {
    restoreChartImages()
  }
}

async function waitForPrintImages(root: HTMLElement) {
  const images = Array.from(root.querySelectorAll('img'))
  await Promise.all(images.map(waitForImageLoad))
}

export async function exportCurrentChartToPdf() {
  const activeChart = await inlineStoredChartAssets(getActiveChartForOutput())
  const chartTitle = sanitizePdfText(activeChart.data.title) || 'chart'
  const chartElement = document.querySelector('#chart') as HTMLElement | null

  if (!chartElement) {
    throw new Error('Chart not found')
  }

  const chartImage = await renderChartImageForPdf(chartElement)

  // Build the hidden print document. It is mounted in the live DOM so the Vue
  // component's styles are compiled and injected exactly as in the app, then
  // serialized into a standalone page for the print window (or printed in
  // place on web, where the print stylesheet hides the app around it).
  const host = document.createElement('div')
  host.className = 'print-doc-root'
  host.id = 'print-host'
  document.body.appendChild(host)

  const printApp = createApp(PrintDocument, {
    chart: activeChart.data,
    chartImage,
  })
  printApp.mount(host)
  await waitForPrintImages(host)

  try {
    const printApi = getPdfExportApi()?.printChartToPdf

    if (printApi) {
      // The collected rules are raw CSS text; they must be wrapped in a
      // <style> tag or the standalone print window would render them as
      // literal text and the document would come out unstyled.
      const html = `<style>${PRINT_DOC_BASE_CSS}${collectPrintDocumentStyles()}</style>${host.innerHTML}`
      const result = await printApi({ html, title: chartTitle })

      if (!result.success) {
        if ('canceled' in result && result.canceled) {
          return
        }
        throw new Error('error' in result && result.error ? result.error : 'Failed to export PDF')
      }
      return
    }

    // Web fallback: the browser's own print dialog produces the PDF from the
    // same document.
    window.print()
  }
  finally {
    printApp.unmount()
    host.remove()
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
