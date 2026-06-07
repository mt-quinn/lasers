// Renders a small, static "as it really looks in-game" swatch for the pause
// menu legend. Reuses the exact same drawing primitives as the live renderer
// (pieces.ts) plus the body coloring from draw.ts, so the key never drifts.

import type { Vec2 } from '../game/math'
import {
  drawRoundedPolyomino,
  applyDomedDepth,
  drawBlockKindOverlay,
} from './pieces'
import { healthFill, relativeLuma } from './draw'

export type SwatchKind = 'fast' | 'armored' | 'shatter' | 'mirror' | 'splitter'

// Scale an "rgb(r g b)" string toward black by `f` (0..1+). Used to derive the
// extruded side-wall shading from the top fill, matching piecesGL.
const scaleRgb = (cssRgb: string, f: number) => {
  const m = cssRgb.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
  if (!m) return cssRgb
  const r = Math.min(255, Math.round(Number(m[1]) * f))
  const g = Math.min(255, Math.round(Number(m[2]) * f))
  const b = Math.min(255, Math.round(Number(m[3]) * f))
  return `rgb(${r} ${g} ${b})`
}

// Draw a full-health block as the extruded, rounded 3D slab the live WebGL
// renderer now produces: a contact shadow, lit side walls, a glossy top, and the
// kind overlay. Static (music-off baseline) so the key never drifts.
const drawBlockSwatch = (
  ctx: CanvasRenderingContext2D,
  kind: 'fast' | 'armored' | 'shatter',
  box: number,
) => {
  // A 2x2 footprint, centered with margin and lifted a touch to leave room for
  // the extruded walls + shadow below.
  const margin = box * 0.17
  const cellSize = (box - margin * 2) / 2
  const ax = margin
  const ay = margin * 0.82
  const w = cellSize * 2
  const h = cellSize * 2
  const cornerRadius = cellSize * 0.5 - 0.6
  // Extrusion depth for the faux-3D walls.
  const H = cellSize * 0.42
  const pos: Vec2 = { x: ax, y: ay }
  const loop: Vec2[] = [
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 2, y: 2 },
    { x: 0, y: 2 },
  ]
  const cells = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ]

  const fillBase = healthFill(1)
  const lum = relativeLuma(fillBase)

  // Contact shadow on the "floor" so the slab feels placed, not floating.
  ctx.save()
  ctx.filter = 'blur(3px)'
  drawRoundedPolyomino(ctx, loop, { x: ax + 2, y: ay + H + 3 }, cellSize, cornerRadius)
  ctx.fillStyle = 'rgba(0,0,0,0.32)'
  ctx.fill()
  ctx.restore()

  // Side walls: the silhouette extruded straight down by H, filled with a
  // top-bright / base-dark gradient derived from the fill (mirrors piecesGL).
  // Armored pieces use a steel wall so the armored look wraps the bottom/front.
  const wallBase = kind === 'armored' ? 'rgb(107 120 145)' : fillBase
  drawRoundedPolyomino(ctx, loop, { x: ax, y: ay + H }, cellSize, cornerRadius)
  const wall = ctx.createLinearGradient(0, ay, 0, ay + h + H)
  wall.addColorStop(0, scaleRgb(wallBase, 0.82))
  wall.addColorStop(1, scaleRgb(wallBase, 0.4))
  ctx.fillStyle = wall
  ctx.fill()

  // Top face.
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  ctx.fillStyle = fillBase
  ctx.fill()

  // Domed depth (clips to the current path).
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  applyDomedDepth(ctx, ax, ay, w, h, 1.0)

  // Glossy top sheen + player-facing rim light.
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  ctx.save()
  ctx.clip()
  ctx.globalCompositeOperation = 'screen'
  const sheen = ctx.createLinearGradient(ax, ay, ax + w * 0.5, ay + h * 0.5)
  sheen.addColorStop(0, 'rgba(255,255,255,0.32)')
  sheen.addColorStop(0.5, 'rgba(255,255,255,0)')
  ctx.fillStyle = sheen
  ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
  const rim = ctx.createLinearGradient(0, ay + h * 0.58, 0, ay + h)
  rim.addColorStop(0, 'rgba(255,255,255,0)')
  rim.addColorStop(1, 'rgba(255,224,255,0.22)')
  ctx.fillStyle = rim
  ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
  ctx.restore()

  // Outline.
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  ctx.lineWidth = 2
  ctx.strokeStyle = lum > 0.62 ? 'rgba(40,18,60,0.70)' : 'rgba(255,245,220,0.35)'
  ctx.stroke()

  // Routing-kind overlay.
  drawBlockKindOverlay(
    ctx,
    kind,
    { ax, ay, w, h, cellSize, cornerRadius, loop, pos, cells },
    { tNow: 0.6, shieldFlashSec: 0, blockId: 0 },
  )
}

// Faux-3D chrome blade — echoes the GL mirror: a thin double-sided reflector
// standing along the cell diagonal (bounces a beam either way), not a solid
// wedge. Static, music-off baseline so the key never drifts.
const drawMirrorSwatch = (ctx: CanvasRenderingContext2D, box: number) => {
  const cx = box * 0.5
  const cy = box * 0.46
  const H = box * 0.13
  const inv = 1 / Math.SQRT2
  // orient '/': diagonal direction (1,-1), width-perp (1,1).
  const dx = inv
  const dy = -inv
  const nx = inv
  const ny = inv
  const Lh = box * 0.34
  const Wh = box * 0.055
  const corner = (sd: number, sn: number, off: number) => ({
    x: cx + dx * Lh * sd + nx * Wh * sn,
    y: cy + dy * Lh * sd + ny * Wh * sn + off,
  })
  const blade = (off: number) => {
    const p = [corner(1, 1, off), corner(1, -1, off), corner(-1, -1, off), corner(-1, 1, off)]
    ctx.beginPath()
    ctx.moveTo(p[0].x, p[0].y)
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i].x, p[i].y)
    ctx.closePath()
    return p
  }
  // Contact shadow.
  ctx.save()
  ctx.filter = 'blur(3px)'
  blade(H + 3)
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.fill()
  ctx.restore()
  // Extrusion skirt + connecting walls (steel thickness).
  const top = blade(0)
  const bot = blade(H)
  ctx.beginPath()
  for (let i = 0; i < 4; i++) {
    const a = top[i]
    const b = top[(i + 1) % 4]
    const a2 = bot[i]
    const b2 = bot[(i + 1) % 4]
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(b.x, b.y)
    ctx.lineTo(b2.x, b2.y)
    ctx.lineTo(a2.x, a2.y)
    ctx.closePath()
  }
  const skirt = ctx.createLinearGradient(0, cy - Lh, 0, cy + Lh + H)
  skirt.addColorStop(0, 'rgb(96 108 132)')
  skirt.addColorStop(1, 'rgb(40 48 62)')
  ctx.fillStyle = skirt
  ctx.fill()
  // Chrome top face: gradient across the blade width (sky → hot horizon → ground).
  blade(0)
  const chrome = ctx.createLinearGradient(
    cx + nx * Wh,
    cy + ny * Wh,
    cx - nx * Wh,
    cy - ny * Wh,
  )
  chrome.addColorStop(0, 'rgb(150 172 205)')
  chrome.addColorStop(0.45, 'rgb(238 248 255)')
  chrome.addColorStop(0.6, 'rgb(150 176 210)')
  chrome.addColorStop(1, 'rgb(60 78 106)')
  ctx.fillStyle = chrome
  ctx.fill()
  // Bright specular core line running down the blade length.
  ctx.strokeStyle = 'rgba(255,255,255,0.92)'
  ctx.lineWidth = Math.max(1.4, box * 0.024)
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(cx + dx * Lh * 0.9, cy + dy * Lh * 0.9)
  ctx.lineTo(cx - dx * Lh * 0.9, cy - dy * Lh * 0.9)
  ctx.stroke()
}

// Faux-3D faceted crystal — echoes the GL splitter gem (octagonal crown with a
// glowing core and exit arrows on the top facet).
const drawSplitterSwatch = (ctx: CanvasRenderingContext2D, box: number) => {
  const cx = box * 0.5
  const cy = box * 0.46
  const R = box * 0.34
  const H = R * 0.5
  const SIDES = 8
  const a0 = -Math.PI / 2
  const oct = (rad: number, dy: number) => {
    ctx.beginPath()
    for (let i = 0; i < SIDES; i++) {
      const a = a0 + (i / SIDES) * Math.PI * 2
      const x = cx + Math.cos(a) * rad
      const y = cy + Math.sin(a) * rad + dy
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }
  // Contact shadow.
  ctx.save()
  ctx.filter = 'blur(3px)'
  ctx.beginPath()
  ctx.ellipse(cx, cy + H + 3, R, R * 0.55, 0, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0,0,0,0.3)'
  ctx.fill()
  ctx.restore()
  // Pavilion skirt (thickness below the girdle).
  oct(R, H)
  ctx.fillStyle = 'rgb(22 56 92)'
  ctx.fill()
  // Crystal body, deep-blue rim → glassy → darker core (contrast for arrows).
  oct(R, 0)
  const body = ctx.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.05, cx, cy, R)
  body.addColorStop(0, 'rgb(120 185 230)')
  body.addColorStop(0.45, 'rgb(70 140 195)')
  body.addColorStop(0.78, 'rgb(34 86 140)')
  body.addColorStop(1, 'rgb(14 40 72)')
  ctx.fillStyle = body
  ctx.fill()
  // Bright bevel ring delineating the big top face.
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  ctx.lineWidth = Math.max(2, box * 0.04)
  ctx.strokeStyle = 'rgba(150,205,250,0.45)'
  ctx.beginPath()
  ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  ctx.lineWidth = Math.max(1.5, box * 0.018)
  ctx.strokeStyle = 'rgba(10,28,48,0.55)'
  ctx.beginPath()
  ctx.arc(cx, cy, R * 0.82, 0, Math.PI * 2)
  ctx.stroke()
  // Exit arrows on the top facet: bold, high-contrast.
  const exits = [45, -45]
  const rot = (vx: number, vy: number, rad: number) => ({
    x: vx * Math.cos(rad) - vy * Math.sin(rad),
    y: vx * Math.sin(rad) + vy * Math.cos(rad),
  })
  const rayLen = R * 0.72
  const headLen = R * 0.34
  const headAng = Math.PI / 6
  const drawArrows = (style: string, lw: number) => {
    ctx.strokeStyle = style
    ctx.lineWidth = lw
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const deg of exits) {
      const d = rot(0, -1, (deg * Math.PI) / 180)
      const ex = cx + d.x * rayLen
      const ey = cy + d.y * rayLen
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(ex, ey)
      const back = rot(-d.x, -d.y, 0)
      const l = rot(back.x, back.y, headAng)
      const r = rot(back.x, back.y, -headAng)
      ctx.moveTo(ex, ey)
      ctx.lineTo(ex + l.x * headLen, ey + l.y * headLen)
      ctx.moveTo(ex, ey)
      ctx.lineTo(ex + r.x * headLen, ey + r.y * headLen)
      ctx.stroke()
    }
  }
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  drawArrows('rgba(150,210,255,0.5)', Math.max(4, box * 0.1))
  ctx.restore()
  drawArrows('rgba(6,16,30,0.92)', Math.max(3.5, box * 0.075))
  drawArrows('rgba(238,250,255,1)', Math.max(2, box * 0.045))
  // Central hub.
  ctx.beginPath()
  ctx.arc(cx, cy, Math.max(2, box * 0.05), 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(6,16,30,0.92)'
  ctx.fill()
  ctx.beginPath()
  ctx.arc(cx, cy, Math.max(1.4, box * 0.032), 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(245,252,255,1)'
  ctx.fill()
}

// Render a single legend swatch into `canvas`. `box` is the CSS pixel size of
// the (square) canvas; the backing store is scaled for the device pixel ratio.
export const drawPieceSwatch = (canvas: HTMLCanvasElement, kind: SwatchKind, box: number) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  canvas.width = Math.round(box * dpr)
  canvas.height = Math.round(box * dpr)
  canvas.style.width = `${box}px`
  canvas.style.height = `${box}px`

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, box, box)

  if (kind === 'mirror') {
    drawMirrorSwatch(ctx, box)
  } else if (kind === 'splitter') {
    drawSplitterSwatch(ctx, box)
  } else {
    drawBlockSwatch(ctx, kind, box)
  }
}
