<script setup lang="ts">
import type { CSSProperties } from 'vue'
import { computed } from 'vue'
import { useStore } from '../../../store'
import Item from './Item.vue'

const props = defineProps<{
  rowNumber: number
  indices: number[]
}>()

const store = useStore()

const rowItems = computed(() => {
  return props.indices.map(index => store.items[index])
})

const baseGap = computed(() => store.chart.gap)
const rowGap = computed(() => Math.max(6, baseGap.value / 2))
const rowStyle = computed<CSSProperties>(() => ({
  gap: `${rowGap.value}px`,
  width: 'max-content',
}))
</script>

<template>
  <div class="item-row" :style="rowStyle">
    <template
      v-for="item in rowItems" :key="item.originalIndex"
    >
      <Item
        :item="item.data"
        :index="item.originalIndex"
        :title="item.title"
        :number="item.number"
      />
    </template>
  </div>
</template>

<style scoped>
.item-row {
  display: flex;
  justify-content: flex-start;
  align-items: flex-start;
  width: max-content;
}
</style>
