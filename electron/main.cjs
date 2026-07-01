const http = require('node:http')
const path = require('node:path')
const process = require('node:process')
const { app, BrowserWindow, shell } = require('electron')
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
