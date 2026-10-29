// Today's goals. There is no goals API or table on the server, so goals are
// stored in this browser's localStorage only: per account and per day, not
// synced to other devices and not visible to collaborators. The UI says so.
import { useCallback, useState } from 'react'

export interface Goal {
  id: string
  text: string
  done: boolean
}

const MAX_GOALS = 50
const MAX_TEXT = 200
const KEEP_DAYS = 30

/** Local calendar date, YYYY-MM-DD. */
export function dayKey(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

const storageKey = (userId: string) => `collabspace-goals:${userId}`

type Store = Record<string, Goal[]> // day -> goals

function read(userId: string): Store {
  try {
    const raw = localStorage.getItem(storageKey(userId))
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Store = {}
    for (const [day, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Array.isArray(list)) continue
      out[day] = list
        .filter((g): g is Goal => !!g && typeof g.id === 'string' && typeof g.text === 'string' && typeof g.done === 'boolean')
        .slice(0, MAX_GOALS)
    }
    return out
  } catch {
    return {} // unreadable or blocked storage: start empty rather than crash
  }
}

function write(userId: string, store: Store): boolean {
  // Drop days older than KEEP_DAYS so storage doesn't grow forever.
  const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86_400_000))
  const kept = Object.fromEntries(Object.entries(store).filter(([day]) => day >= cutoff))
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(kept))
    return true
  } catch {
    return false
  }
}

export function loadGoals(userId: string, day = dayKey()): Goal[] {
  return read(userId)[day] ?? []
}

/** Today's goals for one account, kept in localStorage. */
export function useGoals(userId: string) {
  const [day] = useState(dayKey)
  const [goals, setGoals] = useState<Goal[]>(() => loadGoals(userId, day))
  const [saveFailed, setSaveFailed] = useState(false)

  const update = useCallback(
    (next: (goals: Goal[]) => Goal[]) => {
      setGoals((current) => {
        const list = next(current)
        const store = read(userId)
        store[day] = list
        setSaveFailed(!write(userId, store))
        return list
      })
    },
    [userId, day],
  )

  return {
    day,
    goals,
    saveFailed,
    add: (text: string) => {
      const t = text.trim().slice(0, MAX_TEXT)
      if (!t) return
      const goal = { id: crypto.randomUUID(), text: t, done: false } // outside the updater: it must be pure
      update((g) => (g.length >= MAX_GOALS ? g : [...g, goal]))
    },
    toggle: (id: string) => update((g) => g.map((x) => (x.id === id ? { ...x, done: !x.done } : x))),
    remove: (id: string) => update((g) => g.filter((x) => x.id !== id)),
    clearCompleted: () => update((g) => g.filter((x) => !x.done)),
    limit: MAX_GOALS,
  }
}

export function clearAllGoals(userId: string): void {
  try {
    localStorage.removeItem(storageKey(userId))
  } catch {
    // nothing to clear
  }
}
