import { useState } from 'react'

import type { User } from '../api'
import { clearAllGoals } from '../goals'
import { setThemePreference, useTheme, type ThemePreference } from '../theme'
import { Avatar } from '../ui/Avatar'

/** Settings that exist: appearance, the account (read-only), local data. */
export function Settings({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { preference } = useTheme()
  const [cleared, setCleared] = useState(false)
  const options: { value: ThemePreference; label: string; hint: string }[] = [
    { value: 'system', label: 'System', hint: 'Follow your device setting' },
    { value: 'dark', label: 'Dark', hint: 'Charcoal surfaces' },
    { value: 'light', label: 'Light', hint: 'Bright surfaces' },
  ]
  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <p className="eyebrow">Settings</p>
          <h1 className="page-title">Settings</h1>
        </div>
      </header>

      <section className="panel settings-section" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <fieldset className="choice-group">
          <legend className="sr-only">Theme</legend>
          {options.map((o) => (
            <label key={o.value} className={preference === o.value ? 'choice is-selected' : 'choice'}>
              <input type="radio" name="theme" value={o.value} checked={preference === o.value} onChange={() => setThemePreference(o.value)} />
              <span className="choice-label">{o.label}</span>
              <span className="choice-hint">{o.hint}</span>
            </label>
          ))}
        </fieldset>
        <p className="fine-print">Saved in this browser.</p>
      </section>

      <section className="panel settings-section" aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <div className="account-row">
          <Avatar id={user.id} name={user.display_name} />
          <span className="person">
            <span className="person-name">{user.display_name}</span>
            <span className="person-email">{user.email}</span>
          </span>
          <button type="button" className="btn btn-secondary" onClick={onSignOut}>
            Sign out
          </button>
        </div>
        <p className="fine-print">Changing your name, email or password isn't supported yet.</p>
      </section>

      <section className="panel settings-section" aria-labelledby="data-heading">
        <h2 id="data-heading">Data on this device</h2>
        <div className="account-row">
          <span className="person">
            <span className="person-name">Goals</span>
            <span className="person-email">Stored in this browser only. Documents are stored on the server and aren't affected.</span>
          </span>
          <button
            type="button"
            className="btn btn-secondary btn-danger"
            onClick={() => {
              if (!window.confirm('Delete all goals saved in this browser for this account?')) return
              clearAllGoals(user.id)
              setCleared(true)
            }}
          >
            Clear goals
          </button>
        </div>
        {cleared && (
          <p className="form-message ok" aria-live="polite">
            Goals cleared from this browser.
          </p>
        )}
      </section>
    </div>
  )
}
