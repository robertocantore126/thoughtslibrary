import type { TextRun } from './types'

/**
 * Rich text for topic titles (MINDMAP_S4_AGENT_BRIEF Lane A).
 *
 * A title is a FLAT sequence of runs. There is no tree, no block model and no
 * second document: block structure rides on the runs themselves (`paraGap`
 * opens a paragraph, `listIndent` starts a bullet, `fontSize` carries a
 * heading), exactly as types.ts describes them. That flatness is what lets
 * `MindNode.title` stay a plain string that every other consumer in the
 * product — the tile indicator, the chart save file, the outline copy, the
 * tests — can keep reading:
 *
 *     node.title === runsToPlain(node.titleRuns ?? [])
 *
 * That invariant outranks everything here (§T.10). Break it and nothing
 * crashes; the map simply shows one thing and the rest of the app another.
 *
 * Everything in this file is pure. The only DOM contact is `DOMParser` inside
 * `runsFromHtml`, and even there the parsed tree is READ, never adopted into
 * the document — see the comment on that function.
 */

/** Marks a range toggle can address. Style-level marks live on `Style`. */
export type Mark = 'bold' | 'italic' | 'underline' | 'strike'

/**
 * Hard ceiling on a title built from pasted HTML, in plain-text characters.
 *
 * Someone will paste a 400-page document into a topic. Without a cap that
 * becomes a 40,000-run title which is re-measured, re-serialised and
 * re-rendered on every edit, and the map stops responding for reasons the
 * user cannot see. Generous enough that no real title reaches it.
 */
export const MAX_PASTE_CHARS = 2000

/** Heading sizes in px, by `<h1>`–`<h6>` level. */
const HEADING_SIZES = [28, 24, 20, 18, 16, 15]

/** `font-weight` at or above this is bold, matching the CSS keyword `bold`. */
const BOLD_WEIGHT = 600

/**
 * Element nodeType. Spelled numerically because `Node` is not a global in
 * the test environment, and the constants are fixed by the DOM spec anyway.
 */
const ELEMENT_NODE = 1
const TEXT_NODE = 3

/** Tags whose subtree contributes nothing at all — not even its text. */
const SKIPPED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'META',
  'LINK',
  'TITLE',
  'HEAD',
  'NOSCRIPT',
  // Word's `<o:p>` office-namespace paragraph marker, and its `<xml>` island.
  'O:P',
  'XML',
])

/** Tags that end the current paragraph when they open and when they close. */
const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'TR',
  'TABLE',
  'SECTION',
  'ARTICLE',
  'PRE',
])

/** The formatting carried down the tree while walking it. */
interface Marks {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  color?: string
  fontSize?: number
  listIndent?: number
}

// ---------------------------------------------------------------------------
// Plain text <-> runs
// ---------------------------------------------------------------------------

/**
 * The plain-text projection, and the definition of `MindNode.title`.
 *
 * Block structure contributes nothing here: a `paraGap` run already carries
 * its own leading `\n` in `text` when the paragraph break is real text. This
 * is a pure concatenation on purpose — if it synthesised separators, the
 * offsets the editor hands to `toggleMark` would no longer index this string
 * and every range operation would land one character off per paragraph.
 */
export function runsToPlain(runs: TextRun[]): string {
  let out = ''
  for (const run of runs) {
    out += run.text
  }
  return out
}

/**
 * A plain string as runs.
 *
 * Empty text gives an EMPTY array rather than one empty run, so a blank title
 * normalises to `[]` and callers can test it with `.length`.
 */
export function plainToRuns(text: string): TextRun[] {
  return text ? [{ text }] : []
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** The mark fields two adjacent runs must share to be merged into one. */
function sameFormatting(a: TextRun, b: TextRun): boolean {
  return a.bold === b.bold
    && a.italic === b.italic
    && a.underline === b.underline
    && a.strike === b.strike
    && a.color === b.color
    && a.fontSize === b.fontSize
    && a.paraGap === b.paraGap
    && a.listIndent === b.listIndent
}

/**
 * Drop empty runs, drop marks that are set to `false` or `undefined`, and
 * merge adjacent runs that carry identical formatting.
 *
 * Every mutating function in this file ends by calling it, and that is not
 * tidiness. `sizeKey` (cull.ts) serialises `titleRuns` to decide whether a
 * topic must be re-measured, so `{ text: 'a', bold: false }` and
 * `{ text: 'a' }` are the same title but different keys. Toggling bold on and
 * off ten times without this leaves twenty runs that all compare unequal and
 * re-measure the box each time.
 *
 * `paraGap` and `listIndent` are BLOCK properties: they mean "this run opens a
 * paragraph / a bullet at depth n". Two runs are only merged when they agree
 * on those too, or a bulleted line would be swallowed by the plain line above
 * it.
 */
export function normaliseRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const run of runs) {
    if (!run.text) {
      continue
    }
    const clean: TextRun = { text: run.text }
    if (run.bold) {
      clean.bold = true
    }
    if (run.italic) {
      clean.italic = true
    }
    if (run.underline) {
      clean.underline = true
    }
    if (run.strike) {
      clean.strike = true
    }
    if (run.color) {
      clean.color = run.color
    }
    if (run.fontSize) {
      clean.fontSize = run.fontSize
    }
    if (run.paraGap) {
      clean.paraGap = true
    }
    if (run.listIndent && run.listIndent > 0) {
      clean.listIndent = run.listIndent
    }

    const last = out[out.length - 1]
    // A run that opens a block never merges backwards even when its marks
    // match: merging would erase the boundary it exists to mark.
    if (last && !clean.paraGap && sameFormatting(last, clean)) {
      last.text += clean.text
    }
    else {
      out.push(clean)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Range edits
// ---------------------------------------------------------------------------

/**
 * Split `runs` so that plain-text offsets `start` and `end` fall on run
 * boundaries, then hand the caller each run together with whether it lies
 * inside the range.
 *
 * Offsets are plain-text offsets into `runsToPlain(runs)` — the only
 * coordinate system a DOM `Selection` can be reduced to without teaching
 * every caller about run splitting. Converting once, here, is why the three
 * range functions below are four lines each.
 *
 * A run that opens a block keeps `paraGap`/`listIndent` on its FIRST piece
 * only: the boundary belongs to the start of the paragraph, and copying it
 * onto the tail would open a second paragraph mid-word.
 */
function mapRange(
  runs: TextRun[],
  start: number,
  end: number,
  apply: (run: TextRun) => TextRun,
): TextRun[] {
  const lo = Math.max(0, Math.min(start, end))
  const hi = Math.max(start, end)
  if (hi <= lo) {
    return normaliseRuns(runs)
  }

  const out: TextRun[] = []
  let cursor = 0
  for (const run of runs) {
    const runStart = cursor
    const runEnd = cursor + run.text.length
    cursor = runEnd

    // Entirely outside the range.
    if (runEnd <= lo || runStart >= hi) {
      out.push({ ...run })
      continue
    }

    const headLen = Math.max(0, lo - runStart)
    const tailStart = Math.max(0, Math.min(run.text.length, hi - runStart))

    if (headLen > 0) {
      out.push({ ...run, text: run.text.slice(0, headLen) })
    }

    const middle: TextRun = { ...run, text: run.text.slice(headLen, tailStart) }
    if (headLen > 0) {
      delete middle.paraGap
      delete middle.listIndent
    }
    out.push(apply(middle))

    if (tailStart < run.text.length) {
      const tail: TextRun = { ...run, text: run.text.slice(tailStart) }
      delete tail.paraGap
      delete tail.listIndent
      out.push(tail)
    }
  }
  return normaliseRuns(out)
}

/** Every character in `[start, end)` that already carries `mark`. */
function rangeHasMark(runs: TextRun[], start: number, end: number, mark: Mark): boolean {
  const lo = Math.max(0, Math.min(start, end))
  const hi = Math.max(start, end)
  let cursor = 0
  let sawAny = false
  for (const run of runs) {
    const runStart = cursor
    const runEnd = cursor + run.text.length
    cursor = runEnd
    if (runEnd <= lo || runStart >= hi) {
      continue
    }
    sawAny = true
    if (!run[mark]) {
      return false
    }
  }
  return sawAny
}

/**
 * Toggle `mark` over a plain-text range.
 *
 * A toggle over a range, not per run: if EVERY character in the range already
 * has the mark it is removed, otherwise it is added everywhere. Per-run
 * toggling would invert a partly-bold selection into its photographic
 * negative, which is what everyone expects least.
 */
export function toggleMark(
  runs: TextRun[],
  start: number,
  end: number,
  mark: Mark,
): TextRun[] {
  const remove = rangeHasMark(runs, start, end, mark)
  return mapRange(runs, start, end, run => ({ ...run, [mark]: !remove }))
}

/** Set (or with `undefined`, clear) the colour over a plain-text range. */
export function setRunColor(
  runs: TextRun[],
  start: number,
  end: number,
  color: string | undefined,
): TextRun[] {
  return mapRange(runs, start, end, (run) => {
    const next = { ...run }
    if (color) {
      next.color = color
    }
    else {
      delete next.color
    }
    return next
  })
}

/** Set (or with `undefined`, clear) the per-run font size over a range. */
export function setRunFontSize(
  runs: TextRun[],
  start: number,
  end: number,
  size: number | undefined,
): TextRun[] {
  return mapRange(runs, start, end, (run) => {
    const next = { ...run }
    if (size && size > 0) {
      next.fontSize = size
    }
    else {
      delete next.fontSize
    }
    return next
  })
}

// ---------------------------------------------------------------------------
// HTML in
// ---------------------------------------------------------------------------

/**
 * One `style` attribute as a lowercase property map.
 *
 * The raw attribute is parsed here rather than read back off `element.style`,
 * because the CSSOM normalises values (and drops the ones it does not know)
 * differently in each engine. The attribute string is the same everywhere, so
 * a fixture that passes in the test parses identically in the browser.
 */
function parseStyleAttr(value: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!value) {
    return out
  }
  for (const decl of value.split(';')) {
    const colon = decl.indexOf(':')
    if (colon < 0) {
      continue
    }
    const prop = decl.slice(0, colon).trim().toLowerCase()
    const val = decl.slice(colon + 1).trim()
    if (prop && val) {
      out[prop] = val
    }
  }
  return out
}

/**
 * How an element changes the formatting of everything beneath it.
 *
 * The inline style is consulted BEFORE the tag, and that ordering is the
 * whole reason Google Docs pastes survive: Docs wraps its entire clipboard
 * payload in `<b style="font-weight:normal">`, so a walk that trusts `<b>`
 * reads the whole document as bold. An explicit `font-weight` always wins
 * over the tag that carries it.
 */
function marksForElement(tag: string, style: Record<string, string>, inherited: Marks): Marks {
  const next: Marks = { ...inherited }

  const weight = style['font-weight']
  if (weight) {
    const numeric = Number.parseInt(weight, 10)
    next.bold = Number.isNaN(numeric) ? weight === 'bold' || weight === 'bolder' : numeric >= BOLD_WEIGHT
  }
  else if (tag === 'B' || tag === 'STRONG') {
    next.bold = true
  }

  const fontStyle = style['font-style']
  if (fontStyle) {
    next.italic = fontStyle === 'italic' || fontStyle === 'oblique'
  }
  else if (tag === 'I' || tag === 'EM') {
    next.italic = true
  }

  // `text-decoration` is a shorthand, so both marks are read out of the one
  // value and an explicit `none` clears whatever a parent tag set.
  const decoration = style['text-decoration'] ?? style['text-decoration-line']
  if (decoration) {
    next.underline = decoration.includes('underline')
    next.strike = decoration.includes('line-through')
  }
  if (tag === 'U' || tag === 'INS') {
    next.underline = true
  }
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') {
    next.strike = true
  }

  if (style.color) {
    next.color = style.color
  }

  // Headings take a size from a FIXED table, not the source's px: pasting a
  // Word h1 must give this map's idea of a heading, not Word's 40px one
  // scaled to a page this map does not have.
  const heading = /^H([1-6])$/.exec(tag)
  if (heading) {
    next.fontSize = HEADING_SIZES[Number(heading[1]) - 1]
    next.bold = next.bold ?? true
  }

  return next
}

/** Collapse HTML whitespace the way a browser renders it outside `<pre>`. */
function collapseWhitespace(text: string): string {
  return text.replace(/[\t\n\r ]+/g, ' ')
}

/**
 * The only DOM surface this file reads. Spelled out structurally rather than
 * as `Node`, because it is the sanitisation argument in type form: six
 * members, none of which can carry executable content out of the parsed
 * document and into ours.
 */
export interface DomLike {
  nodeType: number
  nodeValue?: string | null
  tagName?: string
  childNodes?: ArrayLike<DomLike>
  getAttribute?: (name: string) => string | null
}

/**
 * A pending line break. The distinction is the whole difference between a
 * `<br>` and a `<p>`: both put a `\n` in the plain text, but only the block
 * one sets `paraGap`, which is what opens the extra vertical space when the
 * topic renders (§A.1). Treating `<br>` as a paragraph would turn every
 * wrapped Word line into a gap.
 */
type PendingBreak = 'soft' | 'block' | null

interface WalkState {
  runs: TextRun[]
  chars: number
  truncated: boolean
  pendingBreak: PendingBreak
  /** No text has been emitted yet, so a pending break would open on nothing. */
  started: boolean
  /** Text is inside a `pre`-like context: its whitespace is content. */
  preserveWhitespace: boolean
}

/** Append text under the current marks, honouring the paste cap. */
function pushText(state: WalkState, text: string, marks: Marks) {
  if (state.truncated || !text) {
    return
  }

  // A pending break becomes a real `\n` in the text. The newline is
  // deliberate: the plain projection is what the rest of the product reads,
  // and a paragraph that vanished from `node.title` would make a pasted list
  // one unreadable line everywhere except the map. The topic box is already
  // `white-space: pre-wrap`, so it renders with no new mechanism.
  const breaking = state.started ? state.pendingBreak : null
  let body = breaking ? `\n${text}` : text

  // The cap counts the boundary newline too, so the result never exceeds it.
  const room = MAX_PASTE_CHARS - state.chars
  if (body.length > room) {
    body = body.slice(0, Math.max(0, room))
    state.truncated = true
  }
  if (!body || body === '\n') {
    return
  }

  const run: TextRun = { text: body }
  if (breaking === 'block') {
    run.paraGap = true
  }
  if (marks.bold) {
    run.bold = true
  }
  if (marks.italic) {
    run.italic = true
  }
  if (marks.underline) {
    run.underline = true
  }
  if (marks.strike) {
    run.strike = true
  }
  if (marks.color) {
    run.color = marks.color
  }
  if (marks.fontSize) {
    run.fontSize = marks.fontSize
  }
  if (marks.listIndent) {
    run.listIndent = marks.listIndent
  }

  state.pendingBreak = null
  state.started = true
  state.chars += body.length
  state.runs.push(run)
}

/** `white-space` values under which the source's own spacing is content. */
function preservesWhitespace(tag: string, style: Record<string, string>): boolean | undefined {
  const value = style['white-space']
  if (value) {
    return value !== 'normal' && value !== 'nowrap'
  }
  return tag === 'PRE' ? true : undefined
}

function walk(node: DomLike, marks: Marks, state: WalkState, listDepth: number) {
  if (state.truncated) {
    return
  }

  if (node.nodeType === TEXT_NODE) {
    const raw = node.nodeValue ?? ''
    if (state.preserveWhitespace) {
      // The editor's own content: its newlines ARE the paragraph breaks, so
      // collapsing here would silently flatten a multi-line title on commit.
      pushText(state, raw, marks)
      return
    }
    const text = collapseWhitespace(raw)
    // Whitespace-only text between block tags is layout, not content.
    if (!text.trim() && (state.pendingBreak || !state.started)) {
      return
    }
    pushText(state, text, marks)
    return
  }

  if (node.nodeType !== ELEMENT_NODE) {
    return
  }

  const tag = String(node.tagName ?? '').toUpperCase()
  // Not a blocklist of dangerous tags but the inverse: only the tags below
  // contribute meaning, everything unknown contributes its TEXT and nothing
  // else. `<script>` and friends contribute not even that.
  if (SKIPPED_TAGS.has(tag)) {
    return
  }

  const getAttribute = node.getAttribute
  const read = (name: string): string | null => (getAttribute ? getAttribute.call(node, name) : null)

  if (tag === 'BR') {
    // A `<br>` never upgrades an already-pending block break to a soft one.
    state.pendingBreak = state.pendingBreak ?? 'soft'
    return
  }

  const isBlock = BLOCK_TAGS.has(tag)
  if (isBlock && state.started) {
    state.pendingBreak = 'block'
  }

  const style = parseStyleAttr(read('style'))
  const nextMarks = marksForElement(tag, style, marks)
  const nextDepth = tag === 'UL' || tag === 'OL' ? listDepth + 1 : listDepth
  if (tag === 'LI') {
    // Depth 1 for a top-level list: `listIndent > 0` is what makes it a
    // bullet at all, so an `<li>` outside any list still reads as one.
    nextMarks.listIndent = Math.max(1, listDepth)
  }

  // The two `data-` hints below exist only on markup THIS module's editor
  // built. Bullet depth and a heading size have no faithful inverse in
  // generic HTML — inferring a run's font size back out of a `font-size`
  // declaration would give every Google Docs span an 11pt size it never
  // meant, and a bullet rendered as CSS carries no `<li>` to count. So the
  // editor states them outright and the reader trusts them, while a pasted
  // document, which carries neither, still goes through pure inference.
  const indentHint = Number.parseInt(read('data-indent') ?? '', 10)
  if (!Number.isNaN(indentHint)) {
    nextMarks.listIndent = indentHint > 0 ? indentHint : undefined
  }
  const sizeHint = Number.parseFloat(read('data-fs') ?? '')
  if (!Number.isNaN(sizeHint) && sizeHint > 0) {
    nextMarks.fontSize = sizeHint
  }
  const preserve = preservesWhitespace(tag, style)
  const outerPreserve = state.preserveWhitespace
  if (preserve !== undefined) {
    state.preserveWhitespace = preserve
  }

  for (const child of Array.from(node.childNodes ?? [])) {
    walk(child, nextMarks, state, nextDepth)
    if (state.truncated) {
      break
    }
  }

  state.preserveWhitespace = outerPreserve

  if (isBlock) {
    state.pendingBreak = 'block'
  }
}

/**
 * Runs from a live DOM subtree, using the same walk the paste path uses.
 *
 * The title editor commits through this: its content is real DOM the browser
 * has been mutating as the user typed, so it cannot be read back as a string
 * without first serialising markup that would then have to be re-parsed.
 * Sharing the walk is the point — a second reader would drift from the paste
 * path and the two would disagree about the same markup.
 *
 * `preserveWhitespace` is on for the editor because its box is
 * `white-space: pre-wrap`: the newlines the user typed are content, and
 * collapsing them would flatten a multi-line title on every commit.
 */
export function runsFromDom(root: DomLike, preserveWhitespace = false): TextRun[] {
  const state: WalkState = {
    runs: [],
    chars: 0,
    truncated: false,
    pendingBreak: null,
    started: false,
    preserveWhitespace,
  }
  walk(root, {}, state, 0)
  return normaliseRuns(state.runs)
}

// ---------------------------------------------------------------------------
// DOM points <-> plain-text offsets
// ---------------------------------------------------------------------------
// The editor's range functions (toggleMark, setRunColor, …) take offsets into
// `runsToPlain(runs)` — the only coordinate system a DOM `Selection` can be
// reduced to. Mapping a DOM point to that string is done here, with the SAME
// traversal `walk` uses, so the two can never disagree about where a boundary
// newline is. A second reader would be a second answer to "how long is this
// title", which is the exact bug class this module exists to prevent.
//
// The editor walks with `preserveWhitespace` on, so the rules below mirror the
// preserve branch of `walk`/`pushText` only. The paste path never asks for an
// offset.

/** The position of a DOM point in a document subtree, counting like the walk. */
interface PlainCursor {
  chars: number
  started: boolean
  pending: PendingBreak | null
}

/**
 * The plain-text length a node contributes, mirroring the preserve branch of
 * `walk` + `pushText` exactly, and mutating `st` the way that branch does.
 *
 * The two skip rules are load-bearing: `pushText` drops an empty string and a
 * lone `\n` that would be the whole body, and in both cases the pending break
 * SURVIVES — which is how consecutive boundaries collapse into one newline.
 */
function walkLength(node: DomLike, st: PlainCursor): number {
  if (node.nodeType === TEXT_NODE) {
    const raw = node.nodeValue ?? ''
    if (!raw || (raw === '\n' && !(st.pending && st.started))) {
      return 0
    }
    const breakLen = st.pending && st.started ? 1 : 0
    st.pending = null
    st.started = true
    return breakLen + raw.length
  }
  if (node.nodeType !== ELEMENT_NODE) {
    return 0
  }
  const tag = String(node.tagName ?? '').toUpperCase()
  if (SKIPPED_TAGS.has(tag)) {
    return 0
  }
  if (tag === 'BR') {
    st.pending = st.pending ?? 'soft'
    return 0
  }
  const isBlock = BLOCK_TAGS.has(tag)
  // Same enter/exit ordering as walk(): the enter check sees the pre-children
  // `started`, the exit check runs unconditionally like walk's trailing one.
  if (isBlock && st.started) {
    st.pending = 'block'
  }
  if (st.started && node.getAttribute && node.getAttribute('data-para') != null) {
    st.pending = 'block'
  }
  let total = 0
  for (const child of Array.from(node.childNodes ?? [])) {
    total += walkLength(child, st)
  }
  if (isBlock) {
    st.pending = 'block'
  }
  return total
}

/**
 * The plain-text offset of a DOM point inside `root`.
 *
 * For a point on a text node this is exact. For a point on an element (a
 * caret between blocks, a select-all endpoint) the offset is the position
 * just before the element's content, plus whatever of the element's children
 * precede the point — measured on a state copy so the pending break cannot be
 * consumed twice.
 */
export function plainOffsetOf(root: DomLike, point: { node: DomLike, offset: number }): number {
  const st: PlainCursor = { chars: 0, started: false, pending: null }

  const visit = (node: DomLike): number | null => {
    if (node.nodeType === TEXT_NODE) {
      const raw = node.nodeValue ?? ''
      if (!raw || (raw === '\n' && !(st.pending && st.started))) {
        return null
      }
      if (point.node === node) {
        const breakLen = st.pending && st.started ? 1 : 0
        return st.chars + breakLen + Math.max(0, Math.min(point.offset, raw.length))
      }
      st.chars += walkLength(node, st)
      return null
    }
    if (node.nodeType !== ELEMENT_NODE) {
      return null
    }
    const tag = String(node.tagName ?? '').toUpperCase()
    if (SKIPPED_TAGS.has(tag)) {
      return null
    }
    if (tag === 'BR') {
      st.pending = st.pending ?? 'soft'
      return null
    }
    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock && st.started) {
      st.pending = 'block'
    }
    if (st.started && node.getAttribute && node.getAttribute('data-para') != null) {
      st.pending = 'block'
    }

    if (point.node === node) {
      const children = Array.from(node.childNodes ?? [])
      if (point.offset <= 0) {
        // Before the first child: the pending break, if any, materialises at
        // that child's text — which is exactly the position we are asked for.
        return st.chars + (st.pending && st.started ? 1 : 0)
      }
      const copy: PlainCursor = { chars: st.chars, started: st.started, pending: st.pending }
      let contributed = 0
      for (let i = 0; i < Math.min(point.offset, children.length); i++) {
        contributed += walkLength(children[i], copy)
      }
      let at = st.chars + contributed
      // A break left over by the measured children (a block exit between the
      // cut and the next sibling) materialises at the sibling's text, so the
      // point is on its far side.
      if (copy.pending && copy.started && point.offset < children.length) {
        at += 1
      }
      return at
    }

    for (const child of Array.from(node.childNodes ?? [])) {
      const hit = visit(child)
      if (hit !== null) {
        return hit
      }
    }
    if (isBlock) {
      st.pending = 'block'
    }
    return null
  }

  return visit(root) ?? st.chars
}

/**
 * The DOM point at a plain-text offset — the inverse of `plainOffsetOf`.
 *
 * Always a point on a text node (never an element boundary), so a caller can
 * hand it straight to a `Range`. An offset that lands on a paragraph break
 * resolves to the start of the following text — the caret on either side of
 * the invisible newline is the same place. An offset past the end resolves to
 * the end of the last text node. `null` only for an offset in a subtree with
 * no text at all.
 */
export function plainPointOf(root: DomLike, target: number): { node: DomLike, offset: number } | null {
  const st: PlainCursor = { chars: 0, started: false, pending: null }
  let lastText: DomLike | null = null
  let lastLen = 0

  const find = (node: DomLike): { node: DomLike, offset: number } | null => {
    if (node.nodeType === TEXT_NODE) {
      const raw = node.nodeValue ?? ''
      if (!raw || (raw === '\n' && !(st.pending && st.started))) {
        return null
      }
      const breakLen = st.pending && st.started ? 1 : 0
      if (target <= st.chars + breakLen) {
        return { node, offset: 0 }
      }
      const start = st.chars + breakLen
      const end = start + raw.length
      st.chars = end
      st.pending = null
      st.started = true
      lastText = node
      lastLen = raw.length
      if (target <= end) {
        return { node, offset: target - start }
      }
      return null
    }
    if (node.nodeType !== ELEMENT_NODE) {
      return null
    }
    const tag = String(node.tagName ?? '').toUpperCase()
    if (SKIPPED_TAGS.has(tag)) {
      return null
    }
    if (tag === 'BR') {
      st.pending = st.pending ?? 'soft'
      return null
    }
    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock && st.started) {
      st.pending = 'block'
    }
    if (st.started && node.getAttribute && node.getAttribute('data-para') != null) {
      st.pending = 'block'
    }
    for (const child of Array.from(node.childNodes ?? [])) {
      const hit = find(child)
      if (hit !== null) {
        return hit
      }
    }
    if (isBlock) {
      st.pending = 'block'
    }
    return null
  }

  const hit = find(root)
  return hit ?? (lastText ? { node: lastText, offset: lastLen } : null)
}

/**
 * Runs from a `text/html` clipboard payload — Word, Google Docs, Draw.io.
 *
 * The parsed document is READ and thrown away. Nothing from `html` is ever
 * inserted into the live document: no `v-html`, no `insertAdjacentHTML`, not
 * even into a detached node that is later re-attached. `DOMParser` with
 * `text/html` builds an inert document (scripts do not run, `src` is not
 * fetched), the walk copies out text and a fixed set of formatting facts, and
 * the renderer builds its OWN spans from those facts. That is what makes the
 * sanitisation total rather than a blocklist someone has to keep ahead of
 * every new element — an unknown tag cannot smuggle anything through a path
 * that only ever reads `nodeValue` and six CSS properties.
 *
 * Returns `[]` when the payload has no text, so a caller can fall back to the
 * `text/plain` flavour.
 */
export function runsFromHtml(html: string): TextRun[] {
  if (!html) {
    return []
  }
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser
  if (!Parser) {
    // No parser (a non-DOM host): the payload's text is better than nothing,
    // and stripping tags with a regex here would be the blocklist this
    // function exists to avoid, so the whole string is treated as plain.
    return normaliseRuns(plainToRuns(html.slice(0, MAX_PASTE_CHARS)))
  }

  const doc = new Parser().parseFromString(html, 'text/html')
  const root = (doc?.body ?? doc?.documentElement) as DomLike | undefined
  return root ? runsFromDom(root) : []
}

// ---------------------------------------------------------------------------
// Runs out — shared by the two renderers
// ---------------------------------------------------------------------------

/** One rendered line of a title: its runs, plus the block facts they carry. */
export interface RunParagraph {
  runs: TextRun[]
  /** Opens a new paragraph, so it takes the extra leading gap. */
  paraGap: boolean
  /** >0 → a bullet at this depth, with a hanging indent. */
  listIndent: number
}

/**
 * Group a flat run list into the lines it draws as.
 *
 * Two things render runs: `MindmapTopicContent` (Vue, for the topic and the
 * measure layer) and the inline editor (imperative DOM, because a
 * contenteditable and Vue's reactivity cannot both own the same subtree).
 * They must agree, so the rule for where a line starts lives here once
 * instead of twice.
 *
 * A run's leading `\n` is the plain-text ENCODING of the break — it is what
 * keeps `node.title` readable outside the map. Once the break has become a
 * separate paragraph it must not also be drawn, or every paragraph renders
 * with a blank line above it, so it is stripped from the rendered text.
 * Newlines inside a run are soft breaks and stay.
 */
export function runParagraphs(runs: TextRun[]): RunParagraph[] {
  const out: RunParagraph[] = []
  for (const run of runs) {
    const indent = run.listIndent ?? 0
    const previous = out[out.length - 1]
    const starts = !previous || run.paraGap || indent !== previous.listIndent
    const text = run.paraGap && run.text.startsWith('\n') ? run.text.slice(1) : run.text

    if (starts) {
      out.push({ runs: [{ ...run, text }], paraGap: !!run.paraGap, listIndent: indent })
    }
    else {
      previous.runs.push({ ...run, text })
    }
  }
  return out
}

/**
 * A run's marks as inline CSS, for whichever renderer is drawing it.
 *
 * Returned as a style object rather than applied, so the Vue template and the
 * editor's `createElement` path share one answer. If these two ever disagreed
 * the user would watch their formatting change the moment they opened the
 * editor over it.
 */
export function runStyle(run: TextRun): Record<string, string> {
  const style: Record<string, string> = {}
  if (run.bold) {
    style.fontWeight = '700'
  }
  if (run.italic) {
    style.fontStyle = 'italic'
  }
  // One declaration, because two `text-decoration` rules do not combine —
  // the second would silently drop the first on a word that is both.
  const decoration = [run.underline ? 'underline' : '', run.strike ? 'line-through' : '']
    .filter(Boolean)
    .join(' ')
  if (decoration) {
    style.textDecoration = decoration
  }
  if (run.color) {
    style.color = run.color
  }
  if (run.fontSize) {
    style.fontSize = `${run.fontSize}px`
  }
  return style
}
