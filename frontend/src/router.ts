// Hash routes. Document URLs (#/d/<uuid>) are unchanged from earlier
// versions; the other screens are new.
//   #/            overview      #/goals     goals
//   #/workspaces  documents     #/teams     teams
//   #/d/<uuid>    a document    #/settings  settings
//   #/d/<uuid>/share  a document with its Share panel open (owners)
import { useEffect, useState } from 'react'

import { LEAVE_WITH_UNSAVED, unsavedEdits } from './unsaved'

export type Route =
  | { page: 'overview' }
  | { page: 'workspaces' }
  | { page: 'goals' }
  | { page: 'teams' }
  | { page: 'settings' }
  | { page: 'doc'; docId: string; share?: boolean }

export function parseRoute(hash: string): Route {
  const doc = hash.match(/^#\/d\/([0-9a-f-]{36})(\/share)?$/)
  if (doc) return doc[2] ? { page: 'doc', docId: doc[1], share: true } : { page: 'doc', docId: doc[1] }
  switch (hash) {
    case '#/workspaces':
      return { page: 'workspaces' }
    case '#/goals':
      return { page: 'goals' }
    case '#/teams':
      return { page: 'teams' }
    case '#/settings':
      return { page: 'settings' }
    default:
      return { page: 'overview' }
  }
}

let skipUnsavedCheck = false

/**
 * Goes to hash. With skipUnsavedCheck, it doesn't ask about unsaved edits:
 * only for leaving a document that no longer exists (just deleted), whose
 * edits have nowhere to be saved.
 */
export function navigate(hash: string, opts: { skipUnsavedCheck?: boolean } = {}) {
  if (location.hash === hash) return // no hashchange would clear the flag
  skipUnsavedCheck = !!opts.skipUnsavedCheck
  location.hash = hash
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.hash))
  useEffect(() => {
    let shown = location.hash
    // Leaving a document unmounts its editor, and with it any edit not yet
    // saved. beforeunload doesn't fire for in-app navigation, so ask here
    // (Week 5 review R5). On "cancel", put the URL back without another
    // hashchange.
    const onChange = () => {
      if (location.hash === shown) return
      const ask = !skipUnsavedCheck
      skipUnsavedCheck = false
      if (ask && unsavedEdits() > 0 && !window.confirm(LEAVE_WITH_UNSAVED)) {
        history.replaceState(history.state, '', location.pathname + location.search + shown)
        return
      }
      shown = location.hash
      setRoute(parseRoute(location.hash))
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return route
}
