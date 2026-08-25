import { describe, expect, it, vi } from 'vitest'
import { type Command, resolveCommand } from '../src/mindmap/keymap'

/**
 * The suite runs in vitest's node environment (vite.config.ts), which has no
 * KeyboardEvent and no DOM, so events are built as plain objects carrying the
 * five fields resolveCommand reads. That is safe here precisely because the
 * function is pure over those fields — the moment it reached for anything else
 * (document.activeElement, a real element method) this double would start
 * agreeing with a bug instead of testing behavior.
 */
function press(key: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    target: null,
    preventDefault: vi.fn(),
    ...init,
  } as unknown as KeyboardEvent
}

describe('resolveCommand — structural keys', () => {
  it('binds the tree-building keys', () => {
    expect(resolveCommand(press('Enter'))).toBe('sibling')
    expect(resolveCommand(press('Tab'))).toBe('child')
    expect(resolveCommand(press('F2'))).toBe('edit')
    expect(resolveCommand(press(' '))).toBe('toggle')
    expect(resolveCommand(press('Delete'))).toBe('delete')
    expect(resolveCommand(press('Backspace'))).toBe('delete')
  })

  it('binds the four arrows to geometric navigation', () => {
    expect(resolveCommand(press('ArrowUp'))).toBe('navUp')
    expect(resolveCommand(press('ArrowDown'))).toBe('navDown')
    expect(resolveCommand(press('ArrowLeft'))).toBe('navLeft')
    expect(resolveCommand(press('ArrowRight'))).toBe('navRight')
  })

  it('preventDefaults Tab, or focus walks out of the overlay', () => {
    const event = press('Tab')
    expect(resolveCommand(event)).toBe('child')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  // r-node excludes Tab from the Shift modifier, so its documented "promote"
  // never fires (audit K03). Shift+Tab therefore behaves as plain Tab does,
  // and no `promote` command exists to bind it to.
  it('treats Shift+Tab as plain Tab rather than inventing a promote', () => {
    const event = press('Tab', { shiftKey: true })
    expect(resolveCommand(event)).toBe('child')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to the overlay', () => {
    expect(resolveCommand(press('Escape'))).toBeNull()
  })
})

describe('resolveCommand — modifier combinations', () => {
  const cases: [string, Partial<KeyboardEvent>, Command][] = [
    ['z', { ctrlKey: true }, 'undo'],
    ['z', { metaKey: true }, 'undo'],
    ['z', { ctrlKey: true, shiftKey: true }, 'redo'],
    ['y', { ctrlKey: true }, 'redo'],
    ['c', { ctrlKey: true }, 'copy'],
    ['c', { ctrlKey: true, shiftKey: true }, 'copyOutline'],
    ['x', { ctrlKey: true }, 'cut'],
    ['v', { ctrlKey: true }, 'paste'],
    ['d', { ctrlKey: true }, 'duplicate'],
    ['=', { ctrlKey: true }, 'zoomIn'],
    ['+', { ctrlKey: true }, 'zoomIn'],
    ['-', { ctrlKey: true }, 'zoomOut'],
    ['0', { ctrlKey: true }, 'zoomReset'],
    ['1', { ctrlKey: true }, 'fit'],
  ]

  it.each(cases)('maps %s with %o to %s', (key, init, expected) => {
    expect(resolveCommand(press(key, init))).toBe(expected)
  })

  // Chrome reports the shifted letter in uppercase; matching on the raw key
  // would leave Ctrl+Shift+C unbound on exactly the platform it ships to.
  it('matches the shifted letter case-insensitively', () => {
    expect(resolveCommand(press('C', { ctrlKey: true, shiftKey: true }))).toBe('copyOutline')
    expect(resolveCommand(press('Z', { ctrlKey: true, shiftKey: true }))).toBe('redo')
  })

  it('ignores a modified key it does not bind', () => {
    expect(resolveCommand(press('a', { ctrlKey: true }))).toBeNull()
    expect(resolveCommand(press('s', { ctrlKey: true }))).toBeNull()
  })

  // Autosave is the only save path (§T.6). A Ctrl+S binding would imply the
  // map has a manual save, which it does not.
  it('does not bind Mod+S', () => {
    expect(resolveCommand(press('s', { ctrlKey: true }))).toBeNull()
  })

  it('ignores bare Alt accelerators', () => {
    expect(resolveCommand(press('f', { altKey: true }))).toBeNull()
  })
})

describe('resolveCommand — type to edit', () => {
  it('treats a bare printable character as the start of a title', () => {
    expect(resolveCommand(press('a'))).toBe('typeToEdit')
    expect(resolveCommand(press('Z'))).toBe('typeToEdit')
    expect(resolveCommand(press('7'))).toBe('typeToEdit')
    expect(resolveCommand(press('é'))).toBe('typeToEdit')
  })

  it('does not treat a named key as printable', () => {
    expect(resolveCommand(press('Shift'))).toBeNull()
    expect(resolveCommand(press('Dead'))).toBeNull()
    expect(resolveCommand(press('F5'))).toBeNull()
  })

  // AltGr arrives as Ctrl+Alt on Windows and produces a real character, so a
  // European keyboard must still be able to start a title with '@' or '['.
  it('lets an AltGr character seed an edit', () => {
    expect(resolveCommand(press('@', { ctrlKey: true, altKey: true }))).toBe('typeToEdit')
  })
})

describe('resolveCommand — the editing bail', () => {
  const editable = { isContentEditable: true } as unknown as EventTarget
  const input = { tagName: 'INPUT' } as unknown as EventTarget
  const textarea = { tagName: 'textarea' } as unknown as EventTarget
  const select = { tagName: 'SELECT' } as unknown as EventTarget

  it.each([
    ['contenteditable', editable],
    ['input', input],
    ['textarea', textarea],
    ['select', select],
  ])('returns null for every key while focus is in a %s', (_label, target) => {
    for (const event of [
      press('Enter', { target }),
      press('Tab', { target }),
      press('a', { target }),
      press('Delete', { target }),
      press('z', { target, ctrlKey: true }),
      press('ArrowLeft', { target }),
    ]) {
      expect(resolveCommand(event)).toBeNull()
    }
  })

  // Enter inside a rename must finish the rename and nothing else; a sibling
  // appearing on every commit is the bug this guard exists for.
  it('does not preventDefault Tab inside an editor', () => {
    const event = press('Tab', { target: editable })
    expect(resolveCommand(event)).toBeNull()
    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('still resolves for a plain element target', () => {
    const div = { tagName: 'DIV', isContentEditable: false } as unknown as EventTarget
    expect(resolveCommand(press('Enter', { target: div }))).toBe('sibling')
  })
})
