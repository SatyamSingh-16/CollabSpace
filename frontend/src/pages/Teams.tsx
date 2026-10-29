import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import { api, ApiError, type DocumentMeta, type Member } from '../api'
import { Avatar } from '../ui/Avatar'
import { LoadError } from '../ui/Documents'
import { ArrowRightIcon, DocIcon, LockIcon, UsersIcon } from '../ui/Icons'
import { MembersDialog, roleLabel, type DocTeam } from '../ui/MembersDialog'

/** Members shown on a card besides the leader; the rest are "+N". */
const PREVIEW = 3

interface TeamsData {
  /** Documents you own that someone else can access: you lead these teams. */
  led: DocTeam[]
  /** Documents shared with you. Their member lists are owner-only. */
  memberOf: DocumentMeta[]
  /** Documents you own that aren't shared with anyone (not teams). */
  unshared: number
  /** Documents you own whose member list didn't load. */
  failed: DocumentMeta[]
}

const recent = (a: DocumentMeta, b: DocumentMeta) => Date.parse(b.updated_at) - Date.parse(a.updated_at)

/**
 * Teams are shared documents seen as teams: the owner leads the team, and
 * everyone they've shared it with is a member. There's no team entity on the
 * server; this page reads the document list and, for documents you own, the
 * member list (the server lets only owners read it, since it carries email
 * addresses). For documents shared with you it shows your role and nothing
 * about the other members.
 */
export function Teams({ userId, handle }: { userId: string; handle: (e: unknown) => string }) {
  const [data, setData] = useState<TeamsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const seq = useRef(0)

  // `refresh` keeps what's shown while fetching (no skeleton, no flash);
  // an older request finishing last is ignored.
  const load = useCallback(
    async (refresh = false) => {
      const n = ++seq.current
      setError(null)
      if (!refresh) setData(null)
      try {
        const docs = await api.listDocuments()
        const owned = docs.filter((d) => d.role === 'owner')
        const lists = await Promise.allSettled(owned.map((d) => api.listMembers(d.id)))
        const next: TeamsData = { led: [], memberOf: docs.filter((d) => d.role !== 'owner').sort(recent), unshared: 0, failed: [] }
        lists.forEach((r, i) => {
          const doc = owned[i]
          if (r.status === 'fulfilled') {
            if (r.value.some((m) => m.role !== 'owner')) next.led.push({ doc, members: r.value })
            else next.unshared++
            return
          }
          const e = r.reason
          if (e instanceof ApiError && e.status === 401) throw e // the session ended
          // Deleted or no longer yours since the list was read: not a team of yours.
          if (e instanceof ApiError && (e.status === 404 || e.status === 403)) return
          next.failed.push(doc)
        })
        next.led.sort((a, b) => recent(a.doc, b.doc))
        if (n === seq.current) setData(next)
      } catch (e) {
        if (n === seq.current) setError(handle(e))
      }
    },
    [handle],
  )
  useEffect(() => {
    void load()
  }, [load])
  // Back to the tab: memberships may have changed meanwhile.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void load(true)
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const openTeam = data?.led.find((t) => t.doc.id === openId) ?? null
  // A team that disappeared on refresh (unshared, deleted) closes its dialog.
  useEffect(() => {
    if (openId && data && !openTeam) setOpenId(null)
  }, [openId, data, openTeam])

  const people = new Set(data?.led.flatMap((t) => t.members.filter((m) => m.user_id !== userId).map((m) => m.user_id)))
  const nothing = data && data.led.length === 0 && data.memberOf.length === 0 && data.failed.length === 0

  return (
    <div className="page teams-page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Teams</p>
          <h1 className="page-title">Teams</h1>
          <p className="page-sub">Every shared document is a team: its owner leads it, and the people it's shared with are its members.</p>
        </div>
      </header>

      {error && <LoadError message={error} onRetry={() => void load(data !== null)} />}

      {data === null && !error && (
        <ul className="team-grid" aria-busy="true" aria-label="Loading teams">
          {[0, 1, 2].map((i) => (
            <li key={i} className="team-card team-skeleton">
              <span className="skeleton team-skeleton-head" />
              <span className="skeleton team-skeleton-row" />
              <span className="skeleton team-skeleton-row" />
            </li>
          ))}
        </ul>
      )}

      {data && (
        <>
          {!nothing && (
            <p className="teams-summary" role="status">
              {count(data.led.length, 'team you lead', 'teams you lead')}
              {data.led.length > 0 && ` · ${count(people.size, 'person', 'people')} on them`}
              {` · ${count(data.memberOf.length, "team you're in", "teams you're in")}`}
            </p>
          )}

          {nothing && (
            <section className="panel teams-empty">
              <span className="empty-icon" aria-hidden="true">
                <UsersIcon />
              </span>
              <div>
                <h2>No document teams yet</h2>
                <p>
                  A team appears here when a document is shared. Open a document you own and use <strong>Share</strong> to invite
                  someone as an editor or viewer.
                </p>
                <a className="btn btn-secondary btn-sm" href="#/workspaces">
                  Go to your documents
                  <ArrowRightIcon />
                </a>
              </div>
            </section>
          )}

          {(data.led.length > 0 || data.failed.length > 0) && (
            <section className="teams-section" aria-labelledby="led-heading">
              <h2 id="led-heading" className="teams-heading">
                Teams you lead
              </h2>
              <ul className="team-grid" aria-labelledby="led-heading">
                {data.led.map((t) => (
                  <TeamCard key={t.doc.id} team={t} userId={userId} onViewAll={() => setOpenId(t.doc.id)} />
                ))}
                {data.failed.map((d) => (
                  <li key={d.id} className="team-card is-failed">
                    <CardHead doc={d} meta="Members couldn't be loaded" />
                    <div className="team-actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load(true)}>
                        Retry
                      </button>
                      <a className="btn btn-ghost btn-sm" href={`#/d/${d.id}`} aria-label={`Open document ${d.title}`}>
                        Open document
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.unshared > 0 && (
            <p className="teams-note">
              {count(data.unshared, 'document you own is', 'documents you own are')} not shared with anyone, so{' '}
              {data.unshared === 1 ? "it isn't a team" : "they aren't teams"} yet.
            </p>
          )}

          {data.memberOf.length > 0 && (
            <section className="teams-section" aria-labelledby="in-heading">
              <h2 id="in-heading" className="teams-heading">
                Teams you're in
              </h2>
              <ul className="team-grid" aria-labelledby="in-heading">
                {data.memberOf.map((d) => (
                  <li key={d.id} className="team-card is-member">
                    <CardHead doc={d} meta={<span className={`badge ${d.role}`}>You: {roleLabel(d.role)}</span>} />
                    <p className="team-note">
                      <LockIcon />
                      Only the team leader can see who else is on this team.
                    </p>
                    <div className="team-actions">
                      <a className="btn btn-secondary btn-sm" href={`#/d/${d.id}`} aria-label={`Open document ${d.title}`}>
                        Open document
                        <ArrowRightIcon />
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <MembersDialog team={openTeam} userId={userId} onClose={() => setOpenId(null)} />
    </div>
  )
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

function CardHead({ doc, meta }: { doc: DocumentMeta; meta: ReactNode }) {
  return (
    <div className="team-card-head">
      <span className="team-icon" aria-hidden="true">
        <DocIcon />
      </span>
      <div className="team-card-title">
        <h3>{doc.title}</h3>
        <p className="team-meta">{meta}</p>
      </div>
    </div>
  )
}

function TeamCard({ team, userId, onViewAll }: { team: DocTeam; userId: string; onViewAll: () => void }) {
  const { doc, members } = team
  const leader = members.find((m) => m.role === 'owner')
  const others = members.filter((m) => m.role !== 'owner')
  const extra = others.length - PREVIEW
  return (
    <li className="team-card">
      <CardHead doc={doc} meta={count(members.length, 'member', 'members')} />
      {leader && <PersonRow member={leader} you={leader.user_id === userId} className="team-leader" />}
      <ul className="team-preview" aria-label={`Members of ${doc.title}`}>
        {others.slice(0, PREVIEW).map((m) => (
          <PersonRow key={m.user_id} member={m} you={m.user_id === userId} as="li" />
        ))}
      </ul>
      {extra > 0 && (
        <p className="team-more" aria-label={`and ${extra} more`}>
          +{extra}
        </p>
      )}
      <div className="team-actions">
        <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="dialog" aria-label={`View all members of ${doc.title}`} onClick={onViewAll}>
          View all members
        </button>
        <a className="btn btn-ghost btn-sm" href={`#/d/${doc.id}`} aria-label={`Open document ${doc.title}`}>
          Open document
          <ArrowRightIcon />
        </a>
      </div>
    </li>
  )
}

function PersonRow({ member, you, as = 'div', className }: { member: Member; you: boolean; as?: 'div' | 'li'; className?: string }) {
  const Tag = as
  return (
    <Tag className={className ? `team-person ${className}` : 'team-person'}>
      <Avatar id={member.user_id} name={member.display_name} size="sm" />
      <span className="team-person-name">
        {member.display_name}
        {you && <span className="muted"> (you)</span>}
      </span>
      <span className={`badge ${member.role}`}>{roleLabel(member.role)}</span>
    </Tag>
  )
}
