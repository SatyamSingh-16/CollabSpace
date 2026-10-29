// @vitest-environment jsdom
// The pagination plugin on the real editor bound to real Y.Docs. jsdom has
// no layout, so these tests drive the plugin state directly; the measured
// page layout is tested in real Chromium (browser/pagination.spec.ts).
import { Editor } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { collabExtensions } from './editor'
import { createPagination, paginationKey, type PaginationState } from './pagination'

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
})

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

function paginatedEditor(doc: Y.Doc) {
  const pagination = createPagination()
  const e = new Editor({ extensions: collabExtensions(doc, { pagination: pagination.extension }) })
  editors.push(e)
  return e
}

function linked() {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'))
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'))
  return { a, b }
}

/** Positions before each top-level block. */
const blockPositions = (e: Editor) => {
  const out: number[] = []
  e.state.doc.forEach((_n, offset) => out.push(offset))
  return out
}

/** Draws page gaps before the given positions, as a layout pass does (a meta-only transaction). */
function drawGaps(e: Editor, positions: number[]) {
  const breaks = positions.map((pos, k) => ({ pos, kind: 'block' as const, top: 100 * (k + 1), indent: 0, height: 50, lead: 0 }))
  const decorations = DecorationSet.create(
    e.state.doc,
    positions.map((pos) =>
      Decoration.widget(
        pos,
        () => {
          const el = document.createElement('div')
          el.className = 'page-gap'
          return el
        },
        { side: 1 }, // as block gaps are drawn
      ),
    ),
  )
  const state: PaginationState = { enabled: true, decorations, breaks, pageStarts: [0, ...positions] }
  e.view.dispatch(e.state.tr.setMeta(paginationKey, state).setMeta('addToHistory', false))
}

const gapsAt = (e: Editor) => paginationKey.getState(e.state)!.breaks.map((b) => b.pos)

describe('pagination', () => {
  it('drawing page gaps writes nothing to the Y.Doc and leaves the content and selection alone', () => {
    const doc = new Y.Doc()
    const e = paginatedEditor(doc)
    e.commands.insertContent('<p>One</p><p>Two</p><p>Three</p>')
    e.commands.setTextSelection(6)
    const updates: Uint8Array[] = []
    doc.on('update', (u: Uint8Array) => updates.push(u))
    const json = JSON.stringify(e.getJSON())

    const [, second, third] = blockPositions(e)
    drawGaps(e, [second, third])
    expect(e.view.dom.querySelectorAll('.page-gap')).toHaveLength(2) // drawn
    drawGaps(e, [third]) // re-drawn
    drawGaps(e, []) // and removed

    expect(updates).toHaveLength(0)
    expect(JSON.stringify(e.getJSON())).toBe(json)
    expect(e.state.selection.from).toBe(6)
    expect(e.view.dom.querySelectorAll('.page-gap')).toHaveLength(0)
  })

  it('keeps gaps on their blocks through remote edits (y-tiptap replaces each changed block)', () => {
    const { a, b } = linked()
    const ea = paginatedEditor(a)
    const eb = new Editor({ extensions: collabExtensions(b) })
    editors.push(eb)
    eb.commands.insertContent('<p>One</p><p>Two</p><p>Three</p><p>Four</p>')
    const [, p2, p3, p4] = blockPositions(ea)
    drawGaps(ea, [p2, p4])

    // A remote edit between the gaps: the first stays, the second moves with its block.
    eb.commands.insertContentAt(blockPositions(eb)[2] + 1, 'abc')
    expect(ea.state.doc.child(2).textContent).toBe('abcThree')
    expect(gapsAt(ea)).toEqual([p2, p4 + 3])
    expect(ea.view.dom.querySelectorAll('.page-gap')).toHaveLength(2) // still drawn, no flicker

    // A remote edit before both: both move.
    eb.commands.insertContentAt(1, 'xy')
    expect(gapsAt(ea)).toEqual([p2 + 2, p4 + 5])
    expect(blockPositions(ea)).toEqual(expect.arrayContaining([p2 + 2, p4 + 5]))
    expect(ea.view.dom.querySelectorAll('.page-gap')).toHaveLength(2)

    // An edit in the block a gap belongs to: that gap and the ones after it
    // are dropped (the next layout pass redraws them).
    eb.commands.insertContentAt(blockPositions(eb)[1] + 1, 'q')
    expect(gapsAt(ea)).toEqual([])
    expect(p3).toBeGreaterThan(p2)
  })

  it('keeps gaps through a whole-document replacement (y-tiptap’s fallback) by mapping what changed', () => {
    const e = paginatedEditor(new Y.Doc())
    e.commands.insertContent('<p>One</p><p>Two</p><p>Three</p><p>Four</p>')
    const [, p2, , p4] = blockPositions(e)
    drawGaps(e, [p2, p4])
    // The same document with "Three" edited, replacing everything (0 to the end).
    const blocks: ReturnType<typeof e.state.doc.child>[] = []
    e.state.doc.forEach((n, _o, i) => blocks.push(i === 2 ? e.schema.nodes.paragraph.create(null, e.schema.text('Three!!')) : n))
    e.view.dispatch(e.state.tr.replace(0, e.state.doc.content.size, new Slice(Fragment.from(blocks), 0, 0)))
    expect(e.state.doc.child(2).textContent).toBe('Three!!')
    expect(gapsAt(e)).toEqual([p2, p4 + 2])
    expect(e.view.dom.querySelectorAll('.page-gap')).toHaveLength(2)
  })

  it('drops a gap whose block was deleted, and every gap after it (they are re-laid out)', () => {
    const doc = new Y.Doc()
    const e = paginatedEditor(doc)
    e.commands.insertContent('<p>One</p><p>Two</p><p>Three</p><p>Four</p>')
    const [, p2, p3, p4] = blockPositions(e)
    drawGaps(e, [p2, p3, p4])
    // Delete "One" and "Two" with the boundary between them (the gap before "Two" goes).
    e.commands.deleteRange({ from: 1, to: p3 - 1 })
    expect(gapsAt(e)).toEqual([])
  })
})
