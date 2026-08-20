import { ref, toValue, watch } from 'vue'
import { resolveStoredImageUrl } from '../helpers/assets'

export function useResolvedImageUrl(source: (() => string | null | undefined) | string | null | undefined) {
  const resolved = ref('')

  // A request token so an out-of-order IndexedDB read can't paint a stale
  // image: the first resolution for an older source must not overwrite the
  // newest one (a cached second read beats an uncached first).
  let requestId = 0

  watch(
    () => toValue(source),
    async (nextSource) => {
      const token = ++requestId

      if (!nextSource) {
        resolved.value = ''
        return
      }

      try {
        const next = await resolveStoredImageUrl(nextSource)
        if (token === requestId) {
          resolved.value = next
        }
      }
      catch (error) {
        console.error(error)
        if (token === requestId) {
          resolved.value = nextSource
        }
      }
    },
    { immediate: true },
  )

  return resolved
}
