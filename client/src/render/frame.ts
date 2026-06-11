// Per-frame render context + shared color/canvas helpers.
//
// drawFrame (draw.ts) builds one FrameCtx per frame — projection, live music
// signals, and the small closure helpers — and each render pass destructures
// what it needs. Passes live in ./passes/* and run in a fixed order; module-
// level caches (atlases, starfield, lens buffers) live with their pass.

import { clamp } from '../game/math'
import type { RunState } from '../game/runState'
import type { ArenaLayout } from '../game/layout'
import type { Projection } from './projection'

export type DrawUi = { musicOn: boolean }

export type FrameCtx = {
  ctx: CanvasRenderingContext2D
  s: RunState
  ui: DrawUi
  layout: ArenaLayout
  proj: Projection
  project: Projection['project']
  scaleAt: Projection['scaleAt']
  music: RunState['music']
  mi: number
  mBass: number
  mPulse: number
  mEnergy: number
  mHue: number
  spectrum: number[]
  tNow: number
  dpr: number
  hsl: (h: number, sPct: number, lPct: number, a?: number) => string
  hueAt: (x: number, y: number) => number
  heat: (
    hueDeg: number,
    baseR: number,
    baseG: number,
    baseB: number,
    satPct: number,
    lightPct: number,
    alpha: number,
  ) => string
  roundedRectPath: (x: number, y: number, w: number, h: number, r: number) => void
}

// Piece extrusion height as a fraction of cell size. Shared by the GL piece pass
// and the screen-space FX (sparks) so on-piece effects sit on the 3D top face.
export const PIECE_EXTRUDE = 0.95

export const withDpr = (ctx: CanvasRenderingContext2D, dpr: number, fn: () => void) => {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fn()
  ctx.restore()
}

export const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '').trim()
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const hslToRgb = (h: number, sPct: number, lPct: number) => {
  const hh = (((h % 360) + 360) % 360) / 360
  const s = clamp(sPct / 100, 0, 1)
  const l = clamp(lPct / 100, 0, 1)
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(hue2rgb(hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(hh) * 255),
    b: Math.round(hue2rgb(hh - 1 / 3) * 255),
  }
}

export const lerpColor = (a: string, b: string, t: number) => {
  const c0 = hexToRgb(a)
  const c1 = hexToRgb(b)
  const r = Math.round(lerp(c0.r, c1.r, t))
  const g = Math.round(lerp(c0.g, c1.g, t))
  const b2 = Math.round(lerp(c0.b, c1.b, t))
  return `rgb(${r} ${g} ${b2})`
}

// Health gradient: high HP is cooler/lighter; low HP is warmer/more urgent.
// This fits the existing purple/pink scheme while remaining readable.
export const healthFill = (hpPct: number) => {
  const t = clamp(hpPct, 0, 1)
  // "Singularity" health ramp: cold solid matter at full HP, heating to danger
  // as it dies (cold cyan -> teal -> energy amber -> danger red). Full health
  // is the dormant (music-off) matter identity color.
  const c0 = '#ff3b30' // low: danger red
  const c1 = '#ff9d3d' // mid-low: energy amber ("getting hurt")
  const c2 = '#7fc2de' // mid-high: cooling teal
  const c3 = '#bfe6f2' // high: cold mineral (matterFull)
  if (t < 0.33) return lerpColor(c0, c1, t / 0.33)
  if (t < 0.66) return lerpColor(c1, c2, (t - 0.33) / 0.33)
  return lerpColor(c2, c3, (t - 0.66) / 0.34)
}

export const relativeLuma = (cssRgb: string) => {
  // cssRgb is "rgb(r g b)" from lerpColor; parse quickly.
  const m = cssRgb.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
  if (!m) return 1
  const r = Number(m[1]) / 255
  const g = Number(m[2]) / 255
  const b = Number(m[3]) / 255
  // sRGB luminance approximation
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
