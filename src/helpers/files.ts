const MIN_IMAGE_DIMENSION = 160
const INITIAL_WEBP_QUALITY = 0.78
const MIN_WEBP_QUALITY = 0.42

export interface ImageBudget {
  /** Longest side the image is allowed to keep, in pixels. */
  maxDimension: number
  /** Size the re-encoding aims to come in under. */
  maxBytes: number
}

// Stored blobs live in IndexedDB, whose quota is measured in gigabytes. The
// original budget - 512px and 180KB - was sized for localStorage, which has not
// held image bytes since the asset store was introduced, and it was throwing
// away most of every picture the user imported for room that was never needed.
export const STORED_ASSET_BUDGET: ImageBudget = {
  maxDimension: 2048,
  maxBytes: 2 * 1024 * 1024,
}

// The fallback for a browser with no IndexedDB, where the image ends up as a
// data URL inside localStorage's ~5MB origin budget. Here the old numbers are
// exactly right, and generous ones would blow the quota on a handful of covers.
export const INLINE_ASSET_BUDGET: ImageBudget = {
  maxDimension: 512,
  maxBytes: 180 * 1024,
}

export function readBlobAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }

      reject(new Error('Failed to read file as data URL'))
    }

    reader.onerror = () => {
      reject(reader.error || new Error('Failed to read file as data URL'))
    }

    reader.readAsDataURL(file)
  })
}

function loadImageFromBlob(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file)
    const img = new Image()

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(img)
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to decode image'))
    }

    img.src = objectUrl
  })
}

function canvasToBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }

      reject(new Error('Failed to encode image'))
    }, 'image/webp', quality)
  })
}

export async function optimizeImageBlob(file: Blob, budget: ImageBudget = STORED_ASSET_BUDGET): Promise<Blob> {
  if (typeof document === 'undefined') {
    return file
  }

  const type = (file as File).type || ''
  if (!type.startsWith('image/')) {
    return file
  }

  // A canvas only ever holds one frame, so re-encoding an animated GIF would
  // silently throw the animation away and keep the first frame. Stored as-is
  // instead; IndexedDB has the room for it.
  if (type === 'image/gif') {
    return file
  }

  // An SVG is resolution-independent, and drawing one to a canvas replaces it
  // with a bitmap of whatever size happened to be picked - a permanent, and
  // pointless, downgrade of a cover that was already as small as it will get.
  if (type === 'image/svg+xml') {
    return file
  }

  const { maxDimension: MAX_IMAGE_DIMENSION, maxBytes: MAX_OUTPUT_BYTES } = budget

  try {
    const img = await loadImageFromBlob(file)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return file
    }

    let longestSide = Math.min(MAX_IMAGE_DIMENSION, Math.max(img.width, img.height))
    let quality = INITIAL_WEBP_QUALITY

    // An image already smaller than the loop's floor never entered it, and the
    // old fallback encoded the untouched default 300x150 canvas — a blank
    // cover, persisted permanently. Under the size budget the original pixels
    // are kept as-is; otherwise the image is re-encoded at its natural size.
    if (longestSide < MIN_IMAGE_DIMENSION) {
      if (file.size <= MAX_OUTPUT_BYTES) {
        return file
      }
      canvas.width = img.width
      canvas.height = img.height
      ctx.drawImage(img, 0, 0)
      return await canvasToBlob(canvas, INITIAL_WEBP_QUALITY)
    }

    while (longestSide >= MIN_IMAGE_DIMENSION) {
      const scale = Math.min(1, longestSide / Math.max(img.width, img.height))
      const width = Math.max(1, Math.round(img.width * scale))
      const height = Math.max(1, Math.round(img.height * scale))

      canvas.width = width
      canvas.height = height
      ctx.clearRect(0, 0, width, height)
      ctx.drawImage(img, 0, 0, width, height)

      let attemptQuality = quality
      while (attemptQuality >= MIN_WEBP_QUALITY) {
        const blob = await canvasToBlob(canvas, attemptQuality)
        if (blob.size <= MAX_OUTPUT_BYTES) {
          return blob
        }

        attemptQuality -= 0.08
      }

      longestSide = Math.floor(longestSide * 0.75)
      quality = Math.max(MIN_WEBP_QUALITY, quality - 0.08)
    }

    return await canvasToBlob(canvas, MIN_WEBP_QUALITY)
  }
  catch {
    return file
  }
}

// The result is a data URL, so it is bound by whatever holds it rather than by
// the asset store's room.
export async function fileToDataUrl(file: Blob): Promise<string> {
  const optimized = await optimizeImageBlob(file, INLINE_ASSET_BUDGET)
  return readBlobAsDataUrl(optimized)
}
