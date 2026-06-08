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

export type SwatchKind = 'fast' | 'armored' | 'shatter' | 'gold' | 'mirror' | 'splitter'

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
  kind: 'fast' | 'armored' | 'shatter' | 'gold',
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

  // Gold pieces wear a warm metallic body; everything else uses the standard
  // full-health fill (the routing-kind overlay supplies its glyph on top).
  const fillBase = kind === 'gold' ? 'rgb(240 196 74)' : healthFill(1)
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
  const wallBase = kind === 'armored' ? 'rgb(107 120 145)' : kind === 'gold' ? 'rgb(176 132 36)' : fillBase
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

  // Routing-kind overlay. Gold has no routing glyph (its value is the point);
  // the metallic body alone reads it, so use the no-op 'normal' overlay.
  drawBlockKindOverlay(
    ctx,
    kind === 'gold' ? 'normal' : kind,
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

// Crystalline router — echoes the in-game splitter: a glowing faceted hub with
// tapered crystal prongs pointing the exit directions (radial, never the steel
// mirror wedge).
const drawSplitterSwatch = (ctx: CanvasRenderingContext2D, box: number) => {
  const cx = box * 0.5
  const cy = box * 0.5
  const R = box * 0.2 // hub radius
  const reach = box * 0.42
  const exits = [45, -45]
  const rot = (deg: number) => {
    const rad = (deg * Math.PI) / 180
    return { x: Math.sin(rad), y: -Math.cos(rad) }
  }

  const drawProng = (deg: number, len: number, hw: number, dim: number) => {
    const d = rot(deg)
    const p = { x: -d.y, y: d.x }
    const r0 = R * 0.6
    const wTip = hw * 0.4
    ctx.beginPath()
    ctx.moveTo(cx + d.x * r0 + p.x * hw, cy + d.y * r0 + p.y * hw)
    ctx.lineTo(cx + d.x * len + p.x * wTip, cy + d.y * len + p.y * wTip)
    ctx.lineTo(cx + d.x * len - p.x * wTip, cy + d.y * len - p.y * wTip)
    ctx.lineTo(cx + d.x * r0 - p.x * hw, cy + d.y * r0 - p.y * hw)
    ctx.closePath()
    const grd = ctx.createLinearGradient(cx, cy, cx + d.x * len, cy + d.y * len)
    grd.addColorStop(0, `rgba(120,210,255,${0.7 * dim})`)
    grd.addColorStop(1, `rgba(40,120,180,${0.4 * dim})`)
    ctx.fillStyle = grd
    ctx.fill()
    ctx.strokeStyle = `rgba(220,245,255,${0.6 * dim})`
    ctx.lineWidth = Math.max(1, box * 0.012)
    ctx.stroke()
  }

  for (const deg of exits) drawProng(deg, reach, box * 0.07, 1)
  drawProng(180, R + box * 0.1, box * 0.055, 0.55)

  // Hub octagon body.
  ctx.beginPath()
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (i / 8) * Math.PI * 2
    const x = cx + Math.cos(a) * R
    const y = cy + Math.sin(a) * R
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.closePath()
  const body = ctx.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.1, cx, cy, R)
  body.addColorStop(0, 'rgb(225 248 255)')
  body.addColorStop(0.5, 'rgb(70 160 215)')
  body.addColorStop(1, 'rgb(16 52 86)')
  ctx.fillStyle = body
  ctx.fill()
  ctx.strokeStyle = 'rgba(190,230,255,0.6)'
  ctx.lineWidth = Math.max(1, box * 0.014)
  ctx.stroke()

  // Glowing core.
  ctx.save()
  ctx.globalCompositeOperation = 'screen'
  const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.8)
  core.addColorStop(0, 'rgba(250,254,255,0.95)')
  core.addColorStop(1, 'rgba(120,200,250,0)')
  ctx.fillStyle = core
  ctx.beginPath()
  ctx.arc(cx, cy, R * 0.8, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
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
