import type { TextRun } from '../src/mindmap/types'
import domino from '@mixmark-io/domino'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  MAX_PASTE_CHARS,
  normaliseRuns,
  plainOffsetOf,
  plainPointOf,
  plainToRuns,
  runParagraphs,
  runsFromDom,
  runsFromHtml,
  runsToPlain,
  runStyle,
  setRunBackground,
  setRunColor,
  setRunFontSize,
  toggleMark,
} from '../src/mindmap/richtext'

/**
 * The suite runs in vitest's `node` environment (vite.config.ts), which has no
 * `DOMParser`, so one is installed here over domino — a real HTML5 parser, not
 * a hand-written stand-in. That distinction matters: a fake built to match
 * what `runsFromHtml` expects would agree with the walker because it shares
 * the walker's misunderstanding of the markup, and the Word fixture below
 * exists precisely to catch the cases where real HTML does not look the way
 * the code assumes. Everything under test is the shipped code; only the
 * parser behind `DOMParser` is substituted, exactly as `fake-indexeddb`
 * substitutes for IndexedDB in tests/mindmap-storage.test.ts.
 *
 * domino is declared as a direct devDependency in package.json (it was
 * previously only reachable transitively through turndown).
 */
beforeAll(() => {
  class NodeDomParser {
    parseFromString(html: string) {
      return domino.createDocument(html, true)
    }
  }
  ;(globalThis as { DOMParser?: unknown }).DOMParser = NodeDomParser
})

/**
 * The invariant that outranks everything else in this lane (§A.1, §T.10):
 * `node.title` is always the plain projection of `node.titleRuns`. Every
 * consumer outside the map — the tile indicator, the chart save file, the
 * outline copy — reads `title` alone, so a mutation that leaves the two
 * disagreeing shows correct text on the map and stale text everywhere else,
 * with nothing anywhere that fails.
 *
 * It is asserted after each mutating function rather than once, because each
 * one is an independent way to break it.
 */
function expectInvariant(runs: TextRun[], plain: string) {
  expect(runsToPlain(runs)).toBe(plain)
}

const SAMPLE: TextRun[] = [
  { text: 'Hello ' },
  { text: 'brave', bold: true },
  { text: ' world' },
]

describe('the plain-text invariant', () => {
  it('survives every mutating function', () => {
    const plain = runsToPlain(SAMPLE)
    expect(plain).toBe('Hello brave world')

    expectInvariant(normaliseRuns(SAMPLE), plain)
    expectInvariant(toggleMark(SAMPLE, 0, 5, 'bold'), plain)
    expectInvariant(toggleMark(SAMPLE, 6, 11, 'bold'), plain)
    expectInvariant(toggleMark(SAMPLE, 2, 9, 'italic'), plain)
    expectInvariant(toggleMark(SAMPLE, 0, plain.length, 'underline'), plain)
    expectInvariant(toggleMark(SAMPLE, 3, 4, 'strike'), plain)
    expectInvariant(setRunColor(SAMPLE, 1, 12, '#ff0000'), plain)
    expectInvariant(setRunColor(SAMPLE, 0, plain.length, undefined), plain)
    expectInvariant(setRunFontSize(SAMPLE, 2, 8, 24), plain)
    expectInvariant(setRunFontSize(SAMPLE, 0, 4, undefined), plain)
    expectInvariant(plainToRuns(plain), plain)
  })

  it('holds for a paste, whose plain text is whatever the runs say', () => {
    const runs = runsFromHtml('<p>One</p><p><b>Two</b> three</p>')
    // Not a hardcoded expectation of the walker's output: the invariant is
    // that these two agree, whatever the walker decided the text was.
    expectInvariant(runs, runsToPlain(runs))
    expect(runsToPlain(runs)).toContain('One')
    expect(runsToPlain(runs)).toContain('Two three')
  })

  it('holds for a truncated paste', () => {
    const runs = runsFromHtml(`<p>${'x'.repeat(100_000)}</p>`)
    expectInvariant(runs, runsToPlain(runs))
  })

  it('holds when a mutation is a no-op range', () => {
    const plain = runsToPlain(SAMPLE)
    expectInvariant(toggleMark(SAMPLE, 4, 4, 'bold'), plain)
    expectInvariant(toggleMark(SAMPLE, 9, 3, 'bold'), plain)
    expectInvariant(setRunColor([], 0, 5, '#fff'), '')
  })
})

describe('plainToRuns / runsToPlain', () => {
  it('round-trips a plain string', () => {
    expect(runsToPlain(plainToRuns('Topic'))).toBe('Topic')
  })

  it('gives an empty array for empty text, not one empty run', () => {
    // An unstyled title keeps `titleRuns` undefined (§A.1); a lone empty run
    // would make every blank node grow a parallel representation of nothing.
    expect(plainToRuns('')).toEqual([])
    expect(runsToPlain([])).toBe('')
  })

  it('concatenates without inventing separators', () => {
    // If this synthesised a separator between runs, every plain-text offset
    // the editor hands to toggleMark would land short by one per boundary.
    expect(runsToPlain([{ text: 'a' }, { text: 'b', paraGap: true }])).toBe('ab')
  })
})

describe('normaliseRuns', () => {
  it('merges adjacent runs with identical marks', () => {
    const runs = normaliseRuns([
      { text: 'foo', bold: true },
      { text: 'bar', bold: true },
    ])
    expect(runs).toEqual([{ text: 'foobar', bold: true }])
  })

  it('drops empty runs', () => {
    expect(normaliseRuns([{ text: '' }, { text: 'a' }, { text: '' }])).toEqual([{ text: 'a' }])
  })

  it('drops marks set to false, so sizeKey sees one key for one title', () => {
    // cull.ts's sizeKey JSON-serialises titleRuns to decide whether the topic
    // must be re-measured. `{ bold: false }` and `{}` are the same title but
    // different keys, so without this every toggle re-measures the box.
    expect(normaliseRuns([{ text: 'a', bold: false, italic: false }])).toEqual([{ text: 'a' }])
  })

  it('returns a single run after bold on then bold off', () => {
    const plain = runsToPlain(SAMPLE)
    const on = toggleMark(plainToRuns('one two'), 0, 3, 'bold')
    const off = toggleMark(on, 0, 3, 'bold')
    expect(off).toEqual([{ text: 'one two' }])
    expect(runsToPlain(off)).toBe('one two')
    expect(plain).toBe('Hello brave world')
  })

  it('will not merge across a paragraph boundary', () => {
    const runs = normaliseRuns([
      { text: 'one' },
      { text: '\ntwo', paraGap: true },
    ])
    expect(runs).toHaveLength(2)
    expect(runs[1].paraGap).toBe(true)
  })

  it('will not merge a bullet into the plain line above it', () => {
    const runs = normaliseRuns([
      { text: 'intro' },
      { text: 'item', listIndent: 1 },
    ])
    expect(runs).toHaveLength(2)
  })
})

describe('toggleMark', () => {
  it('marks the whole range when only part of it is marked', () => {
    // The surprising alternative is a per-run toggle, which turns a
    // partly-bold selection into its photographic negative.
    const runs = toggleMark(SAMPLE, 0, 17, 'bold')
    expect(runs).toEqual([{ text: 'Hello brave world', bold: true }])
  })

  it('clears the mark only when every character already has it', () => {
    const allBold = toggleMark(plainToRuns('abc'), 0, 3, 'bold')
    expect(toggleMark(allBold, 0, 3, 'bold')).toEqual([{ text: 'abc' }])
  })

  it('lands on offsets that start and end mid-run', () => {
    const runs = toggleMark(plainToRuns('abcdefgh'), 2, 5, 'italic')
    expect(runs).toEqual([
      { text: 'ab' },
      { text: 'cde', italic: true },
      { text: 'fgh' },
    ])
    expectInvariant(runs, 'abcdefgh')
  })

  it('splits across a run boundary without moving the text', () => {
    // 'Hello ' | 'brave'(bold) | ' world' — 3..9 starts mid-run-0 and ends
    // mid-run-1, the case a run-index-based API would get wrong.
    const runs = toggleMark(SAMPLE, 3, 9, 'underline')
    expect(runsToPlain(runs)).toBe('Hello brave world')
    expect(runs.map(r => r.text)).toEqual(['Hel', 'lo ', 'bra', 've', ' world'])
    expect(runs[1].underline).toBe(true)
    expect(runs[2].underline).toBe(true)
    expect(runs[2].bold).toBe(true)
    expect(runs[3].bold).toBe(true)
    expect(runs[3].underline).toBeUndefined()
  })

  it('clamps a range that runs past the end of the text', () => {
    const runs = toggleMark(plainToRuns('abc'), 1, 999, 'strike')
    expect(runs).toEqual([{ text: 'a' }, { text: 'bc', strike: true }])
  })

  it('keeps a paragraph boundary on the first piece of a split run', () => {
    const source: TextRun[] = [{ text: 'one' }, { text: '\ntwo', paraGap: true }]
    const runs = toggleMark(source, 5, 7, 'bold')
    expect(runsToPlain(runs)).toBe('one\ntwo')
    // The gap belongs to the start of the paragraph; copying it onto the tail
    // would open a second paragraph in the middle of a word.
    expect(runs.filter(r => r.paraGap)).toHaveLength(1)
    expect(runs.find(r => r.paraGap)?.text.startsWith('\n')).toBe(true)
  })
})

describe('setRunColor and setRunFontSize', () => {
  it('sets and clears a colour over a partial range', () => {
    const red = setRunColor(plainToRuns('abcdef'), 2, 4, '#ff0000')
    expect(red).toEqual([{ text: 'ab' }, { text: 'cd', color: '#ff0000' }, { text: 'ef' }])
    const cleared = setRunColor(red, 0, 6, undefined)
    expect(cleared).toEqual([{ text: 'abcdef' }])
  })

  it('sets and clears a font size over a partial range', () => {
    const big = setRunFontSize(plainToRuns('abcdef'), 0, 3, 24)
    expect(big).toEqual([{ text: 'abc', fontSize: 24 }, { text: 'def' }])
    expect(setRunFontSize(big, 0, 6, undefined)).toEqual([{ text: 'abcdef' }])
  })

  it('treats a zero size as clearing, not as a size', () => {
    const big = setRunFontSize(plainToRuns('abc'), 0, 3, 24)
    expect(setRunFontSize(big, 0, 3, 0)).toEqual([{ text: 'abc' }])
  })
})

// ---------------------------------------------------------------------------
// Paste fixtures — captured clipboard payloads, not markup written to pass.
// ---------------------------------------------------------------------------

/**
 * Google Docs. The whole payload is wrapped in `<b style="font-weight:normal">`
 * — a real quirk of the Docs clipboard, and the one that a tag-first walk
 * reads as "the entire document is bold".
 */
const GOOGLE_DOCS_HTML = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-9c1f2f2a-7fff-1a2b-3c4d-5e6f7a8b9c0d"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Plain lead-in and </span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">emphasis</span><span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:italic;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"> then italics</span></p></b>`

/**
 * Microsoft Word. Ships a `<style>` block of `mso-` rules, `<o:p>` markers and
 * class-only spans — none of which may reach the runs.
 */
const WORD_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><meta name=Generator content="Microsoft Word 15"><style><!--
 /* Font Definitions */
 @font-face {font-family:Calibri; panose-1:2 15 5 2 2 2 4 3 2 4;}
 /* Style Definitions */
 p.MsoNormal, li.MsoNormal, div.MsoNormal
 {margin:0cm; font-size:11.0pt; font-family:"Calibri",sans-serif;}
 span.SpellE {mso-style-name:""; mso-spl-e:yes;}
--></style></head><body lang=EN-GB style='word-wrap:break-word'><div class=WordSection1><p class=MsoNormal><span style='font-size:12.0pt'>Quarterly <b style='mso-bidi-font-weight:normal'>results</b> review<o:p></o:p></span></p><p class=MsoNormal><span class=SpellE>Followup</span> in <i>March</i><o:p></o:p></p></div></body></html>`

describe('runsFromHtml — Google Docs', () => {
  it('does not come back entirely bold', () => {
    const runs = runsFromHtml(GOOGLE_DOCS_HTML)
    // The whole point of the fixture: the wrapper is <b>, but it declares
    // font-weight:normal, and the inline declaration wins.
    expect(runs.every(r => r.bold)).toBe(false)
    expect(runs[0].bold).toBeUndefined()
  })

  it('reads the wrapper quirk even where no inner span restates the weight', () => {
    // The fixture above happens to give every span its own font-weight, which
    // masks a walker that trusts the <b> tag: the inner declaration corrects
    // the wrapper's mistake on the way down. Docs does not always emit that
    // inner weight, so the quirk is asserted here on its own — this is the
    // case that fails if the tag is ever allowed to beat the style.
    const runs = runsFromHtml('<b style="font-weight:normal;">nothing here is bold</b>')
    expect(runs).toEqual([{ text: 'nothing here is bold' }])
    expect(runs.some(r => r.bold)).toBe(false)
  })

  it('still reads a plain <b> as bold when no weight is declared', () => {
    // The other half of the rule: the tag is trusted whenever nothing
    // contradicts it, or the fix for Docs would silently un-bold every
    // ordinary <b> from every other source.
    expect(runsFromHtml('<b>bold</b>')).toEqual([{ text: 'bold', bold: true }])
    expect(runsFromHtml('<strong>bold</strong>')).toEqual([{ text: 'bold', bold: true }])
  })

  it('keeps the emphasis the document actually declared', () => {
    const runs = runsFromHtml(GOOGLE_DOCS_HTML)
    const plain = runsToPlain(runs)
    expect(plain).toBe('Plain lead-in and emphasis then italics')
    expectInvariant(runs, plain)

    const bold = runs.filter(r => r.bold)
    expect(bold).toHaveLength(1)
    expect(bold[0].text).toBe('emphasis')

    const italic = runs.filter(r => r.italic)
    expect(italic).toHaveLength(1)
    expect(italic[0].text).toBe(' then italics')
  })

  it('drops the layout markup while keeping the text', () => {
    // vertical-align, white-space and line-height are page layout; none has a
    // home on a TextRun and they must NOT leak. font-family and
    // background-color are carried deliberately (the r-node parity work), so
    // they are allowed. Asserted as an exact key set rather than a few
    // absences, because the failure being guarded against is a NEW field
    // leaking through, which no blocklist of known-bad names would catch.
    const allowed = new Set([
      'text',
      'bold',
      'italic',
      'underline',
      'strike',
      'color',
      'fontFamily',
      'backgroundColor',
      'fontSize',
      'paraGap',
      'listIndent',
    ])
    const runs = runsFromHtml(GOOGLE_DOCS_HTML)
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      for (const key of Object.keys(run)) {
        expect(allowed).toContain(key)
      }
    }
    // Docs states a font-size on every span; a title does not inherit the
    // document's body size just because it was copied out of one.
    expect(runs.some(r => r.fontSize)).toBe(false)
  })
})

describe('runsFromHtml — Microsoft Word', () => {
  it('contributes nothing from the <style> block or <o:p> markers', () => {
    const runs = runsFromHtml(WORD_HTML)
    const plain = runsToPlain(runs)
    expect(plain).not.toContain('mso-')
    expect(plain).not.toContain('font-family')
    expect(plain).not.toContain('panose')
    expect(plain).not.toContain('@font-face')
    expectInvariant(runs, plain)
  })

  it('keeps the paragraphs, the bold and the italic', () => {
    const runs = runsFromHtml(WORD_HTML)
    const plain = runsToPlain(runs)
    expect(plain).toBe('Quarterly results review\nFollowup in March')

    expect(runs.filter(r => r.bold).map(r => r.text)).toEqual(['results'])
    expect(runs.filter(r => r.italic).map(r => r.text)).toEqual(['March'])
    // The second <p> opens a paragraph, not just a line.
    expect(runs.some(r => r.paraGap)).toBe(true)
  })
})

describe('runsFromHtml — structure', () => {
  it('renders a heading as BOLD at the body size, r-node style', () => {
    // r-node stores an h1 as bold at the topic's font-size with no per-run
    // size bump, so pasting one must not inflate the node. The source's 96px
    // is deliberately NOT carried either.
    const runs = runsFromHtml('<h1 style="font-size:96px">Title</h1>')
    expect(runs).toHaveLength(1)
    expect(runs[0].bold).toBe(true)
    expect(runs[0].fontSize).toBeUndefined()
  })

  it('gives <li> a listIndent at its nesting depth', () => {
    const runs = runsFromHtml('<ul><li>one</li><li>two<ul><li>deep</li></ul></li></ul>')
    const byText = Object.fromEntries(runs.map(r => [r.text.replace(/^\n/, ''), r]))
    expect(byText.one.listIndent).toBe(1)
    expect(byText.two.listIndent).toBe(1)
    expect(byText.deep.listIndent).toBe(2)
  })

  it('distinguishes a <br> from a <p>', () => {
    // Both put a newline in the plain text; only the block break opens a gap.
    const soft = runsFromHtml('one<br>two')
    expect(runsToPlain(soft)).toBe('one\ntwo')
    expect(soft.some(r => r.paraGap)).toBe(false)

    const block = runsFromHtml('<p>one</p><p>two</p>')
    expect(runsToPlain(block)).toBe('one\ntwo')
    expect(block.some(r => r.paraGap)).toBe(true)
  })

  it('reads underline and strike from tags and from text-decoration', () => {
    const tags = runsFromHtml('<u>a</u><s>b</s><del>c</del><strike>d</strike>')
    expect(tags.filter(r => r.underline).map(r => r.text)).toEqual(['a'])
    expect(tags.filter(r => r.strike).map(r => r.text).join('')).toBe('bcd')

    const css = runsFromHtml('<span style="text-decoration:underline line-through">x</span>')
    expect(css[0].underline).toBe(true)
    expect(css[0].strike).toBe(true)
  })

  it('takes a colour from an inline style', () => {
    const runs = runsFromHtml('<span style="color:#ff7f50">warm</span>')
    expect(runs[0].color).toBe('#ff7f50')
  })

  it('contributes only text for tags it does not understand', () => {
    const runs = runsFromHtml('<article><figure><figcaption>caption</figcaption></figure></article>')
    expect(runsToPlain(runs)).toContain('caption')
    expect(runs.some(r => r.bold || r.italic || r.underline)).toBe(false)
  })
})

describe('runsFromHtml — sanitisation', () => {
  it('contributes no run and no element for a <script>', () => {
    const runs = runsFromHtml('<script>alert(1)</script>')
    expect(runs).toEqual([])
    expect(runsToPlain(runs)).toBe('')
  })

  it('keeps script text out of a document that also has real text', () => {
    const runs = runsFromHtml('<p>before</p><script>alert(1)</script><p>after</p>')
    const plain = runsToPlain(runs)
    expect(plain).toBe('before\nafter')
    expect(plain).not.toContain('alert')
  })

  it('drops an inline event handler and a javascript: href entirely', () => {
    // Attributes other than `style` and the editor's own `data-` hints are
    // never read, so there is no path by which one could reach a run.
    const runs = runsFromHtml('<a href="javascript:alert(1)" onclick="alert(2)">link</a>')
    expect(runs).toEqual([{ text: 'link' }])
    expect(JSON.stringify(runs)).not.toContain('javascript')
    expect(JSON.stringify(runs)).not.toContain('onclick')
  })

  it('drops an <img onerror> while keeping surrounding text', () => {
    const runs = runsFromHtml('<p>a<img src=x onerror="alert(1)">b</p>')
    expect(runsToPlain(runs)).toBe('ab')
    expect(JSON.stringify(runs)).not.toContain('onerror')
  })

  it('contributes nothing from <style> or <meta>', () => {
    const runs = runsFromHtml('<meta charset="utf-8"><style>body{color:red}</style>')
    expect(runs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// DOM points <-> plain offsets — the editor's coordinate system
// ---------------------------------------------------------------------------
// The editor maps a DOM `Selection` to plain-text offsets (what toggleMark
// takes) and back. The mapping shares the walker's traversal, so it must agree
// with runsFromDom about where every newline is; a second, hand-rolled count
// would drift by one per `<br>` and format the wrong word.

describe('plainOffsetOf / plainPointOf', () => {
  function root(html: string): Element {
    return domino.createDocument(html, true).body
  }

  function textOf(node: Element, selector: string, index = 0): Text {
    return node.querySelectorAll(selector)[index].firstChild as Text
  }

  it('maps a caret inside a single run exactly', () => {
    const body = root('<div>abcdef</div>')
    const t = textOf(body, 'div')
    expect(plainOffsetOf(body, { node: t, offset: 0 })).toBe(0)
    expect(plainOffsetOf(body, { node: t, offset: 3 })).toBe(3)
    expect(plainOffsetOf(body, { node: t, offset: 6 })).toBe(6)
    // Select-all endpoints on the root itself.
    expect(plainOffsetOf(body, { node: body, offset: 0 })).toBe(0)
    expect(plainOffsetOf(body, { node: body, offset: 1 })).toBe(6)
  })

  it('counts a paragraph break between two divs once', () => {
    const body = root('<div>ab</div><div>cd</div>')
    const divs = body.querySelectorAll('div')
    // The walker's plain text is 'ab\ncd' — the caret at the second div's
    // start is on the far side of the newline.
    expect(plainOffsetOf(body, { node: divs[1], offset: 0 })).toBe(3)
    expect(plainOffsetOf(body, { node: divs[1].firstChild as Text, offset: 1 })).toBe(4)
    expect(plainOffsetOf(body, { node: divs[0].firstChild as Text, offset: 2 })).toBe(2)
    // An element point between the blocks lands on the same offset.
    expect(plainOffsetOf(body, { node: body, offset: 1 })).toBe(3)
    expect(plainOffsetOf(body, { node: body, offset: 2 })).toBe(5)
  })

  it('counts a <br> as one newline, like the walker', () => {
    const body = root('<div>ab<br>cd</div>')
    const div = body.querySelector('div')!
    const cd = div.childNodes[2] as Text
    // plain: 'ab\ncd' — the br's newline materialises at the text after it.
    expect(plainOffsetOf(body, { node: cd, offset: 0 })).toBe(3)
    expect(plainOffsetOf(body, { node: cd, offset: 1 })).toBe(4)
    expect(plainOffsetOf(body, { node: div, offset: 1 })).toBe(2)
  })

  it('collapses an empty paragraph the way the walker does', () => {
    const body = root('<div>ab</div><div></div><div>cd</div>')
    const divs = body.querySelectorAll('div')
    expect(plainOffsetOf(body, { node: divs[2], offset: 0 })).toBe(3)
    expect(plainOffsetOf(body, { node: body, offset: 2 })).toBe(3)
    expect(plainOffsetOf(body, { node: body, offset: 3 })).toBe(5)
  })

  it('round-trips every offset through a point and back', () => {
    const body = root('<div>ab</div><div><span>cd</span></div><div>ef<br>gh</div>')
    const plain = 'ab\ncd\nef\ngh'
    for (let i = 0; i <= plain.length; i++) {
      const point = plainPointOf(body, i)
      expect(point).not.toBeNull()
      expect(plainOffsetOf(body, point!)).toBe(i)
    }
    // Past the end resolves to the end of the last text, so the caret can be
    // restored even when the selection outlives the content.
    const beyond = plainPointOf(body, plain.length + 5)
    expect(plainOffsetOf(body, beyond!)).toBe(plain.length)
  })

  it('agrees with runsFromDom about the plain text length', () => {
    const body = root('<div>ab</div><div>cd<br>ef</div>')
    const len = runsToPlain(runsFromDom(body, true)).length
    expect(plainOffsetOf(body, { node: body, offset: body.childNodes.length })).toBe(len)
  })

  it('returns null for a subtree with no text', () => {
    const body = root('<div><br></div>')
    expect(plainPointOf(body, 0)).toBeNull()
  })
})

describe('runsFromHtml — the paste cap', () => {
  it('truncates a 100,000-character paste and does not hang', () => {
    const started = Date.now()
    const runs = runsFromHtml(`<p>${'ab '.repeat(40_000)}</p>`)
    const plain = runsToPlain(runs)

    expect(plain.length).toBeLessThanOrEqual(MAX_PASTE_CHARS)
    expectInvariant(runs, plain)
    // Not a benchmark, a hang detector: the failure this guards against is a
    // paste that never returns, not one that is slow.
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('truncates across many elements without building a run per element', () => {
    const html = Array.from({ length: 20_000 }, (_, i) => `<p>para ${i}</p>`).join('')
    const runs = runsFromHtml(html)
    expect(runsToPlain(runs).length).toBeLessThanOrEqual(MAX_PASTE_CHARS)
    expect(runs.length).toBeLessThanOrEqual(MAX_PASTE_CHARS)
    expectInvariant(runs, runsToPlain(runs))
  })

  it('returns an empty array for an empty payload', () => {
    expect(runsFromHtml('')).toEqual([])
    expect(runsFromHtml('   ')).toEqual([])
  })
})

describe('background highlight (advanced rich text)', () => {
  it('parses background-color from pasted html', () => {
    const runs = runsFromHtml('<p>a <mark style="background-color:#fde68a">note</mark> inside</p>')
    const note = runs.find(r => !!r.backgroundColor)
    expect(note?.backgroundColor).toBe('#fde68a')
    expect(note?.text).toBe('note')
    expectInvariant(runs, runsToPlain(runs))
  })

  it('setRunBackground highlights a range and round-trips through the editor', () => {
    const runs = plainToRuns('one two three')
    const highlighted = setRunBackground(runs, 4, 7, '#a7f3d0')
    const run = highlighted.find(r => !!r.backgroundColor)
    expect(run?.backgroundColor).toBe('#a7f3d0')
    expect(run?.text).toBe('two')
    // Cleared highlight merges back to the invariant.
    const cleared = setRunBackground(highlighted, 4, 7, undefined)
    expect(cleared.every(r => !r.backgroundColor)).toBe(true)
    expectInvariant(cleared, runsToPlain(cleared))
  })
})

describe('r-node rich text parity', () => {
  it('reads the background SHORTHAND, not only background-color', () => {
    // Word/Docs spell it longhand, but editors, signatures and Draw.io exports
    // hand-roll `background:#fcdcd2`, and r-node keeps both.
    const runs = runsFromHtml('<p>a <span style="background:#ffd166">note</span> inside</p>')
    const note = runs.find(r => !!r.backgroundColor)
    expect(note?.backgroundColor).toBe('#ffd166')
    expect(note?.text).toBe('note')
    expectInvariant(runs, runsToPlain(runs))
  })

  it('clears a parent highlight with background-color:transparent', () => {
    const runs = runsFromHtml('<div style="background:#fcdcd2"><span style="background-color:transparent">in</span></div>')
    expect(runs.every(r => !r.backgroundColor)).toBe(true)
  })

  it('fills the whole block instead of per-run strips (r-node parity)', () => {
    // A block's background is carried on the paragraph-opening run (not as
    // per-glyph wallpaper on every run), so the topic paints ONE filled box
    // behind the text — which is what makes a pasted section look contiguous
    // instead of patchy, exactly as r-node draws it.
    const runs = runsFromHtml(
      '<div style="background-color:#fcdcd2; padding:10px"><h3>Title</h3><p>body <b>bold</b></p></div>',
    )
    // No run gets a per-glyph strip from the block fill.
    expect(runs.every(r => !r.backgroundColor)).toBe(true)
    // Every paragraph carries the fill + the block's padding.
    const paragraphs = runParagraphs(runs)
    expect(paragraphs.length).toBeGreaterThan(1)
    expect(paragraphs.every(p => p.blockBackground === '#fcdcd2')).toBe(true)
    expect(paragraphs.every(p => p.blockPadding === 10)).toBe(true)
    expectInvariant(runs, runsToPlain(runs))
  })

  it('keeps an inline highlight distinct from a block fill', () => {
    const runs = runsFromHtml(
      '<div style="background-color:#fcdcd2; padding:8px"><p>a <mark style="background-color:#ffd166">w</mark> b</p></div>',
    )
    const highlight = runs.find(r => r.backgroundColor === '#ffd166')
    expect(highlight?.text).toBe('w')
    // The block fill is still the paragraph's, not stamped onto the span.
    expect(runParagraphs(runs).every(p => p.blockBackground === '#fcdcd2')).toBe(true)
  })

  it('keeps a font-family on the run that declares it and lets siblings differ', () => {
    const runs = runsFromHtml(
      '<div style="font-family:Georgia,serif"><h3 style="font-family:Arial">H</h3><p>plain body keeps Georgia</p></div>',
    )
    const heading = runs.find(r => r.text === 'H')
    const body = runs.find(r => (r.text as string).includes('plain body')) as { fontFamily?: string }
    expect(heading?.fontFamily).toBe('Arial')
    expect(body.fontFamily).toBe('Georgia,serif')
    expectInvariant(runs, runsToPlain(runs))
  })

  it('runStyle emits font-family and background-color for the renderers', () => {
    const style = runStyle({ text: 'x', fontFamily: 'Cambria', backgroundColor: '#fde68a' })
    expect(style.fontFamily).toBe('Cambria')
    expect(style.backgroundColor).toBe('#fde68a')
    expect(style.padding).toBe('0 1px')
  })
})
