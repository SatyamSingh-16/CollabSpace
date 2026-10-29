// @vitest-environment jsdom
// The status pill never says "Saved" while anything is pending, and tells a
// first connection apart from a reconnect.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProviderState } from '../collab/provider'
import { StatusPill } from './StatusPill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const base: ProviderState = {
  status: 'connected',
  synced: true,
  saved: true,
  appliedSeq: 3,
  pendingCount: 0,
  error: null,
  role: 'editor',
  closeCode: null,
  discardedEdits: 0,
  participants: [],
  diverged: false,
} as ProviderState

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function pill(patch: Partial<ProviderState>) {
  act(() => root.render(<StatusPill state={{ ...base, ...patch }} readOnly={false} />))
  const el = container.querySelector('[role="status"]')!
  return { text: el.textContent, title: el.getAttribute('title'), tone: el.className }
}

describe('StatusPill', () => {
  it('first connection: Connecting, then Syncing', () => {
    expect(pill({ status: 'connecting', synced: false }).text).toBe('Connecting…')
    expect(pill({ status: 'syncing', synced: false }).text).toBe('Syncing…')
  })

  it('after a drop: Reconnecting, saying when changes are still unsaved', () => {
    expect(pill({ status: 'connecting' }).text).toBe('Reconnecting…')
    const unsaved = pill({ status: 'syncing', saved: false, pendingCount: 2 })
    expect(unsaved.text).toBe('Reconnecting · unsaved changes')
    expect(unsaved.tone).toContain('status-warn')
    expect(unsaved.title).toContain('sent when the connection is back')
  })

  it('"Saved" only when nothing is pending', () => {
    expect(pill({}).text).toBe('Connected · Saved')
    expect(pill({}).title).toBe('All your changes are saved on the server.')
    expect(pill({ saved: false, pendingCount: 1 }).text).toBe('Connected · Saving…')
  })

  it('a terminal error does not promise that edits will be resent', () => {
    const err = pill({ status: 'error', saved: false, error: 'access removed' })
    expect(err.text).toBe('Error · access removed')
    expect(err.title).not.toContain('sent when')
  })
})
