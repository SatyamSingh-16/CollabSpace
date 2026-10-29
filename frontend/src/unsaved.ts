// Every open editor's provider, so page-level actions (signing out, a
// session ending, navigating away) can ask whether any edit is unsaved.
import type { CollabProvider } from './collab/provider'

export const openProviders = new Set<CollabProvider>()

/** How many local edits are not saved on the server yet (0 if none). */
export function unsavedEdits(): number {
  let n = 0
  for (const p of openProviders) {
    const s = p.getState()
    if (!s.saved) n += Math.max(1, s.pendingCount)
  }
  return n
}

export const LEAVE_WITH_UNSAVED = 'You have changes that are not saved yet. Leave anyway and discard them?'
