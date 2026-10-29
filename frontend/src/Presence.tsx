import { useEffect, useId, useRef, useState } from 'react'

import type { Participant } from './collab/protocol'
import { Avatar } from './ui/Avatar'

const roleText: Record<string, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Viewing' }

const MAX_SHOWN = 5

/**
 * Orders the list for display: you first, then everyone else by name.
 * The server sends each user once, so this never needs to deduplicate.
 */
export function orderParticipants(participants: Participant[], selfId: string): Participant[] {
  const others = participants
    .filter((p) => p.user_id !== selfId)
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.user_id.localeCompare(b.user_id))
  const self = participants.filter((p) => p.user_id === selfId)
  return [...self, ...others]
}

/**
 * Who is in the document right now: a compact stack of avatars and, when
 * others are here, how many people are online (distinct users, as the
 * server counts them). The count opens the full list with each person's
 * role, from the same presence message. Names are
 * screen-reader text plus a tooltip; only the server's display name and
 * role are shown (never emails). `participants` is null while there is no
 * live connection; then nothing is shown (the status pill already says
 * "Offline" or "Connecting"), so a list from a dropped connection is never
 * presented as current.
 */
export function ParticipantList({ participants, selfId }: { participants: Participant[] | null; selfId: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)
  const popId = useId()

  // The list closes on Escape (focus back to the button) or a click outside.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      toggle.current?.focus()
    }
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  if (participants === null) return null
  const ordered = orderParticipants(participants, selfId)
  const alone = ordered.every((p) => p.user_id === selfId)
  const shown = ordered.slice(0, MAX_SHOWN)
  const hidden = ordered.length - shown.length
  return (
    <div className="presence" ref={box}>
      <ul className="participants" aria-label="People in this document">
        {shown.map((p) => {
          const you = p.user_id === selfId
          const viewer = p.role === 'viewer'
          const cls = ['participant', you && 'self', viewer && 'is-viewer'].filter(Boolean).join(' ')
          return (
            <li key={p.user_id} className={cls} title={`${you ? 'You' : p.display_name} · ${viewer ? 'viewing' : p.role}`}>
              <Avatar id={p.user_id} name={p.display_name} size="sm" />
              <span className="sr-only">
                {you ? 'You' : p.display_name}
                {viewer && ' (viewing)'}
              </span>
            </li>
          )
        })}
        {hidden > 0 && <li className="participant more">+{hidden} more</li>}
        {alone && <li className="participant alone">Only you here</li>}
      </ul>
      {!alone && (
        <button
          ref={toggle}
          type="button"
          className="presence-count"
          aria-expanded={open}
          aria-controls={popId}
          aria-label={`${ordered.length} online: show who`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="online-dot" aria-hidden="true" />
          {ordered.length} online
        </button>
      )}
      {!alone && open && (
        <div className="presence-pop" id={popId} role="region" aria-label="Who is here">
          <p className="presence-pop-head">Connected now</p>
          <ul>
            {ordered.map((p) => (
              <li key={p.user_id}>
                <Avatar id={p.user_id} name={p.display_name} size="sm" />
                <span className="presence-name">
                  {p.display_name}
                  {p.user_id === selfId && <span className="muted"> (you)</span>}
                </span>
                <span className="presence-role">{roleText[p.role] ?? p.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
