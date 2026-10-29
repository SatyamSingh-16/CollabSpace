import { useEffect, useRef } from 'react'

// A slowly drifting network of nodes and connecting lines, drawn on a canvas
// behind the page. Every node has its own small, persistent velocity and
// wraps around the edges; links are recomputed every frame from the nodes'
// current positions, so the network changes naturally as it drifts. Near the
// mouse, thin lines connect the pointer to the nearest nodes, those nodes
// brighten and ease away, and nearby links brighten; when the pointer
// leaves, its lines fade out while the drift carries on. Colors come from
// CSS tokens (--constellation-*), per theme.

const CELL = 90 // initial spread: one node per cell of a jittered grid
const MAX_POINTS = 260 // bounded, whatever the screen size
const EMPTY = 0.1 // share of cells left empty
const LINK = 118 // longest link, in CSS px; links fade in/out near this distance
const LINK_FADE = 0.25 // the outer share of LINK over which a link fades
const SPEED = [7, 15] // drift speed range, CSS px per second
const WRAP = 24 // nodes leave this far past an edge before wrapping (off screen)
const RADIUS = 170 // the pointer's reach
const POINTER_LINKS = 6 // at most this many pointer-to-node lines
const PUSH = 14 // largest displacement away from the pointer, CSS px
const RESPONSE = 9 // per second: how fast push and highlight follow (no jitter)
const PRESENCE = 6 // per second: how fast pointer lines fade in and out
const MAX_DT = 0.05 // seconds: a long pause (tab switch, debugger) never jumps
const QUIET_MARGIN = 28 // dimming starts this far outside a quiet element…
const QUIET_RAMP = 60 // …and fades out over this distance
const MAX_DPR = 2

// Visual targets (alpha before quiet zones and intensity).
const LINE_ALPHA = [0.28, 0.42] // regular links, long → short
const LINE_HOT_ALPHA = [0.65, 0.85] // links near the pointer
const POINTER_LINE_ALPHA = 0.85 // pointer-to-node lines, at the nearest

export interface Point {
  x: number
  y: number
  vx: number // CSS px per second
  vy: number
  r: number // radius, CSS px
  a: number // base opacity
  tone: 0 | 1 | 2 // gray, silver, or one of the few bright anchors
}

// A small deterministic PRNG (mulberry32), seeded per grid cell, so the
// initial layout and every node's velocity are stable, not random per load.
function rng(seed: number) {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

/** The initial nodes (position, velocity, look) for a width × height area. Deterministic. */
export function layoutConstellation(width: number, height: number): Point[] {
  // Cells divide the area exactly (about CELL px each), so every node starts
  // on screen; bigger cells on huge screens keep the count bounded.
  let cell = CELL
  while (Math.max(1, Math.round(width / cell)) * Math.max(1, Math.round(height / cell)) > MAX_POINTS) cell *= 1.1
  const cols = Math.max(1, Math.round(width / cell))
  const rows = Math.max(1, Math.round(height / cell))
  const cw = width / cols
  const ch = height / rows
  const points: Point[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const rand = rng(col * 73856093 + row * 19349663 + 1)
      if (rand() < EMPTY) continue
      const x = (col + 0.15 + rand() * 0.7) * cw
      const y = (row + 0.15 + rand() * 0.7) * ch
      const t = rand()
      const tone = t < 0.55 ? 0 : t < 0.94 ? 1 : 2 // ~6% bright anchors
      const angle = rand() * Math.PI * 2
      const speed = SPEED[0] + rand() * (SPEED[1] - SPEED[0])
      points.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        r: tone === 2 ? 2.3 + rand() * 0.3 : 1.5 + rand() * 0.9,
        a: tone === 2 ? 0.88 + rand() * 0.07 : 0.6 + rand() * 0.2,
        tone,
      })
    }
  }
  return points
}

/**
 * Every pair of positions closer than maxDist, with its distance. A uniform
 * grid of maxDist-sized cells: each position is compared only with those in
 * its own and the neighbouring cells, not with every other one.
 */
export function findLinks(xs: Float32Array, ys: Float32Array, n: number, maxDist: number): { i: number; j: number; d: number }[] {
  const cells = new Map<number, number[]>()
  const key = (cx: number, cy: number) => cx * 73856093 + cy * 19349663
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(xs[i] / maxDist), Math.floor(ys[i] / maxDist))
    const list = cells.get(k)
    if (list) list.push(i)
    else cells.set(k, [i])
  }
  const out: { i: number; j: number; d: number }[] = []
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(xs[i] / maxDist)
    const cy = Math.floor(ys[i] / maxDist)
    for (let ox = -1; ox <= 1; ox++)
      for (let oy = -1; oy <= 1; oy++) {
        const list = cells.get(key(cx + ox, cy + oy))
        if (!list) continue
        for (const j of list) {
          if (j <= i) continue
          const d = Math.hypot(xs[i] - xs[j], ys[i] - ys[j])
          if (d < maxDist) out.push({ i, j, d })
        }
      }
  }
  return out
}

const media = (q: string) => (typeof window.matchMedia === 'function' ? window.matchMedia(q) : null)
const reducedMotion = () => !!media('(prefers-reduced-motion: reduce)')?.matches

/** Pointer interaction only with a hovering fine pointer and without reduced motion. */
export function constellationInteractive(): boolean {
  return !!media('(hover: hover) and (pointer: fine)')?.matches && !reducedMotion()
}

type RGB = [number, number, number]

function rgb(value: string, fallback: string): RGB {
  const hex = (value.trim() || fallback).replace('#', '')
  const n = parseInt(hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// A color part of the way (t, 0..1) from a toward b, as an rgba() string.
const mix = (a: RGB, b: RGB, t: number, alpha: number) =>
  `rgba(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(', ')}, ${Math.min(1, alpha).toFixed(3)})`

// Frame-rate-independent easing: the share of the way to cover in dt seconds.
const ease = (rate: number, dt: number) => 1 - Math.exp(-rate * dt)

export interface ConstellationOptions {
  /** Overall opacity scale (1 = full). */
  intensity?: number
  /**
   * CSS selector of elements the network dims behind (dense text, inputs,
   * the writing canvas). It stays at full strength in the open background.
   */
  quiet?: string
  /** Opacity kept behind quiet elements (0..1). */
  quietFloor?: number
}

export interface Constellation {
  /** A snapshot of every node (current position and velocity), for tests. */
  nodes: () => { x: number; y: number; vx: number; vy: number }[]
  /** What the last frame drew, for tests. */
  frameInfo: () => { links: number; pointerLinks: number; presence: number; glows: number[] }
  destroy: () => void
}

/**
 * Runs the constellation on a canvas, with one requestAnimationFrame loop:
 * elapsed time (capped) → drift and wrap → pointer influence → links →
 * pointer lines → nodes. Pointer events only record the pointer's position;
 * React is not involved at all. With reduced motion the network is drawn
 * once, still; when the page is hidden the loop stops, and resumes cleanly.
 */
export function createConstellation(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  { intensity = 1, quiet, quietFloor = 0.35 }: ConstellationOptions = {},
): Constellation {
  let width = 0
  let height = 0
  let points: Point[] = []
  // Per node, in typed arrays: drift position, push offset, highlight.
  let px = new Float32Array(0)
  let py = new Float32Array(0)
  let ox = new Float32Array(0)
  let oy = new Float32Array(0)
  let glow = new Float32Array(0)
  let rx = new Float32Array(0) // rendered position = drift + push
  let ry = new Float32Array(0)
  let q = new Float32Array(0) // visibility (quiet zones)
  let colors: { dot: RGB[]; line: RGB; lineHot: RGB; hot: RGB; strength: number } = {
    dot: [
      [196, 200, 210],
      [222, 225, 232],
      [255, 255, 255],
    ],
    line: [190, 195, 205],
    lineHot: [235, 238, 245],
    hot: [255, 255, 255],
    strength: 1,
  }
  let pointer: { x: number; y: number } | null = null
  let lastPointer = { x: 0, y: 0 } // where the pointer was, for fading its lines out
  let presence = 0 // 0..1: the pointer's lines fade in and out
  let info = { links: 0, pointerLinks: 0, presence: 0, glows: [] as number[] }
  let frame = 0
  let last = 0
  let animate = false
  let interactive = false
  let quietRects: DOMRect[] = []
  let quietDirty = true
  let frames = 0

  const readColors = () => {
    const css = getComputedStyle(canvas)
    colors = {
      dot: [
        rgb(css.getPropertyValue('--constellation-dot'), '#c4c8d2'),
        rgb(css.getPropertyValue('--constellation-dot-2'), '#dee1e8'),
        rgb(css.getPropertyValue('--constellation-dot-3'), '#ffffff'),
      ],
      line: rgb(css.getPropertyValue('--constellation-line'), '#bec3cd'),
      lineHot: rgb(css.getPropertyValue('--constellation-line-hot'), '#ebeef5'),
      hot: rgb(css.getPropertyValue('--constellation-hot'), '#ffffff'),
      strength: parseFloat(css.getPropertyValue('--constellation-strength')) || 1, // per theme
    }
  }

  // Sizes the canvas. The first time, lays the nodes out; after that, keeps
  // every node (position scaled to the new size, same velocity) and only
  // adds or drops nodes at the end to keep the density.
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const oldW = width
    const oldH = height
    width = canvas.clientWidth || window.innerWidth
    height = canvas.clientHeight || window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const fresh = layoutConstellation(width, height)
    const keep = Math.min(points.length, fresh.length)
    const next = fresh.slice()
    const nx = new Float32Array(fresh.length)
    const ny = new Float32Array(fresh.length)
    for (let i = 0; i < fresh.length; i++) {
      if (i < keep) {
        next[i] = points[i]
        nx[i] = (px[i] * width) / (oldW || width)
        ny[i] = (py[i] * height) / (oldH || height)
      } else {
        nx[i] = fresh[i].x
        ny[i] = fresh[i].y
      }
    }
    const grow = (a: Float32Array) => {
      const b = new Float32Array(fresh.length)
      b.set(a.subarray(0, keep))
      return b
    }
    points = next
    px = nx
    py = ny
    ox = grow(ox)
    oy = grow(oy)
    glow = grow(glow)
    rx = new Float32Array(fresh.length)
    ry = new Float32Array(fresh.length)
    q = new Float32Array(fresh.length)
    quietDirty = true
  }

  // How much of the network shows at (x, y): quietFloor behind quiet
  // elements, rising to 1 a short way outside them.
  const visibility = (x: number, y: number) => {
    let v = 1
    for (const r of quietRects) {
      const d = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom))
      const t = Math.min(1, Math.max(0, (d - QUIET_MARGIN) / QUIET_RAMP))
      v = Math.min(v, quietFloor + (1 - quietFloor) * t)
    }
    return v
  }

  // 2–4. Drift (with wrap-around), then the pointer's influence, eased.
  const advance = (dt: number) => {
    const spanX = width + 2 * WRAP
    const spanY = height + 2 * WRAP
    const k = ease(RESPONSE, dt)
    const target = pointer && interactive ? pointer : null
    presence += ((target ? 1 : 0) - presence) * ease(PRESENCE, dt)
    if (presence < 0.002) presence = 0
    for (let i = 0; i < points.length; i++) {
      px[i] += points[i].vx * dt
      py[i] += points[i].vy * dt
      if (px[i] < -WRAP) px[i] += spanX
      else if (px[i] > width + WRAP) px[i] -= spanX
      if (py[i] < -WRAP) py[i] += spanY
      else if (py[i] > height + WRAP) py[i] -= spanY
      let tx = 0
      let ty = 0
      let tg = 0
      if (target) {
        const dx = px[i] - target.x
        const dy = py[i] - target.y
        const d = Math.hypot(dx, dy)
        if (d < RADIUS && d > 0.01) {
          const f = 1 - d / RADIUS
          tx = (dx / d) * PUSH * f * f
          ty = (dy / d) * PUSH * f * f
          tg = 1 - (d / RADIUS) ** 2 // holds up across most of the radius
        }
      }
      ox[i] += (tx - ox[i]) * k
      oy[i] += (ty - oy[i]) * k
      glow[i] += (tg - glow[i]) * k
      rx[i] = px[i] + ox[i]
      ry[i] = py[i] + oy[i]
    }
  }

  // 5–7. Links, pointer lines, nodes.
  const draw = () => {
    ctx.clearRect(0, 0, width, height)
    if (quietDirty || frames % 30 === 0) {
      quietRects = quiet ? [...document.querySelectorAll(quiet)].map((el) => el.getBoundingClientRect()) : []
      quietDirty = false
    }
    frames++
    const n = points.length
    for (let i = 0; i < n; i++) q[i] = visibility(rx[i], ry[i])
    const kAll = intensity * colors.strength
    ctx.lineWidth = 0.8

    // Links: recomputed from this frame's positions. Calm links are batched
    // into one path per opacity step; highlighted ones are drawn singly.
    const links = findLinks(rx, ry, n, LINK)
    const batches = new Map<number, number[]>()
    for (const { i, j, d } of links) {
      const near = 1 - d / LINK
      const fade = Math.min(1, near / LINK_FADE) // appear/disappear smoothly at the edge of range
      const g = Math.max(glow[i], glow[j])
      const base = LINE_ALPHA[0] + (LINE_ALPHA[1] - LINE_ALPHA[0]) * near
      const hot = LINE_HOT_ALPHA[0] + (LINE_HOT_ALPHA[1] - LINE_HOT_ALPHA[0]) * near
      const alpha = (base + (hot - base) * g) * fade * kAll * Math.min(q[i], q[j])
      if (alpha <= 0.004) continue
      if (g < 0.02) {
        const step = Math.round(alpha * 50)
        const list = batches.get(step)
        if (list) list.push(i, j)
        else batches.set(step, [i, j])
      } else {
        ctx.strokeStyle = mix(colors.line, colors.lineHot, g, alpha)
        ctx.beginPath()
        ctx.moveTo(rx[i], ry[i])
        ctx.lineTo(rx[j], ry[j])
        ctx.stroke()
      }
    }
    for (const [step, list] of batches) {
      ctx.strokeStyle = mix(colors.line, colors.line, 0, step / 50)
      ctx.beginPath()
      for (let m = 0; m < list.length; m += 2) {
        ctx.moveTo(rx[list[m]], ry[list[m]])
        ctx.lineTo(rx[list[m + 1]], ry[list[m + 1]])
      }
      ctx.stroke()
    }

    // Pointer lines: from the pointer to its nearest nodes, every frame, so
    // they follow it; they fade with `presence` when it leaves.
    let pointerLinks = 0
    if (presence > 0) {
      const at = pointer ?? lastPointer
      const near: { i: number; d: number }[] = []
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(rx[i] - at.x, ry[i] - at.y)
        if (d < RADIUS) near.push({ i, d })
      }
      near.sort((a, b) => a.d - b.d)
      ctx.lineWidth = 1
      for (const { i, d } of near.slice(0, POINTER_LINKS)) {
        // A gentle fall-off: even a line to a node 100px away stays clearly visible.
        const alpha = POINTER_LINE_ALPHA * Math.sqrt(1 - d / RADIUS) * presence * kAll * q[i]
        if (alpha <= 0.004) continue
        ctx.strokeStyle = mix(colors.lineHot, colors.hot, 0.5, alpha)
        ctx.beginPath()
        ctx.moveTo(at.x, at.y)
        ctx.lineTo(rx[i], ry[i])
        ctx.stroke()
        pointerLinks++
      }
    }

    // Nodes: brighter, larger and whiter near the pointer.
    for (let i = 0; i < n; i++) {
      const p = points[i]
      const g = glow[i]
      const alpha = (p.a + (1 - p.a) * g) * kAll * q[i]
      if (alpha <= 0.004) continue
      ctx.fillStyle = mix(colors.dot[p.tone], colors.hot, g, alpha)
      ctx.beginPath()
      ctx.arc(rx[i], ry[i], p.r * (1 + 0.6 * g), 0, Math.PI * 2) // 2.5–4px when highlighted
      ctx.fill()
    }
    info = { links: links.length, pointerLinks, presence, glows: Array.from(glow) }
  }

  // The loop. 1. elapsed time, capped; 2–7. advance and draw; 8. next frame.
  const loop = (ts: number) => {
    frame = 0
    const dt = last ? Math.min((ts - last) / 1000, MAX_DT) : 0
    last = ts
    advance(dt)
    draw()
    if (animate) frame = requestAnimationFrame(loop)
  }
  const start = () => {
    if (frame || !animate || document.visibilityState === 'hidden') return
    last = 0 // the first frame after (re)starting moves nothing: no jump
    frame = requestAnimationFrame(loop)
  }
  const stop = () => {
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }

  // Without the loop (reduced motion), changes are drawn once, still.
  let stillFrame = 0
  const redrawStill = () => {
    if (animate || stillFrame) return
    stillFrame = requestAnimationFrame(() => {
      stillFrame = 0
      advance(0)
      draw()
    })
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    pointer = { x: e.clientX, y: e.clientY }
    lastPointer = pointer
  }
  const onLeave = (e: MouseEvent) => {
    if (!e.relatedTarget) pointer = null
  }
  const onVisibility = () => (document.visibilityState === 'hidden' ? stop() : start())

  const setInteractive = (on: boolean) => {
    if (on === interactive) return
    interactive = on
    if (on) {
      window.addEventListener('pointermove', onMove, { passive: true })
      document.addEventListener('mouseout', onLeave)
    } else {
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('mouseout', onLeave)
      pointer = null
    }
  }
  // Reduced motion: still, no interaction. Touch or no hover: drift only.
  const applyMedia = () => {
    animate = !reducedMotion()
    setInteractive(constellationInteractive())
    if (animate) start()
    else {
      stop()
      ox.fill(0)
      oy.fill(0)
      glow.fill(0)
      presence = 0
      advance(0)
      draw()
    }
  }
  const fine = media('(hover: hover) and (pointer: fine)')
  const reduced = media('(prefers-reduced-motion: reduce)')

  // A resize resizes the canvas (keeping the nodes); scrolling and page
  // content changing size move the quiet zones.
  let resizeFrame = 0
  // Setting a canvas's size clears it, even to the same size (and the
  // observer reports the initial size too): skip it when nothing changed,
  // and redraw at once when it did, so no blank frame is ever shown.
  const sizeChanged = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
    const w = canvas.clientWidth || window.innerWidth
    const h = canvas.clientHeight || window.innerHeight
    return w !== width || h !== height || canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)
  }
  const onResize = () => {
    if (resizeFrame) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      if (!sizeChanged()) return
      resize()
      advance(0)
      draw()
    })
  }
  const onLayoutChange = () => {
    quietDirty = true
    redrawStill()
  }
  const sizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null
  sizeObserver?.observe(canvas)
  const contentObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onLayoutChange) : null
  contentObserver?.observe(document.body)
  window.addEventListener('resize', onResize)
  window.addEventListener('scroll', onLayoutChange, { passive: true, capture: true })
  // Theme switches change the colors.
  const themeObserver = new MutationObserver(() => {
    readColors()
    redrawStill()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  readColors()
  resize()
  advance(0)
  draw()
  applyMedia()
  fine?.addEventListener('change', applyMedia)
  reduced?.addEventListener('change', applyMedia)
  document.addEventListener('visibilitychange', onVisibility)

  return {
    nodes: () => points.map((p, i) => ({ x: px[i], y: py[i], vx: p.vx, vy: p.vy })),
    frameInfo: () => info,
    destroy: () => {
      animate = false
      stop()
      setInteractive(false)
      fine?.removeEventListener('change', applyMedia)
      reduced?.removeEventListener('change', applyMedia)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onLayoutChange, { capture: true })
      sizeObserver?.disconnect()
      contentObserver?.disconnect()
      themeObserver.disconnect()
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      if (stillFrame) cancelAnimationFrame(stillFrame)
      resizeFrame = 0
      stillFrame = 0
    },
  }
}

/**
 * The constellation background, as a click-through canvas behind the page.
 * Used on sign-in/registration, the overview and the editor (dimmed behind
 * the elements matched by `quiet`). Without canvas support the shared
 * background is all that shows.
 */
export function ConstellationBackground({ intensity = 1, quiet, quietFloor }: ConstellationOptions) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = el.getContext('2d')
    } catch {
      ctx = null
    }
    if (!ctx) return // no canvas: the plain dark background stays
    const c = createConstellation(el, ctx, { intensity, quiet, quietFloor })
    return c.destroy
  }, [intensity, quiet, quietFloor])
  return <canvas ref={canvas} className="constellation" aria-hidden="true" />
}
