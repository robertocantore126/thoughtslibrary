/**
 * The causal core: sequence numbers, operation ids, parent/child links.
 *
 * Split from trace.ts on purpose. The audit in trace.ts reads storage and
 * assets to check invariants; storage.ts has to be able to EMIT events. If
 * both lived in one module that would be an import cycle, so everything here
 * depends on nothing but the platform, and every app module can import it.
 *
 * ---------------------------------------------------------------------------
 * Why a sequence number when events already carry a timestamp
 * ---------------------------------------------------------------------------
 * Two events in the same millisecond sort arbitrarily, and the same
 * millisecond is exactly where races live — the bug this app kept producing
 * was two opens resolving inside one IndexedDB round trip. `seq` is a
 * monotonic counter, so the order events were OBSERVED in is never in doubt.
 * The timestamp stays, as information rather than as the ordering key.
 *
 * ---------------------------------------------------------------------------
 * Why the parent is passed explicitly and not held in a global
 * ---------------------------------------------------------------------------
 * A "current operation" global is the obvious design and it is wrong here:
 * the browser has no async context propagation, so the moment two operations
 * are in flight the global describes whichever started last, and every child
 * event is attributed to the wrong parent — silently, and worst exactly when
 * two things overlap, which is when the trace is being read. So a span is a
 * value: you hold it across your awaits and hand it to your children. It is
 * more typing at the call site and it cannot lie.
 */

export type Subsystem = 'ui' | 'chart' | 'mindmap' | 'persist' | 'assets' | 'layout' | 'err'

/**
 * `stale` is not decoration. An operation that resolves after something else
 * took its place is the single failure this codebase produces most, and it is
 * invisible in a flat log: both operations look successful.
 */
export type Phase = 'start' | 'step' | 'end' | 'stale' | 'refused' | 'error'

export type Level = 'off' | 'error' | 'warn' | 'info' | 'debug'

export type Detail = Record<string, unknown>

export interface TraceEvent {
  seq: number
  t: number
  traceId?: string
  parentId?: string
  sub: Subsystem
  what: string
  phase?: Phase
  detail?: Detail
}

const CAPACITY = 2000
const LEVEL_KEY = 'tracer:level'
const BUG_HUNT_KEY = 'tracer:bugHunt'

const LEVEL_RANK: Record<Level, number> = { off: 0, error: 1, warn: 2, info: 3, debug: 4 }

const t0 = typeof performance !== 'undefined' ? performance.now() : 0
const buffer: TraceEvent[] = []

let seq = 0
/**
 * Events the ring buffer threw away. Without this a truncated trace lies by
 * omission: the reader sees a beginning that is not the beginning.
 */
let dropped = 0
let level: Level = 'info'
let bugHunt = false

const opCounters = new Map<string, number>()

function now(): number {
  return Math.round(((typeof performance !== 'undefined' ? performance.now() : 0) - t0) * 10) / 10
}

// Settings persist, because the traces worth catching include the ones that
// happen during startup — before anyone can reach a toggle.
try {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(LEVEL_KEY) as Level | null
    if (stored && stored in LEVEL_RANK) {
      level = stored
    }
    bugHunt = localStorage.getItem(BUG_HUNT_KEY) === 'true'
  }
}
catch {
  // Storage can be blocked outright (private mode, a hostile setting). The
  // defaults are usable, so this is not worth a failure.
}

export function setLevel(next: Level): void {
  level = next
  try {
    localStorage?.setItem(LEVEL_KEY, next)
  }
  catch {}
}

export function getLevel(): Level {
  return level
}

/**
 * Bug-hunt mode. Expensive checks (invariants after every mutation, richer
 * mutation payloads) ask this before doing their work, so the normal path
 * never pays for them.
 */
export function setBugHunt(on: boolean): void {
  bugHunt = on
  try {
    localStorage?.setItem(BUG_HUNT_KEY, String(on))
  }
  catch {}
}

export function isBugHunt(): boolean {
  return bugHunt
}

function enabled(min: Level): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[min]
}

function push(event: TraceEvent): void {
  buffer.push(event)
  if (buffer.length > CAPACITY) {
    dropped += buffer.length - CAPACITY
    buffer.splice(0, buffer.length - CAPACITY)
  }
}

/**
 * Records one event. `detail` may be a thunk: a payload that costs something
 * to build is not built at all when the level would discard the event.
 */
export function emit(
  sub: Subsystem,
  what: string,
  detail?: Detail | (() => Detail),
  opts: { traceId?: string, parentId?: string, phase?: Phase, min?: Level } = {},
): void {
  const min = opts.min ?? 'info'
  if (!enabled(min)) {
    return
  }
  seq += 1
  push({
    seq,
    t: now(),
    traceId: opts.traceId,
    parentId: opts.parentId,
    sub,
    what,
    phase: opts.phase,
    detail: typeof detail === 'function' ? detail() : detail,
  })
}

/**
 * One operation, from start to end, carried as a value across its own awaits.
 * `child()` makes a nested operation whose events point back here, which is
 * what turns a flat list into "what caused this write".
 */
export interface Span {
  readonly id: string
  readonly parentId?: string
  step: (what: string, detail?: Detail | (() => Detail)) => void
  /** Records that this operation was overtaken. See Phase. */
  stale: (detail?: Detail) => void
  refused: (detail?: Detail) => void
  error: (detail?: Detail) => void
  child: (kind: string, sub?: Subsystem, detail?: Detail) => Span
  end: (detail?: Detail) => void
}

/**
 * Opens an operation. The id is `KIND-n` — compact, greppable, and stable
 * within a session, so a whole causal chain can be pulled out of a trace by
 * searching one string.
 */
export function beginOp(
  kind: string,
  sub: Subsystem,
  detail?: Detail,
  parentId?: string,
): Span {
  const n = (opCounters.get(kind) ?? 0) + 1
  opCounters.set(kind, n)
  const id = `${kind}-${n}`
  const startedAt = now()
  let ended = false

  emit(sub, kind.toLowerCase(), detail, { traceId: id, parentId, phase: 'start' })

  const finish = (phase: Phase, extra?: Detail) => {
    if (ended) {
      // A span that ends twice is itself a finding: it means a code path
      // resolved an operation more than once. Say so rather than quietly
      // recording a second end.
      emit('err', 'span:double-end', { id, phase }, { traceId: id, parentId, phase: 'error', min: 'error' })
      return
    }
    ended = true
    emit(sub, kind.toLowerCase(), {
      ...extra,
      ms: Math.round((now() - startedAt) * 10) / 10,
    }, { traceId: id, parentId, phase })
  }

  return {
    id,
    parentId,
    step: (what, d) => emit(sub, what, d, { traceId: id, parentId, phase: 'step' }),
    stale: d => finish('stale', d),
    refused: d => finish('refused', d),
    error: d => finish('error', { ...d }),
    child: (childKind, childSub, d) => beginOp(childKind, childSub ?? sub, d, id),
    end: d => finish('end', d),
  }
}

export function events(): TraceEvent[] {
  return [...buffer]
}

export function droppedCount(): number {
  return dropped
}

export function clearEvents(): void {
  buffer.length = 0
  dropped = 0
}

/**
 * The events of one operation and everything it caused, oldest first. This is
 * the query the whole design exists to answer.
 */
export function causalChain(traceId: string): TraceEvent[] {
  const ids = new Set([traceId])
  // One forward pass is enough: a child's start is always recorded after its
  // parent's, so by the time a descendant is reached its ancestor is in the set.
  for (const event of buffer) {
    if (event.parentId && ids.has(event.parentId) && event.traceId) {
      ids.add(event.traceId)
    }
  }
  return buffer.filter(e => (e.traceId && ids.has(e.traceId)) || (e.parentId && ids.has(e.parentId)))
}

/** One line per event, for reading a chain in a console. */
export function formatEvent(e: TraceEvent): string {
  const id = e.traceId ? `[${e.traceId}]` : ''
  const parent = e.parentId ? `←${e.parentId}` : ''
  const phase = e.phase && e.phase !== 'step' ? ` ${e.phase.toUpperCase()}` : ''
  const detail = e.detail ? ` ${JSON.stringify(e.detail)}` : ''
  return `#${e.seq} ${e.t}ms ${id}${parent} ${e.sub}:${e.what}${phase}${detail}`
}
