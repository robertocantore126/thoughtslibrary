<script setup lang="ts">
import type { Viewport } from '../../../mindmap/cull'
import type { NodeSize } from '../../../mindmap/layout'
import type { MindNode } from '../../../mindmap/types'

// STUB — S4 Lane B owns this file (see MINDMAP_S4_AGENT_BRIEF.md §B.2).
//
// Free relationships between any two topics, independent of the parent/child
// tree, drawn ABOVE the topics so labels and arrowheads read. Model the file on
// MindmapEdges.vue, which is the same shape of problem and already solves the
// hard parts (world-only geometry so a pan rebuilds nothing, an SVG box that is
// the union of what is actually drawn).
//
// The trap: MindmapEdges sets `pointer-events: none` on its <svg> so clicks
// reach the topics. Keep that here and re-enable it only on hit shapes — a fat
// invisible stroke per relationship with `pointer-events: stroke`. A layer that
// answers clicks across its whole box makes every topic under it unselectable,
// and the bug reads as "selection is broken".
defineProps<{
  nodes: MindNode[]
  sizes: Record<string, NodeSize>
  viewport: Viewport | null
  margin: number
}>()
</script>

<template>
  <!-- Renders nothing: `v-if="false"` is the placeholder root, because a
  template needs one element and this stub must add no box, no listener and no
  paint to the map until Lane B fills it with the relationship layer. -->
  <div v-if="false" />
</template>
