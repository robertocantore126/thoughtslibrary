<script setup lang="ts">
// STUB — S4 Lane C owns this file (see MINDMAP_S4_AGENT_BRIEF.md §C.6).
//
// The map's status strip. Round 0 plumbed store.saveState / store.saveError;
// this is what makes them visible: nothing at all when clean, something quiet
// while saving, and a LOUD, persistent message on error.
//
// The error case is the entire point. Before S4 a full IndexedDB meant an hour
// of editing was lost with one line in the console and a UI identical to a
// working one, so an indicator that is easy to miss rebuilds the bug it was
// added to fix.
</script>

<template>
  <!-- Renders nothing: `v-if="false"` is the placeholder root, because a
  template needs one element and this stub must add no box, no listener and no
  paint to the map until Lane C fills it with the save-state strip. -->
  <div v-if="false" />
</template>
