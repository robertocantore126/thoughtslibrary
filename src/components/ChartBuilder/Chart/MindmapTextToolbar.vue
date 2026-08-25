<script setup lang="ts">
// STUB — S4 Lane A owns this file (see MINDMAP_S4_AGENT_BRIEF.md §A.4).
//
// The floating format bar: bold, italic, underline, strike and a colour swatch,
// applied to the current selection inside the open title editor. Visible only
// while an editor is open, positioned over the edited node (screen = world *
// camera.scale + camera, since the whole world is one CSS transform).
//
// It is the visible twin of the Ctrl+B/I/U handling in MindmapNode — both go
// through the same richtext.ts functions, so neither can drift into being the
// only way to reach a mark.
</script>

<template>
  <!-- Renders nothing: `v-if="false"` is the placeholder root, because a
  template needs one element and this stub must add no box, no listener and no
  paint to the map until Lane A fills it with the format bar. -->
  <div v-if="false" />
</template>
