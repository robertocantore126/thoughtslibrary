<script setup lang="ts">
import { computed } from 'vue'
import { useStore } from '../../../store'
import Item from './Item.vue'

const props = defineProps(['row'])

const store = useStore()

const rowItems = computed(() => {
  const start = (props.row - 1) * store.chart.size.x
  const end = start + store.chart.size.x
  return store.items.slice(start, end)
})

</script>

<template>
  <div class="item-row" :style="{ gap: `${store.chart.gap}px` }">
    <template
      v-for="item in rowItems" :key="item.originalIndex"
    >
      <Item :item="item.data" :index="item.originalIndex" :title="item.title" :number="item.number" />
    </template>
  </div>
</template>

<style scoped>
.item-row {
  display: flex;
  justify-content: flex-start;
  width: max-content;
}
</style>
