<script setup lang="ts">
import type { RunParagraph } from '../../../mindmap/richtext'
import type { MindNode } from '../../../mindmap/types'
import { computed } from 'vue'
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'
import { topicImageBoxStyle } from '../../../mindmap/nodeStyle'
import { listIndentPx, paraGapPx, runParagraphs, runStyle } from '../../../mindmap/richtext'

// Everything INSIDE a topic box: the image slot and the title. It exists as one
// component because two places render it — the live topic (MindmapNode) and the
// hidden measure layer (MindmapCanvas) — and layout is only correct while those
// two agree character for character. Before S4 they were two hand-kept copies
// of the same markup, which was survivable for a plain string and is not once
// the title carries rich text: a bold word rendered in the topic but not in the
// measure layer means every formatted box is measured short and the whole map
// packs too tightly.
//
// So: content added here appears in both. Content added to MindmapNode's
// template around this component is NOT measured. That is the rule S4 Lane A
// depends on (§T.4).
const props = defineProps<{
  node: MindNode
  /**
   * Rendered inside the measure layer. The image box is identical either way —
   * it derives from Style numbers alone, never from the loaded bitmap, which is
   * what lets layout run before any byte arrives (S3 C.2b) — so measuring skips
   * resolving the bytes at all rather than asking the asset store for a URL it
   * would never paint.
   */
  measuring?: boolean
  /** The live topic hides the title while its inline editor is open. */
  hideTitle?: boolean
  /**
   * Live-only image-width override while the image resize handle is dragged
   * (MindmapNode commits one setNodeStyle on pointerup). The measure layer
   * never passes it, so it always sizes from the stored Style numbers.
   */
  imageWidth?: number
  /**
   * The live topic's image is selected ({ kind: 'image', id: node.id }): the
   * measure layer never paints a selection, so it never passes this.
   */
  imageSelected?: boolean
}>()

// The image is itself selectable (MindmapNode listens): clicking it selects
// the image ref, so Delete removes just the picture, not the topic. The
// measure layer never gets a click, so the emit is inert there.
const emit = defineEmits<{
  imageClick: []
}>()

const imageBox = computed(() => topicImageBoxStyle(props.node, props.imageWidth))
const resolvedImage = useResolvedImageUrl(() => (props.measuring ? undefined : props.node.style.image))

// An unstyled title keeps `titleRuns` UNDEFINED (§A.1) and renders through the
// original single-span path, byte for byte as it did before this lane. That is
// not just economy in the save file: it means every map that never used
// formatting measures and wraps exactly as it always has, so this change
// cannot move a single existing topic.
const paragraphs = computed(() => {
  const runs = props.node.titleRuns
  return runs && runs.length > 0 ? runParagraphs(runs) : null
})

/**
 * The paragraph box style. When the paragraph carries a block background the
 * topic fills one rectangle behind ALL its runs (r-node parity) — not thin
 * per-run strips. The padding is the block's own breathing room; negative
 * side margins let stacked filled paragraphs in the same section form one
 * contiguous block, and a side bleed pads the fill past the flush edges.
 */
function paraStyle(para: RunParagraph): Record<string, string> | undefined {
  // The paragraph's effective font size drives the hanging bullet indent and
  // the block-gap — proportional, so a multi-size title keeps its hierarchy.
  const fontPx = props.node.style.fontSize ?? 14
  const indent = para.listIndent > 0 ? listIndentPx(para.listIndent, fontPx) : 0
  // The hanging indent pulls the first line (with the • marker) back out of
  // the padding so wrapped lines align under the text, r-node-style.
  const base: Record<string, string> = indent > 0
    ? { paddingLeft: `${indent}px`, textIndent: `-${indent}px` }
    : {}
  const gapPx = para.paraGap ? paraGapPx(fontPx) : 0
  if (gapPx > 0) {
    base.marginTop = `${gapPx}px`
  }
  if (!para.blockBackground) {
    return Object.keys(base).length ? base : undefined
  }
  const pad = para.blockPadding ?? 2
  return {
    ...base,
    backgroundColor: para.blockBackground,
    // The fill stays INSIDE the topic box: padding is the block's breathing
    // room, and no negative margins (which would bleed the fill past the
    // node edge — r-node draws the highlight inside the box).
    padding: `${pad}px ${pad + 2}px`,
    borderRadius: '3px',
    boxDecorationBreak: 'clone',
  }
}
</script>

<template>
  <img
    v-if="imageBox"
    class="mindmap-node-image"
    :class="{ selected: props.imageSelected }"
    :src="props.measuring ? undefined : resolvedImage"
    :style="imageBox"
    alt=""
    draggable="false"
    @click.stop="emit('imageClick')"
    @dblclick.stop
  >
  <template v-if="!props.hideTitle">
    <span v-if="!paragraphs" class="mindmap-node-title">{{ props.node.title }}</span>
    <span v-else class="mindmap-node-title"><span
      v-for="(para, index) in paragraphs"
      :key="index"
      class="mindmap-para"
      :class="{ gap: para.paraGap && index > 0, bullet: para.listIndent > 0 }"
      :style="paraStyle(para)"
    ><span
      v-for="(run, runIndex) in para.runs"
      :key="runIndex"
      :style="runStyle(run)"
    >{{ run.text }}</span></span></span>
  </template>
</template>

<style scoped>
/* Box-affecting, and deliberately here rather than in global.css's shared
   `.mindmap-node` block. The "one stylesheet, one box" rule (S2 M1.2) exists
   so the measured box and the painted box cannot get different answers — and
   a SCOPED rule on this component is the strongest possible form of that,
   because the live topic and the measure layer are the same component and so
   carry the same scope attribute. There is no second answer to give.

   These rules apply only to the rich path: a title with no runs still renders
   the bare `.mindmap-node-title` span above and is styled entirely by
   global.css, exactly as before. */

.mindmap-para {
  display: block;
  /* The runs carry soft line breaks as `\n` in their own text (§A.1), which
     only becomes a line break under pre-wrap. `.mindmap-node` is
     `white-space: normal`, so without this a multi-line title would silently
     collapse to one line — in the topic AND in the measure layer, which is
     why it is safe but also why it has to be stated. */
  white-space: pre-wrap;
  /* r-node's line box is 1.25 × font-size; matching it keeps a pasted
     paragraph the same height here as in r-node. */
  line-height: 1.25;
}

/* The block gap between paragraphs is set INLINE (paraGapPx, proportional),
   so this class only marks the boundary for the bullet re-indent below. */

/* A hanging indent: the bullet sits in the padding the paragraph reserves, so
   a wrapped bullet line aligns under its own text and not under the marker.
   `padding-left` and the negative `text-indent` are both set inline from the
   depth (listIndentPx) so wrapped lines align under the text. */
.mindmap-para.bullet::before {
  content: '• ';
}

/* The image's own selection outline — distinct from the topic's (dashed vs
   solid) so it reads as "the picture, not the box". The box-affecting
   .mindmap-node-image base (width/height/radius) stays in global.css; this
   selection ring is chrome on top, exactly like the node outline in
   MindmapNode.vue. */
.mindmap-node-image.selected {
  outline: 2px dashed #ff7f50;
  outline-offset: 1px;
  cursor: default;
}
</style>
