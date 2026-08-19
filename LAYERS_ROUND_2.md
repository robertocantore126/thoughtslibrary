# Related Layers — Round 2

Changes deferred until after round 1 (`LAYERS_AGENT_BRIEFS.md`) merges. **Do not hand this
to the round-1 agents.** It amends the frozen contract, and changing that mid-flight is
exactly what §8 of the briefs warns against.

---

## R2.1 — Layer bounds gain a one-cell margin ring

### Problem

Round 1 confines a layer to the chart's own bounds: `1 <= x <= size.x`, `1 <= y <= size.y`.

That makes a tile's full 8-child ring impossible to place near any edge. A tile at column 1
cannot have west, north-west, or south-west children — those need column 0. A tile at
column `size.x` cannot have east children. The practical symptom: build a tile with all 8
children in the middle of the chart, then try to drag it to an edge, and the move guard
refuses. The cluster becomes stuck in the interior.

### Fix

Widen the layer's coordinate space by one cell on **all four sides**:

```
x ∈ [0, size.x + 1]
y ∈ [0, size.y + 1]
```

The layer space is `(size.x + 2) x (size.y + 2)`, with the chart sitting in the middle.

**One ring on each side, not one row or column total.** A single extra column only
unblocks one edge; drag the tile to the opposite side and it is blocked again. Both
extremes need covering.

This is the minimum that satisfies the requirement, and it satisfies it exactly: a tile
with all 8 children occupies a 3x3 footprint, so with a one-cell margin it fits centred on
any cell of the chart, corners included. Clusters extending further than one cell from
their parent can still be refused near an edge — that is expected and unchanged.

### Where it lands

Single bounds predicate in `store.ts`. Everything else reads through it:

- `addLayerTile` — `+` buttons into the margin become legal
- `canMoveTile` — the guard inherits the wider space
- `moveLayerTile` — same
- Agent B's `+` button enable/disable logic — no code change, it already asks the store

### Careful: the resize clamp

`setWidth` / `setHeight` (round 1, step A5) compute the minimum safe dimension from the
largest absolute x/y occupied by any layer tile. With the margin ring, a tile legitimately
sitting at `x = 0` or `x = size.x + 1` must **not** be treated as forcing the chart wider.

Subtract the margin when computing the clamp, or resizes that are actually safe will be
refused. This is the one place where the change is not purely mechanical.

### Capacity

Per layer: `(W+2)(H+2) - 1`. Total across the chart: `(W x H) x ((W+2) x (H+2))`.

| Chart | Round 1 max | Round 2 max |
|---|---|---|
| 5 x 5 | 625 | 1,225 |
| 10 x 10 | 10,000 | 14,400 |
| 60 x 60 | 12,960,000 | 13,838,400 |

Still a ceiling reachable only by millions of manual clicks. No storage implications.

### Rendering

No new work. `FocusOverlay` mounts in `.chart-builder`, outside `.chart-viewport`'s
`overflow: auto`, so margin-ring tiles hanging past the chart edge are not clipped. They
may extend toward the window edge on a chart that fills the pane — acceptable, and worth a
look once it is running.

### Contract delta

`§1 Shared Context` bullet "Layers are confined to chart bounds" becomes:

> **Layers are confined to chart bounds plus a one-cell margin ring.** A layer tile's
> absolute position must satisfy `0 <= x <= size.x + 1` and `0 <= y <= size.y + 1`.

No type signatures change. No action signatures change. Agents B and C need no rework —
B's `+` buttons and drag refusal already delegate to the store, and C reads layer contents
without caring about bounds.

---

## R2.2 — Carried over from round 1

- **A9, IndexedDB migration** — marked optional in round 1 and skippable. Revisit only if
  chart JSON actually approaches the localStorage cap.
- **Cross-layer dragging** — moving tiles between the grid and a layer. Deliberately out of
  scope in round 1; still undecided.
