import { XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR } from '../game/runState'
import type { RunState } from '../game/runState'
import type { Vec2 } from '../game/math'
import { clamp } from '../game/math'
import { getArenaLayout } from '../game/layout'
import { makeProjection } from './projection'
import { renderLens } from './lensGL'
// (getRarityColor will be used by the level-up menu overlay; keep renderer lean for now.)

// Depth-grid descent-pulse state (purely visual; module-local so the renderer
// stays stateless per-frame otherwise). A pulse is a single bright horizontal
// line that races down the grid each time the board steps down a row.
let gridSweepStart = -1
let gridLastDepth = -1

// Reusable offscreen buffers for the black-hole gravitational-lens effect. We
// snapshot the already-drawn background around the hole into `lensSnap` once per
// frame and sample from it while warping (so the lens never feeds back on
// itself), and we draw the warped rings into `lensOut` at a SUPERSAMPLED
// resolution, then downscale it onto the scene — this anti-aliases the hard
// circular clip edges and the per-ring scale seams that otherwise look jagged.
let lensSnap: HTMLCanvasElement | null = null
let lensSnapCtx: CanvasRenderingContext2D | null = null
let lensOut: HTMLCanvasElement | null = null
let lensOutCtx: CanvasRenderingContext2D | null = null
const getLensBuf = (wDev: number, hDev: number) => {
  if (!lensSnap) {
    lensSnap = document.createElement('canvas')
    lensSnapCtx = lensSnap.getContext('2d')
  }
  // Size the buffer to EXACTLY the box. The GPU warp uploads the whole buffer
  // as a texture (flipped about the full buffer height); if the buffer were
  // larger than the box, the flipped texture coords would sample the wrong rows
  // and the lens would appear offset/clipped near the screen edges where the box
  // is clamped. An exact fit keeps texScale == 1 so sampling is always aligned.
  if (lensSnap.width !== wDev) lensSnap.width = wDev
  if (lensSnap.height !== hDev) lensSnap.height = hDev
  return { buf: lensSnap, bctx: lensSnapCtx }
}
const getLensOut = (wDev: number, hDev: number) => {
  if (!lensOut) {
    lensOut = document.createElement('canvas')
    lensOutCtx = lensOut.getContext('2d')
  }
  if (lensOut.width < wDev || lensOut.height < hDev) {
    lensOut.width = Math.max(lensOut.width, wDev)
    lensOut.height = Math.max(lensOut.height, hDev)
  }
  return { out: lensOut, octx: lensOutCtx }
}

const withDpr = (ctx: CanvasRenderingContext2D, dpr: number, fn: () => void) => {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fn()
  ctx.restore()
}

const drawRoundedPolyomino = (ctx: CanvasRenderingContext2D, loop: Vec2[], pos: Vec2, cellSize: number, rPx: number) => {
  if (loop.length < 3) return

  // Convert loop points to world px.
  const pts: Vec2[] = loop.map((p) => ({
    x: pos.x + p.x * cellSize,
    y: pos.y + p.y * cellSize,
  }))

  // Ensure closed.
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  if (first.x !== last.x || first.y !== last.y) pts.push({ ...first })

  const n = pts.length
  const m = Math.max(0, n - 1) // unique vertices
  const r = clamp(rPx, 0, cellSize * 0.5 - 0.6)

  const dir = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  }

  const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x

  const isConvex = (i: number) => {
    if (m < 3) return false
    const prev = pts[((i - 1 + m) % m)]!
    const cur = pts[i % m]!
    const next = pts[((i + 1) % m)]!
    const inD = dir(prev, cur)
    const outD = dir(cur, next)
    return cross(inD, outD) > 0.5
  }

  ctx.beginPath()

  // Start at first point, possibly offset if convex.
  const p0 = pts[0]!
  const p1 = pts[1]!
  const d01 = dir(p0, p1)
  const startCut = isConvex(0) ? r : 0
  const start = { x: p0.x + d01.x * startCut, y: p0.y + d01.y * startCut }
  ctx.moveTo(start.x, start.y)

  for (let i = 0; i < m; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const d = dir(a, b)
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const cutB = isConvex(i + 1) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const b2 = { x: b.x - d.x * cutB, y: b.y - d.y * cutB }
    ctx.lineTo(b2.x, b2.y)

    // Arc at vertex b if convex.
    if (isConvex(i + 1)) {
      const inD = d
      const outD = dir(b, pts[((i + 2) % m)]!)
      const center = {
        x: b.x - inD.x * r + outD.x * r,
        y: b.y - inD.y * r + outD.y * r,
      }
      const startAng = Math.atan2((b.y - inD.y * r) - center.y, (b.x - inD.x * r) - center.x)
      const endAng = Math.atan2((b.y + outD.y * r) - center.y, (b.x + outD.x * r) - center.x)
      ctx.arc(center.x, center.y, r, startAng, endAng, false)
    }
  }

  ctx.closePath()
}

const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '').trim()
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const hslToRgb = (h: number, sPct: number, lPct: number) => {
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

const lerpColor = (a: string, b: string, t: number) => {
  const c0 = hexToRgb(a)
  const c1 = hexToRgb(b)
  const r = Math.round(lerp(c0.r, c1.r, t))
  const g = Math.round(lerp(c0.g, c1.g, t))
  const b2 = Math.round(lerp(c0.b, c1.b, t))
  return `rgb(${r} ${g} ${b2})`
}

// Health gradient: high HP is cooler/lighter; low HP is warmer/more urgent.
// This fits the existing purple/pink scheme while remaining readable.
const healthFill = (hpPct: number) => {
  const t = clamp(hpPct, 0, 1)
  // Stops (low -> high):
  const c0 = '#ff3b5c' // low: hot red
  const c1 = '#ff6bd6' // mid-low: neon pink
  const c2 = '#c7a2ff' // mid-high: lilac
  const c3 = '#e7ddff' // high: icy lavender
  if (t < 0.33) return lerpColor(c0, c1, t / 0.33)
  if (t < 0.66) return lerpColor(c1, c2, (t - 0.33) / 0.33)
  return lerpColor(c2, c3, (t - 0.66) / 0.34)
}

const relativeLuma = (cssRgb: string) => {
  // cssRgb is "rgb(r g b)" from lerpColor; parse quickly.
  const m = cssRgb.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
  if (!m) return 1
  const r = Number(m[1]) / 255
  const g = Number(m[2]) / 255
  const b = Number(m[3]) / 255
  // sRGB luminance approximation
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const pickHpAnchor = (s: RunState, b: RunState['blocks'][number]) => {
  // The number rides its natural on-piece anchor the whole way down (the old
  // "slide up so it stays under the top edge" behavior is unnecessary now that
  // the perspective shaft shows pieces flying in from far above).
  const visualY = b.pos.y - s.dropAnimOffset - b.dropAnimExtra
  return { x: b.pos.x + b.hpAnchorLocalPx.x, y: visualY + b.hpAnchorLocalPx.y }
}

export const drawFrame = (canvas: HTMLCanvasElement, s: RunState) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = s.view.dpr
  withDpr(ctx, dpr, () => {
    ctx.clearRect(0, 0, s.view.width, s.view.height)
    const layout = getArenaLayout(s.view)

    // Perspective projection for the whole scene. World (sim) coordinates are
    // flat; everything visual is mapped through this so the board recedes toward
    // a high horizon. Built once per frame.
    const proj = makeProjection(s.view, layout)
    const project = proj.project
    const scaleAt = proj.scaleAt

    // Live music signals (0..1), pre-scaled by the user's reactivity intensity.
    // When nothing is playing, `mi` collapses to 0 so the game looks exactly
    // like its non-reactive baseline.
    const music = s.music
    const playing = music.playing
    const mi = playing ? music.intensity : 0
    const mBass = music.bass * mi
    const mPulse = music.pulse * mi
    const mEnergy = music.energy * mi
    // Continuous rainbow hue (0..360); frozen by the engine when not playing.
    const mHue = music.hue
    const spectrum = music.spectrum
    // Wall clock (seconds) so the background keeps gliding even while the sim is
    // paused; gameplay uses s.timeSec elsewhere. Motion in the background is
    // gated by `mi` so it still settles when music is off.
    const tNow =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
    const hsl = (h: number, sPct: number, lPct: number, a = 1) =>
      `hsla(${(((h % 360) + 360) % 360).toFixed(1)},${sPct.toFixed(1)}%,${lPct.toFixed(1)}%,${a})`
    // Per-element rainbow hue keyed off screen position (same spread the blocks
    // use), so heat FX on a piece match that piece's color.
    const hueAt = (x: number, y: number) => mHue + y * 0.16 + x * 0.1
    // Blend a baked "heat" color (white-hot orange/red) toward the live rainbow
    // hue by the music mix. When music is off it returns the original color, so
    // the molten/weld look is unchanged in the non-reactive baseline.
    const heat = (
      hueDeg: number,
      baseR: number,
      baseG: number,
      baseB: number,
      satPct: number,
      lightPct: number,
      alpha: number,
    ) => {
      if (mi <= 0) return `rgba(${baseR},${baseG},${baseB},${alpha})`
      const hc = hslToRgb(hueDeg, satPct, lightPct)
      const r = Math.round(lerp(baseR, hc.r, mi))
      const g = Math.round(lerp(baseG, hc.g, mi))
      const b = Math.round(lerp(baseB, hc.b, mi))
      return `rgba(${r},${g},${b},${alpha})`
    }
    const roundedRectPath = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + w, y, x + w, y + h, rr)
      ctx.arcTo(x + w, y + h, x, y + h, rr)
      ctx.arcTo(x, y + h, x, y, rr)
      ctx.arcTo(x, y, x + w, y, rr)
      ctx.closePath()
    }
    const applyDomedDepth = (ax: number, ay: number, w: number, h: number, strength: number) => {
      // “Pressed pill” look: depth comes from lighting/shadow *on the face* only.
      // No drop shadow, no thick rim strokes—just clipped gradients.
      const s01 = clamp(strength, 0, 1)
      const r = Math.max(w, h) * 0.95

      ctx.save()
      ctx.clip()

      // Broad highlight (top-left)
      ctx.globalCompositeOperation = 'screen'
      const hi = ctx.createRadialGradient(ax + w * 0.28, ay + h * 0.22, 0, ax + w * 0.28, ay + h * 0.22, r)
      hi.addColorStop(0, `rgba(255,255,255,${0.34 * s01})`)
      hi.addColorStop(0.35, `rgba(255,255,255,${0.14 * s01})`)
      hi.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = hi
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      // Soft shadow falloff (bottom-right)
      ctx.globalCompositeOperation = 'multiply'
      const sh = ctx.createRadialGradient(ax + w * 0.80, ay + h * 0.86, 0, ax + w * 0.80, ay + h * 0.86, r)
      sh.addColorStop(0, `rgba(0,0,0,${0.30 * s01})`)
      sh.addColorStop(0.55, `rgba(0,0,0,${0.10 * s01})`)
      sh.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sh
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      // Edge vignette (darken near edges slightly to sell curvature without a “stroke”)
      ctx.globalCompositeOperation = 'multiply'
      const cx = ax + w * 0.5
      const cy = ay + h * 0.5
      const edge = ctx.createRadialGradient(cx, cy, Math.max(4, r * 0.22), cx, cy, r * 0.98)
      edge.addColorStop(0, 'rgba(0,0,0,0)')
      edge.addColorStop(0.72, 'rgba(0,0,0,0)')
      edge.addColorStop(1, `rgba(0,0,0,${0.16 * s01})`)
      ctx.fillStyle = edge
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      // Small specular “pill shine” streak (very subtle, keeps it tactile)
      ctx.globalCompositeOperation = 'screen'
      const sx = ax + w * 0.30
      const sy = ay + h * 0.26
      const sw = w * 0.55
      const shh = Math.max(10, h * 0.18)
      const sheen = ctx.createLinearGradient(sx, sy, sx + sw, sy + shh)
      sheen.addColorStop(0, 'rgba(255,255,255,0)')
      sheen.addColorStop(0.35, `rgba(255,255,255,${0.11 * s01})`)
      sheen.addColorStop(0.7, 'rgba(255,255,255,0)')
      ctx.fillStyle = sheen
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      ctx.restore()
    }

    // ======================================================================
    // BACKGROUND — "Event-Horizon Descent". Opaque so the whole look lives on
    // the canvas (and the GL lens samples a real backdrop, not the CSS page).
    // A deliberate deep-space gradient + a corner vignette that frames the
    // shaft, plus a glowing horizon aperture where the pieces are born.
    // ======================================================================
    {
      const W = s.view.width
      const H = s.view.height

      // Framing gradient: deep indigo void, a touch warmer toward the bottom.
      const base = ctx.createLinearGradient(0, 0, 0, H)
      base.addColorStop(0, '#0a0820')
      base.addColorStop(0.55, '#0b0a1f')
      base.addColorStop(1, '#0d0b22')
      ctx.fillStyle = base
      ctx.fillRect(0, 0, W, H)

      // Corner vignette: darken the edges so the playfield reads as a pool of
      // light. Deliberate (not a faint shimmer) — pure framing, no animation.
      const vig = ctx.createRadialGradient(W * 0.5, H * 0.52, H * 0.18, W * 0.5, H * 0.52, Math.max(W, H) * 0.82)
      vig.addColorStop(0, 'rgba(0,0,0,0)')
      vig.addColorStop(0.6, 'rgba(0,0,0,0)')
      vig.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Horizon aperture: a soft bloom at the on-screen convergence (top of
      //    the shaft), the source the pieces emerge from. Pulses with the bass.
      {
        const wTop = proj.unproject(W * 0.5, 0).y
        const lx = project(0, wTop).x
        const rx = project(W, wTop).x
        const apX = (lx + rx) * 0.5
        const apY = 2
        const apR = Math.max(60, (rx - lx) * 1.05)
        const apHue = mi > 0 ? mHue : 256
        const pulse = 0.32 + 0.5 * mBass + 0.12 * Math.sin(tNow * 0.8)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const halo = ctx.createRadialGradient(apX, apY, 0, apX, apY, apR)
        halo.addColorStop(0, hsl(apHue, 80, 70, clamp(0.38 * pulse + 0.12, 0, 0.85)))
        halo.addColorStop(0.4, hsl(apHue + 14, 78, 56, clamp(0.18 * pulse, 0, 0.5)))
        halo.addColorStop(1, hsl(apHue + 20, 70, 40, 0))
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(apX, apY, apR, 0, Math.PI * 2)
        ctx.fill()
        // Bright inner seed.
        const seed = ctx.createRadialGradient(apX, apY, 0, apX, apY, apR * 0.32)
        seed.addColorStop(0, hsl(apHue, 90, 92, clamp(0.4 * pulse + 0.16, 0, 0.9)))
        seed.addColorStop(1, hsl(apHue, 85, 70, 0))
        ctx.fillStyle = seed
        ctx.beginPath()
        ctx.arc(apX, apY, apR * 0.32, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }

    // Synthwave depth grid — the shaft you descend. Thin neon lines receding to
    // a vanishing point near the top; horizontals scroll DOWNWARD to sell the
    // descent. Always present (faint, on-brand purple) and comes alive with the
    // music: rainbow hue, brighter/faster with energy, per-line spectrum glow.
    // No full-screen flashes; the only beat event is a single sweeping line.
    {
      const W = s.view.width
      // The grid is the world ground plane drawn through the SAME projection as
      // the pieces, so they are guaranteed co-perspective. Rows are spaced in
      // world px up the shaft from the near plane (emitter) toward the horizon.
      // One grid row == one piece cell so rungs line up with where pieces rest,
      // and the rungs move with the EXACT same stepped motion as the board (see
      // the gridShift below) — the pieces look bolted to the grid.
      const GRID_ROW = 40 // must match the sim's cellSize
      const ROWS = 48
      const farWorldY = proj.nearWorldY - ROWS * GRID_ROW
      const totalDepth = ROWS * GRID_ROW

      // Base look settles to on-brand purple when music is off (mi == 0); when
      // playing it leans into the live rainbow hue.
      const baseHue = 278 + (mHue - 278) * mi
      const baseAlpha = 0.11 + mEnergy * 0.07

      // Distinct "floor" beneath the grid: fill the projected ground-plane quad
      // so the shaft reads as its own surface, separate from the page background.
      // A vertical gradient sits darkest at the horizon and warms toward the
      // player; it leans into the music hue but stays subdued so lines pop.
      {
        const nl = project(0, proj.nearWorldY)
        const nr = project(W, proj.nearWorldY)
        const fl = project(0, farWorldY)
        const fr = project(W, farWorldY)
        const floor = ctx.createLinearGradient(0, fl.y, 0, nl.y)
        const floorHue = 250 + (mHue - 250) * mi
        floor.addColorStop(0, hsl(floorHue + 8, 55, 6, 0.0)) // fade out at horizon
        floor.addColorStop(0.18, hsl(floorHue + 8, 58, 8, 0.55))
        floor.addColorStop(1, hsl(floorHue, 62, 13, 0.8)) // near the player
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(fl.x, fl.y)
        ctx.lineTo(fr.x, fr.y)
        ctx.lineTo(nr.x, nr.y)
        ctx.lineTo(nl.x, nl.y)
        ctx.closePath()
        ctx.fillStyle = floor
        ctx.fill()
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'

      // Converging vertical rails (static — they define the shaft). Each rail is
      // a constant-world-X line from the near plane to the far plane; projection
      // makes them converge toward the vanishing point.
      const COLS = 9
      for (let c = 0; c <= COLS; c++) {
        const xW = (c / COLS) * W
        const a = project(xW, proj.nearWorldY)
        const b = project(xW, farWorldY)
        ctx.strokeStyle = hsl(baseHue + (c / COLS - 0.5) * 36 * mi, 80, 62, baseAlpha * 1.25)
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Horizontal rungs locked to the board's descent. gridShift is the exact
      // world distance the board has visually travelled downward this frame:
      // depth*cell counts completed steps, minus the in-progress catch-up
      // (dropAnimOffset). Modulo one row gives the repeating scroll, so the rungs
      // step and ease-in identically to the pieces instead of free-scrolling.
      const gridShift = (((s.depth * GRID_ROW - s.dropAnimOffset) % GRID_ROW) + GRID_ROW) % GRID_ROW
      for (let i = 0; i <= ROWS; i++) {
        const worldY = proj.nearWorldY - i * GRID_ROW + gridShift
        if (worldY > proj.nearWorldY) continue
        const a = project(0, worldY)
        if (a.scale < 0.04) continue
        const b = project(W, worldY)
        const depthFrac = clamp((proj.nearWorldY - worldY) / totalDepth, 0, 1) // 0 near .. 1 far
        // Per-row spectrum glow: nearer rows read more bass, far rows treble.
        const bin = Math.min(spectrum.length - 1, Math.floor(depthFrac * spectrum.length))
        const band = (spectrum[bin] ?? 0) * mi
        const near = a.scale // ~1 near .. small far
        const alpha = clamp(baseAlpha + near * (0.06 + 0.18 * band), 0, 0.5)
        const lwidth = 0.8 + near * 1.4 + band * 1.6
        ctx.strokeStyle = hsl(baseHue + depthFrac * 40 * mi, 82, 58 + band * 14, alpha)
        ctx.lineWidth = lwidth
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Shaft walls — the bounce surfaces. The two boundaries (world x=0 and
      // x=W) become bright, lit edge rails with light nodes that scroll on the
      // descent, so the beam visibly ricochets off solid structure instead of
      // an invisible edge. Still inside the 'lighter' pass for an additive glow.
      {
        const wallHue = 258 + (mHue - 258) * mi
        for (const xW of [0, W]) {
          const a = project(xW, proj.nearWorldY)
          const b = project(xW, farWorldY)
          ctx.shadowColor = hsl(wallHue, 82, 60, 0.7)
          ctx.shadowBlur = 12
          ctx.strokeStyle = hsl(wallHue, 72, 60, 0.5)
          ctx.lineWidth = 2.4
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          // Light nodes at each row, brighter near the player; they scroll with
          // gridShift so the wall reads as moving with the board.
          for (let i = 0; i <= ROWS; i++) {
            const worldY = proj.nearWorldY - i * GRID_ROW + gridShift
            if (worldY > proj.nearWorldY) continue
            const p = project(xW, worldY)
            if (p.scale < 0.05) continue
            ctx.fillStyle = hsl(wallHue + 8, 85, 72, clamp(0.12 + p.scale * 0.5, 0, 0.7))
            ctx.beginPath()
            ctx.arc(p.x, p.y, 0.8 + p.scale * 2.2, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        // Bounce blooms: laser vertices that landed on a wall flare the surface.
        const wallTol = 2.2
        const bh = mi > 0 ? mHue : wallHue
        for (const seg of s.laser.segments) {
          for (const v of [seg.a, seg.b]) {
            if (v.x <= wallTol || v.x >= W - wallTol) {
              const p = project(v.x, v.y)
              const br = 6 + 11 * p.scale
              const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, br)
              g.addColorStop(0, hsl(bh, 95, 82, 0.5))
              g.addColorStop(1, hsl(bh, 90, 60, 0))
              ctx.fillStyle = g
              ctx.beginPath()
              ctx.arc(p.x, p.y, br, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }

      ctx.restore()

      // Descent pulse: one bright rung races down the shaft (far -> near) every
      // time the board steps down a row, so the descent is unmistakably legible.
      // Triggered off depth (the canonical step counter), so it fires with or
      // without music and stays in lockstep with the pieces.
      if (s.depth !== gridLastDepth) {
        gridLastDepth = s.depth
        gridSweepStart = tNow
      }
      if (gridSweepStart >= 0) {
        const sweepDur = 0.55
        const sp = (tNow - gridSweepStart) / sweepDur
        if (sp >= 0 && sp < 1) {
          const surge = clamp(s.crescendo, 0, 1)
          // Accelerate toward the player so it reads as "falling" with the board.
          const ease = sp * sp
          const worldY = farWorldY + ease * (proj.nearWorldY - farWorldY)
          const a = project(0, worldY)
          const b = project(W, worldY)
          const fade = 1 - sp
          const hue = mi > 0 ? mHue + 12 : baseHue
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          ctx.shadowColor = hsl(hue, 95, 70, 0.9)
          ctx.shadowBlur = 14 * a.scale + 5
          ctx.strokeStyle = hsl(hue, 95, 75, clamp(0.42 + (0.5 + 0.4 * surge) * fade, 0, 0.98))
          ctx.lineWidth = (1.8 + 3.4 * a.scale) * (1 + 0.7 * surge)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.restore()
        } else if (sp >= 1) {
          gridSweepStart = -1
        }
      }
    }

    // Fail line: a charged danger threshold. A faint dashed baseline is always
    // present; an amber glow ignites and pulses as the nearest piece nears it.
    const failY = layout.failY
    {
      let danger = 0
      for (const b of s.blocks) {
        const by = b.pos.y - s.dropAnimOffset - b.dropAnimExtra + b.localAabb.maxY
        danger = Math.max(danger, 1 - clamp((failY - by) / 160, 0, 1))
      }
      const fa = project(0, failY)
      const fb = project(s.view.width, failY)
      const pulse = 0.6 + 0.4 * Math.sin(tNow * 4)
      const DH = 38 // amber
      ctx.save()
      ctx.lineCap = 'round'
      // Danger glow (additive), intensity + blur ride the proximity pulse.
      ctx.globalCompositeOperation = 'lighter'
      ctx.shadowColor = hsl(DH, 100, 55, 0.85)
      ctx.shadowBlur = 5 + 18 * danger * pulse
      ctx.strokeStyle = hsl(DH, 100, 62, clamp(0.16 + 0.6 * danger, 0, 0.95))
      ctx.lineWidth = 2 + 2.4 * danger
      ctx.beginPath()
      ctx.moveTo(fa.x, fa.y)
      ctx.lineTo(fb.x, fb.y)
      ctx.stroke()
      ctx.shadowBlur = 0
      // Dashed baseline so the boundary is legible even at zero danger.
      ctx.globalCompositeOperation = 'source-over'
      ctx.setLineDash([8, 10])
      ctx.strokeStyle = hsl(DH, 85, 70, 0.42)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(fa.x, fa.y)
      ctx.lineTo(fb.x, fb.y)
      ctx.stroke()
      ctx.setLineDash([])
      // End notches anchor the threshold to the walls.
      ctx.fillStyle = hsl(DH, 95, 66, clamp(0.4 + 0.5 * danger, 0, 1))
      for (const e of [fa, fb]) {
        ctx.beginPath()
        ctx.arc(e.x, e.y, 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // Blocks (base render; HP text is drawn at the very end so it stays above glow/laser).
    // Depth-sort far -> near so nearer (lower) pieces overlap farther ones.
    const sortedBlocks = [...s.blocks].sort((a, b) => a.pos.y - b.pos.y)
    for (const b of sortedBlocks) {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const glow = 0.35 + 0.65 * (1 - hpPct)

      // Apply smooth drop animation offset (plus the per-block extra so fast
      // double-steppers ease instead of snapping).
      const visualPos = { x: b.pos.x, y: b.pos.y - s.dropAnimOffset - b.dropAnimExtra }

      ctx.save()
      ctx.globalCompositeOperation = 'source-over'

      // Music: gentle, smooth breathing — envelope-driven (never beat-flashed),
      // with a slow per-piece phase so the board sways like a field, not a strobe.
      const bcx = visualPos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
      const bcy = visualPos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
      const sway = 0.5 + 0.5 * Math.sin(tNow * 2.1 - bcy * 0.01)
      const blockScale = 1 + mPulse * 0.05 * sway + mBass * 0.02
      // Perspective: place the piece at its projected center and scale it by its
      // depth (per-piece uniform scaling preserves all the polish below). The
      // music breathing folds into the same transform.
      {
        const pc = project(bcx, bcy)
        const totalScale = pc.scale * blockScale
        ctx.translate(pc.x, pc.y)
        ctx.scale(totalScale, totalScale)
        ctx.translate(-bcx, -bcy)
      }

      // Color: HP is encoded by SATURATION (low HP = vivid/urgent, full HP =
      // pale), which frees HUE for the continuous rainbow. When music is off
      // (mi == 0) it falls back to the original health gradient so the baseline
      // look is unchanged.
      const pieceHue = hueAt(bcx, bcy)
      let fillBase: string
      let lum: number
      if (b.isGold) {
        fillBase = '#ffd700'
        lum = relativeLuma(fillBase)
      } else if (mi > 0) {
        // Music on: hue is the rainbow, HP rides SATURATION (full health = vivid,
        // draining health = the color drains toward gray). No health-red blended
        // in, so a damaged piece desaturates instead of going red.
        const mc = hslToRgb(pieceHue, lerp(22, 96, hpPct), 62)
        fillBase = `rgb(${mc.r} ${mc.g} ${mc.b})`
        lum = (0.2126 * mc.r + 0.7152 * mc.g + 0.0722 * mc.b) / 255
      } else {
        fillBase = healthFill(hpPct)
        lum = relativeLuma(fillBase)
      }

      if (b.isGold) {
        // Gold blocks have a golden glow
        ctx.shadowColor = `rgba(255,215,0,${0.3 * glow})`
        ctx.shadowBlur = 22 * glow
      } else if (mi > 0) {
        // Rainbow rim that breathes with sustained energy (no beat flash).
        ctx.shadowColor = hsl(pieceHue, 90, 60, clamp(0.12 * glow + mPulse * 0.1, 0, 0.5))
        ctx.shadowBlur = 16 * glow + mEnergy * 12
      } else {
        ctx.shadowColor = `rgba(255,120,210,${0.14 * glow})`
        ctx.shadowBlur = 18 * glow
      }

      drawRoundedPolyomino(ctx, b.loop, visualPos, b.cellSize, b.cornerRadius)

      // Solid fill (health gradient is applied as a per-piece color, not as an internal gradient).
      ctx.fillStyle = fillBase
      ctx.fill()

      // Tactile depth: make blocks read as slightly domed/protruding.
      {
        const ax = visualPos.x + b.localAabb.minX
        const ay = visualPos.y + b.localAabb.minY
        const w = b.localAabb.maxX - b.localAabb.minX
        const h = b.localAabb.maxY - b.localAabb.minY
        // Strong but still “face-only” so it reads like a pressed, domed pill.
        applyDomedDepth(ax, ay, w, h, 1.0)
        
        // Add extra metallic shine for gold blocks
        if (b.isGold) {
          ctx.save()
          ctx.clip()
          ctx.globalCompositeOperation = 'screen'
          const shine = ctx.createLinearGradient(ax, ay, ax + w, ay + h * 0.5)
          shine.addColorStop(0, 'rgba(255,255,200,0.4)')
          shine.addColorStop(0.5, 'rgba(255,255,200,0.25)')
          shine.addColorStop(1, 'rgba(255,255,200,0)')
          ctx.fillStyle = shine
          ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
          ctx.restore()
        }
      }

      // Player-facing rim light + low-HP fracture (clipped to the piece shape).
      {
        const ax = visualPos.x + b.localAabb.minX
        const ay = visualPos.y + b.localAabb.minY
        const w = b.localAabb.maxX - b.localAabb.minX
        const h = b.localAabb.maxY - b.localAabb.minY

        // Rim light along the bottom (player-facing) edge: pieces catch the glow
        // rising up the shaft, giving them a lit, sculpted edge.
        ctx.save()
        ctx.clip()
        ctx.globalCompositeOperation = 'screen'
        const rim = ctx.createLinearGradient(0, ay + h * 0.58, 0, ay + h)
        rim.addColorStop(0, 'rgba(255,255,255,0)')
        rim.addColorStop(1, mi > 0 ? hsl(pieceHue, 85, 82, 0.24) : 'rgba(255,224,255,0.2)')
        ctx.fillStyle = rim
        ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
        ctx.restore()
      }

      ctx.lineWidth = 2
      if (b.isGold) {
        ctx.strokeStyle = 'rgba(184,134,11,0.85)'
      } else {
        ctx.strokeStyle = lum > 0.62 ? 'rgba(40,18,60,0.70)' : 'rgba(255,245,220,0.35)'
      }
      ctx.stroke()

      // Routing-kind overlays so the player can read fast / armored / chrome at a
      // glance (drawn over the standard body, inside the same perspective xform).
      if (!b.isGold && b.kind !== 'normal') {
        const ax = visualPos.x + b.localAabb.minX
        const ay = visualPos.y + b.localAabb.minY
        const w = b.localAabb.maxX - b.localAabb.minX
        const h = b.localAabb.maxY - b.localAabb.minY
        ctx.save()

        if (b.kind === 'armored') {
          // Dark riveted steel everywhere EXCEPT one weak face, which glows green
          // and carries an inward arrow — the only side that takes damage, so you
          // must route the beam to strike it from that direction.
          const vn = b.vulnNormal
          const pulse = 0.5 + 0.5 * Math.sin(tNow * 6)
          // 1 right after a wrong-side (shielded) hit, fading to 0 over
          // SHIELD_FLASH_SEC (0.3s). Drives the "deflected, no damage" cue.
          const flash = Math.min(1, b.shieldFlashSec / 0.3)

          drawRoundedPolyomino(ctx, b.loop, visualPos, b.cellSize, b.cornerRadius)
          ctx.save()
          ctx.clip()
          // Darker plating so the green weak face reads instantly against it.
          ctx.fillStyle = 'rgba(30,37,52,0.7)'
          ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
          // Icy clang wash over the whole plate while a shielded face is struck.
          if (flash > 0) {
            ctx.globalCompositeOperation = 'screen'
            ctx.fillStyle = `rgba(150,205,255,${(0.42 * flash).toFixed(3)})`
            ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
          }
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = 'rgba(150,166,194,0.12)'
          ctx.lineWidth = 2
          for (let x = -h; x < w + h; x += 12) {
            ctx.beginPath()
            ctx.moveTo(ax + x, ay)
            ctx.lineTo(ax + x + h, ay + h)
            ctx.stroke()
          }
          // Corner rivets reinforce the "bolted armor" read.
          ctx.globalCompositeOperation = 'source-over'
          ctx.fillStyle = 'rgba(190,202,224,0.5)'
          const rv = 2.2
          const ri = 6
          for (const [rx, ry] of [
            [ax + ri, ay + ri],
            [ax + w - ri, ay + ri],
            [ax + ri, ay + h - ri],
            [ax + w - ri, ay + h - ri],
          ] as const) {
            ctx.beginPath()
            ctx.arc(rx, ry, rv, 0, Math.PI * 2)
            ctx.fill()
          }
          ctx.restore()

          // Weak face: a thick pulsing green bar with a strong glow, hugging the
          // vulnerable edge.
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          // A wrong-side hit forces the weak face to full brightness + bloom so
          // the eye is pulled to where damage actually lands.
          const mark = Math.max(pulse, flash)
          ctx.strokeStyle = `rgba(120,255,170,${(0.7 + 0.3 * mark).toFixed(3)})`
          ctx.shadowColor = 'rgba(120,255,170,0.95)'
          ctx.shadowBlur = 8 + 8 * pulse + 18 * flash
          ctx.lineWidth = 6 + 6 * flash
          ctx.lineCap = 'round'
          const inset = 4
          const cxB = ax + w / 2
          const cyB = ay + h / 2
          ctx.beginPath()
          if (vn.x < 0) {
            ctx.moveTo(ax + inset, ay + inset)
            ctx.lineTo(ax + inset, ay + h - inset)
          } else if (vn.x > 0) {
            ctx.moveTo(ax + w - inset, ay + inset)
            ctx.lineTo(ax + w - inset, ay + h - inset)
          } else if (vn.y < 0) {
            ctx.moveTo(ax + inset, ay + inset)
            ctx.lineTo(ax + w - inset, ay + inset)
          } else {
            ctx.moveTo(ax + inset, ay + h - inset)
            ctx.lineTo(ax + w - inset, ay + h - inset)
          }
          ctx.stroke()

          // Inward chevron pointing into the weak face: "strike from here".
          const ar = Math.min(w, h) * 0.18 + 3
          ctx.lineWidth = 4 + 4 * flash
          ctx.lineJoin = 'round'
          ctx.beginPath()
          if (vn.x < 0) {
            const x0 = ax + inset + 3
            ctx.moveTo(x0, cyB - ar)
            ctx.lineTo(x0 + ar, cyB)
            ctx.lineTo(x0, cyB + ar)
          } else if (vn.x > 0) {
            const x0 = ax + w - inset - 3
            ctx.moveTo(x0, cyB - ar)
            ctx.lineTo(x0 - ar, cyB)
            ctx.lineTo(x0, cyB + ar)
          } else if (vn.y < 0) {
            const y0 = ay + inset + 3
            ctx.moveTo(cxB - ar, y0)
            ctx.lineTo(cxB, y0 + ar)
            ctx.lineTo(cxB + ar, y0)
          } else {
            const y0 = ay + h - inset - 3
            ctx.moveTo(cxB - ar, y0)
            ctx.lineTo(cxB, y0 - ar)
            ctx.lineTo(cxB + ar, y0)
          }
          ctx.stroke()
          ctx.shadowBlur = 0
          ctx.restore()
        } else if (b.kind === 'chrome') {
          // Mirror-chrome: silvery sheen so it reads as reflective.
          drawRoundedPolyomino(ctx, b.loop, visualPos, b.cellSize, b.cornerRadius)
          ctx.save()
          ctx.clip()
          const cg = ctx.createLinearGradient(ax, ay, ax + w, ay + h)
          cg.addColorStop(0, 'rgba(200,215,235,0.55)')
          cg.addColorStop(0.5, 'rgba(245,250,255,0.78)')
          cg.addColorStop(1, 'rgba(158,178,205,0.55)')
          ctx.fillStyle = cg
          ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = 'rgba(255,255,255,0.5)'
          ctx.lineWidth = 2
          for (let x = -h; x < w + h; x += 9) {
            ctx.beginPath()
            ctx.moveTo(ax + x, ay)
            ctx.lineTo(ax + x + h, ay + h)
            ctx.stroke()
          }
          ctx.restore()
        } else if (b.kind === 'fast') {
          // Cyan down-chevrons: reads as "falling fast".
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = 'rgba(120,240,255,0.95)'
          ctx.shadowColor = 'rgba(120,240,255,0.7)'
          ctx.shadowBlur = 8
          ctx.lineWidth = 3
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          const cxC = ax + w / 2
          const chW = Math.min(w, h) * 0.3
          for (let k = 0; k < 2; k++) {
            const yy = ay + h * (0.36 + k * 0.26)
            ctx.beginPath()
            ctx.moveTo(cxC - chW, yy - chW * 0.55)
            ctx.lineTo(cxC, yy + chW * 0.55)
            ctx.lineTo(cxC + chW, yy - chW * 0.55)
            ctx.stroke()
          }
          ctx.shadowBlur = 0
        }
        ctx.restore()
      }
      ctx.restore()
    }

    // Melt-on-death FX: the block turns red-hot and squishes (gravity) into the XP particle.
    if (s.meltFx.length > 0) {
      const smoothstep = (x: number) => {
        const t = clamp(x, 0, 1)
        return t * t * (3 - 2 * t)
      }
      const drawSmoothClosed = (pts: Vec2[]) => {
        if (pts.length < 3) return
        // If closed (last == first), drop the duplicate.
        const p0 = pts[0]!
        const pn = pts[pts.length - 1]!
        const arr =
          Math.abs(pn.x - p0.x) < 1e-6 && Math.abs(pn.y - p0.y) < 1e-6 ? pts.slice(0, -1) : pts
        const n = arr.length
        if (n < 3) return
        const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 })
        const m0 = mid(arr[0]!, arr[1]!)
        ctx.beginPath()
        ctx.moveTo(m0.x, m0.y)
        for (let i = 1; i < n; i++) {
          const a = arr[i]!
          const b = arr[(i + 1) % n]!
          const m = mid(a, b)
          ctx.quadraticCurveTo(a.x, a.y, m.x, m.y)
        }
        // close via first vertex
        const mEnd = mid(arr[0]!, arr[1]!)
        ctx.quadraticCurveTo(arr[0]!.x, arr[0]!.y, mEnd.x, mEnd.y)
        ctx.closePath()
      }
      for (const fx of s.meltFx) {
        const p = clamp(fx.t / Math.max(0.0001, fx.dur), 0, 1)

        const ax0 = fx.pos.x + fx.localAabb.minX
        const ay0 = fx.pos.y + fx.localAabb.minY
        const w0 = fx.localAabb.maxX - fx.localAabb.minX
        const h0 = fx.localAabb.maxY - fx.localAabb.minY
        const cx0 = ax0 + w0 * 0.5

        // Perspective: render the whole molten morph at its projected center,
        // scaled by depth, so a dying piece melts in-place on the receding board.
        const mp = project(cx0, ay0 + h0 * 0.5)
        ctx.save()
        ctx.translate(mp.x, mp.y)
        ctx.scale(mp.scale, mp.scale)
        ctx.translate(-cx0, -(ay0 + h0 * 0.5))

        // Molten body follows the live rainbow hue (reverts to dead-piece red
        // when music is off), so a dying block doesn't snap to red mid-melt.
        const meltHue = hueAt(cx0, ay0 + h0 * 0.5)
        const molten = heat(meltHue, 255, 59, 92, 90, 60, 1)

        // Single-shape morph (no fades, no separate puddle/orb draw):
        // - Early: gravity sag + pooling deformation (stronger near the bottom).
        // - Late: smoothly morph into a circle at orbFrom with the same radius as the XP orb.
        const phase1End = 0.78
        const a = smoothstep(p / phase1End) // pooling/sag amount
        const c = smoothstep((p - phase1End) / (1 - phase1End)) // circle morph amount

        const top0 = ay0
        const bottom0 = ay0 + h0
        const wob = Math.sin(fx.seed + fx.t * 7.5)

        const ptsWorld: Vec2[] = fx.loop.map((q) => ({
          x: fx.pos.x + q.x * fx.cellSize,
          y: fx.pos.y + q.y * fx.cellSize,
        }))
        const ptsWarp: Vec2[] = []
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity
        const R = 5 // must match XP orb fly radius

        // 1) Warp points with a gravity + pooling field.
        for (const pt of ptsWorld) {
          const v = clamp((pt.y - top0) / Math.max(1, h0), 0, 1) // 0 top -> 1 bottom
          const dy = bottom0 - pt.y
          const edge01 = clamp(Math.abs(pt.x - cx0) / Math.max(1, w0 * 0.5), 0, 1)

          // Compress upper mass downward (sag), much less at the bottom so it "piles up".
          const compress = 1 - a * 0.80 * Math.pow(1 - v, 1.7)
          let y1 = bottom0 - dy * compress
          // Downward drift: affects edges too so horizontal surfaces don't only divot in the middle.
          y1 += a * 0.07 * h0 * Math.pow(v, 2.2) * (0.65 + 0.35 * edge01)

          // Spread more near the bottom (puddle) + a bit of viscous lateral slop.
          // Additionally, cantilevered parts (high + far from center) should flow inward as they melt
          // instead of "dripping" straight down as thin strings.
          const spread = 1 + a * (0.55 * v * v) + a * 0.06 * wob * Math.pow(v, 2.8)

          // Inward reflow is strongest for points that are:
          // - higher up (1 - v)
          // - further from center (edge01)
          // This helps overhangs collapse back toward the body of the piece.
          const inward = a * 0.62 * Math.pow(1 - v, 1.55) * Math.pow(edge01, 1.35)
          const spreadAdj = Math.max(0.15, spread * (1 - inward))

          let x1 = cx0 + (pt.x - cx0) * spreadAdj
          x1 += a * 6.5 * wob * (1 - v) * 0.25

          ptsWarp.push({ x: x1, y: y1 })
        }

        // 2) Viscosity smoothing to combat “balloon animal” pinches (diffuses sharp necks).
        // This keeps thin connectors from collapsing into single vertices with long smooth curves.
        if (ptsWarp.length >= 6) {
          const iters = 2
          const k = 0.22
          for (let it = 0; it < iters; it++) {
            const next: Vec2[] = []
            for (let i = 0; i < ptsWarp.length; i++) {
              const prev = ptsWarp[(i - 1 + ptsWarp.length) % ptsWarp.length]!
              const cur = ptsWarp[i]!
              const nxt = ptsWarp[(i + 1) % ptsWarp.length]!
              next.push({
                x: cur.x + k * ((prev.x + nxt.x) * 0.5 - cur.x),
                y: cur.y + k * ((prev.y + nxt.y) * 0.5 - cur.y),
              })
            }
            for (let i = 0; i < ptsWarp.length; i++) ptsWarp[i] = next[i]!
          }

          // Extra mild “nub killer” near the end: remove tiny protrusions without changing the overall melt.
          // Only activates late to avoid over-smoothing the early recognizable silhouette.
          const nub = smoothstep((p - 0.68) / 0.32)
          if (nub > 0.001) {
            const n = ptsWarp.length
            const extraIters = nub > 0.85 ? 2 : 1
            const kk = 0.10 + 0.10 * nub
            const minEdge = Math.max(1.2, fx.cellSize * 0.06)
            for (let it = 0; it < extraIters; it++) {
              const next: Vec2[] = []
              for (let i = 0; i < n; i++) {
                const prev = ptsWarp[(i - 1 + n) % n]!
                const cur = ptsWarp[i]!
                const nxt = ptsWarp[(i + 1) % n]!
                const lp = Math.hypot(cur.x - prev.x, cur.y - prev.y)
                const ln = Math.hypot(nxt.x - cur.x, nxt.y - cur.y)
                // Only damp when we see very short edges (typical nub signature).
                const w = clamp((minEdge - Math.min(lp, ln)) / minEdge, 0, 1) * nub
                const kLocal = kk * (0.25 + 0.75 * w)
                next.push({
                  x: cur.x + kLocal * ((prev.x + nxt.x) * 0.5 - cur.x),
                  y: cur.y + kLocal * ((prev.y + nxt.y) * 0.5 - cur.y),
                })
              }
              for (let i = 0; i < n; i++) ptsWarp[i] = next[i]!
            }
          }
        }

        // 3) Late circle morph: preserve perimeter order using arclength parameterization.
        // Mapping by polar angle can reorder points and self-intersect (the “inside-out” artifact).
        //
        // Also apply a mild late-stage "surface tension" smoothing in *radius-vs-parameter* space.
        // This specifically combats small lobes/nubbins ("balloon animal" artifacts) that show up
        // near the end (e.g. the T-piece smile + corner blobs).
        //
        // Finally, enforce a consistent "ground plane" (bottom) reference to avoid any perceived
        // rotation: anchor the parameter start at the bottom-most point, and use a fixed downward
        // angle as the phase reference.
        const ptsM: Vec2[] = []
        if (ptsWarp.length >= 3) {
          // Center for radius smoothing: use centroid of the warped loop so the blob stays coherent.
          let cxx = 0
          let cyy = 0
          for (const q of ptsWarp) {
            cxx += q.x
            cyy += q.y
          }
          cxx /= ptsWarp.length
          cyy /= ptsWarp.length

          // Rotate the loop so index 0 is the bottom-most point (stable "ground" anchor).
          let i0 = 0
          let bestY = -Infinity
          let bestDx = Infinity
          for (let i = 0; i < ptsWarp.length; i++) {
            const q = ptsWarp[i]!
            const dx = Math.abs(q.x - cx0)
            if (q.y > bestY + 0.001 || (Math.abs(q.y - bestY) <= 0.001 && dx < bestDx)) {
              bestY = q.y
              bestDx = dx
              i0 = i
            }
          }
          const pts = ptsWarp.slice(i0).concat(ptsWarp.slice(0, i0))

          let total = 0
          const cum: number[] = [0]
          for (let i = 1; i < pts.length; i++) {
            const a0 = pts[i - 1]!
            const b0 = pts[i]!
            total += Math.hypot(b0.x - a0.x, b0.y - a0.y)
            cum.push(total)
          }
          // close
          total += Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y)
          const inv = 1 / Math.max(1e-6, total)

          // Angle parameterization is based on perimeter order (t), not geometric angle.
          // Use a fixed downward phase so the blob doesn't "rotate" as it melts.
          const baseAng = Math.PI / 2

          // Late-stage surface tension: smooth radius along the loop parameter.
          const tension = smoothstep((p - 0.62) / 0.28)
          const n = pts.length
          const angParam: number[] = new Array(n)
          for (let i = 0; i < n; i++) {
            const tt = (cum[i]! * inv) % 1
            angParam[i] = baseAng + tt * Math.PI * 2
          }
          const radii: number[] = new Array(n)
          for (let i = 0; i < n; i++) {
            const dx = pts[i]!.x - cxx
            const dy = pts[i]!.y - cyy
            radii[i] = Math.hypot(dx, dy)
          }
          if (tension > 0.001 && n >= 6) {
            const iters = tension > 0.82 ? 3 : 2
            const alpha = 0.35 * tension
            let r = radii
            for (let it = 0; it < iters; it++) {
              const next = new Array(n)
              for (let i = 0; i < n; i++) {
                const rm1 = r[(i - 1 + n) % n]!
                const r0 = r[i]!
                const rp1 = r[(i + 1) % n]!
                const avg = (rm1 + 2 * r0 + rp1) / 4
                // Stronger smoothing on the *upper* surfaces to remove lingering sag-divots.
                // With baseAng=pi/2, "top" is around ang=-pi/2 (sin is -1).
                const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
                // Increase smoothing as it progresses; reduce slightly once fully circle-morphing.
                const aLocal = alpha * (1 + 0.95 * top01) * (0.8 + 0.2 * (1 - c))
                next[i] = lerp(r0, avg, aLocal)
              }
              r = next
            }
            // Clamp high-frequency bumps AND divots.
            // Max clamp kills tiny lobes; min clamp fills in sharp concave dents that can persist as it shrinks.
            const capHi = Math.max(0.75, fx.cellSize * 0.08) * (1 - 0.35 * c)
            // Keep the allowed "divot depth" quite small on the upper surfaces; otherwise you get
            // those unnatural V-notches that become more pronounced as the blob shrinks.
            const capLoBase = Math.max(0.30, fx.cellSize * 0.04) * (1 - 0.35 * c)
            for (let i = 0; i < n; i++) {
              const rm1 = r[(i - 1 + n) % n]!
              const r0 = r[i]!
              const rp1 = r[(i + 1) % n]!
              const base = (rm1 + rp1) * 0.5
              const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
              const capLo = capLoBase * (1 + 1.55 * top01)
              if (r0 > base + capHi) r[i] = base + capHi
              if (r[i]! < base - capLo) r[i] = base - capLo
            }

            // Explicitly fill persistent V-divots on the upper arc by biasing radii upward
            // toward the neighbor baseline (surface tension "rounds out" dents).
            // This prevents top dents from sharpening as the blob shrinks.
            const fill = smoothstep((p - 0.50) / 0.40) * (1 - 0.15 * c)
            if (fill > 0.001) {
              const passIters = fill > 0.8 ? 2 : 1
              for (let it = 0; it < passIters; it++) {
                const next = r.slice()
                for (let i = 0; i < n; i++) {
                  const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
                  if (top01 < 0.55) continue
                  const rm1 = r[(i - 1 + n) % n]!
                  const r0 = r[i]!
                  const rp1 = r[(i + 1) % n]!
                  const base = (rm1 + rp1) * 0.5
                  // If we're below the baseline (a divot), push up strongly.
                  if (r0 < base) {
                    const k = fill * (0.45 + 0.55 * top01)
                    next[i] = lerp(r0, base, k)
                  }
                }
                r = next
              }
            }
            for (let i = 0; i < n; i++) radii[i] = r[i]!
          }

          for (let i = 0; i < pts.length; i++) {
            const ang = angParam[i]!
            // Use the smoothed radius to build a single-lobed blob, then morph to the final circle.
            const bx = cxx + Math.cos(ang) * radii[i]!
            const by = cyy + Math.sin(ang) * radii[i]!
            const tx = fx.orbFrom.x + Math.cos(ang) * R
            const ty = fx.orbFrom.y + Math.sin(ang) * R
            const x2 = lerp(bx, tx, c)
            const y2 = lerp(by, ty, c)
            ptsM.push({ x: x2, y: y2 })
            minX = Math.min(minX, x2)
            minY = Math.min(minY, y2)
            maxX = Math.max(maxX, x2)
            maxY = Math.max(maxY, y2)
          }
        }

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.shadowColor = heat(meltHue, 255, 80, 80, 85, 62, 0.14)
        ctx.shadowBlur = 12 * (1 - c)
        drawSmoothClosed(ptsM)
        ctx.fillStyle = molten
        ctx.fill()
        ctx.shadowBlur = 0

        // Face lighting + molten flow (clipped) for the whole morph.
        const bbW = Math.max(1, maxX - minX)
        const bbH = Math.max(1, maxY - minY)
        applyDomedDepth(minX, minY, bbW, bbH, 1.0)

        ctx.save()
        ctx.clip()
        ctx.globalCompositeOperation = 'screen'
        const tt = fx.t * 2.3 + fx.seed
        const bandH = Math.max(10, bbH * 0.28)
        for (let k = 0; k < 3; k++) {
          const yy = minY + ((tt * 34 + k * bandH * 1.25) % (bbH + bandH)) - bandH
          const band = ctx.createLinearGradient(minX, yy, minX, yy + bandH)
          band.addColorStop(0, 'rgba(255,255,255,0)')
          band.addColorStop(0.5, `rgba(255,255,255,${0.10 * (1 - c)})`)
          band.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = band
          ctx.fillRect(minX - 2, yy, bbW + 4, bandH)
        }
        ctx.restore()

        ctx.restore()
        ctx.restore() // melt perspective transform
      }
    }

    // Board features: mirrors (destructible diagonal deflectors) / prisms / black holes.
    if (s.features.length > 0) {
      for (const f of s.features) {
        // Apply smooth drop animation offset
        const visualPos = { x: f.pos.x, y: f.pos.y - s.dropAnimOffset }

        // Perspective: wrap the whole feature in a per-entity transform at its
        // projected center so all the world-space drawing below recedes with the
        // board. Skip only once it has shrunk to nothing far up the shaft.
        const fcx = visualPos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
        const fcy = visualPos.y + (f.localAabb.minY + f.localAabb.maxY) * 0.5
        const fp = project(fcx, fcy)
        if (fp.scale < 0.04) continue
        ctx.save()
        ctx.translate(fp.x, fp.y)
        ctx.scale(fp.scale, fp.scale)
        ctx.translate(-fcx, -fcy)

        if (f.kind === 'mirror') {
          const m = f
          const sz = m.sizePx
          // The reflective surface is the diagonal of the bounding square. '\\'
          // (orient 1) kicks a vertical beam left; '/' (orient -1) kicks it right.
          let x0: number
          let y0: number
          let x1: number
          let y1: number
          if (m.orient === 1) {
            x0 = visualPos.x
            y0 = visualPos.y
            x1 = visualPos.x + sz
            y1 = visualPos.y + sz
          } else {
            x0 = visualPos.x
            y0 = visualPos.y + sz
            x1 = visualPos.x + sz
            y1 = visualPos.y
          }
          const wear = clamp(1 - m.hp / Math.max(1, m.hpMax), 0, 1)

          ctx.save()
          ctx.globalCompositeOperation = 'source-over'
          ctx.lineCap = 'round'

          // Glowing chrome bar along the diagonal.
          ctx.shadowColor = 'rgba(170,215,255,0.55)'
          ctx.shadowBlur = 16
          const grad = ctx.createLinearGradient(x0, y0, x1, y1)
          grad.addColorStop(0, 'rgba(120,150,195,0.95)')
          grad.addColorStop(0.5, 'rgba(225,240,255,0.98)')
          grad.addColorStop(1, 'rgba(120,150,195,0.95)')
          ctx.strokeStyle = grad
          ctx.lineWidth = 12
          ctx.globalAlpha = 0.9 - 0.45 * wear
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()

          // Bright specular core.
          ctx.shadowBlur = 0
          ctx.globalAlpha = 0.95 - 0.5 * wear
          ctx.strokeStyle = 'rgba(255,255,255,0.92)'
          ctx.lineWidth = 3.2
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()

          // Wear cracks: dark perpendicular ticks that deepen as it nears burn-through.
          if (wear > 0.2) {
            ctx.globalAlpha = clamp(wear, 0, 1)
            ctx.strokeStyle = 'rgba(20,10,16,0.55)'
            ctx.lineWidth = 1.4
            const dxL = x1 - x0
            const dyL = y1 - y0
            const nLen = Math.hypot(dxL, dyL) || 1
            const px = -dyL / nLen
            const py = dxL / nLen
            const ticks = 3
            for (let i = 1; i <= ticks; i++) {
              const ff = i / (ticks + 1)
              const mx = x0 + dxL * ff
              const my = y0 + dyL * ff
              const tl = 5 * wear
              ctx.beginPath()
              ctx.moveTo(mx - px * tl, my - py * tl)
              ctx.lineTo(mx + px * tl, my + py * tl)
              ctx.stroke()
            }
          }

          ctx.restore()
          ctx.restore() // feature perspective transform
          continue
        }

        if (f.kind === 'prism') {
          const p = f
          const cx = visualPos.x + p.cellSize * 0.5
          const cy = visualPos.y + p.cellSize * 0.5
          const r = p.r

          // Prism visual: prioritize glyph legibility. Use a darker crystal body + a subtle dark
          // readability disc behind the glyph, then render the glyph with a dark outline + bright stroke.

          // Soft outer halo (keeps the "special" read without washing out the glyph).
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.fillStyle = 'rgba(80,180,255,0.08)'
          ctx.beginPath()
          ctx.arc(cx, cy, r * 2.0, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()

          ctx.save()
          ctx.globalCompositeOperation = 'source-over'

          // Dark crystal sphere (less bright-on-bright).
          const grd = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r)
          grd.addColorStop(0, 'rgba(235,250,255,0.55)')
          grd.addColorStop(0.35, 'rgba(70,140,190,0.45)')
          grd.addColorStop(1, 'rgba(10,25,40,0.55)')
          ctx.fillStyle = grd
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fill()

          // Rim
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.stroke()

          // Readability disc behind glyph.
          ctx.fillStyle = 'rgba(0,0,0,0.22)'
          ctx.beginPath()
          ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2)
          ctx.fill()

          // Exit-direction glyph: render relative to a fixed "forward" axis (up).
          const exitsDeg = (p as { exitsDeg?: number[] }).exitsDeg
          const exits: number[] = Array.isArray(exitsDeg) ? exitsDeg : [45, -45]
          const base = { x: 0, y: -1 }
          const toRad = (deg: number) => (deg * Math.PI) / 180
          const rot = (v: Vec2, rad: number): Vec2 => {
            const c = Math.cos(rad)
            const sn = Math.sin(rad)
            return { x: v.x * c - v.y * sn, y: v.x * sn + v.y * c }
          }
          const rayLen = r * 0.88
          const headLen = r * 0.20
          const headAng = Math.PI / 7 // ~25deg

          const drawGlyphPass = (strokeStyle: string, lineWidth: number) => {
            ctx.strokeStyle = strokeStyle
            ctx.lineWidth = lineWidth
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            for (const deg of exits) {
              const d = rot(base, toRad(deg))
              const ex = cx + d.x * rayLen
              const ey = cy + d.y * rayLen
              ctx.beginPath()
              ctx.moveTo(cx, cy)
              ctx.lineTo(ex, ey)

              // arrowhead
              const back = { x: -d.x, y: -d.y }
              const left = rot(back, headAng)
              const right = rot(back, -headAng)
              ctx.moveTo(ex, ey)
              ctx.lineTo(ex + left.x * headLen, ey + left.y * headLen)
              ctx.moveTo(ex, ey)
              ctx.lineTo(ex + right.x * headLen, ey + right.y * headLen)
              ctx.stroke()
            }
          }

          // Outline then bright stroke for legibility on any background.
          drawGlyphPass('rgba(0,0,0,0.55)', 6)
          drawGlyphPass('rgba(245,255,255,0.92)', 2.8)

          // Center dot to anchor the glyph.
          ctx.fillStyle = 'rgba(245,255,255,0.65)'
          ctx.beginPath()
          ctx.arc(cx, cy, Math.max(1.4, r * 0.11), 0, Math.PI * 2)
          ctx.fill()

          ctx.restore()
          ctx.restore() // feature perspective transform
          continue
        }

        // black hole
        const bh = f
        const cx = visualPos.x + bh.cellSize * 0.5
        const cy = visualPos.y + bh.cellSize * 0.5
        const rCore = bh.rCore
        const rInf = bh.rInfluence

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'

        // Subtle influence boundary (helps players read gravity radius).
        // Drawn behind the core effects and kept very faint.
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = 'rgba(255,190,120,0.08)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([6, 10])
        ctx.beginPath()
        ctx.arc(cx, cy, rInf, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
        // very soft outer haze ring
        const haze = ctx.createRadialGradient(cx, cy, rInf * 0.92, cx, cy, rInf)
        haze.addColorStop(0, 'rgba(255,190,120,0)')
        haze.addColorStop(1, 'rgba(255,120,210,0.05)')
        ctx.fillStyle = haze
        ctx.beginPath()
        ctx.arc(cx, cy, rInf, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        // Dark core
        ctx.fillStyle = 'rgba(5,3,10,0.95)'
        ctx.beginPath()
        ctx.arc(cx, cy, rCore, 0, Math.PI * 2)
        ctx.fill()

        // Accretion ring (neon edge)
        ctx.globalCompositeOperation = 'lighter'
        const ringR = rCore * 1.35
        const ring = ctx.createRadialGradient(cx, cy, rCore * 0.85, cx, cy, ringR)
        ring.addColorStop(0, 'rgba(0,0,0,0)')
        ring.addColorStop(0.55, 'rgba(255,120,210,0.08)')
        ring.addColorStop(0.78, 'rgba(255,190,120,0.18)')
        ring.addColorStop(1, 'rgba(255,120,210,0)')
        ctx.fillStyle = ring
        ctx.beginPath()
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
        ctx.fill()

        // Subtle lens sparkle
        ctx.strokeStyle = 'rgba(255,255,255,0.10)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(cx, cy, rCore * 0.85, 0, Math.PI * 2)
        ctx.stroke()

        ctx.restore()
        ctx.restore() // feature perspective transform
      }
    }

    // HUD module: bottom-right L-shape (single container + single outline).
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    // Heat meter: the vertical bar charges as you chain kills and, when full,
    // fires Overdrive (a beam surge); during the surge it drains back to empty.
    const heatFrac = clamp(s.heat, 0, 1)
    const overdriveOn = s.overdriveSec > 0
    const comboMult = s.combo > 0 ? 1 + 0.1 * (s.combo - 1) : 1
    // The corner dial ring now reflects the crescendo (big-play surge).
    const crescendoArc = clamp(s.crescendo, 0, 1)

    // Geometry: union shape = vertical bar (xp) + horizontal cap (stats), with a dial in the elbow.
    const barX = gx
    const barY = gy
    const barW = gw
    const barH = gh
    const cutRight = s.view.width
    const cutBottom = layout.failY
    const bottomY = barY + barH
    // Horizontal leg height: just enough for inline stats with padding.
    const capH = 36
    // Wider horizontal leg so DPS/♥ can sit further left with the same left padding.
    const capW = 184
    const capX = barX + barW - capW
    const capY = bottomY - capH
    const dialD = 38
    const dialR = dialD / 2
    const dialCX = barX + barW - dialR - 8
    const dialCY = bottomY - dialR - 8
    // Leave a little more breathing room above the dial intrusion.
    const dialTop = dialCY - dialR - 14

    const lPath = (outerR: number) => {
      const r = outerR
      const vx0 = barX
      // Extend beyond the right edge so rounding gets clipped into a flat edge.
      const vx1 = cutRight + r
      const vy0 = barY
      // Extend beyond the death line so rounding gets clipped into a flat edge.
      const vy1 = cutBottom + r
      const hx0 = capX
      const hy0 = capY
      // "Skin bulge" around the dial: round the inner corner using an arc around the dial center.
      const bulgeR = dialR + 9

      ctx.beginPath()
      ctx.moveTo(vx1 - r, vy0)
      ctx.arcTo(vx1, vy0, vx1, vy0 + r, r)
      ctx.lineTo(vx1, vy1 - r)
      ctx.arcTo(vx1, vy1, vx1 - r, vy1, r)
      ctx.lineTo(hx0 + r, vy1)
      ctx.arcTo(hx0, vy1, hx0, vy1 - r, r)
      ctx.lineTo(hx0, hy0 + r)
      ctx.arcTo(hx0, hy0, hx0 + r, hy0, r)
      // Inner elbow: replace sharp corner with a circular intrusion so the dial feels like it's
      // pushing out the skin of the HUD, while keeping consistent padding.
      const dy = hy0 - dialCY
      const dx = vx0 - dialCX
      const canBulge = bulgeR * bulgeR > dy * dy && bulgeR * bulgeR > dx * dx
      if (canBulge) {
        const xJoin = dialCX - Math.sqrt(Math.max(0, bulgeR * bulgeR - dy * dy))
        const yJoin = dialCY - Math.sqrt(Math.max(0, bulgeR * bulgeR - dx * dx))
        // Join from horizontal top edge to arc start.
        ctx.lineTo(xJoin, hy0)
        const a0 = Math.atan2(hy0 - dialCY, xJoin - dialCX)
        const a1 = Math.atan2(yJoin - dialCY, vx0 - dialCX)
        // Sweep through the upper-left quadrant around the dial.
        ctx.arc(dialCX, dialCY, bulgeR, a0, a1, true)
        ctx.lineTo(vx0, yJoin)
      } else {
        ctx.lineTo(vx0, hy0)
      }
      ctx.lineTo(vx0, vy0 + r)
      ctx.arcTo(vx0, vy0, vx0 + r, vy0, r)
      ctx.closePath()
    }

    // Single container fill + single outline (no overlapping boxes), clipped to:
    // - right edge of the screen
    // - bottom edge at the death line
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.beginPath()
    ctx.rect(0, 0, cutRight, cutBottom)
    ctx.clip()
    const outerR = 18
    const bg = ctx.createLinearGradient(0, barY, 0, bottomY)
    bg.addColorStop(0, 'rgba(12, 10, 28, 0.62)')
    bg.addColorStop(1, 'rgba(10, 8, 22, 0.48)')
    ctx.fillStyle = bg
    lPath(outerR)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1.5
    lPath(outerR)
    ctx.stroke()
    ctx.restore()

    // XP groove + fill (kept above the dial so nothing overlaps).
    {
      const gx2 = barX + 7
      // More top padding so the XP track doesn't feel jammed against the top of the container.
      const gy2 = barY + 18
      const gw2 = barW - 14
      const gh2 = Math.max(26, dialTop - gy2)
      const groove = ctx.createLinearGradient(0, gy2, 0, gy2 + gh2)
      groove.addColorStop(0, 'rgba(0,0,0,0.38)')
      groove.addColorStop(1, 'rgba(255,255,255,0.05)')
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = groove
      roundedRectPath(gx2, gy2, gw2, gh2, 10)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      roundedRectPath(gx2, gy2, gw2, gh2, 10)
      ctx.stroke()

      const fh = gh2 * heatFrac
      ctx.globalCompositeOperation = 'lighter'
      // Heat fill: a warm "charge" that brightens as it fills; in Overdrive it
      // flips to a pulsing white-gold.
      const odPulse = overdriveOn ? 0.7 + 0.3 * Math.sin(s.timeSec * 18) : 1
      const heatHue = overdriveOn ? 45 : 28
      const heatA = (overdriveOn ? 0.55 : 0.2 + 0.25 * heatFrac) * odPulse
      ctx.fillStyle = hsl(heatHue, 95, 58, heatA)
      roundedRectPath(gx2, gy2 + (gh2 - fh), gw2, fh, 10)
      ctx.fill()
      ctx.fillStyle = hsl(heatHue, 98, overdriveOn ? 90 : 62 + 16 * heatFrac, 0.82 * odPulse)
      roundedRectPath(gx2 + 1, gy2 + (gh2 - fh) + 1, gw2 - 2, Math.max(0, fh - 2), 9)
      ctx.fill()

      // Combo multiplier centered in the groove.
      ctx.globalCompositeOperation = 'source-over'
      const label = `×${comboMult.toFixed(1)}`
      ctx.font = "950 13px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const tx = barX + barW / 2
      const ty = gy2 + gh2 * 0.55
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      roundedRectPath(tx - tw / 2 - 8, ty - 10, tw + 16, 20, 10)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1
      roundedRectPath(tx - tw / 2 - 8, ty - 10, tw + 16, 20, 10)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,246,213,0.92)'
      ctx.fillText(label, tx, ty)
      ctx.restore()
    }

    // Corner dial: DEPTH (the primary "how deep" stat). The ring now lights with
    // the crescendo so big plays flare the HUD.
    {
      const cx = dialCX
      const cy = dialCY
      const rr = dialR
      const dialHue = mi > 0 ? mHue : 320
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      const disc = ctx.createRadialGradient(cx, cy, 1, cx, cy, rr)
      disc.addColorStop(0, 'rgba(0,0,0,0.12)')
      disc.addColorStop(1, 'rgba(0,0,0,0.28)')
      ctx.fillStyle = disc
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Crescendo ring (full sweep, brightness driven by the surge).
      if (crescendoArc > 0.02) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = hsl(dialHue, 95, 65, 0.25 + 0.6 * crescendoArc)
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(cx, cy, rr - 1.5, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "950 15px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,246,213,0.95)'
      ctx.fillText(`${s.depth}`, cx, cy + 0.5)
      ctx.restore()
    }

    // Score in the horizontal leg (left of the depth dial).
    {
      const insetL = capX + 10
      const insetR = dialCX - dialR - 10
      const tx = (insetL + insetR) / 2
      const ty = capY + capH / 2 + 0.5
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,246,213,0.96)'
      ctx.font = "900 15px 'Oxanium', system-ui, sans-serif"
      ctx.fillText(s.score.toLocaleString(), tx, ty)
      ctx.restore()
    }

    // Best score readout (only once a local best or live score exists).
    if (s.bestScoreLocal > 0 || s.score > 0) {
      const bestLive = Math.max(s.bestScoreLocal, s.score)
      const label = `BEST ${bestLive.toLocaleString()}`
      const x = barX - 10
      const y = capY - 14
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "950 14px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = 'rgba(255,246,213,0.92)'
      ctx.fillText(label, x, y)
      ctx.restore()
    }

    // XP orbs (condense -> fly).
    if (s.xpOrbs.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const orb of s.xpOrbs) {
        // The orb starts on the (projected) dying piece and flies to the XP
        // gauge, which is screen-space HUD. So project the start, then lerp in
        // screen space toward the unprojected gauge target, easing the depth
        // scale back to 1 as it arrives at the HUD.
        const fromS = project(orb.from.x, orb.from.y)
        const tt = Math.pow(clamp(orb.t / XP_ORB_FLY_DUR, 0, 1), 0.75)
        const px = orb.phase === 'condense' ? fromS.x : fromS.x + (orb.to.x - fromS.x) * tt
        const py = orb.phase === 'condense' ? fromS.y : fromS.y + (orb.to.y - fromS.y) * tt
        const z = orb.phase === 'condense' ? fromS.scale : lerp(fromS.scale, 1, tt)
        const r = (orb.phase === 'condense' ? 16 * (1 - clamp(orb.t / XP_ORB_CONDENSE_DUR, 0, 1)) + 4 : 5) * z
        // Dead-piece ember: follows the live hue (red when music off).
        const oHue = hueAt(orb.from.x, orb.from.y)
        ctx.fillStyle = heat(oHue, 255, 59, 92, 85, 60, 0.32)
        ctx.beginPath()
        ctx.arc(px, py, r * 2.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = heat(oHue, 255, 59, 92, 85, 62, 0.92)
        ctx.beginPath()
        ctx.arc(px, py, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // Welding hit FX: glow + sparks at beam contact points.
    if (s.weldGlows.length > 0 || s.sparks.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'

      // Glows (radial gradients)
      for (const g of s.weldGlows) {
        const b = s.blocks.find((bb) => bb.id === g.blockId)
        const t = clamp(g.age / Math.max(0.0001, g.life), 0, 1)
        const aBase = (1 - t) * (0.35 + 0.55 * g.intensity)
        const a = b ? aBase : aBase * 0.22

        // Perspective: align to the owning block so the clipped glow matches the
        // projected piece; fall back to the hit point if the block is gone.
        let wcx = g.x
        let wcy = g.y
        if (b) {
          const vp = { x: b.pos.x, y: b.pos.y - s.dropAnimOffset }
          wcx = vp.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
          wcy = vp.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
        }
        const wgp = project(wcx, wcy)
        ctx.save()
        ctx.translate(wgp.x, wgp.y)
        ctx.scale(wgp.scale, wgp.scale)
        ctx.translate(-wcx, -wcy)

        // Smaller, metal-like hot spot. Growth should be mostly inside the piece.
        const r0 = 1.5 + 2.2 * g.intensity
        const baseInside = 9 + 13 * g.intensity
        const rInside = baseInside * (g.bloom || 1)

        // Heat tint follows the piece's live rainbow hue (and reverts to baked
        // orange/red when music is off). Core stays white-hot for impact read.
        const gHue = hueAt(g.x, g.y)
        const gradInside = ctx.createRadialGradient(g.x, g.y, r0, g.x, g.y, rInside)
        gradInside.addColorStop(0, `rgba(255,255,255,${0.95 * a})`)
        gradInside.addColorStop(0.22, heat(gHue, 255, 210, 120, 80, 70, 0.78 * a))
        gradInside.addColorStop(0.55, heat(gHue, 255, 120, 40, 85, 58, 0.55 * a))
        gradInside.addColorStop(0.9, heat(gHue, 255, 45, 25, 88, 48, 0.28 * a))
        gradInside.addColorStop(1, heat(gHue, 255, 35, 25, 88, 45, 0))

        if (b) {
          ctx.save()
          // Clip glow to the block shape so it reads like the metal is glowing.
          // Apply drop animation offset to match visual block position
          const visualPos = { x: b.pos.x, y: b.pos.y - s.dropAnimOffset }
          drawRoundedPolyomino(ctx, b.loop, visualPos, b.cellSize, b.cornerRadius)
          ctx.clip()
          ctx.fillStyle = gradInside
          ctx.beginPath()
          ctx.arc(g.x, g.y, rInside, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }

        // Subtle external halo (reduced outside-piece glow; NOT scaled by bloom).
        const rHalo = baseInside + 6 + 4 * g.intensity
        const gradHalo = ctx.createRadialGradient(g.x, g.y, baseInside * 0.6, g.x, g.y, rHalo)
        gradHalo.addColorStop(0, heat(gHue, 255, 150, 60, 82, 62, 0.07 * a))
        gradHalo.addColorStop(0.6, heat(gHue, 255, 60, 40, 86, 50, 0.035 * a))
        gradHalo.addColorStop(1, heat(gHue, 255, 60, 40, 86, 50, 0))
        ctx.fillStyle = gradHalo
        ctx.beginPath()
        ctx.arc(g.x, g.y, rHalo, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore() // weld glow perspective transform
      }

      // Sparks
      for (const p of s.sparks) {
        const t = clamp(p.age / Math.max(0.0001, p.life), 0, 1)
        const a = (1 - t) * (0.45 + 0.65 * p.heat)
        // Hot metal spark: white -> yellow -> hue-tinted tail (rainbow with the
        // music; pink when off). Cold "deflection" sparks (armored shield hit)
        // instead read icy blue-white so a no-damage hit is unmistakable.
        const c0 = p.cold
          ? `rgba(232,244,255,${0.95 * a})`
          : `rgba(255,252,240,${0.95 * a})`
        const c1 = p.cold
          ? `rgba(150,200,255,${0.8 * a})`
          : `rgba(255,210,140,${0.75 * a})`
        const c2 = p.cold
          ? `rgba(90,150,235,${0.5 * a})`
          : heat(hueAt(p.x, p.y), 255, 120, 210, 85, 65, 0.35 * a)

        const tail = 0.018 + 0.022 * p.heat
        // Project the streak endpoints and scale its weight with depth.
        const z = scaleAt(p.y)
        const head = project(p.x, p.y)
        const back = project(p.x - p.vx * tail, p.y - p.vy * tail)

        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(1, p.size) * z
        ctx.strokeStyle = c2
        ctx.beginPath()
        ctx.moveTo(back.x, back.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()

        ctx.lineWidth = Math.max(0.8, p.size * 0.65) * z
        ctx.strokeStyle = c1
        ctx.beginPath()
        ctx.moveTo(back.x, back.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()

        ctx.fillStyle = c0
        ctx.beginPath()
        ctx.arc(head.x, head.y, Math.max(0.9, p.size * 0.55) * z, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()
    }

    // Laser segments.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // IMPORTANT: draw contiguous segments as a single polyline so we don't get bright "striations"
    // at every vertex (per-segment round caps overlap heavily, especially on curved black-hole arcs).
    const stitched: Array<{ pts: Vec2[]; intensity: number }> = []
    const eps2 = 0.9 * 0.9
    const intEps = 0.035
    for (const seg of s.laser.segments) {
      const dx = seg.b.x - seg.a.x
      const dy = seg.b.y - seg.a.y
      if (dx * dx + dy * dy < 0.0001) continue

      const last = stitched[stitched.length - 1]
      if (last) {
        const p = last.pts[last.pts.length - 1]!
        const dxa = seg.a.x - p.x
        const dya = seg.a.y - p.y
        const canJoin = dxa * dxa + dya * dya <= eps2 && Math.abs(last.intensity - seg.intensity) <= intEps
        if (canJoin) {
          last.pts.push(seg.b)
          continue
        }
      }
      stitched.push({ pts: [seg.a, seg.b], intensity: seg.intensity })
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pathLen = (pts: Vec2[]) => {
      let L = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!
        const b = pts[i]!
        L += Math.hypot(b.x - a.x, b.y - a.y)
      }
      return L
    }

    const pointAndTanAt = (pts: Vec2[], dist: number): { p: Vec2; tan: Vec2 } | null => {
      if (pts.length < 2) return null
      let acc = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!
        const b = pts[i]!
        const segL = Math.hypot(b.x - a.x, b.y - a.y)
        if (segL <= 1e-6) continue
        if (acc + segL >= dist) {
          const t = clamp((dist - acc) / segL, 0, 1)
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          const inv = 1 / segL
          const tan = { x: (b.x - a.x) * inv, y: (b.y - a.y) * inv }
          return { p, tan }
        }
        acc += segL
      }
      // Past the end: return last segment tangent.
      const a = pts[pts.length - 2]!
      const b = pts[pts.length - 1]!
      const segL = Math.hypot(b.x - a.x, b.y - a.y) || 1
      return { p: { ...b }, tan: { x: (b.x - a.x) / segL, y: (b.y - a.y) / segL } }
    }

    // Build a tapered ribbon polygon from projected screen points + per-vertex
    // half-widths (forward down one side, back up the other). A single filled
    // polygon avoids the bright vertex "striations" that overlapping stroked
    // segments would create, while letting the width shrink with depth.
    const buildRibbon = (scr: Vec2[], halfAt: number[]) => {
      const n = scr.length
      if (n < 2) return
      const nrm: Vec2[] = []
      for (let i = 0; i < n; i++) {
        let nx = 0
        let ny = 0
        if (i > 0) {
          const a = scr[i - 1]!
          const b = scr[i]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const l = Math.hypot(dx, dy) || 1
          nx += -dy / l
          ny += dx / l
        }
        if (i < n - 1) {
          const a = scr[i]!
          const b = scr[i + 1]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const l = Math.hypot(dx, dy) || 1
          nx += -dy / l
          ny += dx / l
        }
        const l = Math.hypot(nx, ny) || 1
        nrm.push({ x: nx / l, y: ny / l })
      }
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const p = scr[i]!
        const m = nrm[i]!
        const h = halfAt[i]!
        const x = p.x + m.x * h
        const y = p.y + m.y * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      for (let i = n - 1; i >= 0; i--) {
        const p = scr[i]!
        const m = nrm[i]!
        const h = halfAt[i]!
        ctx.lineTo(p.x - m.x * h, p.y - m.y * h)
      }
      ctx.closePath()
    }

    // Overdrive: the beam fattens and flips to a white-gold while the surge is up.
    const overdrive = s.overdriveSec > 0
    const odWidth = overdrive ? 1.45 : 1
    for (let li = 0; li < stitched.length; li++) {
      const line = stitched[li]!
      const alpha = clamp(line.intensity, 0, 1)
      if (alpha <= 0) continue

      // Project each vertex; keep the per-vertex depth scale so the beam narrows
      // as it falls toward the horizon, matching the grid.
      const scr: Vec2[] = []
      const sc: number[] = []
      for (const wp of line.pts) {
        const pp = project(wp.x, wp.y)
        scr.push({ x: pp.x, y: pp.y })
        sc.push(pp.scale)
      }
      if (scr.length < 2) continue

      // Laser palette: red by default, but the beam drifts through the rainbow
      // hue with the music. Motion is smooth (sustained energy), never beat-keyed,
      // so the width only breathes a few percent. The hot core stays bright.
      const beamSwell = (1 + mPulse * 0.16 + mBass * 0.1) * odWidth
      const glowAlpha = Math.min(0.7, (0.16 + (overdrive ? 0.16 : 0)) * alpha * (1 + mPulse * 0.6))
      const coreAlpha = Math.min(1, (0.78 + (overdrive ? 0.15 : 0)) * alpha)

      // Outer glow ribbon.
      const glowHalf = sc.map((z) => s.stats.beamGlowWidth * beamSwell * 0.5 * z)
      ctx.fillStyle = overdrive
        ? hsl(45, 100, 60, glowAlpha)
        : mi > 0
          ? hsl(mHue, 95, 62, glowAlpha)
          : `rgba(255,60,60,${glowAlpha.toFixed(3)})`
      buildRibbon(scr, glowHalf)
      ctx.fill()

      // Core ribbon (restroke same path) — kept bright (high lightness).
      const coreHalf = sc.map((z) => s.stats.beamWidth * 0.5 * odWidth * z)
      ctx.fillStyle = overdrive
        ? hsl(48, 100, 82, coreAlpha)
        : mi > 0
          ? hsl(mHue, 90, 72, coreAlpha)
          : `rgba(255,90,90,${coreAlpha.toFixed(3)})`
      buildRibbon(scr, coreHalf)
      ctx.fill()

      // Hot white spine — a thin near-white inner ribbon so the beam reads as a
      // superheated filament rather than a flat tube.
      const spineHalf = sc.map((z) => s.stats.beamWidth * 0.22 * odWidth * z)
      ctx.fillStyle = overdrive
        ? `rgba(255,252,240,${Math.min(1, 0.8 * alpha).toFixed(3)})`
        : mi > 0
          ? hsl(mHue, 100, 93, Math.min(1, 0.62 * alpha))
          : `rgba(255,210,210,${(0.62 * alpha).toFixed(3)})`
      buildRibbon(scr, spineHalf)
      ctx.fill()

      // Animated pulse streak: a white scanline (perpendicular to the beam) that travels forward.
      const L = pathLen(line.pts)
      if (L > 6) {
        const speedPxPerSec = 410
        const spacing = 240 // distance between pulses on long beams
        const base = (s.timeSec * speedPxPerSec + li * 37) % (spacing * 4)
        const pulses = Math.max(1, Math.min(3, Math.floor(L / spacing)))
        for (let k = 0; k < pulses; k++) {
          const d = (base + k * spacing) % L
          const pt = pointAndTanAt(line.pts, d)
          if (!pt) continue
          const perp = { x: -pt.tan.y, y: pt.tan.x }
          // Streak length matches the *core* beam width (project both ends so it
          // shrinks with depth too).
          const half = s.stats.beamWidth * 0.52
          const a1 = project(pt.p.x - perp.x * half, pt.p.y - perp.y * half)
          const a2 = project(pt.p.x + perp.x * half, pt.p.y + perp.y * half)

          // Thin crisp white streak (no wide glow band).
          ctx.strokeStyle = `rgba(255,255,255,${0.55 * alpha})`
          ctx.lineWidth = Math.max(2, s.stats.beamWidth * 0.84 * scaleAt(pt.p.y))
          ctx.beginPath()
          ctx.moveTo(a1.x, a1.y)
          ctx.lineTo(a2.x, a2.y)
          ctx.stroke()
        }
      }
    }
    ctx.restore()

    // Fixed muzzle (bottom-center). The emitter no longer slides; it always
    // fires straight up and the gravity-well puck does the steering. Drawn after
    // the laser so the muzzle sits on top of the beam root.
    {
      const kp = project(s.emitter.pos.x, s.emitter.pos.y)
      const knobR = 14 * kp.scale
      const knobX = kp.x
      const knobY = kp.y
      const emHue = mi > 0 ? mHue : 286
      // Charge breathes with energy; the muzzle is the source the beam erupts from.
      const charge = 0.55 + 0.45 * Math.sin(tNow * 3.2) * (0.4 + 0.6 * mEnergy)
      ctx.save()

      // Recessed socket: a dark ring seated into the floor, with an inner shadow
      // so the emitter reads as a port rather than a floating ball.
      const ring = ctx.createRadialGradient(knobX, knobY, knobR * 0.2, knobX, knobY, knobR * 1.35)
      ring.addColorStop(0, 'rgba(0,0,0,0)')
      ring.addColorStop(0.7, 'rgba(6,4,16,0.55)')
      ring.addColorStop(1, 'rgba(6,4,16,0)')
      ctx.fillStyle = ring
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR * 1.35, 0, Math.PI * 2)
      ctx.fill()

      ctx.lineWidth = Math.max(1.5, 2.2 * kp.scale)
      ctx.strokeStyle = hsl(emHue, 55, 40, 0.7)
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.stroke()

      // Hot core the beam blooms out of.
      ctx.globalCompositeOperation = 'lighter'
      ctx.shadowColor = hsl(emHue, 85, 66, 0.6)
      ctx.shadowBlur = (14 + mEnergy * 16) * (0.7 + 0.3 * charge)
      const core = ctx.createRadialGradient(knobX, knobY, 0, knobX, knobY, knobR * 0.9)
      core.addColorStop(0, `rgba(255,255,255,${(0.85 * (0.7 + 0.3 * charge)).toFixed(3)})`)
      core.addColorStop(0.5, hsl(emHue, 90, 75, 0.7))
      core.addColorStop(1, hsl(emHue, 88, 60, 0))
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR * 0.92, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    // Gravity-well puck: the player's single control surface — a gravitational
    // LENS that bends the beam around it. Dark core + real lensing of the board
    // behind it + a neon energy ring, tinted by the music hue and amplified by
    // the crescendo. Drawn in SCREEN space at the puck.
    if (s.well.placed) {
      // The well lives in world space; project it and scale its size with depth
      // so it belongs to the perspective playfield.
      const wp = proj.project(s.well.pos.x, s.well.pos.y)
      const cx = wp.x
      const cy = wp.y
      const wScale = clamp(wp.scale, 0.18, 1.6)
      const grabbed = s.well.grabbed
      // The lens is "energized" (its active glow is live) whenever it's
      // parked/steering the beam, not while it's being carried. Held = inert.
      const active = !grabbed
      // Event-horizon shadow radius. The whole black hole scales off this — and
      // off the perspective depth so it shrinks as it travels up the board.
      const rCore = (16 + (grabbed ? 2 : 0)) * wScale
      const hue = mi > 0 ? mHue : 285
      const surge = clamp(s.crescendo, 0, 1)

      const TWO_PI = Math.PI * 2
      const ell = (rx: number, ry: number, rot: number) => {
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry, rot, 0, TWO_PI)
      }

      // ----------------------------------------------------------------------
      // GRAVITATIONAL LENS (real, cheap). We snapshot the already-drawn board
      // (grid + blocks + laser) around the hole, then re-draw it as a series of
      // concentric ring bands, each magnified about the centre using the thin-
      // lens equation beta = theta - thetaE^2/theta. Light from just behind the
      // hole is stretched outward into an Einstein ring, so the grid lines
      // visibly bow around the shadow. The deflection tapers to zero at the lens
      // edge so there's no seam with the undistorted board.
      // ----------------------------------------------------------------------
      const rEin = rCore * 1.8 // Einstein radius — sets where the ring sits AND how wide the inner minified smear is; smaller = tighter central disc
      // Warp the ENTIRE disc down to (just under) the core edge. If we left an
      // inner gap, the real unwarped scene would show through it while the lensed
      // copy appeared farther out — a visible double image. The black core is
      // drawn on top afterwards, covering the heavily-magnified centre.
      const rLensIn = rCore * 0.9
      const rLens = rCore * 10 // outer edge: distortion fades to nothing here
      const RINGS = 26

      // Device-pixel-aligned sample box. Snapshotting and compositing on integer
      // device pixels is what lets the identity (zero-deflection) region of the
      // warp reproduce the original pixels EXACTLY. Because the deflection tapers
      // to zero before the box edge, the box rim samples 1:1 and is invisible —
      // so we can replace the whole box wholesale with no disc clip, no feather,
      // and therefore no seam and no double image.
      const viewDevW = Math.round(s.view.width * dpr)
      const viewDevH = Math.round(s.view.height * dpr)
      const devL = clamp(Math.floor((cx - rLens) * dpr), 0, viewDevW)
      const devT = clamp(Math.floor((cy - rLens) * dpr), 0, viewDevH)
      const devR = clamp(Math.ceil((cx + rLens) * dpr), 0, viewDevW)
      const devB = clamp(Math.ceil((cy + rLens) * dpr), 0, viewDevH)
      const sizeDevW = devR - devL
      const sizeDevH = devB - devT
      const boxL = devL / dpr
      const boxT = devT / dpr
      const boxWcss = sizeDevW / dpr
      const boxHcss = sizeDevH / dpr

      if (sizeDevW > 4 && sizeDevH > 4) {
        const { buf, bctx } = getLensBuf(sizeDevW, sizeDevH)
        if (bctx) {
          // Snapshot the background patch (device px, 1:1) so the warp samples a
          // clean copy and never feeds back on itself.
          bctx.setTransform(1, 0, 0, 1, 0, 0)
          bctx.clearRect(0, 0, buf.width, buf.height)
          bctx.drawImage(canvas, devL, devT, sizeDevW, sizeDevH, 0, 0, sizeDevW, sizeDevH)

          // Preferred path: a GPU per-pixel warp — smooth (bilinear) and cheap.
          let gpu = true
          let warped: HTMLCanvasElement | null = renderLens(buf, {
            cx: (cx - boxL) * dpr,
            cy: (cy - boxT) * dpr,
            rCore: rCore * dpr,
            rEin: rEin * dpr,
            rLensIn: rLensIn * dpr,
            rLens: rLens * dpr,
            boxDevW: sizeDevW,
            boxDevH: sizeDevH,
            snapW: buf.width,
            snapH: buf.height,
          })
          let warpW = sizeDevW
          let warpH = sizeDevH

          // Fallback (no WebGL): the CPU ring approach, supersampled for AA.
          if (!warped) {
            gpu = false
            const SS = 2
            const outScale = dpr * SS
            const outW = Math.ceil(boxWcss * outScale)
            const outH = Math.ceil(boxHcss * outScale)
            const { out, octx } = getLensOut(outW, outH)
            if (octx) {
              octx.setTransform(outScale, 0, 0, outScale, -boxL * outScale, -boxT * outScale)
              octx.clearRect(boxL, boxT, boxWcss, boxHcss)
              octx.imageSmoothingEnabled = true
              octx.imageSmoothingQuality = 'high'
              for (let k = RINGS - 1; k >= 0; k--) {
                const r0 = rLensIn + (rLens - rLensIn) * (k / RINGS)
                const r1 = rLensIn + (rLens - rLensIn) * ((k + 1) / RINGS)
                const rm = (r0 + r1) * 0.5
                let taper = (rLens - rm) / (rLens - rLensIn)
                taper = clamp(taper, 0, 1)
                taper = taper * taper * (3 - 2 * taper)
                const defl = ((rEin * rEin) / rm) * taper
                const beta = Math.max(rm * 0.12, rm - defl)
                const scale = rm / beta
                octx.save()
                octx.beginPath()
                octx.arc(cx, cy, r1 + 0.6, 0, TWO_PI)
                octx.arc(cx, cy, r0 - 0.6, 0, TWO_PI, true)
                octx.clip('evenodd')
                octx.translate(cx, cy)
                octx.scale(scale, scale)
                octx.translate(-cx, -cy)
                octx.drawImage(buf, 0, 0, sizeDevW, sizeDevH, boxL, boxT, boxWcss, boxHcss)
                octx.restore()
              }
              warped = out
              warpW = outW
              warpH = outH
            }
          }

          if (warped) {
            ctx.save()
            // The board canvas is transparent in the gaps between strokes (the
            // CSS background shows through). Drawing the warp straight on top
            // would composite a second semi-transparent copy over the original
            // and shift it. So clear the whole box first, then drop the warp in.
            // The warp's identity rim reproduces the originals 1:1, so the box
            // edge is invisible — no clip, no feather, no double image.
            ctx.globalCompositeOperation = 'destination-out'
            ctx.fillStyle = '#000'
            ctx.fillRect(boxL, boxT, boxWcss, boxHcss)
            ctx.globalCompositeOperation = 'source-over'
            // GPU path is a 1:1 device-pixel copy — keep it crisp. The fallback
            // is supersampled, so let it smooth on the downscale.
            ctx.imageSmoothingEnabled = !gpu
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(warped, 0, 0, warpW, warpH, boxL, boxT, boxWcss, boxHcss)
            ctx.restore()
          }
        }
      }

      ctx.save()

      const tNowS = s.timeSec
      // Organic flicker so the active state seethes instead of pulsing cleanly.
      const flick = clamp(0.62 + 0.26 * Math.sin(tNowS * 13) + 0.16 * Math.sin(tNowS * 7.3 + 1.7), 0, 1.3)

      // Energized corona (behind the core): a hot, flickering glow that appears
      // while the lens is parked and steering the beam.
      if (active) {
        ctx.globalCompositeOperation = 'lighter'
        const coronaR = rCore * 2.35
        const corA = (0.16 + 0.22 * surge) * flick
        const cor = ctx.createRadialGradient(cx, cy, rCore * 0.7, cx, cy, coronaR)
        cor.addColorStop(0, hsl(hue, 100, 62, 0))
        cor.addColorStop(0.45, hsl(hue, 100, 64, corA))
        cor.addColorStop(1, hsl(hue, 100, 62, 0))
        ctx.fillStyle = cor
        ell(coronaR, coronaR, 0)
        ctx.fill()
      }

      // Event horizon: a firm black disc with a softly feathered edge (the inner
      // ~88% is solid black, then it fades over a couple of px so it doesn't read
      // as a hard vector cut-out).
      ctx.globalCompositeOperation = 'source-over'
      const core = ctx.createRadialGradient(cx, cy, rCore * 0.5, cx, cy, rCore)
      core.addColorStop(0, 'rgba(0,0,0,1)')
      core.addColorStop(0.88, 'rgba(0,0,0,1)')
      core.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = core
      ell(rCore, rCore, 0)
      ctx.fill()

      // Orbiting light: a swirl of hot streaks spiralling around the core — the
      // beam's energy caught and bent by the lens. Thematic "this is bending
      // light" tell, not a clean UI ring.
      if (active) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'
        ctx.shadowColor = hsl(hue, 100, 60, 0.85)
        ctx.shadowBlur = 6
        const N = 7
        const baseRot = tNowS * 2.1
        for (let i = 0; i < N; i++) {
          const ph = (tNowS * 0.85 + i * 0.37) % 1 // 0..1 infall progress
          const rr = rCore * (1.62 + (1.02 - 1.62) * ph) // spirals inward
          const a0 = baseRot + (i / N) * TWO_PI + ph * 1.4 // trailing swirl
          const arcLen = (0.5 + 0.5 * (1 - ph)) * (0.7 + 0.3 * Math.sin(tNowS * 5 + i))
          const fade = (1 - ph) * flick
          ctx.lineWidth = 1.2 + 1.8 * (1 - ph)
          ctx.strokeStyle = hsl((hue + 12 * Math.sin(i * 1.3)) % 360, 100, 70 + ph * 16, (0.22 + 0.5 * fade))
          ctx.beginPath()
          ctx.arc(cx, cy, rr, a0, a0 + arcLen)
          ctx.stroke()
        }
        ctx.shadowBlur = 0
      }

      // Held (inert) tell: a dim, dashed neutral ring — clearly a "carried"
      // handle, deliberately NOT energetic so picking it up never looks active.
      if (grabbed) {
        ctx.globalCompositeOperation = 'source-over'
        ctx.setLineDash([4, 5])
        ctx.lineWidth = 1.5
        ctx.strokeStyle = hsl(hue, 22, 82, 0.32)
        ell(rCore + 5, rCore + 5, 0)
        ctx.stroke()
        ctx.setLineDash([])
      }

      ctx.restore()
    } else {
      // First-run hint: the entire surface is the control.
      const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(s.timeSec * 3))
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "800 15px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = 'Drag anywhere to steer the beam'
      const cxx = s.view.width / 2
      const cyy = s.view.height * 0.46
      ctx.globalAlpha = pulse
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 10
      ctx.fillStyle = 'rgba(255,246,213,0.96)'
      ctx.fillText(label, cxx, cyy)
      ctx.restore()
    }

    // HP text last so it stays readable above welding glow + sparks + laser.
    for (const b of s.blocks) {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const fillBase = healthFill(hpPct)
      const lum = relativeLuma(fillBase)

      const anchor = pickHpAnchor(s, b)
      const pc = project(anchor.x, anchor.y)
      const cx = pc.x
      const cy = pc.y
      ctx.font = `900 ${(18 * pc.scale).toFixed(1)}px Nunito`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const darkText = lum > 0.55
      ctx.fillStyle = darkText ? 'rgba(10,5,18,0.92)' : 'rgba(255,248,230,0.95)'
      ctx.strokeStyle = darkText ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 3 * pc.scale
      const label = String(Math.max(0, Math.ceil(b.hp)))
      ctx.strokeText(label, cx, cy)
      ctx.fillText(label, cx, cy)
    }

    // Power-up flash: a compact neon badge that pops in, holds briefly, then
    // drifts upward and fades. Sits in the upper third so it never blocks the
    // beam/hole action, and is themed to the live music hue.
    if (s.levelUpNotificationFx) {
      const t = s.levelUpNotificationFx.t
      const displayDur = s.levelUpNotificationFx.displayDur
      const fadeDur = s.levelUpNotificationFx.fadeDur

      const introDur = 0.22
      const intro = clamp(t / introDur, 0, 1)
      // easeOutBack for a little overshoot on entry (impact).
      const c1 = 1.70158
      const c3 = c1 + 1
      const back = 1 + c3 * Math.pow(intro - 1, 3) + c1 * Math.pow(intro - 1, 2)

      let alpha = 1
      let riseY = 0
      if (t < introDur) {
        alpha = intro
        riseY = (1 - intro) * 8
      }
      if (t > displayDur) {
        const f = clamp((t - displayDur) / fadeDur, 0, 1)
        alpha = 1 - f
        riseY = -f * 22
      }

      if (alpha > 0.001) {
        const cx = s.view.width * 0.5
        const cy = s.view.height * 0.3 + riseY
        const scale = 0.72 + 0.28 * back
        const hue = mi > 0 ? mHue : 300

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.textAlign = 'center'
        ctx.translate(cx, cy)
        ctx.scale(scale, scale)

        // Eyebrow: "BEAM LEVEL N" — small, letterspaced, neon.
        ctx.textBaseline = 'alphabetic'
        ctx.shadowColor = hsl(hue, 100, 60, 0.7 * alpha)
        ctx.shadowBlur = 8
        try {
          ctx.letterSpacing = '4px'
        } catch {
          // Older engines: harmless to skip.
        }
        ctx.font = '800 13px Oxanium'
        ctx.fillStyle = hsl(hue, 95, 82, 0.92 * alpha)
        ctx.fillText('HEAT MAXED', 2, -16)
        try {
          ctx.letterSpacing = '0px'
        } catch {
          /* noop */
        }

        // Main: "OVERDRIVE" — white-hot core with a hue bloom.
        ctx.textBaseline = 'middle'
        ctx.font = '900 30px Oxanium'
        ctx.shadowColor = hsl(hue, 100, 62, 0.95 * alpha)
        ctx.shadowBlur = 18
        ctx.fillStyle = `rgba(255,250,240,${alpha})`
        ctx.fillText('OVERDRIVE', 0, 12)

        // Neon underline that grows with the entry pop.
        ctx.shadowBlur = 10
        const uw = 86 * intro
        const ug = ctx.createLinearGradient(-uw, 0, uw, 0)
        ug.addColorStop(0, hsl(hue, 95, 70, 0))
        ug.addColorStop(0.5, hsl((hue + 18) % 360, 100, 78, 0.95 * alpha))
        ug.addColorStop(1, hsl(hue, 95, 70, 0))
        ctx.strokeStyle = ug
        ctx.lineWidth = 2.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(-uw, 34)
        ctx.lineTo(uw, 34)
        ctx.stroke()

        ctx.restore()
      }
    }
  })
}


