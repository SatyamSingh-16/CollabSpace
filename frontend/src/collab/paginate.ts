// The page-packing algorithm: pure, no DOM, no editor. Given the document's
// blocks measured in *natural* coordinates (their layout without any page
// gaps), it decides where pages start. collab/pagination.ts measures the
// DOM, runs this, and renders the result as decorations; nothing here or
// there is ever written to the Y.Doc.
//
// Rules:
// - A block that doesn't fit on the current page moves to the next page
//   whole, if it fits on a fresh page.
// - A block taller than a whole page is split between lines (paragraphs,
//   headings, code blocks). A block that can't be split (a rule, say)
//   starts a fresh page and may run over: it is never clipped.
// - Lists and blockquotes break between their items, recursively.
// - A heading at the bottom of a page moves to the next page with the block
//   after it.
// - A manual page break ends the page; the next block starts a new one.
// - Every break moves strictly forward, so the loop always terminates.

export interface Line {
  /** Document position where the line starts. */
  pos: number
  top: number
  bottom: number
}

export interface Unit {
  /** Document position just before the node: where a page gap goes. */
  pos: number
  /** Natural y (CSS px, relative to the content top) of the border box. */
  top: number
  bottom: number
  kind: 'leaf' | 'container' | 'pageBreak'
  heading?: boolean
  children?: Unit[]
  /** For blocks that may be split between lines (textblocks). Lazy: only measured when needed. */
  lines?: () => Line[]
  /** Horizontal offset from the content's left edge (for drawing the gap). */
  indent?: number
}

export interface Break {
  /** Where the gap widget goes: before a block, or at the start of a line inside one. */
  pos: number
  kind: 'block' | 'line'
  /** Natural y at which the new page's content starts. */
  top: number
  indent: number
}

export interface PagePlan {
  breaks: Break[]
  /** Natural y of the bottom of the last content. */
  contentBottom: number
  /** CSS px of content that could not be fitted (unsplittable blocks taller than a page). */
  overflow: number
}

const EPS = 0.5 // sub-pixel tolerance

/**
 * Packs `units` (in document order) into pages of `height` px of content,
 * starting with a page whose content begins at natural y `startTop`.
 */
export function paginate(units: Unit[], height: number, startTop = 0): PagePlan {
  const breaks: Break[] = []
  let pageTop = startTop
  let forced = false
  let overflow = 0
  const limit = () => pageTop + height + EPS
  const isBreakAt = (pos: number) => breaks.some((b) => b.pos === pos)
  const newPage = (pos: number, top: number, kind: Break['kind'], indent = 0) => {
    if (top <= pageTop + EPS) return false // never a break that doesn't move forward
    breaks.push({ pos, kind, top, indent })
    pageTop = top
    return true
  }

  const splitLines = (u: Unit) => {
    const lines = u.lines?.() ?? []
    for (let guard = 0; u.bottom > limit() && guard < 100_000; guard++) {
      const j = lines.findIndex((l) => l.bottom > limit())
      if (j === -1) return // what remains (e.g. bottom padding) fits
      if (j === 0) {
        // Not even the first line fits here: start the block on a fresh page.
        if (newPage(u.pos, u.top, 'block', u.indent)) continue
      }
      if (lines[j].top <= pageTop + EPS) {
        // A single line taller than a page: it gets the page to itself.
        if (j + 1 < lines.length && newPage(lines[j + 1].pos, lines[j + 1].top, 'line', u.indent)) continue
        overflow += Math.max(0, lines[j].bottom - limit())
        return
      }
      if (!newPage(lines[j].pos, lines[j].top, 'line', u.indent)) return
    }
  }

  const placeLeaf = (u: Unit, siblings: Unit[], i: number) => {
    const fitsFreshPage = u.bottom - u.top <= height + EPS
    if (u.top > pageTop + EPS && fitsFreshPage) {
      // Keep with next: a heading just before it on this page goes along.
      const prev = siblings[i - 1]
      const target = prev?.heading && prev.top > pageTop + EPS && !isBreakAt(prev.pos) ? prev : u
      newPage(target.pos, target.top, 'block', target.indent)
      return
    }
    if (u.lines) {
      splitLines(u)
      return
    }
    // Too tall and can't be split: give it a fresh page; the rest runs over.
    newPage(u.pos, u.top, 'block', u.indent)
    overflow += Math.max(0, u.bottom - limit())
  }

  const visit = (list: Unit[]) => {
    for (let i = 0; i < list.length; i++) {
      const u = list[i]
      if (forced) {
        forced = false
        newPage(u.pos, u.top, 'block', u.indent)
      }
      if (u.bottom <= limit()) {
        if (u.kind === 'pageBreak') forced = true
        continue
      }
      if (u.kind === 'pageBreak') {
        // A marker that ends a full page ends it where it is: moving it to a
        // fresh page would leave that page blank.
        forced = true
        continue
      }
      if (u.kind === 'container' && u.children?.length) {
        visit(u.children)
        continue
      }
      placeLeaf(u, list, i)
    }
  }

  visit(units)
  const contentBottom = units.length ? units[units.length - 1].bottom : startTop
  return { breaks, contentBottom, overflow }
}

/**
 * Gap heights for the breaks, so that page k's content starts exactly at
 * k × `pitch` (pitch = content height + bottom margin + gap + top margin),
 * whatever margins the first block of each page has.
 */
export function gapHeights(breaks: Break[], pitch: number, firstPageTop = 0): number[] {
  let prevTop = firstPageTop
  return breaks.map((b) => {
    const h = pitch - (b.top - prevTop)
    prevTop = b.top
    return h
  })
}

/** Blank space left at the bottom of the last page (never negative). */
export function lastPageFill(plan: PagePlan, height: number, startTop = 0): number {
  const lastTop = plan.breaks.length ? plan.breaks[plan.breaks.length - 1].top : startTop
  return Math.max(0, height - (plan.contentBottom - lastTop))
}
