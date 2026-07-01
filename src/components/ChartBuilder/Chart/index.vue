<script setup lang="ts">
import type { ComputedRef, CSSProperties } from 'vue'
import { computed } from 'vue'
import { useStore } from '../../../store'
import { BackgroundTypes, type Chart } from '../../../types'
import Row from './Row.vue'

const store = useStore()

function getTileSize(): { width: number, height: number } {
  const rowFlex = document.querySelector('#chart .row-flex')?.getBoundingClientRect()
  const cols = store.chart.size.x

  if (!rowFlex) {
    return { width: 1, height: 1 }
  }

  return {
    width: rowFlex.width / cols,
    height: rowFlex.width / cols,
  }
}

function getTileCoordinates(event: MouseEvent): { x: number, y: number } {
  const chartElement = document.querySelector('#chart')
  const rowFlex = document.querySelector('#chart .row-flex')
  if (!chartElement || !rowFlex) {
    return { x: 1, y: 1 }
  }

  const chartRect = chartElement.getBoundingClientRect()
  const contentRect = rowFlex.getBoundingClientRect()
  const localX = event.clientX - contentRect.left
  const localY = event.clientY - contentRect.top
  const tileWidth = contentRect.width / store.chart.size.x
  const tileHeight = tileWidth
  const x = Math.min(store.chart.size.x, Math.max(1, Math.floor(localX / tileWidth) + 1))
  const y = Math.min(store.chart.size.y, Math.max(1, Math.floor(localY / tileHeight) + 1))

  return { x, y }
}

function normalizeSelection(start: { x: number, y: number }, end: { x: number, y: number }) {
  const x1 = Math.min(start.x, end.x)
  const x2 = Math.max(start.x, end.x)
  const y1 = Math.min(start.y, end.y)
  const y2 = Math.max(start.y, end.y)

  return {
    x: x1,
    y: y1,
    width: x2 - x1 + 1,
    height: y2 - y1 + 1,
  }
}


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
        <p class="chart-title" :style="chartTitleStyle">
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

#chart .row-flex {
  display: flex;
  flex-flow: column;
  margin: 0;
  padding: 0;
  width: max-content;
}
</style>
