import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginOp,
  causalChain,
  clearEvents,
  droppedCount,
  emit,
  events,
  formatEvent,
  setLevel,
} from '../src/dev/traceCore'

beforeEach(() => {
  clearEvents()
  setLevel('info')
})

describe('sequence numbers', () => {
  it('increase monotonically, which timestamps alone cannot guarantee', () => {
    emit('ui', 'a')
    emit('ui', 'b')
    emit('ui', 'c')

    const seqs = events().map(e => e.seq)
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y))
    expect(new Set(seqs).size).toBe(3)
  })

  it('keeps rising across a clear, so two captures never reuse a number', () => {
    emit('ui', 'before')
    const first = events()[0].seq
    clearEvents()
    emit('ui', 'after')

    expect(events()[0].seq).toBeGreaterThan(first)
  })
})

describe('operation ids and causality', () => {
  it('gives each operation of a kind its own id', () => {
    const a = beginOp('OPEN', 'mindmap')
    const b = beginOp('OPEN', 'mindmap')

    expect(a.id).not.toBe(b.id)
    expect(a.id).toMatch(/^OPEN-\d+$/)
  })

  it('links a child to its parent', () => {
    const parent = beginOp('OPEN', 'mindmap')
    const child = parent.child('WRITE', 'persist')
    child.end()
    parent.end()

    const write = events().find(e => e.traceId === child.id)
    expect(write?.parentId).toBe(parent.id)
  })

  it('causalChain returns an operation and everything it caused, and nothing else', () => {
    const open = beginOp('OPEN', 'mindmap')
    const save = open.child('SAVE', 'persist')
    const write = save.child('WRITE', 'persist')
    write.end()
    save.end()
    open.end()

    // A second, unrelated operation running at the same time must not appear.
    const other = beginOp('OPEN', 'mindmap')
    other.end()

    const chain = causalChain(open.id)
    const ids = new Set(chain.map(e => e.traceId))

    expect(ids).toContain(open.id)
    // Two levels down: the chain has to be transitive, or "what caused this
    // write" stops working exactly where it matters.
    expect(ids).toContain(save.id)
    expect(ids).toContain(write.id)
    expect(ids).not.toContain(other.id)
  })
})

describe('async diagnostics', () => {
  it('records a stale finish distinctly from a normal one', () => {
    const overtaken = beginOp('OPEN', 'mindmap')
    overtaken.stale({ expected: 'A', actual: 'B' })

    const last = events().at(-1)
    expect(last?.phase).toBe('stale')
    expect(last?.detail).toMatchObject({ expected: 'A', actual: 'B' })
  })

  it('reports a span that ends twice instead of silently recording it', () => {
    const span = beginOp('SAVE', 'persist')
    span.end()
    span.end()

    const doubles = events().filter(e => e.what === 'span:double-end')
    expect(doubles).toHaveLength(1)
  })

  it('leaves an unfinished operation visibly unfinished', () => {
    const span = beginOp('OPEN', 'mindmap')

    const mine = events().filter(e => e.traceId === span.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].phase).toBe('start')
  })
})

describe('ring buffer', () => {
  it('bounds itself and counts what it threw away', () => {
    for (let i = 0; i < 2500; i++) {
      emit('ui', `event-${i}`)
    }

    // Without the count a truncated trace lies by omission: the reader takes
    // the oldest surviving event for the beginning of the session.
    expect(events().length).toBeLessThanOrEqual(2000)
    expect(droppedCount()).toBeGreaterThan(0)
    expect(events().at(-1)?.what).toBe('event-2499')
  })
})

describe('levels', () => {
  it('drops events below the level, and does not build their payload', () => {
    setLevel('error')
    let built = 0

    emit('ui', 'chatty', () => {
      built += 1
      return { expensive: true }
    })

    expect(events()).toHaveLength(0)
    // The point of a thunk: a payload that costs something is not paid for
    // when the event is discarded.
    expect(built).toBe(0)
  })

  it('off records nothing at all', () => {
    setLevel('off')
    emit('err', 'boom', undefined, { min: 'error' })
    expect(events()).toHaveLength(0)
  })
})

describe('formatting', () => {
  it('puts the sequence, the id and the parent on one line', () => {
    const parent = beginOp('OPEN', 'mindmap')
    const child = parent.child('WRITE', 'persist')
    const line = formatEvent(events().at(-1)!)

    expect(line).toContain(`[${child.id}]`)
    expect(line).toContain(`←${parent.id}`)
    expect(line).toMatch(/^#\d+/)
  })
})
