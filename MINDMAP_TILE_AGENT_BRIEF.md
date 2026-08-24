> **SUPERSEDED — do not implement.**
>
> This brief described embedding r-node as a `file:` dependency. That approach
> was abandoned in favour of a native Vue + SVG rebuild inside this repo.
> Follow `MINDMAP_NATIVE_AGENT_BRIEF.md` instead. Do not add r-node as a
> dependency of this repo.
>
> Kept for the reasoning in its trap list, several items of which still apply
> to the native build: localStorage quota, undo nesting, and the
> out-of-line-in-storage / inline-on-export rule for portable files.

# Task: give tiles an optional r-node mindmap — the seam only

Two repos. You are building the **plumbing** that lets an r-node mindmap live
inside a thoughtslibrary tile: storage, lifecycle, undo routing, packaging.
You are **not** building the editing UI.

## The one idea behind this task

Every hard problem in this integration comes from the same root: r-node's
`EditorStore` owns its own lifecycle — documents, storage backend, save timing.
thoughtslibrary owns those things too. Two owners, one set of bytes.

The fix is not to reconcile them. It is to **take that ownership away from the
engine at a single seam** and hand it to the host. Everything below follows
from that, and most of the seam already exists:

- `EditorStore` already takes its adapter by injection —
  `constructor(adapter: StorageAdapter = new LocalStorageAdapter())`
  (`src/editor/store.ts:299` in r-node).
- Its constructor does **zero I/O**. It builds an in-memory sample document.
- `execOps` never persists. It applies ops, records history, sets
  `sync: "dirty"`, schedules layout, notifies (`src/editor/store.ts:538`).
- `DocumentModel.sheet` is literally `doc.sheets[0]`, so wrapping a single
  sheet in a document is an object literal, not a refactor.

So you add an adapter that writes to the host instead of to a filesystem, and
a small facade that hands out a ready-made store. That is the whole engine-side
change. **You will not edit any existing r-node source file** except
`package.json` and `CLAUDE.md`.

---

## Repos, branches, and how to verify

### Repo A — r-node

`C:\Users\39389\Documents\XuanZhi9\r-node` — React 18 + TypeScript + Vite.
Currently on `main`, clean. Branch off it: `feat/embed-session`.

Read `docs/AGENT_GUIDE.md` before writing anything — it is the contract for
that repo, and §1 and §2 apply to you.

All three must pass clean:

```
npm test
npm run typecheck
npm run check:map
```

House style there: double quotes, semicolons, comments that explain *why* a
rule exists.

### Repo B — thoughtslibrary

`C:\Users\39389\Desktop\crazy ai repo\thoughtslibrary` — Vue 3 + TypeScript +
Vite + pinia. Currently on `feature/layer-canvas`. Branch off it:
`feat/mindmap-tiles`.

There is **no test runner**. Both must pass clean:

```
npm run lint
```

```
npm run build
```

House style there: `@antfu` config — no semicolons, single quotes, 2-space
indent. Comments explain *why*, matching the surrounding code, which is
heavily commented with the reasoning behind each guard.

---

## In scope / out of scope

**In scope.** The `SheetSession` facade and host adapter in r-node; sheet
storage in thoughtslibrary's IndexedDB; the `mindmaps` field on `Chart`;
export/import round-tripping; undo routing; the package wiring; one minimal
overlay that exists to prove the round-trip works.

**Out of scope — do not build these, do not "while I'm here" them.**

- The r-node editing chrome (Inspector, Toolbar, Outliner). Those are React and
  stay in r-node.
- Rich text / Lexical. Titles are plain strings via `plainToRuns` /
  `runsToPlain` for now.
- Any asset *adapter*. See trap 1 — r-node's own store already works here and
  writing a bridge to thoughtslibrary's would be actively wrong. Note this is
  not the same as A2b's pack/unpack, which is required: the adapter question is
  "where do live bytes go" (answered), packing is "how do bytes leave in a
  file" (still yours to build).
- Any change to the 17 `instanceof TauriStorageAdapter` branches in r-node's
  store. See trap 2.
- Making the two undo models agree. See trap 5.

---

# Part A — r-node

## A1. `src/persist/hostAdapter.ts` (new file)

A `StorageAdapter` whose backing store is a callback owned by the host. This
is what makes the engine storage-less without touching the engine.

```ts
/**
 * Persistence for an EMBEDDED sheet — one whose bytes belong to a host
 * application, not to R-node.
 *
 * The editor's dirty→save→saved machinery, including the one-position save
 * queue, is worth keeping when R-node is a component inside something else;
 * what is not worth keeping is R-node deciding WHERE the bytes go. So the
 * adapter seam — already the only place the store talks to a backend — is
 * implemented against a host callback. Nothing else in the store has to know
 * it is embedded.
 */
import type { RnodeDocument } from "../core/types";
import type { StorageAdapter } from "./storage";

export class HostAdapter implements StorageAdapter {
  readonly label = "host";

  constructor(
    private readonly shell: RnodeDocument,
    private readonly write: (doc: RnodeDocument) => Promise<void>,
  ) {}

  async load(): Promise<RnodeDocument[]> {
    return [this.shell];
  }

  /**
   * The store hands over every open document; an embedded session has exactly
   * one, and writing the wrong one would put a stranger's sheet in the host's
   * slot. Match on documentId rather than trusting the position.
   */
  async save(docs: RnodeDocument[]): Promise<void> {
    const doc = docs.find((d) => d.documentId === this.shell.documentId);
    if (doc) await this.write(doc);
  }
}
```

## A2. `src/embed/session.ts` (new file, new directory)

The single public entry point. Nothing else in r-node may be imported by a
host.

```ts
/**
 * SheetSession — R-node's editing engine, scoped to ONE sheet whose bytes
 * belong to a host application.
 *
 * This is the only module a host imports. It exists so the coupling surface
 * is one file: if the store's internals move, the break lands here and not in
 * a foreign codebase.
 */
import { DocumentModel, nowIso } from "../core/doc";
import { EditorStore } from "../editor/store";
import { HostAdapter } from "../persist/hostAdapter";
import type { RnodeDocument, Sheet } from "../core/types";

export interface SheetHost {
  /** Called whenever the store finishes a save. Persist these bytes. */
  save(sheet: Sheet): Promise<void>;
}

export interface SheetSessionOptions {
  /** Existing sheet to edit; omit for a new, blank map. */
  sheet?: Sheet;
  /** Shown in the store's title field; the host owns the real name. */
  title?: string;
}

export class SheetSession {
  readonly store: EditorStore;
  private readonly shell: RnodeDocument;

  constructor(host: SheetHost, opts: SheetSessionOptions = {}) {
    // DocumentModel reads sheets[0] and nothing else, so a document around a
    // single sheet is a literal — there is no document concept to model here.
    this.shell = DocumentModel.blank(opts.title ?? "Mindmap");
    if (opts.sheet) this.shell.sheets = [opts.sheet];
    this.shell.updatedAt = nowIso();

    this.store = new EditorStore(
      new HostAdapter(this.shell, async (doc) => host.save(doc.sheets[0])),
    );
  }

  /** Loads the sheet into the store. Await before rendering. */
  async open(): Promise<void> {
    await this.store.init();
  }

  get sheet(): Sheet {
    return this.store.sheet;
  }

  /**
   * Undo one step, reporting whether there was one. The host needs the
   * BOOLEAN, not the void the store returns: a host with its own undo stack
   * has to know when this one is exhausted so the keystroke can fall through
   * to it instead of being swallowed.
   */
  undo(): boolean {
    if (!this.store.getSnapshot().canUndo) return false;
    this.store.undo();
    return true;
  }

  redo(): boolean {
    if (!this.store.getSnapshot().canRedo) return false;
    this.store.redo();
    return true;
  }

  subscribe(cb: () => void): () => void {
    return this.store.subscribe(cb);
  }
}

export type { Sheet } from "../core/types";
export { Renderer, type RenderState } from "../render/renderer";
export { THEMES, type ThemeName } from "../render/theme";
export { packSheetAssets, unpackSheetAssets } from "./portable";
```

## A2b. `src/embed/portable.ts` (new file)

A sheet on its own is not portable: its nodes name image assets by id, and
those bytes live in R-node's IndexedDB on the machine that made them. A host
that writes a self-contained file needs the bytes too, and it must not reach
into `persist/assets.ts` to get them — the embed entry is the only import
surface.

These two functions are r-node's existing `compact` `.rnode.zip` mode, reduced
to the two calls a host needs. Everything they use is already exported:
`referencedAssetIds` and `getAssetStore` from `src/persist/assets.ts`,
`generateLevelsFromSource` from `src/editor/exportBridge.ts:304`.

```ts
/** assetId → data: URI, one entry per image the sheet references. */
export async function packSheetAssets(sheet: Sheet): Promise<Record<string, string>>;

/**
 * Restore packed images into this machine's asset store and return how many
 * landed. Ids are content addresses, so they are reused exactly as given —
 * see trap 6.
 */
export async function unpackSheetAssets(
  sheet: Sheet,
  images: Record<string, string>,
): Promise<number>;
```

Implementation notes that are not optional:

- **Pack the `large` (1024px) level, never `original`.** This is r-node's
  `compact` mode and the reasoning is already written down in
  `src/editor/exportBridge.ts:7-21`: originals run to hundreds of MB and buy
  nothing a reader can see. The cost is stated in trap 9.
- **Unpack through `generateLevelsFromSource`**, then `store.putUnderId(id,
  levels, meta)`. A compact payload carries one level and `putUnderId` needs
  three; that helper rebuilds them.
- **Set `originalLost = true`** on the matching card in `sheet.attachments`
  for every asset restored this way. R-node documents this as invariant
  exception I11 — the flag is how a later export knows it is re-exporting a
  degraded image rather than an original, and skipping it makes the whole
  chain lie.
- **Missing assets must not throw.** Count them and return the count, the way
  `sheetToHtmlViewer` tracks `imagesMissing`. A map with one unreadable image
  still exports; an export that dies on it does not.

## A3. `package.json` — add an `exports` map

Immediately after `"version"`:

```json
  "exports": {
    "./embed": "./src/embed/session.ts",
    "./package.json": "./package.json"
  },
```

This is not decoration. It is the mechanism that stops a host from reaching
into `src/editor/store` directly — the failure mode that turns a dependency
back into a fork.

## A4. `CLAUDE.md` — one Concept Map line

`npm run check:map` verifies every path in the `## Concept Map (shortcuts)`
section, so a new directory the map never mentions is fine, but a stale map is
a build failure. Add this bullet to that section:

```
- Embedding R-node inside another app -> `src/embed/session.ts`
  (`SheetSession`), whose bytes are owned by the host through
  `src/persist/hostAdapter.ts`. The embedded store has no file, so every
  `TauriStorageAdapter` branch in `src/editor/store.ts` is correctly inert.
```

Then run `npm run check:map` and confirm it is green.

## A5. `tests/embed.test.ts` (new file)

Follow the conventions in `tests/assets.test.ts` — `import "fake-indexeddb/auto"`
at the top, vitest, plain functions. Cover exactly these four:

1. **A new session starts blank and openable.** `new SheetSession(host)`,
   `await open()`, `sheet.nodes` has exactly the root, and `host.save` has not
   been called.
2. **An op round-trips through the host.** Open, `store.createChild()`, then
   drive whatever the store's save entry point is; assert `host.save` received
   a sheet containing the new node.
3. **A supplied sheet is the one edited.** Build a sheet, pass it in, mutate,
   and assert the saved sheet carries the mutation and the same `rootNodeId`.
4. **`undo()` reports exhaustion.** On a freshly opened session `undo()`
   returns `false`; after one `createChild()` it returns `true`, and the next
   call returns `false` again.

Test 4 is the one that matters most — the host's keyboard routing is built on
that boolean, and a version that always returns `true` swallows Ctrl+Z.

---

# Part B — thoughtslibrary

## B1. Depend on r-node without vendoring it

In `package.json` dependencies:

```json
    "r-node": "file:../../../Documents/XuanZhi9/r-node",
```

Then `npm install`. npm symlinks it into `node_modules`.

In `vite.config.ts`, r-node's source sits outside the project root, so Vite's
file-serving guard must be widened. Add to the existing config — do not remove
the `/api` proxy:

```ts
  server: {
    fs: {
      // r-node is consumed as SOURCE through a file: dependency, and its real
      // path is outside this project. Both repos live under the same user
      // directory, so allowing that one ancestor covers the symlink target
      // without opening the whole disk.
      allow: ['../../..'],
    },
    proxy: { /* unchanged */ },
  },
```

**Never** copy r-node files into this repo. If you find yourself pasting one,
stop and report it instead.

## B2. `src/helpers/sheets.ts` (new file)

IndexedDB storage for sheet bytes. Mirror the structure of
`src/helpers/assets.ts` — same `openDb` shape, same failure posture (an
unavailable IndexedDB must degrade, never throw during startup).

- DB name `thoughtslibrary-sheets`, version 1, object store `sheets`.
- Keys are `crypto.randomUUID()`, generated on first save of a map.
- Exports: `readSheet(id): Promise<Sheet | null>`,
  `writeSheet(id, sheet): Promise<void>`, `deleteSheet(id): Promise<void>`,
  `listSheetIds(): Promise<string[]>`.

Store the `Sheet` object directly. IndexedDB structured-clones it; do not
stringify.

## B3. `src/types.ts` — one field on `Chart`

Add next to `relatedLayers`, and copy the reasoning in the comment above it,
because the rule is identical:

```ts
  // Keyed by ChartItem.id for the same reason relatedLayers is: moving,
  // swapping or resizing rearranges coordinates, and an id-keyed entry
  // re-finds its tile wherever it lands. The VALUE is a sheet id, not a
  // sheet — the bytes live in the sheets IndexedDB store, because a chart
  // goes to localStorage and one 400-topic map would eat the whole quota.
  mindmaps?: Record<string, string>

  // The next two are present ONLY in an exported or file-saved chart, never
  // in localStorage: the sheets themselves, and the image bytes they name.
  // Same out-of-line-in-storage / inline-on-export rule the tile covers
  // already follow, and for the same reason — a file has to open on a machine
  // that has never seen this one.
  mindmapSheets?: Record<string, Sheet>
  // assetId → data: URI. Keyed by r-node's own SHA-256 asset ids, shared
  // across every sheet in the chart, so an image used by two maps is carried
  // once.
  mindmapAssets?: Record<string, string>
```

## B4. Export and import round-trip

**The requirement: an exported file opens with everything intact on a machine
that has never run this app or r-node.** That is already true of tile covers —
`inlineStoredChartAssets` turns every `local-asset://` into a data URI before
the JSON is zlib'd and base64'd. Mindmaps must not be the thing that breaks
it. A sheet whose images are missing is not a portable map, it is a map with
holes.

Both export paths — `exportCurrentChart` (`src/helpers/imports.ts:128`) and
`saveCurrentChartToFile` / `saveCurrentChartAs` (`:519`, `:524`) — funnel
through `inlineStoredChartAssets`. That is your single choke point; do not add
a second one.

**On export**, in `src/helpers/assets.ts`, alongside the existing inlining:

1. Read every sheet named in `chart.mindmaps` out of the sheets store.
2. Attach them as `chart.mindmapSheets`, keyed by the same sheet ids.
3. Call `packSheetAssets(sheet)` for each, **merge** the results into one
   `chart.mindmapAssets` map, and let identical ids collapse — two maps using
   the same picture must carry it once.

**On import**, in `importChart` (`src/helpers/imports.ts:707`):

1. For each entry in `mindmapSheets`, call `unpackSheetAssets(sheet,
   chart.mindmapAssets ?? {})` **before** the sheet is written, so a map is
   never briefly readable with missing images.
2. Write the sheet under a **freshly generated id** and rewrite
   `chart.mindmaps` to point at it. See trap 6.
3. Delete `mindmapSheets` and `mindmapAssets` before the chart reaches the
   pinia store. If they survive into the store they reach localStorage, which
   is trap 4 with images attached — the fastest possible way to blow the
   quota.

**Show the size before the download.** Completeness has a price and the user
should see it, not discover it. r-node already does this for its own
portable file — `estimateRnodeZip` in `src/editor/exportBridge.ts:242` exists
purely to put a number in front of the user before a big export. Sum the
lengths of `mindmapAssets` and surface it the same way. See trap 9.

## B5. The minimal overlay — a smoke test, not a feature

One component, `src/components/ChartBuilder/Chart/MindmapOverlay.vue`. Its job
is to prove the seam works end to end. It contains:

- a `<canvas>` filling the overlay;
- a `SheetSession` created on mount from the tile's sheet id (or a new one),
  `await session.open()`;
- an `r-node/embed` `Renderer` over that canvas, repainting on
  `session.subscribe`;
- wheel-zoom and drag-pan wired to `store.zoomAt` / `store.panBy`;
- exactly one editing control: a button calling `store.createChild()`.

No inspector, no toolbar, no text editing. If you are writing a properties
panel you have left the task.

Follow the existing overlay convention: `NotesPopup.vue` plus the
`notesPopupKey: Selection | null` field in `src/store.ts`. Add
`mindmapOverlayKey: Selection | null` beside it and open/close the overlay the
same way notes do.

## B6. Undo routing

Extend the **existing** handler, `handleUndoHotkey` in
`src/components/TitlesSidebar.vue:107`. Do not add a second window listener —
the brief for the current undo system already warns about this, and both would
fire on every press.

The order inside that function must be: contenteditable check (unchanged) →
text-field check (unchanged) → **mindmap overlay** → chart undo. When the
overlay is open, call `session.undo()`; if it returns `false`, fall through to
the chart stack rather than swallowing the key.

---

# Nine things that will break this if you miss them

**1. Do not write an asset adapter.** `getAssetStore()` in
`r-node/src/persist/assets.ts:412` picks `TauriAssetStore` when
`window.__TAURI__` exists and `IndexedDbAssetStore` otherwise. Inside
thoughtslibrary — browser or Electron renderer — that global is absent, so
r-node's own IndexedDB store just works, in its own database (`r-node-assets`).
Zero lines of adapter. And because it is a *separate database*, those blobs are
invisible to `collectUnusedAssets` in `src/helpers/assets.ts`, which sweeps
every blob no chart references — a sweep that does not know sheets exist and
would otherwise delete every mindmap image after the grace period.

**2. Do not "fix" the `instanceof TauriStorageAdapter` branches.** There are 17
of them in `r-node/src/editor/store.ts` and they look like a leaky abstraction.
They are all desktop *file* operations — save-as, rename, pick-file, copy
assets into the file. An embedded tile map has no file and does none of them.
Against a `HostAdapter` every one evaluates false, which is the correct
behaviour. Changing them is out of scope and risks the desktop build.

**3. Never put `SheetSession` or `EditorStore` in pinia state or a `ref`.**
Vue's reactive proxy deep-wraps everything it is given. Wrapping the store
would proxy its internal `Map`s and `Set`s, break the `instanceof` checks the
store relies on, and add a proxy hop to every renderer read on every frame.
Keep the session in a module-level variable in a new
`src/helpers/mindmapSession.ts`, or `markRaw` it. Use a `shallowRef` only as a
repaint trigger, never as the container for the object.

**4. The chart in the store must never hold sheet content.** `Chart.mindmaps`
holds ids, always. The only two places a whole `Sheet` exists are inside a live
`SheetSession` and inside the IndexedDB record. The moment a sheet lands in the
pinia chart, the debounced write in `LocalStorageWatcher.vue` puts it in
localStorage and the quota dies — quietly, because `isStorageQuotaExceeded`
catches it and the user simply stops getting saves.

**5. Do not unify the two undo models — nest them.** thoughtslibrary uses
whole-chart snapshots (`chartUndoStack: Chart[]`); r-node uses inverse
operations. They never have to agree because they work at different
granularities: inside the overlay r-node's history is authoritative, and from
the chart's point of view the entire editing session is **one** value change.
So push exactly one snapshot onto `chartUndoStack` when the overlay opens, and
none while it is open.

**6. Remap sheet ids on import. Never remap asset ids.** These look like the
same rule and are opposites.

*Sheet ids* are per-machine IndexedDB keys with no meaning outside the machine
that generated them. Importing the same file twice, or importing someone
else's, must generate new ids — otherwise the second import overwrites the
first one's maps and the user loses a map by opening a file.

*Asset ids* are SHA-256 content addresses. The nodes inside the sheet
reference them by value, so renaming one breaks every reference in a document
you cannot rewrite safely. `putUnderId` is first-write-wins precisely so a
re-import is a no-op rather than a duplicate. Pass the id through exactly as
it arrived.

Get these backwards and the failure is silent in both directions: remapped
asset ids give you maps with no pictures, and reused sheet ids give you a
chart that quietly eats another chart's maps.

**7. Deleting a tile must delete its sheet.** A tile carrying a map that gets
cleared or overwritten leaves an orphan record that nothing will ever collect —
there is no sweep for the sheets store. Handle it where the tile is removed in
`src/store.ts`, and note that undo can bring the tile back: either delay the
delete until the chart undo entry holding that tile has fallen off the stack,
or accept the orphan and add a sweep. Pick one, say which in your final
message, and do not leave it unhandled.

**8. `vue-tsc` will typecheck r-node's source.** It is consumed as `.ts`, not
as built `.d.ts`, so `npm run build` in thoughtslibrary type-checks the imported
engine under *this* repo's tsconfig. If that produces errors from inside
r-node, do **not** loosen thoughtslibrary's tsconfig and do not edit r-node's
source to satisfy it. Instead add a `build:embed` script to r-node that emits
`dist/embed.js` + `dist/embed.d.ts`, point the `exports` map at the built
output, and depend on that. Report it if you take this path.

**9. Do not try to shrink the export by compressing images again.** The file
is `JSON → zlib → base64`. Map images are already JPEG, zlib gains
approximately nothing on them, and base64 adds a flat 33%. R-node hit this
exact wall and wrote it down at `src/export/htmlViewer.ts:106` — its HTML
export ships the gzipped payload *only when it turns out smaller*, because on
an image-heavy document it loses. So the file will be big: a chart with five
image-rich maps can add 10 MB or more, and that is the correct price for "open
it anywhere".

The two levers are the ones already chosen for you: pack the `large` level
rather than the original (A2b), and show the estimate before the download
(B4). Do not add a third by re-encoding or downscaling further — the display
level is what the renderer draws, so anything smaller degrades what the user
sees, on import, permanently.

One consequence to state plainly in your final message rather than bury: a
chart imported from a file carries 1024px images, so re-exporting it can never
recover the originals. This is r-node's documented `compact` behaviour and the
`originalLost` flag from A2b is what records it. If the user later wants
full-fidelity portable files, the fix is a `complete` / `compact` toggle on
export — r-node already models both modes — and that is a separate task.

---

# Order of work

1. Part A in full, all three r-node gates green. It is self-contained and
   testable without thoughtslibrary. A2b is part of this — write a vitest case
   that packs a sheet with one image and unpacks it into an empty
   `fake-indexeddb`, because that is the portability guarantee in miniature and
   it is far cheaper to debug here than through the UI.
2. B1 (dependency + vite), then `npm run build` in thoughtslibrary. This is the
   moment trap 8 shows up; find out before writing feature code.
3. B2, B3 — storage and schema.
4. B5 — the overlay, enough to see a map and add one node.
5. Prove the round-trip by hand: add a node, close the overlay, reload the app,
   reopen the overlay, the node is there.
6. B4 — export/import, then the portability test from the Definition of done.
   Do this **before** B6: undo routing is a keystroke detail, while a file
   format that loses images is a decision that gets baked into every file the
   user saves between now and the fix.
7. B6 — undo routing.

# Definition of done

- r-node: `npm test`, `npm run typecheck`, `npm run check:map` all green.
- thoughtslibrary: `npm run lint`, `npm run build` both green.
- The manual round-trip in step 5 above works across a full page reload.
- **The portability test, run exactly like this.** Build a chart with two
  mindmaps, each containing at least one image, and with one image used by
  *both* maps. Export it to a file. Then open the app in a **fresh browser
  profile** — or delete both the `thoughtslibrary-sheets` and `r-node-assets`
  IndexedDB databases, which is the same thing and faster — and import the
  file. Both maps must open with every image present.

  A clean profile is not optional here. The whole failure mode this guards
  against is an export that looks complete only because the exporting machine
  still has the bytes in IndexedDB, and testing on that machine cannot
  distinguish a working file from a broken one.
- Export the imported chart again and confirm the second file also opens in a
  clean profile. This is what proves the `originalLost` path from A2b did not
  drop the images on the way back out.
- No r-node file copied into thoughtslibrary. No existing r-node source file
  modified.

If a step cannot be completed, say so plainly in your final message with what
you tried. A half-finished task with an honest account is worth more than a
green one achieved by disabling a check.
