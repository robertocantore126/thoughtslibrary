// A trace of one PDF export, written out as JSON.
//
// The export crosses a renderer, a print document and (on the desktop) a second
// process, and most of what goes wrong there is invisible from the outside: a
// cover host that never answers, a document laid out at the wrong width, a
// renderer that draws a page the user never sees. Each stage records what it did
// and what it saw, so a failed or surprising export can be read back rather
// than guessed at.
//
// Collecting costs a few counters and timestamps, so it always runs. Getting
// the JSON out:
//
//   Desktop  the main process writes it beside the PDF's temp document and
//            logs the path.
//   Browser  `window.__pdfExportTrace` holds the last one; call
//            `window.__savePdfExportTrace()` to download it.

import type { Chart, ChartItem } from '../types'

export interface TraceEvent {
  stage: string
  atMs: number
  [key: string]: unknown
}

export interface ExportTraceReport {
  startedAt: string
  totalMs: number
  outcome: 'running' | 'ok' | 'canceled' | 'failed'
  environment: Record<string, unknown>
  events: TraceEvent[]
  error?: { stage: string, message: string, stack?: string }
}

export interface ExportTrace {
  mark: (stage: string, data?: Record<string, unknown>) => void
  fail: (stage: string, error: unknown) => void
  finish: (outcome: ExportTraceReport['outcome'], data?: Record<string, unknown>) => ExportTraceReport
  /** A plain snapshot, safe to send to another process. */
  snapshot: () => ExportTraceReport
}

const TRACE_GLOBAL = '__pdfExportTrace'
const TRACE_SAVER = '__savePdfExportTrace'

function describeEnvironment(): Record<string, unknown> {
  const electronApi = (window as Window & { electronAPI?: { printChartToPdf?: unknown } }).electronAPI

  return {
    runtime: electronApi?.printChartToPdf ? 'electron' : 'browser',
    // Which of the two export paths this run will take, which is the first
    // thing worth knowing and the easiest thing to be wrong about.
    exportPath: electronApi?.printChartToPdf ? 'printToPDF' : 'in-page renderer',
    userAgent: navigator.userAgent,
    language: navigator.language,
    origin: window.location.origin,
    devicePixelRatio: window.devicePixelRatio,
  }
}

function urlKind(url?: string | null): string {
  if (!url) {
    return 'none'
  }
  if (url.startsWith('local-asset://')) {
    return 'stored'
  }
  if (url.startsWith('data:')) {
    return 'data'
  }
  if (url.startsWith('blob:')) {
    return 'blob'
  }
  if (/^https?:/.test(url)) {
    return 'remote'
  }
  if (url.startsWith('/')) {
    return 'app-relative'
  }
  return 'other'
}

/**
 * What the chart is made of, in the terms the export cares about.
 *
 * The cover breakdown is the useful part: stored covers are carried into the
 * document, remote ones are fetched by the print window at print time, and
 * app-relative ones only resolve against the running app.
 */
export function summariseChart(chart: Chart): Record<string, unknown> {
  const gridItems = chart.items.filter(Boolean) as ChartItem[]
  const layerItems = Object.values(chart.relatedLayers || {})
    .flatMap(layer => Object.values(layer))
  const all = [...gridItems, ...layerItems]

  const covers: Record<string, number> = {}
  const remoteHosts: Record<string, number> = {}

  for (const item of all) {
    const kind = urlKind(item.coverURL)
    covers[kind] = (covers[kind] || 0) + 1

    if (kind === 'remote') {
      try {
        const host = new URL(item.coverURL).host
        remoteHosts[host] = (remoteHosts[host] || 0) + 1
      }
      catch {
        remoteHosts.unparseable = (remoteHosts.unparseable || 0) + 1
      }
    }
  }

  return {
    // Copied field by field, not referenced: the chart comes straight off the
    // reactive store, and a proxy cannot cross a process boundary.
    size: { x: chart.size.x, y: chart.size.y },
    cells: chart.size.x * chart.size.y,
    gridItems: gridItems.length,
    layerItems: layerItems.length,
    covers,
    remoteHosts,
    distinctCovers: new Set(all.map(item => item.coverURL).filter(Boolean)).size,
    attachments: all.filter(item => item.attachmentURL).length,
    itemsWithNotes: all.filter(item => item.notes?.trim()).length,
    noteCharacters: all.reduce((total, item) => total + (item.notes?.length || 0), 0),
    font: chart.font,
    backgroundType: chart.backgroundType,
    backgroundKind: urlKind(chart.backgroundUrl),
    showTitles: chart.showTitles,
    showNumbers: chart.showNumbers,
    gap: chart.gap,
  }
}

function toSerializable(error: unknown): { message: string, stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

export function startExportTrace(): ExportTrace {
  const startedAt = new Date()
  const t0 = performance.now()
  const events: TraceEvent[] = []
  const report: ExportTraceReport = {
    startedAt: startedAt.toISOString(),
    totalMs: 0,
    outcome: 'running',
    environment: describeEnvironment(),
    events,
  }

  const mark: ExportTrace['mark'] = (stage, data) => {
    events.push({ stage, atMs: Math.round(performance.now() - t0), ...(data || {}) })
  }

  const fail: ExportTrace['fail'] = (stage, error) => {
    const details = toSerializable(error)
    report.error = { stage, ...details }
    mark(`${stage}:failed`, { message: details.message })
  }

  const finish: ExportTrace['finish'] = (outcome, data) => {
    report.outcome = outcome
    report.totalMs = Math.round(performance.now() - t0)
    mark('finished', { outcome, ...(data || {}) })
    publish(report)
    return report
  }

  // A trace records whatever a stage hands it, and the export deals in store
  // proxies and blobs. Rather than trust every call site to pass plain data,
  // anything that leaves this process goes through JSON first — a trace that
  // breaks the export it is measuring would be worse than no trace at all.
  const snapshot = (): ExportTraceReport => {
    try {
      return JSON.parse(JSON.stringify(report)) as ExportTraceReport
    }
    catch {
      return {
        startedAt: report.startedAt,
        totalMs: report.totalMs,
        outcome: report.outcome,
        environment: { note: 'trace snapshot failed to serialize' },
        events: [],
      }
    }
  }

  return { mark, fail, finish, snapshot }
}

/**
 * Leaves the finished trace where it can be picked up: on the window for
 * inspection, and behind a one-call download for handing it to someone else.
 */
function publish(report: ExportTraceReport): void {
  const scope = window as unknown as Record<string, unknown>
  scope[TRACE_GLOBAL] = report
  scope[TRACE_SAVER] = () => downloadTrace(report)

  const summary = report.error
    ? `failed at ${report.error.stage}: ${report.error.message}`
    : report.outcome

  console.warn(
    `[pdf-export] ${summary} in ${report.totalMs}ms via ${report.environment.exportPath}.`,
    `Trace: window.${TRACE_GLOBAL} — save it with window.${TRACE_SAVER}()`,
    report,
  )
}

export function downloadTrace(report: ExportTraceReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = `pdf-export-trace-${report.startedAt.replace(/[:.]/g, '-')}.json`
  document.body.appendChild(link)
  link.click()
  link.remove()

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10000)
}
