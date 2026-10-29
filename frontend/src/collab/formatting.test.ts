// @vitest-environment jsdom
// Typography marks, clear formatting, page breaks and the outline, on the
// real editor bound to real Y.Docs: formatting lives in the collaborative
// document (it syncs, persists and reloads), and an older client can't
// damage it.
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { collabExtensions, EDITOR_FIELD } from './editor'
import { MIXED, markValue, outlineOf } from './formatting'

const editors: Editor[] = []
afterEach(() => editors.splice(0).forEach((e) => e.destroy()))

function editorFor(doc: Y.Doc) {
  const e = new Editor({ extensions: collabExtensions(doc) })
  editors.push(e)
  return e
}
// Two docs that exchange every update, like two clients through the server.
function linked() {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(b, u, 'remote'))
  b.on('update', (u: Uint8Array, origin: unknown) => origin !== 'remote' && Y.applyUpdate(a, u, 'remote'))
  return { a, b }
}
// A "reload": a fresh Y.Doc from the persisted state.
function reload(doc: Y.Doc) {
  const fresh = new Y.Doc()
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc))
  return editorFor(fresh)
}
// The marks on the text node that contains `text` (neighbouring text with
// the same marks is one node).
const marksOf = (e: Editor, text: string) => {
  const found: { type: string; attrs?: Record<string, unknown> }[][] = []
  e.state.doc.descendants((n) => {
    if (n.isText && n.text!.includes(text)) found.push(n.marks.map((m) => ({ type: m.type.name, attrs: m.attrs })))
  })
  return found[0] ?? null
}

describe('font size, color and highlight', () => {
  it('formats exactly the selection, keeps the selection, and renders classes (no inline styles)', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent('Hello world')
    e.commands.setTextSelection({ from: 1, to: 6 })
    e.commands.setFontSize(18)
    e.commands.setTextColor('blue')
    e.commands.setHighlight('yellow')
    expect(e.state.selection.from).toBe(1)
    expect(e.state.selection.to).toBe(6)
    const marks = marksOf(e, 'Hello')!
    expect(marks).toEqual(
      expect.arrayContaining([
        { type: 'fontSize', attrs: { value: 18 } },
        { type: 'textColor', attrs: { value: 'blue' } },
        { type: 'highlight', attrs: { value: 'yellow' } },
      ]),
    )
    expect(marksOf(e, 'world')).toEqual([]) // the rest is untouched
    const html = e.getHTML()
    expect(html).toContain('class="fs-18"')
    expect(html).toContain('class="tc-blue"')
    expect(html).toContain('class="hl-yellow"')
    expect(html).not.toContain('style=')
  })

  it('16px is the default: choosing it removes the size instead of storing it', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent('Sized')
    e.commands.selectAll()
    e.commands.setFontSize(24)
    expect(marksOf(e, 'Sized')).toEqual([{ type: 'fontSize', attrs: { value: 24 } }])
    e.commands.setFontSize(16)
    expect(marksOf(e, 'Sized')).toEqual([])
  })

  it('with a bare cursor, formats what is typed next only', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent('Before ')
    e.commands.setFontSize(32)
    e.commands.setTextColor('red')
    e.commands.insertContent('after')
    expect(marksOf(e, 'Before ')).toEqual([])
    expect(marksOf(e, 'after')).toEqual(
      expect.arrayContaining([
        { type: 'fontSize', attrs: { value: 32 } },
        { type: 'textColor', attrs: { value: 'red' } },
      ]),
    )
  })

  it('ignores values outside the palette (pasted HTML, another build)', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent('<p><span data-font-size="99">big</span> <span data-color="purple">hue</span> <span data-font-size="24">ok</span></p>')
    expect(marksOf(e, 'big')).toEqual([])
    expect(marksOf(e, 'hue')).toEqual([])
    expect(marksOf(e, 'ok')).toEqual([{ type: 'fontSize', attrs: { value: 24 } }])
  })

  it('is stored in the Y.Doc: it survives a reload', () => {
    const doc = new Y.Doc()
    const e = editorFor(doc)
    e.commands.insertContent('Persist me')
    e.commands.selectAll()
    e.commands.setFontSize(24)
    e.commands.setTextColor('green')
    e.commands.setHighlight('blue')
    const again = reload(doc)
    expect(again.getJSON()).toEqual(e.getJSON())
    expect(marksOf(again, 'Persist me')).toHaveLength(3)
  })

  it('syncs to another client, and converges with concurrent edits', () => {
    const { a, b } = linked()
    const ea = editorFor(a)
    const eb = editorFor(b)
    ea.commands.insertContent('Shared text here')
    expect(eb.getText()).toBe('Shared text here')
    // A formats "Shared" while B types at the end, at the same time.
    ea.commands.setTextSelection({ from: 1, to: 7 })
    ea.commands.setHighlight('green')
    eb.commands.setTextSelection(eb.state.doc.content.size - 1)
    eb.commands.insertContent('!')
    expect(eb.getJSON()).toEqual(ea.getJSON())
    expect(marksOf(eb, 'Shared')).toEqual([{ type: 'highlight', attrs: { value: 'green' } }])
    expect(eb.getText()).toBe('Shared text here!')
  })
})

describe('clear formatting', () => {
  it('removes presentational marks only: headings, lists, code blocks and links stay', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent(
      '<h2>Title</h2><ul><li><p>item</p></li></ul><p><a href="https://example.test">link</a> plain</p><pre><code>code()</code></pre>',
    )
    e.commands.selectAll()
    e.chain().setBold().setItalic().setUnderline().setFontSize(24).setTextColor('red').setHighlight('yellow').run()
    e.commands.selectAll()
    e.commands.clearFormatting()
    const types = new Set<string>()
    const marks = new Set<string>()
    e.state.doc.descendants((n) => {
      types.add(n.type.name)
      n.marks.forEach((m) => marks.add(m.type.name))
    })
    expect([...marks]).toEqual(['link']) // only the link remains
    for (const t of ['heading', 'bulletList', 'listItem', 'codeBlock', 'paragraph']) expect(types.has(t)).toBe(true)
    expect(e.getText()).toContain('Title')
    expect(e.getText()).toContain('code()')
  })

  it('with a bare cursor, what is typed next is plain', () => {
    const e = editorFor(new Y.Doc())
    e.commands.setBold()
    e.commands.setFontSize(24)
    e.commands.clearFormatting()
    e.commands.insertContent('plain')
    expect(marksOf(e, 'plain')).toEqual([])
  })
})

describe('page breaks', () => {
  it('are a node in the Y.Doc, render as hr[data-page-break], and survive a reload', () => {
    const doc = new Y.Doc()
    const e = editorFor(doc)
    e.commands.insertContent('<p>Page one</p>')
    e.commands.insertPageBreak()
    e.commands.insertContent('<p>Page two</p>')
    expect(e.getHTML()).toContain('<hr data-page-break="" class="page-break">')
    expect(reload(doc).getJSON()).toEqual(e.getJSON())
    // A plain <hr> is still a horizontal rule, not a page break.
    e.commands.insertContent('<hr>')
    const types: string[] = []
    e.state.doc.descendants((n) => {
      types.push(n.type.name)
    })
    expect(types.filter((t) => t === 'pageBreak')).toHaveLength(1)
    expect(types).toContain('horizontalRule')
  })
})

describe('a client on the previous build', () => {
  it('cannot damage formatted content: it stops editing instead of rewriting the Y.Doc', () => {
    const { a, b } = linked()
    const current = editorFor(a)
    current.commands.insertContent('<h1>Kept</h1><p>formatted</p>')
    current.commands.setTextSelection({ from: 7, to: 16 })
    current.commands.setHighlight('yellow')
    current.commands.setTextSelection(current.state.doc.content.size - 1)
    current.commands.insertPageBreak()
    expect(marksOf(current, 'formatted')).toEqual([{ type: 'highlight', attrs: { value: 'yellow' } }])
    const before = Y.encodeStateVector(a)
    const shared = a.getXmlFragment(EDITOR_FIELD).toString()

    // The old schema has no highlight mark and no page break.
    const old = new Editor({ extensions: [StarterKit.configure({ undoRedo: false }), Collaboration.configure({ document: b, field: EDITOR_FIELD })] })
    editors.push(old)
    old.commands.insertContent('typed on the old build')
    old.commands.selectAll()
    old.commands.deleteSelection()

    expect(Y.encodeStateVector(a)).toEqual(before) // nothing written back
    expect(a.getXmlFragment(EDITOR_FIELD).toString()).toBe(shared)
    expect(current.getText()).toContain('formatted')
  })
})

describe('outlineOf', () => {
  it('lists H1–H3 and page breaks in order, and follows edits, deletes and moves', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent('<h1>Intro</h1><p>text</p><h2>Details</h2><h4>Too deep</h4><h3>Fine print</h3>')
    e.commands.insertPageBreak()
    const outline = () => outlineOf(e.state.doc).map((o) => (o.kind === 'heading' ? `${o.level}:${o.text}` : 'break'))
    expect(outline()).toEqual(['1:Intro', '2:Details', '3:Fine print', 'break'])

    // Edit a heading's text.
    const details = outlineOf(e.state.doc)[1]
    e.commands.insertContentAt(details.pos + 1, 'More ')
    expect(outline()).toEqual(['1:Intro', '2:More Details', '3:Fine print', 'break'])

    // Turn a heading into a paragraph (a delete, as far as the outline goes).
    e.commands.setTextSelection(outlineOf(e.state.doc)[2].pos + 1)
    e.commands.setParagraph()
    expect(outline()).toEqual(['1:Intro', '2:More Details', 'break'])

    // Move the H2 above the H1 (cut and paste).
    const h2 = outlineOf(e.state.doc)[1]
    const node = e.state.doc.nodeAt(h2.pos)!
    e.chain().deleteRange({ from: h2.pos, to: h2.pos + node.nodeSize }).insertContentAt(0, node.toJSON()).run()
    expect(outline()).toEqual(['2:More Details', '1:Intro', 'break'])
  })
})

describe('markValue: what the text style panel shows', () => {
  it('reads the cursor, stored marks, a uniform range and a mixed range from the document', () => {
    const e = editorFor(new Y.Doc())
    e.commands.insertContent('Hello world')
    e.commands.setTextSelection({ from: 7, to: 12 }) // "world"
    e.commands.setFontSize(24)
    e.commands.setTextColor('red')

    expect(markValue(e, 'fontSize')).toBe(24) // uniform range
    expect(markValue(e, 'textColor')).toBe('red')
    expect(markValue(e, 'highlight')).toBe(null)

    e.commands.setTextSelection({ from: 1, to: 12 }) // "Hello " (none) + "world" (24, red)
    expect(markValue(e, 'fontSize')).toBe(MIXED)
    expect(markValue(e, 'textColor')).toBe(MIXED)
    expect(markValue(e, 'highlight')).toBe(null) // none throughout: not mixed

    e.commands.setTextSelection(10) // a cursor inside "world"
    expect(markValue(e, 'fontSize')).toBe(24)
    e.commands.setTextSelection(3) // inside "Hello"
    expect(markValue(e, 'fontSize')).toBe(null)

    // A bare cursor: stored marks (for what is typed next) win.
    e.commands.setFontSize(32)
    e.commands.setHighlight('yellow')
    expect(markValue(e, 'fontSize')).toBe(32)
    expect(markValue(e, 'highlight')).toBe('yellow')
    e.commands.insertContent('X')
    expect(marksOf(e, 'X')).toEqual(
      expect.arrayContaining([
        { type: 'fontSize', attrs: { value: 32 } },
        { type: 'highlight', attrs: { value: 'yellow' } },
      ]),
    )
  })
})

