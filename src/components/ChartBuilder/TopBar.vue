<!-- eslint-disable no-alert -->
<script setup lang="ts">
import type { Ref } from 'vue'
import type { StoredChart } from '../../types'
import { BIconArrowRepeat, BIconFileEarmarkArrowDown } from 'bootstrap-icons-vue'
import { onUnmounted, ref, watch } from 'vue'
import { downloadChart, initializeFirstRun } from '../../helpers/chart'
import { appendChart, destroyChart, getActiveChartUuid, getNewestChartUuid, getStoredCharts, setActiveChart } from '../../helpers/localStorage'
import { createEmptyChart, useStore } from '../../store'
import Switcher from './Switcher.vue'

const store = useStore()

// Keep track of loading so the user knows why it's taking a while.
// Also, we can prevent the user from spamming the button to generate multiple requests.
const loading: Ref<boolean> = ref(false)

// Transient "Saved" confirmation. Ctrl+S is silent otherwise, so this is the
// only signal that an overwrite actually happened.
const showSaved: Ref<boolean> = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

watch(() => store.lastSavedAt, (savedAt) => {
  if (!savedAt) {
    return
  }

  showSaved.value = true

  if (savedTimer) {
    clearTimeout(savedTimer)
  }

  savedTimer = setTimeout(() => {
    showSaved.value = false
    savedTimer = null
  }, 1800)
})

onUnmounted(() => {
  if (savedTimer) {
    clearTimeout(savedTimer)
  }
})

async function saveChart() {
  loading.value = true
  await downloadChart()
  loading.value = false
}

function startNewChart() {
  const newChart: StoredChart = {
    timestamp: new Date().getTime(),
    data: createEmptyChart(),
  }

  const newUuid = appendChart(newChart)
  setActiveChart(newUuid)

  store.reset()
}

function deleteChart() {
  const activeChartUuid = getActiveChartUuid()

  if (window.confirm('Are you sure you want to delete this chart? There\'s no way to recover it!')) {
    destroyChart(activeChartUuid)

    const newStoredCharts = getStoredCharts()

    if (Object.keys(newStoredCharts).length < 1) {
      // We've just deleted the only saved chart, so let's re-initialize.
      initializeFirstRun()
      store.reset()
    }
    else {
      // If there are other charts, pick the most recently created one.
      const chart = setActiveChart(getNewestChartUuid())

      store.setEntireChart(chart.data)
    }
  }
}
</script>

<template>
  <div id="top-bar">
    <div class="switcher-menu">
      <button
        @click="deleteChart"
      >
        -
      </button>
      <Switcher />
      <button
        @click="startNewChart"
      >
        +
      </button>
      <Transition name="saved-fade">
        <span v-if="showSaved" class="saved-indicator" role="status">Saved</span>
      </Transition>
    </div>
    <button
      v-if="!loading"
      class="download-button"
      @click="saveChart"
    >
      <BIconFileEarmarkArrowDown id="save-icon" />
      Download
    </button>
    <button
      v-else
      class="download-button"
    >
      <BIconArrowRepeat id="loading-icon" />
      loading...
    </button>
  </div>
</template>

<style>
#top-bar {
  width: 100%;
  height: 48px;
  background: var(--ui-bg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  top: 0;
  left: 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  margin: 0;
  padding: 0 12px;
  color: white;
  z-index: 2;
  position: sticky;
}

.download-button {
  height: 32px;
  width: 120px;
  margin-left: 12px;
  position: static;
}

#save-icon {
  position: relative;
  top: 2px;
}

#loading-icon {
  position: relative;
  top: 2px;
  animation: rotation 1.5s;
  animation-iteration-count: infinite;
  animation-timing-function: linear;
}

.switcher-menu {
  width: auto;
  height: 100%;
  color: black;
  text-align: center;
  display: flex;
  justify-content: center;
  gap: 12px;
  align-items: center;
}

.saved-indicator {
  font-size: 0.78rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: #7ee08a;
  white-space: nowrap;
  user-select: none;
}

.saved-fade-enter-active,
.saved-fade-leave-active {
  transition: opacity 220ms ease;
}

.saved-fade-enter-from,
.saved-fade-leave-to {
  opacity: 0;
}

@keyframes rotation {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(359deg);
  }
}

@media screen and (max-width: 1000px) {
  #top-bar {
    width: 100%;
    left: 0;
    z-index: 1;
  }

  .switcher-menu {
    max-width: 60%;
    gap: 8px;
  }

}
</style>
