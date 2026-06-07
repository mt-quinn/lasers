// Renders a small, static "as it really looks in-game" swatch for the pause
// menu legend. Reuses the exact same drawing primitives as the live renderer
// (pieces.ts) plus the body coloring from draw.ts, so the key never drifts.

import type { Vec2 } from '../game/math'
import {
  drawRoundedPolyomino,
  applyDomedDepth,
  drawBlockKindOverlay,
  drawMirrorShape,
  drawPrismShape,
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

const drawMirrorSwatch = (ctx: CanvasRenderingContext2D, box: number) => {
  const margin = box * 0.18
  const sizePx = box - margin * 2
  drawMirrorShape(ctx, {
    pos: { x: margin, y: margin },
    sizePx,
    orient: -1,
    hp: 1,
    hpMax: 1,
  })
}

const drawSplitterSwatch = (ctx: CanvasRenderingContext2D, box: number) => {
  // Match in-game proportions: r = cellSize * 0.36, drawn centered.
  const cellSize = box * 0.62
  const r = cellSize * 0.5
  const pos: Vec2 = { x: (box - cellSize) / 2, y: (box - cellSize) / 2 }
  drawPrismShape(ctx, { pos, cellSize, r, exitsDeg: [45, -45] })
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
