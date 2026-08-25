<script setup lang="ts">
import type { MindNode } from '../../../mindmap/types'
import { computed } from 'vue'
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'
import { topicImageBoxStyle } from '../../../mindmap/nodeStyle'
import { runParagraphs, runStyle } from '../../../mindmap/richtext'

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
}>()

const imageBox = computed(() => topicImageBoxStyle(props.node))
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
</script>

<template>
  <img
    v-if="imageBox"
    class="mindmap-node-image"
    :src="props.measuring ? undefined : resolvedImage"
    :style="imageBox"
    alt=""
    draggable="false"
  >
  <template v-if="!props.hideTitle">
    <span v-if="!paragraphs" class="mindmap-node-title">{{ props.node.title }}</span>
    <span v-else class="mindmap-node-title"><span
      v-for="(para, index) in paragraphs"
      :key="index"
      class="mindmap-para"
      :class="{ gap: para.paraGap && index > 0, bullet: para.listIndent > 0 }"
      :style="para.listIndent > 0 ? { paddingLeft: `${para.listIndent * 11}px` } : undefined"
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
}

.mindmap-para.gap {
  margin-top: 0.45em;
}

/* A hanging indent: the bullet sits in the padding the paragraph reserves, so
   a wrapped bullet line aligns under its own text and not under the marker.
   `padding-left` is set inline from the depth; this only pulls the marker
   back out of it. */
.mindmap-para.bullet {
  text-indent: -11px;
}

.mindmap-para.bullet::before {
  content: '• ';
}
</style>
