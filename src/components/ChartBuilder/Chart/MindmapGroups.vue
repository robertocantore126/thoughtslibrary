<script setup lang="ts">
import type { Viewport } from '../../../mindmap/cull'
import type { NodeSize } from '../../../mindmap/layout'
import type { MindNode } from '../../../mindmap/types'

// STUB — S4 Lane B owns this file (see MINDMAP_S4_AGENT_BRIEF.md §B.3).
//
// Boundaries: a dashed rounded rect around the union of a group's member rects,
// drawn BENEATH the tree so it never hides what it encloses. Round 0 created
// and mounted it so Lane B opens a file that already compiles and is already in
// the right place in the stacking order.
//
// Two rules that are already decided:
//  - `Group.borderWidth` is in SCREEN pixels: divide by store.camera.scale, so
//    a boundary stays as thick as it was drawn at every zoom (types.ts).
//  - Members that no longer resolve are SKIPPED, not pruned from memberIds. A
//    deleted topic's id must stay, because restoreNode brings the topic back on
//    undo and the group re-encloses it for free.
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
  paint to the map until Lane B fills it with the boundary layer. -->
  <div v-if="false" />
</template>
