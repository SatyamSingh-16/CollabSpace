import type { SelectionBookmark } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

import { api, type DocumentMeta } from '../api'
import { navigate } from '../router'
import { relativeTime } from './Documents'
import { DocIcon, FolderIcon, HomeIcon, SearchIcon, SettingsIcon, TargetIcon, UsersIcon } from './Icons'

export const isMac = () => /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)
export const shortcutLabel = () => (isMac() ? '⌘K' : 'Ctrl+K')

/**
 * The palette shortcut: Cmd+K on macOS, Ctrl+K elsewhere, with no other
 * modifier. Ctrl+K on macOS is left alone (in text fields it deletes to
 * the end of the line), and so is anything typed while composing.
 */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing'>, mac = isMac()): boolean {
  if (e.isComposing || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'k') return false
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

const PAGES: { label: string; hash: string; icon: ReactNode; keywords: string }[] = [
  { label: 'Overview', hash: '#/', icon: <HomeIcon />, keywords: 'home dashboard' },
  { label: 'Workspaces', hash: '#/workspaces', icon: <FolderIcon />, keywords: 'documents my workspace' },
  { label: 'Goals', hash: '#/goals', icon: <TargetIcon />, keywords: 'today tasks' },
  { label: 'Teams', hash: '#/teams', icon: <UsersIcon />, keywords: 'people collaborators' },
  { label: 'Settings', hash: '#/settings', icon: <SettingsIcon />, keywords: 'theme account preferences' },
]

const MAX_DOCS = 8

/** The editor view behind a Tiptap editor element (Tiptap sets `dom.editor`). */
const editorViewOf = (el: Element | null): EditorView | undefined =>
  (el as (Element & { editor?: { view?: EditorView } }) | null)?.editor?.view

/**
 * Documents whose title contains every word of the query, titles starting
 * with the query first, then the most recently updated. With no query: the
 * most recent ones.
 */
export function matchDocuments(docs: DocumentMeta[], query: string, limit = MAX_DOCS): DocumentMeta[] {
  const q = query.trim().toLowerCase()
  const words = q.split(/\s+/).filter(Boolean)
  const recent = (a: DocumentMeta, b: DocumentMeta) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
  if (words.length === 0) return [...docs].sort(recent).slice(0, limit)
  return docs
    .filter((d) => {
      const t = d.title.toLowerCase()
      return words.every((w) => t.includes(w))
    })
    .sort((a, b) => Number(b.title.toLowerCase().startsWith(q)) - Number(a.title.toLowerCase().startsWith(q)) || recent(a, b))
    .slice(0, limit)
}

type Item = { id: string; kind: 'doc' | 'page'; label: string; hash: string; icon: ReactNode; meta?: string }

/**
 * Global command palette: search documents (the real list from the API)
 * and jump to pages. Opened with Cmd/Ctrl+K or the sidebar's Search
 * button. A native modal <dialog>: focus stays inside while it's open, and
 * goes back where it was when it closes.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const returnTo = useRef<Element | null>(null)
  const caret = useRef<SelectionBookmark | null>(null)
  const [query, setQuery] = useState('')
  // The selected item, by id (not index): documents load after the pages
  // are shown, and an index would then point at a different item.
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null)
  const [error, setError] = useState(false)
  const uid = useId()

  // Back to the element that had focus before (the editor, a button…),
  // with the editor's caret where it was. Done synchronously, inside the
  // keypress or click that closes the palette: tests caught the next
  // keystroke landing at the start of the document (closing the dialog makes
  // the browser refocus the editor with the caret at the start, and
  // ProseMirror adopts that), and a lost first character. Focusing through
  // the editor's view and restoring the saved selection is a selection
  // change only; the document is not touched.
  function restoreFocus() {
    const el = returnTo.current
    const saved = caret.current
    returnTo.current = null
    caret.current = null
    if (!(el instanceof HTMLElement) || !el.isConnected) return
    const view = editorViewOf(el)
    if (!view) return el.focus({ preventScroll: true })
    view.focus()
    if (saved) view.dispatch(view.state.tr.setSelection(saved.resolve(view.state.doc)))
  }

  function closeDialog() {
    const d = dialog.current
    if (!d?.open) return
    if (typeof d.close === 'function') d.close()
    else d.removeAttribute('open') // jsdom
  }

  function closeNow() {
    closeDialog()
    restoreFocus()
    onClose()
  }

  // Open the native dialog and fetch fresh documents each time; when closed
  // from outside (the shortcut pressed again), close it and restore focus.
  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (!open) {
      closeDialog()
      restoreFocus()
      return
    }
    if (d.open) return
    returnTo.current = document.activeElement
    caret.current = editorViewOf(returnTo.current)?.state.selection.getBookmark() ?? null
    setQuery('')
    setActiveKey(null)
    setDocs(null)
    setError(false)
    if (typeof d.showModal === 'function') d.showModal()
    else d.setAttribute('open', '') // jsdom
    input.current?.focus()
    let current = true
    api.listDocuments().then(
      (list) => current && setDocs(list),
      () => current && setError(true),
    )
    return () => {
      current = false
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const docItems: Item[] = useMemo(
    () =>
      (docs ? matchDocuments(docs, query) : []).map((d) => ({
        id: `doc-${d.id}`,
        kind: 'doc',
        label: d.title,
        hash: `#/d/${d.id}`,
        icon: <DocIcon />,
        meta: `${d.role} · ${relativeTime(d.updated_at)}`,
      })),
    [docs, query],
  )
  const pageItems: Item[] = PAGES.filter((p) => !q || p.label.toLowerCase().includes(q) || p.keywords.includes(q)).map((p) => ({
    id: `page-${p.label}`,
    kind: 'page',
    label: p.label,
    hash: p.hash,
    icon: p.icon,
    meta: 'Go to page',
  }))
  const items = [...docItems, ...pageItems]
  const activeItem = items.find((i) => i.id === activeKey) ?? items[0]
  const activeIndex = activeItem ? items.indexOf(activeItem) : 0
  const optionId = (item: Item) => `${uid}-${item.id}`

  // Keep the selected option in view while moving with the arrow keys.
  const activeId = activeItem ? optionId(activeItem) : null
  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView?.({ block: 'nearest' })
  }, [activeId])

  function choose(item: Item | undefined) {
    if (!item) return
    closeNow()
    navigate(item.hash) // the usual unsaved-edits check still applies
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault() // closed here, synchronously, not by the dialog's own cancel
      return closeNow()
    }
    if (items.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveKey(items[(activeIndex + step + items.length) % items.length].id)
    } else if (e.key === 'Home' && e.ctrlKey) {
      setActiveKey(items[0].id)
    } else if (e.key === 'End' && e.ctrlKey) {
      setActiveKey(items[items.length - 1].id)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(activeItem)
    }
  }

  const option = (item: Item) => {
    const selected = item === activeItem
    return (
      <div
        key={item.id}
        id={optionId(item)}
        role="option"
        aria-selected={selected}
        className={selected ? 'palette-option is-active' : 'palette-option'}
        onMouseMove={() => !selected && setActiveKey(item.id)}
        onClick={() => choose(item)}
      >
        <span className="palette-icon" aria-hidden="true">
          {item.icon}
        </span>
        <span className="palette-label">{item.label}</span>
        {item.meta && <span className="palette-meta">{item.meta}</span>}
      </div>
    )
  }

  let docNote: string | null = null
  if (error) docNote = "Couldn't load documents. Pages are still available."
  else if (docs === null) docNote = 'Loading documents…'
  else if (docs.length === 0) docNote = 'No documents yet.'
  else if (docItems.length === 0) docNote = `No documents match “${query.trim()}”.`

  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Command palette"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault()
        closeNow()
      }}
      // A click on the backdrop (the dialog element itself) closes it.
      onClick={(e) => e.target === dialog.current && closeNow()}
    >
      {open && (
        <div className="palette-body">
          <div className="palette-search">
            <SearchIcon />
            <input
              ref={input}
              role="combobox"
              aria-label="Search documents and pages"
              aria-expanded="true"
              aria-controls={`${uid}-list`}
              aria-autocomplete="list"
              aria-activedescendant={activeId ?? undefined}
              placeholder="Search documents or jump to a page…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveKey(null) // a new search starts at its first result
              }}
              onKeyDown={onKeyDown}
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="palette-kbd">Esc</kbd>
          </div>
          <p className="palette-note" aria-live="polite">
            {docNote ?? ''}
          </p>
          <div className="palette-list" id={`${uid}-list`} role="listbox" aria-label="Results">
            {docItems.length > 0 && (
              <div role="group" aria-labelledby={`${uid}-docs`}>
                <div className="palette-group" id={`${uid}-docs`}>
                  {q ? 'Documents' : 'Recent documents'}
                </div>
                {docItems.map(option)}
              </div>
            )}
            {pageItems.length > 0 && (
              <div role="group" aria-labelledby={`${uid}-pages`}>
                <div className="palette-group" id={`${uid}-pages`}>
                  Go to
                </div>
                {pageItems.map(option)}
              </div>
            )}
          </div>
          <p className="palette-foot" aria-hidden="true">
            <span>
              <kbd>↑</kbd> <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>Enter</kbd> open
            </span>
            <span>
              <kbd>Esc</kbd> close
            </span>
          </p>
        </div>
      )}
    </dialog>
  )
}
