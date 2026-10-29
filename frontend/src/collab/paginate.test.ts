// The page-packing rules, on synthetic measurements (no DOM).
import { describe, expect, it } from 'vitest'

import { gapHeights, lastPageFill, paginate, type Line, type Unit } from './paginate'

const H = 100 // content height of a page

// A stack of blocks laid out top to bottom: [height, marginTop] each.
function stack(specs: { h: number; mt?: number; heading?: boolean; kind?: Unit['kind']; lines?: number; children?: Unit[] }[], start = 0, pos0 = 0) {
  let y = start
  return specs.map((s, i) => {
    const top = y + (i === 0 ? 0 : (s.mt ?? 0))
    const bottom = top + s.h
    y = bottom
    const pos = pos0 + i * 100
    const u: Unit = { pos, top, bottom, kind: s.kind ?? 'leaf', heading: s.heading }
    if (s.lines) {
      const lh = s.h / s.lines
      u.lines = () => Array.from({ length: s.lines! }, (_, k): Line => ({ pos: pos + 1 + k * 10, top: top + k * lh, bottom: top + (k + 1) * lh }))
    }
    return u
  })
}

describe('paginate', () => {
  it('fills a page, then moves the next block whole to a new page', () => {
    const units = stack([{ h: 40 }, { h: 30, mt: 10 }, { h: 30, mt: 10 }, { h: 20, mt: 10 }])
    const plan = paginate(units, H)
    expect(plan.breaks).toEqual([{ pos: 200, kind: 'block', top: units[2].top, indent: 0 }]) // 40+10+30 = 80; +10+30 > 100
    expect(plan.overflow).toBe(0)
  })

  it('a block that fits exactly stays; none of the content is lost', () => {
    const units = stack([{ h: 50 }, { h: 50 }, { h: 50 }])
    const plan = paginate(units, H)
    expect(plan.breaks.map((b) => b.pos)).toEqual([200])
  })

  it('splits a paragraph taller than a page between lines, filling each page', () => {
    const units = stack([{ h: 30 }, { h: 250, mt: 10, lines: 10 }]) // 25px lines
    const plan = paginate(units, H)
    expect(plan.breaks.every((b) => b.kind === 'line')).toBe(true)
    // The paragraph runs from 40 to 290: page 1 holds 2 lines (to 90),
    // page 2 four (to 190), page 3 the last four (to 290).
    expect(plan.breaks.map((b) => b.top)).toEqual([90, 190])
    const starts = [0, ...plan.breaks.map((b) => b.top)]
    for (let k = 1; k < starts.length; k++) expect(starts[k] - starts[k - 1]).toBeLessThanOrEqual(H)
    expect(plan.contentBottom - starts[starts.length - 1]).toBeLessThanOrEqual(H)
    expect(plan.overflow).toBe(0)
  })

  it('moves a paragraph that fits on a fresh page instead of splitting it', () => {
    const units = stack([{ h: 70 }, { h: 60, mt: 0, lines: 3 }])
    const plan = paginate(units, H)
    expect(plan.breaks).toEqual([{ pos: 100, kind: 'block', top: 70, indent: 0 }])
  })

  it('keeps a heading with the block after it', () => {
    const units = stack([{ h: 60 }, { h: 20, mt: 5, heading: true }, { h: 30, mt: 5 }])
    const plan = paginate(units, H)
    expect(plan.breaks.map((b) => b.pos)).toEqual([100]) // before the heading, not between it and its paragraph
  })

  it('does not orphan-protect a heading that already starts the page', () => {
    const units = stack([{ h: 20, heading: true }, { h: 150, mt: 0, lines: 6 }])
    const plan = paginate(units, H)
    expect(plan.breaks.length).toBeGreaterThan(0)
    expect(plan.breaks[0].kind).toBe('line') // split the paragraph; no empty page before the heading
  })

  it('honours manual page breaks, without a blank page after a trailing one', () => {
    const units = stack([{ h: 20 }, { h: 2, kind: 'pageBreak' }, { h: 20 }, { h: 2, kind: 'pageBreak' }])
    const plan = paginate(units, H)
    expect(plan.breaks.map((b) => b.pos)).toEqual([200]) // after the first marker; the last marker ends the document
  })

  it('a manual break just past the bottom of a full page ends that page (no blank page)', () => {
    const units = stack([{ h: 99 }, { h: 2, mt: 1, kind: 'pageBreak' }, { h: 20 }])
    const plan = paginate(units, H)
    expect(plan.breaks.map((b) => b.pos)).toEqual([200]) // one break, after the marker; none before it
  })

  it('breaks long lists between items', () => {
    const items = stack(
      Array.from({ length: 10 }, () => ({ h: 22, mt: 2 })),
      5,
      1000,
    )
    const list: Unit = { pos: 999, top: 5, bottom: items[items.length - 1].bottom, kind: 'container', children: items }
    const units = [...stack([{ h: 5 }]), list]
    const plan = paginate(units, H)
    expect(plan.breaks.length).toBe(2)
    for (const b of plan.breaks) expect(items.map((i) => i.pos)).toContain(b.pos) // only between items
    // Each page's content (start to the bottom of its last item) fits; the
    // margin above the next page's first item is absorbed by the gap.
    const starts = [0, ...plan.breaks.map((b) => b.top)]
    starts.forEach((start, k) => {
      const end = starts[k + 1] ?? Infinity
      const lastBottom = Math.max(...items.filter((it) => it.top >= start && it.top < end).map((it) => it.bottom))
      expect(lastBottom - start).toBeLessThanOrEqual(H + 0.5)
    })
  })

  it('never loops: an unsplittable block taller than a page runs over (recorded), a huge line gets its own page', () => {
    const rule = stack([{ h: 30 }, { h: 250, mt: 0 }, { h: 20, mt: 0 }])
    const plan = paginate(rule, H)
    expect(plan.overflow).toBeGreaterThan(0)
    expect(plan.breaks.map((b) => b.pos)).toEqual([100, 200])

    const giantLine = stack([{ h: 10 }, { h: 300, mt: 0, lines: 2 }]) // two lines of 150px
    const plan2 = paginate(giantLine, H)
    expect(plan2.breaks.length).toBeLessThan(5)
    expect(plan2.overflow).toBeGreaterThan(0)
  })

  it('continues from a page start (incremental) exactly as a full run does', () => {
    const units = stack(Array.from({ length: 30 }, () => ({ h: 18, mt: 6 })))
    const full = paginate(units, H)
    const k = 2
    const from = full.breaks[k - 1]
    const tail = paginate(units.filter((u) => u.pos >= from.pos), H, from.top)
    expect(tail.breaks).toEqual(full.breaks.slice(k))
  })
})

describe('gap heights', () => {
  it('put the start of every page at k × pitch, whatever its margin', () => {
    const units = stack([{ h: 40 }, { h: 40, mt: 10 }, { h: 40, mt: 25 }, { h: 40, mt: 10 }, { h: 40, mt: 25 }])
    const plan = paginate(units, H)
    const pitch = H + 2 * 20 + 16 // content + margins + gap
    const gaps = gapHeights(plan.breaks, pitch)
    let added = 0
    plan.breaks.forEach((b, k) => {
      added += gaps[k]
      expect(b.top + added).toBeCloseTo((k + 1) * pitch) // where the page's first block lands
      expect(gaps[k]).toBeGreaterThan(0)
    })
    expect(lastPageFill(plan, H)).toBeGreaterThanOrEqual(0)
  })
})
