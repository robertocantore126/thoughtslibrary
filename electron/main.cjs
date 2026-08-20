const { Buffer } = require('node:buffer')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const serveHandler = require('serve-handler')

// How long the print window may wait for fonts and remote cover images before
// it prints without them. Covers that are still remote URLs are fetched here,
// and an unreachable host must not be able to hold the export open.
const RESOURCE_TIMEOUT_MS = 20000

// Everything the export did, written next to the PDF so a run that went wrong
// can be read back instead of reconstructed. The renderer sends what it saw and
// the main process appends its own half.
function createTraceWriter(rendererTrace) {
  const startedAt = Date.now()
  const report = {
    note: 'The renderer half is a snapshot taken when it handed the document over, so its own outcome is still open at that point. The main half covers everything after.',
    renderer: rendererTrace && typeof rendererTrace === 'object' ? rendererTrace : null,
    main: { events: [] },
  }

  return {
    mark(stage, data) {
      report.main.events.push({ stage, atMs: Date.now() - startedAt, ...(data || {}) })
    },
    write(outcome, extra) {
      report.main.outcome = outcome
      report.main.totalMs = Date.now() - startedAt
      Object.assign(report.main, extra || {})

      try {
        const tracePath = path.join(os.tmpdir(), 'thoughtslibrary-export-trace.json')
        fs.writeFileSync(tracePath, JSON.stringify(report, null, 2), 'utf8')
        console.warn(`PDF export trace: ${tracePath}`)
        return tracePath
      }
      catch (error) {
        console.error('Could not write the export trace:', error)
        return null
      }
    },
  }
}

// Whether the PDF carries real text or only pictures of it. A virtual printer
// such as "Microsoft Print to PDF" produces the latter, and it is the single
// most useful fact about a finished export.
function describePdf(buffer) {
  const text = buffer.toString('latin1')
  return {
    bytes: buffer.length,
    pages: (text.match(/\/Type\s*\/Page[^s]/g) || []).length,
    embeddedFonts: (text.match(/\/BaseFont/g) || []).length,
    hasEmbeddedFonts: text.includes('/BaseFont'),
  }
}

const DEV_URL = process.env.ELECTRON_START_URL
const STATIC_PORT = 4173
let staticServer

function createWindow(urlToLoad) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(urlToLoad)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  void win.loadURL(urlToLoad)
}

async function startStaticServer() {
  const distDir = path.join(__dirname, '..', 'dist')

  return new Promise((resolve, reject) => {
    staticServer = http.createServer((req, res) => {
      return serveHandler(req, res, {
        public: distDir,
        cleanUrls: false,
      })
    })

    staticServer.on('error', reject)
    staticServer.listen(STATIC_PORT, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${STATIC_PORT}`)
    })
  })
}

ipcMain.handle('save-chart-file', async (_event, payload) => {
  if (!payload?.content) {
    return { success: false, error: 'Missing file content' }
  }

  try {
    // Write-through is ONLY allowed for an explicit plain "save" that carries a
    // non-empty path (a path the renderer remembered for this exact chart).
    // Anything else - "save-as", a missing path, an unknown mode - must show the
    // dialog, so a remembered path can never silently overwrite the wrong file.
    const writeThrough = payload.mode === 'save' && typeof payload.filePath === 'string' && payload.filePath.length > 0

    if (writeThrough) {
      fs.writeFileSync(payload.filePath, payload.content, 'utf8')
      return { success: true, filePath: payload.filePath }
    }

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: payload.suggestedName || 'chart.topster',
      filters: [{ name: 'Topster files', extensions: ['topster'] }],
    })

    if (canceled || !filePath) {
      return { success: false, canceled: true }
    }

    fs.writeFileSync(filePath, payload.content, 'utf8')
    return { success: true, filePath }
  }
  catch (error) {
    console.error('Failed to save chart file:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

ipcMain.handle('read-chart-file', async (_event, filePath) => {
  if (typeof filePath !== 'string' || !filePath) {
    return { success: false, error: 'Missing file path' }
  }

  try {
    const content = await fs.promises.readFile(filePath, 'utf8')
    return { success: true, content }
  }
  catch (error) {
    // A missing file is not a conflict: there is nothing to overwrite yet.
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { success: true, content: null }
    }
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
  }
})

// The renderer builds the PDF as a standalone HTML print document: the chart
// rebuilt as real HTML on a sheet of its own, then the per-tile notes flowing
// after it. It is loaded into a hidden window and printed with Chromium's own
// pipeline, so text stays vector and selectable and the document's @page rules
// decide the paper. The visible app window is never touched, so its UI CSS can
// never leak into the PDF.
ipcMain.handle('print-chart-to-pdf', async (event, payload) => {
  const html = payload?.html
  const trace = createTraceWriter(payload?.trace)

  if (typeof html !== 'string' || !html.trim()) {
    trace.write('failed', { error: 'Missing print document HTML' })
    return { success: false, error: 'Missing print document HTML' }
  }

  // Roomy enough that the document lays the chart out at its natural size when
  // the fit script measures it; the printed page size comes from CSS.
  const printWindow = new BrowserWindow({
    show: false,
    width: 1600,
    height: 1200,
    webPreferences: {
      sandbox: true,
    },
  })

  let tempDir
  try {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoughtslibrary-print-'))

    // The chart's images arrive as bytes and are written beside the document,
    // which references them by name. Keeping them out of the HTML is what stops
    // a chart with thousands of tiles from building a document hundreds of
    // megabytes long, since every tile would otherwise repeat its cover inline.
    const assets = Array.isArray(payload?.assets) ? payload.assets : []
    let written = 0
    if (assets.length > 0) {
      const assetDir = path.join(tempDir, 'assets')
      fs.mkdirSync(assetDir)

      for (const asset of assets) {
        // The name decides a path, so it is checked rather than trusted.
        if (!asset || typeof asset.name !== 'string' || !/^[a-z0-9]+\.[a-z0-9]+$/i.test(asset.name)) {
          continue
        }
        fs.writeFileSync(path.join(assetDir, asset.name), Buffer.from(asset.bytes))
        written += 1
      }
      trace.mark('assets:written', { received: assets.length, written, dir: assetDir })
    }

    const docPath = path.join(tempDir, 'print.html')
    fs.writeFileSync(docPath, html, 'utf8')
    trace.mark('document:written', { path: docPath, htmlBytes: html.length })

    // A chart can hold covers that are still plain remote URLs, and loadFile
    // only settles once every one of them has. A single unreachable host would
    // otherwise hold the whole export open with nothing to show for it, so the
    // wait is for the DOM, and the images get a deadline of their own below.
    const domReady = new Promise(resolve => printWindow.webContents.once('dom-ready', resolve))
    let everyResourceArrived = false
    const documentLoaded = printWindow.loadFile(docPath).then(
      () => {
        everyResourceArrived = true
        return true
      },
      () => false,
    )
    await Promise.race([documentLoaded, domReady])
    trace.mark('document:dom-ready', { everyResourceArrived })

    // Give fonts and images a bounded window to arrive, then the document's own
    // fit pass — which measures the laid-out chart and sizes its sheet — a
    // moment to run. Whatever has not arrived by then is simply absent from the
    // PDF; the export always finishes.
    const waitForResources = printWindow.webContents.executeJavaScript(`
      (async () => {
        await Promise.all([
          (document.fonts && document.fonts.ready) || Promise.resolve(),
          ...Array.from(document.images).map(img =>
            img.complete
              ? Promise.resolve()
              : new Promise(resolve => {
                  img.addEventListener('load', resolve, { once: true })
                  img.addEventListener('error', resolve, { once: true })
                }),
          ),
        ])
        return 'ready'
      })()
    `).catch(() => 'unavailable')

    const resourceState = await Promise.race([
      waitForResources,
      new Promise(resolve => setTimeout(() => resolve('timed out'), RESOURCE_TIMEOUT_MS)),
    ])
    trace.mark('resources:settled', { resourceState, everyResourceArrived })

    const posterInfo = await printWindow.webContents.executeJavaScript(`
      (async () => {
        for (let i = 0; i < 200 && !document.documentElement.hasAttribute('data-fitted'); i += 1) {
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        const pending = Array.from(document.images).filter(img => !img.complete || img.naturalWidth === 0).length
        return (document.documentElement.getAttribute('data-poster') || 'unfitted') + ', ' + pending + ' image(s) missing'
      })()
    `).catch(() => 'unknown')

    // The document declares its own page sizes, including a sheet of its own
    // for the chart, so CSS wins over any size passed here.
    const printStartedAt = Date.now()
    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    })
    const pdf = describePdf(pdfBuffer)
    trace.mark('pdf:rendered', { ...pdf, poster: posterInfo, renderMs: Date.now() - printStartedAt })
    console.warn(`PDF export: ${pdfBuffer.length} bytes, ${pdf.pages} pages, fonts ${pdf.hasEmbeddedFonts}, resources ${resourceState}, chart ${posterInfo}`)

    const safeTitle = String(payload?.title || 'chart')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'chart'

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeTitle}.pdf`,
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    })

    if (canceled || !filePath) {
      const tracePath = trace.write('canceled', { pdf })
      return { success: false, canceled: true, tracePath, pdf }
    }

    fs.writeFileSync(filePath, pdfBuffer)
    const tracePath = trace.write('ok', { pdf, savedTo: filePath })
    return { success: true, filePath, tracePath, pdf }
  }
  catch (error) {
    console.error('Failed to export PDF:', error)
    const message = error instanceof Error ? error.message : 'Unknown error'
    const tracePath = trace.write('failed', { error: message, stack: error instanceof Error ? error.stack : undefined })
    return { success: false, error: message, tracePath }
  }
  finally {
    if (printWindow && !printWindow.isDestroyed()) {
      printWindow.destroy()
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  }
})

app.whenReady().then(async () => {
  // Anchor-link downloads (the PNG export, .topster export, web-path PDF)
  // need no handler here: Electron's original routine already prompts a save
  // dialog for a download with no save path set. A will-download handler
  // cannot add a dialog asynchronously either — its item APIs are
  // synchronous-only, and calling event.preventDefault() cancels the
  // download outright.
  try {
    const startUrl = DEV_URL || await startStaticServer()
    createWindow(startUrl)
  }
  catch (error) {
    console.error('Failed to start desktop app:', error)
    app.quit()
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length > 0) {
      return
    }

    const startUrl = DEV_URL || `http://127.0.0.1:${STATIC_PORT}`
    createWindow(startUrl)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('quit', () => {
  if (staticServer) {
    staticServer.close()
  }
})
