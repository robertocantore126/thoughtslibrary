<script setup lang="ts">
import ChartBuilder from './components/ChartBuilder/index.vue'
import LocalStorageWatcher from './components/LocalStorageWatcher.vue'
import Sidebar from './components/Sidebar/index.vue'
import TitlesSidebar from './components/TitlesSidebar.vue'
import './global.css'
</script>

<template>
  <LocalStorageWatcher>
    <div class="main-shell">
      <section class="left-pane">
        <Sidebar />
      </section>
      <section class="center-pane">
        <ChartBuilder />
      </section>
      <section class="right-pane">
        <TitlesSidebar />
      </section>
    </div>
  </LocalStorageWatcher>
</template>

<style>
#app {
  font-family: "Nunito", sans-serif;
  color: var(--text-color);
  overflow: hidden;
  box-sizing: border-box;
  scrollbar-color: var(--accent) black;
  scrollbar-width: thin;
  accent-color: var(--accent);
}

h1, h2, h3, h4 {
  color: var(--accent);
}

body {
  background: #2a2a2a;
  touch-action: manipulation;
}

button {
  font-family: "Nunito", sans-serif;
}

input {
  padding: 8px;
  border: none;
  border-radius: 4px;
  font-family: "Nunito", sans-serif;
  font-size: 14px;
  background-color: var(--input-bg);
  color: black;
}

select {
  border: none;
  font-family: "Nunito", sans-serif;
  font-size: 14px;
  padding: 4px;
  border-radius: 4px;
  color: black;
  accent-color: initial;
  appearance: none;
  background-color: var(--input-bg);
  background-image: url(/caret-down-fill.svg);
  background-repeat: no-repeat;
  background-position-y: center;
  background-position-x: calc(100% - 6px);
  padding-right: 20px;
}

.main-shell {
  height: 100dvh;
  width: 100vw;
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr) 320px;
  overflow: hidden;
}

.left-pane,
.center-pane,
.right-pane {
  min-height: 0;
}

.left-pane {
  border-right: 1px solid rgba(255, 255, 255, 0.1);
  background: #111111;
}

.center-pane {
  background: #000000;
  min-width: 0;
  overflow: hidden;
}

.right-pane {
  min-width: 0;
}

* {
  box-sizing: border-box;
}

@media screen and (max-width: 1200px) {
  .main-shell {
    grid-template-columns: 1fr;
    grid-template-rows: 42dvh 1fr 34dvh;
  }

  .left-pane,
  .right-pane {
    border: none;
  }
}
</style>
