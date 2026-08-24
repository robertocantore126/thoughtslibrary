<script setup lang="ts">
import type { NodeSize } from '../../../mindmap/layout'
import type { MindNode, Sheet } from '../../../mindmap/types'
import { computed } from 'vue'
import { edgePath, type Rect } from '../../../mindmap/geometry'
import { useMindmapStore } from '../../../mindmap/store'

// The canvas measures every node and hands the batch down; the store's own
// copy (kept for fit()) is not part of the frozen contract type.
const props = defineProps<{
  sizes: Record<string, NodeSize>
}>()

// A node with no measured size yet (the canvas measures on its first pass) —
// the edge may be a frame off for one render, never a crash.
const FALLBACK: Rect = { x: 0, y: 0, w: 120, h: 40 }
const PAD = 12

const store = useMindmapStore()

// Collapsed subtrees are pruned from layout and hidden by the canvas, so the
// edges under them must vanish too — a dangling curve to an invisible node is
// the one kind of edge that reads as a rendering bug.
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

function rectOf(node: MindNode): Rect {
  const size = props.sizes[node.id]
  return {
    x: node.position.x,
    y: node.position.y,
    w: size?.w ?? FALLBACK.w,
    h: size?.h ?? FALLBACK.h,
  }
}

interface Edge {
  key: string
  d: string
}

const edges = computed<Edge[]>(() => {
  const sheet = store.sheet
  if (!sheet) {
    return []
  }
  const hidden = hiddenIds(sheet)
  const out: Edge[] = []
  for (const node of store.visibleNodes) {
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
      out.push({
        key: `${node.id}->${childId}`,
        d: edgePath(rectOf(node), rectOf(child)),
      })
    }
  }
  return out
})

// The SVG is sized to the map bounds plus a small pad so strokes at the outer
// edges are not clipped by the viewport. In world units, inside the canvas's
// transformed world, so the whole layer scales with the camera.
const bounds = computed<Rect>(() => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const node of store.visibleNodes) {
    const r = rectOf(node)
    minX = Math.min(minX, r.x)
    minY = Math.min(minY, r.y)
    maxX = Math.max(maxX, r.x + r.w)
    maxY = Math.max(maxY, r.y + r.h)
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
  <!-- One SVG for all edges, beneath the topics (rendered first). Like
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
