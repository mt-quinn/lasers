import type { RunState } from '../game/runState'
import type { Vec2 } from '../game/math'
import { clamp } from '../game/math'

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
    const railH = 14
    const bottomPad = 16 + (s.view.safeBottom || 0)
    const railY = s.view.height - bottomPad - railH
    const failY = railY - 8
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


