import { storeLocalImage } from './assets'

/**
 * Working out what image a drop is carrying, shared by the grid tiles
 * (`Item.vue`) and the related-layer tiles (`LayerTile.vue`). Both used to hold
 * their own byte-identical copy of all of this, so every fix had to be made
 * twice and the two drifted apart in exactly the way you would expect.
 */

// Formats the browser can decode and paint in an <img>. HEIC and TIFF are
// deliberately absent: Chromium cannot render either, so accepting one would
// store a blob that shows up as a permanently blank tile.
const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
])

// Kept in step with the MIME list above. `jfif` and `pjpeg` are the names
// Windows still hands out for perfectly ordinary JPEGs.
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'jfif',
  'pjpeg',
  'png',
  'webp',
  'gif',
  'avif',
  'bmp',
])

export interface DroppedImage {
  coverURL: string
  title: string
}

function getFileExtension(name: string): string {
  const parts = name.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function isSupportedImageFile(file: File): boolean {
  return SUPPORTED_IMAGE_MIME_TYPES.has(file.type)
    || SUPPORTED_IMAGE_EXTENSIONS.has(getFileExtension(file.name))
}

export function extractTitleFromPath(pathOrName: string): string {
  const lastSegment = pathOrName.split('/').pop() || ''
  const decoded = decodeURIComponent(lastSegment)
  const withoutExt = decoded.replace(/\.[^.]+$/, '')
  return withoutExt || 'Dropped image'
}

// A bare URL, with nothing but the string to go on. Requiring a known extension
// is what stops dragging an ordinary link onto a tile from producing a tile
// that can never load. Query and fragment are allowed to follow the extension,
// as in `/cover.jpg?width=800`.
const URL_IMAGE_EXTENSION = /\.(?:jpg|jpeg|jfif|pjpeg|png|webp|gif|avif|bmp)(?:[?#].*)?$/i

function isSupportedImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false
    }

    return URL_IMAGE_EXTENSION.test(url.pathname + url.search + url.hash)
  }
  catch {
    return false
  }
}

// A URL lifted out of an <img> tag needs no extension check: the source page
// was already displaying it as an image, which is far better evidence than a
// file extension. Most images on the web no longer carry one — a Twitter cover
// is `/media/Abc123?format=jpg&name=large`, an Unsplash one is
// `/photo-1234567890` — and demanding it rejected all of them.
function isRenderableImageSrc(rawUrl: string): boolean {
  if (rawUrl.startsWith('data:image/')) {
    return true
  }

  try {
    return ['http:', 'https:'].includes(new URL(rawUrl).protocol)
  }
  catch {
    return false
  }
}

function getDroppedImageUrlFromDataTransfer(dataTransfer: DataTransfer): string | null {
  // The HTML flavour comes first now. It is the only one that proves the thing
  // dragged was an image, so it should not lose to a stricter check on a
  // weaker signal.
  const html = dataTransfer.getData('text/html')
  if (html) {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const src = doc.querySelector('img')?.getAttribute('src')
    if (src && isRenderableImageSrc(src)) {
      return src
    }
  }

  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    const candidate = uriList
      .split('\n')
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#') && isSupportedImageUrl(line))

    if (candidate) {
      return candidate
    }
  }

  const plainText = dataTransfer.getData('text/plain')
  if (plainText && isSupportedImageUrl(plainText.trim())) {
    return plainText.trim()
  }

  return null
}

function titleForUrl(rawUrl: string): string {
  if (rawUrl.startsWith('data:')) {
    return 'Dropped image'
  }

  try {
    return extractTitleFromPath(new URL(rawUrl).pathname)
  }
  catch {
    return 'Dropped image'
  }
}

/**
 * The cover and title a drop is offering, or null if it carries no image this
 * app can show. A dropped file is copied into the asset store first, so the
 * caller always receives a URL it can persist.
 *
 * `dataTransfer` must be read synchronously: it is emptied once the drop
 * handler yields, so every flavour is pulled out before the first await.
 */
export async function resolveDroppedImage(ev: DragEvent): Promise<DroppedImage | null> {
  const dataTransfer = ev.dataTransfer
  if (!dataTransfer) {
    return null
  }

  const file = Array.from(dataTransfer.files).find(isSupportedImageFile)
  const url = file ? null : getDroppedImageUrlFromDataTransfer(dataTransfer)

  if (file) {
    try {
      return {
        coverURL: await storeLocalImage(file),
        title: extractTitleFromPath(file.name),
      }
    }
    catch (error) {
      console.error('Could not store the dropped image:', error)
      return null
    }
  }

  if (url) {
    return { coverURL: url, title: titleForUrl(url) }
  }

  return null
}
