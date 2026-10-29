// Light/dark theme. The theme is an attribute on <html> (set before first
// paint by public/theme-init.js) and CSS variables do the rest, so switching
// re-renders only the components that show the setting (the toggle and the
// Settings page); the editor and its Y.Doc are untouched.
import { useSyncExternalStore } from 'react'

export type Theme = 'light' | 'dark'
export type ThemePreference = Theme | 'system'

const KEY = 'collabspace-theme'
const listeners = new Set<() => void>()

/** The user's explicit choice, or null when following the system. */
export function storedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null // storage blocked (private mode, policy): follow the system
  }
}

export function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function apply(theme: Theme) {
  document.documentElement.setAttribute('data-theme', theme)
  for (const l of listeners) l()
}

/** Remember an explicit theme, or go back to following the system. */
export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch {
    // The choice still applies to this page; it just won't be remembered.
  }
  apply(pref === 'system' ? systemTheme() : pref)
}

// Follow the operating system while there is no explicit choice.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (storedTheme() === null) apply(systemTheme())
  })
}

function snapshot(): string {
  const theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  return `${theme}|${storedTheme() ?? 'system'}`
}

export function useTheme(): { theme: Theme; preference: ThemePreference } {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    snapshot,
  )
  const [theme, preference] = s.split('|') as [Theme, ThemePreference]
  return { theme, preference }
}
