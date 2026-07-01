import { ref, toValue, watch } from 'vue'
import { resolveStoredImageUrl } from '../helpers/assets'

export function useResolvedImageUrl(source: (() => string | null | undefined) | string | null | undefined) {
  const resolved = ref('')

  watch(
    () => toValue(source),
    async (nextSource) => {
      if (!nextSource) {
        resolved.value = ''
        return
      }

      try {
        resolved.value = await resolveStoredImageUrl(nextSource)
      }
      catch (error) {
        console.error(error)
        resolved.value = nextSource
      }
    },
    { immediate: true },
  )

  return resolved
}
