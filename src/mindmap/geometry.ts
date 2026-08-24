/**
 * Edge geometry, ported from r-node's src/layout/measure.ts (the one part of
 * that file worth carrying — MINDMAP_NATIVE_AGENT_BRIEF Lane B).
 *
 * Edges are curves between boxes and must stop exactly at the border rather
 * than run under the node. This geometry is already correct; reinventing it
 * produces edges that look *almost* right, which is the worst outcome because
 * nobody files a bug for "almost".
 */

/** A cubic Bézier, in world units. */
export interface Bezier3 {
  p0: { x: number, y: number }
  p1: { x: number, y: number }
  p2: { x: number, y: number }
  p3: { x: number, y: number }
}

/** Axis-aligned box, in world units (top-left origin) — what layout leaves behind. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Point on a cubic Bézier at parameter t (0..1). */
export function bezierPoint(b: Bezier3, t: number): { x: number, y: number } {
  const mt = 1 - t
  const a = mt * mt * mt
  const bb = 3 * mt * mt * t
  const c = 3 * mt * t * t
  const d = t * t * t
  return {
    x: a * b.p0.x + bb * b.p1.x + c * b.p2.x + d * b.p3.x,
    y: a * b.p0.y + bb * b.p1.y + c * b.p2.y + d * b.p3.y,
  }
}

/**
 * The sub-curve of [t0, t1] as its own cubic Bézier (de Casteljau). Used to
 * truncate a curve exactly at the node borders, so the drawn line meets the
 * border instead of running under it toward the centre. The tangents of the
 * slice at its ends are the exact tangents of the original curve at t0 and t1.
 */
export function bezierSlice(b: Bezier3, t0: number, t1: number): Bezier3 {
  const lerp = (a: { x: number, y: number }, c: { x: number, y: number }, t: number) => ({
    x: a.x + (c.x - a.x) * t,
    y: a.y + (c.y - a.y) * t,
  })
  // Subdivide at t0, keep the right part [t0, 1].
  const q1 = lerp(b.p0, b.p1, t0)
  const q2 = lerp(b.p1, b.p2, t0)
  const q3 = lerp(b.p2, b.p3, t0)
  const q4 = lerp(q1, q2, t0)
  const q5 = lerp(q2, q3, t0)
  const right: Bezier3 = { p0: lerp(q4, q5, t0), p1: q5, p2: q3, p3: b.p3 }
  // Subdivide the right part at u = (t1 - t0) / (1 - t0). The left part of
  // that subdivision is the slice: [R0, e1, f1, g] — using the second-level
  // point f2 (r5) as p2 was the classic mistake and bent the slice's end
  // tangent in the wrong direction.
  const u = (t1 - t0) / (1 - t0)
  const r1 = lerp(right.p0, right.p1, u) // e1
  const r2 = lerp(right.p1, right.p2, u) // e2
  const r3 = lerp(right.p2, right.p3, u) // e3
  const r4 = lerp(r1, r2, u) // f1
  const r6 = lerp(r4, lerp(r2, r3, u), u) // g = P(t1)
  return { p0: right.p0, p1: r1, p2: r4, p3: r6 }
}

/**
 * The parameter t where the curve crosses an axis-aligned rectangle. The
 * relationship curve is monotonic in both axes (control points stay within
 * the endpoints' span), so there is exactly one crossing. `enter` finds the
 * FIRST point inside the rect (the curve ends at the target centre, which is
 * inside); `exit` finds the FIRST point outside (the curve starts at the
 * source centre, which is inside). Degenerate overlaps (two boxes that
 * already touch) clamp to 0 / 1.
 */
export function rectCrossing(b: Bezier3, x: number, y: number, w: number, h: number, exit: boolean): number {
  const inside = (t: number): boolean => {
    const p = bezierPoint(b, t)
    return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h
  }
  const lo0 = inside(0)
  const hi1 = inside(1)
  // The search assumes the polarity flips once; if it already did not, the
  // crossing is at the degenerate end.
  if (lo0 === hi1) {
    return exit ? 1 : 0
  }
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    // Same polarity as the start: the boundary is ahead; flipped: behind.
    if (inside(mid) === lo0) {
      lo = mid
    }
    else {
      hi = mid
    }
  }
  return hi
}

/** First t where the curve (starting outside, ending inside) enters the rect. */
export function bezierEnterRect(b: Bezier3, x: number, y: number, w: number, h: number): number {
  return rectCrossing(b, x, y, w, h, false)
}

/**
 * Where the segment from one box's centre to another's crosses the FIRST box's
 * border (straight relationships).
 *
 * Lives here beside the bezier trimmers because the renderer and any SVG
 * export both truncate a link at the node border, and two copies of that
 * arithmetic drift — visibly, at the arrowheads. Returns the point on the
 * border; the caller decides which end it is trimming by passing the boxes in
 * the right order.
 */
export function segmentExitRect(
  from: { x: number, y: number, w: number, h: number },
  to: { x: number, y: number, w: number, h: number },
): { x: number, y: number } {
  const cx = from.x + from.w / 2
  const cy = from.y + from.h / 2
  const dx = to.x + to.w / 2 - cx
  const dy = to.y + to.h / 2 - cy
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy }
  }
  // Scale the direction until it touches the nearer of the two half-extents:
  // the border hit is whichever axis runs out first.
  const halfW = from.w / 2
  const halfH = from.h / 2
  const tx = dx === 0 ? Infinity : halfW / Math.abs(dx)
  const ty = dy === 0 ? Infinity : halfH / Math.abs(dy)
  const t = Math.min(tx, ty)
  return { x: cx + dx * t, y: cy + dy * t }
}

/** First t where the curve (starting inside, ending outside) leaves the rect. */
export function bezierExitRect(b: Bezier3, x: number, y: number, w: number, h: number): number {
  return rectCrossing(b, x, y, w, h, true)
}

/**
 * SVG `d` for the edge between two laid-out nodes — the parent-child branch
 * curve, identical to r-node's renderer (render/renderer.ts), PDF export and
 * SVG export: it starts and ends exactly on the two box borders, not at their
 * centres, so the line never runs under a node.
 *
 * Which side the child sits on decides the anchor points: the curve leaves
 * the parent's left or right edge toward the child's nearer edge, and the
 * control points bow it toward the child at 45% of the horizontal run.
 */
export function edgePath(from: Rect, to: Rect): string {
  const childLeft = to.x + to.w / 2 < from.x + from.w / 2
  const sx = childLeft ? from.x : from.x + from.w
  const sy = from.y + from.h / 2
  const ex = childLeft ? to.x + to.w : to.x
  const ey = to.y + to.h / 2
  const dx = Math.abs(ex - sx)
  const cp1x = sx + (childLeft ? -dx * 0.45 : dx * 0.45)
  const cp2x = ex + (childLeft ? dx * 0.45 : -dx * 0.45)
  return `M ${sx},${sy} C ${cp1x},${sy} ${cp2x},${ey} ${ex},${ey}`
}
