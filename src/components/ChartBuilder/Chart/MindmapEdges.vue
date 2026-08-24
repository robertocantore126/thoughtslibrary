<script setup lang="ts">
import type { NodeSize } from '../../../mindmap/layout'
import type { MindNode, Sheet } from '../../../mindmap/types'
import { computed } from 'vue'
import { edgeVisible, rectOf, type Viewport } from '../../../mindmap/cull'
import { edgePath, type Rect } from '../../../mindmap/geometry'
import { useMindmapStore } from '../../../mindmap/store'

// Takes the FULL node list and size cache, not a culled list: it needs the
// rects of off-screen endpoints to decide whether an edge crosses the screen
// (MINDMAP_S2_AGENT_BRIEF M1.3). Drawing only when BOTH endpoints are visible
// leaves children floating with no connector the moment their parent pans out
// of the cushion — the S2 M1 regression this `edgeVisible` union test fixes.
const props = defineProps<{
  nodes: MindNode[]
  sizes: Record<string, NodeSize>
  viewport: Viewport | null
  margin: number
}>()

const PAD = 12

const store = useMindmapStore()

// Collapsed subtrees are pruned from layout and hidden; a curve to a folded-away
// node reads as a rendering bug, so those pairs never draw.
function hiddenIds(sheet: Sheet): Set<string> {
  const set = new Set<string>()
  const walk = (id: string, underCollapsed: boolean) => {
    const node = sheet.nodes[id]
    if (!node) {
      return
    }
    if (underCollapsed) {
      set.add(id)
    }
    const childHidden = underCollapsed || node.collapsed
    for (const childId of node.childrenIds) {
      walk(childId, childHidden)
    }
  }
  walk(sheet.rootNodeId, false)
  return set
}

// An edge is drawn when its curve can reach the padded viewport — even if one
// or both endpoints sit just off-screen. `box` is the union of the two endpoint
// rects (plus a little room for the bulge is added by edgeVisible; this is the
// geometry for the SVG bounds below). The SVG box is the union of the DRAWn
// edges plus a pad, so the layer stays small on a huge map and no bulge is
// clipped.

// Curve geometry is pure world data — a pan must never rebuild it. The path
// strings are the expensive part (a 3,000-topic map draws thousands of them),
// so they are computed HERE, without the camera in the dependency graph, and
// only the visibility filter below depends on the viewport. That keeps the
// single-transform rule honest: panning touches the CSS transform alone, and
// Vue's stable-keyed v-for patches nothing when the filtered set is unchanged.
// The endpoint rects ride along so edgeVisible has what it needs without a
// second pass.
interface Edge {
  key: string
  d: string
  box: Rect
  parent: Rect
  child: Rect
}

const edgeGeometry = computed<Edge[]>(() => {
  const sheet = store.sheet
  if (!sheet) {
    return []
  }
  const hidden = hiddenIds(sheet)
  const out: Edge[] = []
  const seen = new Set<string>()
  for (const node of props.nodes) {
    if (hidden.has(node.id) || node.collapsed) {
      continue
    }
    for (const childId of node.childrenIds) {
      if (hidden.has(childId)) {
        continue
      }
      const child = sheet.nodes[childId]
      if (!child) {
        continue
      }
      const key = `${node.id}->${childId}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const parentRect = rectOf(node, props.sizes)
      const childRect = rectOf(child, props.sizes)
      const box: Rect = {
        x: Math.min(parentRect.x, childRect.x),
        y: Math.min(parentRect.y, childRect.y),
        w: Math.max(parentRect.x + parentRect.w, childRect.x + childRect.w) - Math.min(parentRect.x, childRect.x),
        h: Math.max(parentRect.y + parentRect.h, childRect.y + childRect.h) - Math.min(parentRect.y, childRect.y),
      }
      out.push({ key, d: edgePath(parentRect, childRect), box, parent: parentRect, child: childRect })
    }
  }
  return out
})

const edges = computed<Edge[]>(() => {
  const vp = props.viewport
  if (!vp) {
    return []
  }
  return edgeGeometry.value.filter(e => edgeVisible(e.parent, e.child, vp, props.margin))
})

const bounds = computed<Rect>(() => {
  // Union of the drawn edges' boxes plus a pad, so the SVG clips no stroke at
  // its extremes. Zero rect when nothing is drawn (the guard the first attempt
  // got right and must survive).
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const edge of edges.value) {
    minX = Math.min(minX, edge.box.x)
    minY = Math.min(minY, edge.box.y)
    maxX = Math.max(maxX, edge.box.x + edge.box.w)
    maxY = Math.max(maxY, edge.box.y + edge.box.h)
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  return {
    x: minX - PAD,
    y: minY - PAD,
    w: maxX - minX + PAD * 2,
    h: maxY - minY + PAD * 2,
  }
})
</script>

<template>
  <!-- One SVG for the drawn edges, beneath the topics (rendered first). Like
  TileLinks: decoration only — pointer-events none so every click lands on the
  map itself. -->
  <svg
    class="mindmap-edges"
    :width="bounds.w"
    :height="bounds.h"
    :viewBox="`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`"
    :style="{ left: `${bounds.x}px`, top: `${bounds.y}px` }"
  >
    <g v-for="edge in edges" :key="edge.key">
      <!-- Drawn twice: a dark halo underneath, then the line itself, matching
      TileLinks — a single stroke disappears against a background of its own
      colour, and the chart background is whatever the user picked. -->
      <path class="mindmap-edge-halo" :d="edge.d" />
      <path class="mindmap-edge-line" :d="edge.d" />
    </g>
  </svg>
</template>

<style scoped>
.mindmap-edges {
  position: absolute;
  pointer-events: none;
  overflow: visible;
}

.mindmap-edge-halo {
  fill: none;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 5;
}

.mindmap-edge-line {
  fill: none;
  stroke: #ffffff;
  stroke-width: 2;
}
</style>
