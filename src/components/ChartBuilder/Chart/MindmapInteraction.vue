<script setup lang="ts">
import type { Viewport } from '../../../mindmap/cull'
import type { NodeSize } from '../../../mindmap/layout'

// STUB — S4 Lane C owns this file (see MINDMAP_S4_AGENT_BRIEF.md §C.2).
//
// The editing model: the window keydown listener, node drag by delegation,
// marquee, drop indicator and context menu. Invisible except for those
// transient visuals.
//
// Round 0 left two things here for it:
//  - Topics carry `data-node-id`, so pointer targets resolve with
//    event.target.closest('[data-node-id]') — one listener instead of one per
//    mounted topic, and MindmapNode stays Lane A's file.
//  - store.requestEdit(nodeId, seed) opens the inline editor. Do not reach into
//    MindmapNode to do it.
defineProps<{
  viewport: Viewport | null
  sizes: Record<string, NodeSize>
}>()
</script>

<template>
  <!-- Renders nothing: `v-if="false"` is the placeholder root, because a
  template needs one element and this stub must add no box, no listener and no
  paint to the map until Lane C fills it with the interaction controller. -->
  <div v-if="false" />
</template>
