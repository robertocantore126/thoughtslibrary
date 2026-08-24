<script setup lang="ts">
import type { NodeSize } from '../../../mindmap/layout'
import { computed, ref, watch } from 'vue'
import { useMindmapStore } from '../../../mindmap/store'
import MindmapEdges from './MindmapEdges.vue'
import MindmapNode from './MindmapNode.vue'

const store = useMindmapStore()

// ---------------------------------------------------------------------------
// The single transform
// ---------------------------------------------------------------------------
// One CSS transform on the world container carries the whole camera: panning
// and zooming are GPU compositor operations that cost the same at 3,000 topics
// as at 30. Per-node transforms would turn every pan frame into a full layout
// pass, which is how naive DOM canvases die (Lane E).

const worldStyle = computed(() => ({
  transform: `translate(${store.camera.x}px, ${store.camera.y}px) scale(${store.camera.scale})`,
}))

// Collapsed subtrees: pruned from layout, hidden from view. They stay in the
// DOM (visibility, not display) so the canvas still measures them and the map
// keeps every node's size even while a branch is folded.
const hiddenIds = computed(() => {
  const set = new Set<string>()
  const sheet = store.sheet
  if (!sheet) {
    return set
  }
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
})

// ---------------------------------------------------------------------------
// Measurement → layout, once per structural change
// ---------------------------------------------------------------------------
// Layout is derived data: an op changes the tree, layout recomputes positions
// from it (§T.2). So the canvas watches the STRUCTURE — everything layout
// derives positions from, and nothing it writes. `applySizes` republishes the
// sheet with new positions; had positions been part of the key, this watch
// would re-measure forever (measure → layout → republish → watch → measure).

const structureKey = computed(() => {
  const sheet = store.sheet
  if (!sheet) {
    return ''
  }
  return store.visibleNodes
    .map(n => `${n.id}|${n.parentId}|${n.title}|${n.collapsed}|${n.childrenIds.join(',')}`)
    .join('\n')
})

// The component ref gives the public instance; its root element is the box
// that needs measuring. Keyed by node id so a v-for of nodes maps to elements
// without index churn.
const nodeEls = ref<Record<string, HTMLElement>>({})

// The last batch of measured sizes, handed to the edges layer so it can
// compute the node rects it clips to. The store keeps the same record for
// fit(); this local copy is what the contract-typed components can read
// without reaching into a store field the frozen type does not declare.
const measuredSizes = ref<Record<string, NodeSize>>({})

function setNodeEl(id: string, el: unknown) {
  if (el) {
    nodeEls.value[id] = (el as { $el: HTMLElement }).$el
  }
  else {
    delete nodeEls.value[id]
  }
}

// Measurement order matters (Lane E): read ALL sizes first, then hand the
// batch to the store in one call. Reading offsetWidth after a write forces
// synchronous reflow; interleaving read/write per node turns a 200-node map
// into hundreds of forced reflows.
function measureAndLayout() {
  const sheet = store.sheet
  if (!sheet) {
    return
  }
  const sizes: Record<string, NodeSize> = {}
  for (const node of store.visibleNodes) {
    const el = nodeEls.value[node.id]
    sizes[node.id] = el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 120, h: 40 }
  }
  measuredSizes.value = sizes
  store.applySizes(sizes)
}

// flush: 'post' so the DOM has repainted the new tree before its boxes are
// measured; immediate covers the first render after the overlay opens.
watch(structureKey, measureAndLayout, { flush: 'post', immediate: true })

// ---------------------------------------------------------------------------
// Pan and zoom
// ---------------------------------------------------------------------------

const canvasRoot = ref<HTMLElement | null>(null)

// Wheel zooms anchored at the cursor: the world point under the pointer stays
// under the pointer, which is what makes zoom feel like magnifying rather than
// like the map sliding away. The store clamps the scale.
function onWheel(event: WheelEvent) {
  const rect = canvasRoot.value?.getBoundingClientRect()
  if (!rect) {
    return
  }
  const factor = Math.exp(-event.deltaY * 0.0015)
  store.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor)
}

// Pan by dragging the empty ground (left button) or by middle-dragging
// anywhere. Pointer capture keeps the drag alive outside the window. Camera
// deltas are screen pixels, so raw client deltas feed panBy directly.
const panning = ref(false)
let panPointer: number | null = null
let panLast = { x: 0, y: 0 }

function onGroundPointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.button !== 1) {
    return
  }
  panPointer = event.pointerId
  panLast = { x: event.clientX, y: event.clientY }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  panning.value = true
}

function onGroundPointerMove(event: PointerEvent) {
  if (event.pointerId !== panPointer) {
    return
  }
  store.panBy(event.clientX - panLast.x, event.clientY - panLast.y)
  panLast = { x: event.clientX, y: event.clientY }
}

function onGroundPointerEnd(event: PointerEvent) {
  if (event.pointerId !== panPointer) {
    return
  }
  panPointer = null
  panning.value = false
}
</script>

<template>
  <div
    ref="canvasRoot"
    class="mindmap-canvas"
    @wheel.prevent="onWheel"
  >
    <!-- The ground is the pan surface beneath the map: clicks on empty canvas
    drag it, clicks on a node reach the node instead. -->
    <div
      class="mindmap-ground"
      :class="{ panning }"
      @pointerdown="onGroundPointerDown"
      @pointermove="onGroundPointerMove"
      @pointerup="onGroundPointerEnd"
      @pointercancel="onGroundPointerEnd"
    />
    <div class="mindmap-world" :style="worldStyle">
      <MindmapEdges :sizes="measuredSizes" />
      <MindmapNode
        v-for="node in store.visibleNodes"
        :key="node.id"
        :ref="(el) => setNodeEl(node.id, el)"
        :node="node"
        :hidden="hiddenIds.has(node.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.mindmap-canvas {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}

.mindmap-ground {
  position: absolute;
  inset: 0;
  z-index: 0;
  cursor: grab;
}

.mindmap-ground.panning {
  cursor: grabbing;
}

.mindmap-world {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  transform-origin: 0 0;
  z-index: 1;
}
</style>
