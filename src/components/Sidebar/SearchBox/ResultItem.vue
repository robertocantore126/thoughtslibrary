<script setup lang="ts">
import { useResolvedImageUrl } from '../../../composables/useResolvedImageUrl'

interface Props {
  imageData: {
    src: string
    alt: string
  }
}

const props = defineProps<Props>()
const resolvedImageUrl = useResolvedImageUrl(() => props.imageData.src)
</script>

<template>
  <img
    :src="resolvedImageUrl"
    :alt="props.imageData.alt"
  >
</template>
