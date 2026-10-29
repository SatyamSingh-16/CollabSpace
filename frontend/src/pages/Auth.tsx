import { useState, type FormEvent } from 'react'

import { api, ApiError, type User } from '../api'
import { PasswordField } from '../ui/PasswordField'
import { ConstellationBackground } from '../ui/Constellation'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Sign in / create account. Validation here only gives early feedback; the
 * server checks everything again and its messages are shown as they come.
 */
export function AuthScreen(props: { onSignedIn: (u: User) => void; email?: string; compact?: boolean }) {
  const { onSignedIn, email: initialEmail = '', compact = false } = props
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const register = mode === 'register'

  const problems = {
    name: register && !name.trim() ? 'Enter your name.' : null,
    email: !email.trim() ? 'Enter your email address.' : !EMAIL.test(email.trim()) ? 'Enter a valid email address.' : null,
    password: !password
      ? 'Enter your password.'
      : register && password.length < 8
        ? 'Use at least 8 characters.'
        : null,
  }
  const show = (k: keyof typeof problems) => (touched[k] ? problems[k] : null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched({ name: true, email: true, password: true })
    if (problems.name || problems.email || problems.password) return
    setBusy(true)
    setError(null)
    try {
      onSignedIn(register ? await api.register(email, password, name) : await api.login(email, password))
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
      setPassword('') // never keep the password around longer than needed
    }
  }

  function switchMode() {
    setMode(register ? 'login' : 'register')
    setError(null)
    setTouched({})
  }

  const form = (
    <form className={compact ? 'auth-card auth-card-inline' : 'auth-card'} onSubmit={submit} noValidate aria-labelledby="auth-heading">
      <h2 id="auth-heading">{register ? 'Create an account' : 'Sign in'}</h2>
      <p className="auth-sub">{register ? 'Start writing with your team in a minute.' : 'Welcome back. Sign in to see your documents.'}</p>

      {register && (
        <div className="field">
          <label className="field-label" htmlFor="auth-name">
            Name
          </label>
          <input
            id="auth-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, name: true }))}
            maxLength={100}
            autoComplete="name"
            aria-invalid={show('name') ? true : undefined}
            aria-describedby={show('name') ? 'auth-name-error' : undefined}
          />
          {show('name') && (
            <span className="field-error" id="auth-name-error">
              {show('name')}
            </span>
          )}
        </div>
      )}

      <div className="field">
        <label className="field-label" htmlFor="auth-email">
          Email
        </label>
        <input
          id="auth-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setTouched((t) => ({ ...t, email: true }))}
          autoComplete="email"
          aria-invalid={show('email') ? true : undefined}
          aria-describedby={show('email') ? 'auth-email-error' : undefined}
        />
        {show('email') && (
          <span className="field-error" id="auth-email-error">
            {show('email')}
          </span>
        )}
      </div>

      <PasswordField
        value={password}
        onChange={setPassword}
        autoComplete={register ? 'new-password' : 'current-password'}
        minLength={register ? 8 : undefined}
        hint={register ? 'At least 8 characters.' : undefined}
        error={show('password')}
        onBlur={() => setTouched((t) => ({ ...t, password: true }))}
      />

      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? (register ? 'Creating account…' : 'Signing in…') : register ? 'Create account' : 'Sign in'}
      </button>
      <p className="auth-switch">
        {register ? 'Already have an account?' : "Don't have an account?"}{' '}
        <button type="button" className="btn-link" onClick={switchMode}>
          {register ? 'Sign in' : 'Create one'}
        </button>
      </p>
    </form>
  )
  if (compact) return form

  return (
    <div className="auth">
      {/* Decorative: an interactive constellation behind the page, dimmed behind the form. */}
      <ConstellationBackground quiet=".auth-card, .auth-head" quietFloor={0.3} />
      <header className="auth-head">
        <div className="brand brand-lg">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          CollabSpace
        </div>
        <p className="auth-tagline">Write together, in real time.</p>
      </header>
      {form}
    </div>
  )
}
