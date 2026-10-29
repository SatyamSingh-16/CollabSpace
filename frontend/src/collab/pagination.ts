// Automatic pagination, computed per viewer and drawn as decorations.
//
// Nothing here writes to the Y.Doc. The page layout is a view-only
// ProseMirror plugin: it measures the rendered document, decides where
// pages start (collab/paginate.ts), and draws page gaps as widget
// decorations, applied with a meta-only transaction (no document change, so
// y-prosemirror writes nothing; pagination.test.ts checks this).
//
// Measurement uses *natural* coordinates: every DOM position minus the
// heights of the gaps already drawn above it. The paged layout (styles.css,
// .is-paged) uses top margins only and no margin collapsing through
// parents, so inserting a gap never changes the layout of anything else:
// measuring with the gaps in place gives the same natural layout as
// measuring without them, and a pass whose result equals the current one
// dispatches nothing. That's what keeps it from looping.
//
// Invalidation:
// - document changes (local or remote): from the first changed position
//   (findDiffStart), re-paginate from one page before the page containing
//   it (a change can pull content back onto the previous page). Earlier
//   pages are reused as they are.
// - width changes, fonts loading, zoom: a full pass.
// All coalesced to at most one pass per animation frame.
import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state'
import { Mapping, ReplaceStep, StepMap } from '@tiptap/pm/transform'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

import { gapHeights, lastPageFill, paginate, type Break, type Line, type Unit } from './paginate'
import type { PageGeometry } from './pageSettings'

/** Space between two sheets on screen, CSS px. */
export const PAGE_GAP = 28
/** Packing tolerance: pages are filled to this much less than their height, so print never spills a line over. */
const SAFETY = 2

interface DrawnBreak extends Break {
  height: number
  /** Top margin of the block after a block break: the gap ends that far above the page's content. */
  lead: number
}

export interface PaginationState {
  enabled: boolean
  decorations: DecorationSet
  breaks: DrawnBreak[]
  /** Document position where each page starts (page 1 starts at 0). */
  pageStarts: number[]
}

export const paginationKey = new PluginKey<PaginationState>('pagination')

const EMPTY: PaginationState = { enabled: false, decorations: DecorationSet.empty, breaks: [], pageStarts: [0] }

export interface LayoutInfo {
  pages: number
  /** Blank space at the bottom of the last page (the sheet's padding makes it a full page). */
  lastFill: number
}

export interface PaginationController {
  extension: Extension
  /** Page geometry, whether paged layout is on, and the on-screen scale. */
  configure(opts: { geometry: PageGeometry; enabled: boolean; scale: number }): void
  /** Called after every layout change (pages, last-page fill). */
  onLayout(cb: (info: LayoutInfo) => void): () => void
  /** Scrolls to page `n` (1-based) and puts the cursor at its start. */
  goToPage(n: number): void
  /** For tests: how many layout passes ran, and how many changed the decorations. */
  stats(): { passes: number; dispatches: number }
}

const CONTAINERS = new Set(['bulletList', 'orderedList', 'listItem', 'blockquote'])

export function createPagination(): PaginationController {
  let view: EditorView | null = null
  let geometry: PageGeometry | null = null
  let enabled = false
  let scale = 1
  let frame = 0
  let full = true
  let minChanged = Infinity
  let churn = 0 // consecutive changed results without a document change
  let passes = 0
  let dispatches = 0
  let lastWidth = 0
  const listeners = new Set<(info: LayoutInfo) => void>()

  const schedule = (all = false) => {
    full ||= all
    if (frame || !view) return
    frame = requestAnimationFrame(() => {
      frame = 0
      layout()
    })
  }

  const dispatch = (next: PaginationState) => {
    if (!view) return
    dispatches++
    view.dispatch(view.state.tr.setMeta(paginationKey, next).setMeta('addToHistory', false))
  }

  // --- measuring -----------------------------------------------------------

  const measure = (v: EditorView, fromIndex: number) => {
    // Coordinates start at the content box: the sheet's margins are the
    // editable element's padding (so clicking in a margin places the caret).
    const box = v.dom.getBoundingClientRect()
    const cs = getComputedStyle(v.dom)
    const root = {
      top: box.top + (parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop)) * scale,
      left: box.left + (parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft)) * scale,
    }
    const gaps = [...v.dom.querySelectorAll<HTMLElement>('.page-gap')]
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { top: (r.top - root.top) / scale, height: r.height / scale }
      })
      .sort((a, b) => a.top - b.top)
    const natural = (screenY: number) => {
      const y = (screenY - root.top) / scale
      let shift = 0
      for (const g of gaps) if (g.top < y - 0.01) shift += g.height
      return y - shift
    }

    // Line boxes of a textblock, from its text's rectangles (not the gap
    // widgets inside it). Half-leading is split evenly between lines.
    const linesOf = (dom: HTMLElement): Line[] => {
      const rects: DOMRect[] = []
      const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if ((t.parentElement as HTMLElement | null)?.closest('.page-gap')) continue
        const range = document.createRange()
        range.selectNodeContents(t)
        rects.push(...[...range.getClientRects()].filter((r) => r.height > 0))
      }
      rects.sort((a, b) => a.top - b.top)
      const rows: { top: number; bottom: number; left: number }[] = []
      for (const r of rects) {
        const row = rows[rows.length - 1]
        if (row && r.top < row.bottom - 1) {
          row.bottom = Math.max(row.bottom, r.bottom)
          row.left = Math.min(row.left, r.left)
        } else rows.push({ top: r.top, bottom: r.bottom, left: r.left })
      }
      const box = dom.getBoundingClientRect()
      return rows.map((row, k) => {
        const top = k === 0 ? box.top : (rows[k - 1].bottom + row.top) / 2
        const bottom = k === rows.length - 1 ? box.bottom : (row.bottom + rows[k + 1].top) / 2
        const at = v.posAtCoords({ left: row.left + 1, top: (row.top + row.bottom) / 2 })
        return { pos: at ? at.pos : 0, top: natural(top), bottom: natural(bottom) }
      })
    }

    const unitOf = (node: PMNode, pos: number): Unit | null => {
      const dom = v.nodeDOM(pos)
      if (!(dom instanceof HTMLElement)) return null
      const r = dom.getBoundingClientRect()
      const base = { pos, top: natural(r.top), bottom: natural(r.bottom), indent: (r.left - root.left) / scale }
      if (node.type.name === 'pageBreak') return { ...base, kind: 'pageBreak' }
      if (CONTAINERS.has(node.type.name)) {
        const children: Unit[] = []
        node.forEach((child, offset) => {
          const u = unitOf(child, pos + 1 + offset)
          if (u) children.push(u)
        })
        return { ...base, kind: 'container', children }
      }
      if (node.isTextblock) {
        const content = (node.type.name === 'codeBlock' ? dom.querySelector('code') : null) ?? dom
        let lines: Line[] | null = null
        return { ...base, kind: 'leaf', heading: node.type.name === 'heading', lines: () => (lines ??= linesOf(content)) }
      }
      return { ...base, kind: 'leaf' }
    }

    const units: Unit[] = []
    v.state.doc.forEach((node, offset, index) => {
      if (index < fromIndex) return
      const u = unitOf(node, offset)
      if (u) units.push(u)
    })
    return units
  }

  // --- layout ----------------------------------------------------------------

  const layout = () => {
    const v = view
    if (!v || !geometry) return
    const current = paginationKey.getState(v.state) ?? EMPTY
    if (!enabled) {
      if (current.enabled || current.breaks.length) dispatch(EMPTY)
      notify(1, 0)
      return
    }
    passes++
    const height = geometry.contentHeight - SAFETY
    const pitch = geometry.contentHeight + 2 * geometry.margin + PAGE_GAP

    // Restart one page before the first change; reuse the pages before it.
    let kept: DrawnBreak[] = []
    let fromIndex = 0
    let startTop = 0
    if (!full && current.enabled && current.breaks.length) {
      const before = current.breaks.filter((b) => b.pos < minChanged)
      const restart = before.length - 2 // the page before the changed one
      if (restart >= 0) {
        kept = current.breaks.slice(0, restart + 1)
        const pageStart = kept[kept.length - 1]
        fromIndex = topLevelIndex(v.state.doc, pageStart.pos)
        startTop = pageStart.top
      }
    }
    const docChanged = minChanged !== Infinity
    full = false
    minChanged = Infinity

    const units = measure(v, fromIndex)
    const plan = paginate(units, height, startTop)
    const breaks = [...kept.map(({ height: _h, lead: _l, ...b }) => b), ...plan.breaks.map((b) => hoist(v.state.doc, b))]
    const heights = gapHeights(breaks, pitch)
    const drawn: DrawnBreak[] = breaks.map((b, k) => ({ ...b, height: heights[k], lead: leadOf(v, b) }))

    const same =
      current.enabled &&
      drawn.length === current.breaks.length &&
      drawn.every(
        (b, k) =>
          b.pos === current.breaks[k].pos &&
          Math.abs(b.height - current.breaks[k].height) < 0.5 &&
          Math.abs(b.lead - current.breaks[k].lead) < 0.5,
      )
    if (!same) {
      // A loop guard: the document didn't change, yet the result keeps
      // changing. Natural coordinates should rule this out; if it ever
      // happens, stop rather than flicker forever.
      churn = docChanged ? 0 : churn + 1
      if (churn > 4) return
      const total = drawn.length + 1
      const decorations = DecorationSet.create(
        v.state.doc,
        drawn.map((b, k) =>
          Decoration.widget(b.pos, () => gapElement(b, k + 1, total), {
            // A block gap belongs to the block after it (it survives the
            // block before being replaced); a line gap goes before the
            // cursor, so a cursor at the line's start shows on the new page.
            side: b.kind === 'block' ? 1 : -1,
            key: `page-gap-${k}-${b.kind}-${b.height.toFixed(1)}-${b.lead.toFixed(1)}-${b.indent.toFixed(0)}-${total}`,
            ignoreSelection: true,
            stopEvent: () => true,
          }),
        ),
      )
      dispatch({ enabled: true, decorations, breaks: drawn, pageStarts: [0, ...drawn.map((b) => b.pos)] })
    } else churn = 0
    notify(drawn.length + 1, lastPageFill({ ...plan, breaks }, geometry.contentHeight))
  }

  const notify = (pages: number, lastFill: number) => listeners.forEach((cb) => cb({ pages, lastFill }))

  // --- the plugin --------------------------------------------------------------

  const plugin = new Plugin<PaginationState>({
    key: paginationKey,
    state: {
      init: () => EMPTY,
      apply(tr, value) {
        const meta = tr.getMeta(paginationKey) as PaginationState | undefined
        if (meta) return meta
        if (!tr.docChanged || !value.enabled) return value
        // Keep the gaps attached to their content until the next pass. A
        // break whose content was replaced (y-tiptap replaces each changed
        // block, local or remote) is dropped, with every break after it:
        // the next pass only reuses breaks that are still valid, and lays
        // out the rest from scratch.
        const mapping = changeMapping(tr)
        const breaks: DrawnBreak[] = []
        for (const b of value.breaks) {
          const mapped = mapping.mapResult(b.pos, b.kind === 'block' ? 1 : -1)
          if (mapped.deleted) break
          breaks.push({ ...b, pos: mapped.pos })
        }
        return {
          ...value,
          decorations: value.decorations.map(mapping, tr.doc),
          breaks,
          pageStarts: [0, ...breaks.map((b) => b.pos)],
        }
      },
    },
    props: {
      decorations: (state) => paginationKey.getState(state)?.decorations ?? DecorationSet.empty,
    },
    view: (v) => {
      view = v
      // Width changes (sidebar, outline, window). Without ResizeObserver
      // (very old browsers, jsdom), the window's resize event still covers
      // most of them.
      const resize =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => {
              const w = v.dom.clientWidth
              if (Math.abs(w - lastWidth) > 0.5) {
                lastWidth = w
                schedule(true)
              }
            })
      resize?.observe(v.dom)
      const onFonts = () => schedule(true)
      document.fonts?.addEventListener?.('loadingdone', onFonts)
      document.fonts?.ready.then(onFonts, () => {})
      const onZoom = () => schedule(true) // zoom changes text rendering slightly
      window.addEventListener('resize', onZoom)
      schedule(true)
      return {
        update: (updated, prev) => {
          if (updated.state.doc === prev.doc) return
          const diff = prev.doc.content.findDiffStart(updated.state.doc.content)
          minChanged = Math.min(minChanged, diff ?? 0)
          schedule()
        },
        destroy: () => {
          resize?.disconnect()
          document.fonts?.removeEventListener?.('loadingdone', onFonts)
          window.removeEventListener('resize', onZoom)
          // A newer view may already have taken over (an editor re-created
          // by React): only let go of our own.
          if (view !== v) return
          if (frame) cancelAnimationFrame(frame)
          frame = 0
          view = null
        },
      }
    },
  })

  return {
    extension: Extension.create({ name: 'pagination', addProseMirrorPlugins: () => [plugin] }),
    configure(opts) {
      const changed = opts.enabled !== enabled || opts.scale !== scale || geometry === null ||
        opts.geometry.width !== geometry.width || opts.geometry.height !== geometry.height
      geometry = opts.geometry
      enabled = opts.enabled
      scale = opts.scale
      if (changed) schedule(true)
    },
    onLayout(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    goToPage(n) {
      const v = view
      if (!v || !geometry) return
      const state = paginationKey.getState(v.state)
      const pos = state?.pageStarts[n - 1] ?? 0
      const sheet = v.dom.closest('.paper')
      if (sheet instanceof HTMLElement) {
        const pitch = geometry.height + PAGE_GAP
        const top = sheet.getBoundingClientRect().top + window.scrollY + (n - 1) * pitch * scale - 72
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        window.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
      }
      v.focus()
      const $pos = v.state.doc.resolve(Math.min(pos + 1, v.state.doc.content.size))
      v.dispatch(v.state.tr.setSelection(TextSelection.near($pos))) // a selection change only
    },
    stats: () => ({ passes, dispatches }),
  }
}

/**
 * How positions move in a transaction. y-tiptap usually replaces only the
 * changed blocks, but some updates (a forced re-render, a change it can't
 * express as one step) replace the whole document, and that step's mapping
 * would delete every page gap. For such a step, map by what actually
 * changed: the range between the first and last difference of the two
 * documents.
 */
function changeMapping(tr: Transaction): Mapping {
  const step = tr.steps.length === 1 ? tr.steps[0] : null
  const whole = step instanceof ReplaceStep && step.from === 0 && step.to === tr.before.content.size
  if (!whole) return tr.mapping
  const start = tr.before.content.findDiffStart(tr.doc.content)
  if (start === null) return new Mapping()
  let { a, b } = tr.before.content.findDiffEnd(tr.doc.content)!
  const overlap = start - Math.min(a, b)
  if (overlap > 0) {
    a += overlap
    b += overlap
  }
  return new Mapping([new StepMap([start, a - start, b - start])])
}

/**
 * A break before the first child of a list, list item or quote goes before
 * the container instead (same top): between list items, not inside one,
 * so the item's marker stays with its text.
 */
function hoist(doc: PMNode, b: Break): Break {
  if (b.kind !== 'block') return b
  let pos = b.pos
  for (;;) {
    const $pos = doc.resolve(pos)
    if ($pos.depth === 0 || $pos.index() !== 0 || !CONTAINERS.has($pos.parent.type.name)) break
    pos = $pos.before()
  }
  return pos === b.pos ? b : { ...b, pos }
}

/** The top margin of the block a block break goes before (CSS px, unscaled). */
function leadOf(v: EditorView, b: Break): number {
  if (b.kind !== 'block') return 0
  const dom = v.nodeDOM(b.pos)
  return dom instanceof HTMLElement ? parseFloat(getComputedStyle(dom).marginTop) || 0 : 0
}

/** Index of the top-level node containing `pos`. */
function topLevelIndex(doc: PMNode, pos: number): number {
  let index = 0
  doc.forEach((_node, offset, i) => {
    if (offset <= pos) index = i
  })
  return index
}

/**
 * A page gap: the rest of the page, its bottom margin with the page number,
 * the space between sheets, and the next page's top margin. Decorative and
 * outside the document (contenteditable=false, aria-hidden).
 */
function gapElement(b: DrawnBreak, page: number, total: number): HTMLElement {
  const el = document.createElement(b.kind === 'line' ? 'span' : 'div')
  el.className = 'page-gap'
  el.contentEditable = 'false'
  el.setAttribute('aria-hidden', 'true')
  el.dataset.page = String(page)
  // CSSOM custom properties (not a style attribute): allowed by the CSP.
  el.style.setProperty('--gap-h', `${b.height}px`)
  el.style.setProperty('--gap-indent', `${b.indent}px`)
  el.style.setProperty('--gap-lead', `${b.lead}px`)
  const footer = document.createElement('span')
  footer.className = 'page-number'
  footer.textContent = `${page} / ${total}`
  const band = document.createElement('span')
  band.className = 'page-band'
  el.append(footer, band)
  return el
}
