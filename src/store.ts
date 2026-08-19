import { defineStore } from 'pinia'
import { v4 as uuidv4 } from 'uuid'
import {
  BackgroundTypes,
  type Chart,
  type ChartCoordinates,
  type ChartItem,
  type ChartSize,
  type Direction,
  type RelatedLayer,
  type Selection,
} from './types'

export interface State {
  chart: Chart
  collapsed: boolean
  selection: Selection | null
  notesPopupKey: Selection | null
  focusedTileId: string | null
  // Timestamp of the last successful save to a file. Bumped on every save so a
  // repeated save re-triggers the confirmation, even to the same path.
  lastSavedAt: number | null
  textUndoStack: TextUndoEntry[]
  isApplyingTextUndo: boolean
}

export const MAX_CHART_DIMENSION = 60
// A layer may extend this many cells from its parent in any direction unless
// the chart overrides it. 3 gives a 7x7 field, 48 cells around the parent.
export const DEFAULT_LAYER_REACH = 3
export const MAX_LAYER_REACH = 12

export function clampLayerReach(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_LAYER_REACH
  }
  return Math.max(1, Math.min(MAX_LAYER_REACH, Math.round(value)))
}

export const MAX_CHART_ITEMS = MAX_CHART_DIMENSION * MAX_CHART_DIMENSION
const THOUGHT_ICON_URL = '/thought_tile.svg'
const LEGACY_NOTES_ICON_URL = '/notes_tile.svg'
const DEFAULT_CHART_SIZE: ChartSize = {
  x: 5,
  y: 5,
}

// Canonical direction deltas (see §2 of the brief).
// dx > 0 is right, dy > 0 is down.
const DIRECTION_DELTAS: Record<Direction, { x: number, y: number }> = {
  n: { x: 0, y: -1 },
  ne: { x: 1, y: -1 },
  e: { x: 1, y: 0 },
  se: { x: 1, y: 1 },
  s: { x: 0, y: 1 },
  sw: { x: -1, y: 1 },
  w: { x: -1, y: 0 },
  nw: { x: -1, y: -1 },
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

function offsetKey(x: number, y: number): string {
  return `${x},${y}`
}

function isInBounds(x: number, y: number, size: ChartSize): boolean {
  return x >= 1 && x <= size.x && y >= 1 && y <= size.y
}

function parseOffset(offset: string): { x: number, y: number } {
  const [xRaw, yRaw] = offset.split(',')
  const x = Number.parseInt(xRaw)
  const y = Number.parseInt(yRaw)
  if (Number.isNaN(x) || Number.isNaN(y)) {
    return { x: 0, y: 0 }
  }
  return { x, y }
}

function selectionsEqual(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) {
    return false
  }
  if (a.kind === 'tile' && b.kind === 'tile') {
    return a.key === b.key
  }
  if (a.kind === 'layer' && b.kind === 'layer') {
    return a.parentId === b.parentId && a.offset === b.offset
  }
  return false
}

function findItemCoord(coordinates: ChartCoordinates, id: string): { x: number, y: number } | null {
  for (const [key, item] of Object.entries(coordinates)) {
    if (item?.id === id) {
      const [xRaw, yRaw] = key.split(',')
      const x = Number.parseInt(xRaw)
      const y = Number.parseInt(yRaw)
      if (!Number.isNaN(x) && !Number.isNaN(y)) {
        return { x, y }
      }
    }
  }
  return null
}

// The single resolver: every editor action routes its target through here.
function resolveItemAt(chart: Chart, selection: Selection): ChartItem | null {
  if (selection.kind === 'tile') {
    return chart.coordinates?.[selection.key] || null
  }
  return chart.relatedLayers?.[selection.parentId]?.[selection.offset] || null
}

// A layer is its own coordinate space centred on its parent, bounded only by
// how far it may reach. Nothing about the chart constrains it, so moving the
// parent or resizing the chart can never invalidate a layer.
export function layerReachOf(chart: Chart): number {
  return clampLayerReach(chart.layerReach ?? DEFAULT_LAYER_REACH)
}

function isWithinReach(dx: number, dy: number, reach: number): boolean {
  return Math.abs(dx) <= reach && Math.abs(dy) <= reach
}

// Produces a new chart with the item at `selection` replaced by
// `transform(item)`. A null result removes the item; removing a layer tile's
// last entry deletes the layer itself. `items` is only recomputed for grid
// tiles — layer tiles live outside the grid array.
function applyItemUpdate(chart: Chart, selection: Selection, transform: (item: ChartItem) => ChartItem | null): Chart {
  if (selection.kind === 'tile') {
    const coordinates = { ...(chart.coordinates || {}) }
    const item = coordinates[selection.key]
    if (!item) {
      return chart
    }
    const next = transform(item)
    if (next) {
      coordinates[selection.key] = next
    }
    else {
      delete coordinates[selection.key]
    }
    return {
      ...chart,
      coordinates,
      items: itemsFromCoordinates(coordinates, chart.size),
    }
  }

  const layers = { ...(chart.relatedLayers || {}) }
  const layer = { ...(layers[selection.parentId] || {}) }
  const item = layer[selection.offset]
  if (!item) {
    return chart
  }
  const next = transform(item)
  if (next) {
    layer[selection.offset] = next
  }
  else {
    delete layer[selection.offset]
  }
  if (Object.keys(layer).length === 0) {
    delete layers[selection.parentId]
  }
  else {
    layers[selection.parentId] = layer
  }
  return chartWithLayers(chart, layers)
}

// Keeps `relatedLayers` absent from the chart once it holds nothing.
function chartWithLayers(chart: Chart, layers: Record<string, RelatedLayer>): Chart {
  if (Object.keys(layers).length === 0) {
    const { relatedLayers: _relatedLayers, ...rest } = chart
    return { ...rest }
  }
  return { ...chart, relatedLayers: layers }
}

// First unoccupied in-reach offset for the layer, scanning row-major.
// "0,0" is the parent's own cell and is never stored.
function firstEmptyLayerOffset(chart: Chart, layer: RelatedLayer): string | null {
  const reach = layerReachOf(chart)

  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx === 0 && dy === 0) {
        continue
      }
      const key = offsetKey(dx, dy)
      if (!layer[key]) {
        return key
      }
    }
  }
  return null
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

// Entry point for every item that lands in the store: guarantees an id and
// applies the thought-icon normalizations. A missing id must never reach the
// rest of the app.
function normalizeChartItem(item: ChartItem): ChartItem {
  const withId = item.id ? item : { ...item, id: uuidv4() }

  if (withId.itemType === 'thought') {
    return {
      ...withId,
      coverURL: THOUGHT_ICON_URL,
    }
  }

  if (withId.coverURL === LEGACY_NOTES_ICON_URL) {
    return {
      ...withId,
      itemType: 'thought',
      coverURL: THOUGHT_ICON_URL,
    }
  }

  if (withId.coverURL === THOUGHT_ICON_URL && withId.attachmentURL && withId.itemType !== 'thought') {
    return {
      ...withId,
      itemType: 'thought',
    }
  }

  return withId
}

function normalizeCoordinates(coordinates: ChartCoordinates): ChartCoordinates {
  const normalized: ChartCoordinates = {}

  for (const [key, item] of Object.entries(coordinates)) {
    normalized[key] = normalizeChartItem(item)
  }

  return normalized
}

function normalizeRelatedLayers(relatedLayers?: Record<string, RelatedLayer>): Record<string, RelatedLayer> | undefined {
  if (!relatedLayers) {
    return undefined
  }

  const normalized: Record<string, RelatedLayer> = {}
  for (const [parentId, layer] of Object.entries(relatedLayers)) {
    const normalizedLayer: RelatedLayer = {}
    for (const [offset, item] of Object.entries(layer)) {
      if (!item) {
        continue
      }
      normalizedLayer[offset] = normalizeChartItem(item)
    }
    if (Object.keys(normalizedLayer).length > 0) {
      normalized[parentId] = normalizedLayer
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export const initialState = {
  chart: createEmptyChart(),
  collapsed: true,
  selection: null,
  notesPopupKey: null,
  focusedTileId: null,
  lastSavedAt: null,
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

function createLayerTile(): ChartItem {
  return {
    id: uuidv4(),
    title: '',
    coverURL: '',
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
  selection: Selection
  field: TextField
  previousValue: string
}

const buildTitle = (item: ChartItem) => `${[item.creator, item.title].filter(Boolean).join(' - ')}`

export const useStore = defineStore('store', {
  state() {
    return { ...initialState }
  },
  actions: {
    recordTextEdit(payload: { selection: Selection, field: TextField, previousValue: string, nextValue: string }) {
      if (this.isApplyingTextUndo) {
        return
      }

      if (payload.previousValue === payload.nextValue) {
        return
      }

      this.textUndoStack.push({
        selection: payload.selection,
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

      const item = resolveItemAt(this.chart, lastEdit.selection)
      if (!item) {
        return
      }

      this.isApplyingTextUndo = true

      this.chart = applyItemUpdate(this.chart, lastEdit.selection, (current) => {
        if (lastEdit.field === 'title') {
          return {
            ...current,
            title: lastEdit.previousValue,
          }
        }
        if (lastEdit.field === 'creator') {
          if (lastEdit.previousValue.trim() === '') {
            const { creator: _creator, ...itemWithoutCreator } = current
            return itemWithoutCreator
          }
          return {
            ...current,
            creator: lastEdit.previousValue,
          }
        }
        if (lastEdit.previousValue.trim() === '') {
          const { notes: _notes, ...itemWithoutNotes } = current
          return itemWithoutNotes
        }
        return {
          ...current,
          notes: lastEdit.previousValue,
        }
      })
      this.selection = lastEdit.selection
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
      const previous = coords[key]

      if (payload.item) {
        coords[key] = normalizeChartItem(payload.item)
      }
      else {
        delete coords[key]
      }

      // Removing (or overwriting) a parent removes its whole layer.
      let layers = this.chart.relatedLayers
      if (previous && (!payload.item || previous.id !== coords[key]?.id)) {
        if (layers?.[previous.id]) {
          const { [previous.id]: _removed, ...rest } = layers
          layers = rest
        }
      }

      this.chart = chartWithLayers(this.chart, layers || {})

      if (!payload.item && this.selection?.kind === 'tile' && this.selection.key === key) {
        this.selection = null
        this.notesPopupKey = null
      }
      if (!payload.item && this.selection?.kind === 'layer' && previous && this.selection.parentId === previous.id) {
        this.selection = null
        this.notesPopupKey = null
      }

      this.chart = {
        ...this.chart,
        coordinates: coords,
        items: itemsFromCoordinates(coords, this.chart.size),
      }
    },
    // For changing the place of a current item. A layer travels with its parent
    // and is bounded only by its own reach, so no move can ever strand one.
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

      if (this.selection?.kind === 'tile' && !coords[this.selection.key]) {
        this.selection = null
        this.notesPopupKey = null
      }
    },
    selectTile(payload: { x: number, y: number }) {
      const key = coordKey(payload.x, payload.y)
      const item = this.chart.coordinates?.[key]
      this.selection = item ? { kind: 'tile', key } : null
      this.notesPopupKey = item && item.notes?.trim() ? { kind: 'tile', key } : null
    },
    markChartSaved() {
      this.lastSavedAt = Date.now()
    },
    closeNotesPopup() {
      this.notesPopupKey = null
    },
    openNotesPopup() {
      if (this.selection) {
        this.notesPopupKey = this.selection
      }
    },
    clearActiveTile() {
      this.selection = null
      this.notesPopupKey = null
    },
    setActiveTileNote(note: string) {
      const selection = this.selection
      if (!selection) {
        return
      }

      const activeItem = resolveItemAt(this.chart, selection)
      if (!activeItem) {
        return
      }

      this.recordTextEdit({
        selection,
        field: 'notes',
        previousValue: activeItem.notes || '',
        nextValue: note,
      })

      this.chart = applyItemUpdate(this.chart, selection, (item) => {
        if (note.trim() === '') {
          const { notes: _notes, ...itemWithoutNotes } = item
          return itemWithoutNotes
        }
        return {
          ...item,
          notes: note,
        }
      })
    },
    setActiveTileTitle(title: string) {
      const selection = this.selection
      if (!selection) {
        return
      }

      const activeItem = resolveItemAt(this.chart, selection)
      if (!activeItem) {
        return
      }

      this.recordTextEdit({
        selection,
        field: 'title',
        previousValue: activeItem.title,
        nextValue: title,
      })

      this.chart = applyItemUpdate(this.chart, selection, item => ({
        ...item,
        title,
      }))
    },
    setActiveTileCreator(creator: string) {
      const selection = this.selection
      if (!selection) {
        return
      }

      const activeItem = resolveItemAt(this.chart, selection)
      if (!activeItem) {
        return
      }

      this.recordTextEdit({
        selection,
        field: 'creator',
        previousValue: activeItem.creator || '',
        nextValue: creator,
      })

      this.chart = applyItemUpdate(this.chart, selection, (item) => {
        if (creator.trim() === '') {
          const { creator: _creator, ...itemWithoutCreator } = item
          return itemWithoutCreator
        }
        return {
          ...item,
          creator,
        }
      })
    },
    setActiveTileRating(rating: number | null) {
      const selection = this.selection
      if (!selection) {
        return
      }

      const activeItem = resolveItemAt(this.chart, selection)
      if (!activeItem) {
        return
      }

      this.chart = applyItemUpdate(this.chart, selection, (item) => {
        if (rating === null) {
          const { rating: _rating, ...itemWithoutRating } = item
          return itemWithoutRating
        }
        const normalized = Math.max(1, Math.min(7, Math.round(rating)))
        return {
          ...item,
          rating: normalized,
        }
      })
    },
    setActiveTileAttachment(attachmentURL: string) {
      const selection = this.selection
      if (!selection) {
        return
      }

      const activeItem = resolveItemAt(this.chart, selection)
      const isThoughtLikeItem = activeItem && (activeItem.itemType === 'thought' || activeItem.coverURL === THOUGHT_ICON_URL)
      if (!isThoughtLikeItem) {
        return
      }

      this.chart = applyItemUpdate(this.chart, selection, (item) => {
        if (attachmentURL.trim() === '') {
          const { attachmentURL: _attachmentURL, ...itemWithoutAttachment } = item
          return itemWithoutAttachment
        }
        return {
          ...item,
          attachmentURL,
        }
      })
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
      const nextSize = { ...this.chart.size, y: clampDimension(payload) }

      this.chart = {
        ...this.chart,
        size: nextSize,
        items: itemsFromCoordinates(this.chart.coordinates || {}, nextSize),
      }
    },
    setWidth(payload: number) {
      const nextSize = { ...this.chart.size, x: clampDimension(payload) }

      this.chart = {
        ...this.chart,
        size: nextSize,
        items: itemsFromCoordinates(this.chart.coordinates || {}, nextSize),
      }
    },
    // How far related layers may extend from their parent, in cells.
    setLayerReach(payload: number) {
      this.chart = {
        ...this.chart,
        layerReach: clampLayerReach(payload),
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
      const relatedLayers = normalizeRelatedLayers(payload.relatedLayers)

      this.chart = {
        ...payload,
        size: {
          x: width,
          y: height,
        },
        coordinates,
        items: itemsFromCoordinates(coordinates, { x: width, y: height }),
        ...(relatedLayers ? { relatedLayers } : {}),
      }
      this.selection = null
      this.notesPopupKey = null
      this.focusedTileId = null
      this.textUndoStack = []
      this.isApplyingTextUndo = false
    },
    reset() {
      this.chart = createEmptyChart()
      this.selection = null
      this.notesPopupKey = null
      this.focusedTileId = null
      this.textUndoStack = []
      this.isApplyingTextUndo = false
    },
    toggleCollapse() {
      this.collapsed = !this.collapsed
    },
    // --- Focus mode ---
    toggleFocus(tileId: string) {
      if (this.focusedTileId === tileId) {
        this.exitFocus()
        return
      }
      this.focusedTileId = tileId
    },
    exitFocus() {
      this.focusedTileId = null
      if (this.selection?.kind === 'layer') {
        this.selection = null
        this.notesPopupKey = null
      }
    },
    // --- Layer CRUD ---
    addLayerTile(p: { parentId: string, fromOffset: string, direction: Direction }) {
      const delta = DIRECTION_DELTAS[p.direction]
      if (!delta) {
        return
      }
      const from = parseOffset(p.fromOffset)
      const target = { x: from.x + delta.x, y: from.y + delta.y }
      const targetOffset = offsetKey(target.x, target.y)
      // Bounded by the layer's own reach, not by the chart.
      if (!isWithinReach(target.x, target.y, layerReachOf(this.chart))) {
        return
      }
      const layers = { ...(this.chart.relatedLayers || {}) }
      const layer = { ...(layers[p.parentId] || {}) }
      if (layer[targetOffset]) {
        return
      }
      layer[targetOffset] = createLayerTile()
      layers[p.parentId] = layer
      this.chart = chartWithLayers(this.chart, layers)
    },
    setLayerTileItem(p: { parentId: string, offset: string, item: ChartItem | null }) {
      const layers = { ...(this.chart.relatedLayers || {}) }
      const layer = { ...(layers[p.parentId] || {}) }

      if (p.item) {
        layer[p.offset] = normalizeChartItem(p.item)
        layers[p.parentId] = layer
      }
      else {
        delete layer[p.offset]
        if (Object.keys(layer).length === 0) {
          delete layers[p.parentId]
        }
        else {
          layers[p.parentId] = layer
        }
        if (this.selection?.kind === 'layer' && this.selection.parentId === p.parentId && this.selection.offset === p.offset) {
          this.selection = null
          this.notesPopupKey = null
        }
      }

      this.chart = chartWithLayers(this.chart, layers)
    },
    moveLayerTile(p: { parentId: string, fromOffset: string, toOffset: string }) {
      const layers = { ...(this.chart.relatedLayers || {}) }
      const layer = { ...(layers[p.parentId] || {}) }
      const moving = layer[p.fromOffset]
      if (!moving) {
        return
      }
      const to = parseOffset(p.toOffset)
      if (!isWithinReach(to.x, to.y, layerReachOf(this.chart))) {
        return
      }
      // Dropping onto an occupied cell swaps the two tiles, the same way
      // moveItem does on the main grid. An empty tile created with + is a real
      // layer entry, so refusing occupied targets made those undroppable.
      const displaced = p.toOffset === p.fromOffset ? null : layer[p.toOffset]

      delete layer[p.fromOffset]
      layer[p.toOffset] = moving

      if (displaced) {
        layer[p.fromOffset] = displaced
      }

      layers[p.parentId] = layer
      this.chart = chartWithLayers(this.chart, layers)

      if (this.selection?.kind === 'layer' && this.selection.parentId === p.parentId) {
        if (this.selection.offset === p.fromOffset) {
          this.selection = { kind: 'layer', parentId: p.parentId, offset: p.toOffset }
        }
        else if (displaced && this.selection.offset === p.toOffset) {
          this.selection = { kind: 'layer', parentId: p.parentId, offset: p.fromOffset }
        }
      }
    },
    selectLayerTile(p: { parentId: string, offset: string }) {
      const item = this.chart.relatedLayers?.[p.parentId]?.[p.offset]
      this.selection = item ? { kind: 'layer', parentId: p.parentId, offset: p.offset } : null
      this.notesPopupKey = item && item.notes?.trim() ? { kind: 'layer', parentId: p.parentId, offset: p.offset } : null
    },
    // Fills the focused layer's first empty in-reach cell when focus mode is
    // on, otherwise the main grid's first empty cell.
    addItemToActiveTarget(item: ChartItem) {
      const normalized = normalizeChartItem(item)

      if (this.focusedTileId) {
        const layers = { ...(this.chart.relatedLayers || {}) }
        const layer = { ...(layers[this.focusedTileId] || {}) }
        const target = firstEmptyLayerOffset(this.chart, layer)
        if (!target) {
          return
        }
        layer[target] = normalized
        layers[this.focusedTileId] = layer
        this.chart = chartWithLayers(this.chart, layers)
        return
      }

      const firstEmptyIndex = this.chart.items.indexOf(null)
      if (firstEmptyIndex !== -1) {
        this.addItem({ item: normalized, index: firstEmptyIndex })
      }
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
    // KEPT for Item.vue: "x,y" when the selection is a grid tile, else null.
    activeTileKey(state): string | null {
      return state.selection?.kind === 'tile' ? state.selection.key : null
    },
    activeTile(state): { x: number, y: number, item: ChartItem } | null {
      const selection = state.selection
      if (!selection) {
        return null
      }

      const item = resolveItemAt(state.chart, selection)
      if (!item) {
        return null
      }

      if (selection.kind === 'tile') {
        const [xRaw, yRaw] = selection.key.split(',')
        const x = Number.parseInt(xRaw)
        const y = Number.parseInt(yRaw)

        if (Number.isNaN(x) || Number.isNaN(y) || !isInBounds(x, y, state.chart.size)) {
          return null
        }

        return { x, y, item }
      }

      // Layer tiles report their absolute position (parent + offset), which is
      // always in bounds by construction.
      const parentCoord = findItemCoord(state.chart.coordinates || {}, selection.parentId)
      if (!parentCoord) {
        return null
      }
      const delta = parseOffset(selection.offset)
      const x = parentCoord.x + delta.x
      const y = parentCoord.y + delta.y

      if (!isInBounds(x, y, state.chart.size)) {
        return null
      }

      return { x, y, item }
    },
    activeTileNote(_state): string {
      const active = this.activeTile
      if (!active) {
        return ''
      }

      return active.item.notes || ''
    },
    notesPopupNote(state): string {
      if (!state.selection || !state.notesPopupKey || !selectionsEqual(state.notesPopupKey, state.selection)) {
        return ''
      }

      return resolveItemAt(state.chart, state.selection)?.notes?.trim() || ''
    },
    notesPopupVisible(state): boolean {
      return !!state.selection && !!state.notesPopupKey && selectionsEqual(state.notesPopupKey, state.selection)
    },
    activeTileRating(_state): number {
      const active = this.activeTile
      if (!active) {
        return 0
      }

      return Math.max(0, Math.min(7, active.item.rating || 0))
    },
    activeTileAttachment(_state): string {
      const active = this.activeTile
      const isThoughtLikeItem = active && (active.item.itemType === 'thought' || active.item.coverURL === THOUGHT_ICON_URL)
      if (!isThoughtLikeItem) {
        return ''
      }

      return active.item.attachmentURL || ''
    },
    focusedLayer(state): RelatedLayer | null {
      if (!state.focusedTileId) {
        return null
      }
      return state.chart.relatedLayers?.[state.focusedTileId] || null
    },
    focusedTileCoord(state): { x: number, y: number } | null {
      if (!state.focusedTileId) {
        return null
      }
      return findItemCoord(state.chart.coordinates || {}, state.focusedTileId)
    },
    tileHasLayer(state) {
      return (tileId: string): boolean => {
        const layer = state.chart.relatedLayers?.[tileId]
        return !!layer && Object.keys(layer).length > 0
      }
    },
    layerTileCount(state) {
      return (tileId: string): number => Object.keys(state.chart.relatedLayers?.[tileId] || {}).length
    },
  },
})
