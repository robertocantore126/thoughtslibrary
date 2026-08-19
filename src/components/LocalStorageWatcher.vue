<script setup lang="ts">
import type { Chart } from '../types'
import { onMounted } from 'vue'
import { persistChartAssets } from '../helpers/assets'
import { initializeFirstRun } from '../helpers/chart'
import {
  appendChart,
  findByUuid,
  getActiveChart,
  getActiveChartUuid,
  getStoredCharts,
  localStorageMigrations,
  setActiveChart,
  setStoredCharts,
  updateStoredChart,
} from '../helpers/localStorage'
import { useStore } from '../store'

const store = useStore()
let hasWarnedStorageQuota = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
// A pending write is bound to the uuid it belongs to. Without that pairing,
// switching charts inside the debounce window cancelled the first chart's write
// and flushed the second chart's data in its place, losing the edit.
let pendingUuid: string | null = null
let pendingChart: Chart | null = null

function isStorageQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false
  }

  return error.name === 'QuotaExceededError' || error.code === 22
}

// Commits whatever write is pending to the chart it was scheduled for, and
// clears the timer. Safe to call at any time, including when nothing is pending.
function flushPendingChartWrite() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }

  const uuid = pendingUuid
  const chart = pendingChart
  pendingUuid = null
  pendingChart = null

  if (uuid && chart) {
    persistChart(uuid, chart)
  }
}

function persistChart(uuid: string, chart: Chart) {
  try {
    const storedChart = uuid ? findByUuid(uuid) : null

    if (storedChart) {
      updateStoredChart({ ...storedChart, data: chart }, uuid)
    }
    else {
      const newUuid = appendChart({
        timestamp: new Date().getTime(),
        data: chart,
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
  const uuid = getActiveChartUuid()

  // The active chart changed while a write was still pending: commit it to the
  // chart it actually belongs to before this one takes its place.
  if (pendingUuid && pendingUuid !== uuid) {
    flushPendingChartWrite()
  }

  pendingUuid = uuid
  // The store replaces `chart` wholesale on every mutation, so this reference is
  // a genuine snapshot rather than a view that will drift.
  pendingChart = state.chart

  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(flushPendingChartWrite, 300)
  // flush: 'sync' so every mutation is observed as it happens. Pinia's default
  // ('pre') batches to the render cycle, which collapses "edit chart A" and
  // "switch to chart B" into a single notification carrying only B's state -
  // the edit to A would never be seen, let alone written. The 300ms debounce
  // above still keeps the actual writes rare.
}, { flush: 'sync' })

window.addEventListener('beforeunload', flushPendingChartWrite)
</script>

<template>
  <slot />
</template>
