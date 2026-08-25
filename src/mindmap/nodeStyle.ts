import type { CSSProperties } from 'vue'
import { DEFAULT_STYLE, type MindNode, type Sheet } from './types'

/** Display width used when a topic carries an image but no explicit width. */
export const DEFAULT_IMAGE_WIDTH = 120

/** Assumed height/width for an image whose aspect was never recorded. */
export const DEFAULT_IMAGE_ASPECT = 0.75

// The r-node light-theme branch palette (read out of r-node's own theme
// registry in its export): depth-1 topics take a branch colour by their index
// among the root's children, depth-2 the matching soft pastel, deeper topics
// fall back to white. The root itself is white with dark text.
export const RNODE_BRANCH_COLORS = [
  '#ff646b',
  '#ff9a66',
  '#4eb5e8',
  '#55c9bd',
  '#a7d9bb',
  '#d979e5',
  '#70b9e8',
  '#f0bd62',
]
export const RNODE_BRANCH_SOFT = [
  '#ffdfe1',
  '#ffe8dc',
  '#dff4ff',
  '#dff8f5',
  '#e5f6ec',
  '#f6e1f9',
  '#deeffb',
  '#fff0d3',
]
const ROOT_FILL = '#ffffff'
const DEEP_FILL = '#ffffff'

/**
 * Edges from `node` up to the root, following parentId (r-node's `depthOf`).
 * The root itself is depth 0; a direct child is depth 1; anything that cannot
 * reach the root is clamped to 3.
 */
function depthOf(node: MindNode, sheet: Sheet): number {
  let depth = 0
  let id: string | null = node.id
  while (id && id !== sheet.rootNodeId && depth < 64) {
    id = sheet.nodes[id]?.parentId ?? null
    depth += 1
  }
  return id === sheet.rootNodeId ? depth : 3
}

/** The depth-1 ancestor of `node` (its branch root), or the node itself if it is the root. */
function branchRootOf(node: MindNode, sheet: Sheet): MindNode {
  let current = node
  while (current.parentId && current.parentId !== sheet.rootNodeId) {
    const parent = sheet.nodes[current.parentId]
    if (!parent) {
      break
    }
    current = parent
  }
  return current
}

/** The branch root's index among the root's children, 0-based (r-node `branchIndex`, mod 8). */
function branchIndexOf(node: MindNode, sheet: Sheet): number {
  const root = sheet.nodes[sheet.rootNodeId]
  const branch = branchRootOf(node, sheet)
  const index = root ? root.childrenIds.indexOf(branch.id) : -1
  return index >= 0 ? index % RNODE_BRANCH_COLORS.length : 0
}

/** Mix a `#rrggbb` colour toward white by `amount` (r-node's `vt`, used for depth-2 fills under an explicit branch fill). */
function lightenTowardWhite(hex: string, amount: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) {
    return hex
  }
  const n = Number.parseInt(match[1], 16)
  const mix = (channel: number) => Math.round(channel + (255 - channel) * amount)
  const r = mix((n >> 16) & 255)
  const g = mix((n >> 8) & 255)
  const b = mix(n & 255)
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/**
 * The fill a topic paints, mirroring r-node's `resolveFill` exactly: an
 * explicit Style fill wins; otherwise the root is white, a depth-1 topic takes
 * its branch colour (or the root's explicit fill), a depth-2 topic takes the
 * matching soft pastel (or the branch root's fill lightened toward white),
 * and anything deeper is white. Used by BOTH the live topic and the SVG export
 * so the exported map colours exactly like the canvas.
 */
export function resolveNodeFill(node: MindNode, sheet: Sheet): string {
  if (node.style.fill) {
    return node.style.fill
  }
  const depth = depthOf(node, sheet)
  if (depth === 0) {
    return ROOT_FILL
  }
  if (depth === 1) {
    const root = sheet.nodes[sheet.rootNodeId]
    return root?.style.fill ?? RNODE_BRANCH_COLORS[branchIndexOf(node, sheet)]
  }
  if (depth === 2) {
    const branchFill = branchRootOf(node, sheet).style.fill ?? sheet.nodes[sheet.rootNodeId]?.style.fill
    return branchFill ? lightenTowardWhite(branchFill, 0.3) : RNODE_BRANCH_SOFT[branchIndexOf(node, sheet)]
  }
  return DEEP_FILL
}

/**
 * Box-affecting Style → inline CSS, SHARED between the rendered topic
 * (MindmapNode.vue) and the hidden measure layer (MindmapCanvas.vue).
 *
 * MINDMAP_S2_AGENT_BRIEF M2 + trap 4: everything that changes a topic's
 * measured size must be applied in ONE place so the browser measures the same
 * box layout used to place it. The measure layer must not be a simplified
 * cousin of the rendered topic — if it is, layout derives sizes from the wrong
 * box and the box-affecting mismatch reappears.
 *
 * Only fields present on `node.style` are returned, plus what a Shape
 * inherently demands (a capsule is round, `rect`/`underline`/`none` drop the
 * radius or the box). Absent fields fall through to the shared `.mindmap-node`
 * base class in src/global.css, which is the single source of the defaults
 * (padding 6, font 14/400, border 1px). Both callers apply this to their box,
 * so DEFAULTs match DEFAULTs.
 */

/** The box-affecting overrides for a node, applied to its topic box. */
export function topicBoxStyle(node: MindNode): CSSProperties {
  const s = node.style
  const shape = s.shape ?? 'rounded'

  const style: CSSProperties = {}

  if (s.fontSize !== undefined) {
    style.fontSize = `${s.fontSize}px`
  }
  if (s.fontWeight !== undefined) {
    style.fontWeight = s.fontWeight
  }
  if (s.italic !== undefined) {
    style.fontStyle = s.italic ? 'italic' : 'normal'
  }
  if (s.fontFamily !== undefined) {
    style.fontFamily = s.fontFamily
  }
  if (s.padding !== undefined) {
    style.padding = `${s.padding}px`
  }
  // A manual box override (node resize): width/height are in world units and
  // REPLACE the natural wrap, so the CSS max-width that constrains an auto
  // box must not fight them — a 420px-wide topic resized by hand would be
  // silently clamped back to 280 otherwise.
  if (s.width !== undefined) {
    style.width = `${Math.max(1, s.width)}px`
    style.maxWidth = 'none'
  }
  if (s.height !== undefined) {
    // box-sizing keeps height applying inside the padding/border, exactly as
    // the natural box would.
    style.height = `${Math.max(1, s.height)}px`
  }
  if (s.borderWidth !== undefined) {
    style.borderWidth = `${s.borderWidth}px`
  }
  if (s.borderStyle !== undefined) {
    style.borderStyle = s.borderStyle
  }
  if (s.stroke !== undefined) {
    style.borderColor = s.stroke
  }

  if (shape === 'rect') {
    style.borderRadius = '0'
  }
  else if (shape === 'capsule') {
    // A pill: a round radius sufficiently large that a short edge corners fully.
    style.borderRadius = '999px'
  }
  else if (shape === 'underline' || shape === 'none') {
    // These shapes are text-only: no box border, no background. Padding stays
    // the default so the box still has both dimensions for measurement.
    style.border = 'none'
  }
  else if (s.cornerRadius !== undefined) {
    style.borderRadius = `${s.cornerRadius}px`
  }
  else {
    style.borderRadius = `${DEFAULT_STYLE.cornerRadius}px`
  }

  return style
}

/** Non-box visuals (fill, colour, opacity, shadow, text decoration). */
export function topicVisualStyle(node: MindNode, sheet?: Sheet): CSSProperties {
  const s = node.style
  const style: CSSProperties = {}

  // A topic with no explicit fill takes the r-node branch palette (root
  // white, branch colours by depth, deep white) when the sheet is available;
  // without one it keeps the shared class's translucent box. Only an explicit
  // fill overrides either.
  const fill = s.fill ?? (sheet ? resolveNodeFill(node, sheet) : undefined)
  if (fill !== undefined) {
    style.background = fill
  }
  // textColor is inherited from the chart (the box sets color: inherit); only
  // an explicit colour overrides it.
  if (s.textColor !== undefined) {
    style.color = s.textColor
  }
  if (s.opacity !== undefined) {
    style.opacity = s.opacity
  }
  if (s.shadow) {
    style.boxShadow = '0 3px 8px rgba(0, 0, 0, 0.45)'
  }
  if (s.underline || s.strikethrough || s.shape === 'underline') {
    const parts: string[] = []
    if (s.underline || s.shape === 'underline') {
      parts.push('underline')
    }
    if (s.strikethrough) {
      parts.push('line-through')
    }
    style.textDecoration = parts.join(' ')
  }

  return style
}

/**
 * The TOP image slot's box, derived from `imageWidth` × `imageAspect` alone —
 * the S3 C.2b async-input rule. An `<img>` measured before it loads is
 * zero-height, and a topic sized by whatever happens to have loaded is the
 * pan-shift bug arriving once more: so the box comes purely from stored Style
 * numbers and is correct on the FIRST frame, identical before and after the
 * bytes arrive. Both the rendered topic and the hidden measure layer call
 * this, so what layout reads is exactly what paints.
 *
 * `imageWidthOverride` lets the live topic follow a drag on the image resize
 * handle before anything is committed (one setNodeStyle op on pointerup); the
 * measure layer never passes it, so it always sizes from the stored Style.
 *
 * Returns null for a topic with no image; the caller renders no slot.
 */
export function topicImageBoxStyle(node: MindNode, imageWidthOverride?: number): CSSProperties | null {
  const s = node.style
  if (!s.image) {
    return null
  }
  const width = Math.max(1, Math.round(imageWidthOverride ?? s.imageWidth ?? DEFAULT_IMAGE_WIDTH))
  const height = Math.max(1, Math.round(width * (s.imageAspect ?? DEFAULT_IMAGE_ASPECT)))
  return {
    display: 'block',
    width: `${width}px`,
    height: `${height}px`,
    objectFit: 'cover',
  }
}
