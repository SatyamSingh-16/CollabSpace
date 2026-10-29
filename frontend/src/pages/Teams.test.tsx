// @vitest-environment jsdom
// Teams = shared documents seen as teams, from the real API: the document
// list and, for documents you own, the owner-only member list. Nothing is
// invented: counts, leaders and roles come from those responses.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { parseRoute } from '../router'
import { Teams } from './Teams'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const doc = (id: string, title: string, role: string, updated = '2026-10-01T00:00:00Z') => ({
  id,
  title,
  owner_id: role === 'owner' ? 'u-me' : 'u-other',
  role,
  created_at: updated,
  updated_at: updated,
})
const member = (user_id: string, display_name: string, role: string) => ({
  user_id,
  display_name,
  email: `${display_name.toLowerCase()}@example.test`,
  role,
})
const me = member('u-me', 'Me', 'owner')

let container: HTMLDivElement
let root: Root
let routes: Record<string, () => Response | Promise<Response>>
const text = () => container.textContent ?? ''
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const requested = () => vi.mocked(fetch).mock.calls.map((c) => c[0])
const cards = (section: 'Teams you lead' | "Teams you're in") =>
  [...container.querySelectorAll<HTMLElement>(`ul[aria-labelledby="${section === 'Teams you lead' ? 'led-heading' : 'in-heading'}"] > li`)]
const button = (name: string | RegExp, scope: ParentNode = container) =>
  [...scope.querySelectorAll<HTMLElement>('button, a')].find((b) =>
    typeof name === 'string' ? (b.getAttribute('aria-label') ?? b.textContent) === name : name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''),
  )!
const dialog = () => container.querySelector('dialog')!

function reducedMotion(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }))
}

beforeEach(() => {
  routes = {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => (routes[path] ? routes[path]() : json(404, { error: 'not found' }))),
  )
  reducedMotion(true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => root.render(<Teams userId="u-me" handle={(e) => (e instanceof Error ? e.message : 'failed')} />))
  await act(async () => sleep(10))
}

describe('Teams: document teams from real memberships', () => {
  it('an owner and one member: a team you lead, with its leader, count and role', async () => {
    routes['/api/documents'] = () => json(200, { documents: [doc('d1', 'Test_1', 'owner')] })
    routes['/api/documents/d1/members'] = () => json(200, { members: [me, member('u-b', 'Bob', 'editor')] })
    await render()
    const [card] = cards('Teams you lead')
    expect(card.querySelector('h3')?.textContent).toBe('Test_1')
    expect(card.querySelector('.team-meta')?.textContent).toBe('2 members') // the owner counts
    const leader = card.querySelector('.team-leader')!
    expect(leader.textContent).toContain('Me (you)')
    expect(leader.querySelector('.badge')?.textContent).toBe('Team leader')
    const preview = [...card.querySelectorAll('.team-preview > li')]
    expect(preview.map((li) => li.querySelector('.team-person-name')?.textContent)).toEqual(['Bob']) // the owner isn't repeated
    expect(preview[0].querySelector('.badge')?.textContent).toBe('Editor')
    expect(card.querySelector('.team-more')).toBeNull()
    expect(card.textContent).not.toContain('@example.test') // no emails on cards
    expect(button('Open document Test_1', card).getAttribute('href')).toBe('#/d/d1')
    expect(text()).toContain('1 team you lead · 1 person on them · 0 teams you\'re in')
    expect(text()).not.toContain('No teams yet') // the old placeholder is gone
  })

  it('more than three members: three in the preview, the rest as +N, the count exact', async () => {
    routes['/api/documents'] = () => json(200, { documents: [doc('d1', 'Big team', 'owner')] })
    routes['/api/documents/d1/members'] = () =>
      json(200, {
        members: [
          me,
          member('u-a', 'Ana', 'editor'),
          member('u-b', 'Bob', 'viewer'),
          member('u-c', 'Cy', 'editor'),
          member('u-d', 'Dee', 'viewer'),
          member('u-e', 'Eve', 'editor'),
        ],
      })
    await render()
    const [card] = cards('Teams you lead')
    expect(card.querySelector('.team-meta')?.textContent).toBe('6 members')
    expect([...card.querySelectorAll('.team-preview .badge')].map((b) => b.textContent)).toEqual(['Editor', 'Viewer', 'Editor'])
    expect(card.querySelector('.team-more')?.textContent).toBe('+2')
    expect(card.querySelector('.team-more')?.getAttribute('aria-label')).toBe('and 2 more')
  })

  it('documents with no other members are not teams; overlapping members are counted once', async () => {
    routes['/api/documents'] = () =>
      json(200, {
        documents: [doc('d1', 'Plan', 'owner', '2026-10-03T00:00:00Z'), doc('d2', 'Notes', 'owner', '2026-10-02T00:00:00Z'), doc('d3', 'Solo', 'owner')],
      })
    routes['/api/documents/d1/members'] = () => json(200, { members: [me, member('u-b', 'Bob', 'editor'), member('u-a', 'Ana', 'viewer')] })
    routes['/api/documents/d2/members'] = () => json(200, { members: [me, member('u-b', 'Bob', 'viewer')] })
    routes['/api/documents/d3/members'] = () => json(200, { members: [me] })
    await render()
    expect(cards('Teams you lead').map((c) => c.querySelector('h3')?.textContent)).toEqual(['Plan', 'Notes']) // most recent first, one card each
    // Bob is on both teams, with a different role on each.
    expect(cards('Teams you lead')[1].querySelector('.team-preview .badge')?.textContent).toBe('Viewer')
    expect(text()).toContain('2 teams you lead · 2 people on them')
    expect(text()).toContain("1 document you own is not shared with anyone, so it isn't a team yet.")
  })

  it('documents shared with you: your role only; their member lists are never requested', async () => {
    routes['/api/documents'] = () => json(200, { documents: [doc('d2', 'Roadmap', 'viewer'), doc('d4', 'Spec', 'editor')] })
    await render()
    const shared = cards("Teams you're in")
    expect(shared.map((c) => c.querySelector('h3')?.textContent)).toEqual(['Roadmap', 'Spec'])
    expect(shared[0].querySelector('.badge')?.textContent).toBe('You: Viewer')
    expect(shared[1].querySelector('.badge')?.textContent).toBe('You: Editor')
    expect(shared[0].textContent).toContain('Only the team leader can see who else is on this team.')
    expect(shared[0].textContent).not.toMatch(/View all members|members/)
    expect(requested()).not.toContain('/api/documents/d2/members')
    expect(requested()).not.toContain('/api/documents/d4/members')
    expect(cards('Teams you lead')).toHaveLength(0)
  })

  it('loading, then empty: skeletons while fetching, then a clear empty state', async () => {
    let release!: (r: Response) => void
    routes['/api/documents'] = () => new Promise<Response>((r) => (release = r))
    await act(async () => root.render(<Teams userId="u-me" handle={() => 'failed'} />))
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.querySelectorAll('.team-skeleton')).toHaveLength(3)
    await act(async () => {
      release(json(200, { documents: [] }))
      await sleep(10)
    })
    expect(container.querySelector('[aria-busy="true"]')).toBeNull()
    expect(text()).toContain('No document teams yet')
    expect(button('Go to your documents').getAttribute('href')).toBe('#/workspaces')
  })

  it('errors: the page offers Retry; one document failing shows on its card; one gone since the list is dropped', async () => {
    routes['/api/documents'] = () => json(500, { error: 'database unavailable' })
    await render()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('database unavailable')

    routes['/api/documents'] = () => json(200, { documents: [doc('d1', 'Fine', 'owner'), doc('d2', 'Flaky', 'owner'), doc('d3', 'Deleted', 'owner')] })
    routes['/api/documents/d1/members'] = () => json(200, { members: [me, member('u-b', 'Bob', 'editor')] })
    routes['/api/documents/d2/members'] = () => json(500, { error: 'boom' })
    // d3: 404 (deleted after the list was read)
    await act(async () => {
      button('Retry').click()
      await sleep(10)
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    const led = cards('Teams you lead')
    expect(led.map((c) => c.querySelector('h3')?.textContent)).toEqual(['Fine', 'Flaky'])
    expect(led[1].classList).toContain('is-failed')
    expect(led[1].textContent).toContain("Members couldn't be loaded")
    expect(text()).not.toContain('Deleted')

    routes['/api/documents/d2/members'] = () => json(200, { members: [me, member('u-c', 'Cy', 'viewer')] })
    await act(async () => {
      button('Retry', led[1]).click()
      await sleep(10)
    })
    expect(cards('Teams you lead')[1].classList).not.toContain('is-failed')
    expect(cards('Teams you lead')[1].textContent).toContain('Cy')
  })

  it('refreshes when the tab becomes visible again, without going back to skeletons', async () => {
    routes['/api/documents'] = () => json(200, { documents: [doc('d1', 'Test_1', 'owner')] })
    routes['/api/documents/d1/members'] = () => json(200, { members: [me, member('u-b', 'Bob', 'editor')] })
    await render()
    routes['/api/documents/d1/members'] = () => json(200, { members: [me, member('u-b', 'Bob', 'editor'), member('u-c', 'Cy', 'viewer')] })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(container.querySelector('.team-skeleton')).toBeNull() // the old data stays while fetching
      await sleep(10)
    })
    expect(cards('Teams you lead')[0].querySelector('.team-meta')?.textContent).toBe('3 members')
  })
})

describe('View all members', () => {
  const setUp = async () => {
    routes['/api/documents'] = () => json(200, { documents: [doc('d1', 'Test_1', 'owner')] })
    routes['/api/documents/d1/members'] = () =>
      json(200, { members: [me, member('u-a', 'Ana', 'editor'), member('u-b', 'Bob', 'viewer'), member('u-c', 'Cy', 'editor'), member('u-d', 'Dee', 'viewer')] })
    await render()
    const opener = button('View all members of Test_1')
    opener.focus()
    await act(async () => {
      opener.click()
      await sleep(30)
    })
    return opener
  }

  it('opens with the whole list, the leader first and marked, focus on Close, and Manage access to the Share panel', async () => {
    await setUp()
    const d = dialog()
    expect(d.open).toBe(true)
    expect(d.classList).toContain('is-open')
    expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Test_1')
    expect(d.textContent).toContain('5 members · Led by you')
    const rows = [...d.querySelectorAll('.member-row')]
    expect(rows.map((r) => r.querySelector('.member-name')?.textContent)).toEqual(['Me (you)', 'Ana', 'Bob', 'Cy', 'Dee'])
    expect(rows[0].classList).toContain('is-leader')
    expect(rows.map((r) => r.querySelector('.badge')?.textContent)).toEqual(['Team leader', 'Editor', 'Viewer', 'Editor', 'Viewer'])
    expect(document.activeElement).toBe(button('Close', d))
    expect(button('Manage access', d).getAttribute('href')).toBe('#/d/d1/share')
    expect(parseRoute('#/d/' + 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12) + '/share')).toMatchObject({ page: 'doc', share: true })
  })

  it('Escape closes it and focus returns to the button that opened it', async () => {
    const opener = await setUp()
    await act(async () => {
      dialog().dispatchEvent(new Event('cancel', { cancelable: true })) // what the browser fires for Escape
      await sleep(10)
    })
    expect(dialog().open).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('the close button and the backdrop close it; a press inside does not', async () => {
    const opener = await setUp()
    const d = dialog()
    await act(async () => {
      d.querySelector('.member-row')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      d.dispatchEvent(new MouseEvent('click', { bubbles: true })) // released on the backdrop: not a backdrop click
      await sleep(10)
    })
    expect(d.open).toBe(true)
    await act(async () => {
      d.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      d.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await sleep(10)
    })
    expect(d.open).toBe(false)

    await act(async () => {
      opener.click()
      await sleep(30)
    })
    expect(d.open).toBe(true)
    await act(async () => {
      button('Close', d).click()
      await sleep(10)
    })
    expect(d.open).toBe(false)
    expect(document.activeElement).toBe(opener)
  })

  it('with motion, it fades out before the dialog closes (content kept during the fade)', async () => {
    reducedMotion(false)
    await setUp()
    const d = dialog()
    await act(async () => {
      button('Close', d).click()
      await sleep(10)
    })
    expect(d.classList).not.toContain('is-open') // fading
    expect(d.open).toBe(true)
    expect(d.textContent).toContain('Test_1')
    await act(async () => sleep(400)) // no transition runs in jsdom: the fallback closes it
    expect(d.open).toBe(false)
  })

  it('closes when its team disappears on a refresh', async () => {
    await setUp()
    routes['/api/documents/d1/members'] = () => json(200, { members: [me] }) // everyone removed: no longer a team
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      await sleep(20)
    })
    expect(dialog().open).toBe(false)
    expect(cards('Teams you lead')).toHaveLength(0)
  })
})
