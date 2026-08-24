# Task: put mindmaps inside the chart's saved JSON

Stage 3 of the mindmap work. One job. Read §0.3 and §T of
`MINDMAP_NATIVE_AGENT_BRIEF.md` first; both still apply.

## The bug this fixes

`Chart.mindmaps` holds `{ chartItemId: sheetId }` — uuid strings. The sheets
themselves live in the `thoughtslibrary-mindmaps` IndexedDB database. Nothing
in `src/helpers/imports.ts`, `src/helpers/assets.ts` or
`src/helpers/localStorage.ts` reads them.

So **every chart exported or saved to a file today contains no mindmap content
at all** — only ids pointing at records that never leave the machine. Open that
file anywhere else and every map is gone, with no error: the tile still shows
its mindmap indicator, the overlay opens, and the map is empty.

That is silent data loss on the save path, and it is live right now.

## The rule

The same one tile covers already follow, and it is not negotiable in either
direction:

| | Live (localStorage + IndexedDB) | Exported / saved file |
|---|---|---|
| Tile covers | `local-asset://<id>` | data URI, inlined |
| Mindmap sheets | sheet id → IndexedDB | **inlined — this task** |

**Sheets must never go into localStorage.** A chart lives there under the
`charts` key, and one 400-topic map would eat the quota — quietly, because
`isStorageQuotaExceeded` in `LocalStorageWatcher.vue` catches the failure and
the user simply stops getting saves. Out-of-line while live, inline in the
file. That distinction is the whole design.

## Where the code goes

Both export paths already funnel through one function, and both import paths
through its mirror. Use them; do not add new choke points.

- **Export** — `inlineStoredChartAssets` (`src/helpers/assets.ts`), called from
  `exportCurrentChart` (`src/helpers/imports.ts:130`) and
  `saveCurrentChartToFile` / `saveCurrentChartAs` (`:558`).
- **Import** — `persistChartAssets`, called from `importChart`
  (`src/helpers/imports.ts:734`, `:917`) and from `LocalStorageWatcher.vue:135`.

That last caller is the dangerous one. See trap 1.

## M1. Schema

One field on `Chart` in `src/types.ts`, beside the existing `mindmaps`:

```ts
  // Present ONLY in an exported or file-saved chart, never in localStorage:
  // the sheets themselves, keyed by the sheet ids that `mindmaps` points at.
  // Out-of-line while live, inline in the file — the same rule the tile
  // covers follow, and for the same reason: a file has to open on a machine
  // that has never seen this one.
  mindmapSheets?: Record<string, Sheet>
```

## M2. Export — inline

In `src/helpers/assets.ts`, alongside the existing cover inlining: read every
sheet named in `chart.mindmaps` out of the mindmap store and attach them as
`chart.mindmapSheets`.

- A `mindmaps` entry whose sheet is missing from IndexedDB is **skipped, not
  fatal**. Drop the `mindmaps` entry too, so the file never references a sheet
  it does not carry — a dangling id is what created this bug in the first
  place.
- Do not mutate the live chart. The existing helpers clone (`cloneItems`,
  `cloneCoordinates`); follow that.

## M3. Import — restore

In `persistChartAssets`, the reverse: for each entry in `mindmapSheets`, write
the sheet under a **freshly generated id**, rewrite `chart.mindmaps` to point
at the new id, and delete `mindmapSheets` from the chart before it goes any
further.

Sheet ids are per-machine IndexedDB keys, not content addresses. Importing the
same file twice, or importing someone else's, must produce new ids — otherwise
the second import overwrites the first one's maps and the user loses a map by
opening a file.

## M4. Tests — `tests/mindmap-save.test.ts`

Through `fake-indexeddb`:

1. **Round trip.** A chart with two mindmaps → export → clear both IndexedDB
   databases → import → both maps open with their original topics. This is the
   whole point of the task; write it first.
2. **Shared nothing.** The imported chart's `mindmaps` ids differ from the
   exported file's, and both maps still resolve.
3. **Double import.** Importing the same file twice yields two independent
   charts; editing one does not change the other.
4. **Dangling id.** A chart whose `mindmaps` names a sheet not in the store
   exports without that entry, and imports without error.
5. **`mindmapSheets` never survives into the store.** After import, the chart
   handed to pinia has no `mindmapSheets` key.

---

# Traps

**1. `persistChartAssets` also runs on every autosave.** `LocalStorageWatcher.vue:135`
calls it on the debounced write to localStorage — not just on file import. If
your restore logic runs there, it will rewrite sheet ids on every keystroke and
re-key the user's maps continuously. **Gate the restore on the presence of
`mindmapSheets`**, which only a file ever carries, and make sure the autosave
path leaves `mindmaps` untouched. Write test 5 before you write the code.

**2. Never let `mindmapSheets` reach localStorage.** It must be stripped in M3
before the chart reaches the pinia store, and never added by the autosave path.
Verify by hand: build a map, wait for autosave, and inspect the `charts` key —
it must hold ids only.

**3. Images inside mindmaps are out of scope.** S1–S2 mindmaps carry no images
yet. When they do, they will need the same inlining, and the field for it
(`mindmapAssets`, keyed by asset id, shared across sheets so a picture used by
two maps travels once) is already designed — but do not build it now, and do
not stub it.

**4. The save path is where this repo has been burned before.** `git log` shows
`fix/save-safety` and "Stop losing charts, files and images on the save paths".
Read those commits before touching `imports.ts`. Do not restructure the
write-through or the file-handle logic; add to it.

**5. Do not reintroduce `.rnode` import.** It was built in S2 and deliberately
removed — the user does not want it. Mindmaps are authored in thoughtslibrary.

---

# Definition of done

- `npm run lint`, `npm run build`, `npm test` green.
- **The portability test, by hand:** build a chart with two mindmaps, save it
  to a file, then open the app in a **fresh browser profile** (or delete the
  `thoughtslibrary-mindmaps` and `thoughtslibrary-assets` databases, which is
  the same thing and faster) and import the file. Both maps open with their
  topics intact.

  A clean profile is not optional. The failure this guards against is an export
  that looks complete only because the exporting machine still has the sheets
  in IndexedDB, and testing on that machine cannot tell a working file from a
  broken one.
- The `charts` localStorage key contains sheet **ids**, never sheet content,
  after a normal editing session.

If a step cannot be completed, say so plainly with what you tried.
