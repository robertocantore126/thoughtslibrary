<script setup lang="ts">
// STUB — S4 Lane B owns this file (see MINDMAP_S4_AGENT_BRIEF.md §B.4, §B.5).
//
// The inspector section for what is selected, rendering per selection kind:
// 2+ nodes → "Group selection" / "Connect"; a relationship → label, colour,
// line style, connector, bidirectional, delete; a group → label, colour, border
// width, delete. Nothing relevant selected → render nothing at all, not an
// empty panel frame.
//
// Also home to the map export buttons (§B.5). Every control goes through
// relationCommands.ts, so Ctrl+Z undoes a colour change like any other edit.
</script>

<template>
  <!-- Renders nothing: `v-if="false"` is the placeholder root, because a
  template needs one element and this stub must add no box, no listener and no
  paint to the map until Lane B fills it with the relation/group controls. -->
  <div v-if="false" />
</template>
