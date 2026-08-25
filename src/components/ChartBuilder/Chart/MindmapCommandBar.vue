<script setup lang="ts">
import { computed } from 'vue'
import { useMindmapStore } from '../../../mindmap/store'

// The map's status strip (S4 §C.6). Round 0 plumbed saveState/saveError; this
// is what makes them visible: nothing at all when clean, something quiet while
// saving, and a LOUD, persistent message on error.
//
// The error case is the entire point. Before S4 a full IndexedDB meant an hour
// of editing was lost with one line in the console and a UI identical to a
// working one, so an indicator that is easy to miss rebuilds the bug it was
// added to fix. The message stays until a write actually succeeds — the store
// deliberately keeps saveState at 'error' across further edits (§T.6, the
// autosave policy is unchanged).
const store = useMindmapStore()

// 'pending' and 'saving' are both "a write is in flight or coming"; the strip
// shows one quiet word for the two of them.
const saving = computed(() => store.saveState === 'pending' || store.saveState === 'saving')
</script>

<template>
  <!-- Positioned against the overlay chrome, not this flex child's own slot:
  the toolbar must not reflow when the strip appears. -->
  <div
    v-if="store.saveState === 'error'"
    class="mindmap-save-error"
    role="alert"
  >
    ⚠ Autosave failed — your changes are NOT being saved. {{ store.saveError }}
  </div>
  <div v-else-if="saving" class="mindmap-save-saving">
    Saving…
  </div>
</template>

<style scoped>
.mindmap-save-error {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  padding: 8px 14px;
  background: #7a1f1f;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 6px;
  color: #ffffff;
  font-size: 12.5px;
  text-align: center;
  z-index: 6;
}

.mindmap-save-saving {
  position: absolute;
  right: 12px;
  bottom: 12px;
  font-size: 11.5px;
  opacity: 0.6;
  z-index: 6;
}
</style>
