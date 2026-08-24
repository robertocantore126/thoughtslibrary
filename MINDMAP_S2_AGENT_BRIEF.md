# Task: mindmap S2 — culling done properly, styling, and `.rnode` import

Stage 2 of `MINDMAP_NATIVE_AGENT_BRIEF.md`. Read §0.2 (why SVG and DOM), §0.3
(the frozen contract) and §T (traps) of that document first — both still apply
in full, and §0.3 is still frozen.

## Where S1 left off

`main` at `fbc00bd`. Schema, ops, history, layout, geometry, storage, the pinia
store, and the overlay with pan/zoom and S1 editing. **66 tests, lint and build
green.** Branch from `main`.

A first attempt at viewport culling was made and **not merged**. It is preserved
on `feat/mindmap-culling` (`68a67f7`). M1 below replaces it. Read it — three
parts of it are correct and worth lifting — but do not merge it as it stands.

Gates, unchanged:

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
Comments explain *why* a rule exists, never what a line does.

---

# M1. Viewport culling, done properly

## Why the first attempt failed

Not because culling is wrong, but because of what it did to **measurement** and
to **edges**. Both are worth understanding before writing code, because both
are easy to reintroduce.

**The measurement trap.** Sizes come from the DOM (S1 M5). Cull a node out of
the DOM and it can never be measured — so the first attempt gave unmeasured
nodes a flat `120x40` fallback and ran the tidy-tree on it. As you panned,
nodes mounted for the first time, got their true size, and layout repacked:
**topics you had already looked at moved.** The layout became a function of
where you happened to have panned. Fixed in M1.2.

**The edge trap.** It drew an edge only when *both* endpoints were mounted. An
edge with one end off-screen still crosses the viewport, so panning a parent
out of the cushion left its children floating with no connector. Fixed in M1.3.

**What that attempt got right, and you should lift:** the world-space viewport
computation (`screen = world * scale + camera`, inverted), the `ResizeObserver`
that keeps the viewport box current, and the settle-debounce that keeps
measurement off the pan path so §T.4's single-transform rule survives.

## M1.1 `src/mindmap/cull.ts` — the logic, pure and tested

The first attempt put the predicate inside a `.vue` file, where it cannot be
tested. It is pure geometry over data; it belongs in a module.

```ts
export interface Viewport { x: number, y: number, w: number, h: number }

/** A node's world rect from its laid-out position and measured size. */
export function rectOf(node: MindNode, sizes: Record<string, NodeSize>): Rect

/** Nodes whose rect intersects `viewport` grown by `margin` (world units). */
export function cullNodes(
  nodes: MindNode[],
  sizes: Record<string, NodeSize>,
  viewport: Viewport,
  margin: number,
): MindNode[]

/**
 * Whether the edge between two nodes can be seen. TRUE when the union of the
 * two rects intersects the padded viewport — not when both endpoints are
 * visible. A long edge from an off-screen parent crosses the screen and must
 * be drawn.
 */
export function edgeVisible(
  parent: Rect,
  child: Rect,
  viewport: Viewport,
  margin: number,
): boolean
```

`edgeVisible` uses the union of the two rects because a curve drawn between two
boxes stays inside their union, plus the horizontal bulge of its control
handles. Pad the union by `EDGE_BULGE` (export it; the same constant the
geometry layer uses for its handle length) so a bulging curve is never clipped
at the moment its endpoints leave.

## M1.2 The measurement layer — how an unmounted node gets a real size

This is the heart of the fix. **Layout must never run on a guessed size for a
node that has text**, or M1's whole failure repeats.

Add a hidden measurement layer to `MindmapCanvas.vue`, rendered **outside**
`.mindmap-world` so the camera transform never touches it:

```html
<div class="mindmap-measure" aria-hidden="true">
  <div
    v-for="node in unmeasuredNodes"
    :key="node.id"
    :ref="el => setMeasureEl(node.id, el)"
    class="mindmap-node"
  >
    <span class="mindmap-node-title">{{ node.title }}</span>
  </div>
</div>
```

- `position: absolute; visibility: hidden; pointer-events: none;` and out of
  flow, so it costs layout but never paint or hit-testing.
- It **must reuse the same `.mindmap-node` class** as the real component. Two
  stylesheets for the same box is two answers to "how wide is this topic", and
  the one layout uses will be the wrong one. Share the class; do not copy the
  rules.
- It contains only *unmeasured* nodes, so in steady state it is **empty**. Only
  new or edited topics ever pass through it.

`unmeasuredNodes` is driven by a content key, not by node id alone — a renamed
topic must be re-measured:

```ts
/** Everything that can change a topic's box. Style lands in M2; add to this. */
function sizeKey(node: MindNode): string
```

Cache entries as `{ key, w, h }`. A node is unmeasured when its stored `key`
differs from `sizeKey(node)`, which makes rename-invalidation automatic instead
of something a future stage has to remember.

Sequence, and it must be this order:

1. structure or a title changes → `unmeasuredNodes` gains entries
2. Vue renders the measure layer
3. a `flush: 'post'` watcher reads **all** sizes in one batch (§T.4 — never
   interleave read and write)
4. merged into the size cache, which empties `unmeasuredNodes`
5. `applySizes` → layout → `cullNodes` picks what mounts

Port r-node's `HEURISTIC_MEASURER` (`src/layout/measure.ts:44` —
`text.length * fontSize * 0.55`) as the size for a node that somehow reaches
layout with no measurement at all. It is a guard against a blank frame, **not**
the mechanism: if you find layout routinely using it, the measure layer is
broken and the pan-shift bug is back.

## M1.3 Edges

`MindmapEdges.vue` must take the **full** node list and the size cache, not the
culled list — it needs rects for off-screen endpoints. Draw an edge when
`edgeVisible(...)` says so.

Collapsed subtrees stay excluded, as today: a curve to a folded-away node reads
as a rendering bug.

The SVG's `bounds` may be computed from the drawn edges rather than all nodes,
which keeps it small — but guard the empty case; the first attempt correctly
returned a zero rect when no node was finite, and that guard must survive.

## M1.4 Cleanup

- `MindmapNode.vue`'s `hidden` prop and `.is-hidden` CSS are dead once
  collapsed nodes are filtered before mount. Delete both rather than leaving a
  prop that is always `false`.
- The comment above `hiddenIds` in `MindmapCanvas.vue` says collapsed nodes
  "stay in the DOM (visibility, not display) so the canvas still measures
  them". Under M1.2 they are measured by the measure layer instead. Rewrite it;
  a comment that describes the previous design is worse than none.

## M1.5 Tests — `tests/mindmap-cull.test.ts`

1. A node fully inside the viewport is kept; one far outside is dropped.
2. A node straddling the edge is kept (test all four edges).
3. `margin` widens the kept set — a node just outside is kept with a cushion,
   dropped without one.
4. **`edgeVisible` is true when only the parent is off-screen**, and true when
   only the child is. This is the regression test for the first attempt's bug;
   write it first.
5. `edgeVisible` is false when both rects are far off-screen on the same side.
6. `sizeKey` changes when a title changes, so a rename re-measures.

---

# M2. The `Style` fields

`MindmapNode.vue` currently renders a title, selection ring and collapse toggle
and **nothing from `node.style`**. The schema has carried the full `Style`
interface since S1; this is where it starts being read.

Render, in this order of value: `fill`, `textColor`, `stroke` +
`borderWidth` + `borderStyle`, `cornerRadius`, `shape` (start with `rounded`,
`rect`, `capsule`, `underline`, `none` — the path-based shapes are S3),
`fontSize`, `fontWeight`, `italic`, `underline`, `strikethrough`, `opacity`,
`shadow`.

Two rules:

- **Chart values are the default, style is the override.** A topic with no
  `fill` uses the chart's palette and a topic with no `fontFamily` uses
  `chart.font`, exactly as S1 does today. Inheriting the chart's look is the
  main thing this native build has over embedding r-node (§0.2); a hard-coded
  default palette throws it away.
- **Anything affecting the box must be in `sizeKey`.** `fontSize`,
  `fontWeight`, `italic`, `borderWidth` and `cornerRadius` all change measured
  size. Miss one and that topic keeps a stale size until something else
  invalidates it — the exact bug class M1.2 exists to close.

---

# M3. The inspector

A panel in `MindmapOverlay.vue`, driven by `store.selection`, editing the M2
fields on the selected topic.

- Every edit goes through a store action and therefore through an op, so
  **Ctrl+Z undoes a style change**. Do not mutate `node.style` directly; ops
  and their inverses already exist (`setStyle` landed in Lane A).
- Reuse the existing colour picker rather than writing one (§T.7).
- A style edit is a normal op: it marks dirty, debounces a save, and enters
  history like any other.

---

# M4. ~~`.rnode` import~~ — DROPPED

Built, then removed at the user's request: mindmaps are authored in
thoughtslibrary, and importing existing r-node documents is not wanted. The
helper, its tests and the overlay's Import button are gone; the code is in git
history if that ever changes.

What replaced it as the priority is `MINDMAP_S3_AGENT_BRIEF.md` — the saved
chart JSON does not currently carry mindmap content at all, which is silent
data loss on the save path.

---

# Traps specific to S2

**1. Do not let layout run on a guessed size.** The whole of M1.2 exists for
this. If you catch yourself adding a fallback branch in the layout path, stop —
that is the pan-shift bug being rebuilt.

**2. Do not cull by "both endpoints visible".** M1.3. It is the most natural
rule to write and it is wrong.

**3. One stylesheet for the topic box.** The measure layer and the real
component must share the `.mindmap-node` class. Copying the rules gives two
answers to the same question and layout will use the wrong one.

**4. Every box-affecting style field goes in `sizeKey`.** M2.

**5. Style edits are ops, not mutations.** M3. A style change that skips the op
system is invisible to undo, and the user finds out by losing work.

**6. Do not touch `src/mindmap/layout.ts`, `ops.ts`, `history.ts`,
`geometry.ts` or `storage.ts`.** They are landed, tested, and have callers. If
one genuinely needs a change, say so in your final message rather than making
it.

**7. Culling is still not the goal.** The real maps are 18–67 topics. M1 exists
so the 3,000-topic outlier is usable and so the seam is correct — not because
the common case needs it. If M1 gets complicated enough to threaten M2 and M3,
say so and stop; shipping styling without culling is a better S2 than the
reverse.

---

# Order of work

1. M1.1 and M1.5 — the pure module and its tests, before any component
   changes. Test 4 first: it is the regression test for the known bug.
2. M1.2 — the measure layer. Verify by hand that a 3,000-topic map
   (`ciuccia.rnode` once M4 lands, or a generated sheet before then) lays out
   identically whether or not you pan around it. That equality **is** the fix.
3. M1.3, M1.4 — edges and cleanup.
4. M2 — styling.
5. M3 — the inspector.
6. M4 — import.

# Definition of done

- `npm run lint`, `npm run build`, `npm test` green.
- **Panning a large map never changes its layout.** Open a map, screenshot it,
  pan to the far edge and back, screenshot again — identical.
- An edge from an off-screen parent to an on-screen child is drawn.
- A styled topic renders its style, and Ctrl+Z undoes a style change.
- `esempio.rnode.json` imports into a tile and opens with all 37 topics.
- No file touched outside this brief's scope; anything you needed and did not
  own is listed in your final message.

If a step cannot be completed, say so plainly with what you tried. A
half-finished stage with an honest account is worth more than a green one
achieved by disabling a check.
