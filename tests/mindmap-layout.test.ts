import { describe, expect, it } from 'vitest'
import { layoutSheet, LINE_HEIGHT_FACTOR, MAX_TOPIC_W, MIN_TOPIC_W, type NodeSize, TEXT_INSET } from '../src/mindmap/layout'
import { DEFAULT_STRUCTURE, type MindNode, type Sheet } from '../src/mindmap/types'

function makeNode(id: string, parentId: string | null, title: string, type: MindNode['type']): MindNode {
  return {
    id,
    type,
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
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
}

function makeSheet(): Sheet {
  return {
    sheetId: 'sheet-1',
    title: 'Sheet',
    structure: { ...DEFAULT_STRUCTURE },
    rootNodeId: 'root',
    nodes: {
      root: makeNode('root', null, 'Root', 'central'),
    },
    relationships: [],
    boundaries: [],
    summaries: [],
    callouts: [],
    labels: [],
    zones: [],
    attachments: [],
    comments: [],
    presentation: {},
  }
}

// A deterministic stand-in for the browser measuring a topic: width from the
// title's character count (capped like the CSS max-width Lane E applies) and
// height from an estimated line count at the exported line-height factor.
function sizeFor(title: string): NodeSize {
  const w = Math.min(MAX_TOPIC_W, Math.max(MIN_TOPIC_W, title.length * 7 + TEXT_INSET * 2))
  const lines = Math.max(1, Math.ceil(title.length / 12))
  return { w, h: 18 + lines * Math.round(14 * LINE_HEIGHT_FACTOR) }
}

/**
 * Builds a ~3-child-per-node tree with `count` nodes. Titles cycle through
 * varied lengths so no two sibling extents agree.
 */
function buildSheet(count: number): { sheet: Sheet, sizes: Record<string, NodeSize> } {
  const sheet = makeSheet()
  const sizes: Record<string, NodeSize> = {}
  const ids = ['root']
  for (let i = 1; i < count; i++) {
    const id = `n${i}`
    const parentId = ids[Math.floor((i - 1) / 3)]
    const title = `Node ${i} ${'x'.repeat(i % 17)}`
    sheet.nodes[parentId].childrenIds.push(id)
    sheet.nodes[id] = makeNode(id, parentId, title, parentId === 'root' ? 'main' : 'subtopic')
    ids.push(id)
    sizes[id] = sizeFor(title)
  }
  sizes.root = sizeFor('Root')
  return { sheet, sizes }
}

function nodeRects(sheet: Sheet, sizes: Record<string, NodeSize>): Array<{ id: string, x: number, y: number, w: number, h: number }> {
  return Object.entries(sheet.nodes).map(([id, n]) => ({ id, x: n.position.x, y: n.position.y, w: sizes[id].w, h: sizes[id].h }))
}

function expectNoOverlaps(rects: Array<{ id: string, x: number, y: number, w: number, h: number }>): void {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
      expect(overlap, `${a.id} and ${b.id} overlap`).toBe(false)
    }
  }
}

describe('layoutSheet', () => {
  it('lays out a 50-node tree with varied sizes and no two rects intersect', () => {
    const { sheet, sizes } = buildSheet(50)
    layoutSheet(sheet, sizes)
    expectNoOverlaps(nodeRects(sheet, sizes))
  })

  it('keeps manual positions and flows auto siblings around them', () => {
    const { sheet, sizes } = buildSheet(12)
    // Drop one branch onto the right side of the root, far from where layout
    // would have put it. Its children stay auto and must follow the anchor.
    const manual = sheet.nodes.n2
    manual.position = { x: 420, y: -60, manual: true }

    layoutSheet(sheet, sizes)

    expect(manual.position.x).toBe(420)
    expect(manual.position.y).toBe(-60)
    expect(manual.position.manual).toBe(true)
    expectNoOverlaps(nodeRects(sheet, sizes))
  })

  it('distributes root children to both sides of the root', () => {
    const { sheet, sizes } = buildSheet(12)
    layoutSheet(sheet, sizes)
    const root = sheet.nodes.root
    const rootCx = root.position.x + sizes.root.w / 2
    const children = root.childrenIds.map(id => sheet.nodes[id])
    const left = children.filter(n => n.position.x + sizes[n.id].w / 2 < rootCx)
    const right = children.filter(n => n.position.x + sizes[n.id].w / 2 >= rootCx)
    expect(left.length).toBeGreaterThan(0)
    expect(right.length).toBeGreaterThan(0)
  })

  it('force lays out manual nodes too and clears the flag', () => {
    const { sheet, sizes } = buildSheet(12)
    sheet.nodes.n2.position = { x: 420, y: -60, manual: true }
    layoutSheet(sheet, sizes, true)
    const moved = sheet.nodes.n2
    // The explicit auto-layout command took ownership: coordinates changed
    // and the manual flag is gone.
    expect(moved.position.x).not.toBe(420)
    expect(moved.position.manual).toBe(false)
  })
})
