import type { ProviderState } from '../collab/provider'

/**
 * Connection and save state. "Saved" only when the server has confirmed
 * every local edit (provider.saved); while anything is pending it says
 * "Saving…", and offline with pending edits it says so.
 */
export function StatusPill(props: { state: ProviderState | null; readOnly: boolean; onRetry?: () => void }) {
  const { state, readOnly, onRetry } = props
  let label = 'Connecting…'
  let tone = 'pending'
  if (state) {
    switch (state.status) {
      // After the first sync, a new connection is a reconnect: say so, and
      // whether edits are waiting to be sent (they are resent on rejoin).
      case 'connecting':
      case 'syncing':
        if (state.synced) {
          label = state.saved ? 'Reconnecting…' : 'Reconnecting · unsaved changes'
          tone = 'warn'
        } else {
          label = state.status === 'connecting' ? 'Connecting…' : 'Syncing…'
        }
        break
      case 'connected':
        label = readOnly ? 'Connected · View only' : state.saved ? 'Connected · Saved' : 'Connected · Saving…'
        tone = readOnly || state.saved ? 'ok' : 'pending'
        break
      case 'offline':
        label = state.saved ? 'Offline · reconnecting' : 'Offline · unsaved changes'
        tone = 'warn'
        break
      case 'error':
        label = `Error · ${state.error}`
        tone = 'error'
        break
    }
  }
  // A stop the page couldn't explain would otherwise leave the editor on
  // "Error" for good (Week 5 review R18).
  const retry = state?.status === 'error' && !state.diverged && onRetry
  return (
    <span className="status-wrap">
      <span className={`status status-${tone}`} role="status" aria-live="polite" title={explain(state, label)}>
        <span className="status-dot" aria-hidden="true" />
        <span className="status-label">{label}</span>
      </span>
      {retry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Retry
        </button>
      )}
    </span>
  )
}

// The tooltip says what the state means for the user's edits.
function explain(state: ProviderState | null, label: string): string {
  if (state?.status === 'connected') {
    return state.saved ? 'All your changes are saved on the server.' : 'Your latest changes are on their way; the server has not confirmed them yet.'
  }
  // Only while the provider is still trying: after a terminal error nothing will be resent.
  const retrying = state?.status === 'offline' || (!!state?.synced && (state.status === 'connecting' || state.status === 'syncing'))
  if (state && retrying && !state.saved) {
    return 'Your unsaved changes are kept in this tab and sent when the connection is back. Keep the tab open.'
  }
  return label
}
