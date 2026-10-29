// A user's initial on a colour chosen from their ID, so the same person has
// the same colour everywhere. Colours are CSS classes (no inline styles: the
// production CSP is style-src 'self').

const PALETTE = 8

function colorIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % PALETTE
}

export function initial(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? '?'
}

export function Avatar({ id, name, size = 'md' }: { id: string; name: string; size?: 'sm' | 'md' }) {
  return (
    <span className={`avatar avatar-${size} avatar-c${colorIndex(id)}`} aria-hidden="true">
      {initial(name)}
    </span>
  )
}
