<script setup lang="ts">
import type { NodeSize } from '../../../mindmap/layout'
import type { MindNode } from '../../../mindmap/types'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { cullNodes, sizeKey, type Viewport } from '../../../mindmap/cull'
import { topicBoxStyle, topicImageBoxStyle } from '../../../mindmap/nodeStyle'
import { useMindmapStore } from '../../../mindmap/store'
import MindmapEdges from './MindmapEdges.vue'
import MindmapNode from './MindmapNode.vue'

// Fired once the measure queue has been emptied by a measurement pass — the
// overlay's auto-fit signal. A sheet whose nodes carry imported positions is
// "laid out" before any measurement, so fitting on that would frame an empty
// sizes record; settled means every node that needed one now has a real size.
const emit = defineEmits<{ settled: [] }>()

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

// ---------------------------------------------------------------------------
// Viewport and culling
// ---------------------------------------------------------------------------
// A topic is mounted only when its world rect reaches the camera's viewport,
// grown by a cushion so pan does not pop topics in at the very edge. The world
// viewport is screen = world * scale + camera inverted. MINDMAP_S2_AGENT_BRIEF
// M1: the predicate lives in src/mindmap/cull.ts (pure, tested); the edges use
// edgeVisible's union test (`cullNodes` for topics, `edgeVisible` for curves);
// and layout NEVER runs on a guessed size — sizes come only from the measure
// layer below.

const CULL_MARGIN = 160

const canvasRoot = ref<HTMLElement | null>(null)
const view = ref({ w: 0, h: 0 })

const viewportRect = computed<Viewport | null>(() => {
  if (view.value.w === 0 || view.value.h === 0) {
    return null
  }
  const { x, y, scale } = store.camera
  return {
    x: -x / scale,
    y: -y / scale,
    w: view.value.w / scale,
    h: view.value.h / scale,
  }
})

// Collapsed subtrees are pruned from layout and hidden from view. They are NOT
// mounted as real nodes (the cull below filters them, and MindmapNode no longer
// carries a hidden prop — M1.4); the measure layer still sizes them so an
// expand later has their boxes ready.
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
// Sizes: the measure layer
// ---------------------------------------------------------------------------
// Sizes come from the DOM, but a culled node is not in the DOM. The first
// attempt let an unmounted node fall back to a flat box and ran the tidy-tree
// on it, so panning repacked a map you had already looked at (S2 M1). The fix:
// a hidden measurement layer, rendered OUTSIDE the transformed world so the
// camera never touches it, holding every node that has no matching cached size.
// It uses the SAME shared `.mindmap-node` class as the rendered topic, so the
// number layout reads is the number the browser will actually wrap. Only
// unmeasured topics live here, so steady state is empty.

// sizeKey(node) folds everything that can change a topic's box (title now;
// box-affecting Style fields in M2) into one string. A rename changes the key,
// dropping the node back into the measure layer for a fresh read.
interface SizeEntry {
  key: string
  w: number
  h: number
}
const sizeCache = ref<Record<string, SizeEntry>>({})

const unmeasuredNodes = computed<MindNode[]>(() => {
  const c = sizeCache.value
  return store.visibleNodes.filter((n) => {
    const e = c[n.id]
    return !e || e.key !== sizeKey(n)
  })
})

// Reference elements for the measure layer, keyed by node id (setNodeEl-style).
const measureEls = ref<Record<string, HTMLElement>>({})
function setMeasureEl(id: string, el: unknown) {
  if (el) {
    measureEls.value[id] = el as HTMLElement
  }
  else {
    delete measureEls.value[id]
  }
}

// Guard for a topic that reaches layout with no measurement at all (a measure
// layer element that failed to attach, say). Ported from r-node's
// HEURISTIC_MEASURER (text.length * fontSize * 0.55). It is a safety net
// against a blank frame, NOT the mechanism: if layout routinely sees these,
// the measure layer is broken and the pan-shift bug is back.
function heuristicSize(node: MindNode): NodeSize {
  const fontSize = node.style.fontSize ?? 14
  const w = Math.ceil(node.title.length * fontSize * 0.55)
  return { w: Math.max(84, w + 12), h: Math.ceil(fontSize * 1.25 + 12) }
}

// The full size record handed to layout and the edges. Every visible node must
// appear; the measure layer guarantees a real entry for each, and the heuristic
// only plugs a temporary gap before that measurement lands.
function sizesForLayout(): Record<string, NodeSize> {
  const c = sizeCache.value
  const out: Record<string, NodeSize> = {}
  for (const node of store.visibleNodes) {
    const e = c[node.id]
    if (e && e.key === sizeKey(node)) {
      out[node.id] = { w: e.w, h: e.h }
    }
    else {
      out[node.id] = heuristicSize(node)
    }
  }
  return out
}

// True once the first batch of measurements has been laid out. Until then the
// cull predicate has no positions to trust (every node sits at the origin), so
// mounting real topics would spike the whole map into the DOM before culling
// could trim it. The measure layer does the first sizing; only after layout has
// spread positions does the real node layer switch on. Reactive: renderedNodes
// depends on it, so flipping it must bump that computed.
const hasLayout = ref(false)

// ---------------------------------------------------------------------------
// Fonts: the other async input (S3 C.2a)
// ---------------------------------------------------------------------------
// index.html loads the app font with display=swap, so the browser paints a
// fallback face first and switches to Nunito when it arrives. Every box
// measured before the switch is sized for metrics that are about to change,
// and nothing used to re-measure afterwards — a cold load laid topics out for
// the wrong font, a warm cache for the right one. Same async-input rule as
// images below: a layout input must be knowable without waiting for anything
// async, so either wait or invalidate.
//
// A missing document.fonts (node test runner, old engines) counts as "fonts
// are ready".
let fontsWatched = false
function ensureFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || !document.fonts) {
    return Promise.resolve()
  }
  if (!fontsWatched) {
    fontsWatched = true
    // A face can arrive even AFTER ready resolves, when a family/weight gets
    // requested later. Drop every cached size when one does: unmeasuredNodes
    // repopulates and the watcher below re-reads them against real metrics.
    // Fires only when something actually loaded, so this converges.
    document.fonts.onloadingdone = () => {
      sizeCache.value = {}
    }
  }
  return document.fonts.ready.then(() => {})
}

// Measurement order matters (§T.4): read ALL box sizes in one pass, THEN hand
// the batch to the store. Interleaving read/write per node forces reflow per
// node and turns a 3,000-topic map into thousands of synchronous layouts.
// flush: 'post' so the measure layer has painted before its boxes are read.
async function syncMeasure() {
  // The web font must have swapped (or be known-absent) before the first box
  // is read, or the whole first layout runs on fallback metrics.
  await ensureFontsReady()
  await nextTick()
  let changed = false
  for (const node of unmeasuredNodes.value) {
    const el = measureEls.value[node.id]
    if (!el) {
      continue // not painted yet; the watcher re-runs after the next paint
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    sizeCache.value[node.id] = { key: sizeKey(node), w, h }
    changed = true
  }
  if (!changed) {
    return
  }
  // Every node now has a real size inside sizeCache (the unmeasured ones were
  // just read); hand the full record over so layout never guesses.
  const sizes = sizesForLayout()
  store.applySizes(sizes)
  hasLayout.value = true
  if (unmeasuredNodes.value.length === 0) {
    emit('settled')
  }
}

// Watches the set of topics that still need measuring. On a structural change
// or rename the computed gains entries; Vue paints the measure layer; this
// flush:'post' watcher reads that batch. Filling the cache shrinks
// unmeasuredNodes, which re-triggers the watcher with nothing left to read
// (changed=false) — convergence, not a loop, because applySizes only fires
// when a size actually changed.
watch(unmeasuredNodes, () => {
  void syncMeasure()
}, { flush: 'post', immediate: true })

// ---------------------------------------------------------------------------
// What actually mounts, and edges
// ---------------------------------------------------------------------------

const renderedNodes = computed<MindNode[]>(() => {
  if (!hasLayout.value || !viewportRect.value) {
    return []
  }
  const candidates = store.visibleNodes.filter(n => !hiddenIds.value.has(n.id))
  return cullNodes(candidates, sizesForLayout(), viewportRect.value, CULL_MARGIN / store.camera.scale)
})

// The real-node dimensions handed to edges match what layout used: cached sizes.
const edgeSizes = computed<Record<string, NodeSize>>(() => sizesForLayout())

// ---------------------------------------------------------------------------
// Pan and zoom
// ---------------------------------------------------------------------------

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

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  const el = canvasRoot.value
  if (!el) {
    return
  }
  const update = () => {
    view.value = { w: el.clientWidth, h: el.clientHeight }
  }
  update()
  resizeObserver = new ResizeObserver(update)
  resizeObserver.observe(el)
})

onUnmounted(() => {
  resizeObserver?.disconnect()
})
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
      <MindmapEdges
        :nodes="store.visibleNodes"
        :sizes="edgeSizes"
        :viewport="viewportRect"
        :margin="CULL_MARGIN / store.camera.scale"
      />
      <MindmapNode
        v-for="node in renderedNodes"
        :key="node.id"
        :node="node"
      />
    </div>
    <!-- The hidden measure layer: OUTSIDE the transformed world so the camera
    never moves it, holding only topics without a matching cached size (empty
    in steady state). Same .mindmap-node class as the rendered topics, so it
    measures the exact box the browser wraps. visibility:hidden still lays out
    (offsetWidth is real); opacity 0 + pointer-events none make sure it paints
    nothing and answers no clicks. -->
    <div class="mindmap-measure" aria-hidden="true">
      <!-- topicBoxStyle keeps the measurement honest: a styled topic's box must
      be measured with its own font/padding/border, or layout runs on the
      unstyled size (S2 M2 trap 4). Same helper, same box, same answer. -->
      <div
        v-for="node in unmeasuredNodes"
        :key="node.id"
        :ref="el => setMeasureEl(node.id, el)"
        class="mindmap-node"
        :style="topicBoxStyle(node)"
      >
        <!-- The image slot measures with the SAME box the rendered topic uses
        (S3 C.2b) — but without a src: the box derives from Style numbers
        alone, so measurement never waits on (or depends on) a load. -->
        <img
          v-if="topicImageBoxStyle(node)"
          class="mindmap-node-image"
          :style="topicImageBoxStyle(node)"
          alt=""
        >
        <span class="mindmap-node-title">{{ node.title }}</span>
      </div>
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
  /* The world is the transform anchor for the camera, but a 0-wide containing
     block makes every absolute topic box shrink-to-fit against 0px: long
     titles wrap at min-width (84px) instead of their natural width, while the
     measure layer (a real 623px containing block) measured the natural box —
     so layout and render disagreed about every box wider than 84px. Give the
     world the canvas width so shrink-to-fit resolves like the measure layer
     does; the height stays 0 (children are top-positioned, nothing clips), so
     the empty canvas still routes clicks to the pan ground below. */
  width: 100%;
  transform-origin: 0 0;
  /* Keep the world on its own compositor layer: without this, Chromium
     re-rasterises every mounted topic (all 3,000 of them in a full-map
     overview) in software on every pan frame. Promoted, the layer is painted
     once and panning is a texture move — the GPU cost the single-transform
     design (S2 §T.4) is supposed to buy. */
  will-change: transform;
  z-index: 1;
}

.mindmap-measure {
  position: absolute;
  left: 0;
  top: 0;
  /* A containing block with NO width shrinks every absolute measure div to its
     min-width (84px), so long titles wrap into tall strips and layout runs on
     the wrong box — the measurement cousin of the pan-shift bug. Give the
     container the canvas width so shrink-to-fit resolves against something
     real and long titles cap at the 280px max-width like the live map. */
  width: 100%;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  z-index: -1;
}
</style>
