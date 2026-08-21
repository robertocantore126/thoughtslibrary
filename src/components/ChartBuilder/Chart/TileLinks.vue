<script setup lang="ts">
import type { TileLink } from '../../../types'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useStore } from '../../../store'

const props = defineProps<{
  links: TileLink[]
}>()

const store = useStore()

// The element this overlay measures against is simply whatever it was mounted
// inside — `#chart` for the grid, the focus overlay's host for a layer. That
// also scopes the [data-item-id] lookup below: a focused tile renders twice,
// once in the grid and once in the overlay, and querying from the right root
// is what keeps the two sets of arrows from finding each other's copies.
const svg = ref<SVGSVGElement | null>(null)

interface Arrow {
  key: string
  x1: number
  y1: number
  x2: number
  y2: number
}

const arrows = ref<Arrow[]>([])
const size = ref({ width: 0, height: 0 })

// How far short of the target the arrowhead stops, so the tip sits just off
// the cover rather than on top of it.
const TIP_GAP_PX = 6

// Where the line from a rect's centre in direction (dx, dy) crosses that
// rect's edge. Anchoring both ends this way means an arrow never starts or
// ends underneath a cover, at any angle.
function edgePoint(
  cx: number,
  cy: number,
  halfW: number,
  halfH: number,
  dx: number,
  dy: number,
): { x: number, y: number } {
  const scaleX = Math.abs(dx) > 1e-6 ? halfW / Math.abs(dx) : Number.POSITIVE_INFINITY
  const scaleY = Math.abs(dy) > 1e-6 ? halfH / Math.abs(dy) : Number.POSITIVE_INFINITY
  const scale = Math.min(scaleX, scaleY)

  if (!Number.isFinite(scale)) {
    return { x: cx, y: cy }
  }

  return { x: cx + dx * scale, y: cy + dy * scale }
}

// Scroll and resize fire far faster than they need answering, so those are
// coalesced to one measurement per frame. Nothing else goes through here:
// requestAnimationFrame does not run at all in a background tab, and an arrow
// that only appears once the window is looked at is worse than one measured a
// frame early. Mount and store changes measure immediately instead.
let geometryFrame: number | null = null

function scheduleUpdate() {
  if (geometryFrame !== null) {
    return
  }
  geometryFrame = requestAnimationFrame(() => {
    geometryFrame = null
    updateGeometry()
  })
}

function updateGeometry() {
  const root = svg.value?.parentElement
  if (!root) {
    return
  }

  const rootRect = root.getBoundingClientRect()
  size.value = { width: rootRect.width, height: rootRect.height }

  // One measurement per tile that an arrow actually touches, not per tile in
  // the chart — a 60x60 grid with three arrows measures six elements.
  const rects = new Map<string, DOMRect>()
  const rectFor = (id: string): DOMRect | null => {
    const cached = rects.get(id)
    if (cached) {
      return cached
    }

    const el = root.querySelector(`[data-item-id="${CSS.escape(id)}"]`)
    if (!el) {
      return null
    }

    const rect = el.getBoundingClientRect()
    rects.set(id, rect)
    return rect
  }

  const next: Arrow[] = []

  for (const link of props.links) {
    const fromRect = rectFor(link.from)
    const toRect = rectFor(link.to)
    if (!fromRect || !toRect) {
      continue
    }

    const fromCx = fromRect.left + fromRect.width / 2 - rootRect.left
    const fromCy = fromRect.top + fromRect.height / 2 - rootRect.top
    const toCx = toRect.left + toRect.width / 2 - rootRect.left
    const toCy = toRect.top + toRect.height / 2 - rootRect.top

    const dx = toCx - fromCx
    const dy = toCy - fromCy
    if (dx === 0 && dy === 0) {
      continue
    }

    const start = edgePoint(fromCx, fromCy, fromRect.width / 2, fromRect.height / 2, dx, dy)
    const rawEnd = edgePoint(toCx, toCy, toRect.width / 2, toRect.height / 2, -dx, -dy)

    // Back the tip off along the line rather than along an axis, so the gap is
    // the same whichever direction the arrow runs.
    const length = Math.hypot(dx, dy)
    const end = {
      x: rawEnd.x - (dx / length) * TIP_GAP_PX,
      y: rawEnd.y - (dy / length) * TIP_GAP_PX,
    }

    next.push({ key: `${link.from}->${link.to}`, x1: start.x, y1: start.y, x2: end.x, y2: end.y })
  }

  arrows.value = next
}

// The store replaces `chart` wholesale on every mutation, so a shallow watch
// catches every move, swap and resize. `post` flush matters: the arrows are
// measured from the DOM, so they have to be read after Vue has repainted the
// tiles into their new positions, never before.
watch(
  () => [props.links, store.chart] as const,
  updateGeometry,
  { flush: 'post' },
)

const hasArrows = computed(() => arrows.value.length > 0)

let observer: ResizeObserver | null = null

onMounted(() => {
  updateGeometry()

  // Capture phase: the chart scrolls inside .chart-viewport, not the window,
  // so a bubbling listener on window would never hear it.
  window.addEventListener('scroll', scheduleUpdate, true)
  window.addEventListener('resize', scheduleUpdate)

  const root = svg.value?.parentElement
  if (root && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(scheduleUpdate)
    observer.observe(root)
  }
})

onUnmounted(() => {
  window.removeEventListener('scroll', scheduleUpdate, true)
  window.removeEventListener('resize', scheduleUpdate)
  observer?.disconnect()
  if (geometryFrame !== null) {
    cancelAnimationFrame(geometryFrame)
  }
})
</script>

<template>
  <!-- Ignored by html2canvas so the PNG export stays a clean chart: the arrows
  are an on-screen thinking aid, not part of the exported artefact. The PDF
  export needs nothing here, since it rebuilds the chart from the data. -->
  <svg
    ref="svg"
    class="tile-links"
    data-html2canvas-ignore
    :width="size.width"
    :height="size.height"
    :viewBox="`0 0 ${size.width} ${size.height}`"
  >
    <defs>
      <marker
        id="tile-link-arrowhead"
        markerWidth="7"
        markerHeight="7"
        refX="6"
        refY="3.5"
        orient="auto"
        markerUnits="strokeWidth"
      >
        <path d="M0,0 L7,3.5 L0,7 Z" class="tile-link-head" />
      </marker>
    </defs>

    <template v-if="hasArrows">
      <g v-for="arrow in arrows" :key="arrow.key">
        <!-- Drawn twice: a dark halo underneath, then the line itself. A single
        stroke disappears against a background of its own colour, and the chart
        background is whatever the user picked. -->
        <line
          class="tile-link-halo"
          :x1="arrow.x1" :y1="arrow.y1" :x2="arrow.x2" :y2="arrow.y2"
        />
        <line
          class="tile-link-line"
          :x1="arrow.x1" :y1="arrow.y1" :x2="arrow.x2" :y2="arrow.y2"
          marker-end="url(#tile-link-arrowhead)"
        />
      </g>
    </template>
  </svg>
</template>

<style scoped>
.tile-links {
  position: absolute;
  left: 0;
  top: 0;
  /* Arrows are decoration: every click, drag and drop belongs to the tiles
     underneath. Deleting one is done from the sidebar. */
  pointer-events: none;
  overflow: visible;
  z-index: 5;
}

.tile-link-halo {
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 5;
  stroke-linecap: round;
}

.tile-link-line {
  stroke: #ffffff;
  stroke-width: 2;
  stroke-linecap: round;
}

.tile-link-head {
  fill: #ffffff;
  stroke: rgba(0, 0, 0, 0.55);
  stroke-width: 0.6;
}
</style>
