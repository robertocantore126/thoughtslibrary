<script setup lang='ts'>
import type { Ref, ShallowRef } from 'vue'
import type { StoredCharts } from '../../types'
import { ref, shallowRef, watch } from 'vue'
import { getActiveChartUuid, getStoredChartsSnapshot, getUuids, setActiveChart } from '../../helpers/localStorage'
import { useStore } from '../../store'

const store = useStore()

const activeChartUuid: Ref<string> = ref(getActiveChartUuid())
// The store replaces `chart` wholesale on every mutation, so the watcher below
// runs on every keystroke. It used to re-parse the entire chart store twice per
// run - megabytes of JSON per typed character once the user owns a few large
// charts. The snapshot re-parses only when the stored string has actually
// changed, and `shallowRef` keeps Vue from deep-proxying every chart on top of
// that. Read-only here: the snapshot is shared, and nothing in this file writes.
const charts: ShallowRef<Readonly<StoredCharts>> = shallowRef(getStoredChartsSnapshot())
const chartUuids: Ref<string[]> = ref(getUuids())

watch(() => store.chart, () => {
  updateChartList()
})

function sortUuids(uuidArr: string[]) {
  return uuidArr.toSorted((a, b) => (charts.value[b]?.timestamp || 0) - (charts.value[a]?.timestamp || 0))
}

function updateChartList() {
  activeChartUuid.value = getActiveChartUuid()
  charts.value = getStoredChartsSnapshot()
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
