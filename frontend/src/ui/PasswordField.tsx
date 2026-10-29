import { useId, useLayoutEffect, useRef, useState } from 'react'

import { EyeIcon, EyeOffIcon } from './Icons'

/**
 * A password input with a show/hide toggle. The toggle is type="button"
 * (it never submits), keeps the typed value, and puts the caret back where
 * it was. The value lives only in the parent form's state; nothing is
 * stored or logged.
 */
export function PasswordField(props: {
  value: string
  onChange: (v: string) => void
  autoComplete: string
  minLength?: number
  error?: string | null
  hint?: string
  onBlur?: () => void
}) {
  const { value, onChange, autoComplete, minLength, error, hint, onBlur } = props
  const [visible, setVisible] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const caret = useRef<[number | null, number | null] | null>(null)
  const id = useId()
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined

  // Changing the input's type can reset the selection; restore it.
  useLayoutEffect(() => {
    const sel = caret.current
    if (sel && input.current && document.activeElement === input.current) {
      input.current.setSelectionRange(sel[0], sel[1])
    }
    caret.current = null
  }, [visible])

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        Password
      </label>
      <div className="password-wrap">
        <input
          ref={input}
          id={id}
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          autoComplete={autoComplete}
          minLength={minLength}
          required
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          spellCheck={false}
          autoCapitalize="off"
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          aria-controls={id}
          title={visible ? 'Hide password' : 'Show password'}
          // Keep focus (and the caret) in the input when clicked.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = input.current
            caret.current = el ? [el.selectionStart, el.selectionEnd] : null
            setVisible((v) => !v)
          }}
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
      {hint && !error && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </div>
  )
}
