// The deployed stack in real Chromium: HTTPS through Nginx, CSP enforced,
// Secure __Host- cookie, WebSockets proxied, an app restart survived.
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const compose = resolve(dirname(fileURLToPath(import.meta.url)), '../../deploy/compose.yaml')

// Record CSP violations in the page itself, from the first script on.
async function watchCSP(page: Page): Promise<string[]> {
  const violations: string[] = []
  page.on('console', (m) => {
    if (m.text().includes('Content Security Policy')) violations.push(m.text())
  })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      console.error(`Content Security Policy violation: ${e.violatedDirective} ${e.blockedURI}`)
    })
  })
  return violations
}

async function register(page: Page, name: string): Promise<string> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`
  await page.goto('/')
  await page.getByRole('button', { name: 'Create one' }).click()
  await page.getByLabel('Name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill('password-123')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.locator('#sidebar .profile-name')).toHaveText(name)
  return email
}

const status = (p: Page) => p.getByRole('status')
const editor = (p: Page) => p.locator('.tiptap')
const people = (p: Page) => p.getByRole('list', { name: 'People in this document' }).getByRole('listitem')

test('two users collaborate over HTTPS through Nginx, and edits survive an app restart', async ({ browser }) => {
  const a = await browser.newContext()
  const b = await browser.newContext()
  const alice = await a.newPage()
  const bob = await b.newPage()
  const cspAlice = await watchCSP(alice)
  const cspBob = await watchCSP(bob)

  await register(alice, 'Alice')
  const bobEmail = await register(bob, 'Bob')

  // The session cookie as the browser stored it.
  const [cookie] = await a.cookies()
  expect(cookie).toMatchObject({ name: '__Host-collabspace_session', secure: true, httpOnly: true, sameSite: 'Lax', path: '/' })

  await alice.getByPlaceholder('New document title').fill('Deployed')
  await alice.getByRole('button', { name: 'Create' }).click()
  await expect(status(alice)).toContainText('Connected')
  const url = alice.url()
  await alice.getByRole('button', { name: 'Share', exact: true }).click()
  await alice.getByLabel('Email address').fill(bobEmail)
  await alice.getByRole('button', { name: 'Invite' }).click()
  await expect(alice.getByText(`Shared with ${bobEmail} as editor.`)).toBeVisible()
  await bob.goto(url)
  await expect(status(bob)).toContainText('Connected')
  await expect(people(alice)).toHaveText(['AYou', 'BBob'])

  await editor(alice).click()
  await alice.keyboard.type('Hello from Alice. ', { delay: 10 })
  await editor(bob).click()
  await bob.keyboard.press('ControlOrMeta+End')
  await bob.keyboard.type('Hi from Bob.', { delay: 10 })
  await expect(status(alice)).toContainText('Saved')
  await expect(status(bob)).toContainText('Saved')
  await expect(async () => {
    const [x, y] = [await editor(alice).innerText(), await editor(bob).innerText()]
    expect(x).toBe(y)
    expect(x).toContain('Hello from Alice.')
    expect(x).toContain('Hi from Bob.')
  }).toPass()

  // Restart the app container (SIGTERM → 1001 → reconnect through Nginx).
  // Alice types while it is down; the edit is saved after it comes back.
  const restart = new Promise<void>((done) => {
    setTimeout(() => {
      execFileSync('docker', ['compose', '-f', compose, 'restart', 'app'], { stdio: 'ignore' })
      done()
    }, 0)
  })
  await expect(status(alice)).toContainText(/Offline|Connecting|Syncing/, { timeout: 30_000 })
  await editor(alice).click()
  await alice.keyboard.press('ControlOrMeta+End')
  await alice.keyboard.type(' Typed during the restart.', { delay: 10 })
  await restart
  await expect(status(alice)).toContainText('Saved', { timeout: 60_000 })
  await expect(editor(bob)).toContainText('Typed during the restart.', { timeout: 60_000 })
  await expect(people(bob)).toHaveText(['BYou', 'AAlice'], { timeout: 30_000 })

  expect(cspAlice, 'CSP violations (Alice)').toEqual([])
  expect(cspBob, 'CSP violations (Bob)').toEqual([])
  await a.close()
  await b.close()
})
