// @vitest-environment jsdom
// Document rows: who may rename or delete (the server enforces the same
// rules), the online indicator, and the rename and delete flows.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentMeta, Role } from '../api'
import { DocumentRows, sortDocuments } from './Documents'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const doc = (id: string, title: string, role: Role, online = 0): DocumentMeta => ({
  id,
  title,
  role,
  online,
  owner_id: 'x',
  created_at: '2026-10-28T00:00:00Z',
  updated_at: '2026-10-28T00:00:00Z',
})
const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let container: HTMLDivElement
let root: Root
let requests: { method: string; path: string; body?: unknown }[]
let respond: (method: string, path: string) => Response
const onChanged = vi.fn()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const button = (name: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)

beforeEach(() => {
  requests = []
  onChanged.mockClear()
  respond = (method, path) => (method === 'PATCH' ? json(200, { document: doc(path.split('/').pop()!, 'x', 'owner') }) : json(204, null))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      requests.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return respond(method, path)
    }),
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function render(docs: DocumentMeta[]) {
  act(() => root.render(<DocumentRows docs={docs} label="Documents" handle={(e) => String(e)} onChanged={onChanged} />))
}

describe('DocumentRows', () => {
  it('offers Rename to owners and editors, Delete only to owners', () => {
    render([doc('a', 'Mine', 'owner'), doc('b', 'Edit', 'editor'), doc('c', 'View', 'viewer')])
    expect(button('Rename Mine')).not.toBeNull()
    expect(button('Delete Mine')).not.toBeNull()
    expect(button('Rename Edit')).not.toBeNull()
    expect(button('Delete Edit')).toBeNull()
    expect(button('Rename View')).toBeNull()
    expect(button('Delete View')).toBeNull()
  })

  it('shows how many people are online, and nothing when nobody is', () => {
    render([doc('a', 'Busy', 'owner', 3), doc('b', 'Quiet', 'owner', 0)])
    const rows = [...container.querySelectorAll('.doc-row')]
    expect(rows[0].querySelector('.online')?.textContent).toBe('3 online')
    expect(rows[1].querySelector('.online')).toBeNull()
  })

  it('renames inline: Enter saves the trimmed title; Escape cancels', async () => {
    render([doc('a', 'Old name', 'editor')])
    act(() => button('Rename Old name')!.click())
    const input = container.querySelector<HTMLInputElement>('.rename-form input')!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('Old name')

    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(container.querySelector('.rename-form')).toBeNull()
    expect(requests).toEqual([])

    act(() => button('Rename Old name')!.click())
    const again = container.querySelector<HTMLInputElement>('.rename-form input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(again, '  New name  ')
      again.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      again.form!.requestSubmit()
      await sleep(10)
    })
    expect(requests).toEqual([{ method: 'PATCH', path: '/api/documents/a', body: { title: 'New name' } }])
    expect(onChanged).toHaveBeenCalledWith('Renamed to “New name”.')
  })

  it('shows the server refusing a rename, and keeps the form open', async () => {
    respond = () => json(403, { error: 'only the owner and editors can rename this document' })
    render([doc('a', 'Doc', 'editor')])
    act(() => button('Rename Doc')!.click())
    const input = container.querySelector<HTMLInputElement>('.rename-form input')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Other')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      input.form!.requestSubmit()
      await sleep(10)
    })
    expect(container.querySelector('.rename-form [role="alert"]')?.textContent).toContain('only the owner and editors')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('deletes only after confirmation', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)
    render([doc('a', 'Plan', 'owner')])
    await act(async () => button('Delete Plan')!.click())
    expect(confirm).toHaveBeenCalledOnce()
    expect(String(confirm.mock.calls[0])).toContain('for everyone')
    expect(requests).toEqual([])

    confirm.mockReturnValue(true)
    await act(async () => {
      button('Delete Plan')!.click()
      await sleep(10)
    })
    expect(requests).toEqual([{ method: 'DELETE', path: '/api/documents/a', body: undefined }])
    expect(onChanged).toHaveBeenCalledWith('Deleted “Plan”.')
  })
})

describe('sortDocuments', () => {
  const at = (id: string, title: string, updated: string) => ({ ...doc(id, title, 'owner'), updated_at: updated })
  const docs = [at('1', 'doc 10', '2026-10-01T00:00:00Z'), at('2', 'Doc 2', '2026-10-03T00:00:00Z'), at('3', 'alpha', '2026-10-02T00:00:00Z')]
  it('sorts by most recently updated', () => {
    expect(sortDocuments(docs, 'updated').map((d) => d.id)).toEqual(['2', '3', '1'])
  })
  it('sorts by title, ignoring case, with numbers in natural order', () => {
    expect(sortDocuments(docs, 'title').map((d) => d.title)).toEqual(['alpha', 'Doc 2', 'doc 10'])
  })
  it('does not change the list it was given', () => {
    sortDocuments(docs, 'title')
    expect(docs.map((d) => d.id)).toEqual(['1', '2', '3'])
  })
})

