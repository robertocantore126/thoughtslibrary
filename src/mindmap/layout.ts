/**
 * Layout engine (pure, framework-free), ported from r-node's
 * src/layout/mindmap.ts.
 *
 * Observable layout behavior:
 *   1. every topic has an extent (text + padding + shape) — measured ONCE by
 *      the caller and handed in as `sizes`, never read from the DOM;
 *   2. a topic + its descendants form a block;
 *   3. children STRADDLE the parent box: the block is split so some children
 *      sit above and some below the parent, always with a guaranteed gap —
 *      no child can ever overlap its parent, and growing a topic's own title
 *      pushes its neighbors apart;
 *   4. any deep change grows the block, which redistributes siblings and
 *      propagates up to the root — a full recompute on change.
 *
 * Layout is DERIVED data (MINDMAP_NATIVE_AGENT_BRIEF §T.2): it never enters an
 * op and never enters history. Undo restores the tree; layout re-runs from it.
 *
 * `position.manual` is a promise (§T.3): a user who dragged a topic has said
 * where it goes, and a layout pass preserves those coordinates and flows
 * around them. Only an explicit auto-layout command (force = true) lays out
 * manual nodes too, and only that command may clear the flag.
 */
import type { MindNode, Sheet } from './types'

export interface NodeSize {
  w: number
  h: number
}

// Sizing constants applied as CSS by Lane E (MIN/MAX topic width, box inset,
// line height). Ported from r-node's measure.ts.
export const MIN_TOPIC_W = 84
export const MAX_TOPIC_W = 280
export const TEXT_INSET = 6
export const LINE_HEIGHT_FACTOR = 1.25

// A node with no measured size is a caller bug, but layout is derived data
// that runs on every change and must never throw: fall back to a minimal
// single-line topic rather than take the whole map down.
const DEFAULT_SIZE: NodeSize = { w: MIN_TOPIC_W, h: 40 }

/**
 * Writes `position` on every non-manual node (all nodes when `force`).
 * `sizes` must hold an entry per node — the caller measures the DOM once, in
 * batch, and this function never touches it (Lane E's measurement order).
 */
export function layoutSheet(sheet: Sheet, sizes: Record<string, NodeSize>, force = false): void {
  const positions = new Map<string, { x: number, y: number }>()
  const st = sheet.structure
  const root = sheet.nodes[sheet.rootNodeId]
  if (!root) {
    return
  }

  const size = (n: MindNode): NodeSize => sizes[n.id] ?? DEFAULT_SIZE
  const gap = Math.max(6, st.branchSpacing)

  const isAuto = (id: string): boolean => {
    const n = sheet.nodes[id]
    return !!n && (force || !n.position.manual)
  }

  const cacheH = new Map<string, number>()
  const cacheW = new Map<string, number>()

  /**
   * Vertical placement of `kids` around a parent box of height `parentH`.
   * Children are split into an above group and a below group (balanced by
   * total height) separated from the parent by `gap`. Returns each child's
   * center Y relative to the parent center, plus the total block height.
   */
  const stacked = (kids: MindNode[], parentH: number): { centers: Map<string, number>, blockH: number } => {
    const k = kids.length
    // stacked and subtreeHeight are mutually recursive — block heights are
    // built from subtree heights and vice versa — so one must reference the
    // other before its const initializer runs. The order only matters at call
    // time, and every call happens after both are defined.
    // eslint-disable-next-line ts/no-use-before-define
    const blocks = kids.map(kid => subtreeHeight(kid.id))
    const groupTotal = (from: number, to: number): number => {
      if (from >= to) {
        return 0
      }
      let t = 0
      for (let i = from; i < to; i++) {
        t += blocks[i]
      }
      return t + st.branchSpacing * (to - from - 1)
    }
    // Choose the above-count that balances the two groups (first minimal diff
    // → children lean below the parent, Xmind-style).
    let best = 0
    let bestDiff = Infinity
    for (let ac = 0; ac <= k; ac++) {
      const diff = Math.abs(groupTotal(0, ac) - groupTotal(ac, k))
      if (diff < bestDiff) {
        bestDiff = diff
        best = ac
      }
    }
    const aboveTotal = groupTotal(0, best)
    const belowTotal = groupTotal(best, k)
    const blockH = aboveTotal + gap + parentH + gap + belowTotal

    const centers = new Map<string, number>()
    let y = -parentH / 2 - gap - aboveTotal // top of the above group
    for (let i = 0; i < best; i++) {
      centers.set(kids[i].id, y + blocks[i] / 2)
      y += blocks[i] + st.branchSpacing
    }
    y = parentH / 2 + gap // top of the below group
    for (let i = best; i < k; i++) {
      centers.set(kids[i].id, y + blocks[i] / 2)
      y += blocks[i] + st.branchSpacing
    }
    return { centers, blockH }
  }

  const subtreeHeight = (id: string): number => {
    const cached = cacheH.get(id)
    if (cached !== undefined) {
      return cached
    }
    const n = sheet.nodes[id]
    if (!n) {
      return 0
    }
    const h = size(n).h
    if (n.collapsed || n.childrenIds.length === 0) {
      cacheH.set(id, h)
      return h
    }
    const kids = n.childrenIds.map(c => sheet.nodes[c]).filter((c): c is MindNode => !!c)
    // In a mind map, descendants of a non-central topic run in a vertical
    // column beside that topic. The topic is therefore centered against the
    // child column, not surrounded by the root-style straddle gaps. Using
    // `stacked()` here overestimates every branch and makes the placement
    // code's actual geometry disagree with the block height used for balance.
    const childColumnH = kids.reduce((acc, kid) => acc + subtreeHeight(kid.id), 0) + st.branchSpacing * Math.max(0, kids.length - 1)
    const blockH = st.structureType === 'mindmap' ? Math.max(h, childColumnH) : stacked(kids, h).blockH
    cacheH.set(id, blockH)
    return blockH
  }

  const subtreeWidth = (id: string): number => {
    const cached = cacheW.get(id)
    if (cached !== undefined) {
      return cached
    }
    const n = sheet.nodes[id]
    if (!n) {
      return 0
    }
    const w = size(n).w
    if (n.collapsed || n.childrenIds.length === 0) {
      cacheW.set(id, w)
      return w
    }
    const kids = n.childrenIds.map(c => sheet.nodes[c]).filter((c): c is MindNode => !!c)
    const childWidths = kids.map(kid => subtreeWidth(kid.id))
    const blockW = Math.max(w, childWidths.reduce((acc, v) => acc + v, 0) + st.branchSpacing * Math.max(0, kids.length - 1))
    cacheW.set(id, blockW)
    return blockW
  }

  if (st.structureType === 'mindmap') {
    placeMindmap(root.id, 0, 0, 0)
    resolveIntersections(root.id)
  }
  else {
    placeHierarchical(root.id, 0, 0, st.orientation === 'horizontal' ? 'right' : 'down')
  }

  for (const [id, p] of positions) {
    const n = sheet.nodes[id]
    if (!n || (!force && n.position.manual)) {
      continue
    }
    // The sheet handed to layoutSheet may share node objects with a
    // previously published sheet (draftOf's copy-on-write in store.ts), so a
    // laid-out node is REPLACED, never mutated in place — the same
    // replace-before-mutate discipline applyOp follows. A shallow spread is
    // all that is needed: layout only writes `position`.
    sheet.nodes[id] = {
      ...n,
      position: {
        x: p.x,
        y: p.y,
        // force is the explicit auto-layout command: it takes ownership of the
        // topic, so the flag it overrode is cleared with it.
        manual: force ? false : n.position.manual,
        ...(n.position.offsetX !== undefined ? { offsetX: n.position.offsetX } : {}),
        ...(n.position.offsetY !== undefined ? { offsetY: n.position.offsetY } : {}),
      },
    }
  }

  // -- recursive placers ---------------------------------------------------

  function placeMindmap(id: string, cx: number, cy: number, side: -1 | 0 | 1): void {
    const n = sheet.nodes[id]
    if (!n) {
      return
    }
    const { w, h } = size(n)
    positions.set(id, isAuto(id) ? { x: cx - w / 2, y: cy - h / 2 } : { x: n.position.x, y: n.position.y })

    if (n.collapsed || n.childrenIds.length === 0) {
      return
    }
    const kids = n.childrenIds.map(c => sheet.nodes[c]).filter((c): c is MindNode => !!c)

    if (side === 0) {
      const manualKids = kids.filter(k => !isAuto(k.id))
      const autoKids = kids.filter(k => isAuto(k.id))

      const childSide = (kid: MindNode): -1 | 1 => {
        const existing = positions.get(kid.id)
        const p = existing ?? { x: kid.position.x, y: kid.position.y }
        return p.x + size(kid).w / 2 >= cx ? 1 : -1
      }

      for (const kid of manualKids) {
        const { w: kw, h: kh } = size(kid)
        placeMindmap(kid.id, kid.position.x + kw / 2, kid.position.y + kh / 2, childSide(kid))
      }

      if (autoKids.length === 0) {
        return
      }

      let rightGroup: MindNode[]
      let leftGroup: MindNode[]
      if (manualKids.length > 0) {
        rightGroup = autoKids.filter(k => childSide(k) === 1)
        leftGroup = autoKids.filter(k => childSide(k) === -1)
        if (rightGroup.length + leftGroup.length !== autoKids.length) {
          rightGroup = autoKids
          leftGroup = []
        }
      }
      else {
        let rightCount = autoKids.length
        if (st.autoBalance && autoKids.length > 1) {
          const heights = autoKids.map(k => subtreeHeight(k.id))
          const total = heights.reduce((a, b) => a + b, 0)
          let acc = 0
          let bestDiff = Infinity
          let best = 1
          for (let i = 0; i < autoKids.length - 1; i++) {
            acc += heights[i]
            const diff = Math.abs(total - 2 * acc)
            if (diff < bestDiff) {
              bestDiff = diff
              best = i + 1
            }
          }
          rightCount = best
        }
        rightGroup = autoKids.slice(0, rightCount)
        leftGroup = autoKids.slice(rightCount)
      }
      for (const group of [rightGroup, leftGroup]) {
        if (group.length === 0) {
          continue
        }
        const sideSign: -1 | 1 = group === rightGroup ? 1 : -1
        const { centers } = stacked(group, h)
        for (const kid of group) {
          placeMindmap(kid.id, cx + sideSign * (w / 2 + st.spacing + size(kid).w / 2), cy + centers.get(kid.id)!, sideSign)
        }
      }
    }
    else {
      // XMind behavior: for non-root branches, children are laid out in a
      // sequential top-to-bottom column centered on the parent's center.
      // Also, if the parent has a manual position, use its actual coordinates
      // so dragged parents correctly anchor their children.
      const parentNode = sheet.nodes[id]
      const currentCx = !isAuto(id) && parentNode ? parentNode.position.x + w / 2 : cx
      const currentCy = !isAuto(id) && parentNode ? parentNode.position.y + h / 2 : cy

      const totalKidsH = kids.reduce((acc, kid) => acc + subtreeHeight(kid.id), 0) + st.branchSpacing * Math.max(0, kids.length - 1)
      let yCursor = currentCy - totalKidsH / 2
      for (const kid of kids) {
        const kh = subtreeHeight(kid.id)
        const ke = size(kid)
        const kidCy = yCursor + kh / 2
        placeMindmap(kid.id, currentCx + side * (w / 2 + st.spacing + ke.w / 2), kidCy, side)
        yCursor += kh + st.branchSpacing
      }
    }
  }

  function placeHierarchical(id: string, cx: number, cy: number, dir: 'right' | 'down'): void {
    const n = sheet.nodes[id]
    if (!n) {
      return
    }
    const { w, h } = size(n)
    positions.set(id, isAuto(id) ? { x: cx - w / 2, y: cy - h / 2 } : { x: n.position.x, y: n.position.y })

    if (n.collapsed || n.childrenIds.length === 0) {
      return
    }
    const kids = n.childrenIds.map(c => sheet.nodes[c]).filter((c): c is MindNode => !!c)

    if (dir === 'right') {
      const { centers } = stacked(kids, h)
      for (const kid of kids) {
        placeHierarchical(kid.id, cx + w / 2 + st.spacing + size(kid).w / 2, cy + centers.get(kid.id)!, dir)
      }
    }
    else {
      const widths = kids.map(kid => subtreeWidth(kid.id))
      const totalW = widths.reduce((acc, v) => acc + v, 0) + st.branchSpacing * Math.max(0, kids.length - 1)
      let cursor = cx - totalW / 2
      for (let i = 0; i < kids.length; i++) {
        const kid = kids[i]
        const sw = widths[i]
        placeHierarchical(kid.id, cursor + sw / 2, cy + h / 2 + st.spacing + size(kid).h / 2, dir)
        cursor += sw + st.branchSpacing
      }
    }
  }

  /** Resolve vertical collisions without moving manually positioned anchors. */
  function resolveIntersections(rootId: string): void {
    const branchBounds = (id: string): { minY: number, maxY: number } => {
      let minY = Infinity
      let maxY = -Infinity
      const visit = (nodeId: string): void => {
        const node = sheet.nodes[nodeId]
        if (!node) {
          return
        }
        const p = positions.get(nodeId) ?? { x: node.position.x, y: node.position.y }
        const h = size(node).h
        minY = Math.min(minY, p.y)
        maxY = Math.max(maxY, p.y + h)
        if (!node.collapsed) {
          for (const childId of node.childrenIds) {
            visit(childId)
          }
        }
      }
      visit(id)
      return { minY, maxY }
    }

    const shiftAutoSubtree = (id: string, dy: number): void => {
      const node = sheet.nodes[id]
      if (!node) {
        return
      }
      if (isAuto(id)) {
        const p = positions.get(id) ?? { x: node.position.x, y: node.position.y }
        positions.set(id, { x: p.x, y: p.y + dy })
      }
      if (!node.collapsed) {
        for (const childId of node.childrenIds) {
          shiftAutoSubtree(childId, dy)
        }
      }
    }

    const resolveNode = (parentId: string): void => {
      const parent = sheet.nodes[parentId]
      if (!parent || parent.collapsed) {
        return
      }
      for (const childId of parent.childrenIds) {
        resolveNode(childId)
      }
      const children = parent.childrenIds.map(id => sheet.nodes[id]).filter((n): n is MindNode => !!n && positions.has(n.id))
      if (children.length < 2) {
        return
      }

      const parentPosition = positions.get(parentId) ?? { x: parent.position.x, y: parent.position.y }
      const parentCenterX = parentPosition.x + size(parent).w / 2
      const parentCenterY = parentPosition.y + size(parent).h / 2
      const groups: MindNode[][] = st.structureType === 'mindmap' && parentId === rootId
        ? [
            children.filter((child) => {
              const p = positions.get(child.id)!
              return p.x + size(child).w / 2 < parentCenterX
            }),
            children.filter((child) => {
              const p = positions.get(child.id)!
              return p.x + size(child).w / 2 >= parentCenterX
            }),
          ]
        : [children]

      for (const group of groups) {
        for (let pass = 0; pass < group.length * 3; pass++) {
          group.sort((a, b) => branchBounds(a.id).minY - branchBounds(b.id).minY)
          let changed = false
          for (let i = 1; i < group.length; i++) {
            const previous = group[i - 1]
            const current = group[i]
            const previousBounds = branchBounds(previous.id)
            const currentBounds = branchBounds(current.id)
            const overlap = previousBounds.maxY + gap - currentBounds.minY
            if (overlap <= 0) {
              continue
            }
            const currentCenter = (currentBounds.minY + currentBounds.maxY) / 2
            if (isAuto(current.id)) {
              shiftAutoSubtree(current.id, currentCenter < parentCenterY ? -overlap : overlap)
              changed = true
            }
            else if (isAuto(previous.id)) {
              const previousCenter = (previousBounds.minY + previousBounds.maxY) / 2
              shiftAutoSubtree(previous.id, previousCenter < parentCenterY ? -overlap : overlap)
              changed = true
            }
          }
          if (!changed) {
            break
          }
        }
      }
    }
    resolveNode(rootId)
  }
}
