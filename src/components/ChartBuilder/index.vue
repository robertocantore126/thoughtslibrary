<script setup lang="ts">
import FocusOverlay from './Chart/FocusOverlay.vue'
import Chart from './Chart/index.vue'
import NotesPopup from './NotesPopup.vue'
import TopBar from './TopBar.vue'
</script>

<template>
  <div class="chart-builder">
    <div class="chart-builder-contents">
      <TopBar />
      <Chart />
    </div>
    <NotesPopup />
    <FocusOverlay />
  </div>
</template>

<style scoped>
.chart-builder {
  margin: 0;
  padding: 0;
  height: 100%;
  min-width: 0;
  position: relative;
}

.chart-builder-contents {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media screen and (max-width: 1000px) {
  .chart-builder {
    height: 100%;
    width: 100%;
  }

  .chart-builder-contents {
    position: static;
  }
}
</style>
