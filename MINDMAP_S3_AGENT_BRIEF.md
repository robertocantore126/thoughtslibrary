# Task: mindmaps in the saved JSON, and images in topics

Stage 3 of the mindmap work. Read §0.3 and §T of
`MINDMAP_NATIVE_AGENT_BRIEF.md` first; both still apply.

Three things, in this order, and the order is not negotiable — see §Order.

**A.** The saved chart JSON carries mindmap sheets. (Fixes live data loss.)
**B.** The orphan sweep learns about mindmaps. (Must land *before* C.)
**C.** Topics can carry an image, and it travels in the save file.

---

# Part A — the saved JSON carries mindmaps

## A.0 The bug

`Chart.mindmaps` holds `{ chartItemId: sheetId }` — uuid strings. The sheets
live in the `thoughtslibrary-mindmaps` IndexedDB database. Nothing in
`src/helpers/imports.ts`, `src/helpers/assets.ts` or
`src/helpers/localStorage.ts` reads them.

So **every chart exported or saved to a file today contains no mindmap content
at all** — only ids pointing at records that never leave the machine. Open that
file anywhere else and each tile still shows its mindmap indicator, the overlay
still opens, and the map is empty. Silent data loss, live right now.

## A.1 The rule

The same one tile covers already follow, in both directions:

| | Live (localStorage + IndexedDB) | Exported / saved file |
|---|---|---|
| Tile covers | `local-asset://<id>` | data URI, inlined |
| Mindmap sheets | sheet id → IndexedDB | **inlined — this task** |
| Mindmap images | `local-asset://<id>` | data URI, inlined — Part C |

**Sheets must never go into localStorage.** A chart lives there under the
`charts` key, and one 400-topic map would eat the quota — quietly, because
`isStorageQuotaExceeded` in `LocalStorageWatcher.vue` catches the failure and
the user simply stops getting saves.

## A.2 Schema

On `Chart` in `src/types.ts`, beside `mindmaps`:

```ts
  // Present ONLY in an exported or file-saved chart, never in localStorage:
  // the sheets themselves, keyed by the ids `mindmaps` points at. Out-of-line
  // while live, inline in the file — the same rule the tile covers follow,
  // because a file has to open on a machine that has never seen this one.
  mindmapSheets?: Record<string, Sheet>
```

## A.3 Export — inline

Both export paths funnel through `inlineStoredChartAssets`
(`src/helpers/assets.ts`), called from `exportCurrentChart`
(`src/helpers/imports.ts:130`) and `saveCurrentChartToFile` /
`saveCurrentChartAs` (`:558`). Use it; do not add a second choke point.

Read every sheet named in `chart.mindmaps` and attach them as
`chart.mindmapSheets`.

A `mindmaps` entry whose sheet is missing from IndexedDB is **skipped, not
fatal** — and drop the `mindmaps` entry with it, so the file never references a
sheet it does not carry. A dangling id is what created this bug.

Do not mutate the live chart; the existing helpers clone (`cloneItems`,
`cloneCoordinates`). Follow that.

## A.4 Import — restore

`persistChartAssets` is the mirror, called from `importChart`
(`src/helpers/imports.ts:734`, `:917`) **and from
`LocalStorageWatcher.vue:135` on every autosave** — see trap 1.

For each entry in `mindmapSheets`: write the sheet under a **freshly generated
id**, rewrite `chart.mindmaps` to point at it, and delete `mindmapSheets`
before the chart goes any further.

Sheet ids are per-machine IndexedDB keys, not content addresses. Importing the
same file twice must produce new ids, or the second import overwrites the
first one's maps and the user loses a map by opening a file.

---

# Part B — teach the orphan sweep about mindmaps

**Do this before Part C. Not after, not alongside.**

`collectUnusedAssets` in `src/helpers/assets.ts` deletes every blob in the
asset store that no chart references and that is older than a ten-minute grace
period. Its root set comes from `collectChartAssetIds`, which walks
`chart.items`, `chart.coordinates` and `chart.relatedLayers` — **and nothing
else.**

The moment a mindmap topic stores an image as `local-asset://…`, that blob is
invisible to the root set, and roughly ten minutes later the sweep deletes it.
The map keeps the reference; the bytes are gone. Ship Part C without Part B and
you have built an image feature that destroys its own images on a timer.

The fix, at the call site in `LocalStorageWatcher.vue:170`:

- The root set must also include every asset referenced by every sheet of every
  stored chart — not just the active one. `chart.mindmaps` gives the sheet ids;
  read each sheet and collect its image references.
- The gather is async and the call site already is; that is fine.
- **Extend the existing bail-out, do not weaken it.** The code already refuses
  to sweep when any chart fails to read: *"a sweep that cannot see a chart's
  references would delete its images. Better to reclaim nothing this run than
  to collect against an incomplete root set."* A sheet that fails to read is
  exactly the same hazard. Same guard, same reason.

Add a `collectSheetAssetIds(sheet, into)` next to `collectChartAssetIds` so
there is one place that answers "what does a sheet reference", the way
`referencedAssetIds` does in r-node.

**Test it as a deletion test, not a collection test.** Store an image on a
mindmap topic, run the sweep with the grace period bypassed, and assert the
blob is *still there*. A test that only checks that unreferenced blobs get
collected will pass while this bug is present.

---

# Part C — images in topics

## C.1 Use the asset store you already have

`src/helpers/assets.ts` — `storeLocalImage`, `resolveStoredImageUrl`,
`persistImageUrl`, `inlineStoredImageUrl`, `isLocalAssetUrl`. Do **not** build a
second image path for mindmaps (§T.7). One asset store, one orphan sweep, one
export path.

`Style.image` therefore holds a `local-asset://<uuid>` URL, the same convention
as `ChartItem.coverURL` — **not** r-node's SHA-256 asset id. That is a
deliberate divergence from the ported schema: r-node content-addresses because
it owns its own store; here the host's store already exists and already has a
URL convention. Write the reason in a comment where the field is first read.

S3 covers `Style.image` only — the single top image. The other three slots
(`imageBottom`, `imageLeft`, `imageRight`) and `Style.gallery` are S4. The
fields stay in the schema untouched.

## C.2 Sizing — the async-input rule

**A layout input must be knowable without waiting for anything async.** This is
one rule with two instances, and it is the same failure as the S2 pan-shift
bug arriving by two more roads. Both must be closed in S3.

### C.2a Fonts — a live bug, already shipped

`index.html` loads Google Fonts with `display=swap`:

```html
<link href="https://fonts.googleapis.com/css2?family=Nunito&display=swap" rel="stylesheet">
```

`swap` means the browser paints a fallback face first and switches to Nunito
when it arrives. Every measurement taken before that switch uses the wrong
metrics, and **nothing currently re-measures afterwards** — so S2's measure
layer already sizes topics for the wrong font on a cold load and the right one
on a warm cache. Intermittent, environment-dependent, and invisible in tests.

Fix in `MindmapCanvas.vue`:

- `await document.fonts.ready` before the first measurement pass.
- Re-run the measurement pass once on `document.fonts.onloadingdone`, since a
  face can arrive after `ready` resolves when a new family is requested later.
- Guard both: `document.fonts` is absent in the node test environment, so treat
  a missing API as "fonts are ready".

This is not image work, but it lives here because it is the same rule and
because fixing it separately would mean touching the measure layer twice.

### C.2b Images

An `<img>` measured before it loads is zero-height. Measure the node then and
layout packs the tree around a collapsed box; the image arrives, the box grows,
and the map jumps.

So the box must be computable **without** the image being loaded:

- `Style.imageWidth` — display width in world units (already in the schema).
- Add `imageAspect?: number` to `Style` — height / width of the source.
  r-node does not need this because its `AssetMeta` carries `w`/`h`; this
  repo's asset store keeps only the blob and a write timestamp, so the aspect
  has to live on the node. Document that reason at the field.

Read the natural dimensions **once, when the image is added**, and store the
aspect then. Render the `<img>` with an explicit width and height derived from
those two numbers, so the box is correct on the first frame and never changes
on load.

Add `imageWidth` and `imageAspect` to `sizeKey` (S2 M1.2) so resizing an image
re-measures the topic.

## C.3 Editing

In the inspector (S2 M3): add an image, replace it, remove it, and a width
control.

Every one of those is an op through `setNodeStyle` / `clearNodeStyle`, so
**Ctrl+Z undoes adding or removing an image**. Removing clears `image`,
`imageWidth` and `imageAspect` together — a leftover aspect on a node with no
image is a trap for whatever reads it next.

Drag-and-drop onto a topic is welcome if it falls out cheaply; this repo
already has `src/helpers/imageDrop.ts`. Do not rebuild it.

## C.4 Images in the save file

Extend A.3 and A.4 to carry the bytes, keyed by asset id and shared across
every sheet in the chart so a picture used by two maps travels once:

```ts
  // assetId → data: URI. Export-only, like mindmapSheets.
  mindmapAssets?: Record<string, string>
```

- **Export**: for every sheet being inlined, collect its image ids and
  `inlineStoredImageUrl` each into `mindmapAssets`.
- **Import**: write each back through the asset store, rewrite the sheets'
  `Style.image` URLs to the new local ids, then delete `mindmapAssets`.
- Missing bytes are skipped, not fatal — count them and leave the reference
  alone rather than corrupting the sheet.

---

# Traps

**1. `persistChartAssets` runs on every autosave.** `LocalStorageWatcher.vue:135`
calls it on the debounced write to localStorage, not only on file import. If the
restore logic runs there it will re-key sheet ids on every keystroke. **Gate the
restore on `mindmapSheets` being present** — only a file ever carries it — and
make sure the autosave path leaves `mindmaps` untouched. Write the test for this
before the code.

**2. Never let `mindmapSheets` or `mindmapAssets` reach localStorage.** Both are
stripped on import, and neither is ever added by the autosave path. Verify by
hand: build a map with an image, wait for autosave, inspect the `charts` key —
it must hold ids only.

**3. Part B before Part C.** Stated above and worth repeating: images that the
sweep cannot see are deleted ten minutes after they are created.

**4. The save path is where this repo has been burned.** `git log` shows
`fix/save-safety` and "Stop losing charts, files and images on the save paths".
Read those commits before touching `imports.ts`. Add to the write-through and
file-handle logic; do not restructure it.

**5. Do not reintroduce `.rnode` import.** Built in S2 and deliberately removed.
Mindmaps are authored here.

**6. The font fix is not optional and not cosmetic.** C.2a is a bug that is
already live: measurement runs before the web font swaps, so topic sizes depend
on whether the font was cached. It is two lines of `document.fonts.ready` and
it removes an entire class of "it looks different on my machine".

**7. Do not touch `src/mindmap/layout.ts`, `ops.ts`, `history.ts`, `geometry.ts`
or `cull.ts`.** Landed and tested. If one genuinely needs a change, say so in
your final message rather than making it.

---

# Order

1. **Part A** — sheets in the file, with its tests. Self-contained, and it stops
   the live data loss.
2. **Part B** — the sweep. No images exist yet, so nothing is at risk while you
   write it, and the test can use a hand-placed reference.
3. **Part C** — images, last, onto a sweep that already protects them.

# Definition of done

- `npm run lint`, `npm run build`, `npm test` green.
- **The portability test, by hand, in a clean profile.** Build a chart with two
  mindmaps, put an image on a topic in each, save to a file. Then delete the
  `thoughtslibrary-mindmaps` and `thoughtslibrary-assets` databases — or open a
  fresh browser profile — and import. Both maps open with their topics and both
  images.

  A clean profile is not optional. An export missing its sheets or its bytes
  looks perfect on the machine that made it, because they are still in
  IndexedDB. Testing there cannot distinguish a working file from a broken one.
- **The sweep test:** an image on a mindmap topic survives a sweep run with the
  grace period bypassed.
- After a normal editing session the `charts` localStorage key holds ids only —
  no sheet content, no data URIs.
- Adding an image, then Ctrl+Z, removes it.
- **Cold-load font check:** hard-reload with the cache disabled and confirm a
  map's topic boxes are sized identically to a warm reload. Different sizes
  mean C.2a is not done.

If a step cannot be completed, say so plainly with what you tried.
