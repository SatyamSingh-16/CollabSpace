// @vitest-environment jsdom
// Goals live in localStorage only (no server API): per account, per day.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearAllGoals, dayKey, loadGoals, useGoals } from './goals'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
let api: ReturnType<typeof useGoals>

function Probe({ userId }: { userId: string }) {
  api = useGoals(userId)
  return null
}

function mount(userId: string) {
  act(() => root.render(<Probe key={userId} userId={userId} />))
}

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe('goals storage', () => {
  it('adds, toggles, removes and clears completed; survives a remount', () => {
    mount('u-1')
    act(() => api.add('  Write the report  '))
    act(() => api.add('Review PR'))
    act(() => api.add('   ')) // blank: ignored
    expect(api.goals.map((g) => g.text)).toEqual(['Write the report', 'Review PR'])

    act(() => api.toggle(api.goals[0].id))
    expect(api.goals[0].done).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    mount('u-1')
    expect(api.goals.map((g) => [g.text, g.done])).toEqual([
      ['Write the report', true],
      ['Review PR', false],
    ])

    act(() => api.clearCompleted())
    expect(api.goals.map((g) => g.text)).toEqual(['Review PR'])
    act(() => api.remove(api.goals[0].id))
    expect(loadGoals('u-1')).toEqual([])
  })

  it('keeps accounts apart', () => {
    mount('u-1')
    act(() => api.add('mine'))
    mount('u-2')
    expect(api.goals).toEqual([])
    expect(loadGoals('u-1').map((g) => g.text)).toEqual(['mine'])
    clearAllGoals('u-1')
    expect(loadGoals('u-1')).toEqual([])
  })

  it('keeps days apart and drops days older than 30', () => {
    const old = dayKey(new Date(Date.now() - 40 * 86_400_000))
    const yesterday = dayKey(new Date(Date.now() - 86_400_000))
    localStorage.setItem(
      'collabspace-goals:u-1',
      JSON.stringify({
        [old]: [{ id: 'a', text: 'ancient', done: false }],
        [yesterday]: [{ id: 'b', text: 'yesterday', done: true }],
      }),
    )
    mount('u-1')
    expect(api.goals).toEqual([]) // today starts empty
    act(() => api.add('today'))
    const stored = JSON.parse(localStorage.getItem('collabspace-goals:u-1')!)
    expect(Object.keys(stored).sort()).toEqual([yesterday, dayKey()].sort())
  })

  it('ignores corrupt or malformed data instead of crashing', () => {
    localStorage.setItem('collabspace-goals:u-1', '{not json')
    expect(loadGoals('u-1')).toEqual([])
    localStorage.setItem(
      'collabspace-goals:u-1',
      JSON.stringify({ [dayKey()]: [{ id: 'ok', text: 'valid', done: false }, { id: 1 }, null, 'x'], 'bad-day': [] }),
    )
    expect(loadGoals('u-1')).toEqual([{ id: 'ok', text: 'valid', done: false }])
    localStorage.setItem('collabspace-goals:u-1', JSON.stringify([1, 2]))
    expect(loadGoals('u-1')).toEqual([])
  })

  it('caps text length and the number of goals', () => {
    mount('u-1')
    act(() => api.add('x'.repeat(500)))
    expect(api.goals[0].text).toHaveLength(200)
    for (let i = 0; i < api.limit + 5; i++) act(() => api.add(`g${i}`))
    expect(api.goals).toHaveLength(api.limit)
  })

  it('reports when the browser refuses to save', () => {
    mount('u-1')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    act(() => api.add('not saved'))
    expect(api.saveFailed).toBe(true)
    expect(api.goals.map((g) => g.text)).toEqual(['not saved']) // still shown for this session
  })
})
