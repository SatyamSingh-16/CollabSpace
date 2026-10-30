import { EditorContent, useEditor } from '@tiptap/react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import * as Y from 'yjs'

import { api, ApiError, wsUrl, type DocumentMeta, type Member, type Role, type User } from '../api'
import { bindEditable, canEdit, collabExtensions } from '../collab/editor'
import { pageClass, pageGeometry, usePageSettings } from '../collab/pageSettings'
import { createPagination, PAGE_GAP } from '../collab/pagination'
import { CollabProvider, type ProviderState } from '../collab/provider'
import { ParticipantList } from '../Presence'
import { setFlash } from '../flash'
import { navigate } from '../router'
import { openProviders } from '../unsaved'
import { Avatar } from '../ui/Avatar'
import { ConstellationBackground } from '../ui/Constellation'
import { canDelete, canRename, confirmDelete, RenameForm, RoleBadge } from '../ui/Documents'
import { LockIcon, OutlineIcon, PencilIcon, ShareIcon, TrashIcon, UsersIcon } from '../ui/Icons'
import { Outline } from '../ui/Outline'
import { PageSetup } from '../ui/PageSetup'
import { StatusPill } from '../ui/StatusPill'
import { Toolbar } from '../ui/Toolbar'

const roleLabel: Record<Role, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }

// --- one document ---

export function DocumentPage(props: {
  docId: string
  /** Open the Share panel on arrival (owners only; #/d/<id>/share). */
  openShare?: boolean
  user: User
  handle: (e: unknown) => string
  onSessionExpired: () => void
}) {
  const { docId, user, handle, onSessionExpired } = props
  const [doc, setDoc] = useState<DocumentMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sharing, setSharing] = useState(!!props.openShare)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  // Owners only (the member list is owner-only): how many others have access.
  const [sharedWith, setSharedWith] = useState<number | null>(null)
  // Changing the key remounts the editor with a fresh Y.Doc.
  const [editorKey, setEditorKey] = useState(0)

  useEffect(() => {
    api.getDocument(docId).then(setDoc, (e) => setError(handle(e)))
  }, [docId, handle])
  const isOwner = doc?.role === 'owner'
  useEffect(() => {
    if (!isOwner) return setSharedWith(null)
    api.listMembers(docId).then(
      (m) => setSharedWith(m.length - 1),
      () => setSharedWith(null), // just not shown; the share panel reports errors
    )
  }, [docId, isOwner])

  async function deleteDocument() {
    if (!doc || !confirmDelete(doc.title)) return
    setDeleting(true)
    setActionError(null)
    try {
      await api.deleteDocument(doc.id)
    } catch (e) {
      setActionError(handle(e))
      setDeleting(false)
      return
    }
    // The document and any unsaved edits to it are gone for everyone, so
    // leave without the unsaved-changes prompt.
    setFlash(`Deleted “${doc.title}”.`)
    navigate('#/workspaces', { skipUnsavedCheck: true })
  }

  // Our role was lowered to viewer while we had unsaved changes: they can't
  // be saved, and the local Y.Doc now differs from everyone else's. Start
  // over from the server's copy.
  const onDiscarded = useCallback(() => {
    // Some of them may in fact have been saved just before the change (their
    // confirmation was lost when the connection closed), so say "may".
    setNotice('Your access changed to view only. Changes that were not confirmed as saved may have been discarded.')
    setEditorKey((k) => k + 1)
  }, [])

  // A refused WebSocket handshake is invisible to the browser, so ask the
  // API whether the session or the access is the problem. Only definitive
  // answers end the editor: 401 (signed out) or 403/404 (no access). A
  // network error or 5xx means the server is unreachable or restarting; the
  // editor, with any unsaved offline edits in its Y.Doc, must stay while the
  // provider keeps reconnecting. (Week 3 browser test: a 502 from the dev
  // proxy used to unmount the editor and discard those edits.)
  const onConnectFailed = useCallback(async () => {
    try {
      if ((await api.me()) === null) return onSessionExpired()
      await api.getDocument(docId)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setError(handle(e))
        setDoc(null)
      }
    }
  }, [docId, handle, onSessionExpired])

  // The server can change the role while the page is open.
  const onRoleChange = useCallback((role: Role) => setDoc((d) => (d && d.role !== role ? { ...d, role } : d)), [])

  return (
    <div className="page page-doc">
      {/* Decorative: visible in the outer background only; strongly dimmed
          behind the writing surface and the header text. A sibling of the
          editor, so it never re-creates it. */}
      <ConstellationBackground quiet=".paper, .toolbar-wrap, .doc-head, .breadcrumb, .share-panel" quietFloor={0.12} />
      <nav className="breadcrumb" aria-label="Breadcrumb">
        <a href="#/workspaces" className="back-link" aria-label="Back to My workspace">
          ←
        </a>
        <span className="breadcrumb-root">Workspaces</span>
        <span className="breadcrumb-sep" aria-hidden="true">
          /
        </span>
        <a href="#/workspaces">My workspace</a>
        {doc && (
          <>
            <span className="breadcrumb-sep" aria-hidden="true">
              /
            </span>
            <span aria-current="page">{doc.title}</span>
          </>
        )}
      </nav>
      {notice && <p className="banner banner-notice">{notice}</p>}
      {actionError && (
        <p className="banner banner-error" role="alert">
          {actionError}
        </p>
      )}
      {error && !doc && (
        <div className="empty-state" role="alert">
          <h2>This document isn't available</h2>
          <p>{error}</p>
          <a className="btn btn-secondary" href="#/workspaces">
            Back to My workspace
          </a>
        </div>
      )}
      {!doc && !error && (
        <div className="doc-loading" aria-busy="true">
          <span className="skeleton skeleton-title" />
          <span className="skeleton skeleton-paper" />
          <span className="sr-only">Opening…</span>
        </div>
      )}
      {doc && (
        <CollabEditor
          key={editorKey}
          documentId={doc.id}
          userId={user.id}
          onDiscarded={onDiscarded}
          initialRole={doc.role}
          onConnectFailed={onConnectFailed}
          onRoleChange={onRoleChange}
          heading={
            renaming ? (
              <RenameForm
                className="doc-rename"
                initial={doc.title}
                onCancel={() => setRenaming(false)}
                onSave={async (title) => {
                  try {
                    const updated = await api.renameDocument(doc.id, title)
                    setDoc((d) => (d ? { ...d, title: updated.title, updated_at: updated.updated_at } : d))
                  } catch (e) {
                    return handle(e)
                  }
                  setRenaming(false)
                  return null
                }}
              />
            ) : (
              <div className="doc-title-row">
                <h1 className="doc-title">
                  <span className="doc-title-text">{doc.title}</span> <RoleBadge role={doc.role} />
                </h1>
                {canRename(doc.role) && (
                  <button type="button" className="icon-button" aria-label="Rename document" title="Rename" onClick={() => setRenaming(true)}>
                    <PencilIcon />
                  </button>
                )}
                {sharedWith !== null && (
                  <span className="share-state">
                    {sharedWith === 0 ? <LockIcon /> : <UsersIcon />}
                    {sharedWith === 0 ? 'Private' : `Shared with ${sharedWith} ${sharedWith === 1 ? 'person' : 'people'}`}
                  </span>
                )}
              </div>
            )
          }
          actions={
            doc.role === 'owner' && (
              <>
                <button
                  type="button"
                  className={sharing ? 'btn btn-secondary is-open' : 'btn btn-secondary'}
                  aria-expanded={sharing}
                  aria-controls="share-panel"
                  onClick={() => setSharing((s) => !s)}
                >
                  <ShareIcon />
                  Share
                </button>
                {canDelete(doc.role) && (
                  <button
                    type="button"
                    className="icon-button icon-button-danger"
                    aria-label="Delete document"
                    title="Delete document"
                    disabled={deleting}
                    onClick={deleteDocument}
                  >
                    <TrashIcon />
                  </button>
                )}
              </>
            )
          }
          panel={
            doc.role === 'owner' &&
            sharing && (
              <SharePanel docId={doc.id} title={doc.title} handle={handle} onClose={() => setSharing(false)} onMembers={setSharedWith} />
            )
          }
        />
      )}
    </div>
  )
}

// Owner-only: who has access, sharing, changing roles, removing people.
// Changes take effect on open connections too (the server closes or
// reconnects them). Hiding this panel from non-owners is presentation only;
// the server refuses these requests from anyone but the owner.
function SharePanel(props: {
  docId: string
  title: string
  handle: (e: unknown) => string
  onClose: () => void
  onMembers: (othersWithAccess: number) => void
}) {
  const { docId, title, handle, onClose, onMembers } = props
  const [members, setMembers] = useState<Member[] | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  const reload = useCallback(() => {
    api.listMembers(docId).then(
      (m) => {
        setMembers(m)
        onMembers(m.length - 1)
      },
      (e) => setMessage({ text: handle(e), ok: false }),
    )
  }, [docId, handle, onMembers])
  useEffect(reload, [reload])

  async function run(action: () => Promise<unknown>, done: string): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      setMessage({ text: done, ok: true })
      reload()
      return true
    } catch (err) {
      setMessage({ text: handle(err), ok: false })
      return false
    } finally {
      setBusy(false)
    }
  }
  async function share(e: FormEvent) {
    e.preventDefault()
    const target = email.trim()
    if (await run(() => api.shareDocument(docId, target, role), `Shared with ${target} as ${role}.`)) setEmail('')
  }

  return (
    <section id="share-panel" className="share-panel" aria-label="Sharing">
      <div className="share-head">
        <h2>Share “{title}”</h2>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Done
        </button>
      </div>
      <form className="share" onSubmit={share}>
        <label className="field share-email">
          <span className="field-label">Email address</span>
          <input
            type="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="off"
          />
        </label>
        <label className="field share-role">
          <span className="field-label">Permission</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}>
            <option value="editor">Can edit</option>
            <option value="viewer">Can view</option>
          </select>
        </label>
        <button type="submit" className="btn btn-primary share-submit" disabled={busy}>
          {busy ? 'Inviting…' : 'Invite'}
        </button>
      </form>
      {message && (
        // A polite live region rather than role="status": the page's one
        // status region is the connection/save pill.
        <p className={message.ok ? 'form-message ok' : 'form-message error'} role={message.ok ? undefined : 'alert'} aria-live="polite">
          {message.text}
        </p>
      )}
      <h3 className="share-subhead">People with access</h3>
      {members === null && <p className="muted">Loading…</p>}
      <ul className="member-list" aria-label="People with access">
        {members?.map((m) => (
          <li key={m.user_id}>
            <Avatar id={m.user_id} name={m.display_name} />
            <span className="member-who">
              <span className="member-name">{m.display_name}</span>
              <span className="member-email">{m.email}</span>
            </span>
            {m.role === 'owner' ? (
              <span className="member-owner">{roleLabel.owner}</span>
            ) : (
              <span className="member-actions">
                <select
                  aria-label={`Role for ${m.email}`}
                  value={m.role}
                  disabled={busy}
                  onChange={(e) =>
                    run(() => api.shareDocument(docId, m.email, e.target.value as 'editor' | 'viewer'), `${m.email} is now ${e.target.value}.`)
                  }
                >
                  <option value="editor">Can edit</option>
                  <option value="viewer">Can view</option>
                </select>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-danger"
                  aria-label={`Remove ${m.email}`}
                  disabled={busy}
                  onClick={() => run(() => api.removeMember(docId, m.user_id), `Removed ${m.email}.`)}
                >
                  Remove
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

// --- the collaborative editor (Week 1, now per document and per role) ---

function CollabEditor(props: {
  documentId: string
  userId: string
  initialRole: Role
  onConnectFailed: () => void
  onRoleChange: (role: Role) => void
  onDiscarded: () => void
  heading: ReactNode
  actions?: ReactNode
  panel?: ReactNode
}) {
  const { documentId, userId, initialRole, onConnectFailed, onRoleChange, onDiscarded } = props
  // One Y.Doc for the component's life. The provider can come and go
  // (StrictMode mounts effects twice in development) without replacing it.
  const [doc] = useState(() => new Y.Doc())
  const [provider, setProvider] = useState<CollabProvider | null>(null)
  useEffect(() => {
    const p = new CollabProvider({ url: wsUrl(documentId), doc, onConnectFailed })
    openProviders.add(p)
    setProvider(p)
    return () => {
      openProviders.delete(p)
      p.destroy()
    }
  }, [doc, documentId, onConnectFailed])

  const state = useProviderState(provider)
  // The role granted by the server at the latest join wins over the one the
  // page loaded with (an owner may have changed it meanwhile).
  const role = (state?.role as Role | null) ?? initialRole
  const readOnly = role === 'viewer'
  useEffect(() => onRoleChange(role), [role, onRoleChange])

  // injectCSS: false: the production CSP forbids inline <style>; the same
  // base styles are bundled from prosemirror.css instead.
  //
  // Options are built once per Y.Doc and passed with deps. Without deps,
  // useEditor compares options after every render and calls setOptions when
  // they differ, and they always did: collabExtensions() returns new
  // extension objects on each call, and `editable` changes after sync
  // (bindEditable). setOptions re-applies the editor state; when the
  // document ends in an empty paragraph (right after Enter) y-prosemirror
  // writes that as a Y.Doc update, the provider emits, this component
  // re-renders, setOptions runs again... until React aborts ("Maximum
  // update depth exceeded") and unmounts the app: the blank page.
  //
  // The pagination controller is created once, with the Y.Doc: it is part
  // of the extension list, so it must be as stable as the editor.
  const [pagination] = useState(createPagination)
  const editorOptions = useMemo(
    () => ({ extensions: collabExtensions(doc, { pagination: pagination.extension }), editable: false, injectCSS: false }),
    [doc, pagination],
  )
  const editor = useEditor(editorOptions, [doc])
  useEffect(
    () => (editor && provider ? bindEditable(editor, provider, { readOnly }) : undefined),
    [editor, provider, readOnly],
  )

  // Stopped for good because the session ended (4001), access was removed
  // (4003) or the document is gone (4004): let the page find out which and
  // show the right screen.
  const closeCode = state?.status === 'error' ? state.closeCode : null
  useEffect(() => {
    if (closeCode === 4001 || closeCode === 4003 || closeCode === 4004) onConnectFailed()
  }, [closeCode, onConnectFailed])

  const discarded = state?.discardedEdits ?? 0
  useEffect(() => {
    if (discarded > 0) onDiscarded()
  }, [discarded, onDiscarded])

  useWarnBeforeUnload(state !== null && !state.saved)

  // The outline panel. Opening or closing it only re-renders this component:
  // the editor (built once per Y.Doc above) is not recreated.
  const [outlineOpen, setOutlineOpen] = useState(initialOutlineOpen)

  // Pages: the settings come from the Y.Doc; the layout is this viewer's.
  // The sheet is shown at its real size, scaled down to fit the window; below
  // MIN_PAGE_SCALE (phones) pages would be unreadable, so the document flows
  // continuously instead.
  const settings = usePageSettings(doc)
  const geometry = useMemo(() => pageGeometry(settings), [settings])
  const cell = useRef<HTMLDivElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState({ scale: 1, paged: false })
  useLayoutEffect(() => {
    const el = cell.current
    if (!el) return
    const update = () => {
      const scale = Math.min(1, Math.round((el.clientWidth / geometry.width) * 1000) / 1000)
      const paged = scale >= MIN_PAGE_SCALE
      setFit((f) => (f.scale === scale && f.paged === paged ? f : { scale, paged }))
    }
    update()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update)
      return () => window.removeEventListener('resize', update)
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [geometry.width])
  useEffect(() => {
    pagination.configure({ geometry, enabled: fit.paged, scale: fit.paged ? fit.scale : 1 })
  }, [pagination, geometry, fit])
  // Sheet dimensions for the CSS (custom properties via CSSOM: CSP-safe).
  useLayoutEffect(() => {
    const c = cell.current
    if (!c) return
    c.style.setProperty('--sheet-width', `${geometry.width}px`)
    c.style.setProperty('--page-h', `${geometry.height}px`)
    c.style.setProperty('--sheet-margin', `${geometry.margin}px`)
    c.style.setProperty('--page-gap', `${PAGE_GAP}px`)
    c.style.setProperty('--page-scale', String(fit.paged ? fit.scale : 1))
  }, [geometry, fit])
  // The last page is padded to a full page; the cell reserves the scaled height.
  useEffect(() => {
    const s = sheet.current
    const c = cell.current
    if (!s || !c) return
    // After each layout pass (in its animation frame, not in a
    // ResizeObserver callback, which would resize what other observers watch).
    return pagination.onLayout(({ pages, lastFill }) => {
      s.style.setProperty('--last-fill', `${lastFill}px`)
      s.dataset.lastPage = `${pages} / ${pages}`
      c.style.setProperty('--sheet-h', `${s.offsetHeight}px`)
    })
  }, [pagination])
  const toggleOutline = () =>
    setOutlineOpen((open) => {
      try {
        localStorage.setItem(OUTLINE_KEY, open ? '0' : '1')
      } catch {
        // not remembered; still works for this page
      }
      return !open
    })

  return (
    <>
      <div className="doc-head">
        {props.heading}
        <div className="doc-actions">
          <ParticipantList participants={state?.participants ?? null} selfId={userId} />
          <StatusPill state={state} readOnly={readOnly} onRetry={provider ? () => provider.restart() : undefined} />
          <PageSetup doc={doc} settings={settings} canChange={!readOnly && state !== null && canEdit(state)} />
          <button
            type="button"
            className={outlineOpen ? 'btn btn-secondary is-open' : 'btn btn-secondary'}
            aria-expanded={outlineOpen}
            aria-controls="doc-outline"
            onClick={toggleOutline}
          >
            <OutlineIcon />
            Outline
          </button>
          {props.actions}
        </div>
      </div>
      {props.panel}
      <section className="editor-shell" aria-label="Document editor">
        <div className="toolbar-wrap">
          {readOnly ? (
            <p className="readonly-note">You can view this document. Only editors can change it.</p>
          ) : (
            <Toolbar editor={editor} enabled={state !== null && canEdit(state)} />
          )}
        </div>
        <div className={['editor-body', outlineOpen && 'has-outline', fit.paged && 'is-paged'].filter(Boolean).join(' ')}>
          <div className="paper-cell" ref={cell}>
            <div className={`paper ${pageClass(settings)}`} ref={sheet}>
              <EditorContent editor={editor} className="editor" />
            </div>
          </div>
          {outlineOpen && <Outline editor={editor} id="doc-outline" onGoToPage={pagination.goToPage} />}
        </div>
      </section>
      {state && import.meta.env.DEV && (
        <p className="debug">
          seq {state.appliedSeq} · unsaved {state.pendingCount} · client {provider?.clientId.slice(0, 8)}
        </p>
      )}
    </>
  )
}

const OUTLINE_KEY = 'collabspace-outline-open'
// Below this on-screen scale pages would be unreadable: flow continuously.
const MIN_PAGE_SCALE = 0.6

// Remembered per browser; by default open on wide screens, closed on narrow ones.
function initialOutlineOpen(): boolean {
  try {
    const stored = localStorage.getItem(OUTLINE_KEY)
    if (stored !== null) return stored === '1'
  } catch {
    // fall through to the default
  }
  return typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1100px)').matches : true
}

function useProviderState(provider: CollabProvider | null): ProviderState | null {
  return useSyncExternalStore(
    (cb) => (provider ? provider.subscribe(cb) : () => {}),
    () => (provider ? provider.getState() : null),
  )
}

function useWarnBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = '' // older browsers only prompt when this is set
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [active])
}
