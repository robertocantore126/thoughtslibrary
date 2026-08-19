const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const process = require('node:process')
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const serveHandler = require('serve-handler')

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

// The renderer builds the PDF as a standalone HTML print document (the chart
// raster on page 1, then a mini render plus per-tile text per grid tile). It
// is loaded into a hidden window and rasterized with Chromium's own print
// pipeline: vector text, real pagination, @page rules honored. The visible app
// window is never touched, so its UI CSS can never leak into the PDF.
ipcMain.handle('print-chart-to-pdf', async (event, payload) => {
  const html = payload?.html
  if (typeof html !== 'string' || !html.trim()) {
    return { success: false, error: 'Missing print document HTML' }
  }

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
    },
  })

  let tempDir
  try {
    // A document with inlined images can be large; write it to a temp file
    // rather than trusting a multi-megabyte data: URL to load cleanly.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thoughtslibrary-print-'))
    const docPath = path.join(tempDir, 'print.html')
    fs.writeFileSync(docPath, html, 'utf8')

    await printWindow.loadFile(docPath)

    // Wait for images and fonts to settle before rasterizing; a slow cover
    // would otherwise come out blank. Bounded so a hung resource cannot wedge
    // the export.
    const waitForReady = printWindow.webContents.executeJavaScript(`
      Promise.all([
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
    `)
    await Promise.race([
      waitForReady,
      new Promise(resolve => setTimeout(resolve, 10000)),
    ])

    const pdfBuffer = await printWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
    })

    const safeTitle = String(payload?.title || 'chart')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '') || 'chart'

    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: `${safeTitle}.pdf`,
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    })

    if (canceled || !filePath) {
      return { success: false, canceled: true }
    }

    fs.writeFileSync(filePath, pdfBuffer)
    return { success: true, filePath }
  }
  catch (error) {
    console.error('Failed to export PDF:', error)
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
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
