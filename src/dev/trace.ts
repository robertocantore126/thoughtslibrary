/**
 * The tracer: one button, one JSON, written for a reader who was not here.
 *
 * The audience is an AI (or a person) opening a bug report cold, with no
 * screen recording and no session. A dump of raw state does not serve that
 * reader — it makes them re-derive what is wrong from thousands of fields.
 * So the report answers three questions in order:
 *
 *   1. `problems`  — what does not hold RIGHT NOW. Checked, not guessed.
 *   2. `snapshot`  — the state those problems live in.
 *   3. `events`    — what happened in the run-up, newest last.
 *
 * `problems` is the reason this file exists. Every check below is an invariant
 * the app is supposed to maintain and has been seen to break; each one names
 * the subsystem that owns it, so the report points at a suspect rather than
 * asking the reader to find one.
 *
 * Inspired by r-node's src/dev/trace.ts, which carries a ring buffer, a
 * coverage contract and automatic instrumentation of every boundary. This is
 * the smaller sibling: the same "capture, then start clean" gesture and the
 * same subsystem vocabulary, but built around a state audit rather than around
 * full event coverage, because the failures this app produces are almost all
 * state that stopped agreeing with itself.
 *
 * Reachable as `window.__tracer` for a console capture without the button.
 */

import type { Chart } from '../types'
import type { Subsystem, TraceEvent } from './traceCore'
import { collectChartAssetIds, collectSheetAssetIds, listAssetIds } from '../helpers/assets'
import { summariseChart } from '../helpers/exportTrace'
import { listSheetIds, readSheetResult } from '../mindmap/storage'
import {
  causalChain,
  clearEvents,
  events as coreEvents,
  droppedCount,
  emit,
  formatEvent,
  getLevel,
  isBugHunt,
  setBugHunt,
  setLevel,
} from './traceCore'

const TRACE_GLOBAL = '__tracer'

export type { Subsystem, TraceEvent } from './traceCore'

export type Severity = 'error' | 'warning' | 'info'

export interface Problem {
  /** Stable slug, so the same defect reads the same across two captures. */
  id: string
  sub: Subsystem
  severity: Severity
  /** What does not hold, in one sentence. */
  message: string
  /** Where to look. A file path earns its place here; a vague area does not. */
  where?: string
  detail?: Record<string, unknown>
}

function serialiseError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack?.split('\n').slice(0, 6).join('\n') }
  }
  return { message: String(error) }
}

/** Records a free-standing event, for callers with no span to hang it on. */
export function record(sub: Subsystem, what: string, detail?: Record<string, unknown>): void {
  emit(sub, what, detail)
}

export const tracer = {
  record,
  buildReport,
  download,
  events: coreEvents,
  dropped: droppedCount,
  /** Every event of one operation and everything it caused. */
  chain: (traceId: string) => causalChain(traceId),
  /** The same chain, one line per event, for reading in a console. */
  print: (traceId: string) => causalChain(traceId).map(formatEvent).join('\n'),
  setLevel,
  getLevel,
  setBugHunt,
  isBugHunt,
  clear: () => {
    clearEvents()
    emit('ui', 'trace:cleared')
  },
}

// ---------------------------------------------------------------------------
// Passive listeners
//
// Errors are the events nobody remembers to record by hand, and they are the
// ones a report is usually about. Console errors are captured too: the app
// logs its storage failures there rather than throwing.
// ---------------------------------------------------------------------------

let installed = false

export function installTrace(win: Window = window): void {
  if (installed) {
    return
  }
  installed = true

  win.addEventListener('error', (event) => {
    emit('err', 'window:error', {
      message: event.message,
      source: `${event.filename}:${event.lineno}`,
    })
  })

  win.addEventListener('unhandledrejection', (event) => {
    emit('err', 'unhandled:rejection', serialiseError(event.reason))
  })

  const realError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    emit('err', 'console:error', { text: args.map(a => String(a)).join(' ').slice(0, 400) })
    realError(...args)
  }

  const realWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    emit('err', 'console:warn', { text: args.map(a => String(a)).join(' ').slice(0, 400) })
    realWarn(...args)
  }

  emit('ui', 'trace:installed', { level: getLevel(), bugHunt: isBugHunt() })
  ;(win as Window & { [TRACE_GLOBAL]?: unknown })[TRACE_GLOBAL] = tracer
}

// ---------------------------------------------------------------------------
// The audit
//
// Each check is an invariant that has actually broken. Where a defect has a
// known home, `where` names it, so a report lands the reader in the right file
// instead of the right neighbourhood.
// ---------------------------------------------------------------------------

interface AuditInput {
  chart: Chart
  focusedTileId?: string | null
  mindmapSheetId?: string | null
  saveState?: string
  saveError?: string | null
}

async function auditStorage(chart: Chart, problems: Problem[]): Promise<Record<string, unknown>> {
  const mindmaps = chart.mindmaps || {}
  const referencedSheetIds = new Set(Object.values(mindmaps))

  let storedSheetIds: string[] = []
  try {
    storedSheetIds = await listSheetIds()
  }
  catch (error) {
    problems.push({
      id: 'sheet-store-unreadable',
      sub: 'persist',
      severity: 'error',
      message: 'The mindmap sheet store could not be listed at all.',
      detail: serialiseError(error),
    })
  }

  // Sheets nothing points at. deleteSheet() exists but has no caller, so every
  // deleted tile or chart leaves its sheet behind; this is that pile, counted.
  const orphanSheets = storedSheetIds.filter(id => !referencedSheetIds.has(id))
  if (orphanSheets.length > 0) {
    problems.push({
      id: 'orphan-sheets',
      sub: 'persist',
      severity: 'warning',
      message: `${orphanSheets.length} mindmap sheet(s) in storage that no chart references.`,
      where: 'src/mindmap/storage.ts (deleteSheet has no caller)',
      detail: { sheetIds: orphanSheets.slice(0, 20), total: orphanSheets.length },
    })
  }

  // The opposite, and the worse of the two: a tile promising a map that is not
  // there. Opening it silently produces a blank one.
  const dangling: { itemId: string, sheetId: string, why: string }[] = []
  const sheetIdMismatch: { key: string, claims: string }[] = []
  for (const [itemId, sheetId] of Object.entries(mindmaps)) {
    try {
      const result = await readSheetResult(sheetId)
      if (result.kind === 'ok') {
        if (result.sheet.sheetId !== sheetId) {
          sheetIdMismatch.push({ key: sheetId, claims: result.sheet.sheetId })
        }
      }
      else {
        dangling.push({ itemId, sheetId, why: result.kind })
      }
    }
    catch (error) {
      dangling.push({ itemId, sheetId, why: `threw: ${serialiseError(error).message}` })
    }
  }

  if (dangling.length > 0) {
    problems.push({
      id: 'dangling-mindmap-refs',
      sub: 'mindmap',
      severity: 'error',
      message: `${dangling.length} tile(s) point at a mindmap sheet that does not load.`,
      where: 'chart.mindmaps',
      detail: { refs: dangling.slice(0, 20) },
    })
  }

  if (sheetIdMismatch.length > 0) {
    problems.push({
      id: 'sheet-id-divergence',
      sub: 'persist',
      severity: 'error',
      message: 'A sheet\'s own id disagrees with the key it is stored under; saves would split in two.',
      where: 'src/mindmap/storage.ts (readSheetResult aligns this on read)',
      detail: { mismatches: sheetIdMismatch },
    })
  }

  return {
    sheetsInStore: storedSheetIds.length,
    sheetsReferenced: referencedSheetIds.size,
    orphanSheets: orphanSheets.length,
    danglingRefs: dangling.length,
  }
}

async function auditAssets(chart: Chart, problems: Problem[]): Promise<Record<string, unknown>> {
  const referenced = new Set<string>()
  collectChartAssetIds(chart, referenced)

  for (const sheetId of Object.values(chart.mindmaps || {})) {
    try {
      const result = await readSheetResult(sheetId)
      if (result.kind === 'ok') {
        collectSheetAssetIds(result.sheet, referenced)
      }
    }
    catch {
      // A sheet that will not read is already reported by auditStorage; here it
      // only means its asset ids cannot join the root set, which would make
      // live blobs look orphaned. Say so rather than counting them as orphans.
      problems.push({
        id: 'asset-root-set-incomplete',
        sub: 'assets',
        severity: 'warning',
        message: 'A sheet could not be read, so the asset root set below is incomplete — treat the orphan count as a floor, not a total.',
      })
    }
  }

  const stored = await listAssetIds()
  const storedSet = new Set(stored)

  const missing = [...referenced].filter(id => !storedSet.has(id))
  if (missing.length > 0) {
    problems.push({
      id: 'missing-assets',
      sub: 'assets',
      severity: 'error',
      message: `${missing.length} image(s) are referenced but not in the asset store — they render as blank.`,
      detail: { assetIds: missing.slice(0, 20), total: missing.length },
    })
  }

  const orphans = stored.filter(id => !referenced.has(id))
  if (orphans.length > 0) {
    problems.push({
      id: 'orphan-assets',
      sub: 'assets',
      severity: 'info',
      message: `${orphans.length} stored image(s) nothing references. The startup sweep reclaims these when no other window is open.`,
      detail: { total: orphans.length },
    })
  }

  return { referenced: referenced.size, stored: stored.length, missing: missing.length, orphans: orphans.length }
}

function auditChart(input: AuditInput, problems: Problem[]): Record<string, unknown> {
  const { chart } = input
  const coordinates = chart.coordinates || {}
  const items = (chart.items || []).filter(Boolean)

  // `items` is derived from `coordinates` by setEntireChart. A chart holding
  // coordinates but no items never went through it — it was read straight from
  // storage, or a load threw part-way — and everything downstream that walks
  // `items` (the grid, the export, the asset root set) sees an empty chart.
  if (!Array.isArray(chart.items) && Object.keys(coordinates).length > 0) {
    problems.push({
      id: 'items-not-derived',
      sub: 'chart',
      severity: 'error',
      message: 'The chart has coordinates but no derived `items` array: it never went through setEntireChart.',
      where: 'src/store.ts (setEntireChart builds items from coordinates)',
      detail: { coordinateEntries: Object.keys(coordinates).length },
    })
  }

  const size = chart.size
  if (!size || !Number.isFinite(size.x) || !Number.isFinite(size.y)) {
    problems.push({
      id: 'chart-size-missing',
      sub: 'chart',
      severity: 'error',
      message: 'The chart has no usable size, so no bounds check below could run.',
      detail: { size: size ?? null },
    })
    return { coordinateEntries: Object.keys(coordinates).length, visibleItems: items.length }
  }

  // Coordinate keys the grid cannot show. setEntireChart copies every key but
  // rebuilds `items` from the in-bounds ones only, so an out-of-bounds entry
  // survives in storage, keeps its image alive, and answers to id lookups —
  // while being unreachable from the UI.
  const invisible: string[] = []
  for (const key of Object.keys(coordinates)) {
    const [xRaw, yRaw] = key.split(',')
    const x = Number.parseInt(xRaw)
    const y = Number.parseInt(yRaw)
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1 || y < 1 || x > size.x || y > size.y) {
      invisible.push(key)
    }
  }
  if (invisible.length > 0) {
    problems.push({
      id: 'invisible-coordinates',
      sub: 'chart',
      severity: 'error',
      message: `${invisible.length} coordinate entr(ies) sit outside the grid: stored and id-addressable, but impossible to select or delete.`,
      where: 'src/store.ts (normalizeCoordinates does not bounds-check keys)',
      detail: { keys: invisible.slice(0, 20) },
    })
  }

  // Two items sharing an id make every id-keyed operation ambiguous.
  const seen = new Map<string, number>()
  for (const item of Object.values(coordinates)) {
    if (item?.id) {
      seen.set(item.id, (seen.get(item.id) || 0) + 1)
    }
  }
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id)
  if (duplicates.length > 0) {
    problems.push({
      id: 'duplicate-item-ids',
      sub: 'chart',
      severity: 'error',
      message: `${duplicates.length} item id(s) appear on more than one tile; id-based edits will hit the wrong one.`,
      detail: { ids: duplicates.slice(0, 20) },
    })
  }

  // Focus pointing at a tile that is gone: the overlay renders no layer and
  // "add to the active target" silently fails.
  if (input.focusedTileId) {
    const stillThere = Object.values(coordinates).some(item => item?.id === input.focusedTileId)
    if (!stillThere) {
      problems.push({
        id: 'stale-focused-tile',
        sub: 'chart',
        severity: 'error',
        message: 'focusedTileId points at a tile that is no longer on the chart.',
        where: 'src/store.ts (addItem never clears it)',
        detail: { focusedTileId: input.focusedTileId },
      })
    }
  }

  // Arrows whose endpoints have been deleted.
  const ids = new Set(Object.values(coordinates).map(item => item?.id).filter(Boolean))
  for (const layer of Object.values(chart.relatedLayers || {})) {
    for (const item of Object.values(layer)) {
      if (item?.id) {
        ids.add(item.id)
      }
    }
  }
  const brokenLinks = (chart.links || []).filter(link => !ids.has(link.from) || !ids.has(link.to))
  if (brokenLinks.length > 0) {
    problems.push({
      id: 'broken-links',
      sub: 'chart',
      severity: 'warning',
      message: `${brokenLinks.length} link(s) point at an item that no longer exists.`,
      detail: { links: brokenLinks.slice(0, 20) },
    })
  }

  return {
    coordinateEntries: Object.keys(coordinates).length,
    visibleItems: items.length,
    invisibleEntries: invisible.length,
    links: (chart.links || []).length,
    relatedLayers: Object.keys(chart.relatedLayers || {}).length,
  }
}

function auditSession(input: AuditInput, problems: Problem[]): void {
  if (input.saveState === 'error') {
    problems.push({
      id: 'mindmap-save-failing',
      sub: 'persist',
      severity: 'error',
      message: `The open mindmap is not saving: ${input.saveError || 'no reason recorded'}`,
      where: 'src/mindmap/store.ts (flushSave)',
    })
  }

  // Retried only on the next edit; a user who stops typing after a failure
  // never gets another attempt.
  if (input.saveState === 'pending' || input.saveState === 'saving') {
    problems.push({
      id: 'mindmap-save-in-flight',
      sub: 'persist',
      severity: 'info',
      message: 'A mindmap save was still in flight when this was captured; unsaved edits may exist.',
    })
  }

  if (typeof indexedDB === 'undefined') {
    problems.push({
      id: 'no-indexeddb',
      sub: 'persist',
      severity: 'error',
      message: 'IndexedDB is unavailable, so no mindmap or image can be stored at all.',
    })
  }
}

/**
 * Everything this app is entitled to write. Anything else in localStorage
 * belongs to something sharing the origin.
 */
const OWN_KEYS = new Set(['charts', 'activeChart', 'activeTab', 'lastChartFilePath', 'unreadableChartsBackup', 'oldChartsBackup'])
const OWN_PREFIXES = ['lastChartFilePath:', 'tracer:']

function isOwnKey(key: string): boolean {
  return OWN_KEYS.has(key) || OWN_PREFIXES.some(prefix => key.startsWith(prefix))
}

function measureLocalStorage(problems: Problem[]): Record<string, unknown> {
  try {
    let total = 0
    const perKey: Record<string, number> = {}
    const foreign: Record<string, number> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key) {
        continue
      }
      const size = (localStorage.getItem(key) || '').length
      perKey[key] = size
      total += size
      if (!isOwnKey(key)) {
        foreign[key] = size
      }
    }

    // localStorage is keyed by ORIGIN, not by app. Two dev servers on the same
    // host and port are one storage area — so a sibling app's documents sit
    // beside this one's, and anything here that clears or rewrites storage
    // wholesale would take them with it. Worth saying out loud: it is
    // invisible from inside either app.
    const foreignKeys = Object.keys(foreign)
    if (foreignKeys.length > 0) {
      problems.push({
        id: 'shared-origin-storage',
        sub: 'persist',
        severity: 'warning',
        message: `${foreignKeys.length} localStorage key(s) here belong to another app sharing this origin (${window.location.origin}).`,
        where: 'give each app its own port',
        detail: { keys: foreign, ownOrigin: window.location.origin },
      })
    }

    return {
      totalChars: total,
      approxMB: Math.round((total / 1024 / 1024) * 100) / 100,
      perKey,
      foreignKeys: foreignKeys.length,
    }
  }
  catch (error) {
    return serialiseError(error)
  }
}

export interface TraceReport {
  meta: Record<string, unknown>
  problems: Problem[]
  snapshot: Record<string, unknown>
  events: TraceEvent[]
}

/**
 * Builds the report. Never throws: a tracer that dies on a broken document is
 * useless exactly when it is needed, so a failed section reports its own
 * failure and the rest of the capture still lands.
 */
export async function buildReport(input: AuditInput): Promise<TraceReport> {
  const problems: Problem[] = []
  const snapshot: Record<string, unknown> = {}

  const sections: [string, () => unknown | Promise<unknown>][] = [
    ['chart', () => auditChart(input, problems)],
    ['storage', () => auditStorage(input.chart, problems)],
    ['assets', () => auditAssets(input.chart, problems)],
    ['localStorage', () => measureLocalStorage(problems)],
    // summariseChart walks `items` and `size` unguarded — reasonable for the
    // export path, which only ever sees a live store chart. The tracer is
    // pointed at broken ones by definition, so it hands over a padded shape.
    ['chartSummary', () => summariseChart({
      ...input.chart,
      items: Array.isArray(input.chart.items) ? input.chart.items : [],
      size: input.chart.size ?? { x: 0, y: 0 },
    })],
  ]

  for (const [name, run] of sections) {
    try {
      snapshot[name] = await run()
    }
    catch (error) {
      snapshot[name] = { failed: true, ...serialiseError(error) }
      problems.push({
        id: `audit-failed-${name}`,
        sub: 'err',
        severity: 'warning',
        message: `The "${name}" section of this report could not be built, so its problems are unknown.`,
        detail: serialiseError(error),
      })
    }
  }

  try {
    auditSession(input, problems)
  }
  catch {
    // Session checks read plain fields; if even that throws there is nothing
    // meaningful left to say about the session.
  }

  snapshot.mindmapSession = {
    open: !!input.mindmapSheetId,
    sheetId: input.mindmapSheetId ?? null,
    saveState: input.saveState ?? null,
    saveError: input.saveError ?? null,
  }

  // Anything the trace already recorded as gone wrong is promoted into
  // `problems`, so the reader never has to scan the event list to find out
  // that an operation was overtaken or that a write went to the wrong key.
  const recorded = coreEvents()
  for (const event of recorded) {
    if (event.phase === 'stale') {
      problems.push({
        id: 'async-stale-result',
        sub: event.sub,
        severity: 'warning',
        message: `${event.traceId} finished after something else had taken its place.`,
        where: 'see events with this traceId',
        detail: { seq: event.seq, traceId: event.traceId, ...event.detail },
      })
    }
    if (event.what === 'persistence:identity-mismatch') {
      problems.push({
        id: 'persistence-identity-mismatch',
        sub: 'persist',
        severity: 'error',
        message: 'A sheet was written under a key that is not its own id.',
        where: 'src/mindmap/storage.ts (writeSheet)',
        detail: { seq: event.seq, ...event.detail },
      })
    }
  }

  // Operations that started and never reported an end: either still running
  // when the capture was taken, or dropped on the floor.
  const ended = new Set(recorded.filter(e => e.phase && e.phase !== 'start' && e.phase !== 'step').map(e => e.traceId))
  const unfinished = recorded
    .filter(e => e.phase === 'start' && e.traceId && !ended.has(e.traceId))
    .map(e => e.traceId as string)
  if (unfinished.length > 0) {
    problems.push({
      id: 'operations-never-finished',
      sub: 'err',
      severity: 'info',
      message: `${unfinished.length} operation(s) started but never reported an end.`,
      detail: { traceIds: unfinished.slice(0, 20) },
    })
  }

  const order: Record<Severity, number> = { error: 0, warning: 1, info: 2 }
  problems.sort((a, b) => order[a.severity] - order[b.severity])

  return {
    meta: {
      capturedAt: new Date().toISOString(),
      // The report is read cold: whether this ran in Electron or a browser tab
      // decides which half of the save path was even reachable.
      runtime: (window as Window & { electronAPI?: unknown }).electronAPI ? 'electron' : 'browser',
      url: window.location.href,
      userAgent: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
      level: getLevel(),
      bugHunt: isBugHunt(),
      problemCount: problems.length,
      errorCount: problems.filter(p => p.severity === 'error').length,
      eventCount: recorded.length,
      // A truncated trace that does not say it is truncated lies by omission:
      // the reader takes the oldest event for the beginning.
      eventsDropped: droppedCount(),
    },
    problems,
    snapshot,
    events: recorded,
  }
}

function download(report: TraceReport): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `thoughtslibrary-trace-${stamp}.json`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  // Revoked, unlike the PNG export path: a diagnostic tool that leaks on every
  // press would end up in its own report.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
