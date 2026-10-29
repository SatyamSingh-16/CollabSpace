// @vitest-environment jsdom
// Page-level tests for unsaved edits (Week 5 review R1, R5): the real App,
// Tiptap and provider, with a FakeSocket for WebSocket and a stubbed fetch.
// Adapted from the reviewer's reproduction, which showed the edits lost.
import type { Editor } from '@tiptap/core'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { FakeSocket } from './collab/testing'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DOC_ID = '11111111-2222-3333-4444-555555555555'
const alice = { id: 'u-1', email: 'a@example.test', display_name: 'Alice' }
const docMeta = { id: DOC_ID, title: 'Plan', owner_id: 'u-1', role: 'editor', created_at: '', updated_at: '' }

let signedIn = true
let loggedOut = 0
let container: HTMLDivElement
let root: Root
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const text = () => container.textContent ?? ''
const tiptap = () => container.querySelector('.tiptap') as (HTMLElement & { editor: Editor }) | null

beforeEach(() => {
  signedIn = true
  loggedOut = 0
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const m = init?.method ?? 'GET'
      if (path === '/api/auth/me') return signedIn ? json(200, { user: alice }) : json(401, { error: 'unauthenticated' })
      if (path === '/api/auth/logout') {
        loggedOut++
        signedIn = false
        return json(204, null)
      }
      if (path === '/api/auth/login') {
        signedIn = true
        return json(200, { user: alice })
      }
      if (!signedIn) return json(401, { error: 'unauthenticated' })
      if (path === `/api/documents/${DOC_ID}` && m === 'GET') return json(200, { document: docMeta })
      if (path === `/api/documents/${DOC_ID}/members`) return json(200, { members: [] })
      if (path === '/api/documents') return json(200, { documents: [docMeta] })
      return json(404, { error: 'not found' })
    }),
  )
  location.hash = `#/d/${DOC_ID}`
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function openSyncedEditor(): Promise<{ editor: Editor; socket: FakeSocket }> {
  await act(async () => root.render(<App />))
  await act(async () => sleep(20))
  const socket = FakeSocket.latest()
  await act(async () => {
    socket.open()
    socket.deliver({ type: 'joined', head_seq: 0, role: 'editor', conn_id: 'c1' })
    socket.deliver({ type: 'synced', seq: 0 })
  })
  const editor = tiptap()!.editor
  expect(editor.isEditable).toBe(true)
  return { editor, socket }
}

// Types into a React-controlled input (React tracks the native value setter).
function typeInto(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function typeUnsaved(editor: Editor, words: string) {
  await act(async () => {
    editor.commands.insertContent(words)
    await sleep(80) // past the batch window: sent, never acknowledged
  })
}

describe('unsaved edits survive the session ending (R1)', () => {
  it('keeps the editor, asks to sign in again, then resends the same edit', async () => {
    const { editor, socket } = await openSyncedEditor()
    await typeUnsaved(editor, 'IMPORTANT UNSAVED PARAGRAPH')
    const [sent] = socket.updates()
    expect(sent).toBeDefined()

    signedIn = false
    await act(async () => {
      socket.serverClose(4001, 'session expired')
      await sleep(50)
    })
    expect(text()).toContain('Your session ended. Sign in again as a@example.test to save your unsaved changes.')
    expect(tiptap()?.textContent).toContain('IMPORTANT UNSAVED PARAGRAPH') // still on screen
    expect(tiptap()!.editor.isEditable).toBe(false)

    // The email is filled in for the same account; type the password.
    const reauth = container.querySelector('.reauth form')!
    expect((reauth.querySelector('#auth-email') as HTMLInputElement).value).toBe('a@example.test')
    await act(async () => typeInto(reauth.querySelector('input[autocomplete="current-password"]')!, 'secret-pass'))
    await act(async () => {
      reauth.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await sleep(50)
    })
    expect(text()).not.toContain('Your session ended')
    const s2 = FakeSocket.latest()
    expect(s2).not.toBe(socket)
    await act(async () => {
      s2.open()
      s2.deliver({ type: 'joined', head_seq: 0, role: 'editor', conn_id: 'c2' })
      s2.deliver({ type: 'synced', seq: 0 })
    })
    expect(s2.updates()).toEqual([sent]) // same id and bytes: deduplicated if it had been saved
    await act(async () => s2.deliver({ type: 'committed', client_msg_id: sent.client_msg_id, seq: 1 }))
    expect(text()).toContain('Connected · Saved')
  })

  it('with nothing unsaved, shows the sign-in screen and says why', async () => {
    const { socket } = await openSyncedEditor()
    signedIn = false
    await act(async () => {
      socket.serverClose(4001, 'session expired')
      await sleep(50)
    })
    expect(tiptap()).toBeNull()
    expect(text()).toContain('Your session ended. Please sign in again.')
  })

  it('Sign out asks first when there are unsaved edits', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const { editor, socket } = await openSyncedEditor()
    await act(async () => socket.serverClose(1006)) // offline
    await typeUnsaved(editor, 'offline words')
    // Sign out is a button in the sidebar's profile row.
    const signOut = async () => {
      const button = container.querySelector<HTMLButtonElement>('.sidebar button[aria-label="Sign out"]')
      expect(button).not.toBeNull()
      await act(async () => {
        button!.click()
        await sleep(30)
      })
    }

    await signOut()
    expect(confirm).toHaveBeenCalledOnce()
    expect(loggedOut).toBe(0) // cancelled: nothing happened
    expect(tiptap()?.textContent).toContain('offline words')

    confirm.mockReturnValue(true)
    await signOut()
    await act(async () => sleep(30))
    expect(loggedOut).toBe(1)
  })
})

describe('in-app navigation with unsaved edits (R5)', () => {
  it('asks before leaving; "cancel" keeps the editor and the URL', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    const { editor, socket } = await openSyncedEditor()
    await act(async () => socket.serverClose(1006))
    await typeUnsaved(editor, 'typed while offline')

    await act(async () => {
      location.hash = '#/'
      await sleep(30)
    })
    expect(confirm).toHaveBeenCalledOnce()
    expect(tiptap()?.textContent).toContain('typed while offline')
    expect(location.hash).toBe(`#/d/${DOC_ID}`)

    confirm.mockReturnValue(true)
    await act(async () => {
      location.hash = '#/'
      await sleep(30)
    })
    expect(tiptap()).toBeNull()
  })

  it('does not ask when everything is saved', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    await openSyncedEditor()
    await act(async () => {
      location.hash = '#/'
      await sleep(30)
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(tiptap()).toBeNull()
  })
})

describe('save status', () => {
  it('says "Saving…" until the server confirms, and only then "Saved"', async () => {
    const { editor, socket } = await openSyncedEditor()
    expect(text()).toContain('Connected · Saved') // nothing pending yet
    await typeUnsaved(editor, 'pending text')
    expect(text()).toContain('Connected · Saving…')
    expect(text()).not.toContain('Connected · Saved')
    const [sent] = socket.updates()
    await act(async () => socket.deliver({ type: 'committed', client_msg_id: sent.client_msg_id, seq: 1 }))
    expect(text()).toContain('Connected · Saved')
  })
})

// The blank page: pressing Enter left an empty paragraph, which made every
// re-render rewrite the Y.Doc (via useEditor's setOptions), which re-rendered
// again: "Maximum update depth exceeded", and React unmounted the whole app.
describe('pressing Enter in the editor', () => {
  it('creates paragraphs without blanking the page or flooding the server', async () => {
    const errors: unknown[] = []
    const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message)
    window.addEventListener('error', onError)
    const { editor, socket } = await openSyncedEditor()
    await act(async () => {
      editor.commands.insertContent('hello')
      editor.commands.enter()
      await sleep(80)
    })
    await act(async () => {
      editor.commands.enter()
      editor.commands.enter()
      editor.commands.insertContent('third')
      await sleep(200)
    })
    window.removeEventListener('error', onError)

    expect(errors).toEqual([])
    expect(tiptap()).not.toBeNull() // the app is still mounted
    expect(text()).toContain('CollabSpace')
    expect(editor.getJSON().content?.length).toBe(4) // hello, 2 empty paragraphs, third
    expect(tiptap()!.textContent).toContain('third')
    // A few batched messages, not an endless stream of rewrites.
    expect(socket.updates().length).toBeLessThanOrEqual(3)
  })
})
