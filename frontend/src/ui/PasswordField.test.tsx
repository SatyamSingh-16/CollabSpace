// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PasswordField } from './PasswordField'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
const onSubmit = vi.fn((e: Event) => e.preventDefault())

function Form() {
  const [value, setValue] = useState('')
  return (
    <form onSubmit={(e) => onSubmit(e.nativeEvent)}>
      <PasswordField value={value} onChange={setValue} autoComplete="current-password" />
    </form>
  )
}

beforeEach(() => {
  onSubmit.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<Form />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const input = () => container.querySelector('input')!
const toggle = () => container.querySelector<HTMLButtonElement>('button.password-toggle')!

function type(value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
  input().dispatchEvent(new Event('input', { bubbles: true }))
}

describe('PasswordField', () => {
  it('is labelled and hidden by default', () => {
    const label = container.querySelector('label')!
    expect(label.textContent).toBe('Password')
    expect(label.htmlFor).toBe(input().id)
    expect(input().type).toBe('password')
    expect(toggle().getAttribute('aria-label')).toBe('Show password')
    expect(toggle().getAttribute('aria-pressed')).toBe('false')
    expect(toggle().getAttribute('aria-controls')).toBe(input().id)
  })

  it('toggles visibility without submitting, keeping the value and caret', () => {
    act(() => type('hunter22'))
    act(() => {
      input().focus()
      input().setSelectionRange(3, 3)
    })
    act(() => toggle().click())
    expect(input().type).toBe('text')
    expect(input().value).toBe('hunter22')
    expect(toggle().getAttribute('aria-label')).toBe('Hide password')
    expect(toggle().getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(input())
    expect([input().selectionStart, input().selectionEnd]).toEqual([3, 3])

    act(() => toggle().click())
    expect(input().type).toBe('password')
    expect(input().value).toBe('hunter22')
    expect(toggle().getAttribute('aria-label')).toBe('Show password')

    expect(toggle().type).toBe('button')
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('does not write the password anywhere', () => {
    const log = vi.spyOn(console, 'log')
    const set = vi.spyOn(Storage.prototype, 'setItem')
    act(() => type('do-not-store'))
    act(() => toggle().click())
    expect(log).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
    log.mockRestore()
    set.mockRestore()
  })
})
