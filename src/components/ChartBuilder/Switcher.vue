<script setup lang='ts'>
import type { Ref } from 'vue'
import type { StoredCharts } from '../../types'
import { ref, watch } from 'vue'
import { getActiveChartUuid, getStoredCharts, getUuids, setActiveChart } from '../../helpers/localStorage'
import { useStore } from '../../store'

const store = useStore()

const activeChartUuid: Ref<string> = ref(getActiveChartUuid())
const charts: Ref<StoredCharts> = ref(getStoredCharts())
const chartUuids: Ref<string[]> = ref(getUuids())

watch(() => store.chart, () => {
  updateChartList()
})

function sortUuids(uuidArr: string[]) {
  return uuidArr.toSorted((a, b) => charts.value[b].timestamp - charts.value[a].timestamp)
}

function updateChartList() {
  activeChartUuid.value = getActiveChartUuid()
  charts.value = getStoredCharts()
  chartUuids.value = sortUuids(getUuids())
}

function changeChart(event: Event) {
  const uuid = (event.target as HTMLFormElement).value

  const newActiveChart = setActiveChart(uuid)

  activeChartUuid.value = uuid

  store.setEntireChart(newActiveChart.data)
}

function optionLabel(uuid: string): string {
  // The active chart's title comes from the live store: its debounced write
  // lags the edit by 300ms, so re-reading localStorage would keep showing the
  // previous title until the next mutation.
  if (uuid === activeChartUuid.value && store.chart.title) {
    return store.chart.title
  }

  const stored = charts.value[uuid]
  if (stored?.data?.title) {
    return stored.data.title
  }

  return `Untitled (${new Date(stored?.timestamp || 0).toUTCString()})`
}
</script>

<template>
  <div>
    <select
      id="chart-switcher"
      name="chart-switcher"
      @change="changeChart"
    >
      <option
        v-for="(uuid, index) in chartUuids"
        :key="index"
        :value="uuid"
        :selected="uuid === activeChartUuid"
      >
        {{ optionLabel(uuid) }}
      </option>
    </select>
  </div>
</template>

<style>
#chart-switcher {
  width: 140px;
  color: #000000;
  appearance: none;
}
</style>
