// Functions for dealing with localStorage

import { v4 as uuidv4 } from 'uuid'
import { BackgroundTypes, type OldStoredChart, type StoredChart, type StoredCharts, type StoredPremigrationChart } from '../types'
import { forgetFileHandle } from './fileHandles'

// The last path a chart was saved to, remembered per chart UUID so one
// chart's file can never be silently reused as another chart's save target.
const LAST_CHART_FILE_PATH_KEY_PREFIX = 'lastChartFilePath:'

export function getRememberedChartFilePath(uuid: string): string {
  if (!uuid) {
    return ''
  }

  return localStorage.getItem(`${LAST_CHART_FILE_PATH_KEY_PREFIX}${uuid}`) || ''
}

export function rememberChartFilePath(uuid: string, filePath: string): void {
  if (!uuid || !filePath) {
    return
  }

  localStorage.setItem(`${LAST_CHART_FILE_PATH_KEY_PREFIX}${uuid}`, filePath)
}

export function forgetChartFilePath(uuid: string): void {
  if (!uuid) {
    return
  }

  localStorage.removeItem(`${LAST_CHART_FILE_PATH_KEY_PREFIX}${uuid}`)
}

export function setActiveChart(uuid: string) {
  localStorage.setItem('activeChart', uuid)

  return getActiveChart()
}

export function getActiveChartUuid(): string {
  return localStorage.getItem('activeChart')
}

export function getActiveChart(): StoredChart {
  return getStoredCharts()[getActiveChartUuid()]
}

// Null when there are no charts at all. The unguarded `[0][0]` this replaced
// threw a TypeError on an empty store, which is reachable from the Topsters 2
// import path and from a store that failed to parse.
export function getNewestChartUuid(): string | null {
  const chartEntries = Object.entries(getStoredChartsSnapshot())

  if (chartEntries.length === 0) {
    return null
  }

  return chartEntries.sort((a, b) => (b[1]?.timestamp || 0) - (a[1]?.timestamp || 0))[0][0]
}

export function destroyChart(uuid: string) {
  const charts = getStoredCharts()

  delete charts[uuid]
  setStoredCharts(charts)

  // Don't leave a stale remembered path behind for a deleted chart.
  forgetChartFilePath(uuid)

  // Nor a stale write handle. Re-importing the chart's backup file brings the
  // same uuid back (it is stored inside the file), so a handle left behind here
  // would let a later plain save write straight through to whatever file the
  // deleted chart was last saved to, with no picker and no conflict check.
  void forgetFileHandle(uuid).catch((error) => {
    console.error('Could not forget the file handle for a deleted chart:', error)
  })
}

export function getUuids() {
  return Object.keys(getStoredChartsSnapshot())
}

export function setStoredCharts(charts: StoredCharts): void {
  return localStorage.setItem('charts', JSON.stringify(charts))
}

// Parsing the whole store is the expensive part of reading it, and the raw
// string is cheap to compare. Callers that only read go through the snapshot so
// that re-reading on every store mutation costs a `getItem` rather than a full
// parse of every chart the user owns.
let snapshotRaw: string | null = null
let snapshotValue: StoredCharts = {}

export function getStoredChartsSnapshot(): Readonly<StoredCharts> {
  const raw = localStorage.getItem('charts') || '{}'

  if (raw !== snapshotRaw) {
    snapshotRaw = raw
    snapshotValue = parseStoredCharts(raw)
  }

  return snapshotValue
}

// A value that is not parseable, or that parses to something other than an
// object, must not throw: `getStoredCharts` runs before the app is rendered, and
// a throw there leaves the user staring at a blank page with every chart still
// in storage and no way to reach it. The unreadable value is preserved under a
// separate key so it can be recovered by hand rather than overwritten.
function parseStoredCharts(raw: string): StoredCharts {
  try {
    const parsed = JSON.parse(raw) as unknown

    if (!parsed || typeof parsed !== 'object') {
      throw new TypeError('Stored charts are not an object')
    }

    return parsed as StoredCharts
  }
  catch (error) {
    console.error('Could not read stored charts:', error)

    try {
      if (raw && raw !== '{}' && !localStorage.getItem('unreadableChartsBackup')) {
        localStorage.setItem('unreadableChartsBackup', raw)
      }
    }
    catch (backupError) {
      console.error('Could not preserve the unreadable charts value:', backupError)
    }

    return {}
  }
}

export function getStoredCharts(): StoredCharts {
  return parseStoredCharts(localStorage.getItem('charts') || '{}')
}

export function updateStoredChart(updatedChart: StoredChart, uuid: string) {
  const charts = getStoredCharts()

  charts[uuid] = { ...updatedChart }

  setStoredCharts(charts)
}

export function findByUuid(uuid: string) {
  const charts = getStoredCharts()

  const matching = Object.entries(charts).find(en => en[0] === uuid)

  if (matching) {
    return matching[1]
  }

  return null
}

export function appendChart(newChart: StoredChart, uuid?: string): string {
  const charts = getStoredCharts()

  const newUuid = uuid || uuidv4()

  charts[newUuid] = newChart

  setStoredCharts(charts)

  return newUuid
}

// Migration to change to the new data format for charts.
// See https://github.com/camdendotlol/topstersorg/issues/33
export function newStructureMigration() {
  const charts = getStoredCharts() as unknown as OldStoredChart[]

  // If the `charts` value is an array instead of an object,
  // we know we're on the old data model.
  if (Array.isArray(charts)) {
    // Let's back up this data bc this whole process is kinda scary
    localStorage.setItem('oldChartsBackup', JSON.stringify(charts))

    const newObj: { [uuid: string]: StoredChart } = {}
    let activeUuid = null

    charts.forEach((chart) => {
      if (!chart || !chart.data) {
        return
      }

      const uuid = uuidv4()
      newObj[uuid] = {
        timestamp: chart.timestamp,
        data: chart.data,
      }

      if (chart.currentlyActive) {
        activeUuid = uuid
      }
    })

    setStoredCharts(newObj)

    const firstUuid = Object.keys(newObj)[0]
    if (activeUuid || firstUuid) {
      setActiveChart(activeUuid || firstUuid)
    }
  }
}

export function localStorageMigrations() {
  newStructureMigration()

  const charts = getStoredCharts()

  let changed = false

  Object.keys(charts).forEach((uuid) => {
    const chart = charts[uuid] as StoredPremigrationChart

    // One unmigratable entry must not stop the other charts from being
    // migrated, and must never propagate out of here: this runs before the app
    // is rendered, so a throw leaves the user with a blank page and no way in.
    try {
      // Accumulate: assigning here overwrote every earlier chart's result, so
      // with 2+ charts only the last one's migration was ever persisted.
      changed ||= migrateChart(chart)
    }
    catch (error) {
      console.error(`Could not migrate chart ${uuid}:`, error)
    }
  })

  if (changed) {
    setStoredCharts(charts)
  }
}

// Assigns an id to every item lacking one, so charts saved before ids existed
// are repaired at rest. Returns whether any id was assigned.
function backfillItemIds(chart: StoredPremigrationChart): boolean {
  let changed = false

  const coordinates = chart.data?.coordinates
  if (coordinates) {
    for (const item of Object.values(coordinates)) {
      if (item && !item.id) {
        item.id = uuidv4()
        changed = true
      }
    }
  }

  const relatedLayers = chart.data?.relatedLayers
  if (relatedLayers) {
    for (const layer of Object.values(relatedLayers)) {
      for (const item of Object.values(layer || {})) {
        if (item && !item.id) {
          item.id = uuidv4()
          changed = true
        }
      }
    }
  }

  return changed
}

// Applies migrations to a single chart and returns whether changes were made
export function migrateChart(chart: StoredPremigrationChart) {
  let changed = false

  // An entry with no `data` cannot be migrated and must not be dereferenced.
  // Older builds could write one, and every field below assumed it was there.
  if (!chart || !chart.data || typeof chart.data !== 'object') {
    return false
  }

  if (backfillItemIds(chart)) {
    changed = true
  }

  if (!chart.data.backgroundType) {
    chart.data.backgroundType = chart.data.background?.type || BackgroundTypes.Color

    chart.data.backgroundColor = chart.data.backgroundType === BackgroundTypes.Color
      ? chart.data.background?.value || '#000000'
      : '#000000'

    chart.data.backgroundUrl = chart.data.backgroundType === BackgroundTypes.Image
      ? chart.data.background?.value || ''
      : ''

    changed = true
  }

  if (typeof chart.data.roundCorners === 'undefined') {
    chart.data.roundCorners = false
    changed = true
  }

  return changed
}
