# Task: mindmap S4 — rich text, relationships and groups, and the editing model

Stage 4 of the mindmap work, and the largest. It closes the gaps recorded in
`docs/RNODE_THOUGHTSLIBRARY_FUNCTIONAL_PARITY_AUDIT.md`.

Read §0, your own lane, and §T. **Skip the other lanes entirely.**

> **Round 0 is DONE.** The seam described in §0.5 is landed and every signature
> in §0.3 is real code you can compile against today. Three details differ from
> the first draft of this brief and §0.3 below has been corrected to match what
> shipped: `Sheet.schemaVersion` is a **string**, `MindmapTopicContent` takes
> two extra optional props, and `WriteResult`'s success arm carries
> `error?: undefined`. Lanes start at Round 1.

---

## READ THIS FIRST — how not to step on each other

Three rules. Breaking any one of them costs more than the work it saves.

1. **You may only create or edit files your lane owns.** The ownership table in
   §0.4 is exhaustive. A file not listed against your lane is not yours, even
   if the change is one line, even if the file is obviously wrong.
2. **If you need a change in a file you do not own, stop and write it in your
   final message.** Do not make it. Do not work around it by duplicating the
   thing into a file you do own. Two agents editing one file is a merge
   conflict a human resolves by hand.
3. **Code against §0.3, not against the other lanes' source.** Those signatures
   are frozen. If one is wrong, say so in your final message rather than
   changing it — another agent is already compiling calls against it.

Work happens in **two rounds**. Round 0 is one agent alone, cutting the seams
the three lanes need; it adds no features and must be merged to `main` before
any lane branches. Round 1 is the three lanes, in parallel, sharing no file.

---

# §0 — Shared ground

## §0.1 Repo, verification, style

`C:\Users\39389\Desktop\crazy ai repo\thoughtslibrary` — Vue 3 + TypeScript +
Vite + pinia.

Three agents cannot share one working directory: concurrent `npm test` and git
operations race. One git worktree per lane, each branched from `main` **after
Round 0 is merged**. From the repo root, in PowerShell (this shell has no
`&&`; run the lines one at a time):

```powershell
git worktree add ../tl-s4-a -b feat/mindmap-richtext main
```

```powershell
git worktree add ../tl-s4-b -b feat/mindmap-relations main
```

```powershell
git worktree add ../tl-s4-c -b feat/mindmap-interaction main
```

Each worktree needs its own `npm install`.

Every lane leaves these green:

```
npm run lint
```

```
npm run build
```

```
npm test
```

House style: `@antfu` eslint config — no semicolons, single quotes, 2-space
indent. Comments explain *why* a rule exists, never what a line does. Match the
surrounding code, which is heavily commented with the reasoning behind each
guard. A comment that restates the code will be removed in review.

## §0.2 What already exists, and why that matters

`src/mindmap/ops.ts` already implements **24 op types with their inverses**,
including `moveNode`, `sortSiblings`, `setPosition`, `setTitle` with
`titleRuns`/`prevRuns`, and the full `createRelationship` / `deleteRelationship`
/ `setRelationship` / `createGroup` / `deleteGroup` / `setGroup` set. The store
uses **five** of them. `src/mindmap/types.ts` already defines `TextRun`,
`Relationship`, `Group` and `Sheet.relationships` / `Sheet.boundaries`.

**Almost nothing in this brief needs a new op or a new type.** If you find
yourself writing one, re-read `ops.ts` first — you are probably rebuilding
something that is already there and already tested.

The seam that makes three parallel lanes possible is this public store action:

```ts
declare function commit(ops: Op[]): void
```

It builds the copy-on-write draft, applies each op, records the inverses in
history, republishes the sheet and schedules the save. **Every new command in
this stage is a pure function that builds ops and calls `store.commit(...)`.**
That is why no lane needs to edit `src/mindmap/store.ts`.

## §0.3 The frozen contract

Round 0 lands all of this. Lanes compile against it and never change it.

```ts
// src/mindmap/types.ts — Round 0
/** What a selection entry points at. Delete acts on the primary ref's kind. */
export interface SelRef { kind: 'node' | 'relationship' | 'group', id: string }

// TextRun gains one field (T04 needs it and it is not there today):
//   strike?: boolean

// Sheet gains one field, so a migration has something to read:
//   schemaVersion?: string     // absent = predates the field
// A STRING, matching the SCHEMA_VERSION ('0.1.0') already at the top of
// types.ts. A parallel numeric vocabulary for the same idea is how the two
// quietly disagree.
```

```
// src/mindmap/store.ts — Round 0. Changed or new members only.
state:
  selection: SelRef[]                                   // was `string | null`
  saveState: 'clean' | 'pending' | 'saving' | 'error'
  saveError: string | null
  // Lane C sets it (type-to-edit, F2, the context menu's "rename"); Lane A's
  // MindmapNode watches it, opens its editor, and clears it. The only channel
  // between the two lanes, and the reason neither needs the other's file.
  pendingEdit: { nodeId: string, seed: string } | null
getters:
  selectedNodeIds: string[]        // ids of the 'node' refs, in selection order
  primaryNodeId: string | null     // last 'node' ref, or null
actions:
  select: (ref: SelRef, mode?: 'replace' | 'toggle') => void   // default replace
  selectMany: (refs: SelRef[]) => void
  clearSelection: () => void
  isSelected: (ref: SelRef) => boolean
  rename: (nodeId: string, title: string, runs?: TextRun[]) => void
  requestEdit: (nodeId: string, seed?: string) => void   // sets pendingEdit
  clearPendingEdit: () => void
  commit: (ops: Op[]) => void      // unchanged, and now the documented seam
```

```html
<!-- MindmapNode.vue's root element, from Round 0 on. Lane C resolves a
     pointer target with event.target.closest('[data-node-id]') rather than
     adding a handler per topic, so MindmapNode stays Lane A's alone. -->
<div class="mindmap-node" :data-node-id="node.id" …>
```

```ts
// src/mindmap/storage.ts — Round 0 changes the write signature, then Lane C
// owns the file.
// `error?: undefined` on the success arm is load-bearing: without it the union
// does not narrow reliably through pinia's action typing.
export type WriteResult = { ok: true, error?: undefined } | { ok: false, error: string }
export function writeSheet(id: string, sheet: Sheet): Promise<WriteResult>
```

```ts
// src/mindmap/richtext.ts — Lane A
export function runsToPlain(runs: TextRun[]): string
export function plainToRuns(text: string): TextRun[]
export function normaliseRuns(runs: TextRun[]): TextRun[]
export function runsFromHtml(html: string): TextRun[]
export function toggleMark(runs: TextRun[], start: number, end: number,
  mark: 'bold' | 'italic' | 'underline' | 'strike'): TextRun[]
export function setRunColor(runs: TextRun[], start: number, end: number,
  color: string | undefined): TextRun[]
export function setRunFontSize(runs: TextRun[], start: number, end: number,
  size: number | undefined): TextRun[]
```

```ts
// src/mindmap/relations.ts — Lane B (pure geometry, no store, no DOM)
export function relationshipPath(from: Rect, to: Rect, connector?: ConnectorStyle): string
export function relationshipHit(from: Rect, to: Rect, connector: ConnectorStyle | undefined,
  x: number, y: number, tolerance: number): boolean
export function groupBounds(memberRects: Rect[], pad: number): Rect | null

// src/mindmap/relationCommands.ts — Lane B (op builders; Lane C calls these)
export function addRelationship(store: MindmapStore, fromId: string, toId: string): string
export function removeRelationship(store: MindmapStore, id: string): void
export function updateRelationship(store: MindmapStore, id: string, patch: Partial<Relationship>): void
export function addGroup(store: MindmapStore, memberIds: string[]): string
export function removeGroup(store: MindmapStore, id: string): void
export function updateGroup(store: MindmapStore, id: string, patch: Partial<Group>): void
```

```ts
// src/mindmap/commands.ts — Lane C (op builders)
export function moveNode(store, id: string, toParentId: string, index: number): void
export function duplicateNode(store, id: string): string | null
export function createParent(store, id: string): string | null
export function expandAll(store, id: string): void
export function removeMany(store, ids: string[]): void
export function pasteSubtrees(store, payload: ClipboardPayload, intoParentId: string): string[]

// src/mindmap/clipboard.ts — Lane C
export interface ClipboardPayload { kind: 'thoughtslibrary/mindmap', nodes: MindNode[], roots: string[] }
export function serialiseSubtrees(sheet: Sheet, ids: string[]): ClipboardPayload
export function remapIds(payload: ClipboardPayload): ClipboardPayload
export function toOutlineText(sheet: Sheet, ids: string[]): string

// src/mindmap/keymap.ts — Lane C (pure: event in, command name out)
export type Command = 'sibling' | 'child' | 'delete' | 'edit' | 'toggle'
  | 'navUp' | 'navDown' | 'navLeft' | 'navRight' | 'undo' | 'redo'
  | 'copy' | 'cut' | 'paste' | 'copyOutline' | 'duplicate' | 'expandAll'
  | 'fit' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'typeToEdit'
export function resolveCommand(event: KeyboardEvent): Command | null
```

Component props, frozen:

```ts
// MindmapTopicContent.vue — Lane A. Mounted by MindmapNode AND by the hidden
// measure layer. Both must render identical markup or measurement lies.
//   `measuring` — rendered in the measure layer: skip resolving the image
//     bytes, which the box never depended on (S3 C.2b). Nothing else differs.
//   `hideTitle` — the live topic hides the title while its editor is open.
defineProps<{ node: MindNode, measuring?: boolean, hideTitle?: boolean }>()

// MindmapGroups.vue, MindmapRelations.vue — Lane B
defineProps<{ nodes: MindNode[], sizes: Record<string, NodeSize>, viewport: Viewport | null, margin: number }>()

// MindmapInteraction.vue — Lane C
defineProps<{ viewport: Viewport | null, sizes: Record<string, NodeSize> }>()

// MindmapTextToolbar.vue (A), MindmapRelationPanel.vue (B),
// MindmapCommandBar.vue (C) — no props; they read the store.
```

## §0.4 File ownership — exhaustive

| Lane | Owns exclusively |
|---|---|
| **Round 0** | Everything shared: `src/mindmap/types.ts`, `store.ts`, `storage.ts`, `cull.ts`, and all four `.../Chart/Mindmap{Overlay,Canvas,Node,Edges}.vue` — plus the creation of every stub file below. It is the only round allowed to touch a file two lanes will later need. |
| **A** | `src/mindmap/richtext.ts`, `.../Chart/MindmapNode.vue`, `.../Chart/MindmapTopicContent.vue`, `.../Chart/MindmapTextToolbar.vue`, `tests/mindmap-richtext.test.ts` |
| **B** | `src/mindmap/relations.ts`, `src/mindmap/relationCommands.ts`, `src/mindmap/exportMap.ts`, `.../Chart/MindmapRelations.vue`, `.../Chart/MindmapGroups.vue`, `.../Chart/MindmapRelationPanel.vue`, `tests/mindmap-relations.test.ts` |
| **C** | `src/mindmap/keymap.ts`, `src/mindmap/commands.ts`, `src/mindmap/clipboard.ts`, `src/mindmap/storage.ts` *(after Round 0)*, `.../Chart/MindmapCanvas.vue`, `.../Chart/MindmapInteraction.vue`, `.../Chart/MindmapCommandBar.vue`, `tests/mindmap-keymap.test.ts`, `tests/mindmap-commands.test.ts`, `tests/mindmap-clipboard.test.ts` |

**Read-only for every lane after Round 0:** `types.ts`, `store.ts`, `ops.ts`,
`history.ts`, `layout.ts`, `geometry.ts`, `nodeStyle.ts`, `cull.ts`,
`MindmapEdges.vue`, `MindmapOverlay.vue`.

Two notes on the table:

- **Lane C owns `MindmapCanvas.vue` but must not remove or reorder the three
  mount points Round 0 puts there** (`MindmapGroups`, `MindmapRelations`,
  `MindmapInteraction`). Their stacking order is the render order.
- `src/mindmap/store.ts` (the mindmap store) and `src/store.ts` (the chart
  store) are different files. Neither is editable in Round 1. Check the path,
  not the basename.

## §0.5 Round 0 — the seam. DONE; here for reference.

**Round 0 shipped no feature: the app behaves exactly as it did before.** Six
jobs, all landed. Read it to understand what is already there for you — do not
redo any of it.

**1. Typed multi-selection.** `selection: string | null` → `selection: SelRef[]`
per §0.3. Update every reader: `MindmapNode.vue`'s `isSelected`, the Inspector
in `MindmapOverlay.vue` (which reads a single selected node — point it at
`primaryNodeId`), and `publish()`, which today nulls a selection pointing at a
removed node and must now filter dead refs of all three kinds. `select()` keeps
its single-argument call sites working via the default `'replace'` mode.

**1b. The two cross-lane channels.** `pendingEdit` + `requestEdit` /
`clearPendingEdit` per §0.3, and `:data-node-id="node.id"` on
`MindmapNode.vue`'s root element. Neither does anything on its own. They exist
so Lane C can open Lane A's editor and target Lane A's topics without either
lane opening the other's file — without them, both lanes stall on the same
merge conflict in week one.

**2. Extract the topic content.** `MindmapNode.vue` renders the image slot and
the title span; the hidden measure layer in `MindmapCanvas.vue` renders the
*same* markup by hand. Two copies of one box is exactly the divergence S2's
"one stylesheet, one box" rule exists to prevent, and Lane A is about to make
that markup much richer. Move it into `MindmapTopicContent.vue` and mount that
component in both places. No visual change, no style change — the CSS classes
stay where they are.

**3. `sizeKey` folds the runs.** In `cull.ts`, add `titleRuns` to the JSON blob
`sizeKey` builds. Without this, bolding a word leaves the topic on its stale
box until some unrelated edit repaints it.

**4. Two schema fields.** `TextRun.strike?: boolean` and
`Sheet.schemaVersion?: number`. Nothing reads them yet.

**5. Save status, plumbed.** `writeSheet` returns `WriteResult` per §0.3
instead of resolving on failure. The store gains `saveState` / `saveError`:
`'pending'` when `scheduleSave` arms the timer, `'saving'` across the write,
`'clean'` or `'error'` on the result. `flushSave`'s `.catch(() => {})` becomes
a catch that records the error. **The autosave policy does not change** — this
makes an existing silent failure visible, nothing more. Today a quota-exhausted
IndexedDB means an hour of editing is lost with one line in the console.

**6. Create the stubs and mount them.** Seven files, each a component that
renders nothing and takes the props in §0.3, so the three lanes each open a
file that already exists and already compiles:

| Stub | Mounted in | For |
|---|---|---|
| `MindmapTopicContent.vue` | `MindmapNode.vue` + measure layer | A |
| `MindmapTextToolbar.vue` | `MindmapOverlay.vue` | A |
| `MindmapGroups.vue` | `MindmapCanvas.vue`, under the edges | B |
| `MindmapRelations.vue` | `MindmapCanvas.vue`, over the topics | B |
| `MindmapRelationPanel.vue` | `MindmapOverlay.vue`, in the inspector column | B |
| `MindmapInteraction.vue` | `MindmapCanvas.vue`, last child of the canvas | C |
| `MindmapCommandBar.vue` | `MindmapOverlay.vue`, beside the toolbar | C |

(`MindmapTopicContent.vue` is not a stub — job 2 fills it with the markup it
moved.)

## §0.6 Out of scope for S4

Named so nobody builds them speculatively: summaries and the summary brace,
tasks/labels/markers, floating topics, structure/orientation/spacing controls,
image slots beyond `top`, the gallery body, command palette and outliner,
per-node styling across a multi-selection, `.rnode` file interchange (dropped
in S2, and still dropped), and the decoded-image LRU. The last one is
**measurement debt, not a feature**: nobody builds a byte-budgeted bitmap cache
until a benchmark shows the browser's own behavior is not enough.

---

# ROUND 1 — Lane A: rich text in topic titles

Closes T01–T09, T12, T13, F16, F17, F19, F20, F26.

## A.1 The model, and the invariant that outranks everything

A title is a flat sequence of `TextRun`s. `MindNode.title` stays a plain
string and is **always** the plain-text projection of `titleRuns`:

```
node.title === runsToPlain(node.titleRuns ?? [])
```

`types.ts:297` already states this rule. Every other consumer in the product
reads `title` — the tile indicator, the chart save file, Lane C's outline copy,
the tests. Break the invariant and they all silently show stale text while the
map looks perfect. **Write this invariant as a test before you write the
editor**, and assert it after every mutation path in `richtext.ts`.

`titleRuns` absent means "a single plain run". Never write
`titleRuns: [{ text: title }]` for an unstyled title — an unstyled node keeps
`titleRuns` undefined, so a map that never used formatting does not grow a
parallel representation of itself in every save file.

Block structure lives on the runs, per the `types.ts` comments: `paraGap` opens
a paragraph, `listIndent > 0` starts a bullet at that depth, `fontSize` carries
a heading. A soft line break inside a paragraph is a `\n` in `run.text` — the
topic box is already `white-space: pre-wrap`, so it renders without any new
mechanism.

## A.2 `richtext.ts`

Pure, no DOM globals beyond `DOMParser`, no store. The API is frozen in §0.3.

`normaliseRuns` is the workhorse and every other function ends by calling it:
drop empty runs, merge adjacent runs whose marks are identical, and drop marks
set to `false`. Without it, toggling bold on and off ten times leaves twenty
runs that all compare unequal in `sizeKey` and re-measure the topic each time.

Offsets in `toggleMark` / `setRunColor` / `setRunFontSize` are **plain-text
offsets** into `runsToPlain(runs)`, not run indices. That is the only
coordinate system the editor's `Selection` can give you, and converting once at
the boundary is far cheaper than teaching every caller about run splitting.

`toggleMark` is a toggle over a range: if every character in the range already
has the mark, remove it; otherwise add it everywhere. Anything else surprises
the user on a partially-bold selection.

## A.3 `runsFromHtml` — the paste path

Word, Google Docs and Draw.io all paste `text/html`. Parse it with `DOMParser`
and walk the tree. **Never inject the pasted HTML into the document** — no
`v-html`, no `insertAdjacentHTML`, not even into a detached node you then read
back. You build runs from the parsed tree and render runs as your own elements;
that is what makes sanitisation total rather than a blocklist you have to keep
ahead of.

Map:

- `<b>`, `<strong>`, `font-weight >= 600` → `bold`
- `<i>`, `<em>`, `font-style: italic` → `italic`
- `<u>` → `underline`, `<s>`/`<strike>`/`<del>` → `strike`
- `color:` on an inline style → `color`
- `<h1>`–`<h6>` → `fontSize` (a fixed table, not the source's px) + `paraGap`
- `<p>`, `<div>`, `<br>` → paragraph boundary / `\n`
- `<li>` → `listIndent` = nesting depth of the enclosing `<ul>`/`<ol>`
- **everything else contributes only its text**: `<script>`, `<style>`,
  `<meta>` and `<o:p>` contribute nothing at all.

Word pastes a `<style>` block and `mso-` classes; Google Docs wraps everything
in `<b style="font-weight:normal">`, which a naive tag walk reads as bold for
the whole document. Handle the second one — check the inline `font-weight`
before trusting the tag — and test both with a real captured clipboard string
committed as a fixture.

Cap the result. A paste of a 400-page document into one topic must not build a
40,000-run title; truncate at a stated limit (2,000 characters is generous) and
stop. `title` stays the truncated plain text, so the invariant holds.

## A.4 The editor

`MindmapNode.vue` keeps its shape: double click opens a `contenteditable`, blur
and Enter commit, Escape cancels and restores the exact prior content. What
changes:

- The editor is seeded with the *rendered runs*, not `textContent`.
- On commit, read the editor's DOM back through the same walker `runsFromHtml`
  uses, and call `store.rename(id, runsToPlain(runs), runs)`. One op, one undo
  entry, exactly as today.
- `Ctrl/Cmd+B`, `I`, `U` apply `toggleMark` to the current `Selection` and
  re-seed the editor. Nothing else in the map may consume those keys.
- **`Ctrl+Z` inside the editor stays the browser's.** The existing comment in
  `MindmapNode.vue` explains why: the contenteditable owns its own text history
  and the map's undo must not fight it. Lane C's keymap bails on
  contenteditable, so this keeps working — do not add a handler that breaks it.
- Escape must keep calling `stopPropagation`, or the overlay closes underneath
  the cancelled edit.
- **Watch `store.pendingEdit`.** Lane C's F2, type-to-edit and context menu all
  open this editor by calling `store.requestEdit(nodeId, seed)`; the matching
  node opens its editor seeded with `seed` and calls `clearPendingEdit()`. That
  is the entire cross-lane protocol, and it is why Lane C never opens this file.

**The empty title (F26).** A node created and then left blank stays as an empty
box forever. This is yours because the commit path is yours: on commit of an
empty title, delete the node when it is a childless leaf whose title was never
set; otherwise restore the previous title unchanged. Deleting goes through
`store.remove(id)`, so `Ctrl+Z` brings the node back — the user who blanked a
title by accident must not lose the node with no way back.

`MindmapTextToolbar.vue` is the visible affordance for the same commands: it
renders only while an editor is open, positions itself over the edited node
(read `store.camera` and the node's position — the world transform is a single
CSS transform, so screen = world * scale + camera), and applies bold, italic,
underline, strike and a colour swatch to the current selection.

## A.5 Rendering, and the measurement trap

`MindmapTopicContent.vue` renders the runs: one `<span>` per run carrying its
marks, `<br>` at a paragraph gap plus the `paraGap` margin, and a hanging
indent for `listIndent`. Keep it to spans and CSS — no nested block elements,
because the box is already sized by the shared `.mindmap-node` class.

**Round 0 mounted this same component in the hidden measure layer.** That is
not incidental: if the topic renders bold and the measure layer renders plain,
every formatted title measures short, layout packs the boxes too tightly, and
the map subtly overlaps everywhere. If you find yourself adding markup to
`MindmapNode.vue` that is not inside `MindmapTopicContent.vue`, stop — that
markup will not be measured.

## A.6 Tests — `tests/mindmap-richtext.test.ts`

- The plain-text invariant after every mutating function, including paste.
- `normaliseRuns` merges and drops: bold-on then bold-off returns one run.
- `toggleMark` across a partially-marked range marks the whole range.
- Offsets land correctly when the range starts and ends mid-run.
- `runsFromHtml` against a committed Word fixture and a committed Google Docs
  fixture: the Google one must **not** come back entirely bold.
- `<script>alert(1)</script>` contributes no run and no element.
- A 100,000-character paste is truncated and does not hang.

---

# ROUND 1 — Lane B: relationships, groups, and getting the map out as a picture

Closes F11, R05, R06, P15, and E04/E05.

## B.1 The data already exists

`Sheet.relationships: Relationship[]` and `Sheet.boundaries: Group[]` are in
the schema. `ops.ts` implements create/delete/set for both, with inverses, and
`applyWithInverse` already handles them. `relationCommands.ts` is thin by
design: build the op, call `store.commit([op])`, return the new id.

Because both live inside `Sheet`, and S3 Part A inlines whole sheets into the
saved chart, **relationships and groups already travel in the save file.** Do
not add a second export path for them, and do not touch `src/helpers/imports.ts`
or `assets.ts`.

## B.2 Relationships — `MindmapRelations.vue`

An SVG layer inside the world container, over the topics. It takes the same
props `MindmapEdges.vue` takes, and follows its structure closely — read that
file first, it is the pattern for this one.

- Geometry comes from `relations.ts` and depends on world data only, never
  on the camera, so a pan rebuilds nothing. `MindmapEdges` explains why in a
  comment; the same reasoning applies here.
- Honour `connector` (`'curved'` absent-default, `'straight'`, `'elbow'`),
  `color` (absent = theme), `lineStyle` dashes, `bidirectional` (arrowhead at
  both ends), and `label` (a centred `<text>` with a background rect so it
  reads over an edge).
- **Hit testing:** `MindmapEdges` sets `pointer-events: none` on its `<svg>`
  precisely so clicks reach the topics. Keep that on your `<svg>` too, and
  re-enable it only on the hit shapes: draw each relationship twice, an
  invisible `stroke-width: 12` path with `pointer-events: stroke` for the hit,
  and the visible path with `pointer-events: none`. A transparent full-size
  rect over the map would swallow every click on a topic.
- Clicking a relationship calls `store.select({ kind: 'relationship', id })`.
  Selected state is a highlight on the visible path.
- **Creating one:** when exactly one node is selected, draw a small anchor
  handle at the right edge of its rect. Dragging from the handle to another
  topic creates the relationship on pointerup. Do this inside your own layer —
  `MindmapNode.vue` belongs to Lane A and you must not add a handle there.

## B.3 Groups — `MindmapGroups.vue`

An SVG layer *under* the edges: a dashed rounded rect around the union of its
members' rects, plus an optional label at the top-left.

- `groupBounds` takes the member rects and a pad; it returns `null` when no
  member resolves, and the layer draws nothing for that group.
- **Members that no longer exist are skipped, not pruned.** Deleting a topic
  leaves its id in `Group.memberIds`, and that is correct: `restoreNode` puts
  the topic back on undo and the group re-encloses it for free. A tidy-up pass
  that prunes memberIds on delete would make undo silently lose group
  membership. Filter at render time and leave the data alone.
- `Group.borderWidth` is in **screen** pixels — `types.ts` says so. Divide by
  `store.camera.scale` when you draw, so a boundary stays as thick as it was
  drawn at every zoom level.
- Same two-path hit-testing rule as relationships, on the border stroke only:
  the inside of a boundary must stay clickable, or a group makes every topic it
  encloses unselectable.
- Creating one: with two or more nodes selected, "Group selection" in
  `MindmapRelationPanel.vue` calls `addGroup(store, store.selectedNodeIds)`.

## B.4 `MindmapRelationPanel.vue`

Lives in the overlay's inspector column. Renders per selection kind:

- 2+ nodes selected → "Group selection", "Connect" (2 nodes exactly).
- a relationship selected → label, colour, line style, connector,
  bidirectional, delete.
- a group selected → label, colour, border width, delete.
- nothing relevant selected → nothing at all. Do not render an empty panel
  frame.

Every control goes through `updateRelationship` / `updateGroup`, so `Ctrl+Z`
undoes a colour change like any other edit.

## B.5 Map export — `exportMap.ts`

The mindmap cannot currently be exported in any visual form: the overlay is
marked `data-html2canvas-ignore`, so the chart's PNG and PDF paths skip it
deliberately, and there is no map-level export at all.

Export by **serialising the live world element**, not by re-drawing the model.
The DOM/SVG rendering choice was made in §0.2 of `MINDMAP_NATIVE_AGENT_BRIEF.md`
exactly so this pipeline comes free, and it means your export automatically
contains Lane A's rich titles and Lane C's nothing without either lane knowing
you exist.

- `exportSheetSvg(worldEl: HTMLElement, bounds: Rect): string` — wrap the
  cloned world in an `<svg><foreignObject>`, inline the computed styles it
  needs, and return the string.
- PNG goes through the same SVG via a canvas draw.
- Images inside topics are `local-asset://` object URLs, which are meaningless
  outside this session: resolve each to a data URI before serialising. There is
  already `inlineStoredImageUrl` in `src/helpers/assets.ts` — use it, do not
  write a second one.
- Bounds come from the union of all node rects plus a margin, **not** from the
  viewport. Exporting what happens to be on screen is not exporting the map.
- The buttons live in `MindmapRelationPanel.vue`.

## B.6 Tests — `tests/mindmap-relations.test.ts`

Geometry and commands are pure and testable without a DOM:

- `relationshipHit` returns true within tolerance of a curved path and false
  just outside it, at two different zoom scales.
- `groupBounds` returns `null` for an empty member list and skips unresolved
  members.
- `addRelationship` then `store.undo()` leaves `sheet.relationships` empty;
  redo restores it with the same id.
- Deleting a topic that a relationship references removes the relationship
  (the existing `deleteNode` op does this) **and leaves the group memberId in
  place**; undo restores both.

---

# ROUND 1 — Lane C: the editing model

Closes K01–K14, F03, F05, F06, F09, F10, F13, F15, F18, F21–F23, P02,
P07, P09–P13, S04, S05, S07, X05, X08, E08.

This is the largest lane by count and the one the audit calls the biggest
usability gap: today the only global key in the whole mindmap is Escape, and
the tree can only be built in the order the nodes were created.

Do the work in the order below. Each step is shippable on its own.

## C.1 `keymap.ts` — pure, and tested first

`resolveCommand(event)` maps a `KeyboardEvent` to a command name or `null`.
It touches no store and no DOM, which is what makes the whole keyboard layer
testable without mounting anything.

Bindings, matching r-node:

| Key | Command |
|---|---|
| `Enter` | `sibling` |
| `Tab` | `child` |
| `F2` | `edit` |
| `Space` | `toggle` |
| `Delete`, `Backspace` | `delete` |
| arrows | `navUp` / `navDown` / `navLeft` / `navRight` |
| `Mod+Z` | `undo` |
| `Mod+Shift+Z`, `Mod+Y` | `redo` |
| `Mod+C` / `X` / `V` | `copy` / `cut` / `paste` |
| `Mod+Shift+C` | `copyOutline` |
| `Mod+D` | `duplicate` |
| `Mod+=` / `Mod+-` / `Mod+0` / `Mod+1` | `zoomIn` / `zoomOut` / `zoomReset` / `fit` |
| any printable character, no modifier | `typeToEdit` |

Two rules that are not optional:

1. **`resolveCommand` returns `null` when the event target is
   `contenteditable`, an `<input>`, or a `<textarea>`.** Without this, pressing
   Enter to finish a rename creates a sibling, and every letter typed into
   Lane A's editor fires `typeToEdit`. The overlay's existing Escape handler
   already uses this check — copy its shape.
2. **`Tab` must `preventDefault`.** Otherwise focus walks out of the overlay
   into the chart behind it and the next keystroke goes somewhere unexpected.

`Shift+Tab` is deliberately **not** bound. r-node's own combo builder excludes
`Tab` from the Shift modifier, so its documented "promote" never fires — that
is a defect in the reference, recorded in the audit as K03, and reproducing it
would be absurd. Leave it unbound rather than inventing a behavior here.

## C.2 `MindmapInteraction.vue` — the controller

An invisible component, the last child of the canvas. It owns the window
keydown listener, the pointer gestures, and the transient visuals (marquee,
drop indicator, context menu). It calls `resolveCommand`, then dispatches into
`commands.ts`, the store, and — for `delete` on a relationship or group —
Lane B's `removeRelationship` / `removeGroup` from §0.3.

`delete` acts on the **primary selection's kind**: a node deletes the subtree
(root refuses, as today), a relationship deletes the relationship, a group
deletes the group.

`typeToEdit` and `edit` (F2) open Lane A's editor, which lives in
`MindmapNode.vue`. Do not reach into that component. Call
`store.requestEdit(nodeId, seed)` — Lane A watches `pendingEdit`, opens the
editor seeded with that string, and clears it. That is the whole protocol.

Arrow navigation is geometric: from the current node's rect, pick the nearest
node whose centre lies in the half-plane in that direction, weighting
perpendicular distance more heavily than parallel distance. A pure
parent/child/sibling walk feels wrong the moment the map has two sides.

## C.3 Node drag — by delegation

`MindmapNode.vue` belongs to Lane A. You must not add handlers there.

Round 0 put `data-node-id` on the topic root, so listen on the world container
and resolve the target with `event.target.closest('[data-node-id]')`. This is
also the cheaper design: one listener instead of one per mounted topic, on a
map that mounts hundreds.

- A drag past a small threshold (4px) starts a move; below it, it is a click,
  and a click selects (`Shift`/`Ctrl` → `toggle` mode).
- While dragging, resolve a drop target from the pointer position: the nearest
  topic, and which third of its box the pointer is in — top third `before`,
  bottom third `after`, middle `child`. Draw the indicator: a line for
  before/after, a ring for child.
- **The whole drag is ONE undo entry.** Build nothing until pointerup, then
  call `moveNode(store, ...)` once. A `commit` per pointermove gives the user
  four hundred undo steps for one gesture — this is the single most common way
  to get an op-based history wrong.
- Refuse a drop onto the dragged node's own descendant. `moveNode` would happily
  build a cycle, and a cycle in the tree hangs `layoutSheet`'s recursive walk.
- Dragging with several nodes selected moves all of them, still as one entry.

## C.4 Marquee, ground click, wheel

All three live in `MindmapCanvas.vue`, which is yours after Round 0.

- Dragging on the empty ground currently pans. Keep left-drag as pan, and add
  **`Shift`+drag as marquee** rather than swapping the default — panning by
  dragging the background is the gesture users of this app already have.
  Marquee selects every node whose rect intersects the region; `Ctrl` makes it
  additive.
- A ground click that did not become a drag calls `clearSelection()`.
- **Wheel:** today every wheel event zooms. Make plain wheel pan and
  `Ctrl`/`Cmd`+wheel zoom, which is both what r-node does and what a trackpad
  user expects — two-finger scroll should not fling the zoom level. Keep
  `zoomAt`'s cursor anchoring exactly as it is; only the trigger changes.
- Right-click on a topic opens the context menu: add child, add sibling,
  duplicate, create parent, expand all, delete. Right-click on the ground
  closes it.

## C.5 `commands.ts` and `clipboard.ts`

Every command is a function that builds ops and calls `store.commit(...)` once.
None of them touches `store.ts`.

- `duplicateNode` copies the subtree with fresh ids and inserts it after the
  original as a sibling.
- `createParent` inserts a new node between the target and its parent, taking
  the target as its only child. Refuse on the root.
- `expandAll` emits one `setCollapsed` op per collapsed descendant, in one
  batch, so it is one undo entry.
- `removeMany` deletes a set of nodes as one batch, skipping any node that is
  already inside another selected node's subtree — deleting a parent and its
  child in one gesture must not emit two overlapping subtree snapshots.

Clipboard:

- Copy writes **two** flavours to the system clipboard: `text/plain` (the
  indented outline, which is what `Mod+Shift+C` produces alone) and the
  structured payload as JSON. Read the JSON back on paste when it is there,
  fall back to creating nodes from plain text lines when it is not.
- **`remapIds` is mandatory on paste.** Pasting a payload with its original ids
  into the sheet it came from overwrites the originals and corrupts
  `childrenIds` on both sides. S3 A.4 learned this exact lesson with sheet ids;
  the failure mode here is worse because it is silent.
- Paste with rich titles: the payload carries whole `MindNode` objects, so
  `titleRuns` travels without this lane knowing what a run is. Do not strip it.

## C.6 Empty title, save status, migration, validation

Three smaller items, all real. (F26, the empty title, is Lane A's — the commit
path is in its file.)

- **Save status (S04/S07).** Round 0 plumbed `saveState`/`saveError`. Render
  them in `MindmapCommandBar.vue`: nothing at all when clean, a quiet
  indicator while saving, and a **loud, persistent** message on error. The
  error case is the entire point — an autosave that has been failing for twenty
  minutes must not look identical to one that is working.
- **Migration (S05).** `Sheet.schemaVersion` exists as of Round 0 and no stored
  sheet has it. `readSheet` gains a `migrate(sheet)` step: absent → treat as
  version 1, stamp it, and write it back. It does nothing today; it exists so
  the next field change has somewhere to live, and adding it after the fact
  means guessing what old data looked like.
- **Topology validation (X05).** `readSheet` returns whatever IndexedDB holds.
  A sheet whose `parentId`/`childrenIds` disagree, or that contains a cycle,
  sends `layoutSheet`'s recursive walk into a stack overflow and the overlay
  renders blank forever. Validate on load: walk from `rootNodeId`, and repair
  what is repairable — a node unreachable from the root is re-parented to the
  root, a `childrenIds` entry pointing at a missing node is dropped, a cycle is
  broken at the back edge. Log each repair. Never throw: a damaged sheet the
  user can still see beats a blank overlay.

## C.7 Tests

- `tests/mindmap-keymap.test.ts` — every binding, plus the contenteditable
  bail and `Tab`'s `preventDefault`. This file is cheap and catches the whole
  keyboard layer.
- `tests/mindmap-commands.test.ts` — one undo entry per command;
  `duplicateNode` produces fresh ids; `createParent` refuses the root;
  `removeMany` with a parent and its own child emits one delete;
  **a move onto a descendant is refused**.
- `tests/mindmap-clipboard.test.ts` — round trip preserves structure, order and
  `titleRuns`; pasting into the source sheet produces entirely new ids and
  leaves the originals intact.
- Storage: a sheet with a cycle loads, is repaired, and lays out.

---

# §T — Traps. Every lane reads this.

**T.1 The ops layer is done. Use it.** 24 op types with inverses already exist.
A new op type in this stage is almost certainly a mistake, and `ops.ts` is
read-only anyway — if you genuinely need one, stop and say so.

**T.2 One gesture, one undo entry.** Drag, marquee, expand-all, a multi-node
delete, a formatting toggle: each builds its ops and calls `commit` **once**.
Committing inside a pointermove or a keystroke loop is how an op-based history
becomes unusable.

**T.3 Layout is derived data.** It never enters an op and never enters history.
`applySizes` republishes the sheet without touching the undo stacks — do not
add a layout call to any command.

**T.4 The measure layer must render what the topic renders.** One component,
`MindmapTopicContent.vue`, mounted in both. If a lane adds visible content to a
topic outside that component, layout measures a box the browser will not draw,
and the whole map packs wrong. This is the bug class that cost S2 a full round.

**T.5 Nothing large goes into localStorage.** Sheets live in IndexedDB and the
chart holds only a `sheetId`. One 400-topic map in the `charts` key silently
exhausts the quota and the user simply stops getting saves.

**T.6 Autosave stays.** S4 makes failure *visible*; it does not introduce
manual save. A `Mod+S` binding is not in the keymap, on purpose.

**T.7 Do not reintroduce `.rnode` import or export.** Built in S2 and
deliberately removed. Mindmaps are authored here.

**T.8 Do not touch `layout.ts`, `ops.ts`, `history.ts`, `geometry.ts`,
`nodeStyle.ts` or `MindmapEdges.vue`.** Landed and tested. If one genuinely
needs a change, say so in your final message rather than making it.

**T.9 Pointer-events discipline in the SVG layers.** `MindmapEdges` is
`pointer-events: none` for a reason. A new layer that is not will eat every
click on the map and the bug will look like "selection is broken", not like
"the relationship layer is in the way".

**T.10 The plain-text invariant.** `node.title` is what the rest of the product
reads. It is always the plain projection of `titleRuns`.

---

# Definition of done

**Round 0:** the app builds, lints, tests green, and behaves *identically* to
before — same rendering, same interactions, same saves. Seven stub files exist
and are mounted. Anything that changes user-visible behavior in Round 0 is out
of scope and belongs to a lane.

**Lane A:** select a word in a topic, press `Ctrl+B`, and it is bold — in the
node, after a reload, and with the box re-measured to fit. Paste a formatted
paragraph from Google Docs and the emphasis survives while the layout markup
does not. `node.title` is still the plain text everywhere.

**Lane B:** connect two topics, label the line, group three topics, colour the
boundary, undo each with `Ctrl+Z`, reload and find them all. Delete a topic
inside a group and undo it — the group re-encloses it. Export the map to PNG
and open the file: the whole map, not the visible part, with its images.

**Lane C:** build a twenty-node map using only Enter, Tab and typing. Drag a
branch under a different parent and `Ctrl+Z` it in one step. Shift-drag a
marquee over six topics and delete them in one step. Copy a subtree, paste it,
and confirm in devtools that every pasted id is new. Pull the plug on IndexedDB
(devtools → Application → delete the database mid-session) and confirm the
error is loud rather than a console line.

If a step cannot be completed, say so plainly with what you tried.
