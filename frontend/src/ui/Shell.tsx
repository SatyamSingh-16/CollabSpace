import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

import type { User } from '../api'
import type { Route } from '../router'
import { Avatar } from './Avatar'
import { CommandPalette, isMac, isPaletteShortcut, shortcutLabel } from './CommandPalette'
import { CloseIcon, FolderIcon, HomeIcon, LogOutIcon, MenuIcon, PanelLeftIcon, SearchIcon, SettingsIcon, TargetIcon, UsersIcon } from './Icons'
import { ThemeToggle } from './ThemeToggle'

const NAV = [
  { href: '#/', label: 'Overview', icon: <HomeIcon />, pages: ['overview'] },
  { href: '#/workspaces', label: 'Workspaces', icon: <FolderIcon />, pages: ['workspaces', 'doc'] },
  { href: '#/goals', label: 'Goals', icon: <TargetIcon />, pages: ['goals'] },
  { href: '#/teams', label: 'Teams', icon: <UsersIcon />, pages: ['teams'] },
  { href: '#/settings', label: 'Settings', icon: <SettingsIcon />, pages: ['settings'] },
] as const

const COLLAPSED_KEY = 'collabspace-sidebar-collapsed'
const TABLET = '(min-width: 761px) and (max-width: 1080px)'

function storedCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

// null where matchMedia doesn't exist (jsdom): treated as "doesn't match".
const media = (query: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(query) : null)

function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = media(query)
      m?.addEventListener('change', cb)
      return () => m?.removeEventListener('change', cb)
    },
    () => media(query)?.matches ?? false,
  )
}

/**
 * The signed-in layout: a persistent sidebar (a drawer on small screens)
 * and the page. Every control here does something real.
 */
export function Shell(props: { user: User; route: Route; onSignOut: () => void; children: ReactNode }) {
  const { user, route, onSignOut, children } = props
  const [open, setOpen] = useState(false) // the drawer, on small screens
  // Desktop: the sidebar can be collapsed to an icon rail (remembered in
  // this browser). Tablets always get the rail; phones get the drawer.
  const [collapsedPref, setCollapsedPref] = useState(storedCollapsed)
  const tablet = useMedia(TABLET)
  const rail = tablet || collapsedPref
  const toggleCollapsed = () => {
    const next = !collapsedPref
    setCollapsedPref(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
    } catch {
      // not remembered; still works for this page
    }
  }
  const [paletteOpen, setPaletteOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const sidebar = useRef<HTMLElement>(null)

  // Cmd+K (macOS) / Ctrl+K toggles the command palette from anywhere,
  // including inside inputs and the editor (neither binds that shortcut).
  // The browser's own Ctrl/Cmd+K is prevented only for this exact combo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return
      e.preventDefault()
      setPaletteOpen((o) => !o)
    }
    window.addEventListener('keydown', onKey, true) // capture: before the editor sees it
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
  const refocusMenu = useRef(false)
  // Close and give focus back to the menu button. The focus has to wait
  // until the button is no longer inert, so it happens after the render.
  const closeToMenu = () => {
    refocusMenu.current = true
    setOpen(false)
  }

  // Navigating closes the drawer.
  useEffect(() => setOpen(false), [route])

  // While open, the drawer is modal: focus moves into it (to the current
  // page's link), the page behind is inert, and Escape closes it. Growing
  // past the phone layout closes it too, so nothing stays inert.
  useEffect(() => {
    if (!open) {
      if (refocusMenu.current) menuButton.current?.focus()
      refocusMenu.current = false
      return
    }
    sidebar.current?.querySelector<HTMLElement>('.nav [aria-current="page"], .nav a')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeToMenu()
    }
    const wide = media('(min-width: 761px)')
    const onWide = () => wide?.matches && setOpen(false)
    document.addEventListener('keydown', onKey)
    wide?.addEventListener('change', onWide)
    return () => {
      document.removeEventListener('keydown', onKey)
      wide?.removeEventListener('change', onWide)
    }
  }, [open])

  return (
    <div className={['shell', open && 'drawer-open', rail && 'is-collapsed'].filter(Boolean).join(' ')}>
      <header className="mobile-bar" inert={open}>
        <button
          ref={menuButton}
          type="button"
          className="icon-button"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="sidebar"
          onClick={() => setOpen(true)}
        >
          <MenuIcon />
        </button>
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true">
            C
          </span>
          CollabSpace
        </a>
        <button type="button" className="icon-button mobile-search" aria-label="Search documents and pages" onClick={() => setPaletteOpen(true)}>
          <SearchIcon />
        </button>
      </header>

      {open && <div className="drawer-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />}

      <aside id="sidebar" ref={sidebar} className="sidebar" aria-label="Sidebar">
        <div className="sidebar-top">
          <a className="brand" href="#/">
            <span className="brand-mark" aria-hidden="true">
              C
            </span>
            <span className="brand-name">CollabSpace</span>
          </a>
          <button type="button" className="icon-button drawer-close" aria-label="Close navigation" onClick={closeToMenu}>
            <CloseIcon />
          </button>
          {!tablet && (
            <button
              type="button"
              className="icon-button collapse-toggle"
              aria-label={collapsedPref ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!collapsedPref}
              aria-controls="sidebar"
              title={collapsedPref ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={toggleCollapsed}
            >
              <PanelLeftIcon />
            </button>
          )}
        </div>

        {/* One workspace exists: the account's documents. Shown as a label,
            not a switcher, because there is nothing to switch to. */}
        <div className="workspace-chip" title="Your documents and the ones shared with you">
          <span className="workspace-mark" aria-hidden="true">
            {user.display_name.trim().charAt(0).toUpperCase() || 'M'}
          </span>
          <span className="workspace-text">
            <span className="workspace-name">My workspace</span>
            <span className="workspace-sub">Personal</span>
          </span>
        </div>

        <button
          type="button"
          className="nav-item search-trigger"
          aria-keyshortcuts={isMac() ? 'Meta+K' : 'Control+K'}
          title={rail ? `Search (${shortcutLabel()})` : undefined}
          onClick={() => setPaletteOpen(true)}
        >
          <span className="nav-icon">
            <SearchIcon />
          </span>
          <span className="nav-label">Search</span>
          <kbd className="nav-kbd" aria-hidden="true">
            {shortcutLabel()}
          </kbd>
        </button>

        <nav className="nav" aria-label="Main">
          {NAV.map((item) => {
            const active = (item.pages as readonly string[]).includes(route.page)
            return (
              <a
                key={item.href}
                href={item.href}
                className={active ? 'nav-item is-active' : 'nav-item'}
                aria-current={active ? 'page' : undefined}
                title={rail ? item.label : undefined}
              >
                <span className="nav-icon">{item.icon}</span>
                <span className="nav-label">{item.label}</span>
              </a>
            )
          })}
        </nav>

        <div className="sidebar-bottom">
          <ThemeToggle withLabel />
          <div className="profile">
            <Avatar id={user.id} name={user.display_name} size="sm" />
            <span className="profile-text">
              <span className="profile-name">{user.display_name}</span>
              <span className="profile-email">{user.email}</span>
            </span>
            <button type="button" className="icon-button" aria-label="Sign out" title="Sign out" onClick={onSignOut}>
              <LogOutIcon />
            </button>
          </div>
        </div>
      </aside>

      <div className="shell-main" inert={open}>
        {children}
      </div>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  )
}
