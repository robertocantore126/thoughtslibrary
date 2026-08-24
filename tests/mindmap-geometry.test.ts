import { describe, expect, it } from 'vitest'
import { type Bezier3, bezierEnterRect, bezierExitRect, bezierPoint, bezierSlice, edgePath, type Rect, segmentExitRect } from '../src/mindmap/geometry'

describe('bezierPoint', () => {
  it('returns the curve endpoints at t = 0 and t = 1', () => {
    const b: Bezier3 = { p0: { x: 0, y: 0 }, p1: { x: 30, y: 40 }, p2: { x: 70, y: -20 }, p3: { x: 100, y: 0 } }
    expect(bezierPoint(b, 0)).toEqual({ x: 0, y: 0 })
    expect(bezierPoint(b, 1)).toEqual({ x: 100, y: 0 })
  })

  it('sits on the straight-line hull of a flat curve', () => {
    const b: Bezier3 = { p0: { x: 0, y: 50 }, p1: { x: 40, y: 50 }, p2: { x: 60, y: 50 }, p3: { x: 100, y: 50 } }
    const p = bezierPoint(b, 0.5)
    expect(p.x).toBeCloseTo(50, 10)
    expect(p.y).toBeCloseTo(50, 10)
  })
})

describe('bezierEnterRect / bezierExitRect', () => {
  const rect = { x: 60, y: 30, w: 40, h: 40 }

  it('enter returns a t whose point is on the rect edge, not inside', () => {
    // Curve starts outside the rect (left) and ends inside it (at the centre).
    const b: Bezier3 = { p0: { x: 0, y: 50 }, p1: { x: 40, y: 50 }, p2: { x: 60, y: 50 }, p3: { x: 80, y: 50 } }
    const t = bezierEnterRect(b, rect.x, rect.y, rect.w, rect.h)
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(1)

    const p = bezierPoint(b, t)
    // On the border: exactly the left edge of the rect.
    expect(Math.abs(p.x - rect.x)).toBeLessThan(1e-6)
    expect(p.y).toBeGreaterThanOrEqual(rect.y)
    expect(p.y).toBeLessThanOrEqual(rect.y + rect.h)

    // One step before it is still outside, one step after is inside.
    expect(bezierPoint(b, t - 1e-5).x).toBeLessThan(rect.x)
    expect(bezierPoint(b, t + 1e-5).x).toBeGreaterThanOrEqual(rect.x)
  })

  it('exit returns a t whose point is on the rect edge, not inside', () => {
    // Curve starts inside the rect and ends outside it (to the right).
    const b: Bezier3 = { p0: { x: 70, y: 50 }, p1: { x: 110, y: 50 }, p2: { x: 150, y: 50 }, p3: { x: 200, y: 50 } }
    const t = bezierExitRect(b, rect.x, rect.y, rect.w, rect.h)
    expect(t).toBeGreaterThan(0)
    expect(t).toBeLessThan(1)

    const p = bezierPoint(b, t)
    expect(Math.abs(p.x - (rect.x + rect.w))).toBeLessThan(1e-6)
    expect(bezierPoint(b, t - 1e-5).x).toBeLessThanOrEqual(rect.x + rect.w)
    expect(bezierPoint(b, t + 1e-5).x).toBeGreaterThan(rect.x + rect.w)
  })
})

describe('bezierSlice', () => {
  const b: Bezier3 = { p0: { x: 0, y: 0 }, p1: { x: 30, y: 40 }, p2: { x: 70, y: -20 }, p3: { x: 100, y: 0 } }

  it('is the identity over [0, 1]', () => {
    expect(bezierSlice(b, 0, 1)).toEqual(b)
  })

  it('keeps the slice endpoints on the original curve', () => {
    const slice = bezierSlice(b, 0.2, 0.8)
    const start = bezierPoint(b, 0.2)
    const end = bezierPoint(b, 0.8)
    expect(slice.p0.x).toBeCloseTo(start.x, 10)
    expect(slice.p0.y).toBeCloseTo(start.y, 10)
    expect(slice.p3.x).toBeCloseTo(end.x, 10)
    expect(slice.p3.y).toBeCloseTo(end.y, 10)
  })
})

describe('segmentExitRect', () => {
  it('exits through the nearer border along the direction of travel', () => {
    const from = { x: 0, y: 0, w: 100, h: 40 }
    // Straight right: the exit is the right edge, at mid height.
    const right = segmentExitRect(from, { x: 300, y: 0, w: 100, h: 40 })
    expect(right.x).toBeCloseTo(100)
    expect(right.y).toBeCloseTo(20)
    // Down-right: the vertical half-extent runs out first, so the exit is the
    // bottom edge.
    const down = segmentExitRect(from, { x: 200, y: 200, w: 100, h: 40 })
    expect(down.x).toBeCloseTo(70)
    expect(down.y).toBeCloseTo(40)
  })
})

describe('edgePath', () => {
  const from: Rect = { x: 0, y: 0, w: 100, h: 40 }

  it('returns a parseable SVG path from border to border when the child is right', () => {
    const to: Rect = { x: 300, y: 40, w: 80, h: 30 }
    const d = edgePath(from, to)
    const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
    expect(nums).toHaveLength(8)
    // Start on the parent's right edge, mid-height; end on the child's left
    // edge, mid-height.
    expect(nums[0]).toBeCloseTo(from.x + from.w)
    expect(nums[1]).toBeCloseTo(from.y + from.h / 2)
    expect(nums[6]).toBeCloseTo(to.x)
    expect(nums[7]).toBeCloseTo(to.y + to.h / 2)
    // Control points bow toward the child, sharing the anchors' y on the
    // start side and the child's mid-height on the end side.
    expect(nums[2]).toBeGreaterThan(nums[0])
    expect(nums[3]).toBeCloseTo(nums[1])
    expect(nums[4]).toBeLessThan(nums[6])
    expect(nums[5]).toBeCloseTo(nums[7])
  })

  it('returns a parseable SVG path from border to border when the child is left', () => {
    const to: Rect = { x: -300, y: 40, w: 80, h: 30 }
    const d = edgePath(from, to)
    const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number)
    expect(nums).toHaveLength(8)
    expect(nums[0]).toBeCloseTo(from.x)
    expect(nums[1]).toBeCloseTo(from.y + from.h / 2)
    expect(nums[6]).toBeCloseTo(to.x + to.w)
    expect(nums[7]).toBeCloseTo(to.y + to.h / 2)
    expect(nums[2]).toBeLessThan(nums[0])
    expect(nums[4]).toBeGreaterThan(nums[6])
  })
})
