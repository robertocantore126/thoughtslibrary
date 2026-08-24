import { writeSheet } from '../mindmap/storage'
import { SCHEMA_VERSION, type Sheet } from '../mindmap/types'

/**
 * `.rnode.json` import — how a user's existing r-node maps move into a tile
 * (MINDMAP_S2_AGENT_BRIEF M4).
 *
 * A `.rnode.json` is a plain RnodeDocument. The repo's `Sheet` schema was
 * ported verbatim from r-node, so `sheets[0]` is already a valid sheet — the
 * import's real job is validation and re-keying, not translation.
 *
 * Images are explicitly out of scope for S2: a `.rnode.json` references assets
 * by SHA-256 that this machine does not have. Taking `sheets[0]` as-is keeps
 * every `style.image` and `attachment` reference intact so a later stage can
 * resolve them; nothing is silently stripped.
 */

export interface ImportResult {
  /** The fresh id the imported sheet was stored under. */
  sheetId: string
  title: string
  nodeCount: number
}

interface RnodeDocument {
  schemaVersion?: string
  sheets: unknown[]
}

/** A parsed r-node document is an object with a non-empty sheets array. */
function asRnodeDocument(value: unknown): RnodeDocument | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.sheets) || candidate.sheets.length === 0) {
    return null
  }
  return {
    schemaVersion: typeof candidate.schemaVersion === 'string' ? candidate.schemaVersion : undefined,
    sheets: candidate.sheets,
  }
}

/** The importer's validation pass — a sheet must be worth storing. */
function asSheet(value: unknown): Sheet | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const c = value as Partial<Sheet>
  if (typeof c.rootNodeId !== 'string') {
    return null
  }
  if (!c.nodes || typeof c.nodes !== 'object') {
    return null
  }
  // The sheet's central node must exist, or the map has nothing to anchor on.
  if (!(c.rootNodeId in c.nodes)) {
    return null
  }
  return value as Sheet
}

/**
 * Imports a `.rnode.json` string into a fresh sheet in the mindmaps store.
 *
 * Never reuses the file's sheet id (§T.6 of the S1 brief: sheet ids are
 * per-machine keys, and the document may already exist under that id here).
 * Returns the fresh id so the caller can point a tile's `chart.mindmaps` at
 * it, then open the map.
 *
 * Throws a plain-English message (not a corrupt sheet) if the text is not a
 * valid r-node document, so the caller can surface it to the user.
 */
export async function importRnode(text: string): Promise<ImportResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    throw new Error('This file is not valid JSON.')
  }

  const doc = asRnodeDocument(parsed)
  if (!doc) {
    throw new Error('This file is not an r-node map: it has no sheets to import.')
  }

  // r-node is single-sheet in practice; S1 dropped the document wrapper's
  // other sheets and nothing ever reads past `[0]`.
  const sheet = asSheet(doc.sheets[0])
  if (!sheet) {
    throw new Error('This r-node map has no valid sheet to import.')
  }

  // The schema is a contract both machines sign. Compare the MAJOR only: a
  // 0.1.x file and a 0.1.x reader should not refuse each other over a patch
  // number, but a stub from an unrelated tool rarely names a 0.x major and
  // refusing loudly beats importing junk.
  const schemaMajor = doc.schemaVersion?.split('.')[0]
  const ourMajor = SCHEMA_VERSION.split('.')[0]
  if (doc.schemaVersion && schemaMajor !== ourMajor) {
    throw new Error(`Unsupported r-node schema version "${doc.schemaVersion}" (this build reads ${SCHEMA_VERSION}).`)
  }

  // Fresh identity: the imported map is a NEW document in this app.
  const freshId = crypto.randomUUID()
  await writeSheet(freshId, { ...sheet, sheetId: freshId })

  return {
    sheetId: freshId,
    title: sheet.title || '(untitled)',
    nodeCount: Object.keys(sheet.nodes).length,
  }
}
