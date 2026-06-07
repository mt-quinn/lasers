// Shared piece/feature drawing primitives.
//
// These are the SINGLE source of truth for how blocks (and their routing-kind
// overlays) and board features look. Both the live renderer (draw.ts) and the
// pause-menu legend (swatch.ts) call into them, so the key always shows the
// real in-game appearance — no separate iconography to drift out of sync.

import type { Vec2 } from '../game/math'
import { clamp } from '../game/math'
import type { BlockKind } from '../game/runState'

// Build a rounded-corner path for a polyomino outline (loop in cell units,
// positioned at `pos` world px). Leaves the path on the context (no fill/stroke).
export const drawRoundedPolyomino = (
  ctx: CanvasRenderingContext2D,
  loop: Vec2[],
  pos: Vec2,
  cellSize: number,
  rPx: number,
) => {
  if (loop.length < 3) return

  const pts: Vec2[] = loop.map((p) => ({
    x: pos.x + p.x * cellSize,
    y: pos.y + p.y * cellSize,
  }))

  const first = pts[0]!
  const last = pts[pts.length - 1]!
  if (first.x !== last.x || first.y !== last.y) pts.push({ ...first })

  const n = pts.length
  const m = Math.max(0, n - 1)
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
    const prev = pts[(i - 1 + m) % m]!
    const cur = pts[i % m]!
    const next = pts[(i + 1) % m]!
    const inD = dir(prev, cur)
    const outD = dir(cur, next)
    return cross(inD, outD) > 0.5
  }

  ctx.beginPath()

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

    if (isConvex(i + 1)) {
      const inD = d
      const outD = dir(b, pts[(i + 2) % m]!)
      const center = {
        x: b.x - inD.x * r + outD.x * r,
        y: b.y - inD.y * r + outD.y * r,
      }
      const startAng = Math.atan2(b.y - inD.y * r - center.y, b.x - inD.x * r - center.x)
      const endAng = Math.atan2(b.y + outD.y * r - center.y, b.x + outD.x * r - center.x)
      ctx.arc(center.x, center.y, r, startAng, endAng, false)
    }
  }

  ctx.closePath()
}

// "Pressed pill" depth: clipped highlight/shadow/vignette/sheen on the current
// path's face. Call after the polyomino path is set (it clips to it).
export const applyDomedDepth = (
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  w: number,
  h: number,
  strength: number,
) => {
  const s01 = clamp(strength, 0, 1)
  const r = Math.max(w, h) * 0.95

  ctx.save()
  ctx.clip()

  ctx.globalCompositeOperation = 'screen'
  const hi = ctx.createRadialGradient(ax + w * 0.28, ay + h * 0.22, 0, ax + w * 0.28, ay + h * 0.22, r)
  hi.addColorStop(0, `rgba(255,255,255,${0.34 * s01})`)
  hi.addColorStop(0.35, `rgba(255,255,255,${0.14 * s01})`)
  hi.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = hi
  ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

  ctx.globalCompositeOperation = 'multiply'
  const sh = ctx.createRadialGradient(ax + w * 0.8, ay + h * 0.86, 0, ax + w * 0.8, ay + h * 0.86, r)
  sh.addColorStop(0, `rgba(0,0,0,${0.3 * s01})`)
  sh.addColorStop(0.55, `rgba(0,0,0,${0.1 * s01})`)
  sh.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = sh
  ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

  ctx.globalCompositeOperation = 'multiply'
  const cx = ax + w * 0.5
  const cy = ay + h * 0.5
  const edge = ctx.createRadialGradient(cx, cy, Math.max(4, r * 0.22), cx, cy, r * 0.98)
  edge.addColorStop(0, 'rgba(0,0,0,0)')
  edge.addColorStop(0.72, 'rgba(0,0,0,0)')
  edge.addColorStop(1, `rgba(0,0,0,${0.16 * s01})`)
  ctx.fillStyle = edge
  ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

  ctx.globalCompositeOperation = 'screen'
  const sx = ax + w * 0.3
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

export type BlockGeom = {
  // AABB of the piece in world px.
  ax: number
  ay: number
  w: number
  h: number
  cellSize: number
  cornerRadius: number
  // Outline loop (cell units) + world top-left, for clip paths.
  loop: Vec2[]
  pos: Vec2
  // Footprint cells (cell units), for the shatter fracture grid.
  cells: { x: number; y: number }[]
}

export type BlockFx = {
  tNow: number
  shieldFlashSec: number
  blockId: number
}

// Routing-kind overlay (fast / armored / chrome / shatter) drawn over the
// already-filled body. Mirrors the live renderer exactly so the legend matches.
export const drawBlockKindOverlay = (
  ctx: CanvasRenderingContext2D,
  kind: BlockKind,
  g: BlockGeom,
  fx: BlockFx,
) => {
  const { ax, ay, w, h, cellSize, loop, pos, cornerRadius, cells } = g
  ctx.save()

  if (kind === 'armored') {
    const flash = Math.min(1, fx.shieldFlashSec / 0.3)
    const plateH = Math.min(h * 0.5, cellSize * 0.82)
    const plateTop = ay + h - plateH

    drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
    ctx.save()
    ctx.clip()

    ctx.globalCompositeOperation = 'source-over'
    const plate = ctx.createLinearGradient(0, plateTop, 0, ay + h)
    plate.addColorStop(0, 'rgba(58,68,86,0.86)')
    plate.addColorStop(0.5, 'rgba(36,44,60,0.94)')
    plate.addColorStop(1, 'rgba(20,26,38,0.96)')
    ctx.fillStyle = plate
    ctx.fillRect(ax - 2, plateTop, w + 4, plateH + 4)

    ctx.save()
    ctx.beginPath()
    ctx.rect(ax - 2, plateTop, w + 4, plateH + 4)
    ctx.clip()
    ctx.globalCompositeOperation = 'screen'
    ctx.strokeStyle = 'rgba(150,166,194,0.14)'
    ctx.lineWidth = 2
    for (let x = -plateH; x < w + plateH; x += 10) {
      ctx.beginPath()
      ctx.moveTo(ax + x, plateTop)
      ctx.lineTo(ax + x + plateH, plateTop + plateH)
      ctx.stroke()
    }
    ctx.restore()

    ctx.globalCompositeOperation = 'screen'
    ctx.strokeStyle = `rgba(${flash > 0 ? '190,225,255' : '170,188,214'},${(0.5 + 0.4 * flash).toFixed(3)})`
    ctx.lineWidth = 2 + 2 * flash
    ctx.beginPath()
    ctx.moveTo(ax - 2, plateTop + 1)
    ctx.lineTo(ax + w + 2, plateTop + 1)
    ctx.stroke()

    if (flash > 0) {
      ctx.fillStyle = `rgba(150,205,255,${(0.5 * flash).toFixed(3)})`
      ctx.fillRect(ax - 2, plateTop, w + 4, plateH + 4)
    }

    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = 'rgba(196,208,230,0.55)'
    const rv = 2.2
    const ri = 6
    for (const [rx, ry] of [
      [ax + ri, plateTop + ri],
      [ax + w - ri, plateTop + ri],
    ] as const) {
      ctx.beginPath()
      ctx.arc(rx, ry, rv, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()

    ctx.save()
    ctx.globalCompositeOperation = 'screen'
    ctx.strokeStyle = `rgba(150,205,255,${(0.65 + 0.35 * flash).toFixed(3)})`
    ctx.shadowColor = 'rgba(150,205,255,0.9)'
    ctx.shadowBlur = 5 + 14 * flash
    ctx.lineWidth = 2 + 2 * flash
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const tooth = Math.min(cellSize * 0.34, 12)
    const baseY = ay + h - 3
    const step = tooth * 1.5
    for (let tx = ax + step * 0.5; tx < ax + w - 2; tx += step) {
      ctx.beginPath()
      ctx.moveTo(tx - tooth * 0.5, baseY - tooth * 0.6)
      ctx.lineTo(tx, baseY)
      ctx.lineTo(tx + tooth * 0.5, baseY - tooth * 0.6)
      ctx.stroke()
    }
    ctx.shadowBlur = 0
    ctx.restore()
  } else if (kind === 'chrome') {
    drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
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
  } else if (kind === 'fast') {
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
  } else if (kind === 'shatter') {
    const flick = 0.7 + 0.3 * Math.sin(fx.tNow * 9 + fx.blockId)
    drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
    ctx.save()
    ctx.clip()
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = `rgba(255,120,40,${(0.16 + 0.12 * flick).toFixed(3)})`
    ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
    ctx.strokeStyle = `rgba(255,180,90,${(0.65 + 0.3 * flick).toFixed(3)})`
    ctx.shadowColor = 'rgba(255,140,60,0.85)'
    ctx.shadowBlur = 6
    ctx.lineWidth = 1.6
    const cs = cellSize
    const inset = 1.5
    for (const c of cells) {
      const rx = ax + c.x * cs + inset
      const ry = ay + c.y * cs + inset
      ctx.strokeRect(rx, ry, cs - inset * 2, cs - inset * 2)
    }
    ctx.shadowBlur = 0
    ctx.restore()
    ctx.globalCompositeOperation = 'screen'
    ctx.strokeStyle = 'rgba(255,190,110,0.95)'
    ctx.shadowColor = 'rgba(255,150,70,0.7)'
    ctx.shadowBlur = 7
    ctx.lineWidth = 2.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const sxC = ax + w / 2
    const schW = Math.min(w, h) * 0.26
    for (let k = 0; k < 2; k++) {
      const yy = ay + h * (0.4 + k * 0.24)
      ctx.beginPath()
      ctx.moveTo(sxC - schW, yy - schW * 0.55)
      ctx.lineTo(sxC, yy + schW * 0.55)
      ctx.lineTo(sxC + schW, yy - schW * 0.55)
      ctx.stroke()
    }
    ctx.shadowBlur = 0
  }

  ctx.restore()
}

export type MirrorGeom = {
  pos: Vec2 // top-left of bounding square (world px)
  sizePx: number
  orient: 1 | -1
  hp: number
  hpMax: number
}

// Mirror: glowing chrome diagonal with a specular core + wear cracks.
export const drawMirrorShape = (ctx: CanvasRenderingContext2D, g: MirrorGeom) => {
  const sz = g.sizePx
  let x0: number
  let y0: number
  let x1: number
  let y1: number
  if (g.orient === 1) {
    x0 = g.pos.x
    y0 = g.pos.y
    x1 = g.pos.x + sz
    y1 = g.pos.y + sz
  } else {
    x0 = g.pos.x
    y0 = g.pos.y + sz
    x1 = g.pos.x + sz
    y1 = g.pos.y
  }
  const wear = clamp(1 - g.hp / Math.max(1, g.hpMax), 0, 1)

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'
  ctx.lineCap = 'round'

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

  ctx.shadowBlur = 0
  ctx.globalAlpha = 0.95 - 0.5 * wear
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = 3.2
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x1, y1)
  ctx.stroke()

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
}

export type PrismGeom = {
  pos: Vec2 // top-left (world px)
  cellSize: number
  r: number
  exitsDeg: number[]
}

// Prism (splitter): dark crystal sphere with bright exit-direction arrows.
export const drawPrismShape = (ctx: CanvasRenderingContext2D, g: PrismGeom) => {
  const cx = g.pos.x + g.cellSize * 0.5
  const cy = g.pos.y + g.cellSize * 0.5
  const r = g.r

  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = 'rgba(80,180,255,0.08)'
  ctx.beginPath()
  ctx.arc(cx, cy, r * 2.0, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  ctx.save()
  ctx.globalCompositeOperation = 'source-over'

  const grd = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r)
  grd.addColorStop(0, 'rgba(235,250,255,0.55)')
  grd.addColorStop(0.35, 'rgba(70,140,190,0.45)')
  grd.addColorStop(1, 'rgba(10,25,40,0.55)')
  ctx.fillStyle = grd
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()

  ctx.strokeStyle = 'rgba(255,255,255,0.18)'
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.beginPath()
  ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2)
  ctx.fill()

  const exits: number[] = Array.isArray(g.exitsDeg) ? g.exitsDeg : [45, -45]
  const base = { x: 0, y: -1 }
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const rot = (v: Vec2, rad: number): Vec2 => {
    const c = Math.cos(rad)
    const sn = Math.sin(rad)
    return { x: v.x * c - v.y * sn, y: v.x * sn + v.y * c }
  }
  const rayLen = r * 0.88
  const headLen = r * 0.2
  const headAng = Math.PI / 7

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

  drawGlyphPass('rgba(0,0,0,0.55)', 6)
  drawGlyphPass('rgba(245,255,255,0.92)', 2.8)

  ctx.fillStyle = 'rgba(245,255,255,0.65)'
  ctx.beginPath()
  ctx.arc(cx, cy, Math.max(1.4, r * 0.11), 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}
