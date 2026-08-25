/**
 * Relationship and boundary commands (S4 §B.1).
 *
 * Deliberately thin: `ops.ts` already implements create/delete/set for both,
 * with their inverses, and `store.commit` already builds the copy-on-write
 * draft, records history, republishes and schedules the save. So a command
 * here is "build the op, commit it, return the id" and nothing else — which is
 * what makes Ctrl+Z undo a colour change exactly like it undoes a rename,
 * without this module knowing anything about history at all.
 */

import type { useMindmapStore } from './store'
import type { Group, Relationship } from './types'
import { makeOp } from './ops'

/**
 * The store as its callers see it. It is derived from the composable rather
 * than re-declared, so this module cannot drift from the frozen §0.3 contract
 * the store is cast to. `import type` keeps it a compile-time reference — a
 * value import here would pull the store into the geometry tests.
 */
export type MindmapStore = ReturnType<typeof useMindmapStore>

/**
 * Applies a patch, treating an explicitly-undefined value as "remove the
 * field" rather than as "store undefined".
 *
 * Same reasoning as the store's `clearNodeStyle`: `color: undefined` on a
 * relationship must genuinely fall back to the theme, and an explicit
 * undefined survives into the save file and answers `'color' in rel` with
 * true, so every "is it themed?" check downstream reads it as a set colour.
 */
function withPatch<T extends object>(base: T, patch: Partial<T>): T {
  const next = { ...base }
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key]
    if (value === undefined) {
      delete next[key]
    }
    else {
      next[key] = value
    }
  }
  return next
}

/**
 * Connects two topics and returns the new relationship's id, or '' when the
 * pair cannot be connected — the same "empty id means nothing happened"
 * convention `store.createChild` uses.
 *
 * A self-loop is refused because the geometry has no answer for it (both
 * border crossings are on the same box), and a duplicate returns the existing
 * id: two identical lines between the same pair are indistinguishable on the
 * map, so the second one reads as a click that did nothing.
 */
export function addRelationship(store: MindmapStore, fromId: string, toId: string): string {
  const sheet = store.sheet
  if (!sheet || fromId === toId || !sheet.nodes[fromId] || !sheet.nodes[toId]) {
    return ''
  }
  const existing = sheet.relationships.find(
    r => (r.fromId === fromId && r.toId === toId) || (r.fromId === toId && r.toId === fromId),
  )
  if (existing) {
    return existing.id
  }
  const id = crypto.randomUUID()
  store.commit([makeOp('createRelationship', { relationship: { id, fromId, toId } })])
  return id
}

export function removeRelationship(store: MindmapStore, id: string): void {
  const relationship = store.sheet?.relationships.find(r => r.id === id)
  if (!relationship) {
    return
  }
  // The op carries the whole relationship, not just the id: that payload IS
  // the inverse's argument, so undo can put it back with its label and colour.
  store.commit([makeOp('deleteRelationship', { id, relationship: { ...relationship } })])
}

export function updateRelationship(store: MindmapStore, id: string, patch: Partial<Relationship>): void {
  const prev = store.sheet?.relationships.find(r => r.id === id)
  if (!prev) {
    return
  }
  const next = withPatch(prev, { ...patch, id: prev.id })
  // A committed no-op is a wasted undo step: the user presses Ctrl+Z and
  // nothing visibly changes, which reads as broken undo.
  if (JSON.stringify(next) === JSON.stringify(prev)) {
    return
  }
  store.commit([makeOp('setRelationship', { id, relationship: next, prev: { ...prev } })])
}

/**
 * Draws a boundary around the given topics and returns its id, or '' when
 * fewer than two of them resolve. Ids that do not resolve are dropped at
 * CREATION, which is not the same rule as rendering: a boundary must start out
 * enclosing something that exists, while a member deleted LATER keeps its id
 * so undo can bring it back (see memberRectsOf in relations.ts).
 */
export function addGroup(store: MindmapStore, memberIds: string[]): string {
  const sheet = store.sheet
  if (!sheet) {
    return ''
  }
  const seen = new Set<string>()
  const members = memberIds.filter((memberId) => {
    if (seen.has(memberId) || !sheet.nodes[memberId]) {
      return false
    }
    seen.add(memberId)
    return true
  })
  if (members.length < 2) {
    return ''
  }
  const id = crypto.randomUUID()
  store.commit([makeOp('createGroup', { group: { id, memberIds: members } })])
  return id
}

export function removeGroup(store: MindmapStore, id: string): void {
  const group = store.sheet?.boundaries.find(g => g.id === id)
  if (!group) {
    return
  }
  store.commit([makeOp('deleteGroup', { id, group: { ...group, memberIds: [...group.memberIds] } })])
}

export function updateGroup(store: MindmapStore, id: string, patch: Partial<Group>): void {
  const prev = store.sheet?.boundaries.find(g => g.id === id)
  if (!prev) {
    return
  }
  const next = withPatch(prev, { ...patch, id: prev.id })
  if (JSON.stringify(next) === JSON.stringify(prev)) {
    return
  }
  store.commit([makeOp('setGroup', {
    id,
    group: { ...next, memberIds: [...next.memberIds] },
    prev: { ...prev, memberIds: [...prev.memberIds] },
  })])
}
