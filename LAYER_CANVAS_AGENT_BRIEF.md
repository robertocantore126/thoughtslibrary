> **SUPERSEDED — do not implement.**
>
> This brief proposed replacing the related-layer ring with a Vue Flow canvas
> whose nodes are `ChartItem` tiles. The decision went the other way: mindmaps
> are a separate feature on grid tiles, with r-node's MindNode schema and
> auto-layout, hand-built in SVG + DOM.
>
> Follow `MINDMAP_NATIVE_AGENT_BRIEF.md` instead. Do not install `vue-flow`.
>
> The related-layer ring described here stays exactly as it is today — this
> brief is retired, not deferred. Its §4 observation about the backdrop has
> been carried into the new brief; nothing else here is live.

# Task: replace the related-layer ring with a mindmap canvas

## Repo and how to verify

`C:\Users\39389\Desktop\crazy ai repo\thoughtslibrary` — Vue 3 + TypeScript + Vite + pinia.
Work on the branch `feature/layer-canvas` (already created, branched from `main`).

There is **no test runner**. Verify with both of these, and both must pass clean:

```
npm run lint     # eslint, @antfu config: no semicolons, single quotes, 2-space indent
npm run build    # runs vue-tsc then vite build
```

House style: comments explain *why* a rule exists, not what the line does. Match the
surrounding code — it is heavily commented with the reasoning behind each guard.

## What to build

Today, right-clicking a grid tile enters **focus mode**: the chart dims and that tile's
**related layer** appears as tiles locked to the grid cells around it. Replace that layer
with a **free-positioned mindmap canvas** built on Vue Flow, in the same dimmed overlay.

The four interaction decisions are settled. Do not revisit them:

1. **The focused tile is a pinned root.** It sits at the canvas origin and cannot be
   dragged. The user pans and zooms the canvas around it.
2. **Two node kinds.** Existing `ChartItem` tiles (cover, title, creator, rating, notes,
   attachment — everything `LayerTile.vue` does today) and a new plain **text node**.
3. **The backdrop goes near-opaque dark.** Today it is a 45% black wash that lets the
   grid show through, because layer tiles were aligned to the cells beneath them. Once
   nodes float freely and the canvas pans, a half-visible grid lines up with nothing and
   reads as a bug. The canvas is its own workspace.
4. **Double-click empty canvas creates a node.** Connections are made by dragging between
   Vue Flow handles. The eight hover `+` buttons go away — they existed only because
   there were eight fixed lattice directions to fill.

## Frozen contract

```ts
// A node on a tile's mindmap canvas. Position is in canvas pixels, relative to the
// parent, which is pinned at the origin and is never stored as a node.
export interface LayerNode {
  item: ChartItem
  x: number
  y: number
}

// Keyed by the node's own ChartItem.id rather than by position — the same reason
// links are id-keyed. Position is now data, not identity.
export type RelatedLayer = Record<string, LayerNode>

// UNCHANGED in shape. `offset` stops meaning "dx,dy" and becomes the node's uuid.
// It stays a string, so selection, notes, rating and drag payloads need no changes.
export type Selection =
  | { kind: 'tile', key: string }
  | { kind: 'layer', parentId: string, offset: string }

// Text nodes extend the existing optional discriminator.
itemType?: 'thought' | 'text'
```

`Chart.relatedLayers?: Record<string, RelatedLayer>` keeps its shape and its key
(the parent `ChartItem.id`). `Chart.links` is untouched.

## Read before writing anything

- `src/components/ChartBuilder/Chart/FocusOverlay.vue` — the overlay you are replacing.
- `src/components/ChartBuilder/Chart/LayerTile.vue` — 671 lines carrying cover rendering,
  title, creator, rating, notes indicator, delete, image drop, search-result drop, link
  drag and thought attachments. **Adapt it into the canvas node component; do not rewrite
  it from scratch.** Everything except its positioning and `+` buttons survives.
- `src/components/ChartBuilder/Chart/TileLinks.vue` — how arrows are drawn today.
- `src/store.ts` — the layer CRUD block (from `// --- Layer CRUD ---`, around line 1145)
  and the getters block.
- `src/helpers/localStorage.ts` — `migrateChart` and `backfillItemIds`. Your migration
  goes here.

## What this deletes

This feature makes the codebase smaller. Six mechanisms exist *only* because a related
tile's position was a grid offset, and all six should be gone when you are done:

1. `layerLeavesBounds` (`store.ts:157`) and the `isInBounds` guards inside `addLayerTile`
   and `moveLayerTile`.
2. `minDimensionForLayers` (`store.ts:288`) — chart resize clamped by layer contents.
3. `blockingParentTitles` (`store.ts:313`) and `resizeBlockMessage` state plus the UI that
   renders it. It exists purely to apologise for #2.
4. `emptyOffsets` / `dropCellOffsets` / `layer-drop-cell` in `FocusOverlay.vue` —
   enumerating every free grid cell as a drop target.
5. `getCellRect` / `updateGeometry` / `positions` / `tileStyle` in `FocusOverlay.vue` —
   DOM-querying a grid cell to place each layer tile, re-measured on every scroll tick.
6. The layer clauses of the `canMoveTile` getter (`store.ts:1479-1493`). Grid tiles are
   currently refused a move when their related layer would leave the chart bounds. With
   an unbounded canvas that restriction has no meaning — remove those clauses, keep the
   getter and any non-layer logic in it.

Also remove `DIRECTION_DELTAS`, `firstEmptyLayerOffset`, `offsetKey` and `parseOffset` if
nothing else uses them after the refactor, and the `Direction` type if it becomes unused.

## Eight things that will break this if you miss them

**1. `parseOffset` has a NaN fallback that will hide your bug.** It returns `{ x: 0, y: 0 }`
for anything unparseable (`store.ts:89`). The `activeTile` getter computes a layer
selection's position as `parentCoord + parseOffset(selection.offset)`. Feed it a uuid and
it does not fail — it silently returns *the parent's own cell*. The notes content stays
correct (it reads `active.item`), so this surfaces as the notes popup opening over the
wrong tile rather than as an error. Restructure `activeTile` so a canvas node reports its
canvas position, not a fake grid coordinate.

**2. `activeTileNote`, `activeTileRating` and `activeTileAttachment` all route through
`activeTile`.** If you make `activeTile` return `null` for canvas nodes to avoid #1, notes,
ratings and attachments go quietly dead for every node — returning `''` and `0` rather
than throwing. Whatever shape you choose, check all three getters still resolve.

**3. `NotesPopup.vue` anchors to a grid cell.** `positionPopup` computes a flat index from
`activeTile.x/y` and does `document.querySelector('.item[data-index="..."]')`. Canvas nodes
have no grid cell, so this finds nothing and the popup sits at 0,0. It must anchor to the
node's element on the canvas, and re-anchor on pan and zoom.

**4. `chart` is replaced wholesale on every mutation, never mutated in place.** The whole
undo system depends on it: `chartUndoStack` stores bare `this.chart` references as
immutable snapshots, with no deep cloning. Vue Flow wants to own its nodes array and
mutate positions during a drag. Do **not** bind store state directly as Vue Flow's model.
Map store → Vue Flow nodes for rendering, and write positions back to the store on
drag-stop only.

**5. One undo snapshot per drag, not per frame.** `recordChartChange()` on every
`nodesChange` event pushes hundreds of snapshots for a single drag and buries the user's
real history under them. Call it once, when the drag ends and the position actually
changed. The existing `moveLayerTile` already guards a no-op move for this reason.

**6. Derive Vue Flow edges from `chart.links`.** Arrows already work in focus mode via the
`focusedLayerLinks` getter, and links are id-keyed so they survive any repositioning
untouched. Do not give Vue Flow its own edge store — the two will drift. Creating a
connection calls `addTileLink`, deleting one calls `removeTileLink`, and
`pruneDanglingLinks` keeps doing its job.

**7. Several call sites iterate layer values as `ChartItem`.** Wrapping them in `LayerNode`
breaks each one: `findItemById` (`store.ts:239`), the context lookup (`store.ts:256`),
`pruneDeadLinks` (`store.ts:279`), the `focusedLayerLinks` getter, and `applyItemUpdate`,
which must now write `{ ...node, item: next }` instead of the bare item. This is the good
kind of breakage — `vue-tsc` enumerates every site for you. Run `npm run build` early and
work the list.

**8. Clear the Vite cache after installing Vue Flow.** A dev server running across a
dependency change keeps serving pre-change modules for anything already optimised while
newly transformed files are current, so the app runs half-old and produces convincing fake
bugs that are not in the source at all. After `npm install`, delete `node_modules/.vite`
and restart the dev server. Vue Flow also needs its stylesheet imported
(`@vue-flow/core/dist/style.css`) or the canvas renders unstyled and broken.

## Recommended approach

Four stages, each one buildable and lint-clean before starting the next.

**Stage 1 — data model, no UI.** Add `LayerNode`, rewrite `RelatedLayer`, extend
`itemType`. Fix everything `vue-tsc` reports (gotcha 7). Rewrite `addLayerTile` into
`addLayerNode(parentId, x, y, kind)` and `moveLayerTile` into
`moveLayerNode(parentId, nodeId, x, y)`, with no bounds checks. Delete the six mechanisms
listed above. The app still builds; focus mode is temporarily broken.

**Stage 2 — migration.** In `migrateChart` (`localStorage.ts:271`), convert every
`"dx,dy"` key to `{ x: dx * 130, y: dy * 130 }`, keyed by the item's id. 130 is the
`CELL_SIZE_PX` / `BASE_ITEM_SIZE_PX` constant already defined in `FocusOverlay.vue` and
`LayerTile.vue`. This is lossless: every existing layer opens as a canvas with its nodes
exactly where they already appear on screen. Follow the conventions already in that file —
return whether anything changed, be idempotent, and never throw for one bad chart.

**Stage 3 — the canvas.** Install `@vue-flow/core`. Replace `FocusOverlay.vue`'s
positioning half with a Vue Flow canvas; keep its backdrop, its Escape handling and its
`noteOpenAtPress` logic, which exists so a click dismissing a note does not also tear down
the layer behind it. Adapt `LayerTile.vue` into a custom node component. Pin the parent at
the origin as a non-draggable node.

**Stage 4 — the new gestures.** Double-click empty canvas to create a node, connection
handles for arrows, and rewire `addItemToActiveTarget` — the sidebar search currently drops
an item into `firstEmptyLayerOffset`, and needs to place it at a free canvas position near
the origin instead.

## Acceptance criteria

- Right-click a grid tile → chart goes dark, canvas opens with that tile pinned at centre
- An existing chart with related layers opens with every node where it was before, no
  visible change on first load, and re-saving does not re-migrate
- Pan and zoom work; the parent node cannot be dragged
- Double-click empty canvas creates a node; it can be dragged anywhere, including far
  outside the chart's former bounds
- Text nodes can be created and edited, and persist across a reload
- Item nodes keep cover, title, creator, rating, notes, delete, image drop and
  search-result drop working exactly as they do today
- Dragging between two node handles creates an arrow; deleting a node removes its arrows
- Existing arrows inside a migrated layer still render, in their correct pairs
- Drag a node → Ctrl+Z → it returns to its previous position, in one press
- Notes popup opens anchored to its node, and stays anchored while panning
- Escape closes an open note first, and only leaves the canvas on a second press
- Chart resize is no longer clamped by layer contents, and no "can't shrink further"
  message can appear
- A grid tile with a large related layer can now be moved anywhere on the grid
- Switch charts while a canvas is open → no stale nodes from the previous chart
- `npm run lint` and `npm run build` both pass clean

## Out of scope

Nested canvases — a node still never opens a canvas of its own; one level only. Auto-layout
or "tidy up". draw.io-style shapes, per-node fill/stroke styling, or node resizing. Edge
labels, curves or waypoint routing. Rendering canvases into the PNG or PDF exports. Changes
to the main grid's own arrows or to `linkDrag.ts`, which stays as it is for the grid.
