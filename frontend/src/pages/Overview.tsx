import { useState, type FormEvent } from 'react'

import type { User } from '../api'
import { useGoals } from '../goals'
import { ConstellationBackground } from '../ui/Constellation'
import { ArrowRightIcon, CheckIcon, DocIcon, PlusIcon, UsersIcon } from '../ui/Icons'
import {
  CreateDocumentForm,
  DocumentRows,
  DocumentRowsSkeleton,
  LoadError,
  OnlineCount,
  useDocuments,
  useFocusRef,
} from '../ui/Documents'

function greeting(d = new Date()): string {
  const h = d.getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

/**
 * Home: real counts from the document list (including who has documents
 * open, a snapshot refreshed every 30 s), recent documents, today's goals.
 */
export function Overview({ user, handle }: { user: User; handle: (e: unknown) => string }) {
  const { docs, error, reload, refresh } = useDocuments(handle)
  const [message, setMessage] = useState<string | null>(null)
  // The same browser-local goals as the Goals page, editable here too.
  const { goals, add, toggle, limit, saveFailed } = useGoals(user.id)
  const [goalText, setGoalText] = useState('')
  const done = goals.filter((g) => g.done).length
  const addGoal = (e: FormEvent) => {
    e.preventDefault()
    add(goalText)
    setGoalText('')
  }
  const owned = docs?.filter((d) => d.role === 'owner').length
  const shared = docs ? docs.length - (owned ?? 0) : undefined
  const active = docs?.filter((d) => (d.online ?? 0) > 0).sort((a, b) => (b.online ?? 0) - (a.online ?? 0))
  const titleInput = useFocusRef()
  const first = user.display_name.trim().split(/\s+/)[0]
  const dash = '–'

  return (
    <div className="page">
      {/* Decorative: full strength between the cards, dimmed behind text. */}
      <ConstellationBackground quiet=".page-head, .stat, .panel" quietFloor={0.45} />
      <header className="page-head">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1 className="page-title">
            {greeting()}, {first}
          </h1>
          <p className="page-sub">Here's what's happening in My workspace.</p>
        </div>
      </header>

      <section className="stats" aria-label="Summary">
        <a className="stat" href="#/workspaces">
          <span className="stat-label">Documents</span>
          <span className="stat-value">{docs ? docs.length : dash}</span>
          <span className="stat-sub">{owned === undefined ? '' : `${owned} owned by you`}</span>
        </a>
        <a className="stat" href="#/workspaces">
          <span className="stat-label">Shared with you</span>
          <span className="stat-value">{shared ?? dash}</span>
          <span className="stat-sub">by other people</span>
        </a>
        <a className="stat" href="#/workspaces">
          <span className="stat-label">Open right now</span>
          <span className="stat-value">{active ? active.length : dash}</span>
          <span className="stat-sub">{active?.length === 1 ? 'document open, you included' : 'documents open, you included'}</span>
        </a>
        <a className="stat" href="#/goals">
          <span className="stat-label">Today's goals</span>
          <span className="stat-value">
            {done}
            <span className="stat-of">/{goals.length}</span>
          </span>
          <span className="stat-sub">completed</span>
        </a>
      </section>

      <div className="overview-grid">
        <section className="panel" aria-labelledby="recent-heading">
          <div className="panel-head">
            <h2 id="recent-heading">Recent documents</h2>
            <a className="panel-link" href="#/workspaces">
              View all <ArrowRightIcon />
            </a>
          </div>
          <CreateDocumentForm handle={handle} inputRef={titleInput} />
          {message && (
            <p className="form-message ok" aria-live="polite">
              {message}
            </p>
          )}
          {error && <LoadError message={error} onRetry={reload} />}
          {docs === null && !error && <DocumentRowsSkeleton />}
          {docs?.length === 0 && (
            <div className="empty-inline">
              <span className="empty-icon" aria-hidden="true">
                <DocIcon />
              </span>
              <div>
                <h3>No documents yet</h3>
                <p>Create one above, or ask someone to share theirs with you.</p>
              </div>
            </div>
          )}
          {docs && docs.length > 0 && (
            <DocumentRows
              docs={docs.slice(0, 6)}
              label="Recent documents"
              handle={handle}
              onChanged={(m) => {
                setMessage(m)
                refresh()
              }}
            />
          )}
        </section>

        <div className="overview-side">
          <section className="panel" aria-labelledby="active-heading">
            <div className="panel-head">
              <h2 id="active-heading">Active now</h2>
            </div>
            {active === undefined && !error && <p className="muted panel-empty">Loading…</p>}
            {active?.length === 0 && (
              <div className="side-empty">
                <span className="empty-icon empty-icon-sm" aria-hidden="true">
                  <UsersIcon />
                </span>
                <p className="muted">Nobody has your documents open right now.</p>
              </div>
            )}
            {active && active.length > 0 && (
              <ul className="active-list" aria-label="Documents open right now">
                {active.slice(0, 5).map((d) => (
                  <li key={d.id}>
                    <a href={`#/d/${d.id}`}>{d.title}</a>
                    <OnlineCount count={d.online} />
                  </li>
                ))}
              </ul>
            )}
            <p className="fine-print">Counts include you in other tabs. Refreshed every 30 seconds.</p>
          </section>

          <section className="panel panel-glow" aria-labelledby="goals-heading">
            <div className="panel-head">
              <h2 id="goals-heading">Today's goals</h2>
              <a className="panel-link" href="#/goals">
                Open <ArrowRightIcon />
              </a>
            </div>
            {goals.length > 0 && (
              <p className="goal-summary">
                <span className="goal-pct">{Math.round((done / goals.length) * 100)}%</span>
                <span className="goal-of">
                  {done} of {goals.length} done
                </span>
              </p>
            )}
            {goals.length > 0 && (
              <div
                className="progress progress-sm"
                role="progressbar"
                aria-label="Goals completed"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round((done / goals.length) * 100)}
              >
                <span className={`progress-bar p${Math.round((done / goals.length) * 20) * 5}`} />
              </div>
            )}
            <form className="goal-quick" onSubmit={addGoal}>
              <label className="sr-only" htmlFor="overview-goal">
                New goal
              </label>
              <input
                id="overview-goal"
                placeholder={goals.length === 0 ? 'What do you want to finish today?' : 'Add a goal'}
                value={goalText}
                maxLength={200}
                onChange={(e) => setGoalText(e.target.value)}
                disabled={goals.length >= limit}
              />
              <button type="submit" className="icon-button" aria-label="Add goal" disabled={!goalText.trim() || goals.length >= limit}>
                <PlusIcon />
              </button>
            </form>
            {goals.length > 0 && (
              <ul className="goal-list goal-list-compact" aria-label="Today's goals">
                {goals.slice(0, 5).map((g) => (
                  <li key={g.id} className={g.done ? 'goal is-done' : 'goal'}>
                    <label className="goal-check">
                      <input type="checkbox" checked={g.done} onChange={() => toggle(g.id)} />
                      <span className="checkbox" aria-hidden="true">
                        <CheckIcon />
                      </span>
                      <span className="goal-text">{g.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {goals.length > 5 && (
              <a className="panel-link" href="#/goals">
                {goals.length - 5} more on the Goals page <ArrowRightIcon />
              </a>
            )}
            {saveFailed && (
              <p className="form-message error" role="alert">
                This browser refused to save goals; they'll be gone after a reload.
              </p>
            )}
            <p className="fine-print">Saved in this browser only, for this account. Not synced to other devices.</p>
          </section>
        </div>
      </div>
    </div>
  )
}
