import { useEffect, useRef, useState } from 'react'
import type * as Y from 'yjs'

import { writePageSettings, type Orientation, type PageSettings, type PageSize } from '../collab/pageSettings'
import { PageIcon } from './Icons'

const SIZES: { value: PageSize; label: string }[] = [
  { value: 'a4', label: 'A4' },
  { value: 'letter', label: 'US Letter' },
]
const ORIENTATIONS: { value: Orientation; label: string }[] = [
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
]

/**
 * Page size and orientation for the document. They are stored in the
 * document's Y.Doc (collab/pageSettings.ts), so they apply to every
 * collaborator and persist; only editors can change them (the server
 * refuses changes from viewers).
 */
export function PageSetup({ doc, settings, canChange }: { doc: Y.Doc; settings: PageSettings; canChange: boolean }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      button.current?.focus()
    }
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const sizeLabel = SIZES.find((s) => s.value === settings.size)!.label
  return (
    <div className="page-setup" ref={box}>
      <button
        ref={button}
        type="button"
        className={open ? 'btn btn-secondary is-open' : 'btn btn-secondary'}
        aria-expanded={open}
        aria-controls="page-setup"
        aria-label={`Page setup: ${sizeLabel}, ${settings.orientation}`}
        onClick={() => setOpen((o) => !o)}
      >
        <PageIcon />
        {sizeLabel}
      </button>
      {open && (
        <div id="page-setup" className="tb-popover page-setup-pop" role="dialog" aria-label="Page setup">
          <p className="tb-popover-label" id="ps-size">
            Page size
          </p>
          <div className="tb-options" role="group" aria-labelledby="ps-size">
            {SIZES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={settings.size === s.value ? 'tb-option is-active' : 'tb-option'}
                aria-pressed={settings.size === s.value}
                disabled={!canChange}
                onClick={() => writePageSettings(doc, { size: s.value })}
              >
                {s.label}
              </button>
            ))}
          </div>
          <p className="tb-popover-label" id="ps-orientation">
            Orientation
          </p>
          <div className="tb-options" role="group" aria-labelledby="ps-orientation">
            {ORIENTATIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={settings.orientation === o.value ? 'tb-option is-active' : 'tb-option'}
                aria-pressed={settings.orientation === o.value}
                disabled={!canChange}
                onClick={() => writePageSettings(doc, { orientation: o.value })}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="page-setup-note">
            {canChange ? 'Applies to everyone working on this document.' : 'Only editors can change the page setup.'}
          </p>
        </div>
      )}
    </div>
  )
}
