<script setup lang="ts">
import type { Viewport } from '../../../mindmap/cull'
import type { Rect } from '../../../mindmap/geometry'
import type { NodeSize } from '../../../mindmap/layout'
import { computed } from 'vue'
import { DEFAULT_GROUP_COLOR, GROUP_DASH, GROUP_PAD, GROUP_RADIUS, groupBounds, LABEL_BG, LABEL_FONT_SIZE, labelWidth, memberRectsOf } from '../../../mindmap/relations'
import { useMindmapStore } from '../../../mindmap/store'
import { DEFAULT_GROUP_BORDER_WIDTH, type MindNode } from '../../../mindmap/types'

// Boundaries (S4 §B.3): a dashed rounded rect around the union of a group's
// member rects, drawn BENEATH the tree (the canvas mounts this layer first) so
// a boundary never hides what it encloses. Same world-only geometry rule as
// the edges and relationships: a pan must not rebuild a single path.
//
// Members that no longer exist are SKIPPED at render time and never pruned
// from memberIds: a deleted topic's id stays, because restoreNode brings the
// topic back on undo and the boundary re-encloses it for free (memberRectsOf
// documents the rule).
const props = defineProps<{
  nodes: MindNode[]
  sizes: Record<string, NodeSize>
  viewport: Viewport | null
  margin: number
}>()

const store = useMindmapStore()

// The pad, radius, dash and label look come from relations.ts — the export
// draws the same boundary from the same constants, so the map and its picture
// cannot disagree. PAD here is this layer's own SVG-frame cushion, not a look.
const PAD = 12
// Grab radius of the invisible border stroke, in SCREEN pixels (see
// MindmapRelations.vue for the divide-by-scale rule).
const HIT_WIDTH = 12

interface GroupItem {
  key: string
  bounds: Rect
  color: string
  /** Border thickness in screen px — drawn as width / camera.scale (types.ts). */
  width: number
  label: string | null
  labelW: number
}

const geometry = computed<GroupItem[]>(() => {
  const sheet = store.sheet
  if (!sheet) {
    return []
  }
  const out: GroupItem[] = []
  for (const group of sheet.boundaries) {
    const rects = memberRectsOf(sheet.nodes, group.memberIds, props.sizes)
    const b = groupBounds(rects, GROUP_PAD)
    // A boundary whose members are all gone draws NOTHING — never a zero rect
    // at the origin (groupBounds in relations.ts).
    if (!b) {
      continue
    }
    const label = group.label ?? null
    out.push({
      key: group.id,
      bounds: b,
      color: group.color ?? DEFAULT_GROUP_COLOR,
      width: group.borderWidth ?? DEFAULT_GROUP_BORDER_WIDTH,
      label,
      labelW: labelWidth(label ?? ''),
    })
  }
  return out
})

const items = computed<GroupItem[]>(() => {
  const vp = props.viewport
  if (!vp) {
    return []
  }
  const x0 = vp.x - props.margin
  const y0 = vp.y - props.margin
  const x1 = vp.x + vp.w + props.margin
  const y1 = vp.y + vp.h + props.margin
  return geometry.value.filter(g =>
    g.bounds.x < x1
    && g.bounds.x + g.bounds.w > x0
    && g.bounds.y < y1
    && g.bounds.y + g.bounds.h > y0,
  )
})

const bounds = computed<Rect>(() => {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const item of items.value) {
    minX = Math.min(minX, item.bounds.x)
    minY = Math.min(minY, item.bounds.y)
    maxX = Math.max(maxX, item.bounds.x + item.bounds.w)
    maxY = Math.max(maxY, item.bounds.y + item.bounds.h)
  }
  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
  return { x: minX - PAD, y: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 }
})

const selectedIds = computed(() => new Set(store.selection.filter(r => r.kind === 'group').map(r => r.id)))

function onGroupClick(id: string, event: MouseEvent) {
  store.select({ kind: 'group', id }, event.shiftKey || event.ctrlKey || event.metaKey ? 'toggle' : 'replace')
}
</script>

<template>
  <svg
    class="mindmap-groups"
    :width="bounds.w"
    :height="bounds.h"
    :viewBox="`${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`"
    :style="{ left: `${bounds.x}px`, top: `${bounds.y}px` }"
  >
    <g v-for="item in items" :key="item.key">
      <rect
        v-if="selectedIds.has(item.key)"
        :x="item.bounds.x"
        :y="item.bounds.y"
        :width="item.bounds.w"
        :height="item.bounds.h"
        :rx="GROUP_RADIUS"
        class="mindmap-group-glow"
      />
      <!-- Hit stroke on the BORDER only (pointer-events: stroke, fill none):
      the inside of a boundary must stay clickable, or a group makes every
      topic it encloses unselectable (T.9). -->
      <rect
        :x="item.bounds.x"
        :y="item.bounds.y"
        :width="item.bounds.w"
        :height="item.bounds.h"
        :rx="GROUP_RADIUS"
        class="mindmap-group-hit"
        :stroke-width="HIT_WIDTH / store.camera.scale"
        @click="onGroupClick(item.key, $event)"
      />
      <rect
        :x="item.bounds.x"
        :y="item.bounds.y"
        :width="item.bounds.w"
        :height="item.bounds.h"
        :rx="GROUP_RADIUS"
        class="mindmap-group-line"
        :stroke="item.color"
        :stroke-width="item.width / store.camera.scale"
        :stroke-dasharray="GROUP_DASH"
      />
      <g v-if="item.label" class="mindmap-group-label">
        <rect
          :x="item.bounds.x + 6"
          :y="item.bounds.y + 6"
          :width="item.labelW"
          :height="LABEL_FONT_SIZE + 6"
          rx="4"
        />
        <text
          :x="item.bounds.x + 6 + 7"
          :y="item.bounds.y + 6 + LABEL_FONT_SIZE"
          :font-size="LABEL_FONT_SIZE"
        >
          {{ item.label }}
        </text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.mindmap-groups {
  position: absolute;
  pointer-events: none;
  overflow: visible;
}

.mindmap-group-glow {
  fill: none;
  stroke: #ff7f50;
  stroke-width: 6;
  opacity: 0.55;
}

.mindmap-group-hit {
  fill: none;
  stroke: transparent;
  pointer-events: stroke;
  cursor: pointer;
}

.mindmap-group-line {
  fill: none;
}

.mindmap-group-label {
  pointer-events: none;
}

.mindmap-group-label rect {
  fill: v-bind(LABEL_BG);
}

.mindmap-group-label text {
  fill: #ffffff;
}
</style>
