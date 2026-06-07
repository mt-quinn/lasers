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

// Draw a full-health block body (music-off baseline) then its kind overlay.
const drawBlockSwatch = (
  ctx: CanvasRenderingContext2D,
  kind: 'fast' | 'armored' | 'shatter',
  box: number,
) => {
  // A 2x2 footprint, centered with margin.
  const margin = box * 0.16
  const cellSize = (box - margin * 2) / 2
  const ax = margin
  const ay = margin
  const w = cellSize * 2
  const h = cellSize * 2
  const cornerRadius = cellSize * 0.5 - 0.6
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

  // Body fill.
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  ctx.fillStyle = fillBase
  ctx.fill()

  // Domed depth (clips to the current path).
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  applyDomedDepth(ctx, ax, ay, w, h, 1.0)

  // Player-facing rim light.
  drawRoundedPolyomino(ctx, loop, pos, cellSize, cornerRadius)
  ctx.save()
  ctx.clip()
  ctx.globalCompositeOperation = 'screen'
  const rim = ctx.createLinearGradient(0, ay + h * 0.58, 0, ay + h)
  rim.addColorStop(0, 'rgba(255,255,255,0)')
  rim.addColorStop(1, 'rgba(255,224,255,0.2)')
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
