import type { MindNode, Sheet } from '../src/mindmap/types'
import { describe, expect, it } from 'vitest'
import {
  CLIPBOARD_KIND,
  outlineOfPayload,
  outlineToPayload,
  parsePayload,
  payloadFromHtml,
  payloadToHtml,
  remapIds,
  serialiseSubtrees,
  toOutlineText,
  topLevelIds,
} from '../src/mindmap/clipboard'
import { blankSheet } from '../src/mindmap/storage'

/**
 *   root
 *   ├── A  (title runs: "A" in bold)
 *   │   ├── A1
 *   │   └── A2
 *   └── B
 */
function fixture(): { sheet: Sheet, ids: Record<string, string> } {
  const sheet = blankSheet('Map')
  const add = (parentId: string, title: string): string => {
    const id = `n-${title}`
    const node: MindNode = {
      id,
      type: parentId === sheet.rootNodeId ? 'main' : 'subtopic',
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
    sheet.nodes[id] = node
    sheet.nodes[parentId].childrenIds.push(id)
    return id
  }
  const a = add(sheet.rootNodeId, 'A')
  const a1 = add(a, 'A1')
  const a2 = add(a, 'A2')
  const b = add(sheet.rootNodeId, 'B')
  sheet.nodes[a].titleRuns = [{ text: 'A', bold: true }]
  sheet.nodes[a1].style = { fill: '#abcdef' }
  sheet.nodes[a1].notes = 'a note'
  return { sheet, ids: { root: sheet.rootNodeId, a, a1, a2, b } }
}

describe('topLevelIds', () => {
  it('drops ids already covered by another id\'s subtree', () => {
    const { sheet, ids } = fixture()
    expect(topLevelIds(sheet, [ids.a, ids.a1, ids.a2])).toEqual([ids.a])
  })

  it('returns the survivors in document order, whatever order they came in', () => {
    const { sheet, ids } = fixture()
    expect(topLevelIds(sheet, [ids.b, ids.a1])).toEqual([ids.a1, ids.b])
  })

  it('ignores ids the sheet does not hold', () => {
    const { sheet, ids } = fixture()
    expect(topLevelIds(sheet, [ids.b, 'ghost'])).toEqual([ids.b])
  })
})

describe('serialiseSubtrees', () => {
  it('captures the whole subtree, roots first', () => {
    const { sheet, ids } = fixture()
    const payload = serialiseSubtrees(sheet, [ids.a])
    expect(payload.kind).toBe(CLIPBOARD_KIND)
    expect(payload.roots).toEqual([ids.a])
    expect(payload.nodes.map(n => n.title)).toEqual(['A', 'A1', 'A2'])
  })

  // The payload has to describe a tree that stands on its own; a root still
  // pointing at a parent that is not in it is a dangling reference paste has
  // to guess about.
  it('nulls the roots\' parentId and leaves the source sheet alone', () => {
    const { sheet, ids } = fixture()
    const payload = serialiseSubtrees(sheet, [ids.a])
    expect(payload.nodes[0].parentId).toBeNull()
    expect(sheet.nodes[ids.a].parentId).toBe(ids.root)
  })

  it('deep-copies, so editing the payload cannot reach the sheet', () => {
    const { sheet, ids } = fixture()
    const payload = serialiseSubtrees(sheet, [ids.a])
    payload.nodes[0].childrenIds.push('intruder')
    payload.nodes[0].style.fill = '#000000'
    expect(sheet.nodes[ids.a].childrenIds).toEqual([ids.a1, ids.a2])
    expect(sheet.nodes[ids.a].style.fill).toBeUndefined()
  })
})

describe('remapIds', () => {
  it('gives every node a new id and rewires the tree onto them', () => {
    const { sheet, ids } = fixture()
    const original = serialiseSubtrees(sheet, [ids.a])
    const fresh = remapIds(original)

    const oldIds = new Set(original.nodes.map(n => n.id))
    for (const node of fresh.nodes) {
      expect(oldIds.has(node.id)).toBe(false)
    }
    expect(new Set(fresh.nodes.map(n => n.id)).size).toBe(3)

    const [root, first, second] = fresh.nodes
    expect(fresh.roots).toEqual([root.id])
    expect(root.childrenIds).toEqual([first.id, second.id])
    expect(first.parentId).toBe(root.id)
    expect(second.parentId).toBe(root.id)
  })

  it('leaves the payload it was given untouched', () => {
    const { sheet, ids } = fixture()
    const original = serialiseSubtrees(sheet, [ids.a])
    const before = JSON.stringify(original)
    remapIds(original)
    expect(JSON.stringify(original)).toBe(before)
  })

  // Lane A's rich titles ride along inside the node objects; this module does
  // not know what a run is and must not strip one.
  it('carries titleRuns, style and notes through unchanged', () => {
    const { sheet, ids } = fixture()
    const fresh = remapIds(serialiseSubtrees(sheet, [ids.a]))
    expect(fresh.nodes[0].titleRuns).toEqual([{ text: 'A', bold: true }])
    expect(fresh.nodes[1].style.fill).toBe('#abcdef')
    expect(fresh.nodes[1].notes).toBe('a note')
  })

  it('preserves structure and order across a full round trip', () => {
    const { sheet, ids } = fixture()
    const original = serialiseSubtrees(sheet, [ids.a, ids.b])
    const fresh = remapIds(original)
    expect(outlineOfPayload(fresh)).toBe(outlineOfPayload(original))
  })
})

describe('toOutlineText', () => {
  it('indents by depth and keeps document order', () => {
    const { sheet, ids } = fixture()
    expect(toOutlineText(sheet, [ids.a, ids.b])).toBe('A\n  A1\n  A2\nB')
  })

  it('folds a multi-line title onto one line, so the indentation still means depth', () => {
    const { sheet, ids } = fixture()
    sheet.nodes[ids.a1].title = 'first\n    second'
    expect(toOutlineText(sheet, [ids.a])).toBe('A\n  first second\n  A2')
  })
})

describe('outlineToPayload', () => {
  it('reads indentation back as nesting', () => {
    const payload = outlineToPayload('A\n  A1\n  A2\nB')
    expect(payload.roots).toHaveLength(2)
    expect(outlineOfPayload(payload)).toBe('A\n  A1\n  A2\nB')
  })

  it('treats a tab as one level and strips list bullets', () => {
    const payload = outlineToPayload('- Top\n\t- Under\n\t\t* Deeper')
    expect(outlineOfPayload(payload)).toBe('Top\n  Under\n    Deeper')
  })

  it('skips blank lines rather than making empty topics', () => {
    const payload = outlineToPayload('A\n\n  A1\n   \nB')
    expect(payload.nodes).toHaveLength(3)
  })

  it('gives every parsed node a distinct id', () => {
    const payload = outlineToPayload('A\n  A1\n  A2')
    expect(new Set(payload.nodes.map(n => n.id)).size).toBe(3)
  })

  it('returns an empty payload for text with nothing in it', () => {
    expect(outlineToPayload('   \n\n').nodes).toEqual([])
  })
})

describe('parsePayload', () => {
  it('round-trips a serialised payload through JSON', () => {
    const { sheet, ids } = fixture()
    const payload = serialiseSubtrees(sheet, [ids.a])
    const parsed = parsePayload(JSON.stringify(payload))
    expect(parsed).toEqual(payload)
  })

  it('refuses JSON that is not one of ours', () => {
    expect(parsePayload('not json at all')).toBeNull()
    expect(parsePayload('{"kind":"something/else","nodes":[]}')).toBeNull()
    expect(parsePayload('[1,2,3]')).toBeNull()
    expect(parsePayload(JSON.stringify({ kind: CLIPBOARD_KIND, nodes: [], roots: [] }))).toBeNull()
  })

  // Clipboard content is untrusted input: a node with no style or position
  // reaches layoutSheet and takes the whole map down with it.
  it('rebuilds the fields a hand-edited payload left out', () => {
    const parsed = parsePayload(JSON.stringify({
      kind: CLIPBOARD_KIND,
      nodes: [{ id: 'x', title: 'X' }],
      roots: ['x'],
    }))
    expect(parsed.nodes[0].style).toEqual({})
    expect(parsed.nodes[0].position).toEqual({ x: 0, y: 0, manual: false })
    expect(parsed.nodes[0].childrenIds).toEqual([])
    expect(parsed.nodes[0].collapsed).toBe(false)
  })

  it('drops references to nodes the payload does not carry', () => {
    const parsed = parsePayload(JSON.stringify({
      kind: CLIPBOARD_KIND,
      nodes: [{ id: 'x', title: 'X', childrenIds: ['gone'], parentId: 'also-gone' }],
      roots: ['x'],
    }))
    expect(parsed.nodes[0].childrenIds).toEqual([])
    expect(parsed.nodes[0].parentId).toBeNull()
  })

  it('recovers the roots from the tree when the roots list is missing', () => {
    const parsed = parsePayload(JSON.stringify({
      kind: CLIPBOARD_KIND,
      nodes: [{ id: 'x', title: 'X', childrenIds: ['y'] }, { id: 'y', title: 'Y', parentId: 'x' }],
    }))
    expect(parsed.roots).toEqual(['x'])
  })
})

describe('the text/html flavour', () => {
  it('round-trips the structured payload through the markup', () => {
    const { sheet, ids } = fixture()
    const payload = serialiseSubtrees(sheet, [ids.a])
    const html = payloadToHtml(payload, outlineOfPayload(payload))
    expect(payloadFromHtml(html)).toEqual(payload)
  })

  // The JSON is full of quotes and angle brackets; unescaped, the attribute
  // ends at the first one and the payload is unreadable.
  it('survives a title full of markup', () => {
    const { sheet, ids } = fixture()
    sheet.nodes[ids.a].title = '<b>"A" & co</b>'
    const payload = serialiseSubtrees(sheet, [ids.a])
    const html = payloadToHtml(payload, outlineOfPayload(payload))
    expect(payloadFromHtml(html).nodes[0].title).toBe('<b>"A" & co</b>')
  })

  it('ignores HTML from anywhere else', () => {
    expect(payloadFromHtml('<p>hello from a word processor</p>')).toBeNull()
    expect(payloadFromHtml('')).toBeNull()
  })
})
