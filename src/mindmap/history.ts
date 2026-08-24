/**
 * History — undo/redo stack, ported from r-node's src/core/history.ts.
 *
 * Each entry is a BATCH of ops (a single user gesture may produce several
 * ops, e.g. deleting multiple selected topics). The entry stores the forward
 * ops and their inverses in undo order, so undo/redo are pure replays — the
 * stack never applies anything itself, the store does.
 */
import type { Op } from './ops'

interface HistoryEntry {
  ops: Op[]
  /** Inverses in the order they must be applied to undo the batch. */
  inverse: Op[]
}

export class History {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  // A hard cap keeps memory bounded on a long editing session; a 3,000-topic
  // map at 400 snapshots is already far past anything undo can usefully reach.
  private readonly max = 400

  /**
   * Record an applied batch.
   * @param ops forward ops, already applied to the sheet
   * @param inverses per-op inverse lists, in forward order
   */
  push(ops: Op[], inverses: Op[][]): void {
    const entry: HistoryEntry = {
      ops,
      // Undo applies each batch's inverses in reverse order, so the flattened
      // list is stored pre-reversed and undo/redo are plain array replays.
      inverse: [...inverses].reverse().flat(),
    }
    this.undoStack.push(entry)
    if (this.undoStack.length > this.max) {
      this.undoStack.shift()
    }
    this.redoStack.length = 0
  }

  /** Ops to apply for undo (already in the right order), or null when empty. */
  undo(): Op[] | null {
    const entry = this.undoStack.pop()
    if (!entry) {
      return null
    }
    this.redoStack.push(entry)
    return entry.inverse
  }

  /** Ops to apply for redo (already in the right order), or null when empty. */
  redo(): Op[] | null {
    const entry = this.redoStack.pop()
    if (!entry) {
      return null
    }
    this.undoStack.push(entry)
    return entry.ops
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}
