/**
 * The mindmap keyboard layer: a KeyboardEvent in, a command name out.
 *
 * Pure by construction — no store, no DOM beyond the event it is handed — so
 * the entire keyboard surface is testable without mounting a canvas. That is
 * the only reason a table this size is worth having: the dispatcher in
 * MindmapInteraction.vue stays a switch over names, and every binding is
 * covered by tests/mindmap-keymap.test.ts (MINDMAP_S4_AGENT_BRIEF §C.1).
 *
 * Before S4 the only global key in the whole map was Escape.
 */

export type Command =
  | 'sibling'
  | 'child'
  | 'delete'
  | 'edit'
  | 'toggle'
  | 'navUp'
  | 'navDown'
  | 'navLeft'
  | 'navRight'
  | 'undo'
  | 'redo'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'copyOutline'
  | 'duplicate'
  | 'expandAll'
  | 'fit'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'typeToEdit'

/**
 * Whether this key belongs to a text editor rather than to the map. The inline
 * rename editor is a contenteditable div and the inspector is full of inputs;
 * without this check, Enter to finish a rename ALSO creates a sibling and every
 * letter typed into the editor ALSO fires type-to-edit. Same shape as the
 * overlay's existing Escape guard (MindmapOverlay.vue).
 *
 * Duck-typed rather than `instanceof HTMLElement`: the suite runs in vitest's
 * node environment (vite.config.ts), where that global does not exist, and a
 * check that throws in tests is a check nobody keeps.
 */
function isEditingTarget(target: EventTarget | null): boolean {
  const el = target as { isContentEditable?: boolean, tagName?: unknown } | null
  if (!el) {
    return false
  }
  if (el.isContentEditable) {
    return true
  }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Type-to-edit: a bare printable character replaces the selected topic's title
 * and opens its editor seeded with that character. `key.length === 1` is the
 * standard test — every named key ('Enter', 'F2', 'ArrowUp', 'Dead') is longer.
 * Space is excluded because it is bound to `toggle`.
 */
function printable(event: KeyboardEvent): Command | null {
  return event.key.length === 1 && event.key !== ' ' ? 'typeToEdit' : null
}

/**
 * Map a keydown to a mindmap command, or null when the map should ignore it.
 *
 * The caller is expected to `preventDefault` whatever it actually handles;
 * `Tab` is the one exception and is handled here, because its default (moving
 * focus out of the overlay and into the chart behind it) has already happened
 * by the time a dispatcher could react to the returned name.
 */
export function resolveCommand(event: KeyboardEvent): Command | null {
  if (isEditingTarget(event.target)) {
    return null
  }

  const mod = event.ctrlKey || event.metaKey

  if (mod) {
    // Ctrl+Alt is AltGr on a Windows/European layout and produces a printable
    // character, not a shortcut — '@', '#', '[' and friends must still be able
    // to start a title rather than silently matching nothing.
    if (event.altKey) {
      return printable(event)
    }
    switch (event.key.toLowerCase()) {
      case 'z':
        return event.shiftKey ? 'redo' : 'undo'
      case 'y':
        return 'redo'
      case 'c':
        return event.shiftKey ? 'copyOutline' : 'copy'
      case 'x':
        return 'cut'
      case 'v':
        return 'paste'
      case 'd':
        return 'duplicate'
      case '=':
      case '+':
        return 'zoomIn'
      case '-':
      case '_':
        return 'zoomOut'
      case '0':
        return 'zoomReset'
      case '1':
        return 'fit'
      default:
        return null
    }
  }

  // A bare Alt combination is a menu accelerator on Windows, never a map
  // command; letting it fall through to `printable` would seed an edit.
  if (event.altKey) {
    return null
  }

  switch (event.key) {
    case 'Enter':
      return 'sibling'
    case 'Tab':
      // Shift+Tab deliberately resolves to `child` as well, exactly as plain
      // Tab does. r-node's combo builder excludes Tab from the Shift modifier,
      // so its documented "promote" never fires (audit K03) — reproducing that
      // defect faithfully means NOT inventing a promote command here.
      event.preventDefault()
      return 'child'
    case 'F2':
      return 'edit'
    case ' ':
      return 'toggle'
    case 'Delete':
    case 'Backspace':
      return 'delete'
    case 'ArrowUp':
      return 'navUp'
    case 'ArrowDown':
      return 'navDown'
    case 'ArrowLeft':
      return 'navLeft'
    case 'ArrowRight':
      return 'navRight'
  }

  return printable(event)
}
