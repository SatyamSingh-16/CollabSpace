// @vitest-environment jsdom
// The constellation: a stable seeded layout; continuous drift (persistent
// velocities, wrap-around, no jumps, capped time steps) with links
// recomputed every frame; pointer lines that follow the pointer and fade
// when it leaves; one loop that stops when hidden and resumes cleanly;
// still with reduced motion; drift-only on touch; no React renders; cleanup.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConstellationBackground, createConstellation, findLinks, layoutConstellation } from './Constellation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let frames: Map<number, FrameRequestCallback>
let nextFrame = 1
let now = 0
let fine = true
let reduced = false
let hidden = false
const mediaListeners: (() => void)[] = []

// Runs pending frames, advancing the clock by `step` ms each time.
function runFor(ms: number, step = 16) {
  const end = now + ms
  while (now < end && frames.size > 0) {
    now += step
    const pending = [...frames.entries()]
    frames.clear()
    for (const [, cb] of pending) cb(now)
  }
}

function fakeContext() {
  const calls: string[] = []
  const styles: string[] = []
  const ctx = new Proxy(
    { calls, styles, setTransform: vi.fn() },
    {
      get: (t, k) => (k in t ? t[k as keyof typeof t] : (..._: unknown[]) => calls.push(String(k))),
      set: (t, k, v) => {
        if (k === 'fillStyle' || k === 'strokeStyle') t.styles.push(String(v))
        else (t as Record<string | symbol, unknown>)[k] = v
        return true
      },
    },
  )
  return ctx as unknown as CanvasRenderingContext2D & { calls: string[]; styles: string[]; setTransform: ReturnType<typeof vi.fn> }
}
const parse = (style: string) => style.match(/[\d.]+/g)!.map(Number) // [r, g, b, a]
function move(x: number, y: number, pointerType = 'mouse') {
  const e = new MouseEvent('pointermove', { clientX: x, clientY: y })
  Object.defineProperty(e, 'pointerType', { value: pointerType })
  window.dispatchEvent(e)
}
const leave = () => document.dispatchEvent(new MouseEvent('mouseout', { relatedTarget: null }))

const created: { destroy: () => void }[] = []
beforeEach(() => {
  frames = new Map()
  now = 1000
  fine = true
  reduced = false
  hidden = false
  mediaListeners.length = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, cb)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q.includes('reduced-motion') ? reduced : fine
    },
    addEventListener: (_: string, cb: () => void) => mediaListeners.push(cb),
    removeEventListener: (_: string, cb: () => void) => mediaListeners.splice(mediaListeners.indexOf(cb), 1),
  }))
  vi.stubGlobal('devicePixelRatio', 2)
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
})
afterEach(() => {
  created.splice(0).forEach((c) => c.destroy())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

function setup(w = 1280, h = 800, opts = {}) {
  const canvas = document.createElement('canvas')
  Object.defineProperty(canvas, 'clientWidth', { value: w, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: h, configurable: true })
  document.body.append(canvas)
  const ctx = fakeContext()
  const c = createConstellation(canvas, ctx, opts)
  created.push(c)
  return { canvas, ctx, c }
}

describe('layoutConstellation', () => {
  it('is deterministic, including every velocity', () => {
    expect(layoutConstellation(1280, 800)).toEqual(layoutConstellation(1280, 800))
  })

  it('is bounded, on screen, with slow persistent velocities', () => {
    for (const [w, h] of [
      [390, 844],
      [1280, 800],
      [7680, 4320],
    ]) {
      const pts = layoutConstellation(w, h)
      expect(pts.length).toBeGreaterThan(5)
      expect(pts.length).toBeLessThanOrEqual(260)
      for (const p of pts) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x).toBeLessThanOrEqual(w)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeLessThanOrEqual(h)
        const speed = Math.hypot(p.vx, p.vy)
        expect(speed).toBeGreaterThanOrEqual(7 - 1e-9) // never still…
        expect(speed).toBeLessThanOrEqual(15 + 1e-9) // …never fast
        expect(p.r).toBeGreaterThanOrEqual(1.5)
        expect(p.r).toBeLessThanOrEqual(2.6)
      }
    }
  })
})

describe('findLinks (spatial grid)', () => {
  it('finds exactly the pairs a brute-force check finds', () => {
    const pts = layoutConstellation(1280, 800)
    const xs = Float32Array.from(pts.map((p) => p.x))
    const ys = Float32Array.from(pts.map((p) => p.y))
    const grid = findLinks(xs, ys, pts.length, 118).map(({ i, j }) => `${i}-${j}`).sort()
    const brute: string[] = []
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++) if (Math.hypot(xs[i] - xs[j], ys[i] - ys[j]) < 118) brute.push(`${i}-${j}`)
    expect(grid).toEqual(brute.sort())
    expect(grid.length).toBeLessThan(pts.length * 5) // a network, not a mesh
  })
})

describe('ambient drift', () => {
  it('keeps moving for 10 s with the pointer idle: smooth, no jumps, same nodes', () => {
    const { c } = setup()
    const start = c.nodes()
    let prev = start
    for (let s = 0; s < 100; s++) {
      const t0 = now
      runFor(100)
      const elapsed = (now - t0) / 1000
      const cur = c.nodes()
      expect(cur).toHaveLength(start.length) // never regenerated
      cur.forEach((p, i) => {
        expect(p.vx).toBe(start[i].vx) // velocities persist
        const d = Math.hypot(p.x - prev[i].x, p.y - prev[i].y)
        // At most top speed × elapsed time: smooth, no jumps (a wrap, off
        // screen, is the only big step; tested separately).
        if (d < 500) expect(d).toBeLessThanOrEqual(15 * elapsed + 0.01)
      })
      prev = cur
    }
    expect(now - 1000).toBeGreaterThanOrEqual(10_000)
    expect(frames.size).toBe(1) // still running
    const moved = c.nodes().map((p, i) => Math.hypot(p.x - start[i].x, p.y - start[i].y))
    expect(Math.min(...moved)).toBeGreaterThan(0) // every node moved
  })

  it('wraps nodes around the edges, off screen', () => {
    const { c } = setup(400, 300)
    const wrapped = new Set<number>()
    let prev = c.nodes()
    for (let s = 0; s < 400; s++) {
      runFor(100)
      const cur = c.nodes()
      cur.forEach((p, i) => {
        expect(p.x).toBeGreaterThanOrEqual(-24 - 2)
        expect(p.x).toBeLessThanOrEqual(400 + 24 + 2)
        expect(p.y).toBeGreaterThanOrEqual(-24 - 2)
        expect(p.y).toBeLessThanOrEqual(300 + 24 + 2)
        if (Math.abs(p.x - prev[i].x) > 200 || Math.abs(p.y - prev[i].y) > 150) {
          wrapped.add(i)
          // a wrap happens only beyond an edge, where it can't be seen
          expect(prev[i].x < 0 || prev[i].x > 400 || prev[i].y < 0 || prev[i].y > 300).toBe(true)
        }
      })
      prev = cur
    }
    expect(wrapped.size).toBeGreaterThan(0)
  })

  it('recomputes links every frame as nodes drift', () => {
    const { c } = setup()
    const counts = new Set<number>()
    for (let s = 0; s < 40; s++) {
      runFor(250)
      counts.add(c.frameInfo().links)
    }
    expect(counts.size).toBeGreaterThan(1) // the network changes as it drifts
  })

  it('caps the time step: a long pause never makes nodes jump', () => {
    const { c } = setup()
    runFor(32)
    const before = c.nodes()
    now += 5000 // e.g. a debugger pause
    runFor(16)
    c.nodes().forEach((p, i) => {
      const d = Math.hypot(p.x - before[i].x, p.y - before[i].y)
      if (d < 500) expect(d).toBeLessThanOrEqual(15 * 0.05 + 0.01)
    })
  })
})

describe('pointer', () => {
  it('draws up to 6 lines from the pointer to nearby nodes, following it every frame', () => {
    const { c, ctx } = setup()
    expect(c.frameInfo().pointerLinks).toBe(0)
    move(640, 400)
    runFor(600)
    expect(c.frameInfo().pointerLinks).toBeGreaterThan(0)
    expect(c.frameInfo().pointerLinks).toBeLessThanOrEqual(6)
    // Pointer lines start at the pointer: their moveTo is (640, 400).
    const moves: number[][] = []
    ;(ctx as unknown as { moveTo: (x: number, y: number) => void }).moveTo = (x, y) => moves.push([x, y])
    runFor(16)
    expect(moves.filter(([x, y]) => x === 640 && y === 400).length).toBe(c.frameInfo().pointerLinks)
    // Without further pointer events they are still drawn every frame…
    moves.length = 0
    runFor(16)
    expect(moves.filter(([x, y]) => x === 640 && y === 400).length).toBe(c.frameInfo().pointerLinks)
    // …and when the pointer moves, they move with it.
    move(300, 300)
    moves.length = 0
    runFor(16)
    expect(moves.some(([x, y]) => x === 300 && y === 300)).toBe(true)
    expect(moves.some(([x, y]) => x === 640 && y === 400)).toBe(false)
  })

  it('brightens nearby nodes smoothly; links near the pointer reach 0.65+', () => {
    const { c, ctx } = setup()
    const n0 = c.nodes()
    const i = Math.floor(n0.length / 2)
    move(n0[i].x + 30, n0[i].y)
    let prevGlow = 0
    for (let s = 0; s < 30; s++) {
      runFor(16)
      const g = c.frameInfo().glows[i]
      expect(g).toBeGreaterThanOrEqual(prevGlow - 0.05) // eases up, no flicker
      prevGlow = g
    }
    expect(prevGlow).toBeGreaterThan(0.8)
    ctx.styles.length = 0
    runFor(16)
    expect(Math.max(...ctx.styles.map((st) => parse(st)[3]))).toBeGreaterThanOrEqual(0.65)
  })

  it('fades its lines out when the pointer leaves, while the drift continues', () => {
    const { c } = setup()
    move(640, 400)
    runFor(600)
    expect(c.frameInfo().presence).toBeGreaterThan(0.9)
    leave()
    runFor(100)
    const fading = c.frameInfo().presence
    expect(fading).toBeGreaterThan(0) // fading, not cut off
    expect(fading).toBeLessThan(0.9)
    const before = c.nodes()
    runFor(2000)
    expect(c.frameInfo().presence).toBe(0)
    expect(c.frameInfo().pointerLinks).toBe(0)
    expect(c.nodes()[0]).not.toEqual(before[0]) // still drifting
    expect(frames.size).toBe(1)
  })

  it('touch: the drift continues and the pointer is ignored', () => {
    fine = false
    const { c } = setup()
    const before = c.nodes()
    move(640, 400, 'touch')
    move(640, 400)
    runFor(1000)
    expect(c.frameInfo().pointerLinks).toBe(0)
    expect(c.nodes()[0]).not.toEqual(before[0])
  })
})

describe('lifecycle', () => {
  it('reduced motion: drawn once, still; no loop, no pointer; switching it off live starts the drift', () => {
    reduced = true
    const { c, ctx } = setup()
    expect(ctx.calls.filter((k) => k === 'arc').length).toBeGreaterThan(0) // a visible, static network
    expect(frames.size).toBe(0)
    const before = c.nodes()
    move(640, 400)
    runFor(1000)
    expect(c.nodes()).toEqual(before)
    expect(c.frameInfo().pointerLinks).toBe(0)
    reduced = false
    mediaListeners.forEach((cb) => cb())
    runFor(1000)
    expect(c.nodes()[0]).not.toEqual(before[0])
  })

  it('stops when the page is hidden and resumes without a jump', () => {
    const { c } = setup()
    runFor(200)
    hidden = true
    document.dispatchEvent(new Event('visibilitychange'))
    expect(frames.size).toBe(0)
    const before = c.nodes()
    now += 60_000 // a minute in another tab
    hidden = false
    document.dispatchEvent(new Event('visibilitychange'))
    runFor(32)
    c.nodes().forEach((p, i) => {
      const d = Math.hypot(p.x - before[i].x, p.y - before[i].y)
      if (d < 500) expect(d).toBeLessThanOrEqual(15 * 0.05 + 0.01)
    })
    expect(frames.size).toBe(1)
  })

  it('resizes for the pixel ratio and keeps its nodes (scaled), adding or dropping only at the end', () => {
    const { canvas, ctx, c } = setup(1280, 800)
    expect([canvas.width, canvas.height]).toEqual([2560, 1600])
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
    runFor(100)
    const before = c.nodes()
    Object.defineProperty(canvas, 'clientWidth', { value: 640, configurable: true })
    window.dispatchEvent(new Event('resize'))
    runFor(16)
    expect(canvas.width).toBe(1280)
    const after = c.nodes()
    expect(after.length).toBe(layoutConstellation(640, 800).length)
    after.slice(0, Math.min(before.length, after.length)).forEach((p, i) => {
      expect(p.vx).toBe(before[i].vx) // the same node
      expect(Math.abs(p.x - before[i].x / 2)).toBeLessThan(1) // scaled to the new width
    })
  })

  it('draws in monochrome only', () => {
    const { ctx, c } = setup()
    move(640, 400)
    runFor(300)
    for (const st of ctx.styles) {
      const [r, g, b] = parse(st)
      expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(16) // no hue (a purple spreads 100+)
    }
    expect(c.frameInfo().links).toBeGreaterThan(0)
  })

  it('dims the network behind quiet elements, and keeps it full elsewhere', () => {
    const panel = document.createElement('div')
    panel.className = 'quiet-here'
    panel.getBoundingClientRect = () => ({ left: 0, top: 0, right: 640, bottom: 800, width: 640, height: 800, x: 0, y: 0, toJSON: () => ({}) })
    document.body.append(panel)
    const arcs: { x: number; alpha: number }[] = []
    const { ctx } = setup(1280, 800, { quiet: '.quiet-here', quietFloor: 0.2 })
    ;(ctx as unknown as { arc: (x: number) => void }).arc = (x) => arcs.push({ x, alpha: parse(ctx.styles[ctx.styles.length - 1])[3] })
    runFor(16)
    for (const { x, alpha } of arcs) {
      if (x < 600) expect(alpha).toBeLessThanOrEqual(0.2 * 0.96)
      if (x > 760) expect(alpha).toBeGreaterThanOrEqual(0.6)
    }
    expect(arcs.length).toBeGreaterThan(50)
  })

  it('cleans up listeners, observers and frames', () => {
    const removeWin = vi.spyOn(window, 'removeEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const { c } = setup()
    expect(frames.size).toBe(1)
    c.destroy()
    expect(frames.size).toBe(0)
    expect(removeWin).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeWin).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    expect(mediaListeners).toHaveLength(0)
    move(500, 300)
    runFor(100)
    expect(frames.size).toBe(0)
    removeWin.mockRestore()
    removeDoc.mockRestore()
  })
})

describe('ConstellationBackground', () => {
  let container: HTMLDivElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  it('without canvas support, leaves a plain decorative canvas and never throws', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    act(() => root.render(<ConstellationBackground />))
    const canvas = container.querySelector('canvas')!
    expect(canvas.className).toBe('constellation')
    expect(canvas.getAttribute('aria-hidden')).toBe('true')
    act(() => root.unmount())
  })

  it('animates without ever re-rendering React, and stops on unmount', () => {
    let renders = 0
    const ctx = fakeContext()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as never)
    function Counted() {
      renders++
      return <ConstellationBackground />
    }
    act(() => root.render(<Counted />))
    const before = renders
    for (let x = 100; x < 600; x += 50) move(x, 300)
    runFor(1000)
    expect(ctx.calls.length).toBeGreaterThan(0)
    expect(renders).toBe(before)
    act(() => root.unmount())
    expect(frames.size).toBe(0)
  })
})
