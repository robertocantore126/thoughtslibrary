# Related Layers — Implementation Briefs for Agents A, B, C

Three agents work in **separate chats** on the same repo. Sections are non-overlapping by file. **No file is owned by more than one agent.**

## How to use this document

1. Give **§1 Shared Context** and **§2 Frozen Contract** to all three agents, verbatim.
2. Give each agent only its own section (§4, §5, or §6).
3. Agent A merges first. B and C code against §2 and can work in parallel from the start.

---

## §1 Shared Context

**Project:** `thoughtslibrary` — a Vue 3 + Pinia + Vite fork of Topsters, packaged with Electron. Users build a grid chart of album/book/film tiles.

**Existing model.** `Chart.coordinates` is `Record<"x,y", ChartItem>` — a tile's identity IS its grid position. `Chart.items` is a flat array derived from it by `itemsFromCoordinates()` on every mutation. `store.ts` is the single source of truth; `LocalStorageWatcher.vue` persists the whole chart on every mutation via `$subscribe`.

**The feature.** Right-clicking a grid tile toggles **focus mode**: the rest of the chart dims and that tile's own **related layer** appears, grid-aligned, on top. A layer is a second grid the same size as the chart. Every tile in the layer — including the parent — shows eight `+` buttons (4 cardinal + 4 diagonal) that create a new empty editable tile in the adjacent cell. Right-clicking the parent again exits.

**Design decisions already settled — do not revisit:**

- **One level only.** Layer tiles are leaves. They never open layers of their own.
- **Strict tree.** Every layer tile has exactly one parent.
- **Layer tiles are full `ChartItem` peers** — cover, title, creator, rating, notes, attachment, delete, image drop, search-result drop.
- **Layers are confined to chart bounds.** A layer tile's absolute position must satisfy `1 <= x <= size.x` and `1 <= y <= size.y`.
- **Layers are sparse.** A cell exists only once the user presses `+`. An empty layer is not stored at all.
- **Layers follow their parent** when it is dragged. A move is **refused** if any child would land out of bounds.
- **Resize is clamped** at the point layer tiles would be lost.
- Maximum possible tiles is `(size.x * size.y)^2` — 12,960,000 at a 60x60 chart. This is a theoretical ceiling reached only by millions of manual clicks. Do not add quotas, pagination, or virtualization for it.

**Out of scope.** Dragging tiles between the grid layer and a related layer. Nested layers. Auto-layout. Graph/edge rendering.

**House style.** Match surrounding code. `@antfu/eslint-config`, no semicolons, 2-space indent, single quotes. TypeScript throughout. Run `npm run lint-fix` and `npm run build` before declaring done.

---

## §2 Frozen Contract

Agent A implements exactly this. B and C consume it and must not change it. If A finds a signature genuinely unworkable, A stops and reports rather than improvising — a silent change breaks the other two agents.

### Types (`src/types.ts`)

```ts
export interface ChartItem {
  id: string // NEW — uuid v4, required on every item
  title: string
  creator?: string
  coverURL: string
  itemType?: 'thought'
  attachmentURL?: string
  notes?: string
  rating?: number
}

// Key is a RELATIVE offset from the parent tile: `${dx},${dy}`.
// dx > 0 is right, dy > 0 is down. "0,0" is the parent and is never stored.
export type RelatedLayer = Record<string, ChartItem>

export interface Chart {
  // ...all existing fields unchanged...
  relatedLayers?: Record<string, RelatedLayer> // keyed by parent ChartItem.id
}

export type Direction = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

export type Selection =
  | { kind: 'tile', key: string } // "x,y" absolute
  | { kind: 'layer', parentId: string, offset: string } // "dx,dy" relative
```

Direction deltas, canonical:

```
n  ( 0, -1)    ne ( 1, -1)    e  ( 1,  0)    se ( 1,  1)
s  ( 0,  1)    sw (-1,  1)    w  (-1,  0)    nw (-1, -1)
```

### Store state (`src/store.ts`)

```ts
focusedTileId: string | null // null = focus mode off
selection: Selection | null // what the editors act on
```

### Store actions

```ts
toggleFocus(tileId: string): void
exitFocus(): void

addLayerTile(p: { parentId: string, fromOffset: string, direction: Direction }): void
setLayerTileItem(p: { parentId: string, offset: string, item: ChartItem | null }): void
moveLayerTile(p: { parentId: string, fromOffset: string, toOffset: string }): void
selectLayerTile(p: { parentId: string, offset: string }): void

addItemToActiveTarget(item: ChartItem): void
```

### Store getters

```ts
activeTileKey: string | null       // KEPT. "x,y" when selection.kind === 'tile', else null
focusedLayer: RelatedLayer | null  // the focused tile's layer, or null
focusedTileCoord: { x: number, y: number } | null
tileHasLayer: (tileId: string) => boolean
layerTileCount: (tileId: string) => number
canMoveTile: (oldIndex: number, newIndex: number) => boolean
resizeBlockMessage: string | null  // set when a resize was clamped, else null
```

### Semantics agents B and C depend on

- `addLayerTile` writes into the cell adjacent to `fromOffset` in `direction`. If that cell is occupied or out of bounds, it is a **no-op**.
- `canMoveTile` returns `false` when the move — **including the swap of a displaced tile** — would put any layer tile out of bounds.
- `addItemToActiveTarget` fills the **focused layer's first empty in-bounds cell** when focus mode is on, otherwise the main grid's first empty cell.
- All existing `setActiveTile*` actions operate on whatever `selection` points at, so they work identically on grid tiles and layer tiles.

---

## §3 File Ownership

| File | Owner |
|---|---|
| `src/types.ts` | **A** |
| `src/store.ts` | **A** |
| `src/helpers/assets.ts` | **A** |
| `src/helpers/chart.ts` | **A** |
| `src/helpers/localStorage.ts` | **A** |
| `src/components/LocalStorageWatcher.vue` | **A** |
| `src/components/Sidebar/SearchBox/SearchDropdown.vue` | **A** |
| `src/components/Sidebar/Options/index.vue` | **A** |
| `src/components/ChartBuilder/Chart/Item.vue` | **B** |
| `src/components/ChartBuilder/Chart/index.vue` | **B** |
| `src/components/ChartBuilder/index.vue` | **B** |
| `src/components/ChartBuilder/Chart/FocusOverlay.vue` *(new)* | **B** |
| `src/components/ChartBuilder/Chart/LayerTile.vue` *(new)* | **B** |
| `src/helpers/imports.ts` | **C** |
| `src/components/PrintDocument.vue` *(new)* | **C** |
| `electron/main.cjs` | **C** |
| `electron/preload.cjs` | **C** |
| `package.json` | **C** |

`src/global.css` is touched by **nobody** — B uses scoped styles, C uses a scoped print stylesheet. `TitlesSidebar.vue` and `NotesPopup.vue` are touched by **nobody**; if they appear to need changes, A's selection generalization is wrong.

---

## §4 Agent A — Data Foundation

You own the schema. B and C are blocked on your merge, so land §2 exactly as written.

### A1. Add `id` to `ChartItem`

Every item needs a uuid. `uuid` is already a dependency (`import { v4 as uuidv4 } from 'uuid'`).

- Generate in `createChartItem()` (`src/helpers/chart.ts`) for all seven result branches.
- Generate in the drop handlers' item construction paths.
- **Backfill on load**: in `setEntireChart`, walk `coordinates` and assign an id to any item lacking one. Charts saved before this change have none — a missing id must never reach the rest of the app.
- Backfill in `localStorage.ts` `migrateChart()` too, so stored data is repaired at rest.

Ids must be **stable across a move**. `moveItem` relocates the same object between coordinate keys; the id rides along untouched. This is the entire reason for the field: `relatedLayers` is keyed by parent id, so relations survive drags and resizes that would scramble any coordinate-based key.

### A2. Generalize selection

Currently `activeTileKey: string | null` is a coordinate and every editor is hardwired to it. Replace the internal representation with `Selection` (§2) and route all of these through one resolver that returns the target `ChartItem` regardless of kind:

`setActiveTileNote`, `setActiveTileTitle`, `setActiveTileCreator`, `setActiveTileRating`, `setActiveTileAttachment`, `activeTile`, `activeTileNote`, `activeTileRating`, `activeTileAttachment`, `notesPopupNote`, `notesPopupVisible`, `recordTextEdit`, `undoTextEdit`.

`recordTextEdit`/`undoTextEdit` currently store `tileKey: string`. Change `TextUndoEntry` to carry a `Selection` so undo works on layer tiles.

**Acceptance test for this step:** `TitlesSidebar.vue` and `NotesPopup.vue` compile and work on layer tiles with **zero edits to either file**. If you find yourself wanting to edit them, the resolver is in the wrong place.

Keep `activeTileKey` as a getter (§2) — `Item.vue` uses it and that file is B's.

### A3. Layer CRUD

Implement `addLayerTile`, `setLayerTileItem`, `moveLayerTile`, `selectLayerTile`, `toggleFocus`, `exitFocus`, and the getters in §2.

Bounds rule: for parent at `(px, py)` and offset `(dx, dy)`, the absolute position is `(px + dx, py + dy)` and must satisfy `1 <= x <= size.x`, `1 <= y <= size.y`.

Delete a layer's entry entirely when its last tile is removed — do not leave empty objects.

### A4. Movement guards

`canMoveTile(oldIndex, newIndex)` returns `false` if either:

- the tile being moved has a layer and any child would leave bounds at the new position, or
- the target cell is occupied and **that** tile has a layer whose children would leave bounds at the old position (the swap in `moveItem` moves both tiles).

Guard `moveItem` with it — return early, mutate nothing.

### A5. Resize clamping

`setWidth`/`setHeight` clamp to the smallest dimension at which every layer tile still fits, rather than applying the requested value. Compute the minimum from the largest absolute x/y occupied by any layer tile across all layers, plus their parents' positions.

Existing behaviour for **grid** items on resize is unchanged — they still clip and are preserved in `coordinates`. Only layer tiles force a clamp.

When clamped, set `resizeBlockMessage` naming the blockers, e.g. `"Can't shrink further — Arcade Fire and 2 others have related tiles in this column"`. Display it in `Sidebar/Options/index.vue` near the sliders. Clear it on the next successful resize. The sliders read `:value="storeRef.chart.value.size.x"` so they snap back to the clamped value automatically.

### A6. Asset persistence

`persistChartAssets` and `inlineChartAssets` (`src/helpers/assets.ts:228`) currently walk only `items` and `coordinates`. Extend both to walk `relatedLayers` as well.

**Without this, images dropped onto layer tiles never reach IndexedDB and are lost on reload, and they are missing from Agent C's PDF.** Keep both function signatures unchanged — C depends on `inlineStoredChartAssets` as-is.

### A7. Search-result routing

In `SearchDropdown.vue`, `addToChart()` currently targets `items.indexOf(null)`. Replace its body with a call to `addItemToActiveTarget(createChartItem(item))`. All layout/filter logic in that file stays as it is.

### A8. Persistence performance

`LocalStorageWatcher.vue` `$subscribe` stringifies the entire chart on every mutation — including every keystroke in a note. Debounce it to ~300ms. Flush immediately on `beforeunload` so nothing is lost on close.

### A9. IndexedDB migration (optional, do last)

Move chart **structure** from localStorage to the IndexedDB store already open in `assets.ts`. Images are already there via `local-asset://` refs; this is text only, and current volumes are modest, so **skip this and report it as skipped if A1–A8 take the full budget**. Do not start it half-way.

### Do not touch

Anything under `src/components/ChartBuilder/`, `src/helpers/imports.ts`, `electron/`, `package.json`.

---

## §5 Agent B — Focus UI

You build everything the user sees. You call Agent A's actions (§2) and never reach into store internals or reimplement its rules — in particular, do not compute bounds yourself; ask `canMoveTile` and let `addLayerTile` no-op.

### B1. Right-click to focus

In `Item.vue`, add `@contextmenu.prevent` calling `store.toggleFocus(props.item.id)`. Right-clicking the same tile again exits. Right-clicking an empty placeholder does nothing. `e.preventDefault()` is required or the native menu appears.

Also exit focus on `Escape`.

### B2. Dimming

When `store.focusedTileId` is set, all chart content except the focused tile drops to `opacity: 0.15`. The focused tile and its layer stay at `opacity: 1` with elevated z-index. Use a CSS transition (~200ms) — no snap.

### B3. The layer overlay

New `FocusOverlay.vue`, mounted in `ChartBuilder/index.vue` as a sibling of `<Chart />` and `<NotesPopup />`. `.chart-builder` is already `position: relative`, so absolute positioning there is correct.

The layer is **grid-aligned**: same cell size, same gap as the chart. Read the focused tile's `getBoundingClientRect()` for the origin, then place each layer tile at `offset x (cellSize + gap)` from it. Tile size is `BASE_ITEM_SIZE_PX = 130`; gap is `store.chart.gap`; rows use `Math.max(6, gap / 2)` — match `Row.vue` exactly or the layer will drift out of alignment with the grid beneath.

Layer tiles render **on top of** the dimmed chart, fully covering the cell they occupy including its title area.

Animate tiles in with a short staggered scale/fade.

### B4. The eight `+` buttons

Every tile in the layer — the parent included — shows eight `+` buttons: four on the edge midpoints, four at the corners. Reveal on hover of the tile.

Clicking one calls `store.addLayerTile({ parentId, fromOffset, direction })`. A `+` pointing at an occupied or out-of-bounds cell should be hidden or visibly disabled; if one is clicked anyway the action no-ops safely.

Mark them `data-html2canvas-ignore`, matching the existing delete button in `Item.vue`.

### B5. `LayerTile.vue`

A layer tile is a full peer of a grid tile. Port from `Item.vue`: cover image via `useResolvedImageUrl`, title/creator line, rating stars with the existing colour ramp, notes indicator, thought attachment, delete button, ctrl+click delete, `allowDrop` / `handleDrop` including external image files, image URLs, and dragged search results (`application/json` carrying `{ item }`).

Click selects it via `store.selectLayerTile(...)` — which makes the existing sidebar and notes popup edit it, with no work needed on your side.

Dragging a layer tile to another cell in the same layer calls `moveLayerTile`. Dragging between layers, or between a layer and the grid, is **out of scope** — reject those drops.

Prefer extracting shared markup from `Item.vue` over copy-pasting it, but do not change `Item.vue`'s existing behaviour while doing so.

### B6. The yellow ring indicator

In `Item.vue`, the corner slot currently holds `.notes-indicator` — a 10x10 orange `#ff7f50` square shown when the item has notes. New logic for that one slot:

| Tile state | Indicator |
|---|---|
| has a layer (with or without notes) | **yellow ring** |
| notes only, no layer | orange square (unchanged) |
| neither | nothing |

The ring is a small circular outline in the same corner position and size as the square — not an outline around the whole tile. Never show both.

Use `store.tileHasLayer(id)`.

### B7. Drag refusal

In `Item.vue`'s `allowDrop`, when the drag is an internal tile move and `store.canMoveTile(sourceIndex, props.index)` is `false`, set `ev.dataTransfer.dropEffect = 'none'` so the cursor shows the refusal during the drag rather than the drop silently doing nothing.

### Constraints

Scoped styles only — do not edit `src/global.css`. Do not touch `store.ts`, `types.ts`, `TitlesSidebar.vue`, `NotesPopup.vue`, or anything Agent C owns. **The overlay must render outside `#chart`** so `downloadChart()` keeps producing an identical PNG.

---

## §6 Agent C — PDF Pipeline

The current PDF export **silently destroys content**. You are replacing it, not patching it.

### C1. Understand the existing bug (context, not a task)

`exportCurrentChartToPdf` in `src/helpers/imports.ts` rasterizes the chart with html2canvas, then appends text pages with jsPDF. Two independent defects:

- It paginates with `if (y > 760)`, but an a4 page in jsPDF's `px` units is **631.42 units tall**. Everything drawn between 631 and 760 lands off-page and is discarded — roughly five entries per page, on any chart past ~24 tiles.
- `pdf.text(splitText, 56, y)` draws every line of a note at once with no page-break check. A 60-line note runs to y≈1094 on a 631-tall page; two thirds of it is gone.

Plus `sanitizePdfText` collapses all whitespace to single spaces, destroying paragraph structure, and `markdownToPlainText` strips bold, headings, links, and the underline / colour / highlight that the notes editor deliberately preserves.

### C2. Replace the engine

`electron/main.cjs:112` already implements `printToPDF` via Chromium — vector text, selectable and searchable, with real pagination. The jsPDF path is a hand-rolled layout engine duplicating it badly.

Build a hidden **print document** in the DOM and hand it to Chromium. On web, fall back to `window.print()` against the same document. Remove `jspdf` from `package.json`.

### C3. Document structure

```
Page 1:  the chart image, exactly as the PNG export renders it today
Then, for each grid tile that has a non-empty layer:
    - a small render of that tile's layer
    - immediately followed by that tile's own text, then each of its layer tiles' text
Then: the remaining tiles' text (those with no layer)
```

Per-tile text: title, creator, rating, and notes rendered through the existing `renderMarkdown()` from `src/helpers/markdown.ts` — **not** `markdownToPlainText`. That is what preserves bold, headings, links, underline, colour, and highlight. Include the thought attachment image where present.

### C4. The mini layer renders

Draw these as **real DOM and CSS in your print document** — not html2canvas rasters — so they stay vector and crisp at print resolution.

Read `chart.relatedLayers[parentId]` and lay the tiles out on a small grid by their `"dx,dy"` offsets, with the parent highlighted at `0,0`. Crop to the bounding box of the layer's occupied cells rather than rendering the full chart-sized grid — layers are sparse and mostly empty.

**Render your own static markup from the data.** Do not import Agent B's `LayerTile.vue` or `FocusOverlay.vue`; they are interactive, carry hover and drag behaviour you do not want in print, and depending on them would serialize your work behind B's.

### C5. Pagination

Chromium handles it. Use `break-inside: avoid` on each tile section and each mini render so nothing splits mid-entry, and `break-after` between tiles. Verify explicitly with a note long enough to span three pages — that is the exact case the old code lost.

### C6. Assets

Call `inlineStoredChartAssets` (`src/helpers/assets.ts`) as the current code does. Agent A is extending it to walk `relatedLayers`; its signature does not change, so write against it as it stands today. If layer-tile images come through blank, that is A's step A6 not yet merged — report it rather than working around it.

### Acceptance

- A chart with 30 tiles, several with layers, and one 200-line note exports with **every character present** across as many pages as it takes.
- Text in the PDF is selectable and searchable.
- Bold, headings, links, underline, colour, and highlight all survive.
- Ratings and attachments appear.
- `jspdf` is gone from `package.json`.

### Do not touch

`src/store.ts`, `src/types.ts`, anything under `src/components/ChartBuilder/`, `src/helpers/assets.ts`.

---

## §7 Integration Order

1. **A merges first.** B and C write code against §2 from the start, but neither can run until A lands.
2. **B and C merge in either order.** They share no files.
3. Verify together: right-click focus, build a layer, drag the parent near an edge and confirm refusal, shrink the chart and confirm the clamp message, export PNG and confirm it is identical to before, export PDF and confirm every note is complete.

## §8 Known Risks

- **A is a hard dependency for both others.** §2 exists so B and C are not idle. If A changes a signature without telling the other two, both break silently.
- **Grid alignment (B3)** is the most likely visual bug. The layer must use the same cell size, gap, and row gap as `Row.vue`, or it drifts against the grid underneath.
- **The swap case in A4** is easy to miss and produces an asymmetric bug where a move is refused in one direction but allowed in the other.
- **A6 is invisible until it fails.** Nothing breaks at authoring time; images vanish on reload and in the PDF. Test by dropping an image on a layer tile, reloading, and exporting.
