<script setup lang="ts">
import type { Chart } from '../types'
import { onMounted, ref } from 'vue'
import { collectChartAssetIds, collectUnusedAssets, persistChartAssets } from '../helpers/assets'
import { initializeFirstRun } from '../helpers/chart'
import { adoptChartCovers, collectAdoptableAssets } from '../helpers/coverAdoption'
import {
  appendChart,
  findByUuid,
  getActiveChart,
  getActiveChartUuid,
  getStoredCharts,
  localStorageMigrations,
  setActiveChart,
  setStoredCharts,
  updateStoredChart,
} from '../helpers/localStorage'
import { useStore } from '../store'

const store = useStore()
let hasWarnedStorageQuota = false
let saveTimer: ReturnType<typeof setTimeout> | null = null
// The startup load runs an async chain (asset persistence, the unused-blob
// sweep). The app itself is not rendered until it finishes: before the store
// holds a real chart, an edit could only ever land on the blank default, and
// the resulting debounced write would overwrite the saved chart with it. The
// slot gate below makes that whole class of race impossible.
const loaded = ref(false)
// A pending write is bound to the uuid it belongs to. Without that pairing,
// switching charts inside the debounce window cancelled the first chart's write
// and flushed the second chart's data in its place, losing the edit.
let pendingUuid: string | null = null
let pendingChart: Chart | null = null

function isStorageQuotaExceeded(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false
  }

  return error.name === 'QuotaExceededError' || error.code === 22
}

// Commits whatever write is pending to the chart it was scheduled for, and
// clears the timer. Safe to call at any time, including when nothing is pending.
function flushPendingChartWrite() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }

  const uuid = pendingUuid
  const chart = pendingChart
  pendingUuid = null
  pendingChart = null

  if (uuid && chart) {
    persistChart(uuid, chart)
  }
}

function persistChart(uuid: string, chart: Chart) {
  try {
    const storedChart = uuid ? findByUuid(uuid) : null

    if (storedChart) {
      updateStoredChart({ ...storedChart, data: chart }, uuid)
    }
    else {
      const newUuid = appendChart({
        timestamp: new Date().getTime(),
        data: chart,
      })

      setActiveChart(newUuid)
    }
  }
  catch (error) {
    if (isStorageQuotaExceeded(error)) {
      if (!hasWarnedStorageQuota) {
        hasWarnedStorageQuota = true
        // eslint-disable-next-line no-alert
        alert('This chart is too large to save locally. Try a smaller image or fewer local images.')
      }
      return
    }

    console.error(error)
  }
}

onMounted(async () => {
  localStorageMigrations()

  const storedCharts = getStoredCharts()
  const normalizedEntries = await Promise.all(
    Object.entries(storedCharts).map(async ([uuid, chart]) => {
      return [uuid, {
        ...chart,
        data: await persistChartAssets(chart.data),
      }] as const
    }),
  )

  try {
    setStoredCharts(Object.fromEntries(normalizedEntries))
  }
  catch (error) {
    // A quota or serialization failure here used to abort the whole load,
    // leaving the user on a silent empty chart with no error at all.
    console.error('Could not persist startup charts:', error)
  }

  // Reclaim image blobs no chart points at any more. Deleting a tile or a
  // chart only ever dropped the reference, so without this sweep the blobs
  // stayed in IndexedDB forever and storage could only ever grow.
  try {
    const referenced = new Set<string>()
    for (const [, chart] of normalizedEntries) {
      collectChartAssetIds(chart.data, referenced)
    }
    await collectUnusedAssets(referenced)
  }
  catch (error) {
    console.error('Could not reclaim unused images:', error)
  }

  // Flip the gate before setEntireChart so the app mounts holding the real
  // chart, never a blank one. The store mutation below happens after this
  // flag is set, so the subscribe handler treats it as a normal edit.
  loaded.value = true

  const activeChart = getActiveChart()

  if (activeChart) {
    store.setEntireChart(activeChart.data)
  }
  else {
    initializeFirstRun()
    store.setEntireChart(getActiveChart().data)
  }

  scheduleCoverAdoption()
})

// Copies remote covers into the local asset store in the background, so a
// chart stops depending on the servers it imported them from. Started only
// after the gate above, and never awaited: an unadopted cover still displays
// from its remote URL, so nothing the user sees waits on this.
let adoptionRunning = false
let adoptionTimer: ReturnType<typeof setTimeout> | null = null
let adoptionChartUuid: string | null = null

async function runCoverAdoption() {
  if (adoptionRunning) {
    return
  }

  const assets = collectAdoptableAssets(store.chart)
  if (assets.length === 0) {
    return
  }

  adoptionRunning = true
  adoptionChartUuid = getActiveChartUuid()

  try {
    await adoptChartCovers(
      assets,
      (asset, localUrl) => store.replaceItemAsset({ itemId: asset.itemId, field: asset.field, url: localUrl }),
      // Abandon the run the moment the user switches charts, rather than
      // writing covers resolved for one chart into whichever is open now.
      () => getActiveChartUuid() !== adoptionChartUuid,
    )
  }
  catch (error) {
    console.error('Could not copy remote covers locally:', error)
  }
  finally {
    adoptionRunning = false
  }
}

// Debounced, because every adopted cover is itself a store mutation. Waiting
// for the chart to settle keeps a finished run from immediately re-triggering
// itself, and picks up covers from a newly added item or a fresh import in the
// same pass.
function scheduleCoverAdoption() {
  if (adoptionTimer) {
    clearTimeout(adoptionTimer)
  }
  adoptionTimer = setTimeout(runCoverAdoption, 2000)
}

// Persist the whole chart, but only after the edit burst settles — a note
// keystroke otherwise stringifies the chart on every character. Flush any
// pending state on unload so the last edit is never lost on close.
store.$subscribe((_mutation, state) => {
  const uuid = getActiveChartUuid()

  // The active chart changed while a write was still pending: commit it to the
  // chart it actually belongs to before this one takes its place.
  if (pendingUuid && pendingUuid !== uuid) {
    flushPendingChartWrite()
  }

  pendingUuid = uuid
  // The store replaces `chart` wholesale on every mutation, so this reference is
  // a genuine snapshot rather than a view that will drift.
  pendingChart = state.chart

  if (saveTimer) {
    clearTimeout(saveTimer)
  }

  saveTimer = setTimeout(flushPendingChartWrite, 300)
  // Newly imported items arrive through here too, so their covers get adopted
  // in the same pass rather than waiting for the next launch.
  scheduleCoverAdoption()
  // flush: 'sync' so every mutation is observed as it happens. Pinia's default
  // ('pre') batches to the render cycle, which collapses "edit chart A" and
  // "switch to chart B" into a single notification carrying only B's state -
  // the edit to A would never be seen, let alone written. The 300ms debounce
  // above still keeps the actual writes rare.
}, { flush: 'sync' })

window.addEventListener('beforeunload', flushPendingChartWrite)
</script>

<template>
  <slot v-if="loaded" />
</template>
