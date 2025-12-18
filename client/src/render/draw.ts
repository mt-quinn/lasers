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

    // Blocks.
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

      // HP text (centered in AABB).
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

    // Aim reticle: classic sniper reticle, glowing red.
    const rx = s.reticle.x
    const ry = s.reticle.y
    const pulse = 0.55 + 0.45 * Math.sin(s.timeSec * 5.2)
    const retScale = 0.75
    const retOuterR = (22 + pulse * 1.2) * retScale
    const retInnerR = 8.5 * retScale

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'

    // Red glow halo
    ctx.strokeStyle = `rgba(255, 60, 60, ${0.18 + pulse * 0.08})`
    ctx.lineWidth = 9
    ctx.beginPath()
    ctx.arc(rx, ry, retOuterR, 0, Math.PI * 2)
    ctx.stroke()

    // Outer ring with quadrant gaps (classic scope feel)
    ctx.strokeStyle = 'rgba(255, 80, 80, 0.85)'
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
    ctx.strokeStyle = 'rgba(255, 120, 120, 0.9)'
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
    ctx.strokeStyle = 'rgba(255, 120, 120, 0.70)'
    ctx.lineWidth = 1.4
    const tickStep = 4 * retScale
    const tickLen = 2.5 * retScale
    const tickInset = 4 * retScale
    const maxTicks = Math.max(
      0,
      Math.min(4, Math.floor((retOuterR - tickInset - innerStop) / tickStep)),
    )
    // left/right ticks
    for (let i = 1; i <= maxTicks; i++) {
      const dx = innerStop + i * tickStep
      ctx.beginPath()
      ctx.moveTo(rx - dx, ry - tickLen)
      ctx.lineTo(rx - dx, ry + tickLen)
      ctx.moveTo(rx + dx, ry - tickLen)
      ctx.lineTo(rx + dx, ry + tickLen)
      ctx.stroke()
    }
    // up/down ticks
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
    ctx.strokeStyle = 'rgba(255, 120, 120, 0.9)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(rx, ry, retInnerR, 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = 'rgba(255, 210, 210, 0.95)'
    ctx.beginPath()
    ctx.arc(rx, ry, 1.7, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()

    // Slider rail + emitter (at bottom, above safe-area).
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(16, railY, s.view.width - 32, 14)
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'
    ctx.lineWidth = 2
    ctx.strokeRect(16, railY, s.view.width - 32, 14)

    ctx.save()
    ctx.shadowColor = 'rgba(255,120,210,0.55)'
    ctx.shadowBlur = 18
    ctx.fillStyle = 'rgba(255,245,200,0.95)'
    ctx.beginPath()
    ctx.arc(s.emitter.pos.x, s.emitter.pos.y, 11, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    // Drop timer indicator (radial fill): shows time until next global step.
    // Placed just above the rail, centered, to teach cadence.
    const progress = clamp((s.dropIntervalSec - s.dropTimerSec) / Math.max(0.001, s.dropIntervalSec), 0, 1)
    const ringCx = s.view.width * 0.5
    const ringCy = railY - 18
    const rOuter = 12
    const rInner = 8.5

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = 'rgba(255,245,220,0.20)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(ringCx, ringCy, rOuter, 0, Math.PI * 2)
    ctx.stroke()

    // Filled wedge arc (starts at top, fills clockwise)
    const startAng = -Math.PI / 2
    const endAng = startAng + progress * Math.PI * 2
    ctx.strokeStyle = 'rgba(255,120,210,0.75)'
    ctx.lineWidth = rOuter - rInner
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.arc(ringCx, ringCy, (rOuter + rInner) / 2, startAng, endAng)
    ctx.stroke()
    ctx.restore()

    // XP gauge (vertical fill on the right).
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    const xpFrac = clamp(s.xp / Math.max(1, s.xpCap), 0, 1)

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

        // Smaller, metal-like hot spot. Most of the glow is clipped inside the piece.
        const r0 = 1.5 + 2.2 * g.intensity
        const rInside = 9 + 13 * g.intensity

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

        // Subtle external halo (reduced outside-piece glow).
        const rHalo = rInside + 5 + 4 * g.intensity
        const gradHalo = ctx.createRadialGradient(g.x, g.y, rInside * 0.6, g.x, g.y, rHalo)
        gradHalo.addColorStop(0, `rgba(255,150,60,${0.12 * a})`)
        gradHalo.addColorStop(0.6, `rgba(255,60,40,${0.06 * a})`)
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
    for (const seg of s.laser.segments) {
      const alpha = clamp(seg.intensity, 0, 1)
      // outer glow
      ctx.strokeStyle = `rgba(255,120,210,${0.22 * alpha})`
      ctx.lineWidth = s.stats.beamWidth * 3.4
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(seg.a.x, seg.a.y)
      ctx.lineTo(seg.b.x, seg.b.y)
      ctx.stroke()

      // core
      ctx.strokeStyle = `rgba(255,245,210,${0.78 * alpha})`
      ctx.lineWidth = s.stats.beamWidth
      ctx.beginPath()
      ctx.moveTo(seg.a.x, seg.a.y)
      ctx.lineTo(seg.b.x, seg.b.y)
      ctx.stroke()
    }
    ctx.restore()
  })
}


