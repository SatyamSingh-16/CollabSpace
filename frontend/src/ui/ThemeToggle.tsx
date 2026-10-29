import { setThemePreference, useTheme } from '../theme'
import { MoonIcon, SunIcon } from './Icons'

/**
 * Switches between dark and light and remembers the choice. It only
 * changes an attribute on <html>, so nothing else re-renders.
 */
export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const { theme } = useTheme()
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button
      type="button"
      className={withLabel ? 'nav-item' : 'icon-button'}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      onClick={() => setThemePreference(next)}
    >
      {withLabel ? (
        <span className="nav-icon">{theme === 'dark' ? <SunIcon /> : <MoonIcon />}</span>
      ) : theme === 'dark' ? (
        <SunIcon />
      ) : (
        <MoonIcon />
      )}
      {withLabel && <span className="nav-label">{next === 'light' ? 'Light theme' : 'Dark theme'}</span>}
    </button>
  )
}
