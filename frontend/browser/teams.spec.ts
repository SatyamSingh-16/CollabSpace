// Teams in real Chromium, from real sharing: shared documents shown as
// teams (owner = team leader), what members and outsiders can see, the full
// member list dialog (focus, Escape, backdrop, scrolling, Manage access),
// motion and reduced motion, and the phone layout.
// Needs PostgreSQL: COLLABSPACE_TEST_DATABASE_URL. Run: npx playwright test
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import { AppServer, buildServer, DATABASE_URL } from '../e2e/harness'

const BACKEND_PORT = 18080
const APP = 'http://localhost:15173'

test.skip(!DATABASE_URL, 'COLLABSPACE_TEST_DATABASE_URL not set')
test.describe.configure({ mode: 'serial' })

let server: AppServer

test.beforeAll(async () => {
  server = await AppServer.start(buildServer(), BACKEND_PORT, { ALLOWED_ORIGINS: APP })
})
test.afterAll(async () => {
  await server?.stop('SIGTERM')
})

interface User {
  name: string
  email: string
  context: BrowserContext
  page: Page
}

async function newUser(browser: Browser, name: string, opts: Parameters<Browser['newContext']>[0] = {}): Promise<User> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts })
  return { name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`, context, page: await context.newPage() }
}

async function register(u: User) {
  await u.page.goto('/')
  await u.page.getByRole('button', { name: 'Create one' }).click()
  await u.page.getByLabel('Name').fill(u.name)
  await u.page.getByLabel('Email').fill(u.email)
  await u.page.getByLabel('Password', { exact: true }).fill('password-123')
  await u.page.getByRole('button', { name: 'Create account' }).click()
  await expect(u.page.locator('#sidebar .profile-name')).toHaveText(u.name)
}

async function createDoc(u: User, title: string): Promise<string> {
  await u.page.goto('/#/workspaces')
  await u.page.getByPlaceholder('New document title').fill(title)
  await u.page.getByRole('button', { name: 'Create' }).click()
  await expect(u.page.getByRole('heading', { name: title })).toBeVisible()
  return u.page.url().split('#/d/')[1]
}

async function share(owner: User, member: User, role: 'editor' | 'viewer') {
  const toggle = owner.page.getByRole('button', { name: 'Share', exact: true })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await owner.page.getByLabel('Email address').fill(member.email)
  await owner.page.locator('form.share select').selectOption(role)
  await owner.page.getByRole('button', { name: 'Invite' }).click()
  await expect(owner.page.getByText(`Shared with ${member.email} as ${role}.`)).toBeVisible()
}

const teams = async (u: User) => {
  await u.page.goto('/#/teams')
  await expect(u.page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible()
  await expect(u.page.locator('[aria-busy="true"]')).toHaveCount(0)
}
const led = (u: User) => u.page.getByRole('list', { name: 'Teams you lead' })
const member = (u: User) => u.page.getByRole('list', { name: "Teams you're in" })
const card = (list: Locator, title: string) => list.getByRole('listitem').filter({ has: list.page().getByRole('heading', { level: 3, name: title, exact: true }) })

// One set of people and documents for the whole file:
//   Test_1   Alice (owner) + Bob (editor)
//   Big team Alice (owner) + Bob (viewer), Carol (editor), Dave (viewer), Erin (editor)
//   Solo     Alice only (not a team)
let alice: User, bob: User, carol: User, dave: User, erin: User, outsider: User
let bigId: string

test.beforeAll(async ({ browser }) => {
  ;[alice, bob, carol, dave, erin, outsider] = await Promise.all(
    ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Outsider'].map((n) => newUser(browser, n)),
  )
  for (const u of [bob, carol, dave, erin, outsider, alice]) await register(u)
  await createDoc(alice, 'Test_1')
  await share(alice, bob, 'editor')
  bigId = await createDoc(alice, 'Big team')
  await share(alice, bob, 'viewer')
  await share(alice, carol, 'editor')
  await share(alice, dave, 'viewer')
  await share(alice, erin, 'editor')
  await createDoc(alice, 'Solo')
})
test.afterAll(async () => {
  for (const u of [alice, bob, carol, dave, erin, outsider]) await u?.context.close()
})

test('shared documents are teams: leader, real roles, exact counts, +N; unshared documents are not', async () => {
  const requests: string[] = []
  alice.page.on('request', (r) => r.url().includes('/api/') && requests.push(new URL(r.url()).pathname))
  await teams(alice)
  await expect(alice.page.getByText('No teams yet')).toHaveCount(0) // the old placeholder is gone
  await expect(led(alice).getByRole('listitem').filter({ has: alice.page.locator('h3') })).toHaveCount(2)

  const t1 = card(led(alice), 'Test_1')
  await expect(t1.locator('.team-meta')).toHaveText('2 members')
  await expect(t1.locator('.team-leader')).toContainText('Alice (you)')
  await expect(t1.locator('.team-leader .badge')).toHaveText('Team leader')
  await expect(t1.locator('.team-preview > li')).toHaveCount(1)
  await expect(t1.locator('.team-preview > li')).toContainText(['Bob'])
  await expect(t1.locator('.team-preview .badge')).toHaveText(['Editor'])
  await expect(t1.locator('.team-more')).toHaveCount(0)

  const big = card(led(alice), 'Big team')
  await expect(big.locator('.team-meta')).toHaveText('5 members') // the owner counts
  await expect(big.locator('.team-preview > li')).toHaveCount(3)
  await expect(big.locator('.team-more')).toHaveText('+1')
  await expect(big).not.toContainText(carol.email) // no emails on cards

  // Bob is on both teams (editor on one, viewer on the other) but is one person.
  await expect(alice.page.locator('.teams-summary')).toHaveText("2 teams you lead · 4 people on them · 0 teams you're in")
  await expect(alice.page.getByText("1 document you own is not shared with anyone, so it isn't a team yet.")).toBeVisible()
  await expect(alice.page.getByRole('heading', { level: 3, name: 'Solo' })).toHaveCount(0)

  // Each load asks for each member list once. (In development React's
  // StrictMode runs the load effect twice, so count rounds, not requests.)
  const rounds = requests.filter((p) => p === '/api/documents').length
  const members = requests.filter((p) => p.endsWith('/members'))
  expect(members).toHaveLength(3 * rounds) // Test_1, Big team, Solo
  for (const path of new Set(members)) expect(members.filter((p) => p === path)).toHaveLength(rounds)
  // Animations, hovering and the dialog fetch nothing.
  const before = requests.length
  await big.hover()
  await t1.hover()
  for (let i = 0; i < 3; i++) {
    await big.getByRole('button', { name: 'View all members of Big team' }).click()
    await expect(alice.page.getByRole('dialog', { name: 'Big team' })).toBeVisible()
    await alice.page.keyboard.press('Escape')
    await expect(alice.page.getByRole('dialog')).toBeHidden()
  }
  expect(requests.length).toBe(before)
})

test("members see the teams they're in with their own role, and nothing about the other members; outsiders see nothing", async () => {
  const requests: string[] = []
  bob.page.on('request', (r) => r.url().includes('/members') && requests.push(r.url()))
  await teams(bob)
  await expect(led(bob)).toHaveCount(0)
  await expect(card(member(bob), 'Test_1').locator('.badge')).toHaveText('You: Editor')
  await expect(card(member(bob), 'Big team').locator('.badge')).toHaveText('You: Viewer')
  await expect(card(member(bob), 'Big team')).toContainText('Only the team leader can see who else is on this team.')
  await expect(bob.page.getByRole('button', { name: /View all members/ })).toHaveCount(0)
  for (const other of [carol, dave, erin]) await expect(bob.page.locator('main')).not.toContainText(other.name)
  expect(requests).toEqual([]) // the owner-only member list is never asked for
  await expect(bob.page.locator('.teams-summary')).toHaveText("0 teams you lead · 2 teams you're in")
  await card(member(bob), 'Test_1').getByRole('link', { name: 'Open document Test_1' }).click()
  await expect(bob.page.getByRole('heading', { name: 'Test_1' })).toBeVisible()

  await teams(outsider)
  await expect(outsider.page.getByRole('heading', { name: 'No document teams yet' })).toBeVisible()
  await expect(outsider.page.locator('main')).not.toContainText('Test_1')
  await expect(outsider.page.locator('main')).not.toContainText('Big team')
})

test('View all members: the whole list, focus kept inside and returned, Escape, close button, backdrop, Manage access', async () => {
  await teams(alice)
  const opener = card(led(alice), 'Big team').getByRole('button', { name: 'View all members of Big team' })
  await opener.click()
  const dialog = alice.page.getByRole('dialog', { name: 'Big team' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('5 members · Led by you')
  const rows = dialog.getByRole('list', { name: 'Members of Big team' }).getByRole('listitem')
  await expect(rows).toHaveCount(5)
  await expect(rows.first()).toContainText('Alice (you)')
  await expect(rows.first().locator('.badge')).toHaveText('Team leader')
  // The owner first, then the server's order (by email), each with their real role on this document.
  await expect(rows.locator('.member-name')).toHaveText(['Alice (you)', 'Bob', 'Carol', 'Dave', 'Erin'])
  await expect(rows.locator('.badge')).toHaveText(['Team leader', 'Viewer', 'Editor', 'Viewer', 'Editor'])
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused()

  // Tab never reaches the page behind (a modal dialog makes it inert). Past
  // the last control, focus goes to the browser's own UI (the page reports
  // <body>) and the next Tab comes back in, as with any native modal dialog.
  const seen = new Set<string>()
  for (let i = 0; i < 8; i++) {
    await alice.page.keyboard.press('Tab')
    const where = await dialog.evaluate((d) =>
      d.contains(document.activeElement) ? (document.activeElement as HTMLElement).innerText.trim() || 'Close' : document.activeElement === document.body ? 'browser' : 'PAGE',
    )
    expect(where).not.toBe('PAGE')
    seen.add(where)
  }
  expect([...seen]).toEqual(expect.arrayContaining(['Close', 'Manage access', 'Open document']))

  await alice.page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()

  await opener.click()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
  await expect(opener).toBeFocused()

  await opener.click()
  await expect(dialog).toBeVisible()
  await alice.page.mouse.click(8, 8) // the backdrop
  await expect(dialog).toBeHidden()

  // A short window: the list scrolls; the header and the actions stay.
  await alice.page.setViewportSize({ width: 1440, height: 430 })
  await opener.click()
  await expect(dialog).toBeVisible()
  const list = dialog.getByRole('list', { name: 'Members of Big team' })
  expect(await list.evaluate((l) => l.scrollHeight > l.clientHeight && getComputedStyle(l).overflowY === 'auto')).toBe(true)
  await expect(dialog.getByRole('link', { name: 'Manage access' })).toBeInViewport()
  await alice.page.setViewportSize({ width: 1440, height: 900 })

  // Manage access is the document's own Share panel.
  await dialog.getByRole('link', { name: 'Manage access' }).click()
  await expect(alice.page).toHaveURL(new RegExp(`#/d/${bigId}/share$`))
  await expect(alice.page.getByRole('region', { name: 'Sharing' })).toBeVisible()
  await expect(alice.page.getByRole('region', { name: 'Sharing' })).toContainText(carol.email)
})

test('motion: cards fade in, the dialog fades; reduced motion turns it off; phones get one column', async ({ browser }) => {
  await teams(alice)
  const first = led(alice).getByRole('listitem').first()
  expect(await first.evaluate((el) => [getComputedStyle(el).animationName, getComputedStyle(el).animationDuration])).toEqual(['team-in', '0.24s'])
  const transition = await first.evaluate((el) => getComputedStyle(el).transitionProperty)
  expect(transition).toBe('transform, border-color, box-shadow') // never "all"
  const opener = card(led(alice), 'Test_1').getByRole('button', { name: 'View all members of Test_1' })
  await opener.click()
  const dialog = alice.page.getByRole('dialog', { name: 'Test_1' })
  await expect(dialog).toHaveClass(/is-open/)
  await expect(dialog).toHaveCSS('opacity', '1')
  await alice.page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // Reduced motion: no card animation or lift, and the dialog closes at once.
  const still = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', storageState: await alice.context.storageState() })
  const page = await still.newPage()
  await page.goto('/#/teams')
  const card1 = page.getByRole('list', { name: 'Teams you lead' }).getByRole('listitem').first()
  await expect(card1).toBeVisible()
  expect(await card1.evaluate((el) => getComputedStyle(el).animationName)).toBe('none')
  await card1.hover()
  expect(await card1.evaluate((el) => getComputedStyle(el).transform)).toBe('none')
  await page.getByRole('button', { name: 'View all members of Big team' }).click()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => document.querySelector('dialog')?.open)).toBe(false) // already closed: no fade to wait for
  await still.close()

  // A phone: one column, nothing wider than the screen.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, storageState: await alice.context.storageState() })
  const p = await phone.newPage()
  await p.goto('/#/teams')
  const cards = p.getByRole('list', { name: 'Teams you lead' }).locator(':scope > li') // the cards, not the member rows inside them
  await expect(cards).toHaveCount(2)
  const xs = await cards.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
  expect(new Set(xs).size).toBe(1)
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await phone.close()
})
