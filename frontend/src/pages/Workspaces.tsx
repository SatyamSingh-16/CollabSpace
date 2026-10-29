import { useState, type ReactNode } from 'react'

import { recentFlash } from '../flash'
import { CloseIcon, DocIcon, FolderIcon, SearchIcon, UsersIcon } from '../ui/Icons'
import {
  CreateDocumentForm,
  DocumentRows,
  DocumentRowsSkeleton,
  LoadError,
  sortDocuments,
  useDocuments,
  useFocusRef,
  type SortBy,
} from '../ui/Documents'

type Filter = 'all' | 'owned' | 'shared'

const VIEWS: { id: Filter; label: string; icon: ReactNode }[] = [
  { id: 'all', label: 'All documents', icon: <FolderIcon /> },
  { id: 'owned', label: 'Owned by me', icon: <FolderIcon /> },
  { id: 'shared', label: 'Shared with me', icon: <UsersIcon /> },
]

/**
 * "My workspace": the account's documents, owned and shared. The server has
 * no workspace or folder entity; this is a view over GET /api/documents, and
 * the folder-style views on the left are filters, labelled as such.
 */
export function Workspaces({ handle }: { handle: (e: unknown) => string }) {
  const { docs, error, reload, refresh } = useDocuments(handle)
  const [message, setMessage] = useState(recentFlash) // e.g. after deleting the open document
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('updated')
  const titleInput = useFocusRef()
  const searchInput = useFocusRef()
  const clearSearch = () => {
    setQuery('')
    searchInput.current?.focus()
  }

  const inView = (f: Filter) => (d: { role: string }) => f === 'all' || (f === 'owned' ? d.role === 'owner' : d.role !== 'owner')
  const q = query.trim().toLowerCase()
  // Filtering a list that's already in memory: instant, so no debounce.
  const shown = docs && sortDocuments(docs.filter(inView(filter)).filter((d) => d.title.toLowerCase().includes(q)), sortBy)
  const hasDocs = !!docs && docs.length > 0

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Workspaces</p>
          <h1 className="page-title">My workspace</h1>
          <p className="page-sub">Documents you own and documents shared with you.</p>
        </div>
      </header>

      <section className="panel">
        <CreateDocumentForm handle={handle} inputRef={titleInput} />

        <div className={hasDocs ? 'workspace-body' : undefined}>
          {hasDocs && (
            <nav className="views" aria-label="Views">
              <p className="views-label">Views</p>
              <div className="views-list" role="group" aria-label="Show">
                {VIEWS.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    className={filter === v.id ? 'view is-active' : 'view'}
                    aria-pressed={filter === v.id}
                    onClick={() => setFilter(v.id)}
                  >
                    {v.icon}
                    <span className="view-label">{v.label}</span>
                    <span className="view-count">{docs.filter(inView(v.id)).length}</span>
                  </button>
                ))}
              </div>
              <p className="views-note">Views filter your documents. They aren't saved folders.</p>
            </nav>
          )}

          <div className="workspace-list">
            {hasDocs && (
              <div className="list-tools">
                <div className="search">
                  <SearchIcon />
                  <label className="sr-only" htmlFor="doc-search">
                    Search documents
                  </label>
                  <input
                    id="doc-search"
                    ref={searchInput}
                    type="text"
                    placeholder="Search by title"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Escape' && query && (e.preventDefault(), setQuery(''))}
                    autoComplete="off"
                  />
                  {query && (
                    <button type="button" className="icon-button search-clear" aria-label="Clear search" onClick={clearSearch}>
                      <CloseIcon />
                    </button>
                  )}
                </div>
                <label className="sort">
                  <span className="sort-label">Sort</span>
                  <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                    <option value="updated">Recently updated</option>
                    <option value="title">Title A–Z</option>
                  </select>
                </label>
                <p className="sr-only" aria-live="polite">
                  {shown ? `${shown.length} ${shown.length === 1 ? 'document' : 'documents'}` : ''}
                </p>
              </div>
            )}
            {message && (
              <p className="form-message ok" aria-live="polite">
                {message}
              </p>
            )}
            {error && <LoadError message={error} onRetry={reload} />}
            {docs === null && !error && <DocumentRowsSkeleton />}
            {docs?.length === 0 && (
              <div className="empty-state">
                <span className="empty-icon" aria-hidden="true">
                  <DocIcon />
                </span>
                <h2>No documents yet</h2>
                <p>Create one, or ask someone to share theirs with you.</p>
                <button type="button" className="btn btn-secondary" onClick={() => titleInput.current?.focus()}>
                  Start your first document
                </button>
              </div>
            )}
            {shown && hasDocs && shown.length === 0 && (
              <div className="no-results">
                <p className="muted">{q ? `No documents match “${query.trim()}”.` : 'Nothing in this view yet.'}</p>
                {q && (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={clearSearch}>
                    Clear search
                  </button>
                )}
              </div>
            )}
            {shown && shown.length > 0 && (
              <DocumentRows
                docs={shown}
                label="Documents"
                handle={handle}
                onChanged={(m) => {
                  setMessage(m)
                  refresh()
                }}
              />
            )}
          </div>
        </div>
      </section>
      <p className="fine-print">
        CollabSpace currently has one workspace per account. Separate shared workspaces aren't supported by the server yet.
      </p>
    </div>
  )
}
