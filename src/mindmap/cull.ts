import type { Rect } from './geometry'
import type { NodeSize } from './layout'
import type { MindNode } from './types'

/**
 * Viewport culling — pure geometry over a sheet, separated from the rendering
 * path so it can be tested without a DOM (MINDMAP_S2_AGENT_BRIEF M1.1).
 *
 * Culling keeps a 3,000-topic map mounting only what is near the camera. The
 * first attempt reached for this and got the two seams wrong (S2 M1): layout
 * ran on a guessed size for unmeasured nodes, so panning repacked a map you
 * had already looked at, and edges vanished unless BOTH endpoints were on
 * screen. The edges rule here fixes the second of those — see `edgeVisible`.
 */

/** The visible world rect, in the same units as node positions. */
export interface Viewport {
  x: number
  y: number
  w: number
  h: number
}

/** A node's world rect from its laid-out position and measured size. */
export function rectOf(node: MindNode, sizes: Record<string, NodeSize>): Rect {
  const size = sizes[node.id]
  return {
    x: node.position.x,
    y: node.position.y,
    w: size?.w ?? 0,
    h: size?.h ?? 0,
  }
}

/**
 * How far past the union of two boxes a parent-child curve may bulge and
 * still reach. The geometry layer (edgePath) sets each control handle at 45%
 * of the horizontal run, so a curve can bow beyond its endpoints' boxes by
 * roughly that share of the gap between them. Padding the union by this
 * constant keeps such a bulging curve from being culled at the exact moment
 * its endpoints leave the viewport. Chosen at one level's worth of spacing
 * (0.45 * DEFAULT_STRUCTURE.spacing), comfortably over the reach of a typical
 * edge.
 */
export const EDGE_BULGE = 0.45 * 180

/**
 * Nodes whose rect intersects `viewport` grown by `margin` (world units).
 * `nodes` is the full sheet in document order (the store's visibleNodes); the
 * caller already excluded collapsed-hidden nodes. Returns them in order.
 */
export function cullNodes(
  nodes: MindNode[],
  sizes: Record<string, NodeSize>,
  viewport: Viewport,
  margin: number,
): MindNode[] {
  const x0 = viewport.x - margin
  const y0 = viewport.y - margin
  const x1 = viewport.x + viewport.w + margin
  const y1 = viewport.y + viewport.h + margin
  const out: MindNode[] = []
  for (const node of nodes) {
    const r = rectOf(node, sizes)
    // A node with no measured size collapses to a point at its laid-out
    // position and is kept if that point is within the padded viewport — the
    // measure layer sizes every topic before layout, so this only matters in
    // a degenerate or test frame, and silently dropping it would hide a node
    // the moment its size was momentarily unknown.
    if (r.x + r.w < x0 || r.x > x1 || r.y + r.h < y0 || r.y > y1) {
      continue
    }
    out.push(node)
  }
  return out
}

/**
 * Overlap of two axis-aligned rects.
 */
function intersects(a: { x: number, y: number, w: number, h: number }, b: { x: number, y: number, w: number, h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

/**
 * Whether the edge between two nodes can be seen. TRUE when the union of the
 * two rects, padded by both `EDGE_BULGE` (the curve's bend) and `margin`,
 * intersects the viewport — NOT when both endpoints are visible. A long edge
 * from an off-screen parent crosses the screen and must be drawn; culling by
 * "both endpoints on screen" leaves children floating with no connector, which
 * is the S2 M1 regression this exists to prevent.
 */
export function edgeVisible(
  parent: Rect,
  child: Rect,
  viewport: Viewport,
  margin: number,
): boolean {
  const minX = Math.min(parent.x, child.x) - EDGE_BULGE - margin
  const minY = Math.min(parent.y, child.y) - EDGE_BULGE - margin
  const maxX = Math.max(parent.x + parent.w, child.x + child.w) + EDGE_BULGE + margin
  const maxY = Math.max(parent.y + parent.h, child.y + child.h) + EDGE_BULGE + margin
  return intersects(
    { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
    viewport,
  )
}

/**
 * Everything that can change a topic's box, folded into one string. The S2
 * measure layer keys cached sizes on this so a rename — or, later, any
 * box-affecting Style change (M2) — re-measures a topic automatically instead
 * of leaving it at a stale size until something else happens to invalidate it.
 */
export function sizeKey(node: MindNode): string {
  const s = node.style
  return JSON.stringify({
    title: node.title,
    // Box-affecting Style fields (S2 M2). Miss one and that topic keeps a stale
    // size until some unrelated edit repaints it — the exact bug class the
    // measure layer exists to close. shape matters because the no-box shapes
    // (underline, none) lose the border/padding and so measure differently;
    // fontFamily overrides chart.font and re-wraps the text.
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    italic: s.italic,
    borderWidth: s.borderWidth,
    borderStyle: s.borderStyle,
    cornerRadius: s.cornerRadius,
    padding: s.padding,
    shape: s.shape,
    fontFamily: s.fontFamily,
  })
}
