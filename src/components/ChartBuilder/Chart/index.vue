<script setup lang="ts">
import type { ComputedRef, CSSProperties } from 'vue'
import { computed } from 'vue'
import { useStore } from '../../../store'
import { BackgroundTypes, type Chart } from '../../../types'
import Row from './Row.vue'

const store = useStore()

const isFocusMode = computed(() => !!store.focusedTileId)

function getBackgroundStyle(chart: Chart): CSSProperties {
  if (chart.backgroundType === BackgroundTypes.Color) {
    return ({
      backgroundColor: store.chart.backgroundColor,
    })
  }

  // default to black background when no image URL has been entered
  if (!chart.backgroundUrl) {
    return ({
      backgroundColor: '#000000',
    })
  }

  return ({
    backgroundImage: `url("${store.chart.backgroundUrl}")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'center',
    backgroundSize: 'cover',
  })
}

const chartTitleStyle: ComputedRef<CSSProperties> = computed(() => ({
  marginTop: `${store.chart.gap / 2}px`,
}))

const chartStyle: ComputedRef<CSSProperties> = computed(() => ({
  fontFamily: store.chart.font || 'monospace',
  textShadow: store.chart.shadows ? '2px 2px 4px rgba(0,0,0,0.6)' : 'none',
  borderRadius: store.chart.roundCorners ? '10px' : '0',
  color: store.chart.textColor,
  ...getBackgroundStyle(store.chart),
}))

interface VisualRow {
  rowNumber: number
  indices: number[]
}

const visualRows = computed<VisualRow[]>(() => {
  const width = store.chart.size.x
  const height = store.chart.size.y
  const rows: VisualRow[] = []

  for (let rowNumber = 1; rowNumber <= height; rowNumber += 1) {
    const start = (rowNumber - 1) * width
    const indices = Array.from({ length: width }, (_, idx) => start + idx)

    rows.push({
      rowNumber,
      indices,
    })
  }

  return rows
})
</script>

<template>
  <div class="chart-viewport">
    <div
      id="chart"
      :style="chartStyle"
    >
      <div v-if="store.chart.title">
        <p class="chart-title" :class="{ 'focus-dimmed': isFocusMode }" :style="chartTitleStyle">
          {{ store.chart.title }}
        </p>
      </div>
      <div class="row-flex" :style="{ gap: `${store.chart.gap}px`, padding: `${store.chart.gap}px`, paddingTop: store.chart.title ? `${store.chart.gap / 2}px` : `${store.chart.gap}px` }">
        <Row
          v-for="row in visualRows"
          :key="row.rowNumber"
          :row-number="row.rowNumber"
          :indices="row.indices"
        />
      </div>
    </div>
  </div>
</template>

<style>
.chart-viewport {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow: auto;
  padding: 16px 20px 20px;
}

#chart {
  display: inline-block;
  position: relative;
}

#chart .chart-title {
  font-size: 50px;
  padding: 0;
  margin: 0;
}

#chart .chart-title.focus-dimmed {
  opacity: 0.10;
  transition: opacity 200ms ease;
}

#chart .row-flex {
  display: flex;
  flex-flow: column;
  margin: 0;
  padding: 0;
  width: max-content;
}
</style>
