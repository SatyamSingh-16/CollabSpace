import { useEditorState, type Editor } from '@tiptap/react'

import { outlineOf, type OutlineEntry } from '../collab/formatting'
import { paginationKey } from '../collab/pagination'

/**
 * The document outline: the H1–H3 headings and page breaks of the live
 * document, read from the editor state on every change (no second copy of
 * the content). Choosing an entry scrolls to it and puts the cursor there;
 * the document itself is never changed.
 */
export function Outline({ editor, id, onGoToPage }: { editor: Editor | null; id: string; onGoToPage?: (n: number) => void }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      if (!e) return null
      const entries = outlineOf(e.state.doc)
      // The section the cursor is in: the last entry at or before it.
      const at = e.state.selection.from
      let current = -1
      entries.forEach((entry, i) => {
        if (entry.pos < at) current = i
      })
      // Pages as laid out for this viewer (not stored in the document).
      const pages = paginationKey.getState(e.state)
      const paged = !!pages?.enabled
      let page = 1
      pages?.pageStarts.forEach((start, i) => {
        if (start <= at) page = i + 1
      })
      return { entries, current, paged, pageCount: paged ? pages!.pageStarts.length : 0, page }
    },
  })

  const go = (entry: OutlineEntry) => {
    if (!editor) return
    const dom = editor.view.nodeDOM(entry.pos)
    if (dom instanceof HTMLElement) {
      const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      dom.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
    }
    // A selection change only (inside the heading, or on the page break).
    if (entry.kind === 'pageBreak') editor.chain().setNodeSelection(entry.pos).focus(undefined, { scrollIntoView: false }).run()
    else editor.chain().focus(entry.pos + 1, { scrollIntoView: false }).run()
  }

  const entries = state?.entries ?? []
  let breaks = 0
  return (
    <nav id={id} className="outline" aria-label="Document outline">
      <p className="outline-title">Outline</p>
      {entries.length === 0 ? (
        <p className="outline-empty">No headings yet. Use H1, H2 or H3 in the toolbar to build an outline.</p>
      ) : (
        <ol className="outline-list" aria-label="Headings">
          {entries.map((entry, i) => {
            const label = entry.kind === 'pageBreak' ? `Page break ${++breaks}` : entry.text || 'Untitled heading'
            return (
              <li key={`${entry.pos}-${i}`} className={`outline-item level-${entry.level}${entry.kind === 'pageBreak' ? ' is-break' : ''}`}>
                <button
                  type="button"
                  className="outline-link"
                  aria-current={state?.current === i ? 'location' : undefined}
                  onClick={() => go(entry)}
                >
                  {label}
                </button>
              </li>
            )
          })}
        </ol>
      )}
      {state?.paged ? (
        <>
          <p className="outline-title outline-pages-title">Pages</p>
          <ol className="outline-list outline-pages" aria-label="Pages">
            {Array.from({ length: state.pageCount }, (_, i) => (
              <li key={i} className="outline-item">
                <button
                  type="button"
                  className="outline-link"
                  aria-current={state.page === i + 1 ? 'page' : undefined}
                  onClick={() => onGoToPage?.(i + 1)}
                >
                  Page {i + 1}
                </button>
              </li>
            ))}
          </ol>
          <p className="outline-note">Pages as laid out in this window.</p>
        </>
      ) : (
        <p className="outline-note">The page view needs a wider window; the document flows continuously here.</p>
      )}
    </nav>
  )
}
