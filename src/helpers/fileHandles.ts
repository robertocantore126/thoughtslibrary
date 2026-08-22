// Persistence for File System Access API handles.
//
// The desktop build writes through a remembered absolute path, so a plain
// "save" never needs a dialog. The browser has no such path: `showSaveFilePicker`
// hands back a `FileSystemFileHandle` and nothing else, so without storing that
// handle every Ctrl+S would reopen the file picker.
//
// Handles are structured-cloneable, so IndexedDB can hold them across sessions.
// localStorage cannot - it only stores strings.

const DB_NAME = 'thoughtslibrary-file-handles'
const DB_VERSION = 1
const STORE_NAME = 'handles'

export interface StoredFileHandle {
  queryPermission: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  requestPermission: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>
  createWritable: () => Promise<{
    write: (data: string) => Promise<void>
    close: () => Promise<void>
  }>
  // Reading the file back is what lets a write-through check that the file still
  // holds the chart it is about to overwrite, the same way the desktop path
  // does through `readChartFile`.
  getFile?: () => Promise<Blob>
  name: string
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openHandleDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => resolve(null)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => resolve(request.result)
  })
}

export async function rememberFileHandle(uuid: string, handle: StoredFileHandle): Promise<void> {
  if (!uuid) {
    return
  }

  const db = await openHandleDb()
  if (!db) {
    return
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(handle, uuid)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })

  db.close()
}

export async function getRememberedFileHandle(uuid: string): Promise<StoredFileHandle | null> {
  if (!uuid) {
    return null
  }

  const db = await openHandleDb()
  if (!db) {
    return null
  }

  const handle = await new Promise<StoredFileHandle | null>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const request = tx.objectStore(STORE_NAME).get(uuid)
    request.onsuccess = () => resolve((request.result as StoredFileHandle) || null)
    request.onerror = () => resolve(null)
  })

  db.close()
  return handle
}

export async function forgetFileHandle(uuid: string): Promise<void> {
  if (!uuid) {
    return
  }

  const db = await openHandleDb()
  if (!db) {
    return
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(uuid)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })

  db.close()
}

// A stored handle is only usable if the page still holds readwrite permission.
// Chrome keeps the grant for the session and will re-grant silently in many
// cases; when it won't, `requestPermission` shows a small permission prompt
// (not the file picker). Ctrl+S counts as the user gesture that call requires.
export async function ensureWritePermission(handle: StoredFileHandle): Promise<boolean> {
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') {
      return true
    }

    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted'
  }
  catch {
    return false
  }
}
