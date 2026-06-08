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
// Minimal path sink shared by CanvasRenderingContext2D and Path2D, so the same
// geometry tracer can either draw straight into a context's current path or bake
// a reusable Path2D (built once, then filled/clipped/stroked many times).
type PathSink = Pick<Path2D, 'moveTo' | 'lineTo' | 'arc' | 'closePath'>

const traceRoundedPolyomino = (
  sink: PathSink,
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

  const p0 = pts[0]!
  const p1 = pts[1]!
  const d01 = dir(p0, p1)
  const startCut = isConvex(0) ? r : 0
  const start = { x: p0.x + d01.x * startCut, y: p0.y + d01.y * startCut }
  sink.moveTo(start.x, start.y)

  for (let i = 0; i < m; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const d = dir(a, b)
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const cutB = isConvex(i + 1) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const b2 = { x: b.x - d.x * cutB, y: b.y - d.y * cutB }
    sink.lineTo(b2.x, b2.y)

    if (isConvex(i + 1)) {
      const inD = d
      const outD = dir(b, pts[(i + 2) % m]!)
      const center = {
        x: b.x - inD.x * r + outD.x * r,
        y: b.y - inD.y * r + outD.y * r,
      }
      const startAng = Math.atan2(b.y - inD.y * r - center.y, b.x - inD.x * r - center.x)
      const endAng = Math.atan2(b.y + outD.y * r - center.y, b.x + outD.x * r - center.x)
      sink.arc(center.x, center.y, r, startAng, endAng, false)
    }
  }

  sink.closePath()
}

// Trace the rounded silhouette into the context's current path (caller then
// fills/clips/strokes). Kept for callers that draw the shape exactly once.
export const drawRoundedPolyomino = (
  ctx: CanvasRenderingContext2D,
  loop: Vec2[],
  pos: Vec2,
  cellSize: number,
  rPx: number,
) => {
  if (loop.length < 3) return
  ctx.beginPath()
  traceRoundedPolyomino(ctx, loop, pos, cellSize, rPx)
}

// Bake the rounded silhouette into a reusable Path2D. Building it once and then
// calling ctx.fill(path)/clip(path)/stroke(path) avoids re-tracing the geometry
// (and re-allocating its scratch arrays) for every layer of a single piece.
export const buildRoundedPolyominoPath = (
  loop: Vec2[],
  pos: Vec2,
  cellSize: number,
  rPx: number,
): Path2D | null => {
  if (loop.length < 3) return null
  const path = new Path2D()
  traceRoundedPolyomino(path, loop, pos, cellSize, rPx)
  return path
}

// Sample the rounded polyomino OUTLINE into a closed list of points (local px,
// i.e. cell coords * cellSize). This is the exact silhouette drawRoundedPolyomino
// fills, so the WebGL extrusion can build side walls that line up perfectly under
// the textured top face (no square corners peeking past the rounded art).
export const roundedOutlinePoints = (
  loop: Vec2[],
  cellSize: number,
  rPx: number,
  arcSegs = 4,
): Vec2[] => {
  if (loop.length < 3) return loop.map((p) => ({ x: p.x * cellSize, y: p.y * cellSize }))

  const pts: Vec2[] = loop.map((p) => ({ x: p.x * cellSize, y: p.y * cellSize }))
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
    return cross(dir(prev, cur), dir(cur, next)) > 0.5
  }

  const out: Vec2[] = []
  for (let i = 0; i < m; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const d = dir(a, b)
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const cutB = isConvex(i + 1) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    // Straight run up to where the next corner's fillet begins.
    out.push({ x: b.x - d.x * cutB, y: b.y - d.y * cutB })
    if (isConvex(i + 1)) {
      const inD = d
      const outD = dir(b, pts[(i + 2) % m]!)
      const center = { x: b.x - inD.x * r + outD.x * r, y: b.y - inD.y * r + outD.y * r }
      const a0 = Math.atan2(b.y - inD.y * r - center.y, b.x - inD.x * r - center.x)
      let a1 = Math.atan2(b.y + outD.y * r - center.y, b.x + outD.x * r - center.x)
      // Keep the short (convex) arc direction consistent with the canvas arc.
      while (a1 - a0 > Math.PI) a1 -= Math.PI * 2
      while (a1 - a0 < -Math.PI) a1 += Math.PI * 2
      for (let k = 1; k <= arcSegs; k++) {
        const t = k / arcSegs
        const ang = a0 + (a1 - a0) * t
        out.push({ x: center.x + Math.cos(ang) * r, y: center.y + Math.sin(ang) * r })
      }
    }
  }
  return out
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
    // Armored read = a DARK gunmetal plate bolted across EVERY exposed underside
    // of the piece. The sim deflects any straight-up beam that strikes a downward-
    // facing face (hit.normal.y >= 0.45), which is the bottom edge of every cell
    // that has nothing beneath it — not just the lowest row. So we paint a plate on
    // each such face (merging adjacent cells in a row into one continuous plate),
    // so the armor UI matches exactly what's invulnerable. Dark detailing is the
    // key: additive beam/spark glow and bloom only brighten bright pixels, so a
    // dark plate + recessed bolts stay legible no matter how bright the impact
    // gets, and the bolts (not chevrons) make it clearly "armor", not "fast".
    const flash = Math.min(1, fx.shieldFlashSec / 0.3)
    const plateH = Math.min(cellSize * 0.5, h * 0.92)

    // Cell-space exposed-bottom runs. Cells use an integer grid; a cell's bottom
    // face is exposed when no cell sits directly below it (screen +y = down).
    let cminx = Infinity
    let cminy = Infinity
    const occ = new Set<string>()
    for (const c of cells) {
      occ.add(`${c.x},${c.y}`)
      if (c.x < cminx) cminx = c.x
      if (c.y < cminy) cminy = c.y
    }
    if (!Number.isFinite(cminx)) {
      cminx = 0
      cminy = 0
    }
    const rowToXs = new Map<number, number[]>()
    for (const c of cells) {
      if (occ.has(`${c.x},${c.y + 1}`)) continue
      let xs = rowToXs.get(c.y)
      if (!xs) {
        xs = []
        rowToXs.set(c.y, xs)
      }
      xs.push(c.x)
    }
    // Merge contiguous cells per row into [x0, x1) runs.
    const runs: Array<{ cy: number; x0: number; x1: number }> = []
    for (const [cy, xs] of rowToXs) {
      xs.sort((a, b) => a - b)
      let start = xs[0]!
      let prev = xs[0]!
      for (let i = 1; i < xs.length; i++) {
        if (xs[i] === prev + 1) {
          prev = xs[i]!
        } else {
          runs.push({ cy, x0: start, x1: prev + 1 })
          start = xs[i]!
          prev = xs[i]!
        }
      }
      runs.push({ cy, x0: start, x1: prev + 1 })
    }

    drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
    ctx.save()
    ctx.clip()

    const boltR = Math.max(2.2, Math.min(cellSize * 0.12, 6))
    const gap = Math.max(boltR * 3.4, cellSize * 0.52)

    for (const run of runs) {
      const rx = ax + (run.x0 - cminx) * cellSize
      const rw = (run.x1 - run.x0) * cellSize
      const cellBottom = ay + (run.cy + 1 - cminy) * cellSize
      const plateTop = cellBottom - plateH

      // Solid, near-opaque gunmetal slab (dark -> darker toward the edge).
      ctx.globalCompositeOperation = 'source-over'
      const plate = ctx.createLinearGradient(0, plateTop, 0, cellBottom)
      plate.addColorStop(0, 'rgba(46,54,70,0.97)')
      plate.addColorStop(0.45, 'rgba(28,34,48,0.99)')
      plate.addColorStop(1, 'rgba(13,16,24,1)')
      ctx.fillStyle = plate
      ctx.fillRect(rx - 2, plateTop, rw + 4, plateH + 4)

      // Subtle brushed-metal sheen so the plate still reads as metal, kept low so
      // it never blows out.
      ctx.save()
      ctx.beginPath()
      ctx.rect(rx - 2, plateTop, rw + 4, plateH + 4)
      ctx.clip()
      ctx.globalCompositeOperation = 'screen'
      const sheen = ctx.createLinearGradient(rx, plateTop, rx + rw, plateTop + plateH)
      sheen.addColorStop(0, 'rgba(120,140,170,0)')
      sheen.addColorStop(0.5, 'rgba(120,140,170,0.10)')
      sheen.addColorStop(1, 'rgba(120,140,170,0)')
      ctx.fillStyle = sheen
      ctx.fillRect(rx - 2, plateTop, rw + 4, plateH + 4)
      ctx.restore()

      // Hard armor boundary: a thick DARK divider with a thin metallic lip above.
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(6,8,14,0.95)'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(rx - 2, plateTop)
      ctx.lineTo(rx + rw + 2, plateTop)
      ctx.stroke()
      ctx.strokeStyle = `rgba(${flash > 0 ? '200,230,255' : '150,170,202'},${(0.55 + 0.35 * flash).toFixed(3)})`
      ctx.lineWidth = 1.3
      ctx.beginPath()
      ctx.moveTo(rx - 2, plateTop - 1.4)
      ctx.lineTo(rx + rw + 2, plateTop - 1.4)
      ctx.stroke()

      // Bolt row, inset from the very bottom edge so the grazing reflected beam
      // can't sit on top of them.
      const boltY = plateTop + plateH * 0.46
      ctx.globalCompositeOperation = 'source-over'
      for (let bx = rx + Math.max(boltR * 1.6, gap * 0.5); bx < rx + rw - boltR; bx += gap) {
        // Recessed socket shadow.
        ctx.fillStyle = 'rgba(0,0,0,0.6)'
        ctx.beginPath()
        ctx.arc(bx, boltY + boltR * 0.18, boltR * 1.18, 0, Math.PI * 2)
        ctx.fill()
        // Bolt head.
        const bg = ctx.createRadialGradient(
          bx - boltR * 0.3,
          boltY - boltR * 0.3,
          boltR * 0.2,
          bx,
          boltY,
          boltR,
        )
        bg.addColorStop(0, 'rgba(150,164,190,0.98)')
        bg.addColorStop(1, 'rgba(70,82,104,0.98)')
        ctx.fillStyle = bg
        ctx.beginPath()
        ctx.arc(bx, boltY, boltR, 0, Math.PI * 2)
        ctx.fill()
        // Dark slot across the head.
        ctx.strokeStyle = 'rgba(14,18,28,0.85)'
        ctx.lineWidth = Math.max(1, boltR * 0.32)
        ctx.beginPath()
        ctx.moveTo(bx - boltR * 0.58, boltY)
        ctx.lineTo(bx + boltR * 0.58, boltY)
        ctx.stroke()
      }

      // Deflection flash: an icy wash on the plate while a no-damage hit registers.
      if (flash > 0) {
        ctx.globalCompositeOperation = 'screen'
        ctx.fillStyle = `rgba(150,205,255,${(0.4 * flash).toFixed(3)})`
        ctx.fillRect(rx - 2, plateTop, rw + 4, plateH + 4)
      }
    }

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
    // "Drops far / fast": an embossed downward double-chevron. A dark engraved
    // groove sits under the bright cyan edge, so even when bloom blows out the
    // highlight the chevron shape survives as a crisp dark outline.
    const cxC = ax + w / 2
    const chW = Math.min(w, h) * 0.34
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (let k = 0; k < 2; k++) {
      const yy = ay + h * (0.33 + k * 0.3)
      const stroke = () => {
        ctx.beginPath()
        ctx.moveTo(cxC - chW, yy - chW * 0.5)
        ctx.lineTo(cxC, yy + chW * 0.55)
        ctx.lineTo(cxC + chW, yy - chW * 0.5)
        ctx.stroke()
      }
      // Dark engraved groove (survives bloom).
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(6,18,28,0.82)'
      ctx.lineWidth = Math.max(4.5, chW * 0.5)
      stroke()
      // Bright cyan crest with a soft glow.
      ctx.globalCompositeOperation = 'screen'
      ctx.strokeStyle = 'rgba(150,246,255,0.98)'
      ctx.shadowColor = 'rgba(80,228,255,0.7)'
      ctx.shadowBlur = 7
      ctx.lineWidth = Math.max(2, chW * 0.24)
      stroke()
      ctx.shadowBlur = 0
    }
  } else if (kind === 'shatter') {
    // "Fractures into a cluster": each footprint cell is previewed as a rounded
    // sub-piece outlined by a dark molten crack channel with a hot edge and a
    // glowing core dot. The dark cracks survive bloom; the cell grid + cluster
    // dots read as "this breaks into many pieces" (no chevrons, so it no longer
    // mirrors the fast block).
    const flick = 0.72 + 0.28 * Math.sin(fx.tNow * 9 + fx.blockId)
    drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
    ctx.save()
    ctx.clip()
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = `rgba(255,120,40,${(0.14 + 0.1 * flick).toFixed(3)})`
    ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

    const cs = cellSize
    const inset = Math.max(2.5, cellSize * 0.16)
    const rr = Math.max(2, cellSize * 0.2)
    const subRect = (x: number, y: number, ww: number, hh: number, r: number) => {
      const rad = Math.min(r, ww * 0.5, hh * 0.5)
      ctx.beginPath()
      ctx.moveTo(x + rad, y)
      ctx.arcTo(x + ww, y, x + ww, y + hh, rad)
      ctx.arcTo(x + ww, y + hh, x, y + hh, rad)
      ctx.arcTo(x, y + hh, x, y, rad)
      ctx.arcTo(x, y, x + ww, y, rad)
      ctx.closePath()
    }

    // Bold dark seams along the internal cell boundaries so the 1x1 split is
    // unmistakable (the gap between sub-pieces reads as a deep crack, not body
    // color). Drawn under the hot cell edges, which are inset, so the seam centre
    // stays dark while each cell is framed in molten gold.
    const cellSet = new Set(cells.map((c) => `${c.x},${c.y}`))
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = 'rgba(6,3,0,0.97)'
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(3.5, cellSize * 0.2)
    for (const c of cells) {
      if (cellSet.has(`${c.x + 1},${c.y}`)) {
        const x = ax + (c.x + 1) * cs
        ctx.beginPath()
        ctx.moveTo(x, ay + c.y * cs + inset)
        ctx.lineTo(x, ay + (c.y + 1) * cs - inset)
        ctx.stroke()
      }
      if (cellSet.has(`${c.x},${c.y + 1}`)) {
        const y = ay + (c.y + 1) * cs
        ctx.beginPath()
        ctx.moveTo(ax + c.x * cs + inset, y)
        ctx.lineTo(ax + (c.x + 1) * cs - inset, y)
        ctx.stroke()
      }
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const c of cells) {
      const rx = ax + c.x * cs + inset
      const ry = ay + c.y * cs + inset
      const cw = cs - inset * 2
      const ch = cs - inset * 2
      // Dark crack channel.
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = 'rgba(38,12,2,0.88)'
      ctx.lineWidth = Math.max(3, cellSize * 0.14)
      subRect(rx, ry, cw, ch, rr)
      ctx.stroke()
      // Hot molten edge.
      ctx.globalCompositeOperation = 'screen'
      ctx.strokeStyle = `rgba(255,200,120,${(0.82 + 0.18 * flick).toFixed(3)})`
      ctx.shadowColor = 'rgba(255,140,60,0.9)'
      ctx.shadowBlur = 8
      ctx.lineWidth = Math.max(1.4, cellSize * 0.06)
      subRect(rx, ry, cw, ch, rr)
      ctx.stroke()
      ctx.shadowBlur = 0
      // Cluster-piece core dot.
      const ccx = rx + cw / 2
      const ccy = ry + ch / 2
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = 'rgba(28,9,0,0.7)'
      ctx.beginPath()
      ctx.arc(ccx, ccy, Math.max(1.8, cellSize * 0.1), 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'screen'
      ctx.fillStyle = `rgba(255,184,96,${(0.8 * flick + 0.2).toFixed(3)})`
      ctx.beginPath()
      ctx.arc(ccx, ccy, Math.max(1, cellSize * 0.055), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
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
