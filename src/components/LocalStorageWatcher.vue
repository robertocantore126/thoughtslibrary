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
import { detectOtherWindows, reportPersistFailure, reportPersistSuccess } from '../helpers/persistStatus'
import { useStore } from '../store'

const store = useStore()
let hasWarnedStorageQuota = false
// Set when the startup pass could not finish. The gate still opens - the app
// with an unreadable chart is worth more than a blank page - but the failure is
// shown rather than swallowed.
const loadError = ref<string | null>(null)
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
    else if (uuid) {
      // The chart this write belongs to no longer has an entry, which means it
      // was deleted while the write was still pending. Creating it again would
      // resurrect the deleted chart under a fresh uuid AND make it active, so
      // the next mutation wrote the chart the user had switched to into the
      // resurrection - two entries, both holding the wrong data, and the
      // deleted chart back in the switcher. A write with nowhere to go is
      // dropped: the user deleted it.
      return
    }
    else {
      // No active chart at all. This is the bootstrap case and the only one
      // that may create an entry.
      const newUuid = appendChart({
        timestamp: new Date().getTime(),
        data: chart,
      })

      setActiveChart(newUuid)
    }

    // A write got through, so whatever was wrong before is not wrong now. The
    // quota warning re-arms with it: a failure that alerts only once, ever,
    // leaves the user editing an app that silently stopped saving.
    hasWarnedStorageQuota = false
    reportPersistSuccess()
  }
  catch (error) {
    if (isStorageQuotaExceeded(error)) {
      reportPersistFailure('Out of local storage space - your changes are NOT being saved. Save the chart to a file, then remove some local images.')

      if (!hasWarnedStorageQuota) {
        hasWarnedStorageQuota = true
        // eslint-disable-next-line no-alert
        alert('This chart is too large to save locally. Try a smaller image or fewer local images.')
      }
      return
    }

    reportPersistFailure('Your changes are NOT being saved. Save the chart to a file to avoid losing them.')
    console.error(error)
  }
}

// Everything the startup pass does before the app is allowed to render. Every
// step of it is individually recoverable: the caller opens the gate whatever
// happens here, because a throw on this path used to leave `loaded` false
// forever - a blank page, on every launch, with every chart still in storage
// and no way to reach it.
async function loadStoredCharts() {
  localStorageMigrations()

  const storedCharts = getStoredCharts()
  const normalizedEntries = await Promise.all(
    Object.entries(storedCharts).map(async ([uuid, chart]) => {
      // Per entry, so one unreadable chart cannot stop every other chart from
      // being normalized. The bad entry is passed through exactly as stored
      // rather than dropped or repaired - it is the user's data, and the point
      // of surviving this is to leave it recoverable.
      try {
        return [uuid, {
          ...chart,
          data: await persistChartAssets(chart.data),
        }] as const
      }
      catch (error) {
        console.error(`Could not normalize chart ${uuid}:`, error)
        return [uuid, chart] as const
      }
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
  //
  // The root set is only the charts THIS window can see. Another window has
  // charts of its own in flight, and blobs it has just written whose chart
  // write has not landed yet, so from here they are indistinguishable from
  // orphans - and deleting one destroys an image with no copy anywhere. When
  // anyone else is open, the sweep waits for a launch that is alone.
  try {
    if (await detectOtherWindows()) {
      console.warn('Another window is open; skipping the unused-image sweep.')
    }
    else {
      const referenced = new Set<string>()
      for (const [, chart] of normalizedEntries) {
        collectChartAssetIds(chart.data, referenced)
      }
      // An entry that could not be read contributes no references, and a sweep
      // that cannot see a chart's references would delete its images. Better to
      // reclaim nothing this run than to collect against an incomplete root set.
      if (normalizedEntries.some(([, chart]) => !chart?.data)) {
        throw new Error('A chart could not be read; skipping the sweep rather than collecting against an incomplete root set')
      }
      await collectUnusedAssets(referenced)
    }
  }
  catch (error) {
    console.error('Could not reclaim unused images:', error)
  }
}

onMounted(async () => {
  try {
    await loadStoredCharts()
  }
  catch (error) {
    console.error('Could not load stored charts:', error)
    loadError.value = 'Some of your saved data could not be read. Save a copy to a file before making changes.'
  }

  // Flip the gate before setEntireChart so the app mounts holding the real
  // chart, never a blank one. The store mutation below happens after this
  // flag is set, so the subscribe handler treats it as a normal edit.
  //
  // This must happen no matter what went wrong above. The chart the user is
  // looking for is almost always still readable even when the pass that
  // normalizes it is not.
  loaded.value = true

  try {
    const activeChart = getActiveChart()

    if (activeChart?.data) {
      store.setEntireChart(activeChart.data)
    }
    else {
      initializeFirstRun()
      store.setEntireChart(getActiveChart().data)
    }
  }
  catch (error) {
    console.error('Could not open the active chart:', error)
    loadError.value = 'The last chart you had open could not be read. It is still in storage; do not delete it.'
    store.reset()
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
  <div v-if="loadError" class="load-error" role="alert">
    {{ loadError }}
  </div>
  <slot v-if="loaded" />
</template>

<style scoped>
.load-error {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  padding: 8px 16px;
  background: #7a1f1f;
  color: #ffffff;
  font-size: 13px;
  text-align: center;
}
</style>
