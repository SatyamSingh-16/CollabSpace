import { useState, type FormEvent } from 'react'

import type { User } from '../api'
import { useGoals } from '../goals'
import { CheckIcon, PlusIcon, TargetIcon, TrashIcon } from '../ui/Icons'

/**
 * Today's goals: a personal checklist. Stored in this browser only (there is
 * no goals API); the page says so rather than implying it syncs.
 */
export function Goals({ user }: { user: User }) {
  const { goals, saveFailed, add, toggle, remove, clearCompleted, limit } = useGoals(user.id)
  const [text, setText] = useState('')
  const done = goals.filter((g) => g.done).length
  const pct = goals.length ? Math.round((done / goals.length) * 100) : 0
  const full = goals.length >= limit

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!text.trim() || full) return
    add(text)
    setText('')
  }

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
          <h1 className="page-title">Today's Goals</h1>
        </div>
      </header>

      <section className="panel goals-panel">
        <div className="progress-head">
          <span className="progress-text">
            {goals.length === 0 ? 'No goals yet' : `${done} of ${goals.length} done`}
          </span>
          <span className="progress-pct">{pct}%</span>
        </div>
        <div className="progress" role="progressbar" aria-label="Goals completed" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span className={`progress-bar p${Math.round(pct / 5) * 5}`} />
        </div>

        <form className="goal-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="new-goal">
            New goal
          </label>
          <input
            id="new-goal"
            placeholder="Add a goal for today"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={200}
            disabled={full}
          />
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || full}>
            <PlusIcon />
            Add goal
          </button>
        </form>
        {full && <p className="form-message error">You've reached {limit} goals for today.</p>}

        {goals.length === 0 ? (
          <div className="empty-inline">
            <span className="empty-icon" aria-hidden="true">
              <TargetIcon />
            </span>
            <div>
              <h3>Plan your day</h3>
              <p>Add the few things you want to finish today. Check them off as you go.</p>
            </div>
          </div>
        ) : (
          <ul className="goal-list" aria-label="Today's goals">
            {goals.map((g) => (
              <li key={g.id} className={g.done ? 'goal is-done' : 'goal'}>
                <label className="goal-check">
                  <input type="checkbox" checked={g.done} onChange={() => toggle(g.id)} />
                  <span className="checkbox" aria-hidden="true">
                    <CheckIcon />
                  </span>
                  <span className="goal-text">{g.text}</span>
                </label>
                <button type="button" className="icon-button goal-remove" aria-label={`Delete goal: ${g.text}`} onClick={() => remove(g.id)}>
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}

        {done > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={clearCompleted}>
            Clear completed
          </button>
        )}
      </section>

      {saveFailed && (
        <p className="banner banner-error" role="alert">
          This browser refused to save your goals (storage is blocked or full). They'll be lost when you leave.
        </p>
      )}
      <p className="fine-print">
        Goals are saved in this browser only, for this account. They aren't synced to other devices or shared with
        collaborators.
      </p>
    </div>
  )
}
