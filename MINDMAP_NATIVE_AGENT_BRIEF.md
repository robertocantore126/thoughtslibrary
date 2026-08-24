# Task: a native mindmap for thoughtslibrary tiles — three parallel lanes

Build a mind-mapping feature inside thoughtslibrary, in Vue + SVG, reaching
feature parity with r-node over five stages. Any tile on the **main grid** can
carry one mindmap. Related-layer tiles cannot.

This document is written for **three agents working simultaneously**. It is
organised by *lane*, not by module, and the lane boundaries are file-exclusive.

Supersedes `MINDMAP_TILE_AGENT_BRIEF.md` and `LAYER_CANVAS_AGENT_BRIEF.md`.
Do not follow either. Do not add r-node as a dependency. Do not install
`vue-flow`.

---

## READ THIS FIRST — how not to step on each other

**Read §0, your own lane, and §T. Skip the other lanes entirely.**

Three rules, and breaking any of them costs more than the work it saves:

1. **You may only create or edit files your lane owns.** The ownership table in
   §0.4 is exhaustive. A file not listed against your lane is not yours, even
   if it is one line, even if it is obviously wrong.
2. **If you need a change in a file you do not own, stop and write it in your
   final message.** Do not make it. Do not work around it by duplicating the
   thing elsewhere. Two agents editing one file means a merge conflict that a
   human has to resolve at 3am.
3. **Code against §0.3, not against the other lanes' source.** The signatures
   there are frozen. If a signature turns out to be wrong, say so in your final
   message rather than changing it — another agent is already writing calls to
   it.

Work happens in **two rounds**. Round 1 is three lanes of pure logic that
cannot collide. Round 2 is three lanes of UI that depend on Round 1 being
merged. **Do not start Round 2 work while in a Round 1 lane.**

---

# §0 — Shared ground

## §0.1 Repo, worktrees, verification

`C:\Users\39389\Desktop\crazy ai repo\thoughtslibrary` — Vue 3 + TypeScript +
Vite + pinia.

Three agents cannot share one working directory: concurrent `npm test` runs and
git operations race. Use one git worktree per lane.

**Run these only after Round 0 (§0.5) is merged to `main`.** Each branches from
`main`, so a worktree created earlier has no `src/mindmap/types.ts` and no
`npm test`, and all three lanes start on sand. Round 0 first, then these, then
the agents.

From the repo root, in PowerShell:

```powershell
git worktree add ../tl-lane-a -b feat/mindmap-ops main
```

```powershell
git worktree add ../tl-lane-b -b feat/mindmap-layout main
```

```powershell
git worktree add ../tl-lane-c -b feat/mindmap-storage main
```

Each worktree needs its own `npm install`. Branch from `main`, never from
`feature/layer-canvas` — that branch belongs to a retired task and is 0 commits
ahead of `main`.

Every lane must leave these green:

```
npm run lint
```

```
npm run build
```

```
npm test
```

House style: `@antfu` config — no semicolons, single quotes, 2-space indent.
Comments explain *why* a rule exists, never what a line does. Match the
surrounding code, which is heavily commented with the reasoning behind each
guard.

## §0.2 Why SVG and DOM, not canvas

r-node draws to a canvas. Do not copy that decision — it is right for r-node
and wrong here:

1. **Print and PDF come free.** `buildPrintDocument` in
   `src/helpers/printDocument.ts:752` emits an HTML string, and
   `src/helpers/pdfFromDom.ts` measures real element rects. DOM nodes and SVG
   edges serialise straight into that pipeline. Canvas would print as a flat
   bitmap needing a second rasterisation path.
2. **No text-parity problem to inherit.** r-node's largest maintenance burden
   is keeping canvas text, layout text and editor text in agreement. With one
   text renderer — the browser — that class of bug cannot occur.
3. **`measure.ts` mostly evaporates.** 1,222 lines of text measuring, wrapping,
   code-block sizing and gallery grid math is what canvas costs. CSS does it.
4. **You already do this.** `src/components/ChartBuilder/Chart/TileLinks.vue`
   draws tile arrows in SVG. Match its conventions.

## §0.3 The frozen contract

Every signature below is fixed before any lane starts. Code against these.

```ts
// src/mindmap/types.ts — Round 0
// Ported from r-node/src/core/types.ts. See §0.5.

// src/mindmap/ops.ts — Lane A
export type Op = { type: string, [k: string]: unknown }
/** Applies `op` to `sheet` in place, returning the ops that undo it. */
export function applyWithInverse(sheet: Sheet, op: Op): Op[]

// src/mindmap/history.ts — Lane A
export class History {
  push(ops: Op[], inverses: Op[][]): void
  undo(): Op[] | null   // ops to apply, already in the right order
  redo(): Op[] | null
  get canUndo(): boolean
  get canRedo(): boolean
  clear(): void
}

// src/mindmap/layout.ts — Lane B
export interface NodeSize { w: number, h: number }
/** Writes `position` on every non-manual node. Pure w.r.t. the DOM. */
export function layoutSheet(
  sheet: Sheet,
  sizes: Record<string, NodeSize>,
  force?: boolean,
): void

// src/mindmap/geometry.ts — Lane B
export function bezierPoint(b: Bezier3, t: number): { x: number, y: number }
export function bezierEnterRect(b: Bezier3, x: number, y: number, w: number, h: number): number
export function bezierExitRect(b: Bezier3, x: number, y: number, w: number, h: number): number
/** SVG `d` for the edge between two laid-out nodes, clipped to both borders. */
export function edgePath(from: Rect, to: Rect): string

// src/mindmap/storage.ts — Lane C
export function readSheet(id: string): Promise<Sheet | null>
export function writeSheet(id: string, sheet: Sheet): Promise<void>
export function deleteSheet(id: string): Promise<void>
export function listSheetIds(): Promise<string[]>
export function blankSheet(title: string): Sheet

// src/mindmap/store.ts — Lane D (Round 2)
// Frozen NOW so Lanes E and F can call it before it exists.
export const useMindmapStore: StoreDefinition<'mindmap', {
  sheet: Sheet | null
  selection: string | null
  camera: { x: number, y: number, scale: number }
  canUndo: boolean
  canRedo: boolean
}, {
  visibleNodes: (state) => MindNode[]
}, {
  open: (sheetId: string | null) => Promise<void>
  close: () => Promise<void>
  applySizes: (sizes: Record<string, NodeSize>) => void
  createChild: (parentId: string) => string
  createSibling: (nodeId: string) => string
  rename: (nodeId: string, title: string) => void
  remove: (nodeId: string) => void
  toggleCollapse: (nodeId: string) => void
  select: (nodeId: string | null) => void
  panBy: (dx: number, dy: number) => void
  zoomAt: (sx: number, sy: number, factor: number) => void
  fit: (viewW: number, viewH: number) => void
  undo: () => boolean   // false when this history is empty — see Lane F
  redo: () => boolean
}>

// MindmapCanvas.vue — Lane E, mounted by Lane F
// TAKES NO PROPS AND EMITS NOTHING. It reads useMindmapStore directly and
// fills its parent. Lane F writes exactly `<MindmapCanvas />` and nothing
// else: props would be a second channel for state the store already owns,
// and the two would drift the first time one of them was updated alone.
```

## §0.4 File ownership — exhaustive

| Lane | Owns exclusively |
|---|---|
| **Round 0** | `src/mindmap/types.ts`, `package.json`, `vite.config.ts` |
| **A** (Round 1) | `src/mindmap/ops.ts`, `src/mindmap/history.ts`, `tests/mindmap-ops.test.ts` |
| **B** (Round 1) | `src/mindmap/layout.ts`, `src/mindmap/geometry.ts`, `tests/mindmap-layout.test.ts`, `tests/mindmap-geometry.test.ts` |
| **C** (Round 1) | `src/mindmap/storage.ts`, `tests/mindmap-storage.test.ts`, `src/types.ts` |
| **D** (Round 2) | `src/mindmap/store.ts`, `tests/mindmap-store.test.ts` |
| **E** (Round 2) | `src/components/ChartBuilder/Chart/MindmapCanvas.vue`, `MindmapNode.vue`, `MindmapEdges.vue` |
| **F** (Round 2) | `src/components/ChartBuilder/Chart/MindmapOverlay.vue`, `src/store.ts`, `src/components/TitlesSidebar.vue`, `src/components/ChartBuilder/Chart/Item.vue` |

`src/mindmap/types.ts`, `package.json` and `vite.config.ts` are **read-only for
every lane** after Round 0.

**Two files are dangerously similarly named.** `src/mindmap/store.ts` is the
new mindmap store and belongs to Lane D. `src/store.ts` is the existing chart
store and belongs to Lane F. They are different files with different owners.
Check the path, not the basename.

## §0.5 Round 0 — do this before the lanes start

One agent, alone. Everything else blocks on it, so it is merged to `main`
before any lane branches. Two jobs.

### Job 1 — the test runner

Add vitest 2.x and an `npm test` script. r-node has no `vitest.config.ts` to
copy: its config is inline in `vite.config.ts:76` and runs
`environment: "node"`. Do the same here — a `test` block inside the existing
`vite.config.ts`, plus `fake-indexeddb` as a dev dependency for Lane C.
**jsdom is not needed**, and that is deliberate: see Lane B.

This is in Round 0 rather than in a lane because all three Round 1 lanes are
test-first. If it lived in Lane C, Lanes A and B would sit blocked, or worse,
start writing untested code while waiting.

Land it with one trivial passing test so `npm test` is green, not merely
present.

### Job 2 — the schema

Create `src/mindmap/types.ts` by porting r-node's
`C:\Users\39389\Documents\XuanZhi9\r-node\src\core\types.ts` **as close to
verbatim as the lint config allows** — same interface names, same field names,
same optionality, comments included.

This is not laziness and not a fork. Types are a *format*, not an engine.
Copying them means your existing `.rnode` documents import without a
translation layer in S2, the layout logic ports without renaming anything, and
the reasoning already written into those comments comes with them.

Carry over: `MindNode`, `Style`, `TextRun`, `Position`, `Relationship`,
`Group`, `Summary`, `TaskInfo`, `AttachmentInfo`, `GalleryItem`, `Sheet`, and
the enums (`NodeType`, `TopicShape`, `ConnectorStyle`, `TaskStatus`,
`Priority`).

Two deliberate changes, and no others:

- **Drop `RnodeDocument`.** A tile owns one `Sheet`. r-node's document wrapper
  is single-sheet in practice anyway — `sheets` is only ever read as
  `sheets[0]`, in 8 places, and there is no add-sheet or switch-sheet command
  anywhere in that codebase. Nothing is lost.
- **Cut `StructureType` to what exists.** The union lists nine layouts; the
  engine implements a tidy tree and a left/right mindmap variant of it. Keep
  those two. Do not carry seven names nothing can produce.

**The schema is full-parity from S1**, even where nothing reads the fields yet.
That is the point of the staging: later stages add behaviour, never a
migration. A document written by S1 must load unchanged in S5.

## §0.6 The five stages

Only **S1** is specified here. It is what Rounds 0–2 build.

| Stage | What lands |
|---|---|
| **S1** | Schema, storage, layout, rendering, pan/zoom, create/rename/delete, undo, the overlay |
| **S2** | The `Style` fields and an inspector panel; `.rnode` import |
| **S3** | Images in topics, then galleries |
| **S4** | Relationships, boundaries, summaries, markers, tasks |
| **S5** | Print/PDF integration, SVG export, the chart-file round-trip |

---

# ROUND 1 — three lanes, no shared files

## Lane A — ops and history

Port r-node's `src/core/ops.ts` and `src/core/history.ts` (417 lines together).
Each op computes its own inverse; history only stacks them.

Ops needed for S1: create node, delete node (with subtree), set title, set
parent (move), toggle collapse. Others may be stubbed with a clear `TODO(S2)`
but their inverses must be correct if implemented at all.

Why ops rather than the whole-object snapshots this repo uses everywhere else:
a chart is replaced wholesale on every mutation, so a snapshot is free. A sheet
is not — it is a `Record<string, MindNode>` that mutations touch in place, and
snapshotting several hundred nodes on every keystroke is a different
proposition. Ops also keep per-topic undo honest while typing.

**Tests** (`tests/mindmap-ops.test.ts`), table-driven, one case per op type:

1. **Every op has a correct inverse.** Apply, invert, assert the sheet
   deep-equals its starting state. This is the cheapest real safety net in the
   whole build.
2. **Delete removes the whole subtree** and its inverse restores all of it,
   including child order.
3. **History depth and redo invalidation.** Push, undo, push again — the redo
   stack is cleared.

Do not import anything from `layout.ts` or `storage.ts`. Ops operate on the
`Sheet` and nothing else.

## Lane B — layout and geometry

### layout.ts

Port `r-node/src/layout/mindmap.ts` (410 lines): a tidy tree, children fanned
left and right of the root, vertically packed so nothing overlaps.

**Layout takes measured sizes as an argument and must never read the DOM.**
That is the single most important interface decision in S1 and it is easy to
break by accident. A layout that reaches for `offsetWidth` is untestable
outside a browser, forces jsdom into the test run, and welds the trickiest
logic in the build to the rendering layer. Your caller measures; you receive
`sizes`.

Two properties are load-bearing:

- **`position.manual === true` means the user placed it.** Preserve those
  coordinates and flow around them. Only an explicit auto-layout command
  (`force = true`) may clear the flag.
- **Layout is derived data.** It never enters an op and never enters history.
  Undo restores the tree; layout re-runs from it.

Sizing constants to apply, ported from r-node's `measure.ts`: `MIN_TOPIC_W` 84,
`MAX_TOPIC_W` 280, `TEXT_INSET` 6, `LINE_HEIGHT_FACTOR` 1.25. Export them —
Lane E applies them as CSS.

### geometry.ts

The one part of r-node's `measure.ts` worth carrying: `bezierPoint`,
`bezierSlice`, `bezierEnterRect`, `bezierExitRect`, `segmentExitRect`,
`rectCrossing` (~150 lines, `r-node/src/layout/measure.ts:208-330`), plus a new
`edgePath(from, to)` that returns the SVG `d` string Lane E renders.

Edges are curves between boxes and must stop exactly at the border rather than
run under the node. That geometry is already correct; reinventing it produces
edges that look *almost* right, which is the worst outcome because nobody files
a bug for "almost".

**Tests** (`tests/mindmap-layout.test.ts`, `tests/mindmap-geometry.test.ts`):

1. **No overlap.** A 50-node tree of varied title lengths, laid out, no two
   node rects intersect. This is the test that would have caught every layout
   bug r-node has ever had.
2. **Manual positions survive** a layout pass, and siblings flow around them.
3. **Balance.** Children distribute left and right of the root rather than
   piling on one side.
4. **Edges stop at the border.** `bezierEnterRect` returns a point on the rect
   edge, not inside it.
5. **`edgePath` output parses** as a valid SVG path and both endpoints lie on
   the respective rect borders.

Do not import `ops.ts`, `storage.ts` or anything Vue.

## Lane C — storage and the chart schema

The test runner and `fake-indexeddb` already exist; Round 0 landed them. You
own neither `package.json` nor `vite.config.ts` — if you need another dependency,
report it rather than adding it.

### storage.ts

Sheets live in IndexedDB, never in localStorage.

- DB `thoughtslibrary-mindmaps`, version 1, store `sheets`, keyed by
  `crypto.randomUUID()`.
- Mirror `src/helpers/assets.ts` for the open and failure posture: an
  unavailable IndexedDB degrades, it never throws during startup.
- Store the `Sheet` object directly. IndexedDB structured-clones it; do not
  stringify.
- `blankSheet(title)` returns a valid single-root sheet.

### src/types.ts

Add one field to `Chart`, beside `relatedLayers`, copying the reasoning in the
comment above it because the rule is identical:

```ts
  // Keyed by ChartItem.id for the same reason relatedLayers is: moving,
  // swapping or resizing rearranges coordinates, and an id-keyed entry
  // re-finds its tile wherever it lands. The VALUE is a sheet id, not a
  // sheet — the bytes live in the mindmaps IndexedDB store, because a chart
  // goes to localStorage and one 400-topic map would eat the whole quota.
  mindmaps?: Record<string, string>
```

Grid tiles only. A `Selection` of `kind: 'layer'` never gets a mindmap.

**Tests** (`tests/mindmap-storage.test.ts`) through `fake-indexeddb`: write and
read back a sheet unchanged; `readSheet` of an unknown id returns `null`;
`deleteSheet` removes it; a missing IndexedDB degrades instead of throwing.

## Round 1 sync point

Merge A, B and C into `main` in that order. `npm run lint`, `npm run build` and
`npm test` must be green on `main` before Round 2 branches. **Do not start
Round 2 against an unmerged Round 1.**

---

# ROUND 2 — the UI

**Round 2 is being done by ONE agent, working through Lanes D, E and F in that
order on a single branch.** The file-ownership table in §0.4 no longer
partitions work between agents; read it now as the list of files this task is
allowed to touch, and nothing outside it.

Two things still hold, and they matter more here than they did in Round 1:

- **§0.3 is still frozen.** Lanes D, E and F already have callers and tests
  written against those signatures. Changing one to suit the component you are
  writing at that moment breaks the two you already finished.
- **Finish and verify a lane before starting the next.** E is testable the
  moment it renders a supplied sheet; F is the only lane that edits existing
  files. Carrying an unfinished E into F means debugging two new things at
  once, in the one part of this build that tests cannot catch for you.

Lane D landed in Round 1 — it is already on `main`, with 17 tests. Start at
Lane E.

## Lane D — the mindmap store

`src/mindmap/store.ts`, a pinia store separate from the chart store,
implementing the interface frozen in §0.3 exactly.

Follow this repo's existing idiom: **replace state objects, never mutate them
in place**, as `src/store.ts` does with `chart`. Ops mutate a draft and the
store publishes the result as a new reference — that is what makes Vue's change
detection cheap and lets `shallowRef` work.

Do not deep-`ref` the node map. Several hundred proxied objects re-read every
frame is the one performance mistake this design is otherwise free of.

`applySizes` is how measurement reaches layout: Lane E measures the DOM and
calls it; the store runs `layoutSheet` and republishes. `undo()` and `redo()`
return a boolean — `false` when this history is empty, which is what lets Lane
F fall through to the chart's own undo stack.

Autosave through `writeSheet` on a debounce. Never write a sheet into the chart
store.

**Tests**: open → createChild → undo → redo round-trips; `undo()` returns
`false` on a freshly opened sheet and `true` after one edit.

## Lane E — rendering

Three components. No store logic, no persistence — call §0.3 only.

- **`MindmapCanvas.vue`** — one absolutely-positioned container, pan and zoom
  via a **single CSS `transform`** on it. Not per-node transforms. This is the
  most important line in your lane: one transform is a GPU compositor
  operation, so panning costs the same at 3,000 topics as at 30 — nothing
  re-layouts, re-paints or re-renders. Per-node transforms turn every pan frame
  into a full layout pass, which is how naive DOM canvases die.
- **`MindmapNode.vue`** — one topic. Apply Lane B's constants as CSS
  (`min-width`, `max-width`, `padding`, `line-height`) and let the browser
  wrap. **Do not write a text measurer.**
- **`MindmapEdges.vue`** — **one** `<svg>` beneath the topics for all edges,
  sized to the map bounds, paths from `edgePath`. Match `TileLinks.vue`.

**Measurement order matters.** Render topics, read *all* sizes, then call
`applySizes` once. Reading `offsetWidth` after a write forces synchronous
reflow; interleaving read/write per node turns a 200-node map into hundreds of
forced reflows and will feel broken on the first real map, not in testing.

**`v-for` over the store's `visibleNodes` getter, never the raw node map.** In
S1 it returns everything. It exists so that switching on viewport culling later
is a change to one getter rather than a restructuring of your components.

Inherit the chart's own `font` and `textColor` so a map looks like the chart it
lives in. This is the main thing a native build buys over embedding r-node —
do not throw it away by hard-coding a palette.

## Lane F — overlay and integration

The only lane that touches existing files. Be conservative in all of them.

**`MindmapOverlay.vue`** (new): hosts Lane E's canvas, opened from a grid tile.
S1 editing surface and nothing beyond it — create child, create sibling, rename
in place, delete, collapse/expand, pan, zoom, fit. No inspector, no styling, no
images; those are S2 and S3.

The backdrop goes **near-opaque**, not the 45% wash focus mode uses. That wash
exists because related-layer tiles line up with the grid cells beneath them, so
showing the grid through is informative. A mindmap pans and zooms freely, so a
half-visible grid behind it lines up with nothing and reads as a rendering bug.

**`src/store.ts`** (existing): add `mindmapKey: Selection | null` beside
`notesPopupKey`, and open/close it exactly the way notes do. Add nothing else.

**`src/components/ChartBuilder/Chart/Item.vue`** (existing): the entry point
that opens a mindmap for a grid tile. Follow how the notes popup is opened.

**`src/components/TitlesSidebar.vue`** (existing): extend the **existing**
`handleUndoHotkey` at line 107. Do not add a second window listener — both
would fire on every press. Order: contenteditable check (unchanged) →
text-field check (unchanged) → **mindmap overlay** → chart undo. While the
overlay is open Ctrl+Z belongs to the mindmap; when `store.undo()` returns
`false`, fall through to the chart stack rather than swallowing the key.

From the chart's point of view an entire editing session is one change: push a
single snapshot onto `chartUndoStack` when the overlay opens, and none while it
is open.

**The related-layer ring is not affected by this task.** Right-click focus mode
keeps its current lattice behaviour. Do not merge, replace or unify the two.

---

# §T — Traps. Every lane reads this.

**1. Do not port `measure.ts`.** 1,222 lines of canvas text measurement. On a
DOM renderer it becomes a second opinion about text size that will disagree
with the browser's, and when they disagree the browser wins and your layout is
wrong. Take the geometry helpers (Lane B) and nothing else.

**2. Layout must never enter history.** It is derived. An op changes the tree;
layout recomputes positions from it. Put positions in an op and undo starts
fighting the layout engine — and the bug presents as "undo sometimes moves
things", which is close to untrackable later.

**3. `position.manual` is a promise.** A user who drags a topic has said where
it goes. A layout pass that quietly reflows it destroys work silently.

**4. Measure before you position, once, in batch.** See Lane E.

**5. Never put a sheet in localStorage.** Not the sheet, not a cached copy, not
"just the titles for search". `Chart.mindmaps` holds ids. The moment sheet
content reaches the pinia chart, the debounced write in
`LocalStorageWatcher.vue` puts it in localStorage and the quota dies quietly —
`isStorageQuotaExceeded` catches it and the user simply stops getting saves.

**6. Know the DOM ceiling, and which axis it is on.** Measured against the real
documents in `C:\Users\39389\Downloads`, existing maps run 18–67 topics with
one outlier near 3,000. r-node's own stated goal is 1,000 nodes
(`docs/LANE_C.md:201`); 8,000 is its stress ceiling, not its target. DOM is
comfortable to ~1,000–2,000 and degrades past that on *mount and edit*, not on
pan and zoom, which the single-transform rule makes flat. The axis that
actually bites is **images, not topics** — those same documents run 364 MB at
18 topics and 14 MB at 67. On that axis DOM wins: `<img>` gets decode
scheduling, memory management and lazy loading free, whereas canvas forced
r-node to hand-build bitmap caches with byte budgets (`TEXT_BUDGET` 64 MB,
`IMAGE_BUDGET` 128 MB in `render/renderer.ts`). Do not rebuild any of that.

**7. Do not reimplement the notes editor, the asset store, or the colour
picker.** Tiles already have all three, and S2/S3 must reuse them. A mindmap
storing images differently from tiles is two asset systems in one app, and the
orphan sweep in `collectUnusedAssets` only knows about one.

**8. Do not "fix" another lane's file.** Rule 2 in the header. Report it.

---

# Definition of done — per lane

**Every lane**: `npm run lint`, `npm run build`, `npm test` green, and no file
touched outside its row in §0.4.

**A**: every op's inverse restores the sheet exactly; redo invalidation works.
**B**: 50-node layout has zero overlapping rects; manual positions survive.
**C**: a sheet round-trips through fake-indexeddb; a missing IndexedDB degrades instead of throwing.
**D**: open → edit → undo → redo round-trips; `undo()` reports exhaustion.
**E**: a canvas renders a supplied sheet, pans and zooms, with edges meeting
borders cleanly.
**F**: a grid tile opens a mindmap, topics can be created, renamed, deleted and
collapsed, the map survives a full page reload, and Ctrl+Z falls through to the
chart when the map's history is empty.

**Integration, after F merges**: build a map on a tile, reload the page, reopen
it — and inspect the `charts` localStorage key to confirm it holds an **id**,
not a tree.

If a step cannot be completed, say so plainly in your final message with what
you tried, and list any change you needed in a file you did not own. A
half-finished lane with an honest account is worth more than a green one
achieved by disabling a check or editing someone else's file.
