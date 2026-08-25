<script setup lang="ts">
import type { Viewport } from '../../../mindmap/cull'
import type { Rect } from '../../../mindmap/geometry'
import type { NodeSize } from '../../../mindmap/layout'
import type { MindNode, Sheet } from '../../../mindmap/types'
import { computed, ref } from 'vue'
import { edgeVisible, rectOf } from '../../../mindmap/cull'
import { addRelationship } from '../../../mindmap/relationCommands'
import { arrowheadPath, DEFAULT_RELATIONSHIP_COLOR, LABEL_BG, LABEL_FONT_SIZE, labelWidth, type Point, relationshipDash, relationshipMidpoint, relationshipPath, relationshipPoints } from '../../../mindmap/relations'
import { useMindmapStore } from '../../../mindmap/store'

// Free relationships between any two topics (S4 §B.2) — an SVG layer above the
// topics, modelled on MindmapEdges.vue, which solved the same problems first:
// world-only geometry so a pan rebuilds nothing, an SVG box that is the union
// of what is actually drawn, and `pointer-events: none` on the layer so every
// click falls through to the map (T.9). The one thing this layer re-enables is
// the fat invisible stroke per relationship — that is what makes a line
// clickable without swallowing the whole map.
const props = defineProps<{
  nodes: MindNode[]
  sizes: Record<string, NodeSize>
  viewport: Viewport | null
  margin: number
}>()

const store = useMindmapStore()

// Grab radius of the invisible hit stroke, in SCREEN pixels: the world
// transform scales stroke widths, so dividing by the camera scale keeps a line
// equally easy to click at every zoom — the same rule `Group.borderWidth`
// documents in types.ts. The arrowheads, dashes, label box and label text
// come from relations.ts — the export draws the same shapes from the same
// constants, so the map and its picture cannot disagree.
const HIT_WIDTH = 12
const PAD = 12

// A topic folded away keeps its stale coordinates on purpose (layout preserves
// the box so an expand has it ready); a line drawn to it would point at empty
// space, so pairs with a hidden endpoint never draw — the same filter
// MindmapEdges applies to tree edges.
function hiddenIds(sheet: Sheet): Set<string> {
  const set = new Set<string>()
  const walk = (id: string, underCollapsed: boolean) => {
    const node = sheet.nodes[id]
    if (!node) {
      return
    }
    if (underCollapsed) {
      set.add(id)
    }
    const childHidden = underCollapsed || node.collapsed
    for (const childId of node.childrenIds) {
      walk(childId, childHidden)
    }
  }
  walk(sheet.rootNodeId, false)
  return set
}

interface RelationshipItem {
  key: string
  d: string
  box: Rect
  from: Rect
  to: Rect
  mid: Point
  color: string
  dash: string | null
  toArrow: string | null
  fromArrow: string | null
  label: string | null
  labelW: number
}

function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  const x2 = Math.max(a.x + a.w, b.x + b.w)
  const y2 = Math.max(a.y + a.h, b.y + b.h)
  return { x, y, w: x2 - x, h: y2 - y }
}

// World-only geometry: the camera never enters this computed, so a pan touches
// only the CSS transform and the viewport filter below — the MindmapEdges
// cost rule, kept here for the same reason.
const geometry = computed<RelationshipItem[]>(() => {
  const sheet = store.sheet
  if (!sheet) {
    return []
  }
  const hidden = hiddenIds(sheet)
  const out: RelationshipItem[] = []
  for (const rel of sheet.relationships) {
    if (hidden.has(rel.fromId) || hidden.has(rel.toId)) {
      continue
    }
    const from = sheet.nodes[rel.fromId]
    const to = sheet.nodes[rel.toId]
    if (!from || !to) {
      continue
    }
    const fromRect = rectOf(from, props.sizes)
    const toRect = rectOf(to, props.sizes)
    const pts = relationshipPoints(fromRect, toRect, rel.connector)
    const label = rel.label ?? null
    out.push({
      key: rel.id,
      d: relationshipPath(fromRect, toRect, rel.connector),
      box: unionRect(fromRect, toRect),
      from: fromRect,
      to: toRect,
      mid: relationshipMidpoint(fromRect, toRect, rel.connector),
      color: rel.color ?? DEFAULT_RELATIONSHIP_COLOR,
      dash: relationshipDash(rel.lineStyle),
      // A plain relationship points at its target; bidirectional points both
      // ways (R05).
      toArrow: arrowheadPath(pts[pts.length - 1], pts[pts.length - 2]),
      fromArrow: rel.bidirectional ? arrowheadPath(pts[0], pts[1]) : null,
      label,
      labelW: labelWidth(label ?? ''),
    })
  }
  return out
})

const items = computed<RelationshipItem[]>(() => {
  const vp = props.viewport
  if (!vp) {
    return []
  }
  // The same union test as the tree edges: a long relationship from an
  // off-screen endpoint crosses the screen and must draw.
  return geometry.value.filter(g => edgeVisible(g.from, g.to, vp, props.margin))
})

const bounds = computed<Rect>(() => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const item of items.value) {
    minX = Math.min(minX, item.box.x)
    minY = Math.min(minY, item.box.y)
    maxX = Math.max(maxX, item.box.x + item.box.w)
    maxY = Math.max(maxY, item.box.y + item.box.h)
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  return { x: minX - PAD, y: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 }
})

// Selection is read separately from the geometry so changing the selection
// never rebuilds every path — the same reason the camera stays out of it.
const selectedIds = computed(() => new Set(store.selection.filter(r => r.kind === 'relationship').map(r => r.id)))

function onRelationshipClick(id: string, event: MouseEvent) {
  store.select({ kind: 'relationship', id }, event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
}

// ---------------------------------------------------------------------------
// Creating a relationship: drag from the anchor
// ---------------------------------------------------------------------------
// The anchor for drawing a new line: a small handle at the right edge of the
// one selected topic's box. It lives in THIS layer rather than on MindmapNode
// because that file is Lane A's (§B.2) — a drag from the handle to another
// topic creates the relationship on pointerup, and the whole gesture stays
// inside this layer's own listeners.
const handle = computed<{ id: string, x: number, y: number } | null>(() => {
  if (store.selection.length !== 1 || store.selection[0].kind !== 'node') {
    return null
  }
  const sheet = store.sheet
  const node = sheet?.nodes[store.selection[0].id]
  if (!node) {
    return null
  }
  const r = rectOf(node, props.sizes)
  return { id: node.id, x: r.x + r.w, y: r.y + r.h / 2 }
})

const connecting = ref(false)
const preview = ref<Point | null>(null)
let connectPointer: number | null = null

function startConnect(event: PointerEvent) {
  if (!handle.value) {
    return
  }
  // The whole gesture is this layer's; stop it reaching Lane C's world-level
  // pointer listener, which resolves node drags by closest('[data-node-id]')
  // and would read this start as a non-topic pointerdown it then ignores —
  // harmless, but the anchor must keep capture, and only this listener knows.
  event.stopPropagation()
  connecting.value = true
  preview.value = { x: handle.value.x, y: handle.value.y }
  connectPointer = event.pointerId
  ;(event.currentTarget as Element).setPointerCapture(event.pointerId)
}

function onConnectMove(event: PointerEvent) {
  if (!connecting.value || event.pointerId !== connectPointer) {
    return
  }
  // screen = world * scale + camera, inverted. The canvas fills the overlay,
  // which fills the viewport, so clientX/Y are already canvas coordinates.
  preview.value = {
    x: (event.clientX - store.camera.x) / store.camera.scale,
    y: (event.clientY - store.camera.y) / store.camera.scale,
  }
}

function endConnect(event: PointerEvent) {
  if (!connecting.value || event.pointerId !== connectPointer) {
    return
  }
  connecting.value = false
  connectPointer = null
  // elementFromPoint, not event.target: pointer capture keeps every event on
  // the handle, so the target under the cursor is found by hit-testing. The
  // topics carry data-node-id for exactly this (S4 §0.3).
  const target = document.elementFromPoint(event.clientX, event.clientY)
  const toId = target?.closest('[data-node-id]')?.getAttribute('data-node-id') ?? null
  const fromId = handle.value?.id
  if (fromId && toId) {
    const id = addRelationship(store, fromId, toId)
    if (id) {
      // The new line is selected so its inspector opens: the user just drew
      // it, and labelling or colouring it is the natural next move.
      store.select({ kind: 'relationship', id })
    }
  }
}
</script>

<template>
  <svg
    class="mindmap-relations"
    :width="bounds.w"
    :height="bounds.h"
    :viewBox="`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`"
    :style="{ left: `${bounds.x}px`, top: `${bounds.y}px` }"
  >
    <g v-for="item in items" :key="item.key">
      <!-- Selection glow sits UNDER the line so the line's own colour stays
      the thing the user sees. -->
      <path
        v-if="selectedIds.has(item.key)"
        :d="item.d"
        class="mindmap-rel-glow"
      />
      <path
        :d="item.d"
        class="mindmap-rel-line"
        :stroke="item.color"
        :stroke-dasharray="item.dash"
      />
      <!-- Invisible grab stroke, the ONLY pointer-answering shape of the two
      (T.9): stroke-width is set inline at the camera scale so the grab area
      is a constant screen size, and pointer-events: stroke means only the
      line itself is clickable, never the area under it. -->
      <path
        :d="item.d"
        class="mindmap-rel-hit"
        :stroke-width="HIT_WIDTH / store.camera.scale"
        @click="onRelationshipClick(item.key, $event)"
      />
      <path v-if="item.toArrow" :d="item.toArrow" class="mindmap-rel-arrow" :fill="item.color" />
      <path v-if="item.fromArrow" :d="item.fromArrow" class="mindmap-rel-arrow" :fill="item.color" />
      <g v-if="item.label" class="mindmap-rel-label">
        <rect
          :x="item.mid.x - item.labelW / 2"
          :y="item.mid.y - LABEL_FONT_SIZE / 2 - 3"
          :width="item.labelW"
          :height="LABEL_FONT_SIZE + 6"
          rx="4"
        />
        <text
          :x="item.mid.x"
          :y="item.mid.y + 4"
          text-anchor="middle"
          :font-size="LABEL_FONT_SIZE"
        >
          {{ item.label }}
        </text>
      </g>
    </g>

    <g
      v-if="handle"
      class="mindmap-rel-anchor"
      @pointerdown="startConnect"
      @pointermove="onConnectMove"
      @pointerup="endConnect"
      @pointercancel="endConnect"
    >
      <circle :cx="handle.x" :cy="handle.y" r="7" class="mindmap-rel-anchor-ring" />
      <circle :cx="handle.x" :cy="handle.y" r="3" class="mindmap-rel-anchor-dot" />
    </g>

    <line
      v-if="connecting && handle && preview"
      :x1="handle.x"
      :y1="handle.y"
      :x2="preview.x"
      :y2="preview.y"
      class="mindmap-rel-preview"
    />
  </svg>
</template>

<style scoped>
.mindmap-relations {
  position: absolute;
  pointer-events: none;
  overflow: visible;
}

.mindmap-rel-glow {
  fill: none;
  stroke: #ff7f50;
  stroke-width: 6;
  opacity: 0.55;
}

.mindmap-rel-line {
  fill: none;
  stroke-width: 2;
}

.mindmap-rel-hit {
  fill: none;
  stroke: transparent;
  pointer-events: stroke;
  cursor: pointer;
}

.mindmap-rel-arrow,
.mindmap-rel-label {
  pointer-events: none;
}

.mindmap-rel-label rect {
  fill: v-bind(LABEL_BG);
}

.mindmap-rel-label text {
  fill: #ffffff;
}

/* The anchor is the one spot on this pointer-events: none layer that must
   answer, and it is small enough to never swallow a topic click. */
.mindmap-rel-anchor {
  pointer-events: all;
  cursor: crosshair;
}

.mindmap-rel-anchor-ring {
  fill: rgba(0, 0, 0, 0.7);
  stroke: #ff7f50;
  stroke-width: 1.5;
}

.mindmap-rel-anchor-dot {
  fill: #ff7f50;
}

.mindmap-rel-preview {
  stroke: #ff7f50;
  stroke-width: 2;
  stroke-dasharray: 6 4;
  opacity: 0.9;
  pointer-events: none;
}
</style>
