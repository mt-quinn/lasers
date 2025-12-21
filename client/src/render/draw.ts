import type { RunState } from '../game/runState'
import type { Vec2 } from '../game/math'
import { clamp } from '../game/math'
import { getArenaLayout } from '../game/layout'
// (getRarityColor will be used by the level-up menu overlay; keep renderer lean for now.)

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
  let p0 = pts[0]!
  let p1 = pts[1]!
  let d01 = dir(p0, p1)
  const startCut = isConvex(0) ? r : 0
  const start = { x: p0.x + d01.x * startCut, y: p0.y + d01.y * startCut }
  ctx.moveTo(start.x, start.y)

  for (let i = 0; i < m; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const d = dir(a, b)
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const cutA = isConvex(i) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const cutB = isConvex(i + 1) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const a2 = { x: a.x + d.x * cutA, y: a.y + d.y * cutA }
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
  // Use cached inside-the-shape anchor, then apply the "slide up as it becomes visible" rule.
  const target = { x: b.pos.x + b.hpAnchorLocalPx.x, y: b.pos.y + b.hpAnchorLocalPx.y }

  const pieceTop = b.pos.y + b.localAabb.minY
  const pieceBottom = b.pos.y + b.localAabb.maxY
  const visibleTop = 0
  const visibleBottom = s.view.height

  const visiblePieceTop = Math.max(pieceTop, visibleTop)
  const visiblePieceBottom = Math.min(pieceBottom, visibleBottom)
  const pieceH = Math.max(1, pieceBottom - pieceTop)
  const visibleFrac = clamp((visiblePieceBottom - visiblePieceTop) / pieceH, 0, 1)

  const pad = 10
  const yBottomVisible = visiblePieceBottom - pad
  const t = Math.pow(visibleFrac, 2.2)
  const y = lerp(yBottomVisible, target.y, t)

  // Clamp inside the piece's AABB (conservative walls clamp).
  const left = b.pos.x + b.localAabb.minX + pad
  const right = b.pos.x + b.localAabb.maxX - pad
  const top = Math.max(visibleTop + pad, b.pos.y + b.localAabb.minY + pad)
  const bottom = b.pos.y + b.localAabb.maxY - pad
  return { x: clamp(target.x, left, right), y: clamp(y, top, bottom) }
}

export const drawFrame = (canvas: HTMLCanvasElement, s: RunState) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = s.view.dpr
  withDpr(ctx, dpr, () => {
    ctx.clearRect(0, 0, s.view.width, s.view.height)
    const layout = getArenaLayout(s.view)
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

    // Arena glow vignette.
    const grd = ctx.createRadialGradient(
      s.view.width * 0.5,
      s.view.height * 0.35,
      40,
      s.view.width * 0.5,
      s.view.height * 0.5,
      Math.max(s.view.width, s.view.height) * 0.75,
    )
    grd.addColorStop(0, 'rgba(160,120,255,0.10)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, s.view.width, s.view.height)

    // Fail line: keep it tight to the bottom to maximize board height.
    const railY = layout.railY
    const failY = layout.failY
    ctx.strokeStyle = 'rgba(255,220,180,0.18)'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 10])
    ctx.beginPath()
    ctx.moveTo(0, failY)
    ctx.lineTo(s.view.width, failY)
    ctx.stroke()
    ctx.setLineDash([])

    // Blocks (base render; HP text is drawn at the very end so it stays above glow/laser).
    for (const b of s.blocks) {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const glow = 0.35 + 0.65 * (1 - hpPct)

      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      const fillBase = healthFill(hpPct)
      const lum = relativeLuma(fillBase)
      ctx.shadowColor = `rgba(255,120,210,${0.14 * glow})`
      ctx.shadowBlur = 18 * glow

      drawRoundedPolyomino(ctx, b.loop, b.pos, b.cellSize, b.cornerRadius)

      // Solid fill (health gradient is applied as a per-piece color, not as an internal gradient).
      ctx.fillStyle = fillBase
      ctx.fill()

      // Bevel shading overlay (subtle, still solid-colored overall).
      ctx.save()
      ctx.globalCompositeOperation = 'overlay'
      const shade = ctx.createLinearGradient(
        b.pos.x,
        b.pos.y + b.localAabb.minY,
        b.pos.x,
        b.pos.y + b.localAabb.maxY,
      )
      shade.addColorStop(0, 'rgba(255,255,255,0.22)')
      shade.addColorStop(0.55, 'rgba(255,255,255,0.05)')
      shade.addColorStop(1, 'rgba(0,0,0,0.18)')
      ctx.fillStyle = shade
      ctx.fill()
      ctx.restore()

      ctx.lineWidth = 2
      ctx.strokeStyle = lum > 0.62 ? 'rgba(40,18,60,0.70)' : 'rgba(255,245,220,0.35)'
      ctx.stroke()
      ctx.restore()
    }

    // Board features: mirrors / prisms / black holes (indestructible, no HP numbers).
    if (s.features.length > 0) {
      for (const f of s.features) {
        // Skip if fully above the screen (matches the "not shootable until visible" vibe visually too).
        const maxY = f.pos.y + f.localAabb.maxY
        if (maxY < 0) continue

        if (f.kind === 'mirror') {
          const m = f
          const ax = m.pos.x + m.localAabb.minX
          const ay = m.pos.y + m.localAabb.minY
          const w = m.localAabb.maxX - m.localAabb.minX
          const h = m.localAabb.maxY - m.localAabb.minY

          ctx.save()
          ctx.globalCompositeOperation = 'source-over'
          ctx.shadowColor = 'rgba(180,220,255,0.20)'
          ctx.shadowBlur = 14

          drawRoundedPolyomino(ctx, m.loop, m.pos, m.cellSize, m.cornerRadius)

          const grad = ctx.createLinearGradient(ax, ay, ax + w, ay + h)
          grad.addColorStop(0, 'rgb(60 75 105)')
          grad.addColorStop(0.45, 'rgb(145 170 210)')
          grad.addColorStop(1, 'rgb(55 65 90)')
          ctx.fillStyle = grad
          ctx.fill()

          // Important: confine the shadow glow to the *fill* only.
          // Leaving shadowBlur on will make the outline/top edge read as a thick horizontal glare band.
          ctx.shadowBlur = 0
          ctx.shadowColor = 'rgba(0,0,0,0)'

          // Specular diagonal sheen lines.
          ctx.save()
          ctx.clip()
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'
          ctx.lineWidth = 3
          const step = 16
          for (let x = -h; x < w + h; x += step) {
            ctx.beginPath()
            ctx.moveTo(ax + x, ay)
            ctx.lineTo(ax + x + h, ay + h)
            ctx.stroke()
          }
          ctx.restore()

          // Outline (must redraw path; the sheen loop overwrote the current path).
          drawRoundedPolyomino(ctx, m.loop, m.pos, m.cellSize, m.cornerRadius)
          ctx.lineWidth = 2
          ctx.strokeStyle = 'rgba(245,250,255,0.35)'
          ctx.stroke()

          ctx.restore()
          continue
        }

        if (f.kind === 'prism') {
          const p = f
          const cx = p.pos.x + p.cellSize * 0.5
          const cy = p.pos.y + p.cellSize * 0.5
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
          const exits: number[] = Array.isArray((p as any).exitsDeg) ? (p as any).exitsDeg : [45, -45]
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
          continue
        }

        // black hole
        const bh = f
        const cx = bh.pos.x + bh.cellSize * 0.5
        const cy = bh.pos.y + bh.cellSize * 0.5
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
      }
    }

    // XP gauge (vertical fill on the right).
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    const xpFrac = clamp(s.xp / Math.max(1, s.xpCap), 0, 1)

    // Drop timer indicator (linear fill): shows time until next global step.
    // Move to top-right: just left of the XP gauge, aligned to its top with padding.
    const progress = clamp((s.dropIntervalSec - s.dropTimerSec) / Math.max(0.001, s.dropIntervalSec), 0, 1)
    const pad = 10
    const barW = 10
    const barH = 56
    const barX = gx - pad - barW
    const barY = gy
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    // background
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(barX - 2, barY - 2, barW + 4, barH + 4)
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 2
    ctx.strokeRect(barX - 2, barY - 2, barW + 4, barH + 4)
    // fill (bottom -> top)
    const fh = barH * progress
    ctx.fillStyle = 'rgba(255,120,210,0.80)'
    ctx.fillRect(barX, barY + (barH - fh), barW, fh)
    ctx.restore()

    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(gx - 2, gy - 2, gw + 4, gh + 4)
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 2
    ctx.strokeRect(gx - 2, gy - 2, gw + 4, gh + 4)

    // fill
    const fillH = gh * xpFrac
    ctx.fillStyle = 'rgba(255,120,210,0.78)'
    ctx.fillRect(gx, gy + (gh - fillH), gw, fillH)
    ctx.restore()

    // XP orbs (condense -> fly).
    if (s.xpOrbs.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const orb of s.xpOrbs) {
        const p =
          orb.phase === 'condense'
            ? orb.from
            : {
                x: orb.from.x + (orb.to.x - orb.from.x) * Math.pow(clamp(orb.t / 0.55, 0, 1), 0.75),
                y: orb.from.y + (orb.to.y - orb.from.y) * Math.pow(clamp(orb.t / 0.55, 0, 1), 0.75),
              }
        const r = orb.phase === 'condense' ? 16 * (1 - clamp(orb.t / 0.12, 0, 1)) + 4 : 5
        ctx.fillStyle = 'rgba(255,120,210,0.35)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = 'rgba(255,245,230,0.85)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
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

        // Smaller, metal-like hot spot. Growth should be mostly inside the piece.
        const r0 = 1.5 + 2.2 * g.intensity
        const baseInside = 9 + 13 * g.intensity
        const rInside = baseInside * (g.bloom || 1)

        const gradInside = ctx.createRadialGradient(g.x, g.y, r0, g.x, g.y, rInside)
        // Heated metal: white-hot core -> orange -> deep red edge.
        gradInside.addColorStop(0, `rgba(255,255,255,${0.95 * a})`)
        gradInside.addColorStop(0.22, `rgba(255,210,120,${0.78 * a})`)
        gradInside.addColorStop(0.55, `rgba(255,120,40,${0.55 * a})`)
        gradInside.addColorStop(0.9, `rgba(255,45,25,${0.28 * a})`)
        gradInside.addColorStop(1, 'rgba(255,35,25,0)')

        if (b) {
          ctx.save()
          // Clip glow to the block shape so it reads like the metal is glowing.
          drawRoundedPolyomino(ctx, b.loop, b.pos, b.cellSize, b.cornerRadius)
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
        gradHalo.addColorStop(0, `rgba(255,150,60,${0.07 * a})`)
        gradHalo.addColorStop(0.6, `rgba(255,60,40,${0.035 * a})`)
        gradHalo.addColorStop(1, 'rgba(255,60,40,0)')
        ctx.fillStyle = gradHalo
        ctx.beginPath()
        ctx.arc(g.x, g.y, rHalo, 0, Math.PI * 2)
        ctx.fill()
      }

      // Sparks
      for (const p of s.sparks) {
        const t = clamp(p.age / Math.max(0.0001, p.life), 0, 1)
        const a = (1 - t) * (0.45 + 0.65 * p.heat)
        // "hot metal" spark color shifts from white -> yellow -> orange/pink
        const c0 = `rgba(255,252,240,${0.95 * a})`
        const c1 = `rgba(255,210,140,${0.75 * a})`
        const c2 = `rgba(255,120,210,${0.35 * a})`

        const tail = 0.018 + 0.022 * p.heat
        const x0 = p.x - p.vx * tail
        const y0 = p.y - p.vy * tail

        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(1, p.size)
        ctx.strokeStyle = c2
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(p.x, p.y)
        ctx.stroke()

        ctx.lineWidth = Math.max(0.8, p.size * 0.65)
        ctx.strokeStyle = c1
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(p.x, p.y)
        ctx.stroke()

        ctx.fillStyle = c0
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0.9, p.size * 0.55), 0, Math.PI * 2)
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

    for (let li = 0; li < stitched.length; li++) {
      const line = stitched[li]!
      const alpha = clamp(line.intensity, 0, 1)
      if (alpha <= 0) continue

      // Build path once.
      ctx.beginPath()
      ctx.moveTo(line.pts[0]!.x, line.pts[0]!.y)
      for (let i = 1; i < line.pts.length; i++) ctx.lineTo(line.pts[i]!.x, line.pts[i]!.y)

      // Laser palette: darker reticle-red, with a warm core.
      // (Reticle uses reds; keep this cohesive and more dangerous-looking.)
      // outer glow
      ctx.strokeStyle = `rgba(255,60,60,${0.16 * alpha})`
      ctx.lineWidth = s.stats.beamWidth * 3.4
      ctx.stroke()

      // core (restroke same path)
      ctx.strokeStyle = `rgba(255,90,90,${0.78 * alpha})`
      ctx.lineWidth = s.stats.beamWidth
      ctx.stroke()

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
          // Streak length should match the *core* beam width (not the outer glow).
          const half = s.stats.beamWidth * 0.52
          const a0 = pt.p
          const a1 = { x: a0.x - perp.x * half, y: a0.y - perp.y * half }
          const a2 = { x: a0.x + perp.x * half, y: a0.y + perp.y * half }

          // Thin crisp white streak (no wide glow band).
          ctx.strokeStyle = `rgba(255,255,255,${0.55 * alpha})`
          ctx.lineWidth = Math.max(3.2, s.stats.beamWidth * 0.84)
          ctx.beginPath()
          ctx.moveTo(a1.x, a1.y)
          ctx.lineTo(a2.x, a2.y)
          ctx.stroke()
        }
      }
    }
    ctx.restore()

    // Slider rail + emitter (at bottom, above safe-area). Draw *after* the laser so the emitter sits on top.
    {
      const railX = 16
      const railW = s.view.width - 32
      const railH = layout.railH
      const railR = railH / 2

      // Outer rail body
      ctx.save()
      const railGrad = ctx.createLinearGradient(0, railY, 0, railY + railH)
      railGrad.addColorStop(0, 'rgba(255,255,255,0.06)')
      railGrad.addColorStop(0.5, 'rgba(0,0,0,0.22)')
      railGrad.addColorStop(1, 'rgba(0,0,0,0.34)')
      ctx.fillStyle = railGrad
      roundedRectPath(railX, railY, railW, railH, railR)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.lineWidth = 2
      ctx.stroke()

      // Inner groove
      const groovePad = 3
      const grooveH = Math.max(6, railH - 6)
      const grooveY = railY + (railH - grooveH) / 2
      const grooveR = grooveH / 2
      const grooveGrad = ctx.createLinearGradient(0, grooveY, 0, grooveY + grooveH)
      grooveGrad.addColorStop(0, 'rgba(0,0,0,0.38)')
      grooveGrad.addColorStop(1, 'rgba(255,255,255,0.05)')
      ctx.fillStyle = grooveGrad
      roundedRectPath(railX + groovePad, grooveY, railW - groovePad * 2, grooveH, grooveR)
      ctx.fill()
      ctx.restore()

      // Emitter knob (slider handle)
      const knobR = 13
      const knobX = s.emitter.pos.x
      const knobY = s.emitter.pos.y
      ctx.save()
      ctx.shadowColor = 'rgba(255,120,210,0.45)'
      ctx.shadowBlur = 18
      const knobGrad = ctx.createRadialGradient(
        knobX - knobR * 0.35,
        knobY - knobR * 0.45,
        2,
        knobX,
        knobY,
        knobR * 1.25,
      )
      knobGrad.addColorStop(0, 'rgba(255,255,255,0.95)')
      knobGrad.addColorStop(0.55, 'rgba(255,245,200,0.92)')
      knobGrad.addColorStop(1, 'rgba(180,150,255,0.70)')
      ctx.fillStyle = knobGrad
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.stroke()

      // Grip lines
      ctx.strokeStyle = 'rgba(0,0,0,0.26)'
      ctx.lineWidth = 1.5
      for (let i = -1; i <= 1; i++) {
        const xx = knobX + i * 3.5
        ctx.beginPath()
        ctx.moveTo(xx, knobY - 6)
        ctx.lineTo(xx, knobY + 6)
        ctx.stroke()
      }
      ctx.restore()

      // Tutorial label: persists until the player moves the emitter.
      if (!s.tutorialMovedEmitter) {
        const pulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(s.timeSec * 3.1))
        const label = 'Move Laser ↔'
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.font = "800 12px 'Oxanium', system-ui, sans-serif"
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const padX = 10
        const textW = ctx.measureText(label).width
        const boxW = Math.ceil(textW + padX * 2)
        const boxH = 22
        const boxX = knobX - boxW / 2
        const boxY = knobY - knobR - 10 - boxH
        ctx.globalAlpha = pulse
        ctx.shadowColor = 'rgba(255,120,210,0.35)'
        ctx.shadowBlur = 14
        ctx.fillStyle = 'rgba(10, 8, 22, 0.72)'
        roundedRectPath(boxX, boxY, boxW, boxH, 10)
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'
        ctx.lineWidth = 2
        roundedRectPath(boxX, boxY, boxW, boxH, 10)
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,246,213,0.98)'
        ctx.fillText(label, knobX, boxY + boxH / 2)
        ctx.restore()
      }
    }

    // Aim reticle: draw late (above weld glow) and auto-darken when bright welding glow is behind it.
    {
      const rx = s.reticle.x
      const ry = s.reticle.y
      const pulse = 0.55 + 0.45 * Math.sin(s.timeSec * 5.2)
      const retScale = 0.75
      const retOuterR = (22 + pulse * 1.2) * retScale
      const retInnerR = 8.5 * retScale

      // Estimate "backlight" from nearby weld glows.
      let back = 0
      if (s.weldGlows.length > 0) {
        for (const g of s.weldGlows) {
          const tt = clamp(g.age / Math.max(0.0001, g.life), 0, 1)
          const a = (1 - tt) * (0.35 + 0.55 * g.intensity)
          const baseInside = 9 + 13 * g.intensity
          const rInside = baseInside * (g.bloom || 1)
          const rr = rInside + 18
          const dx = rx - g.x
          const dy = ry - g.y
          const d2 = dx * dx + dy * dy
          if (d2 > rr * rr) continue
          const d = Math.sqrt(d2)
          back += a * (1 - d / rr)
        }
      }
      back = clamp(back * 1.6, 0, 1)
      const darkMode = back > 0.22
      const aScale = darkMode ? 0.55 : 1

      // Dark underlay (improves legibility against bright additive glows).
      if (darkMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = `rgba(0,0,0,${0.62 * back})`
        ctx.lineWidth = 6
        ctx.beginPath()
        ctx.arc(rx, ry, retOuterR, 0, Math.PI * 2)
        ctx.stroke()
        ctx.lineWidth = 5
        const arm = retOuterR + 10 * retScale
        const innerStop = retInnerR + 2 * retScale
        ctx.beginPath()
        ctx.moveTo(rx - arm, ry)
        ctx.lineTo(rx - innerStop, ry)
        ctx.moveTo(rx + innerStop, ry)
        ctx.lineTo(rx + arm, ry)
        ctx.moveTo(rx, ry - arm)
        ctx.lineTo(rx, ry - innerStop)
        ctx.moveTo(rx, ry + innerStop)
        ctx.lineTo(rx, ry + arm)
        ctx.stroke()
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = darkMode ? 'source-over' : 'lighter'
      ctx.lineCap = 'round'

      // Red glow halo (reduced when backlit).
      ctx.strokeStyle = `rgba(255, 60, 60, ${(0.18 + pulse * 0.08) * aScale * 0.65})`
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.arc(rx, ry, retOuterR, 0, Math.PI * 2)
      ctx.stroke()

      // Outer ring with quadrant gaps (classic scope feel)
      ctx.strokeStyle = `rgba(255, 80, 80, ${0.85 * aScale})`
      ctx.lineWidth = 2.25
      const gap = Math.PI / 10
      for (let q = 0; q < 4; q++) {
        const a0 = q * (Math.PI / 2) + gap
        const a1 = (q + 1) * (Math.PI / 2) - gap
        ctx.beginPath()
        ctx.arc(rx, ry, retOuterR, a0, a1)
        ctx.stroke()
      }

      // Crosshair lines (stop short of center ring)
      const arm = retOuterR + 10 * retScale
      const innerStop = retInnerR + 2 * retScale
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.9 * aScale})`
      ctx.lineWidth = 2
      ctx.beginPath()
      // horizontal
      ctx.moveTo(rx - arm, ry)
      ctx.lineTo(rx - innerStop, ry)
      ctx.moveTo(rx + innerStop, ry)
      ctx.lineTo(rx + arm, ry)
      // vertical
      ctx.moveTo(rx, ry - arm)
      ctx.lineTo(rx, ry - innerStop)
      ctx.moveTo(rx, ry + innerStop)
      ctx.lineTo(rx, ry + arm)
      ctx.stroke()

      // Tick marks along crosshair (small, tight, and contained within the outer ring)
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.7 * aScale})`
      ctx.lineWidth = 1.4
      const tickStep = 4 * retScale
      const tickLen = 2.5 * retScale
      const tickInset = 4 * retScale
      const maxTicks = Math.max(0, Math.min(4, Math.floor((retOuterR - tickInset - innerStop) / tickStep)))
      for (let i = 1; i <= maxTicks; i++) {
        const dx = innerStop + i * tickStep
        ctx.beginPath()
        ctx.moveTo(rx - dx, ry - tickLen)
        ctx.lineTo(rx - dx, ry + tickLen)
        ctx.moveTo(rx + dx, ry - tickLen)
        ctx.lineTo(rx + dx, ry + tickLen)
        ctx.stroke()
      }
      for (let i = 1; i <= maxTicks; i++) {
        const dy = innerStop + i * tickStep
        ctx.beginPath()
        ctx.moveTo(rx - tickLen, ry - dy)
        ctx.lineTo(rx + tickLen, ry - dy)
        ctx.moveTo(rx - tickLen, ry + dy)
        ctx.lineTo(rx + tickLen, ry + dy)
        ctx.stroke()
      }

      // Center ring + dot
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.9 * aScale})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(rx, ry, retInnerR, 0, Math.PI * 2)
      ctx.stroke()

      ctx.fillStyle = `rgba(255, 210, 210, ${0.95 * aScale})`
      ctx.beginPath()
      ctx.arc(rx, ry, 1.7, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
    }

    // HP text last so it stays readable above welding glow + sparks + laser.
    for (const b of s.blocks) {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const fillBase = healthFill(hpPct)
      const lum = relativeLuma(fillBase)

      const anchor = pickHpAnchor(s, b)
      const cx = anchor.x
      const cy = anchor.y
      ctx.font = '900 18px Nunito'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const darkText = lum > 0.55
      ctx.fillStyle = darkText ? 'rgba(10,5,18,0.92)' : 'rgba(255,248,230,0.95)'
      ctx.strokeStyle = darkText ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 3
      const label = String(Math.max(0, Math.ceil(b.hp)))
      ctx.strokeText(label, cx, cy)
      ctx.fillText(label, cx, cy)
    }

    // Life loss presentation: board wipe + banner (run continues).
    if (s.lifeLossFx) {
      const t = s.lifeLossFx.t
      const wipeDur = s.lifeLossFx.wipeDur
      const bannerDur = s.lifeLossFx.bannerDur

      // Wipe: a bright scan band that moves top->bottom, "vaporizing" the board.
      const p = clamp(t / Math.max(0.001, wipeDur), 0, 1)
      if (p < 1) {
        const y = p * s.view.height
        const band = 90
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const grad = ctx.createLinearGradient(0, y - band, 0, y + band)
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(0.35, 'rgba(255,80,120,0.10)')
        grad.addColorStop(0.5, 'rgba(255,240,220,0.18)')
        grad.addColorStop(0.65, 'rgba(255,80,120,0.10)')
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.fillRect(0, y - band, s.view.width, band * 2)

        // subtle trailing vignette above the band so the wipe reads as an event.
        const haze = ctx.createLinearGradient(0, 0, 0, y)
        haze.addColorStop(0, 'rgba(0,0,0,0)')
        haze.addColorStop(1, 'rgba(0,0,0,0.10)')
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = haze
        ctx.fillRect(0, 0, s.view.width, y)
        ctx.restore()
      }

      // Banner: "LIFE LOST" + remaining lives.
      const bt = clamp(t / Math.max(0.001, bannerDur), 0, 1)
      const fadeIn = clamp(bt / 0.12, 0, 1)
      const fadeOut = clamp((1 - bt) / 0.25, 0, 1)
      const a = fadeIn * fadeOut
      if (a > 0.001) {
        const cx = s.view.width * 0.5
        const cy = s.view.height * 0.32
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'

        // Panel
        ctx.fillStyle = `rgba(0,0,0,${0.35 * a})`
        const w = Math.min(320, s.view.width - 44)
        const h = 72
        const x = cx - w / 2
        const y = cy - h / 2
        ctx.beginPath()
        const r = 14
        ctx.moveTo(x + r, y)
        ctx.arcTo(x + w, y, x + w, y + h, r)
        ctx.arcTo(x + w, y + h, x, y + h, r)
        ctx.arcTo(x, y + h, x, y, r)
        ctx.arcTo(x, y, x + w, y, r)
        ctx.closePath()
        ctx.fill()

        // Accent line
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = `rgba(255,80,120,${0.45 * a})`
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(x + 18, y + 14)
        ctx.lineTo(x + w - 18, y + 14)
        ctx.stroke()
        ctx.restore()

        // Text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = `rgba(255,245,235,${0.95 * a})`
        ctx.font = '900 18px Oxanium'
        ctx.fillText('LIFE LOST', cx, cy - 10)
        ctx.fillStyle = `rgba(255,210,210,${0.75 * a})`
        ctx.font = '800 13px Nunito'
        ctx.fillText(`${s.lifeLossFx.livesAfter}/3 lives remaining`, cx, cy + 14)

        ctx.restore()
      }
    }
  })
}


