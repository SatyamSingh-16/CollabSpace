// Automatic pagination in real Chromium (docs/decisions/0002-pagination.md).
// Page boundaries are computed per viewer from the rendered layout and drawn
// as decorations; these tests check where they fall, that they follow edits,
// resizes and page-setup changes, that printing matches them, and that they
// never reach the shared document (no Yjs updates of their own).
// Needs PostgreSQL: COLLABSPACE_TEST_DATABASE_URL. Run: npx playwright test
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'

import { AppServer, buildServer, DATABASE_URL } from '../e2e/harness'

const BACKEND_PORT = 18080
const APP = 'http://localhost:15173'
const WIDE = { width: 1600, height: 1000 } // an A4 sheet fits at full size

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

async function newUser(browser: Browser, name: string, viewport = WIDE): Promise<User> {
  const context = await browser.newContext({ viewport })
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
  await expect(u.page.getByRole('status')).toContainText('Connected')
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

async function openDoc(u: User, docId: string) {
  await u.page.goto(`/#/d/${docId}`)
  await expect(u.page.getByRole('status')).toContainText('Connected')
}

const editor = (u: User) => u.page.locator('.tiptap')

/**
 * Puts the cursor at the start or end of the document (a selection change
 * only). Keyboard shortcuts for this differ by platform: Ctrl/Cmd+End is
 * not "end of document" in Chromium on macOS.
 */
async function cursorTo(u: User, where: 'start' | 'end') {
  await expect(editor(u)).toHaveAttribute('contenteditable', 'true') // editable once synced
  await editor(u).evaluate((el, w) => (el as HTMLElement & { editor: { commands: { focus(p: string): void } } }).editor.commands.focus(w), where)
  await expect(editor(u)).toBeFocused() // Tiptap focuses in the next frame
}
const updatesSent = (u: User) => u.sent.filter((f) => f.includes('"type":"update"')).length

/** Waits until every local edit is committed ("Saved"). */
async function saved(u: User) {
  await expect(u.page.getByRole('status')).toContainText('Saved')
}

/** Filler text; `seed` varies it so paragraphs differ. */
const words = (n: number, seed = 0) => Array.from({ length: n }, (_, k) => `word${(k * 7 + seed) % 97}`).join(' ')

/**
 * Types blocks at the end of the document, one per line. A block starting
 * with "## " becomes a heading and "- " a list item, through the editor's
 * input rules, as when a person types them.
 */
async function typeBlocks(u: User, blocks: string[]) {
  await cursorTo(u, 'end')
  for (const [i, block] of blocks.entries()) {
    const m = /^(## |- )/.exec(block)
    if (m) await u.page.keyboard.type(m[1])
    await u.page.keyboard.insertText(block.slice(m ? m[1].length : 0))
    if (i < blocks.length - 1) await u.page.keyboard.press('Enter')
  }
  await saved(u)
}

const paragraphs = (count: number, length = 60, label = 'Paragraph') =>
  Array.from({ length: count }, (_, i) => `${label} ${i + 1}. ${words(length, i)}`)

interface Layout {
  paged: boolean
  /** Pages drawn: page gaps + 1. */
  pages: number
  /** Pages the sheet is tall (it should be a whole number of pages). */
  sheetPages: number
  /** Gaps inside a paragraph (a split between lines), and between blocks. */
  lineGaps: number
  blockGaps: number
  /** Lines of text that are outside a page's content area (in a margin, a gap or off the sheet). */
  outside: string[]
  /** Pages with no text on them (an unintended blank page). */
  blankPages: number[]
  /** The text of the document, without the page decorations. */
  text: string
}

/**
 * The page view as rendered, once it has settled. Every line of text must
 * lie inside its page's content area: below the top margin, above the
 * bottom margin. That one check covers moved blocks, split paragraphs,
 * lists, headings and every page size.
 */
async function layout(u: User): Promise<Layout> {
  let last = ''
  for (let i = 0; i < 30; i++) {
    const now = await u.page.evaluate(
      () =>
        new Promise<string>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const gaps = [...document.querySelectorAll<HTMLElement>('.tiptap .page-gap')]
              resolve(gaps.map((g) => `${g.tagName}${g.getBoundingClientRect().height.toFixed(1)}`).join(','))
            }),
          ),
        ),
    )
    if (now === last) break
    last = now
  }
  return u.page.evaluate(() => {
    const tiptap = document.querySelector<HTMLElement>('.tiptap')!
    const sheet = document.querySelector<HTMLElement>('.paper')!
    const cell = getComputedStyle(document.querySelector('.paper-cell')!)
    const num = (v: string) => parseFloat(cell.getPropertyValue(v))
    const [H, M, G, scale] = [num('--page-h'), num('--sheet-margin'), num('--page-gap'), num('--page-scale')]
    const paged = !!document.querySelector('.editor-body.is-paged')
    const gaps = [...tiptap.querySelectorAll<HTMLElement>('.page-gap')]
    const sheetTop = sheet.getBoundingClientRect().top
    const pitch = (H + G) * scale
    const outside: string[] = []
    const inked = new Set<number>()
    let text = ''
    const walker = document.createTreeWalker(tiptap, NodeFilter.SHOW_TEXT)
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (t.parentElement?.closest('.page-gap')) continue
      text += t.textContent
      if (!paged) continue
      const range = document.createRange()
      range.selectNodeContents(t)
      for (const r of range.getClientRects()) {
        if (r.height === 0) continue
        const y0 = r.top - sheetTop
        const y1 = r.bottom - sheetTop
        const k = Math.floor(y0 / pitch)
        inked.add(k)
        const top = k * pitch + M * scale
        const bottom = k * pitch + (H - M) * scale
        if (y0 < top - 1 || y1 > bottom + 1)
          outside.push(`page ${k + 1}: ${y0.toFixed(1)}–${y1.toFixed(1)} not in ${top.toFixed(1)}–${bottom.toFixed(1)}: "${(t.textContent ?? '').slice(0, 30)}"`)
      }
    }
    return {
      paged,
      pages: gaps.length + 1,
      sheetPages: (sheet.getBoundingClientRect().height / scale + G) / (H + G),
      lineGaps: gaps.filter((g) => g.tagName === 'SPAN').length,
      blockGaps: gaps.filter((g) => g.tagName === 'DIV').length,
      outside,
      blankPages: paged ? Array.from({ length: gaps.length + 1 }, (_, k) => k + 1).filter((n) => !inked.has(n - 1)) : [],
      text,
    }
  })
}

/** Every page is whole, and no text is outside its page's content area. */
function expectClean(l: Layout) {
  expect(l.paged).toBe(true)
  expect(l.outside).toEqual([])
  expect(l.blankPages).toEqual([])
  expect(l.sheetPages).toBeCloseTo(l.pages, 2)
}

/** The sheet's page size, CSS px (unscaled). */
const sheetSize = (u: User) =>
  u.page.evaluate(() => {
    const cell = getComputedStyle(document.querySelector('.paper-cell')!)
    const px = (v: string) => Math.round(parseFloat(cell.getPropertyValue(v)) * 10) / 10
    return { width: px('--sheet-width'), height: px('--page-h') }
  })

/** Counts PDF pages (Chromium's PDFs list one /Type /Page object per page). */
const pdfPages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
/** The distinct page sizes in a PDF, in points (A4 is 595 × 842). */
const pdfSizes = (pdf: Buffer) => [
  ...new Set([...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)].map((m) => `${Math.round(+m[1])}x${Math.round(+m[2])}`)),
]

test('automatic page boundaries: blocks move whole, edits and undo re-paginate, reload keeps it', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  const docId = await createDoc(alice, 'Pages')
  await expect(alice.page.getByRole('button', { name: 'Page setup: A4, portrait' })).toBeVisible() // the default

  await typeBlocks(alice, paragraphs(24))
  const first = await layout(alice)
  expectClean(first)
  expect(first.pages).toBeGreaterThanOrEqual(4)
  expect(first.lineGaps).toBe(0) // every paragraph fits a page: moved whole, never split
  expect(await alice.page.locator('.tiptap > p').count()).toBe(24)
  await expect(alice.page.locator('.paper')).toHaveAttribute('data-last-page', `${first.pages} / ${first.pages}`)

  // An edit near the top pushes content down every page after it. (After a
  // pause: edits within 500 ms are one undo step.)
  await alice.page.waitForTimeout(700)
  await alice.page.locator('.tiptap > p').nth(1).click()
  await alice.page.keyboard.press('End')
  await alice.page.keyboard.insertText(' ' + words(400, 3))
  await saved(alice)
  const longer = await layout(alice)
  expectClean(longer)
  expect(longer.pages).toBeGreaterThan(first.pages)

  // Undo takes it back, and the pages with it.
  await alice.page.keyboard.press('ControlOrMeta+z')
  await saved(alice)
  const undone = await layout(alice)
  expectClean(undone)
  expect(undone.pages).toBe(first.pages)
  expect(undone.text).toBe(first.text)

  await alice.page.reload()
  await expect(alice.page.getByRole('status')).toContainText('Connected')
  const reloaded = await layout(alice)
  expectClean(reloaded)
  expect(reloaded.pages).toBe(first.pages)
  expect(reloaded.text).toBe(first.text)
  expect(docId).toBeTruthy()
  await alice.context.close()
})

test('pagination never changes the shared document: resizes and re-layouts send no updates', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Layout only')
  await typeBlocks(alice, paragraphs(18))
  const wide = await layout(alice)
  expectClean(wide)
  // Mark the editor's DOM node: a re-created editor would lose the mark.
  await editor(alice).evaluate((el) => ((el as HTMLElement & { __mark?: boolean }).__mark = true))
  const before = updatesSent(alice)
  expect(before).toBeGreaterThan(0) // the recorder does see edits

  // Narrower: the sheet is scaled down, the pages are recomputed.
  await alice.page.setViewportSize({ width: 1180, height: 900 })
  const scaled = await layout(alice)
  expectClean(scaled)
  expect(scaled.pages).toBe(wide.pages) // the same sheet, only smaller on screen
  // The outline (open by default on wide windows) narrows the column further.
  await alice.page.setViewportSize({ width: 1300, height: 900 })
  const outline = alice.page.getByRole('button', { name: 'Outline' })
  if ((await outline.getAttribute('aria-expanded')) !== 'true') await outline.click()
  const outlined = await layout(alice)
  expectClean(outlined)
  await expect(alice.page.locator('.outline-pages .outline-link')).toHaveCount(outlined.pages)
  // Go to the last page from the outline: the cursor lands there.
  await alice.page.locator('.outline-pages .outline-link').last().click()
  await expect(alice.page.locator('.outline-pages .outline-link').last()).toHaveAttribute('aria-current', 'page')

  // Phone width: pages would be unreadable, so the document flows continuously.
  await alice.page.setViewportSize({ width: 420, height: 860 })
  const phone = await layout(alice)
  expect(phone.paged).toBe(false)
  expect(phone.pages).toBe(1)
  expect(phone.text).toBe(wide.text)

  await alice.page.setViewportSize(WIDE)
  const back = await layout(alice)
  expectClean(back)
  expect(back.pages).toBe(wide.pages)

  await alice.page.waitForTimeout(500) // anything pagination might have sent would be out by now
  expect(updatesSent(alice)).toBe(before)
  expect(await editor(alice).evaluate((el) => (el as HTMLElement & { __mark?: boolean }).__mark)).toBe(true)
  await saved(alice)
  await alice.context.close()
})

test('oversized paragraphs split between lines; manual page breaks start a new page', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Long paragraph')
  const giant = `Giant. ${words(1600, 5)} The end.`
  await typeBlocks(alice, ['Before.', giant])
  const split = await layout(alice)
  expectClean(split) // no line clipped or lost in a margin
  expect(split.pages).toBeGreaterThanOrEqual(3)
  expect(split.lineGaps).toBeGreaterThanOrEqual(2) // split inside the paragraph, several times
  expect(await alice.page.locator('.tiptap > p').count()).toBe(2) // still one paragraph
  expect(split.text).toBe('Before.' + giant) // every word is still there, in order

  // A manual break: the next block starts at the top of a new page.
  await cursorTo(alice, 'end')
  await alice.page.keyboard.press('Enter')
  await alice.page.keyboard.insertText('Last page of the giant ends here.')
  await alice.page.getByRole('button', { name: 'Insert page break' }).click()
  await alice.page.keyboard.insertText('After the break.')
  await saved(alice)
  const broken = await layout(alice)
  expectClean(broken)
  expect(broken.pages).toBeGreaterThan(split.pages) // and no blank page (expectClean)
  const offset = await alice.page.evaluate(() => {
    const p = [...document.querySelectorAll('.tiptap > p')].find((e) => e.textContent === 'After the break.')!
    const sheet = document.querySelector('.paper')!.getBoundingClientRect()
    const cell = getComputedStyle(document.querySelector('.paper-cell')!)
    const H = parseFloat(cell.getPropertyValue('--page-h'))
    const G = parseFloat(cell.getPropertyValue('--page-gap'))
    const M = parseFloat(cell.getPropertyValue('--sheet-margin'))
    const y = p.getBoundingClientRect().top - sheet.top
    return { y, expected: (document.querySelectorAll('.tiptap .page-gap').length) * (H + G) + M }
  })
  expect(Math.abs(offset.y - offset.expected)).toBeLessThan(1.5)
  await alice.context.close()
})

test('headings stay with the text after them; long lists break between items', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Structure')
  const blocks: string[] = []
  for (let i = 0; i < 16; i++) blocks.push(`## Section ${i + 1}`, `Body ${i + 1}. ${words(25 + ((i * 37) % 70), i)}`)
  await typeBlocks(alice, blocks)
  const sections = await layout(alice)
  expectClean(sections)
  expect(sections.pages).toBeGreaterThanOrEqual(3)
  // No page ends with a heading: the block before every page gap is not one.
  const endsWithHeading = await alice.page.evaluate(() =>
    [...document.querySelectorAll('.tiptap > .page-gap')].filter((g) => /^H[1-3]$/.test(g.previousElementSibling?.tagName ?? '')).length,
  )
  expect(endsWithHeading).toBe(0)
  expect(await alice.page.locator('.tiptap > h2').count()).toBe(16)

  // A long list after it.
  await cursorTo(alice, 'end')
  await alice.page.keyboard.press('Enter')
  // "- " starts the list; Enter continues it.
  await typeBlocks(alice, Array.from({ length: 90 }, (_, i) => `${i === 0 ? '- ' : ''}Item ${i + 1} ${words(6 + (i % 9), i)}`))
  const list = await layout(alice)
  expectClean(list)
  expect(await alice.page.locator('.tiptap > ul > li').count()).toBe(90)
  expect(await alice.page.locator('.tiptap ul > .page-gap').count()).toBeGreaterThanOrEqual(2) // between items
  await alice.context.close()
})

test('page setup: shared by everyone, persisted, re-paginates; viewers cannot change it', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  const carol = await newUser(browser, 'Carol')
  await register(alice)
  await register(bob)
  await register(carol)
  const docId = await createDoc(alice, 'Setup')
  await typeBlocks(alice, paragraphs(14))
  await share(alice, bob, 'editor')
  await share(alice, carol, 'viewer')
  await openDoc(bob, docId)
  const portrait = await layout(bob)
  expectClean(portrait)

  await alice.page.getByRole('button', { name: /^Page setup:/ }).click()
  await alice.page.getByRole('button', { name: 'Landscape' }).click()
  await saved(alice)
  // Bob's view follows: landscape sheets (A4 is 297 × 210 mm). expectClean
  // measures against the new page height, so stale breaks would fail it.
  await expect(bob.page.locator('.paper')).toHaveClass(/page-a4-landscape/)
  const landscape = await layout(bob)
  expectClean(landscape)
  expect(await sheetSize(bob)).toEqual({ width: 1122.5, height: 793.7 })
  expect(landscape.text).toBe(portrait.text) // the content is untouched

  await alice.page.getByRole('button', { name: 'US Letter' }).click()
  await saved(alice)
  await expect(bob.page.locator('.paper')).toHaveClass(/page-letter-landscape/)
  expectClean(await layout(bob))
  expect(await sheetSize(bob)).toEqual({ width: 1056, height: 816 }) // 11 × 8.5 in

  await bob.page.reload()
  await expect(bob.page.getByRole('status')).toContainText('Connected')
  await expect(bob.page.locator('.paper')).toHaveClass(/page-letter-landscape/)
  await expect(bob.page.getByRole('button', { name: 'Page setup: US Letter, landscape' })).toBeVisible()

  await openDoc(carol, docId)
  await carol.page.getByRole('button', { name: /^Page setup:/ }).click()
  await expect(carol.page.getByRole('button', { name: 'Portrait' })).toBeDisabled()
  await expect(carol.page.getByText('Only editors can change the page setup.')).toBeVisible()
  for (const u of [alice, bob, carol]) await u.context.close()
})

test('concurrent editing while paginated: documents converge, each viewer paginates, no layout updates', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  const bob = await newUser(browser, 'Bob')
  await register(alice)
  await register(bob)
  const docId = await createDoc(alice, 'Together')
  await typeBlocks(alice, paragraphs(16))
  await share(alice, bob, 'editor')
  await openDoc(bob, docId)
  await layout(bob)

  // Both type at once: Alice at the top (moving every page), Bob at the end.
  const typeAt = async (u: User, where: 'start' | 'end', label: string) => {
    await cursorTo(u, where)
    for (let i = 0; i < 6; i++) {
      await u.page.keyboard.press('Enter')
      await u.page.keyboard.insertText(`${label} ${i}: ${words(70, i + label.length)}`)
    }
  }
  await Promise.all([typeAt(alice, 'start', 'Alice'), typeAt(bob, 'end', 'Bob')])
  await saved(alice)
  await saved(bob)

  const [a, b] = await Promise.all([layout(alice), layout(bob)])
  expectClean(a)
  expectClean(b)
  expect(b.text).toBe(a.text) // converged
  expect(a.text).toContain('Alice 5:')
  expect(a.text).toContain('Bob 5:')
  expect(b.pages).toBe(a.pages) // same window, same fonts: the same pages

  // Re-layouts on both sides send nothing.
  const sent = [updatesSent(alice), updatesSent(bob)]
  await Promise.all([alice.page.setViewportSize({ width: 1300, height: 900 }), bob.page.setViewportSize({ width: 1400, height: 900 })])
  expectClean(await layout(alice))
  expectClean(await layout(bob))
  await alice.page.waitForTimeout(500)
  expect([updatesSent(alice), updatesSent(bob)]).toEqual(sent)
  for (const u of [alice, bob]) await u.context.close()
})

test('print: the PDF has the page view’s pages, in the document’s page size', async ({ browser }) => {
  const alice = await newUser(browser, 'Alice')
  await register(alice)
  await createDoc(alice, 'Print')
  await typeBlocks(alice, ['## Report', ...paragraphs(12), `Long. ${words(900, 2)}`, '- One', 'Two', 'Three'])
  await alice.page.keyboard.press('Enter')
  await alice.page.keyboard.press('Enter') // out of the list
  await alice.page.getByRole('button', { name: 'Insert page break' }).click()
  await alice.page.keyboard.insertText('After a manual break.')
  await saved(alice)
  const screen = await layout(alice)
  expectClean(screen)
  const pdf = await alice.page.pdf({ preferCSSPageSize: true })
  expect(pdfPages(pdf)).toBe(screen.pages) // the same breaks; no trailing blank page
  expect(pdfSizes(pdf)).toEqual(['595x842'])

  await alice.page.getByRole('button', { name: /^Page setup:/ }).click()
  await alice.page.getByRole('button', { name: 'Landscape' }).click()
  await saved(alice)
  await expect(alice.page.locator('.paper')).toHaveClass(/page-a4-landscape/)
  const landscape = await layout(alice)
  expectClean(landscape)
  const pdf2 = await alice.page.pdf({ preferCSSPageSize: true })
  expect(pdfPages(pdf2)).toBe(landscape.pages)
  expect(pdfSizes(pdf2)).toEqual(['842x595'])
  await alice.context.close()
})
