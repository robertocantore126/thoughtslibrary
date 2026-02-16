const MAX_IMAGE_DIMENSION = 1200
const WEBP_QUALITY = 0.88

function readBlobAsDataUrl(file: Blob): Promise<string> {
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

export async function fileToDataUrl(file: Blob): Promise<string> {
  if (typeof document === 'undefined') {
    return readBlobAsDataUrl(file)
  }

  const type = (file as File).type || ''
  if (!type.startsWith('image/')) {
    return readBlobAsDataUrl(file)
  }

  try {
    const img = await loadImageFromBlob(file)
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(img.width, img.height))
    const width = Math.max(1, Math.round(img.width * scale))
    const height = Math.max(1, Math.round(img.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return readBlobAsDataUrl(file)
    }

    ctx.drawImage(img, 0, 0, width, height)

    return canvas.toDataURL('image/webp', WEBP_QUALITY)
  }
  catch {
    return readBlobAsDataUrl(file)
  }
}
