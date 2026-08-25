import type { CSSProperties } from 'vue'
import { DEFAULT_STYLE, type MindNode } from './types'

/** Display width used when a topic carries an image but no explicit width. */
export const DEFAULT_IMAGE_WIDTH = 120

/** Assumed height/width for an image whose aspect was never recorded. */
export const DEFAULT_IMAGE_ASPECT = 0.75

/**
 * Box-affecting Style → inline CSS, SHARED between the rendered topic
 * (MindmapNode.vue) and the hidden measure layer (MindmapCanvas.vue).
 *
 * MINDMAP_S2_AGENT_BRIEF M2 + trap 4: everything that changes a topic's
 * measured size must be applied in ONE place so the browser measures the same
 * box layout used to place it. The measure layer must not be a simplified
 * cousin of the rendered topic — if it is, layout derives sizes from the wrong
 * box and the box-affecting mismatch reappears.
 *
 * Only fields present on `node.style` are returned, plus what a Shape
 * inherently demands (a capsule is round, `rect`/`underline`/`none` drop the
 * radius or the box). Absent fields fall through to the shared `.mindmap-node`
 * base class in src/global.css, which is the single source of the defaults
 * (padding 6, font 14/400, border 1px). Both callers apply this to their box,
 * so DEFAULTs match DEFAULTs.
 */

/** The box-affecting overrides for a node, applied to its topic box. */
export function topicBoxStyle(node: MindNode): CSSProperties {
  const s = node.style
  const shape = s.shape ?? 'rounded'

  const style: CSSProperties = {}

  if (s.fontSize !== undefined) {
    style.fontSize = `${s.fontSize}px`
  }
  if (s.fontWeight !== undefined) {
    style.fontWeight = s.fontWeight
  }
  if (s.italic !== undefined) {
    style.fontStyle = s.italic ? 'italic' : 'normal'
  }
  if (s.fontFamily !== undefined) {
    style.fontFamily = s.fontFamily
  }
  if (s.padding !== undefined) {
    style.padding = `${s.padding}px`
  }
  if (s.borderWidth !== undefined) {
    style.borderWidth = `${s.borderWidth}px`
  }
  if (s.borderStyle !== undefined) {
    style.borderStyle = s.borderStyle
  }
  if (s.stroke !== undefined) {
    style.borderColor = s.stroke
  }

  if (shape === 'rect') {
    style.borderRadius = '0'
  }
  else if (shape === 'capsule') {
    // A pill: a round radius sufficiently large that a short edge corners fully.
    style.borderRadius = '999px'
  }
  else if (shape === 'underline' || shape === 'none') {
    // These shapes are text-only: no box border, no background. Padding stays
    // the default so the box still has both dimensions for measurement.
    style.border = 'none'
  }
  else if (s.cornerRadius !== undefined) {
    style.borderRadius = `${s.cornerRadius}px`
  }
  else {
    style.borderRadius = `${DEFAULT_STYLE.cornerRadius}px`
  }

  return style
}

/** Non-box visuals (fill, colour, opacity, shadow, text decoration). */
export function topicVisualStyle(node: MindNode): CSSProperties {
  const s = node.style
  const style: CSSProperties = {}

  // A topic with no fill keeps the chart's/theme's look (the shared class's
  // translucent box); only an explicit fill overrides it.
  if (s.fill !== undefined) {
    style.background = s.fill
  }
  // textColor is inherited from the chart (the box sets color: inherit); only
  // an explicit colour overrides it.
  if (s.textColor !== undefined) {
    style.color = s.textColor
  }
  if (s.opacity !== undefined) {
    style.opacity = s.opacity
  }
  if (s.shadow) {
    style.boxShadow = '0 3px 8px rgba(0, 0, 0, 0.45)'
  }
  if (s.underline || s.strikethrough || s.shape === 'underline') {
    const parts: string[] = []
    if (s.underline || s.shape === 'underline') {
      parts.push('underline')
    }
    if (s.strikethrough) {
      parts.push('line-through')
    }
    style.textDecoration = parts.join(' ')
  }

  return style
}

/**
 * The TOP image slot's box, derived from `imageWidth` × `imageAspect` alone —
 * the S3 C.2b async-input rule. An `<img>` measured before it loads is
 * zero-height, and a topic sized by whatever happens to have loaded is the
 * pan-shift bug arriving once more: so the box comes purely from stored Style
 * numbers and is correct on the FIRST frame, identical before and after the
 * bytes arrive. Both the rendered topic and the hidden measure layer call
 * this, so what layout reads is exactly what paints.
 *
 * Returns null for a topic with no image; the caller renders no slot.
 */
export function topicImageBoxStyle(node: MindNode): CSSProperties | null {
  const s = node.style
  if (!s.image) {
    return null
  }
  const width = Math.max(1, Math.round(s.imageWidth ?? DEFAULT_IMAGE_WIDTH))
  const height = Math.max(1, Math.round(width * (s.imageAspect ?? DEFAULT_IMAGE_ASPECT)))
  return {
    display: 'block',
    width: `${width}px`,
    height: `${height}px`,
    objectFit: 'cover',
  }
}
