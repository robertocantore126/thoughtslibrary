<script setup lang="ts">
import type { Ref } from 'vue'
import { ref } from 'vue'
import { storeLocalImage } from '../../../helpers/assets'

const emit = defineEmits([
  'updateResults',
])

const urlInput: Ref<HTMLInputElement> = ref(null)
const titleInput: Ref<HTMLInputElement> = ref(null)
const creatorInput: Ref<HTMLInputElement> = ref(null)
const localFileInput: Ref<HTMLInputElement> = ref(null)
const localFileName = ref('')
const SUPPORTED_IMAGE_EXTENSIONS = /\.(jpg|jpeg|png|webp)(\?.*)?(#.*)?$/i

function buildTitleFromFilename(name: string): string {
  const noExt = name.replace(/\.[^.]+$/, '')
  return noExt || 'Local image'
}

function emitCustomItem(imageURL: string, suggestedTitle?: string) {
  const title = titleInput.value.value || suggestedTitle || ''
  const item = {
    title,
    creator: creatorInput.value.value,
    imageURL,
    type: 'custom',
  }

  emit('updateResults', [item])
}

function isSupportedImageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol)) {
      return false
    }

    return SUPPORTED_IMAGE_EXTENSIONS.test(url.pathname + url.search + url.hash)
  }
  catch {
    return false
  }
}

function buildResultItem() {
  if (urlInput.value.value) {
    emitCustomItem(urlInput.value.value)
  }
}

function buildThoughtItem() {
  const typedTitle = titleInput.value.value?.trim() || 'Thought'
  const typedAttachment = urlInput.value.value?.trim()
  const thought = {
    title: typedTitle,
    imageURL: '/thought_tile.svg',
    attachmentURL: isSupportedImageUrl(typedAttachment) ? typedAttachment : undefined,
    type: 'thought',
  }

  emit('updateResults', [thought])
}

async function processLocalFile(file: File) {
  if (!file.type.startsWith('image/')) {
    return
  }

  localFileName.value = file.name

  try {
    const storedUrl = await storeLocalImage(file)
    emitCustomItem(storedUrl, buildTitleFromFilename(file.name))
  }
  catch (e) {
    console.error(e)
  }
}

function onLocalFilePicked(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (file) {
    void processLocalFile(file)
  }
}

function onDropLocalFile(event: DragEvent) {
  event.preventDefault()
  const file = event.dataTransfer?.files?.[0]
  if (file) {
    void processLocalFile(file)
  }
}

function onDragOver(event: DragEvent) {
  event.preventDefault()
}

function openLocalPicker() {
  localFileInput.value?.click()
}

async function processClipboardData(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) {
    return
  }

  const imageFile = Array.from(dataTransfer.files).find(file => file.type.startsWith('image/'))
  if (imageFile) {
    await processLocalFile(imageFile)
    return
  }

  const pastedText = dataTransfer.getData('text/plain')?.trim()
  if (pastedText && isSupportedImageUrl(pastedText)) {
    emitCustomItem(pastedText, buildTitleFromFilename(new URL(pastedText).pathname))
  }
}

function onPaste(event: ClipboardEvent) {
  processClipboardData(event.clipboardData)
}

async function pasteFromClipboard() {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    return
  }

  try {
    if (navigator.clipboard.read) {
      const items = await navigator.clipboard.read()
      for (const item of items) {
        const imageType = item.types.find(type => type.startsWith('image/'))
        if (imageType) {
          const blob = await item.getType(imageType)
          const file = new File([blob], `pasted.${imageType.split('/')[1] || 'png'}`, { type: imageType })
          await processLocalFile(file)
          return
        }
      }
    }
  }
  catch {
    // ignore and try text fallback
  }

  try {
    const text = (await navigator.clipboard.readText()).trim()
    if (text && isSupportedImageUrl(text)) {
      emitCustomItem(text, buildTitleFromFilename(new URL(text).pathname))
    }
  }
  catch {
    // ignore clipboard permission failures
  }
}
</script>

<template>
  <div id="custom-form">
    <div
      class="local-drop-zone"
      tabindex="0"
      @click="openLocalPicker"
      @dragover="onDragOver"
      @drop="onDropLocalFile"
      @paste="onPaste"
    >
      <input
        ref="localFileInput"
        type="file"
        accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
        class="hidden-file-input"
        @change="onLocalFilePicked"
      >
      <p class="drop-title">Drop local image here</p>
      <p class="drop-subtitle">or click to choose JPG, PNG, WEBP</p>
      <p class="drop-subtitle">Paste with Ctrl+V/Cmd+V</p>
      <p v-if="localFileName" class="file-name">{{ localFileName }}</p>
    </div>
    <button @click="pasteFromClipboard">
      Paste image / URL
    </button>
    <div class="custom-form-item">
      <label for="custom-image-url">
        Image Link
      </label>
      <input
        id="custom-image-url"
        ref="urlInput"
        required
        type="text"
      >
    </div>
    <div class="custom-form-item">
      <label for="custom-image-title">
        Title
      </label>
      <input
        id="custom-image-title"
        ref="titleInput"
        type="text"
      >
    </div>
    <div class="custom-form-item">
      <label for="custom-image-creator">
        Creator (Optional)
      </label>
      <input
        id="custom-image-creator"
        ref="creatorInput"
        type="text"
      >
    </div>
    <button
      @click="buildResultItem"
    >
      Generate chart item
    </button>
    <button
      @click="buildThoughtItem"
    >
      Add thought item
    </button>
  </div>
</template>

<style scoped>
#custom-form {
  display: flex;
  flex-flow: column;
  gap: 10px;
}

#custom-form button {
  margin: auto;
  font-size: 1rem;
}

.custom-form-item label {
  display: block;
  font-size: 0.8rem;
}

.custom-form-item input {
  width: 100%;
}

.local-drop-zone {
  border: 1px dashed #666666;
  border-radius: 8px;
  padding: 12px;
  text-align: center;
  background: #1a1a1a;
}

.local-drop-zone:hover {
  cursor: pointer;
  border-color: var(--accent);
}

.drop-title {
  margin: 0;
  font-size: 0.9rem;
}

.drop-subtitle {
  margin: 4px 0 0;
  font-size: 0.75rem;
  opacity: 0.8;
}

.file-name {
  margin: 8px 0 0;
  font-size: 0.75rem;
  color: var(--accent);
}

.hidden-file-input {
  display: none;
}
</style>
