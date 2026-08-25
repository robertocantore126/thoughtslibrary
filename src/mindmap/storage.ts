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
import { DEFAULT_STRUCTURE, type MindNode, SCHEMA_VERSION, type Sheet } from './types'

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

/**
 * A sheet on its way back out of the store, plus a line per repair made to it.
 * `sheet` is null only when there is nothing recoverable at all (no node map,
 * or an empty one) — the caller then opens a blank sheet in its place.
 */
export interface SheetRepair {
  sheet: Sheet | null
  repairs: string[]
}

export type ReadSheetResult =
  | { kind: 'ok', sheet: Sheet }
  | { kind: 'missing' }
  | { kind: 'unavailable', error: string }
  | { kind: 'invalid', error: string }

export async function readSheetResult(id: string): Promise<ReadSheetResult> {
  const db = await openDb()
  if (!db) {
    return { kind: 'unavailable', error: 'Storage is unavailable' }
  }

  const stored = await new Promise<{ value: unknown, error: string | null }>((resolve) => {
    let request: IDBRequest
    try {
      request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id)
    }
    catch (error) {
      resolve({ value: null, error: describeWriteError(error) })
      return
    }
    request.onsuccess = () => resolve({ value: request.result ?? null, error: null })
    request.onerror = () => resolve({ value: null, error: describeWriteError(request.error) })
  })

  if (stored.error) {
    return { kind: 'unavailable', error: stored.error }
  }
  if (!stored.value) {
    return { kind: 'missing' }
  }

  try {
    const repaired = repairSheet(stored.value)
    if (!repaired.sheet) {
      return { kind: 'invalid', error: 'The sheet contains no readable topics' }
    }
    const sheet = repaired.sheet
    const repairs = [...repaired.repairs, ...migrate(sheet)]
    // The key IS the identity. A sheet whose stored sheetId disagrees with the
    // key it lives under would be saved back under the id it claims, leaving
    // the original key holding a copy nothing writes to any more.
    if (sheet.sheetId !== id) {
      repairs.push(`sheetId said "${sheet.sheetId}"; aligned it with the key "${id}"`)
      sheet.sheetId = id
    }
    if (repairs.length > 0) {
      console.warn(`Repaired mindmap sheet "${id}":\n  ${repairs.join('\n  ')}`)
      // Written back so the repair is paid for once. A failed write is not
      // worth reporting here: the sheet in memory is sound and the next
      // autosave will persist it anyway.
      await writeSheet(id, sheet)
    }
    return { kind: 'ok', sheet }
  }
  catch (error) {
    return { kind: 'invalid', error: error instanceof Error ? error.message : 'Invalid sheet' }
  }
}

/**
 * Stamps the schema version on a sheet written before the field existed.
 *
 * There is nothing to translate yet, and that is the point (S4 §C.6): the step
 * exists NOW, while the old and new shapes are still the same one, so the next
 * field change has a version to branch on. Added after the fact it would have
 * to guess what old data looked like.
 */
function migrate(sheet: Sheet): string[] {
  if (sheet.schemaVersion) {
    return []
  }
  sheet.schemaVersion = SCHEMA_VERSION
  return [`stamped schemaVersion ${SCHEMA_VERSION} on a pre-S4 sheet`]
}

/**
 * Validates and repairs the topology of a stored sheet (S4 §C.6, audit X05).
 *
 * `readSheet` returns whatever IndexedDB holds, and what it holds may be a
 * half-written sheet, a hand-edited one, or one an older build left
 * inconsistent. A `parentId`/`childrenIds` disagreement or a cycle sends
 * `layoutSheet`'s recursive walk into a stack overflow, and the overlay then
 * renders blank forever with nothing in the console to explain it.
 *
 * So: walk from the root, repair what is repairable, and never throw. A
 * damaged map the user can still see and fix by hand beats a blank one.
 */
export function repairSheet(input: unknown): SheetRepair {
  const repairs: string[] = []
  const sheet = input as Sheet | null
  if (!sheet || typeof sheet !== 'object' || !sheet.nodes || typeof sheet.nodes !== 'object') {
    return { sheet: null, repairs }
  }

  // Collections a truncated or hand-edited file may be missing outright. The
  // store's own publish() calls .some() on relationships and boundaries, so an
  // absent one is a crash on the first edit rather than a rendering glitch.
  for (const key of ['relationships', 'boundaries', 'summaries', 'callouts', 'labels', 'zones', 'attachments', 'comments'] as const) {
    if (!Array.isArray(sheet[key])) {
      sheet[key] = []
      repairs.push(`replaced a missing "${key}" list`)
    }
  }
  if (!sheet.structure || typeof sheet.structure !== 'object') {
    sheet.structure = { ...DEFAULT_STRUCTURE }
    repairs.push('replaced a missing structure config')
  }
  if (!sheet.presentation || typeof sheet.presentation !== 'object') {
    sheet.presentation = {}
  }

  for (const [key, node] of Object.entries(sheet.nodes)) {
    if (!node || typeof node !== 'object' || node.id !== key) {
      delete sheet.nodes[key]
      repairs.push(`dropped "${key}", which was not a node keyed by its own id`)
    }
  }
  const nodeIds = Object.keys(sheet.nodes)
  if (nodeIds.length === 0) {
    return { sheet: null, repairs }
  }

  if (!sheet.nodes[sheet.rootNodeId]) {
    const replacement = nodeIds.find(nodeId => sheet.nodes[nodeId].parentId === null) ?? nodeIds[0]
    repairs.push(`rootNodeId pointed at no node; promoted "${replacement}"`)
    sheet.rootNodeId = replacement
  }
  const root = sheet.nodes[sheet.rootNodeId]
  if (root.parentId !== null) {
    root.parentId = null
    repairs.push('the central topic claimed a parent')
  }
  for (const node of Object.values(sheet.nodes)) {
    if (!Array.isArray(node.childrenIds)) {
      node.childrenIds = []
      repairs.push(`"${node.id}" had no children list`)
    }
  }

  // One walk down from the root does all three structural repairs at once: a
  // child that is not there, a child already claimed by another parent, and a
  // back edge into the branch currently being walked (the cycle).
  const claimed = new Set<string>([sheet.rootNodeId])
  const path = new Set<string>()
  const walk = (id: string) => {
    path.add(id)
    const node = sheet.nodes[id]
    const kept: string[] = []
    for (const childId of node.childrenIds) {
      if (!sheet.nodes[childId]) {
        repairs.push(`"${id}" listed a child "${childId}" that is not in the sheet`)
      }
      else if (path.has(childId)) {
        repairs.push(`broke a cycle at "${id}" → "${childId}"`)
      }
      else if (claimed.has(childId)) {
        repairs.push(`"${childId}" was listed under two parents; kept the first`)
      }
      else {
        claimed.add(childId)
        kept.push(childId)
      }
    }
    if (kept.length !== node.childrenIds.length) {
      node.childrenIds = kept
    }
    for (const childId of kept) {
      if (sheet.nodes[childId].parentId !== id) {
        sheet.nodes[childId].parentId = id
        repairs.push(`"${childId}" disagreed with its parent about who it belongs to`)
      }
      walk(childId)
    }
    path.delete(id)
  }
  walk(sheet.rootNodeId)

  const attachToRoot = (id: string) => {
    sheet.nodes[id].parentId = sheet.rootNodeId
    root.childrenIds.push(id)
    claimed.add(id)
    repairs.push(`"${id}" was unreachable from the central topic; re-parented to it`)
    walk(id)
  }
  // A node hanging off a parent that is itself unreachable is part of a
  // detached BRANCH: attaching every one of them individually would flatten it,
  // so only the branch's top is attached and the walk claims the rest.
  for (const id of nodeIds) {
    const parentId = sheet.nodes[id]?.parentId
    if (claimed.has(id) || (parentId && sheet.nodes[parentId] && !claimed.has(parentId))) {
      continue
    }
    attachToRoot(id)
  }
  // A detached branch with no top at all is a cycle floating free of the root;
  // nothing above reaches it, so break in wherever and let walk() cut the loop.
  for (const id of nodeIds) {
    if (!claimed.has(id)) {
      attachToRoot(id)
    }
  }

  const liveRelationships = sheet.relationships.filter(r => r && sheet.nodes[r.fromId] && sheet.nodes[r.toId])
  if (liveRelationships.length !== sheet.relationships.length) {
    repairs.push(`dropped ${sheet.relationships.length - liveRelationships.length} relationship(s) with a missing endpoint`)
    sheet.relationships = liveRelationships
  }
  for (const group of sheet.boundaries) {
    const members = (group.memberIds ?? []).filter(memberId => sheet.nodes[memberId])
    if (members.length !== (group.memberIds ?? []).length) {
      repairs.push(`boundary "${group.id}" listed members that are no longer in the sheet`)
      group.memberIds = members
    }
  }

  if (typeof sheet.title !== 'string') {
    sheet.title = root.title || 'Untitled'
    repairs.push('replaced a missing sheet title')
  }

  return { sheet, repairs }
}

/**
 * The lossy view of `readSheetResult`, for the callers that genuinely cannot
 * act on WHY a sheet did not load — the export walk and the startup sweep,
 * which both treat an unreadable sheet as a reason to skip work rather than a
 * reason to show the user anything. Anything that OPENS a sheet must use
 * `readSheetResult`: collapsing "storage is down" into "no such sheet" is what
 * let a blank map take an existing one's place.
 */
export async function readSheet(id: string): Promise<Sheet | null> {
  const result = await readSheetResult(id)
  if (result.kind === 'ok') {
    return result.sheet
  }
  if (result.kind !== 'missing') {
    console.error(`Mindmap sheet "${id}" could not be read: ${result.error}`)
  }
  return null
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
    let transaction: IDBTransaction
    let request: IDBRequest
    try {
      transaction = db.transaction(STORE_NAME, 'readwrite')
      request = transaction.objectStore(STORE_NAME).put(sheet, id)
    }
    catch (error) {
      // Opening the transaction throws on its own (a closing connection, a
      // store that vanished under a version change), and that path never
      // reached the handlers below.
      console.error('Failed to open a mindmap write transaction:', error)
      resolve({ ok: false, error: describeWriteError(error) })
      return
    }
    transaction.oncomplete = () => {
      resolve({ ok: true })
    }
    request.onerror = () => {
      // A full store must not take the app down with it: the user keeps
      // editing, the next debounced write tries again — but the failure is
      // now reported rather than swallowed.
      console.error('Failed to write mindmap sheet:', request.error)
      resolve({ ok: false, error: describeWriteError(request.error) })
    }
    transaction.onerror = () => {
      console.error('Failed to commit mindmap sheet:', transaction.error)
      resolve({ ok: false, error: describeWriteError(transaction.error) })
    }
    transaction.onabort = () => {
      console.error('Mindmap sheet transaction aborted:', transaction.error)
      resolve({ ok: false, error: describeWriteError(transaction.error) })
    }
  })
}

// Quota exhaustion is the failure this is most likely to hit, and it is the one
// the user can actually act on, so it gets its own words instead of a
// DOMException name nobody outside the console can read.
function describeWriteError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'QuotaExceededError':
      return 'Out of browser storage — free some space to keep saving'
    case 'InvalidStateError':
      // The connection closed under us: another tab ran a version change, or
      // the browser reclaimed it. Reopening gets a fresh one.
      return 'Browser storage closed unexpectedly — close this and open it again'
    case 'VersionError':
      return 'This map was written by a newer version of the app'
    case 'SecurityError':
    case 'InvalidAccessError':
      return 'The browser is blocking storage here — private browsing or a site setting'
    case 'NotFoundError':
      return 'The browser storage this app uses is missing'
    case '':
      return error instanceof Error ? error.message : 'Unknown storage error'
    default:
      // A name nobody outside the console can read is worse than no name, so
      // it travels as context on a sentence rather than as the whole message.
      return `Browser storage failed (${name})`
  }
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
    // Stamped at birth so a sheet created today never looks, to the migration
    // step, like one written before the field existed.
    schemaVersion: SCHEMA_VERSION,
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
