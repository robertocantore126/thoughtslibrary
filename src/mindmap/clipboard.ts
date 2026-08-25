import type { MindNode, Sheet, TextRun } from './types'
/**
 * Copy, cut and paste for whole subtrees (MINDMAP_S4_AGENT_BRIEF §C.5).
 *
 * A copy writes TWO flavours: `text/plain` — the indented outline, which is
 * also what Mod+Shift+C produces on its own — and the structured payload,
 * carried in a `text/html` attribute so it survives a trip through the system
 * clipboard and back. Paste prefers the structured flavour and falls back to
 * reading the plain lines as an outline, so text pasted from anywhere at all
 * still becomes a tree.
 *
 * The payload carries whole `MindNode` objects, so `titleRuns` (Lane A's rich
 * titles) travels without this module knowing what a run is. Nothing here
 * strips it.
 */
import { cloneNode } from './ops'

/** Tags a payload as ours, so foreign JSON on the clipboard is not mistaken for one. */
export const CLIPBOARD_KIND = 'thoughtslibrary/mindmap'

export interface ClipboardPayload {
  kind: 'thoughtslibrary/mindmap'
  /** Every node of every copied subtree, roots first, then their descendants. */
  nodes: MindNode[]
  /** The subtree roots, in document order. Their `parentId` is null. */
  roots: string[]
}

/** The attribute the structured payload rides in on the `text/html` flavour. */
const HTML_PAYLOAD_ATTR = 'data-thoughtslibrary-mindmap'
/** One outline level. Two spaces, matching the parser's tab-is-two-spaces rule. */
const OUTLINE_INDENT = '  '

// Same in-app payload the last copy produced. The system clipboard is the
// interchange format, but a browser may refuse a structured read (no
// permission, no ClipboardItem) and hand back only the plain outline — in
// which case a same-session paste would silently lose every title run and
// style. Remembering the payload makes the common case lossless regardless.
let lastCopied: ClipboardPayload | null = null

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * The ids in `ids` that are not already inside another id's subtree.
 *
 * Copying, deleting or moving a parent already carries its children, so the
 * descendant entries are not just redundant — they would produce a second,
 * overlapping subtree snapshot of the same nodes (§C.5's removeMany rule) or a
 * second copy of them in the payload. Returned in document order so a pasted
 * or restored batch keeps the order it was read in.
 */
export function topLevelIds(sheet: Sheet, ids: string[]): string[] {
  const wanted = new Set(ids.filter(id => !!sheet.nodes[id]))
  const covered = new Set<string>()
  for (const id of wanted) {
    const walk = (nodeId: string) => {
      for (const childId of sheet.nodes[nodeId]?.childrenIds ?? []) {
        covered.add(childId)
        walk(childId)
      }
    }
    walk(id)
  }
  const out: string[] = []
  const order = (id: string) => {
    if (wanted.has(id) && !covered.has(id)) {
      out.push(id)
    }
    for (const childId of sheet.nodes[id]?.childrenIds ?? []) {
      order(childId)
    }
  }
  order(sheet.rootNodeId)
  // A node the root cannot reach (a legacy import, a hand-edited file) would
  // otherwise be dropped from a copy that plainly asked for it.
  for (const id of wanted) {
    if (!covered.has(id) && !out.includes(id)) {
      out.push(id)
    }
  }
  return out
}

/** Deep-copies the subtrees rooted at `ids`, dropping any id another one covers. */
export function serialiseSubtrees(sheet: Sheet, ids: string[]): ClipboardPayload {
  const roots = topLevelIds(sheet, ids)
  const rootSet = new Set(roots)
  const nodes: MindNode[] = []
  const walk = (id: string) => {
    const node = sheet.nodes[id]
    if (!node) {
      return
    }
    const copy = cloneNode(node)
    // A root's parent is not in the payload, so pointing at it would describe
    // a tree the payload is no longer part of. Paste sets the real parent.
    if (rootSet.has(id)) {
      copy.parentId = null
    }
    nodes.push(copy)
    for (const childId of node.childrenIds) {
      walk(childId)
    }
  }
  for (const rootId of roots) {
    walk(rootId)
  }
  return { kind: CLIPBOARD_KIND, nodes, roots }
}

/**
 * A copy of the payload in which every node carries a brand-new id.
 *
 * MANDATORY on paste. Pasting a payload with its original ids into the sheet
 * it came from overwrites those nodes and corrupts `childrenIds` on both
 * sides — and it does it silently, because the map still renders. S3 A.4 hit
 * the same class of bug with sheet ids.
 */
export function remapIds(payload: ClipboardPayload): ClipboardPayload {
  const fresh = new Map<string, string>()
  for (const node of payload.nodes) {
    fresh.set(node.id, crypto.randomUUID())
  }
  const nodes = payload.nodes.map((node) => {
    const copy = cloneNode(node)
    copy.id = fresh.get(node.id) as string
    copy.parentId = node.parentId === null ? null : fresh.get(node.parentId) ?? null
    copy.childrenIds = node.childrenIds
      .map(childId => fresh.get(childId))
      .filter((childId): childId is string => !!childId)
    return copy
  })
  return {
    kind: CLIPBOARD_KIND,
    nodes,
    roots: payload.roots
      .map(rootId => fresh.get(rootId))
      .filter((rootId): rootId is string => !!rootId),
  }
}

/**
 * The indented plain-text outline of a payload.
 *
 * It reads `title`, the plain-text projection every consumer in the product
 * uses (§T.10) — the styled runs travel in the structured flavour instead. A
 * title containing newlines (a code topic) is folded onto one line, or the
 * outline's own indentation would stop describing the tree.
 */
export function outlineOfPayload(payload: ClipboardPayload): string {
  const byId = new Map(payload.nodes.map(node => [node.id, node]))
  const lines: string[] = []
  const walk = (id: string, depth: number) => {
    const node = byId.get(id)
    if (!node) {
      return
    }
    lines.push(OUTLINE_INDENT.repeat(depth) + node.title.replace(/\s*\n\s*/g, ' '))
    for (const childId of node.childrenIds) {
      walk(childId, depth + 1)
    }
  }
  for (const rootId of payload.roots) {
    walk(rootId, 0)
  }
  return lines.join('\n')
}

/** The indented outline of the subtrees rooted at `ids` — Mod+Shift+C's output. */
export function toOutlineText(sheet: Sheet, ids: string[]): string {
  return outlineOfPayload(serialiseSubtrees(sheet, ids))
}

/** A tab counts as one outline level, so a tab-indented paste nests correctly. */
function indentWidth(line: string): number {
  let width = 0
  for (const char of line) {
    if (char === '\t') {
      width += OUTLINE_INDENT.length
    }
    else if (char === ' ') {
      width += 1
    }
    else {
      break
    }
  }
  return width
}

function blankNode(title: string, parentId: string | null): MindNode {
  const now = nowIso()
  return {
    id: crypto.randomUUID(),
    type: 'subtopic',
    parentId,
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
}

/**
 * Reads indented lines as a tree — the fallback for text that came from
 * anywhere but this app. Leading list bullets are stripped so a markdown or
 * Google Docs list pastes as the nesting it looks like.
 */
export function outlineToPayload(text: string): ClipboardPayload {
  const nodes: MindNode[] = []
  const byId = new Map<string, MindNode>()
  const roots: string[] = []
  const stack: { indent: number, id: string }[] = []
  for (const line of text.split(/\r?\n/)) {
    const title = line.trim().replace(/^[-*•]\s+/, '').trim()
    if (!title) {
      continue
    }
    const indent = indentWidth(line)
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const node = blankNode(title, parent?.id ?? null)
    nodes.push(node)
    byId.set(node.id, node)
    if (parent) {
      byId.get(parent.id)?.childrenIds.push(node.id)
    }
    else {
      roots.push(node.id)
    }
    stack.push({ indent, id: node.id })
  }
  return { kind: CLIPBOARD_KIND, nodes, roots }
}

// A payload read back off the clipboard is untrusted input: it may have been
// hand-edited, truncated, or written by an older build. A node missing `style`
// or `position` reaches layoutSheet and takes the map down, so every field is
// rebuilt here rather than trusted.
function normaliseNode(raw: unknown): MindNode | null {
  const node = raw as Partial<MindNode> | null
  if (!node || typeof node.id !== 'string' || node.id === '') {
    return null
  }
  const base = blankNode(typeof node.title === 'string' ? node.title : '', null)
  const position = node.position
  const metadata = node.metadata
  return {
    ...base,
    id: node.id,
    type: node.type ?? 'subtopic',
    parentId: typeof node.parentId === 'string' ? node.parentId : null,
    childrenIds: Array.isArray(node.childrenIds)
      ? node.childrenIds.filter((childId): childId is string => typeof childId === 'string')
      : [],
    titleRuns: Array.isArray(node.titleRuns) ? (node.titleRuns as TextRun[]) : undefined,
    position: position && typeof position === 'object'
      ? { x: Number(position.x) || 0, y: Number(position.y) || 0, manual: !!position.manual }
      : base.position,
    style: node.style && typeof node.style === 'object' ? { ...node.style } : {},
    collapsed: !!node.collapsed,
    labels: Array.isArray(node.labels) ? [...node.labels] : [],
    markers: Array.isArray(node.markers) ? [...node.markers] : [],
    notes: typeof node.notes === 'string' ? node.notes : '',
    task: node.task ?? null,
    // Kept rather than restamped: a payload that survives a JSON round trip
    // must come back as what went in, and `blankNode`'s fresh timestamps would
    // silently rewrite the history of every pasted topic.
    metadata: metadata && typeof metadata === 'object'
      ? {
          createdAt: typeof metadata.createdAt === 'string' ? metadata.createdAt : base.metadata.createdAt,
          updatedAt: typeof metadata.updatedAt === 'string' ? metadata.updatedAt : base.metadata.updatedAt,
        }
      : base.metadata,
  }
}

/** Parses a JSON string as one of our payloads, or null if it is anything else. */
export function parsePayload(text: string): ClipboardPayload | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch {
    // Ordinary text on the clipboard is the common case, not an error.
    return null
  }
  const candidate = raw as Partial<ClipboardPayload> | null
  if (!candidate || candidate.kind !== CLIPBOARD_KIND || !Array.isArray(candidate.nodes)) {
    return null
  }
  const nodes = candidate.nodes
    .map(normaliseNode)
    .filter((node): node is MindNode => node !== null)
  if (nodes.length === 0) {
    return null
  }
  const present = new Set(nodes.map(node => node.id))
  for (const node of nodes) {
    node.childrenIds = node.childrenIds.filter(childId => present.has(childId))
    if (node.parentId !== null && !present.has(node.parentId)) {
      node.parentId = null
    }
  }
  const declared = Array.isArray(candidate.roots) ? candidate.roots : []
  const roots = declared.filter(rootId => present.has(rootId))
  return {
    kind: CLIPBOARD_KIND,
    nodes,
    // A payload whose roots list did not survive still holds a usable tree:
    // the parentless nodes are its roots by definition.
    roots: roots.length > 0 ? roots : nodes.filter(node => node.parentId === null).map(node => node.id),
  }
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
}

/** The `text/html` flavour: the outline, with the payload riding in an attribute. */
export function payloadToHtml(payload: ClipboardPayload, outline: string): string {
  const json = escapeAttribute(JSON.stringify(payload))
  return `<div ${HTML_PAYLOAD_ATTR}="${json}">${escapeAttribute(outline)}</div>`
}

/**
 * Pulls our payload back out of the `text/html` flavour.
 *
 * A regex rather than DOMParser: this markup is our own, one attribute on one
 * element, so the match is exact — and keeping the module free of DOM globals
 * is what lets the whole thing be tested in the node environment the suite
 * runs in. HTML from anywhere else simply does not match and falls through to
 * the plain-text path.
 */
export function payloadFromHtml(html: string): ClipboardPayload | null {
  const match = new RegExp(`${HTML_PAYLOAD_ATTR}="([^"]*)"`).exec(html)
  return match ? parsePayload(unescapeAttribute(match[1])) : null
}

function clipboardApi(): Clipboard | null {
  return typeof navigator === 'undefined' ? null : navigator.clipboard ?? null
}

/**
 * Puts a copied payload on the system clipboard in both flavours, and
 * remembers it in-process. Never throws: a clipboard the browser refuses must
 * not take an editing session down, and the in-process copy still works.
 */
export async function writeClipboard(payload: ClipboardPayload, outline: string): Promise<void> {
  lastCopied = payload
  const clipboard = clipboardApi()
  if (!clipboard) {
    return
  }
  try {
    if (typeof ClipboardItem !== 'undefined' && clipboard.write) {
      await clipboard.write([new ClipboardItem({
        'text/plain': new Blob([outline], { type: 'text/plain' }),
        'text/html': new Blob([payloadToHtml(payload, outline)], { type: 'text/html' }),
      })])
      return
    }
  }
  catch (error) {
    // Firefox before 127 has no ClipboardItem, and a page without focus is
    // refused outright. Both fall through to the plain-text write below.
    console.warn('Could not write the structured clipboard flavour:', error)
  }
  try {
    await clipboard.writeText(outline)
  }
  catch (error) {
    console.warn('Could not write to the clipboard:', error)
  }
}

/**
 * Whatever is on the clipboard, as a payload: the structured flavour first,
 * then JSON on the plain flavour, then the remembered in-process copy when the
 * plain text is the outline it produced (which keeps title runs), and finally
 * the plain lines read as an outline. Null when there is nothing usable.
 */
export async function readClipboard(): Promise<ClipboardPayload | null> {
  const clipboard = clipboardApi()
  if (clipboard?.read) {
    try {
      for (const item of await clipboard.read()) {
        if (!item.types.includes('text/html')) {
          continue
        }
        const payload = payloadFromHtml(await (await item.getType('text/html')).text())
        if (payload) {
          return payload
        }
      }
    }
    catch {
      // A refused structured read is expected wherever clipboard-read is not
      // granted; the plain-text path below needs no permission.
    }
  }
  if (clipboard?.readText) {
    try {
      const text = await clipboard.readText()
      if (text.trim() !== '') {
        return parsePayload(text)
          ?? (lastCopied && outlineOfPayload(lastCopied) === text ? lastCopied : null)
          ?? outlineToPayload(text)
      }
    }
    catch (error) {
      console.warn('Could not read the clipboard:', error)
    }
  }
  return lastCopied
}
