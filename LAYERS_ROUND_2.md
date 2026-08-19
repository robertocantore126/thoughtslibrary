# Related Layers — Round 2 (implemented)

Round 1 tied a layer to the chart: a layer was a grid the same size as the chart,
confined to its bounds. Round 2 cuts that tie. **A layer is now its own coordinate
space centred on its parent, bounded only by how far it may reach.**

An earlier draft of this document proposed a one-cell margin ring around the chart.
That was superseded: a margin ring only fixed the 8-children-at-an-edge case, and
left small charts unable to carry large layers. The reach model solves both.

---

## R2.1 — Layers are bounded by reach, not by the chart

### Rule

```
-reach <= dx <= reach        -reach <= dy <= reach
```

`Chart.layerReach` holds the value, default `DEFAULT_LAYER_REACH` (3, a 7x7 field
of 48 cells around the parent), adjustable 1–12 from the **Layer Reach** slider in
the Options sidebar.

Nothing about the chart constrains a layer any more. A 3x3 chart can carry a
48-cell layer on every tile, including corner tiles.

### What this deleted

The reach model made three pieces of round-1 machinery unnecessary, because a move
or resize can no longer strand a layer tile:

| Removed | Was |
|---|---|
| `canMoveTile` getter | Refused a tile move when it would push a child out of chart bounds, including the swap case |
| `moveItem` guard | Called the above |
| `layerLeavesBounds` | Bounds test behind both |
| `minDimensionForLayers`, `blockingParentTitles` | Computed the resize clamp |
| Resize clamping in `setWidth` / `setHeight` | Refused to shrink past a layer tile |
| `resizeBlockMessage` state + its Options display | Explained the clamp |
| Drag-refusal branch in `Item.vue` `allowDrop` | Signalled a refused move |

`setWidth` / `setHeight` are back to their original one-line form. Shrinking the
chart to 1x1 leaves every layer untouched.

### Backward compatibility

Reach limits **creation and movement only**. Layer tiles already stored outside the
current reach still render and can still be selected, edited, and moved back inward.
Nothing is deleted or hidden when reach shrinks, so round-1 charts open intact even
though they predate the setting.

---

## R2.2 — Overlay positioning had to change with it

`FocusOverlay.getCellRect` used to find a layer cell's screen position by computing
a grid index and querying `.item[data-index=N]`. That cannot survive round 2:

- Cells outside the chart have no `.item` element at all.
- Worse, the index arithmetic **wraps**. A cell one column past the right edge
  resolves to a real element on the next row, so the tile rendered in the wrong
  place with no error.

Positions are now stepped arithmetically off the parent's own measured cell:

```
pitchX = parentCell.width  + max(6, gap / 2)     // matches Row.vue's column gap
pitchY = parentCell.height + gap                 // matches .row-flex's row gap
```

### Known limitation

Grid rows are not uniform in height — a tile with a two-line title is taller than an
empty cell — so a single pitch cannot align with every row at once. Layer cells stay
evenly spaced among themselves and align with the parent exactly, but can drift by
roughly a line of text per row against distant grid rows.

This is a deliberate trade. The layer is its own space now, and in focus mode the
chart sits at 0.10 opacity behind a 0.45 dark wash, so alignment with it is barely
perceptible; internal consistency of the layer is what shows.

---

## R2.3 — Carried over, still open

- **The dimmed-export bug.** `.dimmed` is applied to elements inside `#chart`, and
  neither `downloadChart` (`chart.ts`) nor `renderChartImageForPdf` (`imports.ts`)
  strips it in their `onclone`. Exporting while focus mode is active bakes the
  dimming into the PNG and the PDF's first page. Both already strip `.placeholder`
  the same way, so the fix mirrors existing code.
- **IndexedDB for chart structure.** Still optional; volumes remain small.
- **Cross-layer dragging** between the grid and a layer. Still out of scope.
