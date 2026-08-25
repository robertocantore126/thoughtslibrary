<script setup lang="ts">
// The capture gesture, top-right and always there.
//
// Downloading BEFORE clearing is deliberate, and copied from r-node: by the
// time anyone reaches for this button the bug has already happened, so
// clearing first would throw away the evidence. Each press writes the file,
// then starts a clean window, which scopes the NEXT capture to the next
// problem instead of to the whole session.
import { computed, onMounted, ref } from 'vue'
import { buildReport, installTrace, tracer } from '../dev/trace'
import { useMindmapStore } from '../mindmap/store'
import { useStore } from '../store'

const store = useStore()
const mindmap = useMindmapStore()

const busy = ref(false)
// Shown for a moment after a capture, then gone: a permanent badge would sit
// there claiming a stale count long after the state moved on.
const flash = ref('')

const label = computed(() => {
  if (busy.value) {
    return 'Reading state…'
  }
  return flash.value || 'Trace'
})

onMounted(() => {
  installTrace()
})

async function capture() {
  if (busy.value) {
    return
  }
  busy.value = true
  flash.value = ''
  try {
    // Every field is read defensively. The tracer must survive a store shape
    // that changed under it — a diagnostic that breaks on the broken state is
    // the one thing it may never do.
    const report = await buildReport({
      chart: store.chart,
      focusedTileId: store.focusedTileId ?? null,
      mindmapSheetId: mindmap.sheet?.sheetId ?? null,
      saveState: mindmap.saveState,
      saveError: mindmap.saveError ?? null,
    })
    tracer.download(report)
    const errors = report.meta.errorCount as number
    const total = report.problems.length
    flash.value = total === 0 ? 'Clean' : `${total} found${errors > 0 ? ` (${errors} error)` : ''}`
    tracer.clear()
  }
  catch (error) {
    console.error('The tracer itself failed:', error)
    flash.value = 'Failed'
  }
  finally {
    busy.value = false
    setTimeout(() => {
      flash.value = ''
    }, 6000)
  }
}
</script>

<template>
  <button
    class="tracer-button"
    :class="{ 'is-busy': busy }"
    :disabled="busy"
    data-html2canvas-ignore
    title="Capture a diagnostic JSON — what is open, what does not add up, and what just happened. Downloads the file, then starts a fresh recording."
    @click="capture"
  >
    <span class="tracer-dot" aria-hidden="true" />
    {{ label }}
  </button>
</template>

<style scoped>
/* Fixed, not absolute: the chart scrolls and the mindmap overlay covers the
   app at z-index 50, and this has to outrank both — a diagnostic you cannot
   reach while the thing you are diagnosing is on screen is no use. */
.tracer-button {
  position: fixed;
  top: 10px;
  right: 12px;
  z-index: 100;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  color: #cfd3da;
  background: rgba(22, 22, 26, 0.82);
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 4px;
  cursor: pointer;
  /* Deliberately quiet until hovered: it lives on top of every screen in the
     app, so it must read as furniture rather than as a call to action. */
  opacity: 0.45;
  transition: opacity 120ms ease, border-color 120ms ease;
}

.tracer-button:hover,
.tracer-button:focus-visible {
  opacity: 1;
  border-color: rgba(255, 255, 255, 0.4);
}

.tracer-button:focus-visible {
  outline: 2px solid #6ea8fe;
  outline-offset: 2px;
}

.tracer-button.is-busy {
  cursor: progress;
  opacity: 1;
}

.tracer-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #e0574a;
}

.is-busy .tracer-dot {
  animation: tracer-pulse 900ms ease-in-out infinite;
}

@keyframes tracer-pulse {
  50% { opacity: 0.25; }
}

@media (prefers-reduced-motion: reduce) {
  .is-busy .tracer-dot {
    animation: none;
  }
}
</style>
