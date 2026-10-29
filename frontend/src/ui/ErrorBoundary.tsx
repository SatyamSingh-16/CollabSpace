import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Shows what went wrong instead of a blank page if a render ever throws.
 * It is a safety net, not a fix: the error is logged and the user decides
 * whether to reload (unsaved edits in the crashed editor can't be saved).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('CollabSpace crashed:', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash" role="alert">
        <h1>Something went wrong</h1>
        <p>The page hit an unexpected error and stopped. Changes that weren't saved yet may be lost.</p>
        <pre className="crash-detail">{this.state.error.message}</pre>
        <button type="button" className="btn btn-primary" onClick={() => location.reload()}>
          Reload the page
        </button>
      </div>
    )
  }
}
