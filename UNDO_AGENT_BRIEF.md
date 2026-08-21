# Task: add undo (Ctrl+Z) for tile moves and tile connection arrows

## Repo and how to verify

`C:\Users\39389\Desktop\crazy ai repo\thoughtslibrary` — Vue 3 + TypeScript + Vite + pinia.
Work on top of the branch `feature/tile-links`.

There is **no test runner**. Verify with both of these, and both must pass clean:

```
npm run lint     # eslint, @antfu config: no semicolons, single quotes, 2-space indent
npm run build    # runs vue-tsc then vite build
```

House style: comments explain *why* a rule exists, not what the line does. Match the
surrounding code — it is heavily commented with the reasoning behind each guard.

## What to build

Ctrl+Z (and Cmd+Z on Mac) must undo these four store actions, all in `src/store.ts`:

1. `moveItem` — moving or swapping a tile on the main grid
2. `moveLayerTile` — moving a tile inside a related layer (focus mode)
3. `addTileLink` — creating a connection arrow between two tiles
4. `removeTileLink` — deleting one

Repeated Ctrl+Z walks back through the history, most recent change first.

## Read before writing anything

- `src/store.ts` — the pinia store. Look specifically at `recordTextEdit` and
  `undoTextEdit`, plus the `TextUndoEntry` interface. They are the pattern to follow.
- `src/components/TitlesSidebar.vue` — `handleUndoHotkey`, the existing Ctrl+Z listener.
- `src/components/LocalStorageWatcher.vue` — how chart state gets persisted.

## Five things that will break this if you miss them

**1. A Ctrl+Z handler already exists.** `handleUndoHotkey` in
`src/components/TitlesSidebar.vue`. It only acts when `document.activeElement` is an
`INPUT` or `TEXTAREA`; outside a text field it returns early and does nothing today.
Do **not** add a second `window` keydown listener for Ctrl+Z — both would fire on every
press. Extend the existing one: in a text field, keep calling `store.undoTextEdit()`;
otherwise call your new structural undo.

**2. `chart` is replaced wholesale on every mutation, never mutated in place.** Every
action does `this.chart = { ...this.chart, ... }`. So you do **not** need deep cloning:
pushing the previous `this.chart` reference onto a stack is already an immutable
snapshot. `LocalStorageWatcher.vue` documents and depends on this same property. Use it.

**3. Only record an undo entry when the state actually changed.** All four actions can
be no-ops:

- `moveItem` returns early when `canMoveTile` refuses (the move would push a related
  layer out of the chart's bounds)
- `addTileLink` refuses a self-link, an exact duplicate, and any pair whose two ends are
  not in the same context (two grid tiles, or two tiles of one layer)
- `removeTileLink` returns when the link is not there

If you push the undo entry before those guards, Ctrl+Z will appear dead for several
presses while it burns through no-op entries. Record *after* the guards, at the point
where you know the chart is about to change.

**4. Clear your stack everywhere `textUndoStack` is cleared.** Two actions in
`src/store.ts` do this: `setEntireChart` and `reset`. They fire when a chart is loaded
or the user switches charts. Miss this and Ctrl+Z will apply one chart's history to a
different chart.

**5. Never resolve an undo by grid position.** The existing `TextUndoEntry` stores an
`itemId` and resolves through `findSelectionForItem` for a documented reason: "a move
between the edit and the undo would otherwise restore the value onto whatever tile now
occupies the recorded cell." Snapshotting the whole `chart` (see #2) gets this right
automatically; any position-keyed scheme will not.

## Recommended approach

Snapshot-based, mirroring the existing text-undo structure:

- State: `chartUndoStack: Chart[]`, capped the way `textUndoStack` is (it caps at 300
  and slices the front off).
- A small private helper invoked at the top of each of the four actions, *after* their
  guards: push `this.chart` onto the stack, then let the action proceed.
- `undoChartChange()`: pop, assign to `this.chart`, then clear `selection` and
  `notesPopupKey` if they now point at something the restored chart no longer contains.
- Wire it into `handleUndoHotkey`'s non-text-field branch.

A useful side effect of snapshotting: it also correctly reverses the link-pruning that
`moveItem` and `addItem` perform via `pruneDanglingLinks`, because it restores the whole
chart rather than replaying an inverse operation.

## Acceptance criteria

- Move a tile to an empty cell → Ctrl+Z → it returns to its original cell
- Swap two tiles → Ctrl+Z → both return to their original cells
- Move a tile inside a focused layer → Ctrl+Z → it returns
- Shift-drag to create an arrow → Ctrl+Z → the arrow disappears
- Delete an arrow via the sidebar Connections list → Ctrl+Z → the arrow comes back
- Several changes in a row → repeated Ctrl+Z walks back through all of them in order
- Ctrl+Z inside the title / creator / notes fields still performs text undo, unchanged
- Ctrl+Z on an empty stack does nothing and does not throw
- Attempt a move or link that a guard refuses, then Ctrl+Z → it undoes the previous
  *real* change rather than consuming a no-op entry
- Switch to another chart, then Ctrl+Z → it must not resurrect the previous chart's state
- `npm run lint` and `npm run build` both pass clean

## Out of scope

Redo (Ctrl+Shift+Z / Ctrl+Y). Undo for adding or deleting tiles, image drops, chart
resizes, or option changes. Do not refactor the existing text-undo system — extend
around it.
