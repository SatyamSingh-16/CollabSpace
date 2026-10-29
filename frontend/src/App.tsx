import { useCallback, useEffect, useState } from 'react'

import { api, ApiError, type User } from './api'
import { AuthScreen } from './pages/Auth'
import { DocumentPage } from './pages/DocumentPage'
import { Goals } from './pages/Goals'
import { Overview } from './pages/Overview'
import { Settings } from './pages/Settings'
import { Teams } from './pages/Teams'
import { Workspaces } from './pages/Workspaces'
import { useRoute, type Route } from './router'
import { Shell } from './ui/Shell'
import { LEAVE_WITH_UNSAVED, openProviders, unsavedEdits } from './unsaved'

export { unsavedEdits } from './unsaved'

// --- session gate ---

export function App() {
  // undefined = still asking the server; null = signed out.
  const [user, setUser] = useState<User | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // The session ended while an editor held unsaved edits: keep the editor
  // mounted (read-only, its provider stopped) and ask the user to sign in
  // again, instead of unmounting it and losing the edits (Week 5 review R1).
  const [sessionEnded, setSessionEnded] = useState(false)
  const route = useRoute()
  useEffect(() => {
    api.me().then(setUser, (e) => setError(e instanceof ApiError ? e.message : 'Could not reach the server.'))
  }, [])

  // The server clears the cookie even when revoking the session fails, but
  // the UI only shows "signed out" once /me confirms there is no session.
  const signOut = useCallback(async () => {
    if (unsavedEdits() > 0 && !window.confirm(LEAVE_WITH_UNSAVED)) return
    setError(null)
    setSessionEnded(false)
    const failed = await api.logout().then(() => false, () => true)
    try {
      const still = await api.me()
      setUser(still)
      if (still) setError('Sign-out failed. Please try again.')
      else if (failed) setError('Signed out on this device; the server could not revoke the session yet.')
    } catch {
      setError('Sign-out could not be confirmed. Close the browser to be safe.')
    }
  }, [])
  // Any 401 from here on means the session expired or was revoked.
  const sessionExpired = useCallback(() => {
    if (unsavedEdits() > 0) {
      setSessionEnded(true)
      return
    }
    setUser(null)
    setNotice('Your session ended. Please sign in again.')
  }, [])

  // Signed in again. Same account: resume the stopped editors, which resend
  // their unsaved edits. Another account: the page starts over for it
  // (the page is keyed by user), and the old account's edits are dropped.
  const signedIn = useCallback(
    (u: User) => {
      setNotice(null)
      setError(null)
      if (sessionEnded && user && u.id === user.id) {
        for (const p of openProviders) if (p.getState().closeCode === 4001) p.restart()
      }
      setSessionEnded(false)
      setUser(u)
    },
    [sessionEnded, user],
  )

  const banners = (
    <>
      {error && (
        <p className="banner banner-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="banner banner-notice">{notice}</p>}
    </>
  )

  if (!user) {
    return (
      <main className="auth-page">
        {banners}
        {!error && user === undefined && <p className="muted loading-line">Loading…</p>}
        {user === null && <AuthScreen onSignedIn={signedIn} />}
      </main>
    )
  }

  return (
    <Shell user={user} route={route} onSignOut={signOut}>
      <main className="main">
        {banners}
        {sessionEnded && (
          <section className="reauth">
            <p className="banner banner-notice">
              Your session ended. Sign in again as {user.email} to save your unsaved changes. Signing in with another
              account discards them.
            </p>
            <AuthScreen onSignedIn={signedIn} email={user.email} compact />
          </section>
        )}
        <Page key={user.id} user={user} route={route} onSessionExpired={sessionExpired} onSignOut={signOut} />
      </main>
    </Shell>
  )
}

function Page(props: { user: User; route: Route; onSessionExpired: () => void; onSignOut: () => void }) {
  const { user, route, onSessionExpired, onSignOut } = props
  // Route API failures: 401 → back to sign-in; others are shown in place.
  const handle = useCallback(
    (e: unknown): string => {
      if (e instanceof ApiError && e.status === 401) onSessionExpired()
      return e instanceof ApiError ? e.message : 'Something went wrong.'
    },
    [onSessionExpired],
  )
  switch (route.page) {
    case 'doc':
      return (
        <DocumentPage
          key={route.docId}
          docId={route.docId}
          openShare={route.share}
          user={user}
          handle={handle}
          onSessionExpired={onSessionExpired}
        />
      )
    case 'workspaces':
      return <Workspaces handle={handle} />
    case 'goals':
      return <Goals user={user} />
    case 'teams':
      return <Teams userId={user.id} handle={handle} />
    case 'settings':
      return <Settings user={user} onSignOut={onSignOut} />
    default:
      return <Overview user={user} handle={handle} />
  }
}
