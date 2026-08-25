import type { RelatedLayer } from '../src/types'
import { describe, expect, it } from 'vitest'
import { reservedMindmapOffset } from '../src/store'

// The reserved mindmap spot ("il primo tile in basso a destra"): a fixed cell
// in a focused tile's layer, preferred at the parent's bottom-right (offset
// +1,+1), that no layer tile can occupy. The chart store's layer CRUD guards
// it (addLayerTile / firstEmptyLayerOffset / focusedMindmapSpotOffset); these
// tests pin down the cell-selection rules.
function offsetSpot(
  parent: { x: number, y: number },
  size: { x: number, y: number },
  layer: RelatedLayer = {},
): string | null {
  return reservedMindmapOffset(parent, size, layer)
}

describe('reservedMindmapOffset', () => {
  it('prefers the cell bottom-right of the parent (offset +1,+1)', () => {
    expect(offsetSpot({ x: 2, y: 2 }, { x: 3, y: 3 })).toBe('1,1')
  })

  it('falls back clockwise from south-east when the preferred cell is out of bounds', () => {
    // Parent at the bottom-right corner: +1,+1 is off-grid; the first in-bounds
    // cell of the fallback order is the cell to its left.
    expect(offsetSpot({ x: 3, y: 3 }, { x: 3, y: 3 })).toBe('-1,0')
    // Parent on the bottom edge: the +1,+1 and +0,+1 cells are off-grid, so
    // the spot lands on the cell to the parent's right.
    expect(offsetSpot({ x: 2, y: 3 }, { x: 3, y: 3 })).toBe('1,0')
  })

  it('skips cells already occupied by a layer tile', () => {
    const layer: RelatedLayer = { '1,1': {} as never, '0,1': {} as never }
    expect(offsetSpot({ x: 2, y: 2 }, { x: 3, y: 3 }, layer)).toBe('1,0')
  })

  it('returns null when every surrounding cell is off-grid (1x1 chart)', () => {
    expect(offsetSpot({ x: 1, y: 1 }, { x: 1, y: 1 })).toBeNull()
  })
})
