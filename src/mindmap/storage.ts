/**
 * Sheet persistence, mirroring the open/failure posture of
 * src/helpers/assets.ts (MINDMAP_NATIVE_AGENT_BRIEF Lane C).
 *
 * Sheets live in IndexedDB, never in localStorage: a chart is a few hundred
 * KB of grid metadata and fits the quota, but one 400-topic map would eat it
 * whole (Chart.mindmaps stores an ID, never the sheet). IndexedDB
 * structured-clones the Sheet object on write, so nothing is stringified.
 *
 * An unavailable IndexedDB degrades — it never throws. Every function resolves
 * to null / [] / undefined and the app keeps working without persistence
 * rather than dying at startup.
 */
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from './types'

const DB_NAME = 'thoughtslibrary-mindmaps'
const DB_VERSION = 1
const STORE_NAME = 'sheets'

// One shared connection for the lifetime of the page, like the asset store.
let dbPromise: Promise<IDBDatabase | null> | null = null

function hasIndexedDb(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null)
  }

  if (dbPromise) {
    return dbPromise
  }

  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      dbPromise = null
      resolve(null)
    }

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }

    request.onsuccess = () => {
      const db = request.result
      // A version change elsewhere invalidates this handle; drop it so the
      // next caller opens a fresh one instead of using a closing connection.
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

export async function readSheet(id: string): Promise<Sheet | null> {
  const db = await openDb()
  if (!db) {
    return null
  }

  return await new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    request.onsuccess = () => {
      resolve((request.result as Sheet | undefined) || null)
    }
    request.onerror = () => {
      resolve(null)
    }
  })
}

/**
 * Whether the write reached the disk. `writeSheet` still never throws — an
 * unavailable or full IndexedDB must not take the UI down — but it no longer
 * resolves identically to a success either. Before S4 a quota-exhausted store
 * meant an hour of editing was lost with one line in the console and a UI that
 * looked exactly like a working one; the caller now has something to show.
 */
// `error?: undefined` on the success arm is not decoration: without it the
// union is not reliably discriminated through pinia's action typing, and
// `result.error` fails to narrow in the else branch.
export type WriteResult = { ok: true, error?: undefined } | { ok: false, error: string }

export async function writeSheet(id: string, sheet: Sheet): Promise<WriteResult> {
  const db = await openDb()
  if (!db) {
    // The sheet itself is never cached in memory for later retry — degrade
    // loudly rather than pretend the edit was saved.
    console.error('IndexedDB is unavailable; mindmap changes are not being saved')
    return { ok: false, error: 'Storage is unavailable' }
  }

  return new Promise<WriteResult>((resolve) => {
    let request: IDBRequest
    try {
      request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(sheet, id)
    }
    catch (error) {
      // Opening the transaction throws on its own (a closing connection, a
      // store that vanished under a version change), and that path never
      // reached the handlers below.
      console.error('Failed to open a mindmap write transaction:', error)
      resolve({ ok: false, error: describeWriteError(error) })
      return
    }
    request.onsuccess = () => {
      resolve({ ok: true })
    }
    request.onerror = () => {
      // A full store must not take the app down with it: the user keeps
      // editing, the next debounced write tries again — but the failure is
      // now reported rather than swallowed.
      console.error('Failed to write mindmap sheet:', request.error)
      resolve({ ok: false, error: describeWriteError(request.error) })
    }
  })
}

// Quota exhaustion is the failure this is most likely to hit, and it is the one
// the user can actually act on, so it gets its own words instead of a
// DOMException name nobody outside the console can read.
function describeWriteError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'QuotaExceededError') {
    return 'Out of browser storage — free some space to keep saving'
  }
  return name || (error instanceof Error ? error.message : 'Unknown storage error')
}

export async function deleteSheet(id: string): Promise<void> {
  const db = await openDb()
  if (!db) {
    return
  }

  await new Promise<void>((resolve) => {
    const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id)
    request.onsuccess = () => {
      resolve()
    }
    request.onerror = () => {
      resolve()
    }
  })
}

export async function listSheetIds(): Promise<string[]> {
  const db = await openDb()
  if (!db) {
    return []
  }

  return await new Promise((resolve) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAllKeys()
    request.onsuccess = () => {
      resolve((request.result as IDBValidKey[]).map(String))
    }
    request.onerror = () => {
      resolve([])
    }
  })
}

/** A valid single-root sheet, ready to be edited and stored. */
export function blankSheet(title: string): Sheet {
  const rootId = crypto.randomUUID()
  const now = new Date().toISOString()
  const root: MindNode = {
    id: rootId,
    type: 'central',
    parentId: null,
    childrenIds: [],
    title,
    position: { x: 0, y: 0, manual: false },
    style: {},
    collapsed: false,
    labels: [],
    markers: [],
    notes: '',
    task: null,
    metadata: { createdAt: now, updatedAt: now },
  }
  return {
    sheetId: crypto.randomUUID(),
    title,
    structure: { ...DEFAULT_STRUCTURE },
    rootNodeId: rootId,
    nodes: { [rootId]: root },
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
  }
}
