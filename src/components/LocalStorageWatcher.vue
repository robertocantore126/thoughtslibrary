<script setup lang="ts">
import { onMounted } from 'vue'
import { initializeFirstRun } from '../helpers/chart'
import {
  appendChart,
  getActiveChart,
  getActiveChartUuid,
  localStorageMigrations,
  setActiveChart,
  updateStoredChart,
} from '../helpers/localStorage'
import { useStore } from '../store'

const store = useStore()
let hasWarnedStorageQuota = false

function isStorageQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false
  }

  return error.name === 'QuotaExceededError' || error.code === 22
}

onMounted(() => {
  localStorageMigrations()

  const activeChart = getActiveChart()

  if (activeChart) {
    store.setEntireChart(activeChart.data)
  }
  else {
    initializeFirstRun()
    store.setEntireChart(getActiveChart().data)
  }
})

store.$subscribe((_mutation, state) => {
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
        alert('This chart is too large to save locally. Try a smaller image or fewer local images.')
      }
      return
    }

    console.error(error)
  }
})
</script>

<template>
  <slot />
</template>
