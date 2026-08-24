import type { MindNode, Style } from '../src/mindmap/types'
import { describe, expect, it } from 'vitest'
import { cullNodes, edgeVisible, rectOf, sizeKey, type Viewport } from '../src/mindmap/cull'

const VIEW: Viewport = { x: 0, y: 0, w: 400, h: 300 }

// Sizes come from the measure layer, keyed by node id, and are the SECOND half
// of a node's rect (position lives on the node). A cull test that forgets them
// collapses every box to a zero-area point at its position, which is a
// different (and degenerate) question from whether the full box straddles — so
// the factory records each node's dimensions and sizesOf hands them back.
const DIMS: Record<string, { w: number, h: number }> = {}
function node(id: string, x: number, y: number, w: number, h: number, title = 'topic', style: Style = {}): MindNode {
  DIMS[id] = { w, h }
  return {
    id,
    type: 'subtopic',
    parentId: id === 'root' ? null : 'root',
    childrenIds: [],
    title,
    titleRuns: [{ text: title }],
    position: { x, y, manual: false },
    style,
    collapsed: false,
    labels: [],
    markers: [],
    notes: '',
    task: null,
    metadata: { createdAt: 'a', updatedAt: 'a' },
  }
}

function sizesOf(...ns: MindNode[]): Record<string, { w: number, h: number }> {
  const out: Record<string, { w: number, h: number }> = {}
  for (const n of ns) {
    out[n.id] = DIMS[n.id] ?? { w: 0, h: 0 }
  }
  return out
}

// The regression test for the S2 M1 known bug comes first: an edge must be
// drawn when ONE end is off-screen, because a curve from an off-screen parent
// still crosses the screen. Culling by "both endpoints visible" leaves the
// on-screen child floating with no connector.
describe('cull — edgeVisible (regression: the first attempt culled edges by both-endpoint visibility)', () => {
  it('is true when only the parent is off-screen', () => {
    // Parent far to the left of the viewport, child on screen.
    const parent = { x: -600, y: 10, w: 100, h: 30 }
    const child = { x: 10, y: 10, w: 100, h: 30 }
    expect(edgeVisible(parent, child, VIEW, 0)).toBe(true)
  })

  it('is true when only the child is off-screen', () => {
    // Parent on screen, child far below it.
    const parent = { x: 10, y: 10, w: 100, h: 30 }
    const child = { x: 10, y: 400, w: 100, h: 30 }
    expect(edgeVisible(parent, child, VIEW, 0)).toBe(true)
  })
})

describe('cull — node visibility (cullNodes)', () => {
  it('keeps a node fully inside the viewport and drops one far outside', () => {
    const inside = node('in', 10, 10, 100, 30)
    const outside = node('out', 10_000, 10_000, 100, 30)
    const result = cullNodes([inside, outside], sizesOf(inside, outside), VIEW, 0)
    expect(result.map(n => n.id)).toEqual(['in'])
  })

  it('keeps a node straddling each of the four edges', () => {
    const nodesL = [
      node('top', 10, -20, 100, 100), // pokes the top
      node('bottom', 10, 280, 100, 100), // pokes the bottom
      node('left', -20, 10, 100, 100), // pokes the left
      node('right', 380, 10, 100, 100), // pokes the right
    ]
    const result = cullNodes(nodesL, sizesOf(...nodesL), VIEW, 0)
    expect(result.map(n => n.id).sort()).toEqual(['bottom', 'left', 'right', 'top'])
  })

  it('margin widens the kept set — a node just outside is kept with a cushion and dropped without one', () => {
    // Rect spans [-25,-5] in both axes: its far corner sits 5px outside the
    // viewport's top-left, so margin 0 drops it and margin 20 draws it in.
    const r = node('corner', -25, -25, 20, 20)
    expect(cullNodes([r], sizesOf(r), VIEW, 0).map(n => n.id)).toEqual([])
    expect(cullNodes([r], sizesOf(r), VIEW, 20).map(n => n.id)).toEqual(['corner'])
  })
})

describe('cull — edgeVisible both ends off-screen', () => {
  it('is false when both rects are far off-screen on the same side', () => {
    const a = { x: -800, y: -800, w: 100, h: 30 }
    const b = { x: -600, y: -700, w: 100, h: 30 }
    expect(edgeVisible(a, b, VIEW, 0)).toBe(false)
  })

  it('stays true close to the edge because the union enters the viewport', () => {
    const a = { x: -100, y: 10, w: 100, h: 30 }
    const b = { x: 50, y: 60, w: 100, h: 30 }
    expect(edgeVisible(a, b, VIEW, 0)).toBe(true)
  })
})

describe('sizeKey — box-affecting invalidation', () => {
  it('changes when the title changes', () => {
    const a = node('n', 0, 0, 50, 20, 'Alpha')
    const b = node('n', 0, 0, 50, 20, 'Beta')
    expect(sizeKey(a)).not.toBe(sizeKey(b))
  })

  it('changes when a box-affecting Style field changes', () => {
    const a = node('n', 0, 0, 50, 20, 'Same', { fontSize: 14 })
    const b = node('n', 0, 0, 50, 20, 'Same', { fontSize: 18 })
    expect(sizeKey(a)).not.toBe(sizeKey(b))
  })

  it('is stable when only a non-box-affecting field changes', () => {
    const a = node('n', 0, 0, 50, 20, 'Same', { opacity: 1 })
    const b = node('n', 0, 0, 50, 20, 'Same', { opacity: 0.5 })
    expect(sizeKey(a)).toBe(sizeKey(b))
  })

  it('rectOf reads the node position and the measured size record', () => {
    const n = node('n', 30, 40, 50, 20)
    const r = rectOf(n, { n: { w: 140, h: 90 } })
    expect(r).toEqual({ x: 30, y: 40, w: 140, h: 90 })
  })
})
