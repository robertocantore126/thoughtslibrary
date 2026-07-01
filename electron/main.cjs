const http = require('node:http')
const fs = require('node:fs')
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
    if (payload.filePath) {
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

ipcMain.handle('print-chart-to-pdf', async (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender)

  if (!win) {
    return { success: false, error: 'No browser window available' }
  }

  try {
    const widthMicrons = Math.max(1000, Math.round((payload?.widthPixels || 0) * 25400 / 96))
    const heightMicrons = Math.max(1000, Math.round((payload?.heightPixels || 0) * 25400 / 96))
    const pdfBuffer = await win.webContents.printToPDF({
      pageSize: {
        width: widthMicrons,
        height: heightMicrons,
      },
      marginsType: 0,
      printBackground: true,
      preferCSSPageSize: false,
      landscape: false,
    })

    const safeTitle = (payload?.title || 'chart')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/(^-|-$)/g, '') || 'chart'

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
