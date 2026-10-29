// The text style panel ("Aa") in real Chromium: formatting applied from it
// stays, whichever way the panel closes; with a bare cursor it applies to
// what is typed next; the panel shows the formatting at the selection
// (including mixed selections); and formatting persists and reaches other
// collaborators. Focus and selection behaviour needs a real browser.
// Needs PostgreSQL: COLLABSPACE_TEST_DATABASE_URL. Run: npx playwright test
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
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
  /** Collaboration frames this page has sent. */
  sent: string[]
}

async function newUser(browser: Browser, name: string): Promise<User> {
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  const page = await context.newPage()
  const sent: string[] = []
  page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))))
  return { name, email: `${name.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`, context, page, sent }
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
  await u.page.getByPlaceholder('New document title').fill(title)
  await u.page.getByRole('button', { name: 'Create' }).click()
  await expect(u.page.getByRole('heading', { name: title })).toBeVisible()
  await expect(editor(u)).toHaveAttribute('contenteditable', 'true')
  return u.page.url().split('#/d/')[1]
}

async function share(owner: User, member: User) {
  await owner.page.getByRole('button', { name: 'Share', exact: true }).click()
  await owner.page.getByLabel('Email address').fill(member.email)
  await owner.page.locator('form.share select').selectOption('editor')
  await owner.page.getByRole('button', { name: 'Invite' }).click()
  await expect(owner.page.getByText(`Shared with ${member.email} as editor.`)).toBeVisible()
}

type TiptapEl = HTMLElement & { editor: { [k: string]: any } }
const editor = (u: User) => u.page.locator('.tiptap')
const panel = (u: User) => u.page.getByRole('dialog', { name: 'Text style' })
const aa = (u: User) => u.page.getByRole('button', { name: 'Text style' })
const saved = (u: User) => expect(u.page.getByRole('status')).toContainText('Saved')
const updatesSent = (u: User) => u.sent.filter((f) => f.includes('"type":"update"')).length

/** A new empty paragraph at the end, with the cursor in it (no marks carried over). */
async function freshParagraph(u: User) {
  await editor(u).evaluate((el) => {
    const e = (el as TiptapEl).editor
    e.chain().insertContentAt(e.state.doc.content.size, { type: 'paragraph' }).focus('end').run()
  })
  await expect(editor(u)).toBeFocused()
}

/** Types `text` as a paragraph of its own and selects it (cursor stays in the editor). */
async function selectedParagraph(u: User, text: string) {
  await freshParagraph(u)
  await u.page.keyboard.type(text)
  await editor(u).evaluate((el, t) => {
    const e = (el as TiptapEl).editor
    let from = -1
    e.state.doc.descendants((n: { isText: boolean; text?: string }, pos: number) => {
      if (n.isText && n.text === t) from = pos
    })
    e.commands.setTextSelection({ from, to: from + t.length })
  }, text)
}

/** The marks on the text node whose text is exactly `text`, as "name=value"; null if there's no such text. */
const marksOn = (u: User, text: string) =>
  editor(u).evaluate((el, t) => {
    let found: string[] | null = null
    ;(el as TiptapEl).editor.state.doc.descendants((n: { isText: boolean; text?: string; marks: { type: { name: string }; attrs: { value?: unknown } }[] }) => {
      if (n.isText && n.text === t) found = n.marks.map((m) => `${m.type.name}=${m.attrs.value ?? ''}`).sort()
    })
    return found
  }, text)

const selection = (u: User) => editor(u).evaluate((el) => [(el as TiptapEl).editor.state.selection.from, (el as TiptapEl).editor.state.selection.to])
const docJSON = (u: User) => editor(u).evaluate((el) => JSON.stringify((el as TiptapEl).editor.getJSON()))

type Close = 'Escape' | 'outside click' | 'Aa button'
const CLOSES: Close[] = ['Escape', 'outside click', 'Aa button']

/** Closes the panel the way a person would. */
async function close(u: User, how: Close) {
  if (how === 'Escape') await u.page.keyboard.press('Escape')
  else if (how === 'Aa button') await aa(u).click()
  else {
    // Empty page background, between the sidebar and the sheet.
    const sheet = (await u.page.locator('.paper').boundingBox())!
    const sidebar = (await u.page.locator('#sidebar').boundingBox())!
    await u.page.mouse.click((sidebar.x + sidebar.width + sheet.x) / 2, 600)
  }
  await expect(panel(u)).toHaveCount(0)
}

const FORMATS = [
  { label: 'Font size 24px', mark: 'fontSize=24', cls: 'fs-24' },
  { label: 'Text color Red', mark: 'textColor=red', cls: 'tc-red' },
  { label: 'Highlight Yellow', mark: 'highlight=yellow', cls: 'hl-yellow' },
] as const

test('selected text keeps its formatting when the panel closes, whichever way it closes', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Selected text')
  for (const how of CLOSES) {
    const word = `selected${how.replace(/\W/g, '')}`
    await selectedParagraph(alice, word)
    const sel = await selection(alice)
    await aa(alice).click()
    for (const f of FORMATS) await panel(alice).getByRole('button', { name: f.label }).click()
    await close(alice, how)

    expect(await marksOn(alice, word), how).toEqual(['fontSize=24', 'highlight=yellow', 'textColor=red'])
    const span = editor(alice).locator('.fs-24', { hasText: word })
    await expect(span).toHaveCSS('font-size', '24px')
    await expect(editor(alice).locator('.tc-red', { hasText: word })).toBeVisible()
    await expect(editor(alice).locator('mark.hl-yellow', { hasText: word })).toBeVisible()
    // The selection is untouched, and the editor still has focus (typing goes on in it).
    expect(await selection(alice), how).toEqual(sel)
    await expect(editor(alice), how).toBeFocused()
  }

  // Moving the cursor elsewhere doesn't change formatted text.
  await freshParagraph(alice)
  await alice.page.keyboard.type('elsewhere')
  expect(await marksOn(alice, 'selectedEscape')).toEqual(['fontSize=24', 'highlight=yellow', 'textColor=red'])
  expect(await marksOn(alice, 'elsewhere')).toEqual([])
  await alice.context.close()
})

test('with a bare cursor, the chosen size, color or highlight applies to what is typed next', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Typing next')
  for (const how of CLOSES) {
    for (const f of FORMATS) {
      const word = `${f.cls}${how.replace(/\W/g, '')}`
      await freshParagraph(alice)
      const at = await selection(alice)
      await aa(alice).click()
      await panel(alice).getByRole('button', { name: f.label }).click()
      await close(alice, how)
      expect(await selection(alice), `${how}: the cursor stays put`).toEqual(at)
      await alice.page.keyboard.type(word)
      expect(await marksOn(alice, word), `${f.label}, closed with ${how}`).toEqual([f.mark])
      // And it keeps applying while typing continues.
      await alice.page.keyboard.type(' more')
      expect(await marksOn(alice, `${word} more`), `${f.label}, closed with ${how}`).toEqual([f.mark])
    }
  }
  await alice.context.close()
})

test('the panel shows the formatting at the selection: after reopening, after moving, and for mixed selections', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Indicators')
  const pressed = (group: 'Size' | 'Text color' | 'Highlight') =>
    panel(alice).getByRole('group', { name: group }).locator('[aria-pressed="true"]')

  await selectedParagraph(alice, 'big')
  await aa(alice).click()
  await panel(alice).getByRole('button', { name: 'Font size 24px' }).click()
  await panel(alice).getByRole('button', { name: 'Text color Blue' }).click()
  await alice.page.keyboard.press('Escape')

  // Reopened on the same selection: what it has.
  await aa(alice).click()
  await expect(pressed('Size')).toHaveAccessibleName('Font size 24px')
  await expect(pressed('Text color')).toHaveAccessibleName('Text color Blue')
  await expect(pressed('Highlight')).toHaveAccessibleName('No highlight')
  await alice.page.keyboard.press('Escape')

  // A cursor in plain text: the defaults.
  await selectedParagraph(alice, 'plain')
  await editor(alice).evaluate((el) => (el as TiptapEl).editor.commands.setTextSelection((el as TiptapEl).editor.state.selection.to))
  await aa(alice).click()
  await expect(pressed('Size')).toHaveAccessibleName('Font size 16px (default)')
  await expect(pressed('Text color')).toHaveAccessibleName('Default text color')
  await alice.page.keyboard.press('Escape')

  // A selection over "big" (24px, blue) and "plain" (16px, default): mixed, nothing pressed.
  await editor(alice).evaluate((el) => {
    const e = (el as TiptapEl).editor
    e.commands.setTextSelection({ from: 1, to: e.state.doc.content.size - 1 })
  })
  await aa(alice).click()
  await expect(pressed('Size')).toHaveCount(0)
  await expect(pressed('Text color')).toHaveCount(0)
  await expect(panel(alice).getByText('Mixed')).toHaveCount(2) // size and color
  await expect(pressed('Highlight')).toHaveAccessibleName('No highlight') // the same throughout: none
  // Applying to a mixed selection makes it uniform.
  await panel(alice).getByRole('button', { name: 'Font size 18px' }).click()
  await expect(pressed('Size')).toHaveAccessibleName('Font size 18px')
  expect(await marksOn(alice, 'plain')).toEqual(['fontSize=18'])
  expect(await marksOn(alice, 'big')).toEqual(['fontSize=18', 'textColor=blue'])
  await alice.context.close()
})

test('formatting persists after reload and reaches a collaborator; the panel never changes the document or recreates the editor', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(alice)
  await register(bob)
  const docId = await createDoc(alice, 'Shared formatting')
  await share(alice, bob)
  await bob.page.goto(`/#/d/${docId}`)
  await expect(editor(bob)).toHaveAttribute('contenteditable', 'true')

  await selectedParagraph(alice, 'styled')
  await aa(alice).click()
  for (const f of FORMATS) await panel(alice).getByRole('button', { name: f.label }).click()
  await alice.page.keyboard.press('Escape')
  await freshParagraph(alice)
  await aa(alice).click()
  await panel(alice).getByRole('button', { name: 'Font size 32px' }).click()
  await alice.page.keyboard.press('Escape')
  await alice.page.keyboard.type('typed')
  await saved(alice)

  // Bob receives it, live.
  for (const f of FORMATS) await expect(editor(bob).locator(`.${f.cls}`, { hasText: 'styled' })).toBeVisible()
  await expect(editor(bob).locator('.fs-32', { hasText: 'typed' })).toBeVisible()
  expect(await marksOn(bob, 'styled')).toEqual(['fontSize=24', 'highlight=yellow', 'textColor=red'])

  // Opening and closing the panel, every way, changes nothing and sends nothing.
  await editor(alice).evaluate((el) => {
    ;(el as TiptapEl & { __mark?: boolean }).__mark = true
    ;(window as unknown as { __ed: unknown }).__ed = (el as TiptapEl).editor
  })
  const json = await docJSON(alice)
  const before = updatesSent(alice)
  for (let i = 0; i < 2; i++) {
    for (const how of CLOSES) {
      await aa(alice).click()
      await expect(panel(alice)).toBeVisible()
      await close(alice, how)
    }
  }
  await alice.page.waitForTimeout(300)
  expect(updatesSent(alice)).toBe(before)
  expect(await docJSON(alice)).toBe(json)
  expect(
    await editor(alice).evaluate(
      (el) => (el as TiptapEl & { __mark?: boolean }).__mark === true && (window as unknown as { __ed: unknown }).__ed === (el as TiptapEl).editor,
    ),
  ).toBe(true)

  // Reload: it's in the stored document.
  await bob.page.reload()
  await expect(editor(bob)).toHaveAttribute('contenteditable', 'true')
  expect(await marksOn(bob, 'styled')).toEqual(['fontSize=24', 'highlight=yellow', 'textColor=red'])
  expect(await marksOn(bob, 'typed')).toEqual(['fontSize=32'])
  await expect(editor(bob).locator('.fs-24', { hasText: 'styled' })).toHaveCSS('font-size', '24px')
  for (const u of [alice, bob]) await u.context.close()
})

test('keyboard: the panel opened from the toolbar returns focus to the Aa button on Escape', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Keyboard')
  await aa(alice).focus()
  await alice.page.keyboard.press('Enter')
  await expect(panel(alice)).toBeVisible()
  await alice.page.keyboard.press('Escape')
  await expect(panel(alice)).toHaveCount(0)
  await expect(aa(alice)).toBeFocused()
  await alice.context.close()
})
