// @vitest-environment jsdom
// The command palette: the shortcut (and only that shortcut), real document
// search, keyboard selection, and honest loading/error/no-match states.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DocumentMeta } from '../api'
import { CommandPalette, isPaletteShortcut, matchDocuments } from './CommandPalette'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  ...mods,
})
const doc = (id: string, title: string, updated: string): DocumentMeta => ({
  id,
  title,
  role: 'owner',
  owner_id: 'x',
  created_at: updated,
  updated_at: updated,
})

describe('isPaletteShortcut', () => {
  it('is Cmd+K on macOS, and leaves Ctrl+K (delete to end of line) alone', () => {
    expect(isPaletteShortcut(key('k', { metaKey: true }), true)).toBe(true)
    expect(isPaletteShortcut(key('K', { metaKey: true }), true)).toBe(true) // caps lock
    expect(isPaletteShortcut(key('k', { ctrlKey: true }), true)).toBe(false)
  })

  it('is Ctrl+K elsewhere', () => {
    expect(isPaletteShortcut(key('k', { ctrlKey: true }), false)).toBe(true)
    expect(isPaletteShortcut(key('k', { metaKey: true }), false)).toBe(false)
  })

  it('ignores plain typing, other modifiers and IME composition', () => {
    for (const mac of [true, false]) {
      expect(isPaletteShortcut(key('k'), mac)).toBe(false)
      expect(isPaletteShortcut(key('k', { metaKey: true, ctrlKey: true }), mac)).toBe(false)
      expect(isPaletteShortcut(key('k', { metaKey: mac, ctrlKey: !mac, shiftKey: true }), mac)).toBe(false)
      expect(isPaletteShortcut(key('k', { metaKey: mac, ctrlKey: !mac, altKey: true }), mac)).toBe(false)
      expect(isPaletteShortcut(key('k', { metaKey: mac, ctrlKey: !mac, isComposing: true }), mac)).toBe(false)
      expect(isPaletteShortcut(key('j', { metaKey: mac, ctrlKey: !mac }), mac)).toBe(false)
    }
  })
})

describe('matchDocuments', () => {
  const docs = [
    doc('1', 'Roadmap Q4', '2026-10-01T00:00:00Z'),
    doc('2', 'Launch plan', '2026-10-20T00:00:00Z'),
    doc('3', 'Plan for the launch party', '2026-10-25T00:00:00Z'),
    doc('4', 'Notes', '2026-10-27T00:00:00Z'),
  ]
  it('without a query, lists the most recently updated', () => {
    expect(matchDocuments(docs, '', 3).map((d) => d.id)).toEqual(['4', '3', '2'])
  })
  it('matches every word, case-insensitively, prefix matches first', () => {
    expect(matchDocuments(docs, 'PLAN').map((d) => d.id)).toEqual(['3', '2']) // "Plan for…" starts with it
    expect(matchDocuments(docs, 'launch plan').map((d) => d.id)).toEqual(['2', '3'])
    expect(matchDocuments(docs, 'zebra')).toEqual([])
  })
})

let container: HTMLDivElement
let root: Root
let listing: () => Promise<Response>
const onClose = vi.fn()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]')!
const options = () => [...container.querySelectorAll('[role="option"]')].map((o) => o.querySelector('.palette-label')!.textContent)
const activeLabel = () => document.getElementById(input().getAttribute('aria-activedescendant')!)?.querySelector('.palette-label')?.textContent
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  onClose.mockClear()
  location.hash = '#/'
  listing = async () => json(200, { documents: [doc('a1', 'Launch plan', '2026-10-20T00:00:00Z'), doc('b2', 'Q4 roadmap', '2026-10-27T00:00:00Z')] })
  vi.stubGlobal('fetch', vi.fn(() => listing()))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function openPalette() {
  await act(async () => root.render(<CommandPalette open onClose={onClose} />))
  await act(async () => sleep(10))
}
function typeQuery(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (k: string) => act(() => input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })))

describe('CommandPalette', () => {
  it('is a labelled dialog with a combobox, focused, listing real documents then pages', async () => {
    await openPalette()
    expect(container.querySelector('dialog')?.getAttribute('aria-label')).toBe('Command palette')
    expect(document.activeElement).toBe(input())
    expect(input().getAttribute('aria-controls')).toBe(container.querySelector('[role="listbox"]')!.id)
    expect(options()).toEqual(['Q4 roadmap', 'Launch plan', 'Overview', 'Workspaces', 'Goals', 'Teams', 'Settings'])
    expect(vi.mocked(fetch)).toHaveBeenCalledWith('/api/documents', expect.anything())
  })

  it('filters as you type and moves the selection with the arrow keys (wrapping)', async () => {
    await openPalette()
    typeQuery('launch')
    expect(options()).toEqual(['Launch plan'])
    expect(activeLabel()).toBe('Launch plan')
    typeQuery('go')
    expect(options()).toEqual(['Goals']) // pages match too
    typeQuery('')
    press('ArrowDown')
    expect(activeLabel()).toBe('Launch plan')
    press('ArrowUp')
    press('ArrowUp')
    expect(activeLabel()).toBe('Settings') // wrapped to the end
  })

  it('keeps the selected item when documents arrive after the pages', async () => {
    let deliver!: (r: Response) => void
    listing = () => new Promise((resolve) => (deliver = resolve))
    await openPalette()
    press('ArrowUp') // pages only so far: wraps to Settings
    press('ArrowUp')
    expect(activeLabel()).toBe('Teams')
    await act(async () => {
      deliver(json(200, { documents: [doc('a1', 'Launch plan', '2026-10-20T00:00:00Z')] }))
      await sleep(10)
    })
    expect(options()[0]).toBe('Launch plan') // documents are listed first…
    expect(activeLabel()).toBe('Teams') // …and the selection didn't move
  })

  it('Enter opens the selection and closes the palette', async () => {
    await openPalette()
    typeQuery('roadmap')
    press('Enter')
    expect(onClose).toHaveBeenCalled()
    expect(location.hash).toBe('#/d/b2')
  })

  it('says when nothing matches, and never invents results', async () => {
    await openPalette()
    typeQuery('zebra')
    expect(options()).toEqual([])
    expect(container.querySelector('.palette-note')?.textContent).toBe('No documents match “zebra”.')
    press('Enter') // nothing to open
    expect(onClose).not.toHaveBeenCalled()
  })

  it('shows loading, then an error that still leaves pages usable', async () => {
    let fail!: (r: Response) => void
    listing = () => new Promise((resolve) => (fail = resolve))
    await openPalette()
    expect(container.querySelector('.palette-note')?.textContent).toBe('Loading documents…')
    expect(options()).toEqual(['Overview', 'Workspaces', 'Goals', 'Teams', 'Settings'])
    await act(async () => {
      fail(json(500, { error: 'database unavailable' }))
      await sleep(10)
    })
    expect(container.querySelector('.palette-note')?.textContent).toBe("Couldn't load documents. Pages are still available.")
    expect(options()).toContain('Goals')
  })
})
