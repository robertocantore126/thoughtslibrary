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
  type TileLink,
} from './types'

export interface State {
  chart: Chart
  collapsed: boolean
  selection: Selection | null
  notesPopupKey: Selection | null
  focusedTileId: string | null
  resizeBlockMessage: string | null
  // Timestamp of the last successful save to a file. Bumped on every save so a
  // repeated save re-triggers the confirmation, even to the same path.
  lastSavedAt: number | null
  textUndoStack: TextUndoEntry[]
  isApplyingTextUndo: boolean
  // False until a real chart has been loaded into the store. The app renders
  // nothing until then, but window-level handlers registered outside that gate
  // — the Ctrl+S hotkey — still fire while `chart` is the blank default, and
  // must never write that blank over the chart the user actually has.
  chartLoaded: boolean
}

export const MAX_CHART_DIMENSION = 60
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

// The current Selection for an item — its grid cell or its layer cell — or
// null if the item no longer exists anywhere in the chart. Undo entries are
// keyed by item id so a move between the edit and the undo can't redirect the
// restore onto a different tile.
function findSelectionForItem(chart: Chart, id: string): Selection | null {
  const coord = findItemCoord(chart.coordinates || {}, id)
  if (coord) {
    return { kind: 'tile', key: coordKey(coord.x, coord.y) }
  }

  for (const [parentId, layer] of Object.entries(chart.relatedLayers || {})) {
    for (const [offset, item] of Object.entries(layer)) {
      if (item?.id === id) {
        return { kind: 'layer', parentId, offset }
      }
    }
  }

  return null
}

// True if any tile in the layer would fall outside `size` when the layer's
// parent sits at `coord`.
function layerLeavesBounds(layer: RelatedLayer, coord: { x: number, y: number }, size: ChartSize): boolean {
  for (const offset of Object.keys(layer)) {
    const delta = parseOffset(offset)
    if (!isInBounds(coord.x + delta.x, coord.y + delta.y, size)) {
      return true
    }
  }
  return false
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

// Same idea for `links`: an empty array is dropped rather than stored, so a
// chart that has never used arrows serializes exactly as it did before.
function chartWithLinks(chart: Chart, links: TileLink[]): Chart {
  if (links.length === 0) {
    const { links: _links, ...rest } = chart
    return { ...rest }
  }
  return { ...chart, links }
}

export function findItemById(chart: Chart, id: string): ChartItem | null {
  for (const item of Object.values(chart.coordinates || {})) {
    if (item.id === id) {
      return item
    }
  }
  for (const layer of Object.values(chart.relatedLayers || {})) {
    for (const item of Object.values(layer)) {
      if (item.id === id) {
        return item
      }
    }
  }
  return null
}

// Which context a tile belongs to: the grid, or one specific related layer.
// A link is only legal between two ids that answer the same thing here.
function linkContextOf(chart: Chart, id: string): string | null {
  if (findItemCoord(chart.coordinates || {}, id)) {
    return 'grid'
  }

  for (const [parentId, layer] of Object.entries(chart.relatedLayers || {})) {
    for (const item of Object.values(layer)) {
      if (item.id === id) {
        return `layer:${parentId}`
      }
    }
  }

  return null
}

// Drops links whose ends no longer exist. Re-checking the whole list after a
// structural change is what makes this safe: deleting a tile, overwriting one,
// or removing a parent (which takes its entire layer with it) all funnel
// through here, so no removal path can leave an arrow pointing at nothing.
function pruneDanglingLinks(chart: Chart): Chart {
  const links = chart.links
  if (!links || links.length === 0) {
    return chart
  }

  const live = new Set<string>()
  Object.values(chart.coordinates || {}).forEach(item => live.add(item.id))
  Object.values(chart.relatedLayers || {}).forEach((layer) => {
    Object.values(layer).forEach(item => live.add(item.id))
  })

  const kept = links.filter(link => live.has(link.from) && live.has(link.to))
  return kept.length === links.length ? chart : chartWithLinks(chart, kept)
}

// Smallest dimension at which every layer tile still fits, per axis.
function minDimensionForLayers(chart: Chart, axis: 'x' | 'y'): number {
  const coordinates = chart.coordinates || {}
  const layers = chart.relatedLayers
  if (!layers || Object.keys(layers).length === 0) {
    return 1
  }
  let min = 1
  for (const [parentId, layer] of Object.entries(layers)) {
    const parentCoord = findItemCoord(coordinates, parentId)
    if (!parentCoord) {
      continue
    }
    // The parent's own cell counts too: clamping only on the layer tiles
    // would let a shrink clip the parent out of the grid while its layer
    // survives, leaving the layer uneditable.
    min = Math.max(min, axis === 'x' ? parentCoord.x : parentCoord.y)
    for (const offset of Object.keys(layer)) {
      const delta = parseOffset(offset)
      const absolute = axis === 'x' ? parentCoord.x + delta.x : parentCoord.y + delta.y
      min = Math.max(min, absolute)
    }
  }
  return Math.min(min, MAX_CHART_DIMENSION)
}

// Titles of the parents whose layers pin the given minimum dimension.
function blockingParentTitles(chart: Chart, axis: 'x' | 'y', minDimension: number): string[] {
  const coordinates = chart.coordinates || {}
  const layers = chart.relatedLayers
  if (!layers) {
    return []
  }
  const titles: string[] = []
  for (const [parentId, layer] of Object.entries(layers)) {
    const parentCoord = findItemCoord(coordinates, parentId)
    if (!parentCoord) {
      continue
    }
    // The parent's own coordinate pins the minimum when its layer lies toward
    // the origin, so it counts as a blocker in that case too.
    let maxAbsolute = axis === 'x' ? parentCoord.x : parentCoord.y
    for (const offset of Object.keys(layer)) {
      const delta = parseOffset(offset)
      const absolute = axis === 'x' ? parentCoord.x + delta.x : parentCoord.y + delta.y
      maxAbsolute = Math.max(maxAbsolute, absolute)
    }
    if (maxAbsolute >= minDimension) {
      const parentItem = coordinates[coordKey(parentCoord.x, parentCoord.y)]
      titles.push(parentItem?.title?.trim() || 'A tile')
    }
  }
  return [...new Set(titles)]
}

// First unoccupied in-bounds offset for the layer, scanning row-major.
// "0,0" is the parent's own cell and is never stored.
function firstEmptyLayerOffset(chart: Chart, parentCoord: { x: number, y: number }, layer: RelatedLayer): string | null {
  const minDx = -(parentCoord.x - 1)
  const maxDx = chart.size.x - parentCoord.x
  const minDy = -(parentCoord.y - 1)
  const maxDy = chart.size.y - parentCoord.y

  for (let dy = minDy; dy <= maxDy; dy++) {
    for (let dx = minDx; dx <= maxDx; dx++) {
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

// Repairs stored layers on load. A layer is only kept when its parent still
// exists in the grid, and only in-bounds entries survive — plus "0,0", the
// parent's own cell, which is never a legitimate layer entry (a past bug
// could create one by dropping onto the focused parent). Anything dropped
// here is unreachable from the UI and would otherwise pin its images forever.
function normalizeRelatedLayers(
  relatedLayers: Record<string, RelatedLayer> | undefined,
  coordinates: ChartCoordinates,
  size: ChartSize,
): Record<string, RelatedLayer> | undefined {
  if (!relatedLayers) {
    return undefined
  }

  const normalized: Record<string, RelatedLayer> = {}
  for (const [parentId, layer] of Object.entries(relatedLayers)) {
    const parentCoord = findItemCoord(coordinates, parentId)
    if (!parentCoord) {
      continue
    }

    const normalizedLayer: RelatedLayer = {}
    for (const [offset, item] of Object.entries(layer)) {
      if (!item || offset === '0,0') {
        continue
      }
      const delta = parseOffset(offset)
      if (!isInBounds(parentCoord.x + delta.x, parentCoord.y + delta.y, size)) {
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
  resizeBlockMessage: null,
  lastSavedAt: null,
  textUndoStack: [],
  isApplyingTextUndo: false,
  chartLoaded: false,
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
  // The edited item's id, so undo resolves by identity rather than position:
  // a move between the edit and the undo would otherwise restore the value
  // onto whatever tile now occupies the recorded cell.
  itemId: string
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

      const item = resolveItemAt(this.chart, payload.selection)
      if (!item) {
        return
      }

      this.textUndoStack.push({
        selection: payload.selection,
        itemId: item.id,
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

      // Resolve by the item's id so the undo lands on the tile that was
      // actually edited, wherever a move has taken it since. An entry whose
      // item no longer exists is dropped rather than applied to a stranger.
      const selection = findSelectionForItem(this.chart, lastEdit.itemId)
      if (!selection) {
        return
      }

      this.isApplyingTextUndo = true

      this.chart = applyItemUpdate(this.chart, selection, (current) => {
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
      this.selection = selection
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

      this.chart = pruneDanglingLinks({
        ...this.chart,
        coordinates: coords,
        items: itemsFromCoordinates(coords, this.chart.size),
      })
    },
    // Draws an arrow from one tile to another. Both ends must sit in the same
    // context — two grid tiles, or two tiles of one related layer — so an
    // arrow can never span the grid and a layer, where the two are never on
    // screen in the same geometry and no line could be drawn between them.
    addTileLink(p: { from: string, to: string }) {
      if (p.from === p.to) {
        return
      }

      const fromContext = linkContextOf(this.chart, p.from)
      if (!fromContext || fromContext !== linkContextOf(this.chart, p.to)) {
        return
      }

      const links = this.chart.links || []
      // A second arrow the same way round is the same arrow. The reverse
      // direction is a different statement, so B->A alongside A->B is kept.
      if (links.some(link => link.from === p.from && link.to === p.to)) {
        return
      }

      this.chart = chartWithLinks(this.chart, [...links, { from: p.from, to: p.to }])
    },
    removeTileLink(p: { from: string, to: string }) {
      const links = this.chart.links
      if (!links) {
        return
      }

      const kept = links.filter(link => !(link.from === p.from && link.to === p.to))
      if (kept.length === links.length) {
        return
      }

      this.chart = chartWithLinks(this.chart, kept)
    },
    // For changing the place of a current item
    moveItem(payload: { oldIndex: number, newIndex: number }) {
      if (!this.canMoveTile(payload.oldIndex, payload.newIndex)) {
        return
      }

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

      // The selection follows the moved tile, and a swap moves the displaced
      // tile into the old cell — the same rule moveLayerTile uses, so a drag
      // never leaves the sidebar editing a tile the user didn't touch.
      if (this.selection?.kind === 'tile') {
        if (this.selection.key === oldKey) {
          this.selection = { kind: 'tile', key: newKey }
        }
        else if (existingAtNew && this.selection.key === newKey) {
          this.selection = { kind: 'tile', key: oldKey }
        }
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
      const requestedHeight = clampDimension(payload)
      const minHeight = minDimensionForLayers(this.chart, 'y')
      const blockingTitles = blockingParentTitles(this.chart, 'y', minHeight)
      const nextHeight = Math.max(requestedHeight, minHeight)
      const nextSize = { ...this.chart.size, y: nextHeight }

      this.chart = {
        ...this.chart,
        size: nextSize,
        items: itemsFromCoordinates(this.chart.coordinates || {}, nextSize),
      }

      // The clamp above keeps layer parents in bounds, but a corrupt or
      // imported chart can already have the focused parent off the grid.
      // Drop focus rather than let the overlay anchor to a missing cell.
      const focusedCoord = this.focusedTileId ? findItemCoord(this.chart.coordinates || {}, this.focusedTileId) : null
      if (focusedCoord && !isInBounds(focusedCoord.x, focusedCoord.y, nextSize)) {
        this.focusedTileId = null
        if (this.selection?.kind === 'layer') {
          this.selection = null
          this.notesPopupKey = null
        }
      }

      if (nextHeight !== requestedHeight) {
        const first = blockingTitles[0] || 'A tile'
        const others = blockingTitles.length - 1
        this.resizeBlockMessage = others > 0
          ? `Can't shrink further — ${first} and ${others} others have related tiles in this row`
          : `Can't shrink further — ${first} has related tiles in this row`
      }
      else {
        this.resizeBlockMessage = null
      }
    },
    setWidth(payload: number) {
      const requestedWidth = clampDimension(payload)
      const minWidth = minDimensionForLayers(this.chart, 'x')
      const blockingTitles = blockingParentTitles(this.chart, 'x', minWidth)
      const nextWidth = Math.max(requestedWidth, minWidth)
      const nextSize = { ...this.chart.size, x: nextWidth }

      this.chart = {
        ...this.chart,
        size: nextSize,
        items: itemsFromCoordinates(this.chart.coordinates || {}, nextSize),
      }

      // The clamp above keeps layer parents in bounds, but a corrupt or
      // imported chart can already have the focused parent off the grid.
      // Drop focus rather than let the overlay anchor to a missing cell.
      const focusedCoord = this.focusedTileId ? findItemCoord(this.chart.coordinates || {}, this.focusedTileId) : null
      if (focusedCoord && !isInBounds(focusedCoord.x, focusedCoord.y, nextSize)) {
        this.focusedTileId = null
        if (this.selection?.kind === 'layer') {
          this.selection = null
          this.notesPopupKey = null
        }
      }

      if (nextWidth !== requestedWidth) {
        const first = blockingTitles[0] || 'A tile'
        const others = blockingTitles.length - 1
        this.resizeBlockMessage = others > 0
          ? `Can't shrink further — ${first} and ${others} others have related tiles in this column`
          : `Can't shrink further — ${first} has related tiles in this column`
      }
      else {
        this.resizeBlockMessage = null
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
      // Charts arrive from imported files and from storage that an older or
      // broken build may have written, so nothing here can be assumed present.
      // A missing size used to throw, and since the caller had already persisted
      // and activated the chart, the same throw repeated on every startup and
      // left the app unable to load at all.
      const width = clampDimension(Number(payload?.size?.x) || DEFAULT_CHART_SIZE.x)
      const height = clampDimension(Number(payload?.size?.y) || DEFAULT_CHART_SIZE.y)
      const payloadItems = Array.isArray(payload?.items) ? payload.items : []
      const baseCoordinates = payload?.coordinates
        ? { ...payload.coordinates }
        : coordinatesFromItems(payloadItems, width)
      const coordinates = normalizeCoordinates(mergeLegacyNotesIntoCoordinates(baseCoordinates, payload.tileNotes))
      const relatedLayers = normalizeRelatedLayers(payload.relatedLayers, coordinates, { x: width, y: height })

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
      this.resizeBlockMessage = null
      this.textUndoStack = []
      this.isApplyingTextUndo = false
      this.chartLoaded = true
    },
    reset() {
      this.chart = createEmptyChart()
      this.selection = null
      this.notesPopupKey = null
      this.focusedTileId = null
      this.resizeBlockMessage = null
      this.textUndoStack = []
      this.isApplyingTextUndo = false
      this.chartLoaded = true
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
      const parentCoord = findItemCoord(this.chart.coordinates || {}, p.parentId)
      if (!parentCoord) {
        return
      }
      const delta = DIRECTION_DELTAS[p.direction]
      if (!delta) {
        return
      }
      const from = parseOffset(p.fromOffset)
      const targetOffset = offsetKey(from.x + delta.x, from.y + delta.y)
      if (!isInBounds(parentCoord.x + from.x + delta.x, parentCoord.y + from.y + delta.y, this.chart.size)) {
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
      // Writing an entry validates the target like every other layer write:
      // a drop for a missing parent, an out-of-bounds cell, or the parent's
      // own "0,0" offset is a no-op, so corrupt state can't be introduced
      // from the UI. Removing an entry is always allowed.
      if (p.item) {
        if (p.offset === '0,0') {
          return
        }
        const parentCoord = findItemCoord(this.chart.coordinates || {}, p.parentId)
        if (!parentCoord) {
          return
        }
        const delta = parseOffset(p.offset)
        if (!isInBounds(parentCoord.x + delta.x, parentCoord.y + delta.y, this.chart.size)) {
          return
        }
      }

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

      this.chart = pruneDanglingLinks(chartWithLayers(this.chart, layers))
    },
    moveLayerTile(p: { parentId: string, fromOffset: string, toOffset: string }) {
      const parentCoord = findItemCoord(this.chart.coordinates || {}, p.parentId)
      if (!parentCoord) {
        return
      }
      const layers = { ...(this.chart.relatedLayers || {}) }
      const layer = { ...(layers[p.parentId] || {}) }
      const moving = layer[p.fromOffset]
      if (!moving) {
        return
      }
      const to = parseOffset(p.toOffset)
      if (!isInBounds(parentCoord.x + to.x, parentCoord.y + to.y, this.chart.size)) {
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
    // Fills the focused layer's first empty in-bounds cell when focus mode is
    // on, otherwise the main grid's first empty cell.
    addItemToActiveTarget(item: ChartItem) {
      const normalized = normalizeChartItem(item)

      if (this.focusedTileId) {
        const parentCoord = findItemCoord(this.chart.coordinates || {}, this.focusedTileId)
        if (!parentCoord) {
          return
        }
        const layers = { ...(this.chart.relatedLayers || {}) }
        const layer = { ...(layers[this.focusedTileId] || {}) }
        const target = firstEmptyLayerOffset(this.chart, parentCoord, layer)
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
    // Arrows whose ends are both grid tiles. The overlay draws these against
    // the chart; a layer's own arrows are drawn by the focus overlay instead,
    // in its own geometry.
    gridLinks(state): TileLink[] {
      const links = state.chart.links
      if (!links || links.length === 0) {
        return []
      }

      const gridIds = new Set(Object.values(state.chart.coordinates || {}).map(item => item.id))
      return links.filter(link => gridIds.has(link.from) && gridIds.has(link.to))
    },
    focusedLayerLinks(state): TileLink[] {
      const links = state.chart.links
      const layer = state.focusedTileId ? state.chart.relatedLayers?.[state.focusedTileId] : null
      if (!links || links.length === 0 || !layer) {
        return []
      }

      const layerIds = new Set(Object.values(layer).map(item => item.id))
      return links.filter(link => layerIds.has(link.from) && layerIds.has(link.to))
    },
    // Every arrow touching the selected tile, labelled by the tile at the far
    // end, for the sidebar's connection list.
    activeTileLinks(_state): Array<{ direction: 'out' | 'in', title: string, from: string, to: string }> {
      const active = this.activeTile
      if (!active) {
        return []
      }

      const id = active.item.id
      const chart = this.chart

      return (chart.links || [])
        .filter(link => link.from === id || link.to === id)
        .map((link) => {
          const isOutgoing = link.from === id
          const other = findItemById(chart, isOutgoing ? link.to : link.from)
          return {
            direction: isOutgoing ? 'out' as const : 'in' as const,
            title: other ? buildTitle(other) : 'Unknown tile',
            from: link.from,
            to: link.to,
          }
        })
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
    canMoveTile(state) {
      return (oldIndex: number, newIndex: number): boolean => {
        if (oldIndex === newIndex) {
          return true
        }
        const coordinates = state.chart.coordinates || {}
        const oldCoord = indexToCoord(oldIndex, state.chart.size.x)
        const newCoord = indexToCoord(newIndex, state.chart.size.x)
        const oldKey = coordKey(oldCoord.x, oldCoord.y)
        const newKey = coordKey(newCoord.x, newCoord.y)
        const movingItem = coordinates[oldKey]
        if (!movingItem) {
          return true
        }
        const layers = state.chart.relatedLayers
        if (!layers) {
          return true
        }

        // The moving tile's own layer must fit at the destination.
        const movingLayer = layers[movingItem.id]
        if (movingLayer && layerLeavesBounds(movingLayer, newCoord, state.chart.size)) {
          return false
        }

        // The swap: the displaced tile moves to the old position, so its
        // layer must fit there too.
        const existingAtNew = coordinates[newKey]
        if (existingAtNew) {
          const displacedLayer = layers[existingAtNew.id]
          if (displacedLayer && layerLeavesBounds(displacedLayer, oldCoord, state.chart.size)) {
            return false
          }
        }

        return true
      }
    },
  },
})
