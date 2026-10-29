// The Week 3 browser checklist, in real Chromium. Each user is a separate
// browser context (own cookies and storage), like separate browsers.
// Needs PostgreSQL: COLLABSPACE_TEST_DATABASE_URL. Run: npx playwright test
import { expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import { AppServer, buildServer, DATABASE_URL } from '../e2e/harness'

const BACKEND_PORT = 18080
const APP = 'http://localhost:15173'

test.skip(!DATABASE_URL, 'COLLABSPACE_TEST_DATABASE_URL not set')
test.describe.configure({ mode: 'serial' })

let binary: string
let server: AppServer

async function startServer() {
  server = await AppServer.start(binary, BACKEND_PORT, { ALLOWED_ORIGINS: APP })
}

test.beforeAll(async () => {
  binary = buildServer()
  await startServer()
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

async function newUser(browser: Browser, name: string): Promise<User> {
  const context = await browser.newContext()
  const page = await context.newPage()
  return { name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`, context, page }
}

async function register(u: User) {
  await u.page.goto('/')
  await u.page.getByRole('button', { name: 'Create one' }).click()
  await u.page.getByLabel('Name').fill(u.name)
  await u.page.getByLabel('Email').fill(u.email)
  await u.page.getByLabel('Password', { exact: true }).fill('password-123')
  await u.page.getByRole('button', { name: 'Create account' }).click()
  await expect(signedInAs(u.page)).toHaveText(u.name)
}

// The profile row at the bottom of the sidebar (hidden in the drawer on phones).
const signedInAs = (page: Page) => page.locator('#sidebar .profile-name')

// Sign out is a button in the sidebar's profile row; on phones, open the drawer first.
async function signOutVia(page: Page) {
  const menu = page.getByRole('button', { name: 'Open navigation' })
  if (await menu.isVisible()) await menu.click()
  await page.locator('#sidebar').getByRole('button', { name: 'Sign out' }).click()
}

async function createDoc(u: User, title: string): Promise<string> {
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

const editor = (u: User) => u.page.locator('.tiptap')
const status = (u: User) => u.page.getByRole('status')

async function openDoc(u: User, docId: string) {
  await u.page.goto(`/#/d/${docId}`)
  await expect(status(u)).toContainText('Connected')
}

async function typeAtEnd(u: User, text: string) {
  await editor(u).click()
  await u.page.keyboard.press('ControlOrMeta+End')
  await u.page.keyboard.type(text, { delay: 15 })
}

/**
 * Routes the page's collaboration WebSockets through Playwright so a test can
 * cut the connection for real (Chromium's setOffline does not close an open
 * WebSocket; Week 3 §B) and hold back the server's "committed" acks.
 * Must be installed before the page opens the socket.
 */
async function controlSockets(page: Page) {
  const ctl = {
    offline: false,
    dropAcks: false,
    current: null as { page: WebSocketRoute; server: WebSocketRoute } | null,
    /** Drop the open connection and refuse new ones until online(). */
    goOffline() {
      ctl.offline = true
      ctl.current?.server.close()
      ctl.current?.page.close({ code: 1001, reason: 'network down (test)' })
      ctl.current = null
    },
    online() {
      ctl.offline = false
    },
  }
  await page.routeWebSocket(/\/ws\/documents\//, (ws) => {
    if (ctl.offline) {
      ws.close({ code: 1001, reason: 'network down (test)' })
      return
    }
    const server = ws.connectToServer()
    ws.onMessage((m) => server.send(m))
    server.onMessage((m) => {
      if (ctl.dropAcks && typeof m === 'string' && m.includes('"type":"committed"')) return
      ws.send(m)
    })
    server.onClose((code, reason) => ws.close({ code, reason }))
    ws.onClose(() => server.close())
    ctl.current = { page: ws, server }
  })
  return ctl
}

test('register, sign out, sign in; documents are private until shared', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(alice)
  await register(bob)

  // 2. Sign out and in again.
  await signOutVia(alice.page)
  await expect(alice.page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await alice.page.getByLabel('Email').fill(alice.email)
  await alice.page.getByLabel('Password', { exact: true }).fill('password-123')
  await alice.page.getByRole('button', { name: 'Sign in' }).click()
  await expect(signedInAs(alice.page)).toHaveText('Alice')

  // 3. Create and list.
  const docId = await createDoc(alice, 'Private plan')
  await alice.page.getByRole('link', { name: 'My workspace', exact: true }).click()
  await expect(alice.page.getByRole('link', { name: 'Private plan' })).toBeVisible()
  await bob.page.reload()
  await expect(bob.page.getByText('No documents yet')).toBeVisible()

  // 10. Bob opens Alice's private document by URL.
  await bob.page.goto(`/#/d/${docId}`)
  await expect(bob.page.getByText('document not found')).toBeVisible()

  // 11. A WebSocket without a valid session never opens.
  const anonymous = await browser.newContext()
  const anonPage = await anonymous.newPage()
  await anonPage.goto('/')
  const result = await anonPage.evaluate(
    (url) =>
      new Promise<{ opened: boolean; code: number }>((resolve) => {
        const ws = new WebSocket(url)
        let opened = false
        ws.onopen = () => (opened = true)
        ws.onclose = (e) => resolve({ opened, code: e.code })
      }),
    `ws://localhost:15173/ws/documents/${docId}`,
  )
  expect(result.opened).toBe(false)
  // Positive control: the same check from a signed-in page does connect, so
  // "never opened" above isn't just a server or proxy being down.
  await alice.page.goto(`/#/d/${docId}`)
  const signedIn = await alice.page.evaluate(
    (url) =>
      new Promise<boolean>((resolve) => {
        const ws = new WebSocket(url)
        ws.onopen = () => {
          resolve(true)
          ws.close()
        }
        ws.onclose = () => resolve(false)
      }),
    `ws://localhost:15173/ws/documents/${docId}`,
  )
  expect(signedIn).toBe(true)
  await anonymous.close()
  await alice.context.close()
  await bob.context.close()
})

test('share, edit concurrently, refresh, permissions change live', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(alice)
  await register(bob)
  const docId = await createDoc(alice, 'Shared notes')

  // 4. Share as editor; Bob sees it in his list.
  await share(alice, bob, 'editor')
  await bob.page.reload()
  await expect(bob.page.getByRole('list', { name: 'Recent documents' }).getByRole('link', { name: 'Shared notes' })).toBeVisible()
  // Alice has it open, so it is also listed as active right now.
  await expect(bob.page.getByRole('list', { name: 'Documents open right now' })).toContainText('Shared notes')

  // 6. Concurrent editing in two browsers.
  await openDoc(alice, docId)
  await openDoc(bob, docId)
  await Promise.all([typeAtEnd(alice, 'Alice was here. '), typeAtEnd(bob, 'Bob too. ')])
  await expect(status(alice)).toContainText('Saved')
  await expect(status(bob)).toContainText('Saved')
  await expect(async () => {
    const [a, b] = [await editor(alice).innerText(), await editor(bob).innerText()]
    expect(a).toBe(b)
    expect(a).toContain('Alice was here.')
    expect(a).toContain('Bob too.')
  }).toPass()

  // 7. Refresh: content persists.
  const before = await editor(bob).innerText()
  await bob.page.reload()
  await expect(status(bob)).toContainText('Connected')
  await expect(editor(bob)).toHaveText(before)

  // 5/12. Owner downgrades Bob to viewer while his editor is open: it
  // becomes read-only without a reload.
  await alice.page.getByLabel(`Role for ${bob.email}`).selectOption('viewer')
  await expect(status(bob)).toContainText('View only')
  await expect(editor(bob)).toHaveAttribute('contenteditable', 'false')
  await expect(bob.page.locator('.doc-title .badge')).toHaveText('viewer')

  // 12. Owner removes Bob while his page is open.
  await alice.page.locator('.member-list li', { hasText: bob.email }).getByRole('button', { name: 'Remove' }).click()
  await expect(bob.page.getByText('document not found')).toBeVisible()

  await alice.context.close()
  await bob.context.close()
})

test('offline edits and a server restart: nothing saved is lost', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const net = await controlSockets(alice.page)
  await register(alice)
  const docId = await createDoc(alice, 'Restart test')
  await expect(status(alice)).toContainText('Connected')

  // 8. The connection really drops (Week 5: setOffline didn't close the
  // WebSocket, so this step used to prove nothing), edits are made while
  // disconnected, then it comes back.
  await typeAtEnd(alice, 'before offline. ')
  await expect(status(alice)).toContainText('Saved')
  net.goOffline()
  await expect(status(alice)).toContainText('Offline')
  await typeAtEnd(alice, 'typed offline. ')
  await expect(status(alice)).toContainText('Offline · unsaved changes')
  net.online()
  await expect(status(alice)).toContainText('Saved', { timeout: 30_000 })

  // 9. Server restart: edits made while it is down are saved afterwards.
  await server.stop('SIGTERM')
  await expect(status(alice)).toContainText('Offline')
  await typeAtEnd(alice, 'typed while the server was down.')
  await expect(status(alice)).toContainText('unsaved changes')
  await startServer()
  await expect(status(alice)).toContainText('Saved', { timeout: 30_000 })

  const fresh = await alice.context.newPage()
  await fresh.goto(`${APP}/#/d/${docId}`)
  await expect(fresh.locator('.tiptap')).toContainText('before offline. typed offline. typed while the server was down.')
  await alice.context.close()
})

test('signing out in one tab ends the open editor in another', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  const docId = await createDoc(alice, 'Two tabs')
  await expect(status(alice)).toContainText('Connected')

  const second = await alice.context.newPage()
  await second.goto('/')
  await signOutVia(second)
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  // The editor tab's WebSocket is closed by the server (4001) and the page
  // returns to the sign-in screen without being touched.
  await expect(alice.page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await expect(alice.page.getByText('Your session ended. Please sign in again.')).toBeVisible()
  await expect(alice.page).toHaveURL(new RegExp(docId))
  await alice.context.close()
})

// Week 5 review R1: an edit not yet saved when the session ends (signed out in
// another tab) used to vanish with the editor. Now the editor stays, the user
// signs in again, and the edit is saved.
test('signing out elsewhere with unsaved edits: sign in again and they are saved', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const net = await controlSockets(alice.page)
  await register(alice)
  const docId = await createDoc(alice, 'Unsaved at sign-out')
  await expect(status(alice)).toContainText('Saved')

  net.dropAcks = true // the edit reaches the server but its confirmation doesn't come back
  await typeAtEnd(alice, 'not confirmed yet')
  await expect(status(alice)).toContainText('Saving')

  const second = await alice.context.newPage()
  await second.goto('/')
  await signOutVia(second)
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  // The first tab keeps the text on screen and asks to sign in again.
  await expect(alice.page.getByText('Your session ended. Sign in again as')).toBeVisible()
  await expect(editor(alice)).toContainText('not confirmed yet')
  await expect(editor(alice)).toHaveAttribute('contenteditable', 'false')

  net.dropAcks = false
  const reauth = alice.page.locator('.reauth')
  await expect(reauth.getByLabel('Email')).toHaveValue(alice.email)
  await reauth.getByLabel('Password', { exact: true }).fill('password-123')
  await reauth.getByRole('button', { name: 'Sign in' }).click()
  await expect(status(alice)).toContainText('Saved', { timeout: 30_000 })

  const fresh = await alice.context.newPage()
  await fresh.goto(`${APP}/#/d/${docId}`)
  await expect(fresh.locator('.tiptap')).toContainText('not confirmed yet')
  await alice.context.close()
})

// --- Week 4: presence ---

const people = (page: Page) => page.getByRole('list', { name: 'People in this document' }).getByRole('listitem')

test('presence: who is here, tabs, role change, disconnect and reconnect', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(alice)
  await register(bob)
  const docId = await createDoc(alice, 'Presence')
  await share(alice, bob, 'editor')

  // Alone.
  await expect(status(alice)).toContainText('Connected')
  await expect(people(alice.page)).toHaveText(['AYou', 'Only you here'])

  // Every presence frame Bob's page receives, per socket. The server sends
  // one only when the list changes, so no frame may repeat the one before
  // it on the same socket (checked at the end, instead of a fixed wait).
  const bobFrames: string[][] = []
  bob.page.on('websocket', (ws) => {
    const frames: string[] = []
    bobFrames.push(frames)
    ws.on('framereceived', ({ payload }) => {
      if (typeof payload === 'string' && payload.includes('"type":"presence"')) frames.push(payload)
    })
  })

  // Bob joins: both lists update.
  await openDoc(bob, docId)
  await expect(people(alice.page)).toHaveText(['AYou', 'BBob'])
  await expect(people(bob.page)).toHaveText(['BYou', 'AAlice'])

  // Alice opens a second tab: still listed once; closing it changes nothing.
  const aliceTab2 = await alice.context.newPage()
  await aliceTab2.goto(`${APP}/#/d/${docId}`)
  await expect(people(aliceTab2)).toHaveText(['AYou', 'BBob'])
  await expect(people(bob.page)).toHaveText(['BYou', 'AAlice'])
  await aliceTab2.close()
  await expect(people(bob.page)).toHaveText(['BYou', 'AAlice'])

  // Presence doesn't disturb editing or saving.
  await typeAtEnd(bob, 'Bob typed. ')
  await expect(status(bob)).toContainText('Saved')
  await expect(editor(alice)).toContainText('Bob typed.')

  // Role change: Bob reconnects and is listed as viewing.
  await alice.page.getByLabel(`Role for ${bob.email}`).selectOption('viewer')
  await expect(people(alice.page)).toHaveText(['AYou', 'BBob (viewing)'])
  await expect(status(bob)).toContainText('View only')

  // Server restart: the list disappears while offline (never stale), then
  // comes back from the new connections.
  await server.stop('SIGTERM')
  await expect(status(alice)).toContainText('Offline')
  await expect(people(alice.page)).toHaveCount(0)
  await startServer()
  await expect(people(alice.page)).toHaveText(['AYou', 'BBob (viewing)'], { timeout: 30_000 })

  // Bob leaves.
  await bob.page.close()
  await expect(people(alice.page)).toHaveText(['AYou', 'Only you here'])

  // No presence frame repeated its predecessor: in particular, closing
  // Alice's second tab sent nothing. (The Go probe test proves this
  // precisely; here the following steps give the server seconds to have
  // processed that leave.)
  expect(bobFrames.flat().length).toBeGreaterThanOrEqual(3)
  for (const frames of bobFrames) {
    for (let i = 1; i < frames.length; i++) expect(frames[i], `presence frame ${i} repeats the previous one`).not.toBe(frames[i - 1])
  }

  await alice.context.close()
  await bob.context.close()
})

// --- Enter-key crash regression (the blank page) ---

test('keyboard editing: Enter, headings, lists, undo/redo, reload; the page never blanks', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const pageErrors: string[] = []
  alice.page.on('pageerror', (e) => pageErrors.push(e.message))
  await register(alice)
  await createDoc(alice, 'Keyboard')
  await expect(status(alice)).toContainText('Connected')
  const ed = editor(alice)
  const kb = alice.page.keyboard

  await ed.click()
  await kb.type('First line', { delay: 10 })
  await kb.press('Enter') // this used to blank the page
  await kb.press('Enter')
  await kb.type('Third line', { delay: 10 })
  await expect(ed.locator('p')).toHaveCount(3)
  await expect(ed.locator('p').nth(2)).toHaveText('Third line')

  await kb.press('Enter')
  await kb.press('ControlOrMeta+Alt+1')
  await kb.type('A heading', { delay: 10 })
  await expect(ed.locator('h1')).toHaveText('A heading')
  await kb.press('Enter') // leaves the heading
  await kb.type('- ', { delay: 10 }) // bullet list input rule
  await kb.type('item one', { delay: 10 })
  await kb.press('Enter')
  await kb.type('item two', { delay: 10 })
  await expect(ed.locator('ul > li')).toHaveCount(2)
  await kb.press('Enter')
  await kb.press('Enter') // an empty item + Enter leaves the list
  await kb.type('After the list', { delay: 10 })
  await expect(ed.locator('ul > li')).toHaveCount(2)
  await expect(status(alice)).toContainText('Saved')

  // Undo/redo (Yjs undo manager from the Collaboration extension).
  await kb.press('ControlOrMeta+z')
  await expect(ed).not.toContainText('After the list')
  await kb.press('ControlOrMeta+Shift+z')
  await expect(ed).toContainText('After the list')
  await expect(status(alice)).toContainText('Saved')

  // Everything was persisted: a reload rebuilds it from the server's log.
  await alice.page.reload()
  await expect(status(alice)).toContainText('Connected')
  await expect(ed.locator('h1')).toHaveText('A heading')
  await expect(ed.locator('ul > li')).toHaveCount(2)
  await expect(ed).toContainText('After the list')
  await expect(ed.locator('p').first()).toHaveText('First line')

  expect(pageErrors).toEqual([])
  await alice.context.close()
})

// --- UI: toolbar, theme, keyboard access, narrow screens ---

test('toolbar formats text, shows active state and supports arrow-key navigation', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Toolbar')
  await expect(status(alice)).toContainText('Connected')
  const ed = editor(alice)
  const toolbar = alice.page.getByRole('toolbar', { name: 'Formatting' })
  const bold = toolbar.getByRole('button', { name: 'Bold' })

  await ed.click()
  await expect(bold).toHaveAttribute('aria-pressed', 'false')
  await bold.click()
  await alice.page.keyboard.type('strong words')
  await expect(ed.locator('strong')).toHaveText('strong words')
  await expect(bold).toHaveAttribute('aria-pressed', 'true') // active state follows the cursor

  await alice.page.keyboard.press('Enter')
  await toolbar.getByRole('button', { name: 'Heading 2' }).click()
  await alice.page.keyboard.type('Section')
  await expect(ed.locator('h2')).toHaveText('Section')
  await expect(toolbar.getByRole('button', { name: 'Heading 2' })).toHaveAttribute('aria-pressed', 'true')

  await alice.page.keyboard.press('Enter')
  await toolbar.getByRole('button', { name: 'Bulleted list' }).click()
  await alice.page.keyboard.type('point')
  await expect(ed.locator('ul > li')).toHaveText('point')
  await expect(status(alice)).toContainText('Saved')

  // One Tab stop; arrow keys move between buttons (WAI-ARIA toolbar).
  const tabbable = toolbar.locator('button[tabindex="0"]')
  await expect(tabbable).toHaveCount(1)
  await tabbable.focus()
  const first = await alice.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  await alice.page.keyboard.press('ArrowRight')
  const second = await alice.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  expect(second).not.toBe(first)
  await alice.context.close()
})

test('theme toggle: switches, persists, and leaves the document and editor untouched', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  // Record every frame the page sends, from before the editor's socket opens.
  const sent: string[] = []
  alice.page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))))
  await register(alice)
  await createDoc(alice, 'Themes')
  await expect(status(alice)).toContainText('Connected')
  await typeAtEnd(alice, 'Content that must not change.')
  await expect(status(alice)).toContainText('Saved')
  const html = alice.page.locator('html')
  const before = await html.getAttribute('data-theme')
  // Mark the editor's DOM node: if a theme switch remounted the editor, the mark would be gone.
  await editor(alice).evaluate((el) => ((el as HTMLElement & { __mark?: boolean }).__mark = true))
  const updatesBefore = sent.filter((f) => f.includes('"type":"update"')).length
  expect(updatesBefore).toBeGreaterThan(0) // the recorder does see edits

  const toggle = alice.page.getByRole('button', { name: /^Switch to (dark|light) theme$/ })
  await toggle.click()
  const after = await html.getAttribute('data-theme')
  expect(after).not.toBe(before)
  expect(await editor(alice).evaluate((el) => (el as HTMLElement & { __mark?: boolean }).__mark)).toBe(true)
  await expect(editor(alice)).toHaveText('Content that must not change.')
  await expect(status(alice)).toContainText('Saved')
  await alice.page.waitForTimeout(300) // a batched edit would be sent within 50 ms
  expect(sent.filter((f) => f.includes('"type":"update"')).length).toBe(updatesBefore) // nothing new was sent

  await alice.page.reload()
  await expect(html).toHaveAttribute('data-theme', after!) // remembered
  await expect(editor(alice)).toHaveText('Content that must not change.')
  await alice.context.close()
})

test('sidebar: every link opens its page and shows where you are', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const pageErrors: string[] = []
  alice.page.on('pageerror', (e) => pageErrors.push(e.message))
  await register(alice)
  const nav = alice.page.getByRole('navigation', { name: 'Main' })
  const pages: [string, string, RegExp][] = [
    ['Workspaces', '#/workspaces', /^My workspace$/],
    ['Goals', '#/goals', /^Today's Goals$/],
    ['Teams', '#/teams', /^Teams$/],
    ['Settings', '#/settings', /^Settings$/],
    ['Overview', '#/', /^Good (morning|afternoon|evening), Alice$/],
  ]
  for (const [label, hash, heading] of pages) {
    await nav.getByRole('link', { name: label }).click()
    await expect(alice.page).toHaveURL(new RegExp(`${hash.replace('/', '\\/')}$`))
    await expect(alice.page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
    await expect(nav.getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page')
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1)
  }
  // A document belongs to Workspaces; the breadcrumb leads back there.
  await createDoc(alice, 'Nav doc')
  await expect(nav.getByRole('link', { name: 'Workspaces' })).toHaveAttribute('aria-current', 'page')
  await alice.page.getByRole('link', { name: 'Back to My workspace' }).click()
  await expect(alice.page.getByRole('link', { name: 'Nav doc' })).toBeVisible()
  expect(pageErrors).toEqual([])
  await alice.context.close()
})

test('phone drawer: opens from the keyboard, page behind is inert, Escape returns focus', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  const alice: User = { name: 'Alice', email: `alice-${randomUUID().slice(0, 8)}@example.test`, context, page }
  await register(alice)
  const menu = page.getByRole('button', { name: 'Open navigation' })
  const sidebar = page.locator('#sidebar')
  await expect(sidebar).toBeHidden() // off-screen and not focusable while closed
  await menu.focus()
  await page.keyboard.press('Enter')
  await expect(menu).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar).toBeVisible()
  await expect(sidebar.getByRole('link', { name: 'Overview' })).toBeFocused() // the current page
  await expect(page.locator('.shell-main')).toHaveAttribute('inert', '')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveAttribute('aria-expanded', 'false')
  await expect(menu).toBeFocused()
  await expect(sidebar).toBeHidden()
  await expect(page.locator('.shell-main')).not.toHaveAttribute('inert')

  // Choosing a page closes the drawer.
  await menu.click()
  await sidebar.getByRole('link', { name: 'Goals' }).click()
  await expect(page.getByRole('heading', { level: 1, name: "Today's Goals" })).toBeVisible()
  await expect(sidebar).toBeHidden()
  // So does the close button.
  await menu.click()
  await sidebar.getByRole('button', { name: 'Close navigation' }).click()
  await expect(sidebar).toBeHidden()
  await expect(menu).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await context.close()
})

test('goals: add, check off, progress; kept in this browser after reload', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await alice.page.goto('/#/goals')
  const page = alice.page
  await expect(page.getByText('Plan your day')).toBeVisible() // empty state
  await expect(page.getByText(/saved in this browser only/i)).toBeVisible() // says where goals live

  const input = page.getByLabel('New goal')
  await input.fill('Write the summary')
  await page.keyboard.press('Enter')
  await input.fill('Review the PR')
  await page.getByRole('button', { name: 'Add goal' }).click()
  await expect(input).toHaveValue('')
  const progress = page.getByRole('progressbar')
  await expect(progress).toHaveAttribute('aria-valuenow', '0')
  await expect(page.getByText('0 of 2 done')).toBeVisible()

  await page.getByRole('checkbox', { name: 'Write the summary' }).check()
  await expect(page.getByText('1 of 2 done')).toBeVisible()
  await expect(progress).toHaveAttribute('aria-valuenow', '50')

  await page.reload()
  await expect(page.getByRole('checkbox', { name: 'Write the summary' })).toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Review the PR' })).not.toBeChecked()

  // Overview shows the same numbers.
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Overview' }).click()
  await expect(page.locator('.stat', { hasText: "Today's goals" })).toContainText('1/2')

  await page.goto('/#/goals')
  await page.getByRole('button', { name: 'Delete goal: Review the PR' }).click()
  await page.getByRole('button', { name: 'Clear completed' }).click()
  await expect(page.getByText('Plan your day')).toBeVisible()

  // Another account in the same browser sees none of them.
  const other = await alice.context.newPage()
  await other.goto('/#/goals')
  await expect(other.getByRole('heading', { name: "Today's Goals" })).toBeVisible()
  await alice.context.close()
})

test('settings: theme choice applies at once and persists; System follows the OS', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' })
  const page = await context.newPage()
  const alice: User = { name: 'Alice', email: `alice-${randomUUID().slice(0, 8)}@example.test`, context, page }
  await register(alice)
  const html = page.locator('html')
  await expect(html).toHaveAttribute('data-theme', 'dark') // follows the OS with no choice made
  await page.goto('/#/settings')
  await expect(page.getByRole('radio', { name: /^System/ })).toBeChecked()
  await page.getByRole('radio', { name: /^Light/ }).check()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await page.reload()
  await expect(html).toHaveAttribute('data-theme', 'light')
  await expect(page.getByRole('radio', { name: /^Light/ })).toBeChecked()

  await page.getByRole('radio', { name: /^System/ }).check()
  await expect(html).toHaveAttribute('data-theme', 'dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(html).toHaveAttribute('data-theme', 'light') // follows a live OS change
  await context.close()
})

test('auth: show/hide password keeps the value, never submits; inline validation', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  const posts: string[] = []
  page.on('request', (r) => r.method() === 'POST' && posts.push(r.url()))
  await page.goto('/')
  const password = page.getByLabel('Password', { exact: true })
  const show = page.getByRole('button', { name: 'Show password' })
  await password.fill('s3cret-value')
  await password.press('ArrowLeft')
  await password.press('ArrowLeft')
  await show.click()
  await expect(password).toHaveAttribute('type', 'text')
  await expect(password).toHaveValue('s3cret-value')
  await expect(password).toBeFocused()
  expect(await password.evaluate((el: HTMLInputElement) => el.selectionStart)).toBe(10)
  await page.getByRole('button', { name: 'Hide password' }).click()
  await expect(password).toHaveAttribute('type', 'password')
  await expect(password).toHaveValue('s3cret-value')
  await show.press('Enter') // keyboard activation toggles too, and still doesn't submit
  await expect(password).toHaveAttribute('type', 'text')
  expect(posts).toEqual([])
  expect(await page.evaluate(() => JSON.stringify(localStorage) + document.cookie)).not.toContain('s3cret-value')

  // Inline validation before anything is sent.
  await password.fill('')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByText('Enter your email address.')).toBeVisible()
  await expect(page.getByText('Enter your password.')).toBeVisible()
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true')
  expect(posts).toEqual([])

  // The server's answer is shown in place.
  await page.getByLabel('Email').fill(`nobody-${randomUUID().slice(0, 8)}@example.test`)
  await password.fill('wrong-password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(password).toHaveValue('') // not kept after a submit
  await context.close()
})

test('two people pressing Enter in the same document converge; nobody blanks', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  const pageErrors: string[] = []
  for (const u of [alice, bob]) u.page.on('pageerror', (e) => pageErrors.push(`${u.name}: ${e.message}`))
  await register(bob)
  await register(alice)
  const docId = await createDoc(alice, 'Enter together')
  await share(alice, bob, 'editor')
  await openDoc(bob, docId)
  await expect(status(alice)).toContainText('Connected')

  await typeAtEnd(alice, 'Alice line')
  await alice.page.keyboard.press('Enter')
  await alice.page.keyboard.press('Enter') // the trailing empty paragraph that used to blank the page
  await expect(editor(bob)).toContainText('Alice line')
  await expect(editor(bob).locator('p')).toHaveCount(3)

  // Both press Enter at the same time, at different places: Alice at the top, Bob at the end.
  // (Placed through Tiptap: Cmd+Home isn't "document start" in Chromium on macOS.)
  const caret = (u: User, at: 'start' | 'end') =>
    editor(u).evaluate((el, at) => (el as HTMLElement & { editor: { commands: { focus: (p: string) => void } } }).editor.commands.focus(at), at)
  await caret(alice, 'start')
  await caret(bob, 'end')
  // Tiptap's focus() moves focus in a requestAnimationFrame: typing before
  // that lost the first keystroke (seen: "ob line").
  await expect(editor(alice)).toBeFocused()
  await expect(editor(bob)).toBeFocused()
  await Promise.all([
    (async () => {
      await alice.page.keyboard.type('Alice on top', { delay: 10 })
      await alice.page.keyboard.press('Enter')
      await alice.page.keyboard.press('Enter')
    })(),
    (async () => {
      await bob.page.keyboard.type('Bob line', { delay: 10 })
      await bob.page.keyboard.press('Enter')
      await bob.page.keyboard.press('Enter')
      await bob.page.keyboard.type('Bob after blanks', { delay: 10 })
    })(),
  ])

  await expect(status(alice)).toContainText('Saved')
  await expect(status(bob)).toContainText('Saved')
  const html = (u: User) => editor(u).innerHTML()
  await expect.poll(async () => (await html(alice)) === (await html(bob))).toBe(true)
  const lines = await editor(alice).locator('p').allTextContents()
  expect(lines, 'paragraphs after concurrent Enter').toEqual(['Alice on top', '', 'Alice line', '', 'Bob line', '', 'Bob after blanks'])
  await expect(alice.page.locator('.editor-shell')).toBeVisible()
  await expect(bob.page.locator('.editor-shell')).toBeVisible()
  expect(pageErrors, 'page errors').toEqual([])
  await alice.context.close()
  await bob.context.close()
})

test('narrow screens (390px): no horizontal overflow; editing and sharing still work', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const alice: User = { name: 'Alice', email: `alice-${randomUUID().slice(0, 8)}@example.test`, context, page: await context.newPage() }
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  await register(alice)
  await createDoc(alice, 'Mobile')
  await expect(status(alice)).toContainText('Connected')
  const overflow = () => alice.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(await overflow()).toBe(0)

  await typeAtEnd(alice, 'Typed on a phone.')
  await alice.page.getByRole('button', { name: 'Bold' }).click()
  await alice.page.keyboard.type(' Bold too.')
  await expect(editor(alice).locator('strong')).toHaveText(' Bold too.')
  await share(alice, bob, 'viewer')
  expect(await overflow()).toBe(0)
  await expect(alice.page.getByRole('button', { name: 'Invite' })).toBeVisible()
  await expect(status(alice)).toContainText('Saved')
  await context.close()
  await bob.context.close()
})

// --- Rename, delete, online counts, collapsible sidebar ---

test('rename: owner and editors can, viewers cannot; everyone sees the new title', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  const carol = await newUser(browser, 'Carol')
  for (const u of [bob, carol, alice]) await register(u)
  const docId = await createDoc(alice, 'Draft title')
  await share(alice, bob, 'editor')
  await share(alice, carol, 'viewer')

  // The owner renames from the document page; the editor stays mounted.
  await typeAtEnd(alice, 'Body text stays.')
  await expect(status(alice)).toContainText('Saved')
  await editor(alice).evaluate((el) => ((el as HTMLElement & { __mark?: boolean }).__mark = true))
  await alice.page.getByRole('button', { name: 'Rename document' }).click()
  const title = alice.page.getByLabel('Document title', { exact: true })
  await expect(title).toBeFocused()
  await title.fill('Launch plan')
  await title.press('Enter')
  await expect(alice.page.getByRole('heading', { level: 1, name: /Launch plan/ })).toBeVisible()
  await expect(alice.page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Launch plan')
  expect(await editor(alice).evaluate((el) => (el as HTMLElement & { __mark?: boolean }).__mark)).toBe(true)
  await expect(editor(alice)).toHaveText('Body text stays.')

  // Escape cancels without saving.
  await alice.page.getByRole('button', { name: 'Rename document' }).click()
  await title.fill('Not saved')
  await title.press('Escape')
  await expect(alice.page.getByRole('heading', { level: 1, name: /Launch plan/ })).toBeVisible()

  // The editor renames from the list.
  await bob.page.goto('/#/workspaces')
  await bob.page.getByRole('button', { name: 'Rename Launch plan' }).click()
  await bob.page.getByLabel('Document title', { exact: true }).fill('Launch plan v2')
  await bob.page.getByRole('button', { name: 'Save' }).click()
  await expect(bob.page.getByRole('link', { name: 'Launch plan v2' })).toBeVisible()
  await expect(bob.page.getByText('Renamed to “Launch plan v2”.')).toBeVisible()

  // The viewer gets no rename control anywhere, and the API refuses anyway.
  await carol.page.goto(`/#/d/${docId}`)
  await expect(carol.page.getByRole('heading', { level: 1, name: /Launch plan v2/ })).toBeVisible()
  await expect(carol.page.getByRole('button', { name: 'Rename document' })).toHaveCount(0)
  await carol.page.goto('/#/workspaces')
  await expect(carol.page.getByRole('link', { name: 'Launch plan v2' })).toBeVisible()
  await expect(carol.page.getByRole('button', { name: /^Rename / })).toHaveCount(0)
  const refused = await carol.page.evaluate(
    (id) => fetch(`/api/documents/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"title":"x"}' }).then((r) => r.status),
    docId,
  )
  expect(refused).toBe(403)
  for (const u of [alice, bob, carol]) await u.context.close()
})

test('delete: only the owner can; open editors are closed for everyone', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  await register(alice)
  const docId = await createDoc(alice, 'Doomed')
  await share(alice, bob, 'editor')
  await openDoc(bob, docId)
  await typeAtEnd(bob, 'Bob was here.')
  await expect(status(bob)).toContainText('Saved')

  // Bob (editor) has no delete control, on the page or in the list; the API refuses.
  await expect(bob.page.getByRole('button', { name: 'Delete document' })).toHaveCount(0)
  const refused = await bob.page.evaluate((id) => fetch(`/api/documents/${id}`, { method: 'DELETE' }).then((r) => r.status), docId)
  expect(refused).toBe(403)

  // Cancelling the confirmation deletes nothing.
  alice.page.once('dialog', (d) => d.dismiss())
  await alice.page.getByRole('button', { name: 'Delete document' }).click()
  await expect(editor(bob)).toContainText('Bob was here.')
  await expect(status(bob)).toContainText('Connected')

  alice.page.once('dialog', (d) => {
    expect(d.message()).toContain('Delete “Doomed”?')
    void d.accept()
  })
  await alice.page.getByRole('button', { name: 'Delete document' }).click()
  await expect(alice.page).toHaveURL(/#\/workspaces$/)
  await expect(alice.page.getByText('Deleted “Doomed”.')).toBeVisible()
  await expect(alice.page.getByRole('link', { name: 'Doomed' })).toHaveCount(0)

  // Bob's open editor is closed by the server and the page says so.
  await expect(bob.page.getByText('document not found')).toBeVisible()
  await bob.page.goto('/#/workspaces')
  await expect(bob.page.getByText('No documents yet')).toBeVisible()
  await alice.context.close()
  await bob.context.close()
})

test('online: the editor shows how many people are here, and so does the list', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  await register(alice)
  const docId = await createDoc(alice, 'Together')
  await share(alice, bob, 'editor')
  await expect(alice.page.getByText('Only you here')).toBeVisible()
  await expect(alice.page.locator('.presence-count')).toHaveCount(0)

  await openDoc(bob, docId)
  await expect(alice.page.locator('.presence-count')).toHaveText('2 online')
  await expect(bob.page.locator('.presence-count')).toHaveText('2 online')

  // From another tab, the document list shows the same count (Alice's open
  // editor tab and Bob).
  const list = await alice.context.newPage()
  await list.goto('/#/workspaces')
  const row = list.locator('.doc-row', { hasText: 'Together' })
  await expect(row.locator('.online')).toHaveText('2 online')
  await list.goto('/#/')
  await expect(list.getByRole('list', { name: 'Documents open right now' })).toContainText('Together')

  await bob.page.close()
  await expect(alice.page.locator('.presence-count')).toHaveCount(0)
  await expect(alice.page.getByText('Only you here')).toBeVisible()
  await list.goto('/#/workspaces')
  await expect(row.locator('.online')).toHaveText('1 online')
  await alice.context.close()
  await bob.context.close()
})

test('sidebar collapses to an icon rail and back, and remembers it', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  const page = alice.page
  const sidebar = page.locator('#sidebar')
  const width = async () => (await sidebar.boundingBox())!.width
  expect(await width()).toBeGreaterThan(200)

  const collapse = page.getByRole('button', { name: 'Collapse sidebar' })
  await expect(collapse).toHaveAttribute('aria-expanded', 'true')
  await collapse.click()
  await expect.poll(width).toBeLessThan(90)
  const expand = page.getByRole('button', { name: 'Expand sidebar' })
  await expect(expand).toHaveAttribute('aria-expanded', 'false')
  await expect(expand).toBeFocused() // focus stays on the toggle

  // Links still work and keep their names (labels are visually hidden only).
  const nav = page.getByRole('navigation', { name: 'Main' })
  await nav.getByRole('link', { name: 'Goals' }).click()
  await expect(page.getByRole('heading', { level: 1, name: "Today's Goals" })).toBeVisible()
  await expect(nav.getByRole('link', { name: 'Goals' })).toHaveAttribute('aria-current', 'page')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)

  await page.reload()
  await expect.poll(width).toBeLessThan(90) // remembered
  await page.getByRole('button', { name: 'Expand sidebar' }).click()
  await expect.poll(width).toBeGreaterThan(200)

  // Tablets always get the rail, without the toggle.
  await page.setViewportSize({ width: 900, height: 1000 })
  await expect.poll(width).toBeLessThan(90)
  await expect(page.getByRole('button', { name: /^(Collapse|Expand) sidebar$/ })).toHaveCount(0)
  await alice.context.close()
})

// --- Command palette, Workspaces search/sort, Overview goals, presence list ---

test('command palette: Cmd/Ctrl+K from the editor, search real documents, Escape gives focus back', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const pageErrors: string[] = []
  alice.page.on('pageerror', (e) => pageErrors.push(e.message))
  await register(alice)
  const targetId = await createDoc(alice, 'Palette target')
  await alice.page.goto('/#/workspaces')
  await createDoc(alice, 'Other notes')
  await expect(status(alice)).toContainText('Connected')
  const page = alice.page
  const palette = page.getByRole('dialog', { name: 'Command palette' })
  const search = page.getByRole('combobox', { name: 'Search documents and pages' })

  // Open it in the middle of typing: nothing is typed into the document.
  await typeAtEnd(alice, 'Typing here')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  await expect(search).toBeFocused()
  await expect(editor(alice)).toHaveText('Typing here')
  await expect(palette.getByRole('option')).toContainText(['Other notes', 'Palette target', 'Overview'])

  // Escape closes and typing carries on in the editor.
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(editor(alice)).toBeFocused()
  await page.keyboard.type(' and more', { delay: 10 })
  await expect(editor(alice)).toHaveText('Typing here and more')
  await expect(status(alice)).toContainText('Saved')

  // Search, then Enter opens the selected document.
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('palette tar')
  await expect(palette.getByRole('option', { name: /Palette target/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(new RegExp(`#/d/${targetId}$`))
  await expect(page.getByRole('heading', { level: 1, name: /Palette target/ })).toBeVisible()

  // Pages, chosen with the arrow keys.
  await page.keyboard.press('ControlOrMeta+k')
  await search.fill('se')
  await expect(palette.getByRole('option')).toHaveText([/Settings/]) // no document has "se" in its title
  await search.fill('')
  await page.keyboard.press('ArrowUp') // wraps to the last page: Settings
  await page.keyboard.press('ArrowUp')
  await expect(palette.getByRole('option', { name: /Teams/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: 'Teams' })).toBeVisible()

  // No invented results.
  await page.getByRole('button', { name: 'Search' }).click() // the sidebar entry opens it too
  await search.fill('nothing like this')
  await expect(palette.getByRole('option')).toHaveCount(0)
  await expect(palette.getByText('No documents match “nothing like this”.')).toBeVisible()
  await page.keyboard.press('Escape')

  // Plain typing in a text field never opens it; the shortcut does.
  await page.goto('/#/workspaces')
  const docSearch = page.getByLabel('Search documents', { exact: true })
  await docSearch.fill('k')
  await expect(palette).toBeHidden()
  await docSearch.press('ControlOrMeta+k')
  await expect(palette).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(docSearch).toBeFocused()
  expect(pageErrors).toEqual([])
  await alice.context.close()
})

test('command palette on phones: the top bar has a search button', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const alice: User = { name: 'Alice', email: `alice-${randomUUID().slice(0, 8)}@example.test`, context, page: await context.newPage() }
  await register(alice)
  await alice.page.getByRole('button', { name: 'Search documents and pages' }).click()
  const palette = alice.page.getByRole('dialog', { name: 'Command palette' })
  await expect(palette).toBeVisible()
  await alice.page.getByRole('combobox').fill('goals')
  await alice.page.keyboard.press('Enter')
  await expect(alice.page.getByRole('heading', { level: 1, name: "Today's Goals" })).toBeVisible()
  expect(await alice.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await context.close()
})

test('workspaces: sort by title or recency; search can be cleared', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  for (const t of ['beta notes', 'Alpha plan', 'gamma draft']) {
    await alice.page.goto('/#/workspaces')
    await createDoc(alice, t)
  }
  const page = alice.page
  await page.goto('/#/workspaces')
  const titles = page.getByRole('list', { name: 'Documents' }).locator('.doc-link')
  await expect(titles).toHaveText(['gamma draft', 'Alpha plan', 'beta notes']) // most recent first
  await page.getByLabel('Sort').selectOption('title')
  await expect(titles).toHaveText(['Alpha plan', 'beta notes', 'gamma draft'])

  const search = page.getByLabel('Search documents', { exact: true })
  await search.fill('zzz')
  await expect(page.getByText('No documents match “zzz”.')).toBeVisible()
  await page.getByRole('button', { name: 'Clear search' }).first().click()
  await expect(search).toHaveValue('')
  await expect(search).toBeFocused()
  await expect(titles).toHaveCount(3)
  await search.fill('plan')
  await expect(titles).toHaveText(['Alpha plan'])
  await search.press('Escape')
  await expect(search).toHaveValue('')

  // Rows open on click, and are reachable with the keyboard.
  await titles.filter({ hasText: 'beta notes' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { level: 1, name: /beta notes/ })).toBeVisible()
  await alice.context.close()
})

test('overview: goals can be added and completed there, and say where they are stored', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  const page = alice.page
  const goals = page.getByRole('list', { name: "Today's goals" })
  await page.getByLabel('New goal').fill('Ship the palette')
  await page.keyboard.press('Enter')
  await page.getByLabel('New goal').fill('Write tests')
  await page.getByRole('button', { name: 'Add goal' }).click()
  await expect(goals.getByRole('checkbox')).toHaveCount(2)
  await goals.getByRole('checkbox', { name: 'Ship the palette' }).check()
  await expect(page.locator('.stat', { hasText: "Today's goals" })).toContainText('1/2')
  await expect(page.getByText('50%')).toBeVisible()
  await expect(page.getByText('Saved in this browser only, for this account. Not synced to other devices.')).toBeVisible()
  await page.reload()
  await expect(goals.getByRole('checkbox', { name: 'Ship the palette' })).toBeChecked()
  await page.goto('/#/goals') // the same goals on the Goals page
  await expect(page.getByRole('checkbox', { name: 'Write tests' })).not.toBeChecked()
  await alice.context.close()
})

test('presence: the online count lists who is connected, with their role', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  await register(alice)
  const docId = await createDoc(alice, 'Who is here')
  await share(alice, bob, 'viewer')
  await openDoc(bob, docId)
  const toggle = alice.page.getByRole('button', { name: '2 online: show who' })
  await toggle.click()
  const who = alice.page.getByRole('region', { name: 'Who is here' })
  await expect(who.getByRole('listitem')).toHaveCount(2)
  await expect(who.getByRole('listitem').nth(0)).toContainText('Alice (you)')
  await expect(who.getByRole('listitem').nth(0)).toContainText('Owner')
  await expect(who.getByRole('listitem').nth(1)).toContainText('Bob')
  await expect(who.getByRole('listitem').nth(1)).toContainText('Viewing')
  await alice.page.keyboard.press('Escape')
  await expect(who).toBeHidden()
  await expect(toggle).toBeFocused()

  // When Bob leaves, the count and the list go away; nobody is invented.
  await bob.page.close()
  await expect(toggle).toBeHidden()
  await expect(alice.page.getByText('Only you here')).toBeVisible()
  await alice.context.close()
  await bob.context.close()
})

// --- Constellation background on the auth screens ---

// Canvas pixel statistics in a CSS-px box (scaled for the pixel ratio):
// how many pixels are drawn at least `min` alpha (0..255), and the mean alpha.
async function canvasAlpha(page: Page, box: { x: number; y: number; w: number; h: number }, min: number) {
  return page.evaluate(
    ([b, m]) => {
      const c = document.querySelector<HTMLCanvasElement>('canvas.constellation')!
      const s = c.width / c.clientWidth
      const d = c.getContext('2d')!.getImageData(b.x * s, b.y * s, b.w * s, b.h * s).data
      let count = 0
      let sum = 0
      for (let i = 3; i < d.length; i += 4) {
        sum += d[i]
        if (d[i] >= m) count++
      }
      return { count, mean: sum / (d.length / 4) }
    },
    [box, min] as const,
  )
}

// A digest of the canvas pixels in a CSS-px box (scaled for the pixel ratio).
async function canvasDigest(page: Page, box: { x: number; y: number; w: number; h: number }) {
  return page.evaluate((b) => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.constellation')!
    const s = c.width / c.clientWidth
    const data = c.getContext('2d')!.getImageData(b.x * s, b.y * s, b.w * s, b.h * s).data
    let sum = 0
    for (let i = 0; i < data.length; i++) sum = (sum + data[i] * (i % 251 + 1)) % 1_000_000_007
    return sum
  }, box)
}

test('auth constellation: drifts while idle, cursor lines follow the pointer, sharp on high-DPI, never gets in the way', async ({ browser }) => {
  const context = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  const canvas = page.locator('canvas.constellation')
  await expect(canvas).toHaveAttribute('aria-hidden', 'true')
  await expect(canvas).toHaveCSS('pointer-events', 'none')
  await expect(page.locator('.pointer-glow')).toHaveCount(0) // the old glow is gone
  expect(await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([2560, 1600])

  // Clearly visible while the pointer is idle: in an open area, lines and
  // nodes are drawn at a solid alpha (≥ 0.25), not as a faint haze.
  const open = { x: 40, y: 200, w: 400, h: 400 }
  const idle = await canvasAlpha(page, open, 64)
  // Calibrated on the screenshot-verified drifting look (1,750 measured;
  // links now fade in and out at the edge of their range): fails if the
  // network fades back toward a haze.
  expect(idle.count).toBeGreaterThan(1100)

  // Alive while the mouse is completely idle (it hasn't moved at all yet):
  // the canvas changes at every sample over more than 10 seconds.
  const whole = { x: 0, y: 0, w: 1280, h: 800 }
  let prevDigest = await canvasDigest(page, whole)
  for (let s = 0; s < 6; s++) {
    await page.waitForTimeout(2000)
    const d = await canvasDigest(page, whole)
    expect(d, `still drifting after ${(s + 1) * 2} s`).not.toBe(prevDigest)
    prevDigest = d
  }

  // Lines from the pointer to nearby nodes: they all converge on the pointer,
  // so a small box around it goes from mostly empty to clearly drawn.
  const around = (x: number, y: number) => ({ x: x - 10, y: y - 10, w: 20, h: 20 })
  const at = { x: 220, y: 460 }
  const elsewhere = { x: 1150, y: 300 }
  const bright = async (p: { x: number; y: number }) => (await canvasAlpha(page, around(p.x, p.y), 80)).count
  const samples = async (p: { x: number; y: number }) => {
    const out: number[] = []
    for (let s = 0; s < 5; s++) {
      out.push(await bright(p))
      await page.waitForTimeout(120)
    }
    return out
  }
  await page.mouse.move(elsewhere.x, elsewhere.y, { steps: 4 })
  await page.waitForTimeout(600)
  const without = Math.max(...(await samples(at))) // drifting lines may cross it now and then
  await page.mouse.move(at.x, at.y, { steps: 6 })
  await page.waitForTimeout(600)
  const withPointer = Math.min(...(await samples(at))) // held still: every sample has the lines
  expect(withPointer).toBeGreaterThan(without * 2 + 30)

  // The lines follow the pointer…
  await page.mouse.move(elsewhere.x, elsewhere.y, { steps: 10 })
  await page.waitForTimeout(600)
  expect(Math.min(...(await samples(elsewhere)))).toBeGreaterThan(without * 2 + 30)
  expect(Math.max(...(await samples(at)))).toBeLessThan(withPointer)

  // …and fade away when it leaves the page, while the drift continues.
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null })))
  await page.waitForTimeout(1200)
  expect(Math.max(...(await samples(elsewhere)))).toBeLessThan(withPointer / 2)
  const d1 = await canvasDigest(page, whole)
  await page.waitForTimeout(500)
  expect(await canvasDigest(page, whole)).not.toBe(d1)

  // Resizing redraws at the new size.
  await page.setViewportSize({ width: 900, height: 700 })
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height])).toEqual([1800, 1400])

  // Sign-in and registration work through it: mouse, keyboard, selection.
  const email = page.getByLabel('Email')
  const box = (await email.boundingBox())!
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [box.x + 10, box.y + box.height / 2])).toBe('auth-email')
  await page.mouse.click(box.x + 20, box.y + box.height / 2)
  await expect(email).toBeFocused()
  await page.keyboard.type(`nobody-${randomUUID().slice(0, 6)}@example.test`)
  await page.keyboard.press('Tab')
  await page.keyboard.type('wrong-password')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Show password' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text')
  await page.getByText('Write together, in real time.').dblclick()
  expect(await page.evaluate(() => window.getSelection()?.toString().trim())).not.toBe('')
  await page.getByLabel('Password', { exact: true }).press('Enter')
  await expect(page.getByRole('alert')).toBeVisible() // the server's answer

  const name = `Con ${randomUUID().slice(0, 4)}`
  await page.getByRole('button', { name: 'Create one' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(`con-${randomUUID().slice(0, 8)}@example.test`)
  await page.getByLabel('Password', { exact: true }).fill('password-123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.locator('#sidebar .profile-name')).toHaveText(name)
  // Signed in: a quieter version on the overview only; never behind the
  // editor or the other text-heavy pages.
  await expect(canvas).toHaveCount(1)
  await page.goto('/#/workspaces')
  await expect(page.getByRole('heading', { level: 1, name: 'My workspace' })).toBeVisible()
  await expect(canvas).toHaveCount(0)
  await page.getByPlaceholder('New document title').fill('Calm canvas')
  await page.getByRole('button', { name: 'Create', exact: true }).click()
  await expect(page.locator('.tiptap')).toBeVisible()
  // The editor: visible in the outer background, strongly dimmed behind the
  // writing surface.
  await expect(canvas).toHaveCount(1)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('.tiptap')).toBeVisible()
  await page.waitForTimeout(300) // the resize redraw
  // Mean canvas alpha behind the writing surface vs. in open background
  // (more than 100px from every dimmed element), sampled every 4 CSS px.
  const zones = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('canvas.constellation')!
    const s = c.width / c.clientWidth
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    const quiet = [...document.querySelectorAll('.paper, .toolbar-wrap, .doc-head, .breadcrumb, .share-panel')].map((e) => e.getBoundingClientRect())
    const paper = document.querySelector('.paper')!.getBoundingClientRect()
    const dist = (r: DOMRect, x: number, y: number) => Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))
    let inSum = 0, inN = 0, outSum = 0, outN = 0
    for (let y = 0; y < c.clientHeight; y += 4)
      for (let x = 0; x < c.clientWidth; x += 4) {
        const a = d[(Math.floor(y * s) * c.width + Math.floor(x * s)) * 4 + 3]
        if (dist(paper, x, y) === 0) {
          inSum += a
          inN++
        } else if (quiet.every((r) => dist(r, x, y) > 100)) {
          outSum += a
          outN++
        }
      }
    return { behind: inSum / inN, open: outSum / outN, openSamples: outN }
  })
  expect(zones.openSamples).toBeGreaterThan(1000)
  expect(zones.open).toBeGreaterThan(zones.behind * 4) // clearly dimmed behind the writing
  await page.locator('.tiptap').click()
  await page.keyboard.type('Typing over a calm canvas.')
  await expect(page.locator('.tiptap')).toHaveText('Typing over a calm canvas.')
  expect(errors).toEqual([])
  await context.close()
})

test('auth constellation: still with reduced motion; drifting but pointer-free on touch phones', async ({ browser }) => {
  const reduced = await browser.newContext({ reducedMotion: 'reduce' })
  const a = await reduced.newPage()
  await a.goto('/')
  await expect(a.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  const region = { x: 120, y: 120, w: 160, h: 160 }
  const before = await canvasDigest(a, region)
  // A visible network (940 px measured at 1×; still, so it's exact)…
  expect((await canvasAlpha(a, { x: 0, y: 0, w: 1280, h: 720 }, 64)).count).toBeGreaterThan(600)
  await a.waitForTimeout(1500)
  expect(await canvasDigest(a, region)).toBe(before) // …that stays still
  await a.mouse.move(150, 150)
  await a.mouse.move(200, 200, { steps: 8 })
  await a.waitForTimeout(400)
  expect(await canvasDigest(a, region)).toBe(before) // and doesn't follow the mouse
  await reduced.close()

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
  const p = await phone.newPage()
  await p.goto('/')
  await expect(p.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  const pr = { x: 0, y: 0, w: 390, h: 844 }
  const first = await canvasDigest(p, pr)
  await p.getByLabel('Email').tap()
  await expect(p.getByLabel('Email')).toBeFocused()
  await p.touchscreen.tap(200, 60)
  await p.waitForTimeout(1000)
  expect(await canvasDigest(p, pr)).not.toBe(first) // the gentle drift continues on touch
  expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0)
  await phone.close()
})

// --- Monochrome theme ---

// Every element's colors, borders and gradients, as rendered: report any
// with a visible hue, except those whose color carries meaning (saved,
// online, warnings, errors, destructive actions).
async function huedElements(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const SEMANTIC = [
      '.badge.editor', '.badge.viewer', '[class*="status-"]', '.status-dot', '.online', '.online-dot',
      '.presence-count', '.banner', '.btn-danger', '.icon-button-danger', '.form-message', '.field-error',
      '.rename-error', 'input[aria-invalid="true"]',
    ].join(', ')
    const hue = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/g) ?? []
      return m.some((one) => {
        const [r, g, b, a = 1] = one.replace(/rgba?\(|\)/g, '').split(/[ ,/]+/).filter(Boolean).map(Number)
        return a > 0.04 && Math.max(r, g, b) - Math.min(r, g, b) > 24
      })
    }
    const out: string[] = []
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest(SEMANTIC)) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      for (const prop of ['color', 'backgroundColor', 'borderTopColor', 'backgroundImage', 'fill', 'stroke'] as const) {
        const v = cs[prop]
        if (v && hue(v)) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${prop}: ${v}`)
      }
    }
    return [...new Set(out)].slice(0, 20)
  })
}

test('monochrome: no hue anywhere except status colors, in both themes', async ({ browser }) => {
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  for (const scheme of ['dark', 'light'] as const) {
    const context = await browser.newContext({ colorScheme: scheme })
    const page = await context.newPage()
    const alice: User = { name: 'Alice', email: `alice-${randomUUID().slice(0, 8)}@example.test`, context, page }
    await page.goto('/')
    expect(await huedElements(page), `${scheme} sign-in`).toEqual([])
    await register(alice)
    await page.getByLabel('New goal').fill('Check the theme')
    await page.keyboard.press('Enter')
    await page.getByRole('checkbox', { name: 'Check the theme' }).check()
    expect(await huedElements(page), `${scheme} overview`).toEqual([])
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible()
    expect(await huedElements(page), `${scheme} palette`).toEqual([])
    await page.keyboard.press('Escape')
    await page.goto('/#/workspaces')
    const docId = await createDoc(alice, 'Monochrome')
    await share(alice, bob, 'editor')
    await openDoc(bob, docId)
    await expect(page.locator('.presence-count')).toHaveText('2 online')
    await typeAtEnd(alice, 'Plain text, in black and white.')
    await expect(status(alice)).toContainText('Saved')
    expect(await huedElements(page), `${scheme} editor`).toEqual([])
    for (const hash of ['#/workspaces', '#/goals', '#/teams', '#/settings']) {
      await page.goto(`/${hash}`)
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await huedElements(page), `${scheme} ${hash}`).toEqual([])
    }

    // Spot checks: silver primary with dark text (graphite/white in light), white focus ring.
    await page.goto('/#/workspaces')
    const create = page.getByRole('button', { name: 'Create', exact: true })
    const bg = await create.evaluate((el) => getComputedStyle(el).backgroundImage)
    expect(bg).toContain(scheme === 'dark' ? 'rgb(242, 243, 245)' : 'rgb(58, 60, 66)')
    await expect(create).toHaveCSS('color', scheme === 'dark' ? 'rgb(16, 17, 20)' : 'rgb(255, 255, 255)')
    await page.getByPlaceholder('New document title').focus()
    await page.keyboard.press('Tab')
    await expect(create).toBeFocused()
    expect(await create.evaluate((el) => getComputedStyle(el).boxShadow)).toContain(scheme === 'dark' ? 'rgb(213, 215, 222)' : 'rgb(58, 60, 66)')
    await context.close()
  }
  await bob.context.close()
})


// --- Editor: typography, outline, page breaks ---

type TiptapEl = HTMLElement & {
  editor: {
    commands: Record<string, (...a: unknown[]) => boolean>
    state: { selection: { from: number; to: number }; doc: { textContent: string } }
  }
}
// Runs a Tiptap command on the user's editor (only to place the selection
// precisely; formatting itself goes through the real toolbar).
const tiptap = (u: User, name: string, ...args: unknown[]) =>
  editor(u).evaluate((el, [n, a]) => (el as TiptapEl).editor.commands[n as string](...(a as unknown[])), [name, args] as const)
const selectionOf = (u: User) => editor(u).evaluate((el) => {
  const s = (el as TiptapEl).editor.state.selection
  return [s.from, s.to]
})

test('typography: size, color and highlight format the selection, sync, persist and clear', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  await register(alice)
  const docId = await createDoc(alice, 'Typography')
  await share(alice, bob, 'editor')
  await openDoc(bob, docId)
  await typeAtEnd(alice, 'Format this word please')
  await expect(status(alice)).toContainText('Saved')

  await tiptap(alice, 'setTextSelection', { from: 8, to: 12 }) // "this"
  const trigger = alice.page.getByRole('button', { name: 'Text style' })
  await trigger.click()
  const popover = alice.page.getByRole('dialog', { name: 'Text style' })
  await expect(popover).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  expect(await selectionOf(alice)).toEqual([8, 12]) // opening it kept the selection
  await expect(popover.getByRole('button', { name: 'Font size 16px (default)' })).toHaveAttribute('aria-pressed', 'true')

  await popover.getByRole('button', { name: 'Font size 24px' }).click()
  await popover.getByRole('button', { name: 'Text color Blue' }).click()
  await popover.getByRole('button', { name: 'Highlight Yellow' }).click()
  expect(await selectionOf(alice)).toEqual([8, 12]) // and so did using it
  await expect(popover.getByRole('button', { name: 'Font size 24px' })).toHaveAttribute('aria-pressed', 'true')
  await expect(popover.getByRole('button', { name: 'Text color Blue' })).toHaveAttribute('aria-pressed', 'true')

  for (const u of [alice, bob]) {
    // Formatting is in the shared document: the other editor shows it too.
    await expect(editor(u).locator('span.fs-24')).toHaveText('this')
    await expect(editor(u).locator('span.tc-blue')).toHaveText('this')
    await expect(editor(u).locator('mark.hl-yellow')).toHaveText('this')
  }
  await expect(editor(alice).locator('span.fs-24')).toHaveCSS('font-size', '24px')
  expect(await editor(alice).locator('[style]').count()).toBe(0) // classes, no inline styles (CSP)

  // Escape closes the popover and returns focus to where it was when the
  // popover opened: the editor here (opened with the mouse while typing),
  // so typing goes on with the formatting intact. (Opened from the
  // keyboard, focus returns to the button: browser/formatting.spec.ts.)
  await alice.page.keyboard.press('Escape')
  await expect(popover).toBeHidden()
  await expect(editor(alice)).toBeFocused()
  await expect(editor(alice).locator('span.fs-24')).toHaveCSS('font-size', '24px')

  // It's persisted: a reload shows it.
  await expect(status(alice)).toContainText('Saved')
  await alice.page.reload()
  await expect(status(alice)).toContainText('Connected')
  await expect(editor(alice).locator('span.fs-24')).toHaveText('this')
  await expect(editor(alice).locator('mark.hl-yellow')).toHaveText('this')

  // Clear formatting removes it everywhere, keeping the text.
  await tiptap(alice, 'selectAll')
  await alice.page.getByRole('button', { name: 'Text style' }).click()
  await alice.page.getByRole('dialog', { name: 'Text style' }).getByRole('button', { name: 'Clear formatting' }).click()
  for (const u of [alice, bob]) {
    await expect(editor(u).locator('span.fs-24, span.tc-blue, mark.hl-yellow')).toHaveCount(0)
    await expect(editor(u)).toHaveText('Format this word please')
  }
  await alice.context.close()
  await bob.context.close()
})

test('typography: with a bare cursor, the chosen size applies to what is typed next', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Cursor formatting')
  await typeAtEnd(alice, 'Plain ')
  await alice.page.getByRole('button', { name: 'Text style' }).click()
  await alice.page.getByRole('dialog', { name: 'Text style' }).getByRole('button', { name: 'Font size 32px' }).click()
  await alice.page.keyboard.type('Big', { delay: 10 }) // the editor kept focus
  await expect(editor(alice).locator('span.fs-32')).toHaveText('Big')
  await expect(editor(alice)).toHaveText('Plain Big')
  await alice.context.close()
})

test('outline: follows the headings, jumps to them, and opening panels never recreates the editor', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Outline')
  const page = alice.page
  const outline = page.getByRole('navigation', { name: 'Document outline' })
  const toggle = page.getByRole('button', { name: 'Outline' })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(outline).toContainText('No headings yet')

  // Mark the editor's DOM node and keep the editor instance: if a panel
  // recreated the editor, both checks below would fail.
  await editor(alice).evaluate((el) => {
    ;(el as HTMLElement & { __mark?: boolean }).__mark = true
    ;(window as unknown as { __ed: unknown }).__ed = (el as TiptapEl).editor
  })
  const sameEditor = () =>
    editor(alice).evaluate(
      (el) => (el as HTMLElement & { __mark?: boolean }).__mark === true && (window as unknown as { __ed: unknown }).__ed === (el as TiptapEl).editor,
    )

  const filler = Array.from({ length: 25 }, (_, i) => `<p>Paragraph ${i + 1} of filler text.</p>`).join('')
  await tiptap(alice, 'insertContent', `<h1>Introduction</h1>${filler}<h2>Details</h2>${filler}<h3>Deep section</h3><p>The end.</p>`)
  const items = outline.getByRole('list', { name: 'Headings' }).getByRole('button')
  await expect(items).toHaveText(['Introduction', 'Details', 'Deep section'])
  await expect(outline.locator('.outline-item.level-2')).toHaveText('Details')
  await expect(outline.locator('.outline-item.level-3')).toHaveText('Deep section')

  // Jump to the last heading: it scrolls into view and the cursor goes there.
  await page.evaluate(() => window.scrollTo(0, 0))
  await items.filter({ hasText: 'Deep section' }).click()
  const deep = editor(alice).locator('h3')
  // (it's near the end, so the page may not scroll it all the way to the top)
  await expect(deep).toBeInViewport()
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(500)
  await expect(editor(alice)).toBeFocused()
  await page.keyboard.type('Very ', { delay: 10 })
  await expect(deep).toHaveText('Very Deep section')
  await expect(items).toHaveText(['Introduction', 'Details', 'Very Deep section']) // edits follow

  // Turning a heading into a paragraph removes it from the outline.
  await items.filter({ hasText: 'Details' }).click()
  await page.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Heading 2' }).click()
  await expect(items).toHaveText(['Introduction', 'Very Deep section'])

  // Panels open and close freely; the editor and its content stay.
  for (let i = 0; i < 3; i++) {
    await toggle.click()
    await toggle.click()
    await page.getByRole('button', { name: 'Text style' }).click()
    await page.keyboard.press('Escape')
  }
  expect(await sameEditor()).toBe(true)
  await expect(deep).toHaveText('Very Deep section')
  await expect(status(alice)).toContainText('Saved')

  // The outline is rebuilt from the stored document after a reload.
  await page.reload()
  await expect(status(alice)).toContainText('Connected')
  await expect(
    page.getByRole('navigation', { name: 'Document outline' }).getByRole('list', { name: 'Headings' }).getByRole('button'),
  ).toHaveText(['Introduction', 'Very Deep section'])
  await alice.context.close()
})

test('page breaks: inserted from the toolbar, shared, persisted, and a real break in print', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(bob)
  await register(alice)
  const docId = await createDoc(alice, 'Page breaks')
  await share(alice, bob, 'editor')
  await openDoc(bob, docId)
  await typeAtEnd(alice, 'Page one')
  await alice.page.getByRole('button', { name: 'Insert page break' }).click()
  await alice.page.keyboard.type('Page two', { delay: 10 }) // the cursor is after the break, not on it
  for (const u of [alice, bob]) {
    await expect(editor(u).locator('hr.page-break')).toHaveCount(1)
    await expect(editor(u).locator('p')).toHaveText(['Page one', 'Page two'])
  }
  await expect(status(alice)).toContainText('Saved')
  await alice.page.reload()
  await expect(status(alice)).toContainText('Connected')
  await expect(editor(alice).locator('hr.page-break')).toHaveCount(1)
  const toggle = alice.page.getByRole('button', { name: 'Outline' })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await expect(alice.page.getByRole('navigation', { name: 'Document outline' })).toContainText('Page break 1')
  // Print, in the page view: the page gap after the marker is the break (the
  // marker prints nothing, so there's no second break and no blank page).
  await alice.page.emulateMedia({ media: 'print' })
  await expect(editor(alice).locator('hr.page-break + .page-gap')).toHaveCSS('break-before', 'page')
  await expect(editor(alice).locator('hr.page-break')).toHaveCSS('display', 'none')
  // In continuous mode (a narrow window) the marker itself is the break.
  await alice.page.emulateMedia({ media: 'screen' })
  await alice.page.setViewportSize({ width: 420, height: 860 })
  await expect(editor(alice).locator('.page-gap')).toHaveCount(0)
  await alice.page.emulateMedia({ media: 'print' })
  await expect(editor(alice).locator('hr.page-break')).toHaveCSS('break-after', 'page')
  await alice.context.close()
  await bob.context.close()
})

test('typography applied while offline is sent on reconnect and persists', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const net = await controlSockets(alice.page)
  await register(alice)
  const docId = await createDoc(alice, 'Offline formatting')
  await typeAtEnd(alice, 'Offline styling')
  await expect(status(alice)).toContainText('Saved')

  net.goOffline()
  await expect(status(alice)).toContainText('Offline')
  await tiptap(alice, 'setTextSelection', { from: 1, to: 8 }) // "Offline"
  await alice.page.getByRole('button', { name: 'Text style' }).click()
  await alice.page.getByRole('dialog', { name: 'Text style' }).getByRole('button', { name: 'Highlight Green' }).click()
  await expect(status(alice)).toContainText('unsaved changes') // held, not lost

  net.online()
  await expect(status(alice)).toContainText('Saved', { timeout: 30_000 })
  const fresh = await alice.context.newPage()
  await fresh.goto(`${APP}/#/d/${docId}`)
  await expect(fresh.locator('.tiptap mark.hl-green')).toHaveText('Offline')
  await alice.context.close()
})
