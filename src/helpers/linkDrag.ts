/**
 * Shift-drag from one tile to another to draw an arrow between them.
 *
 * The source id travels under its own MIME type rather than inside the ordinary
 * `application/json` payload. That is deliberate: `getData()` is unreadable
 * during `dragover` — the drag data store stays in protected mode until the
 * drop — but `types` is readable throughout, so a drop target can tell a link
 * drag from a move drag while the pointer is still travelling, and answer with
 * the right effect. Reporting an effect the source did not allow makes the
 * browser refuse the drop outright, so this distinction has to be available
 * early.
 */
export const LINK_DRAG_TYPE = 'application/x-tile-link'

export function isLinkDrag(dataTransfer: DataTransfer | null): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types).includes(LINK_DRAG_TYPE)
}

// `dragstart` fires whether or not a modifier is held, so the gesture is
// decided here and the payload written to match.
export function startLinkDrag(ev: DragEvent, sourceId: string): void {
  if (!ev.dataTransfer) {
    return
  }

  ev.dataTransfer.effectAllowed = 'link'
  ev.dataTransfer.setData(LINK_DRAG_TYPE, sourceId)
}

export function readLinkSourceId(ev: DragEvent): string | null {
  return ev.dataTransfer?.getData(LINK_DRAG_TYPE) || null
}
