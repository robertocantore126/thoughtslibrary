/**
 * Relationship and boundary geometry — pure world-space maths, no store and no
 * DOM (S4 §B.2/§B.3).
 *
 * It is separated from the two SVG layers for the same reason `cull.ts` is
 * separated from the canvas: the maths is what breaks, and a curve that stops
 * two pixels inside a topic is not something a component test would ever
 * notice. It is also the reason a pan rebuilds nothing — every function here
 * takes world rects and never sees the camera, so the layers can compute their
 * paths outside the camera's dependency graph exactly as `MindmapEdges` does.
 */

import type { NodeSize } from './layout'
import type { ConnectorStyle, MindNode, Relationship } from './types'
import { rectOf } from './cull'
import { type Bezier3, bezierEnterRect, bezierExitRect, bezierSlice, type Rect, segmentExitRect } from './geometry'

export interface Point {
  x: number
  y: number
}

/** How finely a curve is sampled for hit testing and for its bounding box. */
const CURVE_SAMPLES = 32

// ---------------------------------------------------------------------------
// Shared look — the layer components and the map export (exportMap.ts) both
// read these, so the two can never disagree about what a relationship or a
// boundary looks like. A colour or a size hand-written in two places is how
// the map and its picture quietly diverge.
// ---------------------------------------------------------------------------

/**
 * The line a relationship is drawn with when `Relationship.color` is absent —
 * a warm tint of the app's coral accent, close enough to the tree edges' white
 * to sit in the same family but distinct enough that a map reads its free
 * links apart from its hierarchy at a glance (types.ts: absent = the theme
 * decides).
 */
export const DEFAULT_RELATIONSHIP_COLOR = '#ffd6bd'

/**
 * The border a boundary is drawn with when `Group.color` is absent — the
 * muted grey types.ts promises, in the same hairline family as the topic
 * borders.
 */
export const DEFAULT_GROUP_COLOR = 'rgba(255, 255, 255, 0.6)'

/** Arrowhead size, in world units. */
export const RELATION_ARROW_LEN = 10
/** Arrowhead half-width, in world units. */
export const RELATION_ARROW_HALF = 5

/** Gap between a boundary and its members' boxes (world units). */
export const GROUP_PAD = 12
/** Corner radius of a boundary (world units). */
export const GROUP_RADIUS = 10
/** The boundary's dash pattern (world units). */
export const GROUP_DASH = '10 6'

/** Font size of relationship and boundary labels (world units). */
export const LABEL_FONT_SIZE = 12
/** Background of a label's backing rect, so the text reads over any line. */
export const LABEL_BG = 'rgba(0, 0, 0, 0.72)'

/**
 * The dash pattern a relationship's `lineStyle` maps to, or null for solid.
 * Lives here because the layer and the export both draw the same line.
 */
export function relationshipDash(lineStyle: Relationship['lineStyle'] | undefined): string | null {
  if (lineStyle === 'dashed') {
    return '8 6'
  }
  if (lineStyle === 'dotted') {
    return '2 6'
  }
  return null
}

/**
 * A label's background rect is sized from a rough character width — exact
 * text measurement would need the DOM, and a label a few pixels wider or
 * narrower than its text is invisible to everyone.
 */
export function labelWidth(text: string): number {
  return text.length * 6.5 + 14
}

/**
 * The arrowhead at one end of a relationship line: a triangle whose tip sits
 * exactly on the path endpoint (the topic border) and whose base is
 * perpendicular to the path's local direction, so it stays glued to the line
 * at any connector style. Shared by the relationship layer and the export.
 */
export function arrowheadPath(tip: Point, before: Point, length = RELATION_ARROW_LEN, halfWidth = RELATION_ARROW_HALF): string {
  let dx = tip.x - before.x
  let dy = tip.y - before.y
  const len = Math.hypot(dx, dy)
  if (len === 0) {
    return ''
  }
  dx /= len
  dy /= len
  const baseX = tip.x - dx * length
  const baseY = tip.y - dy * length
  const px = -dy * halfWidth
  const py = dx * halfWidth
  return `M ${tip.x},${tip.y} L ${baseX + px},${baseY + py} L ${baseX - px},${baseY - py} Z`
}

function centreOf(r: Rect): Point {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
}

/** Two decimals is under a tenth of a device pixel at max zoom and keeps `d` short. */
function round(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * The centre-to-centre curve a 'curved' relationship follows before it is
 * trimmed at the two borders.
 *
 * Both control handles are pulled along the DOMINANT axis and stay strictly
 * inside the endpoints' span. That is not a style choice: `rectCrossing` in
 * geometry.ts binary-searches for a SINGLE border crossing and says so in its
 * comment, and a handle outside the span bows the curve back over a border it
 * has already crossed. The search then converges on the wrong one and the line
 * is drawn from inside the topic — which looks like a rendering bug and is
 * really a broken precondition.
 */
function relationshipCurve(from: Rect, to: Rect): Bezier3 {
  const a = centreOf(from)
  const b = centreOf(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { p0: a, p1: { x: a.x + dx * 0.5, y: a.y }, p2: { x: b.x - dx * 0.5, y: b.y }, p3: b }
  }
  return { p0: a, p1: { x: a.x, y: a.y + dy * 0.5 }, p2: { x: b.x, y: b.y - dy * 0.5 }, p3: b }
}

/**
 * The curve cut back to the two box borders, so the line meets the topic
 * instead of running under it toward its centre — the rule geometry.ts exists
 * to enforce for tree edges, applied to relationships.
 */
function trimmedCurve(from: Rect, to: Rect): Bezier3 {
  const full = relationshipCurve(from, to)
  const t0 = bezierExitRect(full, from.x, from.y, from.w, from.h)
  const t1 = bezierEnterRect(full, to.x, to.y, to.w, to.h)
  // Overlapping or touching boxes leave nothing between the two borders, and
  // bezierSlice divides by (1 - t0): an inverted or degenerate range would hand
  // the renderer NaN control points and the path would silently vanish.
  if (t0 >= 1 || t1 <= t0) {
    return full
  }
  return bezierSlice(full, t0, t1)
}

/**
 * The corners of an 'elbow' relationship: out of one border along the dominant
 * axis, across at the halfway line, into the other border.
 */
function elbowPoints(from: Rect, to: Rect): Point[] {
  const a = centreOf(from)
  const b = centreOf(to)
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    const sx = dx >= 0 ? from.x + from.w : from.x
    const ex = dx >= 0 ? to.x : to.x + to.w
    const mx = (sx + ex) / 2
    return [{ x: sx, y: a.y }, { x: mx, y: a.y }, { x: mx, y: b.y }, { x: ex, y: b.y }]
  }
  const sy = dy >= 0 ? from.y + from.h : from.y
  const ey = dy >= 0 ? to.y : to.y + to.h
  const my = (sy + ey) / 2
  return [{ x: a.x, y: sy }, { x: a.x, y: my }, { x: b.x, y: my }, { x: b.x, y: ey }]
}

/**
 * The drawn line as a polyline, in world units. One function answers hit
 * testing, the label anchor and the SVG bounding box, so those three can never
 * disagree with each other about where the line actually is — the failure mode
 * being a relationship you can see but not click.
 */
export function relationshipPoints(from: Rect, to: Rect, connector?: ConnectorStyle): Point[] {
  if (connector === 'straight') {
    return [segmentExitRect(from, to), segmentExitRect(to, from)]
  }
  if (connector === 'elbow') {
    return elbowPoints(from, to)
  }
  const b = trimmedCurve(from, to)
  const out: Point[] = []
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const t = i / CURVE_SAMPLES
    const mt = 1 - t
    const c0 = mt * mt * mt
    const c1 = 3 * mt * mt * t
    const c2 = 3 * mt * t * t
    const c3 = t * t * t
    out.push({
      x: c0 * b.p0.x + c1 * b.p1.x + c2 * b.p2.x + c3 * b.p3.x,
      y: c0 * b.p0.y + c1 * b.p1.y + c2 * b.p2.y + c3 * b.p3.y,
    })
  }
  return out
}

/**
 * SVG `d` for a relationship. `connector` absent means 'curved', so every
 * document written before the field keeps the look it has (types.ts).
 */
export function relationshipPath(from: Rect, to: Rect, connector?: ConnectorStyle): string {
  if (connector === 'straight' || connector === 'elbow') {
    const pts = relationshipPoints(from, to, connector)
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)},${round(p.y)}`).join(' ')
  }
  // The curve is emitted as a real cubic rather than as the sampled polyline:
  // the samples exist for hit testing, and drawing them would put 32 line
  // joins on every relationship at every zoom level.
  const b = trimmedCurve(from, to)
  return `M ${round(b.p0.x)},${round(b.p0.y)} C ${round(b.p1.x)},${round(b.p1.y)} ${round(b.p2.x)},${round(b.p2.y)} ${round(b.p3.x)},${round(b.p3.y)}`
}

/** Squared distance from a point to a segment — squared, so the loop below has no sqrt in it. */
function distanceToSegmentSq(px: number, py: number, a: Point, b: Point): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const lenSq = vx * vx + vy * vy
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / lenSq))
  const dx = px - (a.x + vx * t)
  const dy = py - (a.y + vy * t)
  return dx * dx + dy * dy
}

/**
 * Whether a world point is within `tolerance` world units of the drawn line.
 *
 * The tolerance is in WORLD units and the caller divides its screen-pixel grab
 * radius by the camera scale, so a relationship is equally easy to hit at any
 * zoom. Passing screen pixels straight in makes a zoomed-out map almost
 * unclickable and a zoomed-in one select a line the pointer is nowhere near.
 */
export function relationshipHit(
  from: Rect,
  to: Rect,
  connector: ConnectorStyle | undefined,
  x: number,
  y: number,
  tolerance: number,
): boolean {
  const pts = relationshipPoints(from, to, connector)
  const limit = tolerance * tolerance
  for (let i = 1; i < pts.length; i++) {
    if (distanceToSegmentSq(x, y, pts[i - 1], pts[i]) <= limit) {
      return true
    }
  }
  return false
}

/** Where a relationship's label sits: the middle of the drawn line. */
export function relationshipMidpoint(from: Rect, to: Rect, connector?: ConnectorStyle): Point {
  const pts = relationshipPoints(from, to, connector)
  if (pts.length === 2) {
    return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 }
  }
  // An even sample count leaves a true middle vertex for the curve, and the
  // elbow's two inner corners average to the centre of its crossing run.
  const mid = pts.length % 2 === 1 ? pts[(pts.length - 1) / 2] : null
  if (mid) {
    return { x: mid.x, y: mid.y }
  }
  const a = pts[pts.length / 2 - 1]
  const b = pts[pts.length / 2]
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

/**
 * The world rect the members of a boundary occupy, grown by `pad` — or null
 * when nothing resolved.
 *
 * Null rather than a zero rect: a group whose members have all been deleted
 * must draw NOTHING, and a zero rect at the origin would paint a dot in the
 * corner of every map that ever lost a grouped topic.
 */
export function groupBounds(memberRects: Rect[], pad: number): Rect | null {
  if (memberRects.length === 0) {
    return null
  }
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const r of memberRects) {
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 }
}

/**
 * The rects of the members a boundary can still resolve.
 *
 * Members that no longer exist are SKIPPED HERE, and `Group.memberIds` is
 * never touched (§B.3). Deleting a topic leaves its id in the group on
 * purpose: `restoreNode` puts the topic back on undo and the boundary
 * re-encloses it for free. A tidy-up pass that pruned memberIds on delete
 * would make Ctrl+Z silently lose group membership — the data would be
 * consistent and the user's map would be wrong.
 */
export function memberRectsOf(
  nodes: Record<string, MindNode>,
  memberIds: string[],
  sizes: Record<string, NodeSize>,
): Rect[] {
  const out: Rect[] = []
  for (const id of memberIds) {
    const node = nodes[id]
    if (!node) {
      continue
    }
    out.push(rectOf(node, sizes))
  }
  return out
}
