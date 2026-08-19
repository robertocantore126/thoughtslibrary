import { defineStore } from 'pinia'
import { BackgroundTypes, type Chart, type ChartCoordinates, type ChartItem, type ChartSize } from './types'

export interface State {
  chart: Chart
  collapsed: boolean
  activeTileKey: string | null
  notesPopupKey: string | null
  textUndoStack: TextUndoEntry[]
  isApplyingTextUndo: boolean
}

export const MAX_CHART_DIMENSION = 60
export const MAX_CHART_ITEMS = MAX_CHART_DIMENSION * MAX_CHART_DIMENSION
const THOUGHT_ICON_URL = '/thought_tile.svg'
const LEGACY_NOTES_ICON_URL = '/notes_tile.svg'
const DEFAULT_CHART_SIZE: ChartSize = {
  x: 5,
  y: 5,
}

function clampDimension(value: number): number {
  return Math.max(1, Math.min(MAX_CHART_DIMENSION, value))
}

function indexToCoord(index: number, width: number): { x: number, y: number } {
  return {
    x: (index % width) + 1,
    y: Math.floor(index / width) + 1,
  }
}

function coordToIndex(x: number, y: number, width: number): number {
  return (y - 1) * width + (x - 1)
}

function coordKey(x: number, y: number): string {
  return `${x},${y}`
}

function isInBounds(x: number, y: number, size: ChartSize): boolean {
  return x >= 1 && x <= size.x && y >= 1 && y <= size.y
}

function coordinatesFromItems(items: Array<ChartItem | null>, width: number): ChartCoordinates {
  const coordinates: ChartCoordinates = {}

  items.forEach((item, idx) => {
    if (!item)
      return

    const { x, y } = indexToCoord(idx, width)
    coordinates[coordKey(x, y)] = item
  })

  return coordinates
}

function itemsFromCoordinates(coordinates: ChartCoordinates, size: ChartSize): Array<ChartItem | null> {
  const length = size.x * size.y
  const items = Array.from({ length }).fill(null) as Array<ChartItem | null>

  for (const [key, item] of Object.entries(coordinates)) {
    const [xRaw, yRaw] = key.split(',')
    const x = Number.parseInt(xRaw)
    const y = Number.parseInt(yRaw)

    if (!item || Number.isNaN(x) || Number.isNaN(y) || !isInBounds(x, y, size))
      continue

    const idx = coordToIndex(x, y, size.x)
    items[idx] = item
  }

  return items
}

function mergeLegacyNotesIntoCoordinates(coordinates: ChartCoordinates, tileNotes?: Record<string, string>): ChartCoordinates {
  if (!tileNotes) {
    return coordinates
  }

  const merged = { ...coordinates }

  for (const [key, note] of Object.entries(tileNotes)) {
    const existing = merged[key]
    if (!existing) {
      continue
    }

    merged[key] = {
      ...existing,
      notes: note,
    }
  }

  return merged
}

function normalizeChartItem(item: ChartItem): ChartItem {
  if (item.itemType === 'thought') {
    return {
      ...item,
      coverURL: THOUGHT_ICON_URL,
    }
  }

  if (item.coverURL === LEGACY_NOTES_ICON_URL) {
    return {
      ...item,
      itemType: 'thought',
      coverURL: THOUGHT_ICON_URL,
    }
  }

  if (item.coverURL === THOUGHT_ICON_URL && item.attachmentURL && item.itemType !== 'thought') {
    return {
      ...item,
      itemType: 'thought',
    }
  }

  return item
}

function normalizeCoordinates(coordinates: ChartCoordinates): ChartCoordinates {
  const normalized: ChartCoordinates = {}

  for (const [key, item] of Object.entries(coordinates)) {
    normalized[key] = normalizeChartItem(item)
  }

  return normalized
}

export const initialState = {
  chart: createEmptyChart(),
  collapsed: true,
  activeTileKey: null,
  notesPopupKey: null,
  textUndoStack: [],
  isApplyingTextUndo: false,
} as State

export function createEmptyChart(): Chart {
  return {
    title: '',
    coordinates: {},
    items: itemsFromCoordinates({}, DEFAULT_CHART_SIZE),
    size: { ...DEFAULT_CHART_SIZE },
    backgroundUrl: '',
    backgroundColor: '#000000',
    backgroundType: BackgroundTypes.Color,
    showNumbers: false,
    showTitles: true,
    gap: 20,
    font: 'monospace',
    textColor: '#ffffff',
    shadows: true,
    roundCorners: false,
  }
}

interface ItemData {
  data: ChartItem | null
  title?: string
  number?: number
  originalIndex: number
}

type TextField = 'title' | 'creator' | 'notes'

interface TextUndoEntry {
  tileKey: string
  field: TextField
  previousValue: string
}

const buildTitle = (item: ChartItem) => `${[item.creator, item.title].filter(Boolean).join(' - ')}`

export const useStore = defineStore('store', {
  state() {
    return { ...initialState }
  },
  actions: {
    recordTextEdit(payload: { tileKey: string, field: TextField, previousValue: string, nextValue: string }) {
      if (this.isApplyingTextUndo) {
        return
      }

      if (payload.previousValue === payload.nextValue) {
        return
      }

      this.textUndoStack.push({
        tileKey: payload.tileKey,
        field: payload.field,
        previousValue: payload.previousValue,
      })

      if (this.textUndoStack.length > 300) {
        this.textUndoStack = this.textUndoStack.slice(this.textUndoStack.length - 300)
      }
    },
    undoTextEdit() {
      const lastEdit = this.textUndoStack.pop()
      if (!lastEdit) {
        return
      }

      const coordinates = { ...(this.chart.coordinates || {}) }
      const item = coordinates[lastEdit.tileKey]
      if (!item) {
        return
      }

      this.isApplyingTextUndo = true

      if (lastEdit.field === 'title') {
        coordinates[lastEdit.tileKey] = {
          ...item,
          title: lastEdit.previousValue,
        }
      }
      else if (lastEdit.field === 'creator') {
        if (lastEdit.previousValue.trim() === '') {
          const { creator: _creator, ...itemWithoutCreator } = item
          coordinates[lastEdit.tileKey] = itemWithoutCreator
        }
        else {
          coordinates[lastEdit.tileKey] = {
            ...item,
            creator: lastEdit.previousValue,
          }
        }
      }
      else {
        if (lastEdit.previousValue.trim() === '') {
          const { notes: _notes, ...itemWithoutNotes } = item
          coordinates[lastEdit.tileKey] = itemWithoutNotes
        }
        else {
          coordinates[lastEdit.tileKey] = {
            ...item,
            notes: lastEdit.previousValue,
          }
        }
      }

      this.chart = {
        ...this.chart,
        coordinates,
        items: itemsFromCoordinates(coordinates, this.chart.size),
      }
      this.activeTileKey = lastEdit.tileKey
      this.isApplyingTextUndo = false
    },
    syncItemsFromCoordinates() {
      this.chart = {
        ...this.chart,
        items: itemsFromCoordinates(this.chart.coordinates || {}, this.chart.size),
      }
    },
    // For overriding the existing item (e.g. adding to a null slot, or removing an item)
    addItem(payload: { item: ChartItem | null, index: number }) {
      const coords = { ...(this.chart.coordinates || {}) }
      const { x, y } = indexToCoord(payload.index, this.chart.size.x)
      const key = coordKey(x, y)

      if (payload.item) {
        coords[key] = normalizeChartItem(payload.item)
      }
      else {
        delete coords[key]
      }

      this.chart = {
        ...this.chart,
        coordinates: coords,
        items: itemsFromCoordinates(coords, this.chart.size),
      }

      if (!payload.item && this.activeTileKey === key) {
        this.activeTileKey = null
      }
      if (!payload.item && this.notesPopupKey === key) {
        this.notesPopupKey = null
      }
    },
    // For changing the place of a current item
    moveItem(payload: { oldIndex: number, newIndex: number }) {
      const coords = { ...(this.chart.coordinates || {}) }
      const oldCoord = indexToCoord(payload.oldIndex, this.chart.size.x)
      const newCoord = indexToCoord(payload.newIndex, this.chart.size.x)
      const oldKey = coordKey(oldCoord.x, oldCoord.y)
      const newKey = coordKey(newCoord.x, newCoord.y)
      const movingItem = coords[oldKey]
      const existingAtNew = coords[newKey]

      if (!movingItem) {
        return
      }

      if (existingAtNew) {
        coords[oldKey] = existingAtNew
      }
      else {
        delete coords[oldKey]
      }

      coords[newKey] = movingItem

      this.chart = {
        ...this.chart,
        coordinates: coords,
        items: itemsFromCoordinates(coords, this.chart.size),
      }

      if (this.activeTileKey && !coords[this.activeTileKey]) {
        this.activeTileKey = null
      }
    },
    selectTile(payload: { x: number, y: number }) {
      const key = coordKey(payload.x, payload.y)
      const item = this.chart.coordinates?.[key]
      this.activeTileKey = item ? key : null
      this.notesPopupKey = item && item.notes?.trim() ? key : null
    },
    closeNotesPopup() {
      this.notesPopupKey = null
    },
    clearActiveTile() {
      this.activeTileKey = null
      this.notesPopupKey = null
    },
    setActiveTileNote(note: string) {
      if (!this.activeTileKey) {
        return
      }

      const coordinates = { ...(this.chart.coordinates || {}) }
      const activeItem = coordinates[this.activeTileKey]

      if (!activeItem) {
        return
      }

      this.recordTextEdit({
        tileKey: this.activeTileKey,
        field: 'notes',
        previousValue: activeItem.notes || '',
        nextValue: note,
      })

      if (note.trim() === '') {
        const { notes: _notes, ...itemWithoutNotes } = activeItem
        coordinates[this.activeTileKey] = itemWithoutNotes
      }
      else {
        coordinates[this.activeTileKey] = {
          ...activeItem,
          notes: note,
        }
      }

      this.chart = {
        ...this.chart,
        coordinates,
        items: itemsFromCoordinates(coordinates, this.chart.size),
      }
    },
    setActiveTileTitle(title: string) {
      if (!this.activeTileKey) {
        return
      }

      const coordinates = { ...(this.chart.coordinates || {}) }
      const activeItem = coordinates[this.activeTileKey]
      if (!activeItem) {
        return
      }

      this.recordTextEdit({
        tileKey: this.activeTileKey,
        field: 'title',
        previousValue: activeItem.title,
        nextValue: title,
      })

      coordinates[this.activeTileKey] = {
        ...activeItem,
        title,
      }

      this.chart = {
        ...this.chart,
        coordinates,
        items: itemsFromCoordinates(coordinates, this.chart.size),
      }
    },
    setActiveTileCreator(creator: string) {
      if (!this.activeTileKey) {
        return
      }

      const coordinates = { ...(this.chart.coordinates || {}) }
      const activeItem = coordinates[this.activeTileKey]
      if (!activeItem) {
        return
      }

      this.recordTextEdit({
        tileKey: this.activeTileKey,
        field: 'creator',
        previousValue: activeItem.creator || '',
        nextValue: creator,
      })

      if (creator.trim() === '') {
        const { creator: _creator, ...itemWithoutCreator } = activeItem
        coordinates[this.activeTileKey] = itemWithoutCreator
      }
      else {
        coordinates[this.activeTileKey] = {
          ...activeItem,
          creator,
        }
      }

      this.chart = {
        ...this.chart,
        coordinates,
        items: itemsFromCoordinates(coordinates, this.chart.size),
      }
    },
    setActiveTileRating(rating: number | null) {
      if (!this.activeTileKey) {
        return
      }

      const coordinates = { ...(this.chart.coordinates || {}) }
      const activeItem = coordinates[this.activeTileKey]
      if (!activeItem) {
        return
      }

      if (rating === null) {
        const { rating: _rating, ...itemWithoutRating } = activeItem
        coordinates[this.activeTileKey] = itemWithoutRating
      }
      else {
        const normalized = Math.max(1, Math.min(7, Math.round(rating)))
        coordinates[this.activeTileKey] = {
          ...activeItem,
          rating: normalized,
        }
      }

      this.chart = {
        ...this.chart,
        coordinates,
        items: itemsFromCoordinates(coordinates, this.chart.size),
      }
    },
    setActiveTileAttachment(attachmentURL: string) {
      if (!this.activeTileKey) {
        return
      }

      const coordinates = { ...(this.chart.coordinates || {}) }
      const activeItem = coordinates[this.activeTileKey]
      const isThoughtLikeItem = activeItem && (activeItem.itemType === 'thought' || activeItem.coverURL === THOUGHT_ICON_URL)
      if (!isThoughtLikeItem) {
        return
      }

      if (attachmentURL.trim() === '') {
        const { attachmentURL: _attachmentURL, ...itemWithoutAttachment } = activeItem
        coordinates[this.activeTileKey] = itemWithoutAttachment
      }
      else {
        coordinates[this.activeTileKey] = {
          ...activeItem,
          attachmentURL,
        }
      }

      this.chart = {
        ...this.chart,
        coordinates,
        items: itemsFromCoordinates(coordinates, this.chart.size),
      }
    },
    changeTitle(newTitle: string) {
      this.chart = { ...this.chart, title: newTitle }
    },
    setBackgroundColor(hex: string) {
      this.chart = {
        ...this.chart,
        backgroundColor: hex,
      }
    },
    setBackgroundUrl(url: string) {
      this.chart = {
        ...this.chart,
        backgroundUrl: url,
      }
    },
    setBackgroundType(backgroundType: BackgroundTypes) {
      this.chart = {
        ...this.chart,
        backgroundType,
      }
    },
    setHeight(payload: number) {
      const nextHeight = clampDimension(payload)
      const nextSize = { ...this.chart.size, y: nextHeight }

      this.chart = {
        ...this.chart,
        size: nextSize,
        items: itemsFromCoordinates(this.chart.coordinates || {}, nextSize),
      }
    },
    setWidth(payload: number) {
      const nextWidth = clampDimension(payload)
      const nextSize = { ...this.chart.size, x: nextWidth }

      this.chart = {
        ...this.chart,
        size: nextSize,
        items: itemsFromCoordinates(this.chart.coordinates || {}, nextSize),
      }
    },
    changeGap(newGap: number) {
      this.chart = { ...this.chart, gap: newGap }
    },
    changeFont(newFont: string) {
      this.chart = { ...this.chart, font: newFont }
    },
    changeTextColor(newColor: string) {
      this.chart = { ...this.chart, textColor: newColor }
    },
    toggleTitles(newValue: boolean) {
      this.chart = { ...this.chart, showTitles: newValue }
    },
    toggleNumbers(newValue: boolean) {
      this.chart = { ...this.chart, showNumbers: newValue }
    },
    toggleShadows(newValue: boolean) {
      this.chart = { ...this.chart, shadows: newValue }
    },
    toggleRoundedCorners(newValue: boolean) {
      this.chart = { ...this.chart, roundCorners: newValue }
    },
    setEntireChart(payload: Chart) {
      const width = clampDimension(payload.size.x)
      const height = clampDimension(payload.size.y)
      const baseCoordinates = payload.coordinates
        ? { ...payload.coordinates }
        : coordinatesFromItems(payload.items, width)
      const coordinates = normalizeCoordinates(mergeLegacyNotesIntoCoordinates(baseCoordinates, payload.tileNotes))

      this.chart = {
        ...payload,
        size: {
          x: width,
          y: height,
        },
        coordinates,
        items: itemsFromCoordinates(coordinates, { x: width, y: height }),
      }
      this.activeTileKey = null
      this.notesPopupKey = null
      this.textUndoStack = []
      this.isApplyingTextUndo = false
    },
    reset() {
      this.chart = createEmptyChart()
      this.activeTileKey = null
      this.notesPopupKey = null
      this.textUndoStack = []
      this.isApplyingTextUndo = false
    },
    toggleCollapse() {
      this.collapsed = !this.collapsed
    },
  },
  getters: {
    // Get the list of chart items, along with some computed metadata
    // that's generally useful throughout the application.
    items(state): Array<ItemData | null> {
      // For numbered charts, we use this variable to track the number
      // of each non-null item. We can't just use the index because
      // we don't want to count null numbers.
      let counter = 1

      return state.chart.items.map((item, idx) => {
        if (!item) {
          return {
            data: null,
            originalIndex: idx,
          }
        }

        return {
          data: item,
          number: counter++,
          title: buildTitle(item),
          originalIndex: idx,
        }
      })
    },
    activeTile(state): { x: number, y: number, item: ChartItem } | null {
      if (!state.activeTileKey) {
        return null
      }

      const item = state.chart.coordinates?.[state.activeTileKey]
      if (!item) {
        return null
      }

      const [xRaw, yRaw] = state.activeTileKey.split(',')
      const x = Number.parseInt(xRaw)
      const y = Number.parseInt(yRaw)

      if (Number.isNaN(x) || Number.isNaN(y) || !isInBounds(x, y, state.chart.size)) {
        return null
      }

      return { x, y, item }
    },
    activeTileNote(state): string {
      const active = this.activeTile
      if (!active) {
        return ''
      }

      return active.item.notes || ''
    },
    notesPopupNote(state): string {
      if (!state.activeTileKey || state.notesPopupKey !== state.activeTileKey) {
        return ''
      }

      return state.chart.coordinates?.[state.activeTileKey]?.notes?.trim() || ''
    },
    activeTileRating(state): number {
      const active = this.activeTile
      if (!active) {
        return 0
      }

      return Math.max(0, Math.min(7, active.item.rating || 0))
    },
    activeTileAttachment(state): string {
      const active = this.activeTile
      const isThoughtLikeItem = active && (active.item.itemType === 'thought' || active.item.coverURL === THOUGHT_ICON_URL)
      if (!isThoughtLikeItem) {
        return ''
      }

      return active.item.attachmentURL || ''
    },
  },
})
