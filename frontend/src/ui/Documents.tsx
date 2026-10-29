import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type Ref } from 'react'

import { api, type DocumentMeta, type Role } from '../api'
import { DocIcon, PencilIcon, PlusIcon, TrashIcon } from './Icons'

// Who may do what (the server enforces the same rules).
export const canRename = (role: Role) => role === 'owner' || role === 'editor'
export const canDelete = (role: Role) => role === 'owner'

export function confirmDelete(title: string): boolean {
  return window.confirm(
    `Delete “${title}”?\n\nThis permanently deletes the document, its history and its sharing for everyone with access. It can't be undone.`,
  )
}

export function RoleBadge({ role }: { role: Role }) {
  return <span className={`badge ${role}`}>{role}</span>
}

/** "3 minutes ago", "yesterday"; callers put the exact time in a tooltip. */
export function relativeTime(iso: string): string {
  const diff = (Date.parse(iso) - Date.now()) / 1000
  if (!Number.isFinite(diff)) return ''
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ]
  for (const [unit, seconds] of units) if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit)
  return 'just now'
}

export type SortBy = 'updated' | 'title'

/** Most recently updated first, or by title (natural order: "Doc 2" before "Doc 10"). */
export function sortDocuments(docs: DocumentMeta[], by: SortBy): DocumentMeta[] {
  return [...docs].sort(
    by === 'title'
      ? (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true })
      : (a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at),
  )
}

const REFRESH_MS = 30_000

/**
 * The account's documents (owned and shared), newest first. While the tab
 * is visible the list is refreshed quietly every 30 s, so "online" counts
 * (a snapshot from the server) don't go stale.
 */
export function useDocuments(handle: (e: unknown) => string) {
  const [docs, setDocs] = useState<DocumentMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fetchDocs = useCallback(
    () => api.listDocuments().then((d) => [...d].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))),
    [],
  )
  const load = useCallback(() => {
    setError(null)
    setDocs(null)
    fetchDocs().then(setDocs, (e) => setError(handle(e)))
  }, [fetchDocs, handle])
  // A background refresh keeps what's on screen if it fails.
  const refresh = useCallback(() => {
    fetchDocs().then(setDocs, (e) => {
      handle(e) // still routes a 401 to sign-in
    })
  }, [fetchDocs, handle])
  useEffect(load, [load])
  useEffect(() => {
    const tick = () => document.visibilityState === 'visible' && refresh()
    const timer = window.setInterval(tick, REFRESH_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [refresh])
  return { docs, error, reload: load, refresh }
}

export function CreateDocumentForm({ handle, inputRef }: { handle: (e: unknown) => string; inputRef?: Ref<HTMLInputElement> }) {
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function create(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const d = await api.createDocument(title.trim() || 'Untitled document')
      location.hash = `#/d/${d.id}`
    } catch (err) {
      setError(handle(err))
      setBusy(false)
    }
  }
  return (
    <form className="create-form" onSubmit={create} aria-label="New document">
      <label className="sr-only" htmlFor="new-doc-title">
        New document title
      </label>
      <input
        id="new-doc-title"
        ref={inputRef}
        placeholder="New document title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={200}
      />
      <button type="submit" className="btn btn-primary" disabled={busy}>
        <PlusIcon />
        {busy ? 'Creating…' : 'Create'}
      </button>
      {error && (
        <p className="form-message error create-error" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

/** "2 online" with a live dot; nothing when nobody has it open. */
export function OnlineCount({ count }: { count?: number }) {
  if (!count) return null
  return (
    <span className="online" title={`${count} ${count === 1 ? 'person has' : 'people have'} this document open`}>
      <span className="online-dot" aria-hidden="true" />
      {count} online
    </span>
  )
}

/**
 * Document rows. With onChanged, each row also offers Rename (owner and
 * editors) and Delete (owner only); onChanged is called after either.
 */
export function DocumentRows(props: {
  docs: DocumentMeta[]
  label: string
  handle?: (e: unknown) => string
  onChanged?: (message: string) => void
}) {
  return (
    <ul className="doc-list" aria-label={props.label}>
      {props.docs.map((d) => (
        <DocumentRow key={d.id} doc={d} handle={props.handle} onChanged={props.onChanged} />
      ))}
    </ul>
  )
}

function DocumentRow(props: { doc: DocumentMeta; handle?: (e: unknown) => string; onChanged?: (message: string) => void }) {
  const { doc: d, handle, onChanged } = props
  const [renaming, setRenaming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const actions = handle && onChanged

  async function remove() {
    if (!handle || !onChanged || !confirmDelete(d.title)) return
    setBusy(true)
    setError(null)
    try {
      await api.deleteDocument(d.id)
      onChanged(`Deleted “${d.title}”.`)
    } catch (e) {
      setError(handle(e))
      setBusy(false)
    }
  }

  return (
    <li className={renaming ? 'doc-row is-renaming' : 'doc-row'}>
      <span className="doc-icon" aria-hidden="true">
        <DocIcon />
      </span>
      {renaming && handle && onChanged ? (
        <RenameForm
          initial={d.title}
          onCancel={() => setRenaming(false)}
          onSave={async (title) => {
            try {
              await api.renameDocument(d.id, title)
            } catch (e) {
              return handle(e)
            }
            setRenaming(false)
            onChanged(`Renamed to “${title}”.`)
            return null
          }}
        />
      ) : (
        <span className="doc-main">
          <a className="doc-link" href={`#/d/${d.id}`}>
            {d.title}
          </a>
          <OnlineCount count={d.online} />
        </span>
      )}
      {!renaming && (
        <span className="doc-meta">
          <RoleBadge role={d.role} />
          <time className="doc-time" dateTime={d.updated_at} title={new Date(d.updated_at).toLocaleString()}>
            {relativeTime(d.updated_at)}
          </time>
          {actions && (
            <span className="row-actions">
              {canRename(d.role) && (
                <button type="button" className="icon-button" aria-label={`Rename ${d.title}`} title="Rename" onClick={() => setRenaming(true)}>
                  <PencilIcon />
                </button>
              )}
              {canDelete(d.role) && (
                <button
                  type="button"
                  className="icon-button icon-button-danger"
                  aria-label={`Delete ${d.title}`}
                  title="Delete"
                  disabled={busy}
                  onClick={remove}
                >
                  <TrashIcon />
                </button>
              )}
            </span>
          )}
        </span>
      )}
      {error && (
        <p className="form-message error row-error" role="alert">
          {error}
        </p>
      )}
    </li>
  )
}

/**
 * Inline title editor. Enter saves, Escape cancels. onSave returns an error
 * message, or null on success.
 */
export function RenameForm(props: {
  initial: string
  onSave: (title: string) => Promise<string | null>
  onCancel: () => void
  className?: string
}) {
  const { initial, onSave, onCancel } = props
  const [title, setTitle] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = useId()
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t) return setError('Enter a title.')
    if (t === initial) return onCancel()
    setBusy(true)
    setError(null)
    const problem = await onSave(t)
    if (problem) {
      setError(problem)
      setBusy(false)
    }
  }

  return (
    <form className={`rename-form ${props.className ?? ''}`} onSubmit={submit} aria-label="Rename document">
      <label className="sr-only" htmlFor={`${id}-title`}>
        Document title
      </label>
      <input
        id={`${id}-title`}
        ref={input}
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
        {busy ? 'Saving…' : 'Save'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
      {error && (
        <p className="form-message error rename-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

export function DocumentRowsSkeleton() {
  return (
    <ul className="doc-list" aria-label="Loading documents" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="doc-row skeleton-row">
          <span className="skeleton skeleton-icon" />
          <span className="skeleton skeleton-text" />
        </li>
      ))}
    </ul>
  )
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="banner banner-error banner-row" role="alert">
      <span>{message}</span>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}

export function useFocusRef() {
  return useRef<HTMLInputElement>(null)
}
