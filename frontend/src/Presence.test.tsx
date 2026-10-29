// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { Participant } from './collab/protocol'
import { orderParticipants, ParticipantList } from './Presence'

// React only flushes act() updates synchronously when told it's a test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const me: Participant = { user_id: 'u-me', display_name: 'Me Myself', role: 'editor' }
const zoe: Participant = { user_id: 'u-zoe', display_name: 'Zoe', role: 'editor' }
const ana: Participant = { user_id: 'u-ana', display_name: 'Ana', role: 'viewer' }

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

function render(participants: Participant[] | null) {
  act(() => root.render(<ParticipantList participants={participants} selfId={me.user_id} />))
  return [...container.querySelectorAll('li')].map((li) => li.textContent)
}

describe('ParticipantList', () => {
  it('renders nothing without a live connection (no stale list)', () => {
    expect(render(null)).toEqual([])
    expect(container.querySelector('ul')).toBeNull()
  })

  it('says when you are alone', () => {
    expect(render([me])).toEqual(['MYou', 'Only you here'])
  })

  it('lists you first, then others by name, marking viewers', () => {
    expect(render([zoe, me, ana])).toEqual(['MYou', 'AAna (viewing)', 'ZZoe'])
    expect(container.querySelector('ul')?.getAttribute('aria-label')).toBe('People in this document')
  })

  it('updates in place when a new list arrives', () => {
    render([me, zoe])
    expect(render([me])).toEqual(['MYou', 'Only you here'])
    expect(render([me, ana])).toEqual(['MYou', 'AAna (viewing)'])
  })

  it('counts who is online when others are here, including hidden ones', () => {
    const count = () => container.querySelector('.presence-count')?.textContent ?? null
    render([me])
    expect(count()).toBeNull() // "Only you here" says it already
    render([me, zoe, ana])
    expect(count()).toBe('3 online')
    const many = Array.from({ length: 8 }, (_, i) => ({ user_id: `u-${i}`, display_name: `User ${i}`, role: 'editor' }))
    render([me, ...many])
    expect(count()).toBe('9 online') // 5 avatars + "+4 more"
    render(null)
    expect(count()).toBeNull() // no live connection: no claim about who is online
  })

  it('the online count opens the full list with roles, and Escape closes it', () => {
    render([zoe, me, ana])
    const toggle = container.querySelector<HTMLButtonElement>('button.presence-count')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    act(() => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const rows = [...container.querySelectorAll('.presence-pop li')].map((li) => li.textContent)
    expect(rows).toEqual(['MMe Myself (you)Can edit', 'AAnaViewing', 'ZZoeCan edit'])
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(container.querySelector('.presence-pop')).toBeNull()
    expect(document.activeElement).toBe(toggle)
  })

  it('collapses long lists', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ user_id: `u-${i}`, display_name: `User ${i}`, role: 'editor' }))
    const items = render([me, ...many])
    expect(items).toHaveLength(6)
    expect(items.at(-1)).toBe('+4 more')
  })

  it('renders names as text, not markup', () => {
    const evil = { user_id: 'u-x', display_name: '<img src=x onerror=alert(1)>', role: 'editor' }
    render([me, evil])
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })
})

describe('orderParticipants', () => {
  it('keeps you first even when you are not first in the server order', () => {
    expect(orderParticipants([ana, zoe, me], me.user_id).map((p) => p.user_id)).toEqual(['u-me', 'u-ana', 'u-zoe'])
  })
})
