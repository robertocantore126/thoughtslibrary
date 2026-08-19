<script setup lang="ts">
import { onMounted } from 'vue'
import { persistChartAssets } from '../helpers/assets'
import { initializeFirstRun } from '../helpers/chart'
import {
  appendChart,
  getActiveChart,
  getActiveChartUuid,
  getStoredCharts,
  localStorageMigrations,
  setActiveChart,
  setStoredCharts,
  updateStoredChart,
} from '../helpers/localStorage'
import { type State, useStore } from '../store'

const store = useStore()
let hasWarnedStorageQuota = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingState: State | null = null

function isStorageQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false
  }

  return error.name === 'QuotaExceededError' || error.code === 22
}

function persistState(state: State) {
  try {
    const activeChartUuid = getActiveChartUuid()
    const activeChart = getActiveChart()

    if (activeChart) {
      const updatedChart = {
        ...activeChart,
        data: state.chart,
      }

      updateStoredChart(updatedChart, activeChartUuid)
    }
    else {
      const newUuid = appendChart({
        timestamp: new Date().getTime(),
        data: state.chart,
      })

      setActiveChart(newUuid)
    }
  }
  catch (error) {
    if (isStorageQuotaExceeded(error)) {
      if (!hasWarnedStorageQuota) {
        hasWarnedStorageQuota = true
        // eslint-disable-next-line no-alert
        alert('This chart is too large to save locally. Try a smaller image or fewer local images.')
      }
      return
    }

    console.error(error)
  }
}

onMounted(async () => {
  localStorageMigrations()

  const storedCharts = getStoredCharts()
  const normalizedEntries = await Promise.all(
    Object.entries(storedCharts).map(async ([uuid, chart]) => {
      return [uuid, {
        ...chart,
        data: await persistChartAssets(chart.data),
      }] as const
    }),
  )

  setStoredCharts(Object.fromEntries(normalizedEntries))

  const activeChart = getActiveChart()

  if (activeChart) {
    store.setEntireChart(activeChart.data)
  }
  else {
    initializeFirstRun()
    store.setEntireChart(getActiveChart().data)
  }
})

// Persist the whole chart, but only after the edit burst settles — a note
// keystroke otherwise stringifies the chart on every character. Flush any
// pending state on unload so the last edit is never lost on close.
store.$subscribe((_mutation, state) => {
  pendingState = state

  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(() => {
    saveTimer = null
    pendingState = null
    persistState(state)
  }, 300)
})

window.addEventListener('beforeunload', () => {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }

  if (pendingState) {
    persistState(pendingState)
  }
})
</script>

<template>
  <slot />
</template>
