const MAX_IMAGE_DIMENSION = 512
const MIN_IMAGE_DIMENSION = 160
const INITIAL_WEBP_QUALITY = 0.78
const MIN_WEBP_QUALITY = 0.42
const MAX_OUTPUT_BYTES = 180 * 1024

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

export async function optimizeImageBlob(file: Blob): Promise<Blob> {
  if (typeof document === 'undefined') {
    return file
  }

  const type = (file as File).type || ''
  if (!type.startsWith('image/')) {
    return file
  }

  try {
    const img = await loadImageFromBlob(file)
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return file
    }

    let longestSide = Math.min(MAX_IMAGE_DIMENSION, Math.max(img.width, img.height))
    let quality = INITIAL_WEBP_QUALITY

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

export async function fileToDataUrl(file: Blob): Promise<string> {
  const optimized = await optimizeImageBlob(file)
  return readBlobAsDataUrl(optimized)
}
