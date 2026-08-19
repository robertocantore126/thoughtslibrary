# Technical review — thoughtslibrary

Reviewed at commit `e7aecab`. ~6,400 lines across `src/`, Vue 3 + Pinia + Vite,
with an Electron wrapper and a .NET launcher added on top of a fork of
[topsters.org](https://github.com/camdendotlol/topstersorg).

Measurements in this document were taken against the app running live on
`127.0.0.1:5173`, not estimated. Lint, typecheck and audit output is real
command output.

---

## 0. Verdict

The additions on top of upstream are genuinely good ideas: notes and ratings per
tile, a thought-tile type, an IndexedDB asset store that keeps base64 out of
localStorage, a coordinate map instead of a bare array. The asset layer
(`helpers/assets.ts`) in particular is the right design — blobs in IndexedDB,
one-line `local-asset://` refs in the chart, inlined only at export time.

The problems are not in the ideas. They're in three places:

| Area | State | Severity |
|---|---|---|
| **Save-to-file** | Silently overwrites the wrong file, reports success | 🔴 Data loss |
| **Half-finished features** | Electron PDF wired end-to-end and never called; marquee selection; per-row scaling | 🟠 Serious |
| **Persistence design** | Chart stored twice, full sync write per keystroke, 1.29 MB at max size | 🟡 Structural |
| Fork leftovers | GA beacon, `topsters.org` CNAME, Pages deploy workflow | 🟡 Hygiene |
| Repo hygiene | 32 committed build artifacts, 48 lint errors, 0 tests | 🟡 Hygiene |

Fix #1 today. Everything else is a weekend.

---

## 1. 🔴 "Save current chart" overwrites the wrong file

**Desktop build only. Confirmed by code path, not observed — reproducing it destroys a file.**

`lastChartFilePath` is a **single global** localStorage key
([imports.ts:15](src/helpers/imports.ts#L15)), not scoped per chart:

```ts
const LAST_CHART_FILE_PATH_KEY = 'lastChartFilePath'          // :15
filePath: filePath || getLastChartFilePath() || undefined     // :335
rememberChartFilePath('filePath' in result ? result.filePath || '' : '')  // :384
```

And the main process writes straight through with no dialog when a path is present
([main.cjs:65-68](electron/main.cjs#L65)):

```js
if (payload.filePath) {
  fs.writeFileSync(payload.filePath, payload.content, 'utf8')
  return { success: true, filePath: payload.filePath }
}
```

So:

1. Save chart **A** → dialog → you pick `a.topster` → path is remembered.
2. Switch to chart **B** via the switcher, or hit `+` for a new chart.
3. Click "Save current chart".
4. **`a.topster` is overwritten with chart B's data. No dialog. The UI says
   "Chart saved successfully!"** ([Imports/index.vue:46](src/components/Sidebar/Imports/index.vue#L46))

Nothing clears the key — not `changeChart`
([Switcher.vue:29](src/components/ChartBuilder/Switcher.vue#L29)), not
`startNewChart` ([TopBar.vue:24](src/components/ChartBuilder/TopBar.vue#L24)), not
`deleteChart`, not import.

Compounding it: **there is no Save As.** `saveCurrentChartToFile(filePath?)` is only
ever called with no argument, so once the path is set there is no way from the UI to
save anywhere else.

The browser build is unaffected — the `showSaveFilePicker` branch
([imports.ts:357](src/helpers/imports.ts#L357)) ignores `filePath` and always prompts.

**Fix.** Key the path per chart (`lastChartFilePath:<uuid>`) and clear it on
new/import/switch; add an explicit "Save As" that forces the dialog. Or, simplest and
safest: delete the shortcut and always show the dialog.

---

## 2. 🟠 The Electron PDF export is fully wired and never called

The native path exists in its entirety:

- [main.cjs:88-129](electron/main.cjs#L88) — `print-chart-to-pdf` handler using `webContents.printToPDF`
- [preload.cjs:5](electron/preload.cjs#L5) — exposed on `window.electronAPI`
- [vite-env.d.ts:16](src/vite-env.d.ts#L16) — typed
- [imports.ts:140-155](src/helpers/imports.ts#L140) — `getPdfExportApi()`, the intended caller

Nothing calls `getPdfExportApi`. eslint flags it as unused; `grep` confirms it.

**Consequence:** the desktop app falls through to the browser path —
`html2canvas` rasterises the DOM, `jsPDF.addImage` pastes the bitmap
([imports.ts:263-280](src/helpers/imports.ts#L263)). You ship a **bitmap PDF** with
unselectable, unsearchable text, while the code for a real vector PDF is sitting
right there, already written.

Either call it when `window.electronAPI` is present, or delete the handler, the
preload binding, the typings and `getPdfExportApi` together.

---

## 3. 🟠 PDF tile labels never work

[imports.ts:220](src/helpers/imports.ts#L220):

```ts
const position = Object.entries(coordinates).find(([key, value]) => value === item && key)
const tileLabel = position?.[0] || `Tile ${index + 1}`
```

This is an **object-identity** comparison. In the live store it would work — both
`chart.items[i]` and `chart.coordinates[key]` hold the same reference. But
`exportCurrentChartToPdf` runs `inlineStoredChartAssets` first
([imports.ts:235](src/helpers/imports.ts#L235)), and `inlineChartAssets`
([assets.ts:241-252](src/helpers/assets.ts#L241)) rebuilds `items` and `coordinates`
**independently**, each through a `{ ...item }` spread. After that the two structures
share no references at all.

So `find` always returns `undefined`, and every row falls back to `Tile N`. The `x,y`
label the code is trying to produce **has never once appeared in an exported PDF**.

Fix: compute the key from the index (`indexToCoord(index, chart.size.x)`) instead of
comparing identities.

While you're in there, [imports.ts:223](src/helpers/imports.ts#L223):

```ts
const text = [item.notes, item.creator && item.title ? undefined : undefined].filter(Boolean).join('')
```

The ternary yields `undefined` in both branches, and `text` is never read — line 227
recomputes it correctly. Delete it.

---

## 4. 🟠 Import-path memory is dead on your Electron version

[imports.ts:404](src/helpers/imports.ts#L404):

```ts
const importedFilePath = (files[0] as File & { path?: string }).path
```

`File.path` was removed in **Electron 32**. You are on **37.10.3** (verified against
`node_modules/electron/package.json`). This is always `undefined`.

Use `webUtils.getPathForFile(file)` exposed through preload, or drop the branch.

---

## 5. 🟠 Object URLs are cached forever, never revoked

[assets.ts:8](src/helpers/assets.ts#L8) and [assets.ts:166-168](src/helpers/assets.ts#L166):

```ts
const objectUrlCache = new Map<string, string>()
...
const objectUrl = URL.createObjectURL(blob)
objectUrlCache.set(assetId, objectUrl)
```

`URL.revokeObjectURL` is never called on these. (The two calls in
[files.ts:34,39](src/helpers/files.ts#L34) are for a different, short-lived URL inside
`loadImageFromBlob`.) Every image decoded in the session — across every chart you
switch through — stays pinned for the lifetime of the window.

Fix: revoke on chart switch, or cap the map with an LRU.

---

## 6. 🟡 The chart is stored twice, and derived state got persisted

[types.ts:37-39](src/types.ts#L37) — `Chart` carries **both**:

```ts
coordinates?: ChartCoordinates   // "3,4" -> item
items: Array<ChartItem | null>   // flat, size.x * size.y
```

`items` is 100% derivable from `coordinates` + `size` — that's literally what
`itemsFromCoordinates` ([store.ts:58-75](src/store.ts#L58)) does, and every single
store action calls it and replaces the whole chart object. Both go to localStorage.

Costs: ~2× storage, a full array rebuild (up to 3,600 entries) on every mutation, and
a permanent desync hazard — **finding #3 is exactly this hazard firing**.

Fix: make `items` a Pinia getter over `coordinates` and `size`; persist `coordinates`
only; keep reading legacy `items` on load for back-compat (the migration code in
`setEntireChart` already does).

Related: shrinking the chart (`setWidth`/`setHeight`,
[store.ts:505-524](src/store.ts#L505)) drops out-of-bounds tiles from `items` but keeps
them in `coordinates`. That's a defensible non-destructive resize, but it means
localStorage accumulates invisible items indefinitely, and nothing ever prunes them.

---

## 7. 🟡 Every keystroke triggers a full synchronous serialise + write

[LocalStorageWatcher.vue:54](src/components/LocalStorageWatcher.vue#L54) — `store.$subscribe`
persists the entire chart on every mutation, **undebounced**. Typing one character in
the notes textarea runs: `setActiveTileNote` → `recordTextEdit` → clone all
coordinates → rebuild the whole `items` array → `JSON.stringify` the chart →
`localStorage.setItem`.

Measured on the running app, synthetic charts using `local-asset://` refs (no base64
inline — i.e. the *good* case):

| Chart | Serialised size | ms per write |
|---|---|---|
| 5×5 | 9 KB | 0.04 |
| 10×10 | 36 KB | 0.34 |
| 20×20 | 142 KB | 0.73 |
| **60×60 (`MAX_CHART_DIMENSION`)** | **1.29 MB** | **7.2** |

7 ms of blocked main thread per character at max size. And 1.29 MB for **one** chart
against a ~5 MB localStorage budget shared by all of them — which is precisely why the
`QuotaExceededError` handler at
[LocalStorageWatcher.vue:20-26](src/components/LocalStorageWatcher.vue#L20) had to be
written.

Fix: debounce the write (~300 ms), and move charts into IndexedDB next to the assets
that already live there. localStorage is the wrong store for megabyte documents.

---

## 8. 🟡 Dead scaffolding from removed features

**Marquee selection** — [Chart/index.vue:10-55](src/components/ChartBuilder/Chart/index.vue#L10).
`getTileSize`, `getTileCoordinates` (plus an unused `chartRect` inside it) and
`normalizeSelection` are a complete rubber-band-selection system with no callers.

**Per-row tile scaling** — [Item.vue:16-18](src/components/ChartBuilder/Chart/Item.vue#L16):

```ts
function getTileScale(row: number): number {
  return 1
}
```

Ignores its argument, always returns `1`. But `tileScale`, `tileSizePx`,
`itemStyle`, `coverFrameStyle` and `titleStyle` all exist to consume it, and a
`visualRow` prop is threaded `Chart/index.vue` → `Row.vue` → `Item.vue` purely to feed
it. The feature was removed; the plumbing wasn't. That's ~25 lines of computed
properties that resolve to constants.

**Vuex typings** — [src/vuex.d.ts](src/vuex.d.ts) declares `$store` typings importing
from `vuex`. `vuex` is not installed (the project uses Pinia). It only compiles because
`skipLibCheck: true` skips `.d.ts` files entirely.

---

## 9. 🟡 `strict: false`

[tsconfig.json:12-13](tsconfig.json#L12) — `"strict": false, "noImplicitThis": false`.

`npx vue-tsc --noEmit` passes clean, which sounds good and means very little. Concrete
lie it's currently hiding, [localStorage.ts:12-14](src/helpers/localStorage.ts#L12):

```ts
export function getActiveChartUuid(): string {
  return localStorage.getItem('activeChart')   // string | null
}
```

That `null` flows into `getStoredCharts()[uuid]` at every call site. And
[localStorage.ts:20-24](src/helpers/localStorage.ts#L20):

```ts
return chartEntries.sort((a, b) => b[1].timestamp - a[1].timestamp)[0][0]
```

throws `TypeError` on empty storage — `[0]` is `undefined`.

For a codebase this dependent on optional fields (`creator?`, `notes?`, `rating?`,
`coordinates?`, `attachmentURL?`), strict mode is the single highest-leverage change
available. Expect a day of fallout, then permanently fewer bugs.

---

## 10. 🟡 Duplicated logic

- **`ratingColor` + the `frusciante` easter egg** exists twice —
  [Item.vue:239-254](src/components/ChartBuilder/Chart/Item.vue#L239) and
  [TitlesSidebar.vue:77-92](src/components/TitlesSidebar.vue#L77). The two take
  different arguments (normalized rating vs. star index), so they're already
  structurally divergent. Extract one `helpers/rating.ts`.
- **`SUPPORTED_IMAGE_EXTENSIONS` + `isSupportedImageUrl`** duplicated in
  [Item.vue:14,77-89](src/components/ChartBuilder/Chart/Item.vue#L14) and
  [CustomItemForm.vue:15,34-46](src/components/Sidebar/SearchBox/CustomItemForm.vue#L15).
  eslint flags the regex for super-linear backtracking (`regexp/no-super-linear-backtracking`).
- **The thought-tile test** `itemType === 'thought' || coverURL === '/thought_tile.svg'`
  is spelled out in five places: [store.ts:462](src/store.ts#L462),
  [store.ts:640](src/store.ts#L640),
  [Item.vue:221](src/components/ChartBuilder/Chart/Item.vue#L221),
  [TitlesSidebar.vue:20](src/components/TitlesSidebar.vue#L20). Make it
  `isThoughtItem(item)`.
- `waitForImageLoad` and `inlineLocalImagesForExport` are copy-pasted between
  [chart.ts:151-197](src/helpers/chart.ts#L151) and
  [imports.ts:157-203](src/helpers/imports.ts#L157) — near-identical, ~45 duplicated lines.

---

## 11. 🟡 It's still upstream's app in several places

**Google Analytics fires on every launch, with an unsubstituted placeholder.**
[index.html:22-26](index.html#L22). Verified live —
`performance.getEntriesByType('resource')` on the running app shows a real request to:

```
https://www.googletagmanager.com/gtag/js?id=%VITE_GOOGLE_ANALYTICS_TAG%
```

plus `fonts.googleapis.com`. Your own `devserver.err.log` has the Vite warning about it
ten times over. For a local-first desktop app this is a pointless external call at
startup, it breaks offline launch, and it signals app usage to Google. Delete the GA
block; ship the Nunito font locally or fall back to the system stack.

**The backend defaults to someone else's server.**
[api/config.ts:3](src/api/config.ts#L3) — production builds fall back to
`https://api.topsters.org`. Games (IGDB), movies/TV (TMDB), Last.fm, and the
html2canvas CORS proxy ([chart.ts:125](src/helpers/chart.ts#L125),
[imports.ts:266](src/helpers/imports.ts#L266)) all route through the upstream author's
infrastructure. Only books go direct ([openlibrary.ts](src/api/openlibrary.ts)). That's
an unowned dependency you can't fix if it disappears, and every search query you type
leaves your machine to a third party. Fine as a deliberate choice — worth making it a
deliberate one.

**Leftover deploy machinery.**
[.github/workflows/deploy.yml](.github/workflows/deploy.yml) publishes to GitHub Pages
on every push to `main`, reading `secrets.VITE_BACKEND_URL` you presumably don't have —
so it would deploy pointed at topsters.org. [public/CNAME](public/CNAME) is
`topsters.org`. `og:url` in [index.html](index.html#L13) is `https://topsters.org`. The
README still describes upstream's contribution process and calls it "a website".

**Imported charts can beacon.** A `.topster` file sets `backgroundUrl` and every
`coverURL`, which land in `background-image: url(...)`
([Chart/index.vue:73](src/components/ChartBuilder/Chart/index.vue#L73)) and `<img src>`.
I checked whether the unescaped template interpolation allows CSS-declaration injection
— it does not; CSSOM rejects the payload. But a plain external URL is honoured, so
opening a chart file from someone else fetches whatever URLs it names (IP + "file was
opened" leak). Low severity for personal use; worth a CSP on the Electron window if you
ever share files around.

---

## 12. 🟡 Repo hygiene

**Build artifacts and logs are committed.** `git ls-files` shows **32 tracked files**
under `launcher/bin/` and `launcher/obj/` — `.dll`, `.pdb`, `.exe`, MSBuild caches — plus
`ThoughtsLibraryLauncher.exe` and `ThoughtsLibraryLauncher_fixed.exe` at the repo root
and three `devserver*.log` files. `.gitignore` covers `/dist` and `/release` but not
these. Two near-identical root exes with nothing saying which is canonical (your desktop
shortcut points at `_fixed`).

**Three launch paths, none blessed.**
- [launcher/Program.cs](launcher/Program.cs) — .NET app that shells out to `npm run dev`
  and opens a browser. It requires Node, npm and the full source tree on the target
  machine, which defeats the point of a desktop app, and duplicates `desktop:dev`.
- `npm run desktop:dev` — Electron + Vite. The real dev path.
- `npm run desktop:dist` — portable exe. The real ship path.

Recommend deleting `launcher/` and both root exes, and pointing the shortcut at the
`release/` output.

**48 lint errors.** `npx eslint .` → `57 problems (48 errors, 9 warnings)`, 15
auto-fixable. The README asks contributors to make sure changes pass the linter; the
repo doesn't. Either fix them or stop claiming it.

**Zero tests.** No runner in `devDependencies`. The riskiest code in the repo has no
coverage at all:
- Topsters 2 import — charcode-shift → base64 → zlib → JSON, five nested parses
  ([imports.ts:445-600](src/helpers/imports.ts#L445))
- localStorage migrations ([localStorage.ts:80-151](src/helpers/localStorage.ts#L80))
- coordinates ↔ items round-trip ([store.ts:44-75](src/store.ts#L44))

Add Vitest and pin those three with fixtures. That's a few hours and it's where the
data-loss bugs live.

**`npm audit`**: 6 vulnerabilities, 4 high (postcss, uuid) — all with fixes available.
Five dependabot PRs are open and unmerged on the remote.

---

## 13. Accessibility & UX (brief)

- Tiles are `<div>`s with `@click`, no `tabindex`, `role` or key handler
  ([Item.vue:277](src/components/ChartBuilder/Chart/Item.vue#L277)) — unusable without a
  mouse. `<img class="item-img">` ([:316](src/components/ChartBuilder/Chart/Item.vue#L316))
  has no `alt`.
- `alert()` is the entire error-reporting strategy — 12 uses. In Electron these are
  blocking modals. Non-blocking toasts would be a real improvement.
- Ctrl+click to delete a tile ([Item.vue:257](src/components/ChartBuilder/Chart/Item.vue#L257))
  is undiscoverable and undocumented.
- Undo ([TitlesSidebar.vue:94](src/components/TitlesSidebar.vue#L94)) only fires when
  focus is in a text field, and the 300-entry stack covers **text only** — moving or
  deleting a tile is unrecoverable.

---

## 14. Suggested order

1. **Fix the save-path overwrite (#1).** Data loss. Today.
2. Turn on `strict` (#9) and delete the dead scaffolding (#8). Makes everything below easier.
3. Debounce persistence, make `items` derived, move to IndexedDB (#6, #7).
4. Decide the Electron PDF question (#2) and fix the tile labels (#3).
5. Strip fork leftovers: GA, CNAME, Pages workflow, launcher, committed binaries (#11, #12).
6. Vitest around import/migration/round-trip (#12); `npm audit fix` and merge dependabot.
