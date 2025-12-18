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
  const r = clamp(rPx, 0, cellSize * 0.49)

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
    const cutA = isConvex(i) ? Math.min(r, segLen * 0.49) : 0
    const cutB = isConvex(i + 1) ? Math.min(r, segLen * 0.49) : 0
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
    const bottomPad = 16
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
      ctx.shadowColor = `rgba(180,140,255,${0.16 * glow})`
      ctx.shadowBlur = 18 * glow

      drawRoundedPolyomino(ctx, b.loop, b.pos, b.cellSize, b.cornerRadius)

      const fill = ctx.createLinearGradient(b.pos.x, b.pos.y, b.pos.x, b.pos.y + b.localAabb.maxY)
      fill.addColorStop(0, 'rgba(255,245,200,0.92)')
      fill.addColorStop(1, 'rgba(220,160,255,0.90)')
      ctx.fillStyle = fill
      ctx.fill()

      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(40,18,60,0.75)'
      ctx.stroke()
      ctx.restore()

      // HP text (centered in AABB).
      const cx = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
      const cy = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
      ctx.font = '900 18px Nunito'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(10,5,18,0.95)'
      ctx.strokeStyle = 'rgba(255,255,255,0.55)'
      ctx.lineWidth = 3
      const label = String(Math.max(0, Math.ceil(b.hp)))
      ctx.strokeText(label, cx, cy)
      ctx.fillText(label, cx, cy)

      // HP rim
      const barW = Math.min(110, (b.localAabb.maxX - b.localAabb.minX) * 0.9)
      const barH = 6
      const bx = cx - barW / 2
      const by = cy + 18
      ctx.fillStyle = 'rgba(15,10,30,0.45)'
      ctx.fillRect(bx, by, barW, barH)
      ctx.fillStyle = `rgba(255,120,210,${0.85})`
      ctx.fillRect(bx, by, barW * hpPct, barH)
    }

    // Slider rail + emitter (at bottom).
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


