// @vitest-environment jsdom
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

import { fromBase64 } from './base64'
import { bindEditable, collabExtensions, EDITOR_FIELD } from './editor'
import { CollabProvider } from './provider'
import { FakeSocket, updateMsg } from './testing'

// Tiptap's own Yjs content, produced by a second editor, to replay as
// "history from the server".
function historyFromAnotherEditor(text: string): Uint8Array[] {
  const doc = new Y.Doc()
  const out: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => out.push(u))
  const editor = new Editor({ element: document.createElement('div'), extensions: collabExtensions(doc) })
  editor.commands.insertContent(text)
  editor.destroy()
  return out
}

let editors: Editor[] = []
function setup() {
  const doc = new Y.Doc()
  const docUpdates: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => docUpdates.push(u))
  const provider = new CollabProvider({
    url: 'ws://test/x',
    doc,
    createSocket: FakeSocket.factory,
    batchMs: 10,
    random: () => 0.5,
  })
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: collabExtensions(doc),
    editable: false,
  })
  editors.push(editor)
  bindEditable(editor, provider)
  return { doc, provider, editor, docUpdates, socket: FakeSocket.latest() }
}

beforeEach(() => {
  FakeSocket.instances = []
  editors = []
  vi.useFakeTimers()
})
afterEach(() => {
  editors.forEach((e) => e.destroy())
  vi.useRealTimers()
})

describe('collaborative editor', () => {
  it('stays read-only until the initial sync completes', () => {
    const { editor, socket } = setup()
    expect(editor.isEditable).toBe(false)
    socket.open()
    socket.deliver({ type: 'joined', head_seq: 0, role: 'editor', conn_id: 'c' })
    expect(editor.isEditable).toBe(false)
    socket.deliver({ type: 'synced', seq: 0 })
    expect(editor.isEditable).toBe(true)

    // A later disconnect keeps editing possible (edits queue as pending).
    socket.serverClose(1006)
    expect(editor.isEditable).toBe(true)
  })

  it('creating the editor writes nothing into the Y.Doc (no seeded content)', () => {
    const { docUpdates } = setup()
    vi.advanceTimersByTime(100)
    expect(docUpdates).toHaveLength(0)
  })

  it('renders replayed history and sends the user’s typing as an update', () => {
    const { editor, socket, doc } = setup()
    const history = historyFromAnotherEditor('Hello from history')
    socket.open()
    socket.deliver({ type: 'joined', head_seq: history.length, role: 'editor', conn_id: 'c' })
    history.forEach((u, i) => socket.deliver(updateMsg(i + 1, u)))
    socket.deliver({ type: 'synced', seq: history.length })
    expect(editor.getText()).toBe('Hello from history')

    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' and me')
    vi.advanceTimersByTime(10)
    const sent = socket.updates()
    expect(sent).toHaveLength(1)

    // Applying exactly the stored history + the sent update to a fresh doc
    // reproduces the editor's content: what we send is what others will see.
    const check = new Y.Doc()
    for (const u of history) Y.applyUpdate(check, u)
    Y.applyUpdate(check, fromBase64(sent[0].data))
    const fresh = new Editor({ element: document.createElement('div'), extensions: collabExtensions(check) })
    editors.push(fresh)
    expect(fresh.getText()).toBe('Hello from history and me')
    expect(check.getXmlFragment(EDITOR_FIELD).toString()).toBe(doc.getXmlFragment(EDITOR_FIELD).toString())
  })
})

// Week 5 review R12: a click on a link in an editable editor used to call
// window.open(href, '_blank') without noopener (Tiptap's click handler).
describe('links', () => {
  it('a click on a link does not open it', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const el = document.createElement('div')
    document.body.append(el)
    const editor = new Editor({ element: el, extensions: collabExtensions(new Y.Doc()) })
    editor.commands.insertContent({
      type: 'paragraph',
      content: [{ type: 'text', text: 'click me', marks: [{ type: 'link', attrs: { href: 'https://evil.example/' } }] }],
    })
    const a = el.querySelector('a')!
    // Every ProseMirror handleClick prop, as a real click would run them.
    const ev = new MouseEvent('click', { button: 0 })
    Object.defineProperty(ev, 'target', { value: a })
    for (const plugin of editor.state.plugins) plugin.props.handleClick?.call(plugin, editor.view, 3, ev)
    expect(open).not.toHaveBeenCalled()
    editor.destroy()
    el.remove()
    open.mockRestore()
  })
})
