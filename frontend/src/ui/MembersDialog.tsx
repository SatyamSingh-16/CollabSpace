import { useEffect, useId, useRef, useState, type MouseEvent } from 'react'

import type { DocumentMeta, Member, Role } from '../api'
import { Avatar } from './Avatar'
import { ArrowRightIcon, CloseIcon, DocIcon, ShareIcon } from './Icons'

/** A document's members as a team: the owner leads it. */
export interface DocTeam {
  doc: DocumentMeta
  /** Everyone with access, the owner included (from the owner-only member list). */
  members: Member[]
}

export const roleLabel = (role: Role) => (role === 'owner' ? 'Team leader' : role === 'editor' ? 'Editor' : 'Viewer')

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/**
 * Everyone on a document team. A native modal <dialog>, as the command
 * palette: focus stays inside while it's open (the close button has it
 * first) and returns to the button that opened it. Escape, the close button
 * and a click on the backdrop close it. It fades and rises in; on closing it
 * fades out before the dialog actually closes (at once with reduced motion).
 * Opening and closing are driven by `team` alone: null means closed.
 */
export function MembersDialog({ team, userId, onClose }: { team: DocTeam | null; userId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const returnTo = useRef<Element | null>(null)
  const downOnBackdrop = useRef(false)
  const [visible, setVisible] = useState(false)
  // The last team shown, so the content stays while it fades out.
  const last = useRef<DocTeam | null>(null)
  if (team) last.current = team
  const shown = team ?? last.current
  const titleId = useId()
  const teamId = team?.doc.id ?? null

  useEffect(() => {
    const d = dialog.current
    if (!d) return
    if (teamId) {
      if (!d.open) {
        returnTo.current = document.activeElement
        if (typeof d.showModal === 'function') d.showModal()
        else d.setAttribute('open', '') // jsdom
        closeButton.current?.focus()
      }
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
    if (!d.open) return
    setVisible(false)
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      if (typeof d.close === 'function') d.close()
      else d.removeAttribute('open')
      const el = returnTo.current
      returnTo.current = null
      if (el instanceof HTMLElement && el.isConnected) el.focus({ preventScroll: true })
    }
    if (reducedMotion()) {
      finish()
      return
    }
    const onEnd = (e: TransitionEvent) => e.target === d && e.propertyName === 'opacity' && finish()
    d.addEventListener('transitionend', onEnd)
    const fallback = setTimeout(finish, 320) // if no transition runs
    return () => {
      d.removeEventListener('transitionend', onEnd)
      clearTimeout(fallback)
      finish()
    }
  }, [teamId])

  // A click on the backdrop is a click on the dialog element itself (its
  // content fills the box); a press that started inside doesn't count.
  const onMouseDown = (e: MouseEvent) => (downOnBackdrop.current = e.target === e.currentTarget)
  const onClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget && downOnBackdrop.current) onClose()
  }

  const leader = shown?.members.find((m) => m.role === 'owner')
  const others = shown?.members.filter((m) => m.role !== 'owner') ?? []
  return (
    <dialog
      ref={dialog}
      className={visible ? 'members-dialog is-open' : 'members-dialog'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault() // closed by the parent, with the fade
        onClose()
      }}
      onMouseDown={onMouseDown}
      onClick={onClick}
    >
      {shown && (
        <div className="members-sheet">
          <header className="members-head">
            <span className="team-icon" aria-hidden="true">
              <DocIcon />
            </span>
            <div className="members-heading">
              <h2 id={titleId}>{shown.doc.title}</h2>
              <p className="muted">
                {shown.members.length} {shown.members.length === 1 ? 'member' : 'members'}
                {leader && ` · Led by ${leader.user_id === userId ? 'you' : leader.display_name}`}
              </p>
            </div>
            <button ref={closeButton} type="button" className="icon-button" aria-label="Close" onClick={onClose}>
              <CloseIcon />
            </button>
          </header>
          <ul className="members-list" aria-label={`Members of ${shown.doc.title}`}>
            {[...(leader ? [leader] : []), ...others].map((m) => (
              <li key={m.user_id} className={m.role === 'owner' ? 'member-row is-leader' : 'member-row'}>
                <Avatar id={m.user_id} name={m.display_name} />
                <span className="member-who">
                  <span className="member-name">
                    {m.display_name}
                    {m.user_id === userId && <span className="muted"> (you)</span>}
                  </span>
                  {/* Emails: this list is owner-only, as in the Share panel. */}
                  <span className="member-email">{m.email}</span>
                </span>
                <span className={`badge ${m.role}`}>{roleLabel(m.role)}</span>
              </li>
            ))}
          </ul>
          <footer className="members-foot">
            <a className="btn btn-secondary" href={`#/d/${shown.doc.id}/share`}>
              <ShareIcon />
              Manage access
            </a>
            <a className="btn btn-primary" href={`#/d/${shown.doc.id}`}>
              Open document
              <ArrowRightIcon />
            </a>
          </footer>
        </div>
      )}
    </dialog>
  )
}
