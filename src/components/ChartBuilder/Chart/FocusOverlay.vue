<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, watch } from 'vue'
import { useStore } from '../../../store'
import LayerTile from './LayerTile.vue'

const store = useStore()

const isFocusMode = computed(() => !!store.focusedTileId)
const focusedTileId = computed(() => store.focusedTileId || '')
const focusedTileCoord = computed(() => store.focusedTileCoord)

// Flat index of the focused tile's grid cell, used to locate its DOM element.
const focusedTileIndex = computed(() => {
  const coord = focusedTileCoord.value
  if (!coord) {
    return -1
  }
  return (coord.y - 1) * store.chart.size.x + (coord.x - 1)
})

// The parent renders in the overlay too (at "0,0"), with its + buttons.
const parentItem = computed(() => {
  const index = focusedTileIndex.value
  if (index < 0) {
    return null
  }
  return store.items[index]?.data ?? null
})

// Layer tiles other than the parent's own cell ("0,0" is never stored).
const layerEntries = computed(() => {
  const layer = store.focusedLayer
  if (!layer) {
    return []
  }
  return Object.entries(layer)
    .filter(([offset]) => offset !== '0,0')
    .map(([offset, item]) => ({ offset, item }))
})

const hostStyle = reactive({ left: 0, top: 0, width: 0, height: 0 })
const positions = reactive<Record<string, { left: number, top: number }>>({})

function parseOffset(offset: string): { x: number, y: number } {
  const [xRaw, yRaw] = offset.split(',')
  const x = Number.parseInt(xRaw)
  const y = Number.parseInt(yRaw)
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return { x: 0, y: 0 }
  }
  return { x, y }
}

function getCellRect(offset: string): { left: number, top: number } {
  const parent = focusedTileCoord.value
  if (!parent) {
    return { left: 0, top: 0 }
  }

  const { x, y } = parseOffset(offset)
  const absX = parent.x + x
  const absY = parent.y + y
  const index = (absY - 1) * store.chart.size.x + (absX - 1)
  const cell = document.querySelector(`.item[data-index="${index}"]`)
  if (!cell) {
    return { left: 0, top: 0 }
  }

  const rect = cell.getBoundingClientRect()
  return { left: rect.left, top: rect.top }
}

// Anchors every layer tile to the exact bounding box of the grid cell beneath
// it, so alignment survives wrapped titles, the chart title, and any gap
// combination. The host is clipped to the chart viewport so tiles never leak
// over other UI when the user scrolls mid-focus.
function updateGeometry() {
  const builder = document.querySelector('.chart-builder') as HTMLElement | null
  const viewport = document.querySelector('.chart-viewport') as HTMLElement | null
  if (!builder) {
    return
  }

  const builderRect = builder.getBoundingClientRect()
  const vpRect = viewport?.getBoundingClientRect() ?? builderRect

  hostStyle.left = vpRect.left - builderRect.left
  hostStyle.top = vpRect.top - builderRect.top
  hostStyle.width = vpRect.width
  hostStyle.height = vpRect.height

  const hostLeft = vpRect.left
  const hostTop = vpRect.top

  const offsets = ['0,0', ...layerEntries.value.map(entry => entry.offset)]
  for (const offset of offsets) {
    const cellRect = getCellRect(offset)
    positions[offset] = {
      left: cellRect.left - hostLeft,
      top: cellRect.top - hostTop,
    }
  }
}

function tileStyle(offset: string, stagger: number): Record<string, string> {
  const pos = positions[offset]
  if (!pos) {
    return { animationDelay: `${stagger * 30}ms` }
  }
  return {
    left: `${pos.left}px`,
    top: `${pos.top}px`,
    animationDelay: `${stagger * 30}ms`,
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && store.focusedTileId && !store.notesPopupVisible) {
    store.exitFocus()
  }
}

watch(
  [
    isFocusMode,
    layerEntries,
    focusedTileCoord,
    () => store.chart.size,
    () => store.chart.gap,
    () => store.chart.title,
    () => store.chart.showTitles,
    () => store.chart.font,
  ],
  updateGeometry,
  { immediate: true },
)

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  window.addEventListener('scroll', updateGeometry, true)
  window.addEventListener('resize', updateGeometry)
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
  window.removeEventListener('scroll', updateGeometry, true)
  window.removeEventListener('resize', updateGeometry)
})
</script>

<template>
  <div
    v-if="isFocusMode"
    class="focus-overlay"
    :style="{
      left: `${hostStyle.left}px`,
      top: `${hostStyle.top}px`,
      width: `${hostStyle.width}px`,
      height: `${hostStyle.height}px`,
    }"
  >
    <!-- Clicking anywhere that isn't a layer tile leaves focus mode. The tiles
    are later siblings, so they paint above this and swallow their own clicks. -->
    <div
      class="focus-backdrop"
      @click="store.exitFocus()"
      @contextmenu.prevent="store.exitFocus()"
    />
    <LayerTile
      v-if="parentItem"
      :item="parentItem"
      offset="0,0"
      :parent-id="focusedTileId"
      is-parent
      :style="tileStyle('0,0', 0)"
    />
    <LayerTile
      v-for="(entry, index) in layerEntries"
      :key="entry.offset"
      :item="entry.item"
      :offset="entry.offset"
      :parent-id="focusedTileId"
      :style="tileStyle(entry.offset, index + 1)"
    />
  </div>
</template>

<style scoped>
.focus-overlay {
  position: absolute;
  z-index: 40;
  overflow: hidden;
  pointer-events: none;
}

/* Tile opacity alone only fades tiles toward the chart's own background, which
   may be light. This wash darkens the whole field behind the layer regardless
   of what the chart background is set to. */
.focus-backdrop {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  background: rgba(0, 0, 0, 0.45);
  animation: focus-backdrop-in 200ms ease;
}

@keyframes focus-backdrop-in {
  from {
    background: rgba(0, 0, 0, 0);
  }
  to {
    background: rgba(0, 0, 0, 0.45);
  }
}
</style>
