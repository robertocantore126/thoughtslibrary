<script setup lang="ts">
import type { MindNode } from '../../../mindmap/types'
import { computed } from 'vue'
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'
import { topicImageBoxStyle } from '../../../mindmap/nodeStyle'

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
  <span v-if="!props.hideTitle" class="mindmap-node-title">{{ props.node.title }}</span>
</template>
