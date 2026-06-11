import type { FrameCtx } from '../frame'
import { healthFill, relativeLuma, PIECE_EXTRUDE } from '../frame'
import { clamp } from '../../game/math'
import { PALETTE, gradeHue } from '../theme'
import { renderPiecesGL, type GLPiece } from '../piecesGL'
import { renderFeaturesGL, type GLFeature } from '../featuresGL'
import type { BlockEntity, MirrorFeature, PrismFeature } from '../../game/runState'
import {
  drawRoundedPolyomino,
  buildRoundedPolyominoPath,
  roundedOutlinePoints,
  applyDomedDepth,
  drawBlockKindOverlay,
  drawMirrorShape,
  drawPrismShape,
} from '../pieces'

// Render pieces as extruded 3D solids via WebGL (with a 2D-billboard fallback if
// WebGL is unavailable). Toggle off to compare against the legacy 2D path.
const USE_GL_PIECES = true

// Contact shadows under pieces/features. Even at half resolution the per-frame
// silhouette redraw + Canvas2D blur + upscale composite is a measurable cost, so
// it's the first quality sacrifice when the framerate is tight. Off = no shadows.
const DRAW_CONTACT_SHADOWS = false

// Reusable atlas for the WebGL piece pass: each piece's flat 2D artwork is
// rendered into a packed slot here once per frame, then sampled as a texture on
// its 3D top face.
let pieceAtlas: HTMLCanvasElement | null = null
let pieceAtlasCtx: CanvasRenderingContext2D | null = null
const getPieceAtlas = (w: number, h: number) => {
  if (!pieceAtlas) {
    pieceAtlas = document.createElement('canvas')
    pieceAtlasCtx = pieceAtlas.getContext('2d')
  }
  if (pieceAtlas.width !== w || pieceAtlas.height !== h) {
    pieceAtlas.width = w
    pieceAtlas.height = h
  }
  return pieceAtlasCtx
}

// Reusable atlas for the WebGL feature pass (mirror chrome panels + gem tops).
let featAtlas: HTMLCanvasElement | null = null
let featAtlasCtx: CanvasRenderingContext2D | null = null
const getFeatAtlas = (w: number, h: number) => {
  if (!featAtlas) {
    featAtlas = document.createElement('canvas')
    featAtlasCtx = featAtlas.getContext('2d')
  }
  if (featAtlas.width !== w || featAtlas.height !== h) {
    featAtlas.width = w
    featAtlas.height = h
  }
  return featAtlasCtx
}

// Reusable scratch canvases for the contact-shadow pass. Silhouettes are drawn
// unblurred into A, blurred ONCE into B, then upscaled onto the scene. Both
// scratches live at HALF device resolution: Canvas2D `filter: blur` cost scales
// with the destination area, so blurring at quarter the pixels is ~4× cheaper —
// and a contact shadow is soft enough that the downscale is invisible. (Blurring
// each piece's fill separately, or at full res, is a canvas-filter perf trap.)
const SHADOW_DOWN = 0.5
let shadowA: HTMLCanvasElement | null = null
let shadowACtx: CanvasRenderingContext2D | null = null
let shadowB: HTMLCanvasElement | null = null
let shadowBCtx: CanvasRenderingContext2D | null = null
const getShadowPair = (devW: number, devH: number) => {
  const hw = Math.max(1, Math.ceil(devW * SHADOW_DOWN))
  const hh = Math.max(1, Math.ceil(devH * SHADOW_DOWN))
  if (!shadowA) {
    shadowA = document.createElement('canvas')
    shadowACtx = shadowA.getContext('2d')
    shadowB = document.createElement('canvas')
    shadowBCtx = shadowB.getContext('2d')
  }
  if (shadowA.width !== hw || shadowA.height !== hh) {
    shadowA.width = hw
    shadowA.height = hh
    shadowB!.width = hw
    shadowB!.height = hh
  }
  return { ca: shadowA, actx: shadowACtx, cb: shadowB!, bctx: shadowBCtx, hw, hh, scale: SHADOW_DOWN }
}

// Cache of each block's inset wall outline in LOCAL (untranslated) coords. The
// silhouette only depends on the piece's fixed shape (loop/cellSize/cornerRadius),
// so it's computed once per block and merely re-translated each frame — skipping
// the per-vertex arc sampling + centroid + inset math the GL wall pass would
// otherwise redo every frame. Keyed weakly so it's freed when a block is dropped.
const blockOutlineCache = new WeakMap<
  BlockEntity,
  { sig: string; local: { x: number; y: number }[] }
>()
export const drawPiecesPass = (c: FrameCtx) => {
  const { ctx, s, proj, project, mi, mBass, mPulse, mEnergy, tNow, hsl, hueAt, heat } = c
    // Discrete danger tiers for the drain-gauge overlay. The intact silhouette
    // proportion carries the fine health read; the tier color makes the
    // dangerous states pop even on a tiny, far-away piece (color/brightness
    // survive distance where a saturation gradient can't). FULL/HEALTHY keep the
    // native body color; HURT/CRITICAL wash the intact region amber/red.
    const critPulse = 0.5 + 0.5 * Math.sin(tNow * 7)
    const healthTier = (hpPct: number): { washFill: string; lineStroke: string; lineGlow: number } => {
      if (hpPct > 0.66) return { washFill: '', lineStroke: '', lineGlow: 0 }
      if (hpPct > 0.4) return { washFill: '', lineStroke: 'rgba(170,232,250,0.85)', lineGlow: 6 }
      if (hpPct > 0.18)
        return { washFill: 'rgba(255,176,64,0.34)', lineStroke: 'rgba(255,196,92,0.95)', lineGlow: 9 }
      return {
        washFill: `rgba(255,72,52,${(0.45 + 0.18 * critPulse).toFixed(3)})`,
        lineStroke: 'rgba(255,120,90,1)',
        lineGlow: 12 + 8 * critPulse,
      }
    }

    // Draw a piece's full flat face (body fill + domed depth + rim + outline +
    // routing-kind overlay + HP drain gauge) at world top-left (posX,posY) with
    // NO perspective applied. `hueCx/hueCy` is the world-space center used to key
    // the rainbow hue (kept separate from the draw anchor so an off-screen atlas
    // render still matches the piece's in-scene color). Single source of truth,
    // shared by the live 2D path and the WebGL atlas.
    const drawPieceBody = (
      ctx: CanvasRenderingContext2D,
      b: BlockEntity,
      posX: number,
      posY: number,
      hueCx: number,
      hueCy: number,
    ) => {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const pos = { x: posX, y: posY }
      // Bake the silhouette once and reuse it for the rim/speckle clips and the
      // outline stroke below (instead of re-tracing the polyomino each time).
      const shapePath = buildRoundedPolyominoPath(b.loop, pos, b.cellSize, b.cornerRadius)
      const pieceHue = hueAt(hueCx, hueCy)
      let fillBase: string
      let lum: number
      if (b.isGold) {
        // Valuable = the one WARM piece (reward lives on the energy axis). Molten
        // gold gem, distinct from cold matter by temperature.
        fillBase = PALETTE.valuableBody
        lum = relativeLuma(fillBase)
      } else if (mi > 0) {
        // Graded music-reactive identity color (color-graded rainbow, not raw HSL).
        const mc = gradeHue(pieceHue)
        fillBase = `rgb(${mc.r} ${mc.g} ${mc.b})`
        lum = (0.2126 * mc.r + 0.7152 * mc.g + 0.0722 * mc.b) / 255
      } else {
        fillBase = healthFill(1)
        lum = relativeLuma(fillBase)
      }

      // Per-piece glow disabled for performance: a Canvas2D shadowBlur on every
      // piece every frame (baked + uploaded) was the dominant per-piece cost and
      // scaled badly as pieces filled the screen. Removing it also lets the atlas
      // tile margin shrink (smaller texture upload). Pieces keep their depth from
      // the 3D extruded walls + rim light + domed shading.
      ctx.shadowBlur = 0

      drawRoundedPolyomino(ctx, b.loop, pos, b.cellSize, b.cornerRadius)
      ctx.fillStyle = fillBase
      ctx.fill()

      const ax = pos.x + b.localAabb.minX
      const ay = pos.y + b.localAabb.minY
      const w = b.localAabb.maxX - b.localAabb.minX
      const h = b.localAabb.maxY - b.localAabb.minY

      applyDomedDepth(ctx, ax, ay, w, h, 1.0)
      if (b.isGold) {
        ctx.save()
        ctx.clip()
        ctx.globalCompositeOperation = 'screen'
        // Animated specular band sweeping diagonally across the gem so the
        // valuable piece glints and reads as molten metal, not a flat tile.
        const sweep = ((tNow * 0.33 + (b.id % 7) * 0.13) % 1)
        const g0x = ax - w
        const g1x = ax + w * 2
        const shine = ctx.createLinearGradient(g0x, ay - h, g1x, ay + h * 2)
        const lo = Math.max(0.0001, sweep - 0.16)
        const hi = Math.min(0.9999, sweep + 0.16)
        shine.addColorStop(0, 'rgba(255,240,190,0)')
        shine.addColorStop(lo, 'rgba(255,240,190,0)')
        shine.addColorStop(clamp(sweep, lo, hi), 'rgba(255,250,214,0.6)')
        shine.addColorStop(hi, 'rgba(255,240,190,0)')
        shine.addColorStop(1, 'rgba(255,240,190,0)')
        ctx.fillStyle = shine
        ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
        ctx.restore()
      }

      // Player-facing rim light (clipped to the piece shape).
      ctx.save()
      if (shapePath) ctx.clip(shapePath)
      ctx.globalCompositeOperation = 'screen'
      const rim = ctx.createLinearGradient(0, ay + h * 0.58, 0, ay + h)
      rim.addColorStop(0, 'rgba(255,255,255,0)')
      rim.addColorStop(1, mi > 0 ? hsl(pieceHue, 85, 82, 0.24) : 'rgba(200,235,250,0.2)')
      ctx.fillStyle = rim
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)
      ctx.restore()

      // Mineral speckle removed for performance: ~20+ per-piece arc fills every
      // frame (baked + uploaded) for a texture that read as near-invisible.

      ctx.lineWidth = 2
      if (b.isGold) {
        ctx.strokeStyle = 'rgba(184,134,11,0.85)'
      } else {
        ctx.strokeStyle = lum > 0.62 ? 'rgba(40,18,60,0.70)' : 'rgba(255,245,220,0.35)'
      }
      if (shapePath) ctx.stroke(shapePath)

      if (!b.isGold && b.kind !== 'normal') {
        drawBlockKindOverlay(
          ctx,
          b.kind,
          {
            ax,
            ay,
            w,
            h,
            cellSize: b.cellSize,
            cornerRadius: b.cornerRadius,
            loop: b.loop,
            pos,
            cells: b.cells,
          },
          { tNow, shieldFlashSec: b.shieldFlashSec, blockId: b.id },
        )
      }

      // --- Health drain gauge (single source of the HP read) ---------------
      if (hpPct < 0.999) {
        const gax = ax
        const gay = ay
        const gw = w
        const gh = h
        const tier = healthTier(hpPct)
        const vnx = 0
        const vny = b.kind === 'armored' ? -1 : 1
        const x0 = gax - 2
        const y0 = gay - 2
        const x1 = gax + gw + 2
        const y1 = gay + gh + 2
        let hollow: { x: number; y: number; w: number; h: number }
        let intact: { x: number; y: number; w: number; h: number }
        let cutAx: number
        let cutAy: number
        let cutBx: number
        let cutBy: number
        if (vnx < 0) {
          const xc = gax + gw * (1 - hpPct)
          hollow = { x: x0, y: y0, w: xc - x0, h: y1 - y0 }
          intact = { x: xc, y: y0, w: x1 - xc, h: y1 - y0 }
          cutAx = xc
          cutAy = y0
          cutBx = xc
          cutBy = y1
        } else if (vnx > 0) {
          const xc = gax + gw * hpPct
          hollow = { x: xc, y: y0, w: x1 - xc, h: y1 - y0 }
          intact = { x: x0, y: y0, w: xc - x0, h: y1 - y0 }
          cutAx = xc
          cutAy = y0
          cutBx = xc
          cutBy = y1
        } else if (vny < 0) {
          const yc = gay + gh * (1 - hpPct)
          hollow = { x: x0, y: y0, w: x1 - x0, h: yc - y0 }
          intact = { x: x0, y: yc, w: x1 - x0, h: y1 - yc }
          cutAx = x0
          cutAy = yc
          cutBx = x1
          cutBy = yc
        } else {
          const yc = gay + gh * hpPct
          hollow = { x: x0, y: yc, w: x1 - x0, h: y1 - yc }
          intact = { x: x0, y: y0, w: x1 - x0, h: yc - y0 }
          cutAx = x0
          cutAy = yc
          cutBx = x1
          cutBy = yc
        }

        drawRoundedPolyomino(ctx, b.loop, pos, b.cellSize, b.cornerRadius)
        ctx.save()
        ctx.clip()
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = 'rgba(6,5,12,0.62)'
        ctx.fillRect(hollow.x, hollow.y, hollow.w, hollow.h)
        if (tier.washFill) {
          ctx.fillStyle = tier.washFill
          ctx.fillRect(intact.x, intact.y, intact.w, intact.h)
        }
        if (tier.lineStroke) {
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = tier.lineStroke
          ctx.shadowColor = tier.lineStroke
          ctx.shadowBlur = tier.lineGlow
          ctx.lineWidth = 2.5
          ctx.beginPath()
          ctx.moveTo(cutAx, cutAy)
          ctx.lineTo(cutBx, cutBy)
          ctx.stroke()
          ctx.shadowBlur = 0
        }
        ctx.restore()
      }

      // Welding hot-spot: the beam contact point glows and grows on the affected
      // piece. Baked into the body (clipped to the shape) so it rides the 3D top
      // face in the GL pass exactly aligned with the art.
      // World hit point -> atlas-local via the block origin.
      for (const wg of s.weldGlows) {
        if (wg.blockId !== b.id) continue
        const wt = clamp(wg.age / Math.max(0.0001, wg.life), 0, 1)
        const wa = (1 - wt) * (0.35 + 0.55 * wg.intensity)
        if (wa <= 0) continue
        const lx = posX + (wg.x - b.pos.x)
        const ly = posY + (wg.y - b.pos.y)
        const gHue = hueAt(wg.x, wg.y)
        const r0 = 1.5 + 2.2 * wg.intensity
        const rInside = (9 + 13 * wg.intensity) * (wg.bloom || 1)
        ctx.save()
        drawRoundedPolyomino(ctx, b.loop, pos, b.cellSize, b.cornerRadius)
        ctx.clip()
        ctx.globalCompositeOperation = 'lighter'
        const wgGrad = ctx.createRadialGradient(lx, ly, r0, lx, ly, rInside)
        wgGrad.addColorStop(0, `rgba(255,255,255,${0.95 * wa})`)
        wgGrad.addColorStop(0.22, heat(gHue, 255, 210, 120, 80, 70, 0.78 * wa))
        wgGrad.addColorStop(0.55, heat(gHue, 255, 120, 40, 85, 58, 0.55 * wa))
        wgGrad.addColorStop(0.9, heat(gHue, 255, 45, 25, 88, 48, 0.28 * wa))
        wgGrad.addColorStop(1, heat(gHue, 255, 35, 25, 88, 45, 0))
        ctx.fillStyle = wgGrad
        ctx.beginPath()
        ctx.arc(lx, ly, rInside, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }

    // Blocks (base render; the drain-gauge HP overlay is drawn per piece below).
    // Depth-sort far -> near so nearer (lower) pieces overlap farther ones.
    const sortedBlocks = [...s.blocks].sort((a, b) => a.pos.y - b.pos.y)

    // Identity color (0..1) for a piece, mirroring drawPieceBody's fillBase.
    const parseRgbStr = (str: string) => {
      const m = str.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
      return m ? { r: +m[1]!, g: +m[2]!, b: +m[3]! } : { r: 255, g: 255, b: 255 }
    }
    const glPieceColor = (b: BlockEntity, hx: number, hy: number) => {
      if (b.isGold) return { r: 245 / 255, g: 194 / 255, b: 74 / 255 }
      // Armored pieces have an invulnerable reflective underside; render the side
      // walls (the bottom/front face the player sees) as steel so the armored
      // look wraps down the body instead of stopping at the top plate.
      if (b.kind === 'armored') return { r: 0.42, g: 0.47, b: 0.57 }
      if (mi > 0) {
        const c = gradeHue(hueAt(hx, hy))
        return { r: c.r / 255, g: c.g / 255, b: c.b / 255 }
      }
      const c = parseRgbStr(healthFill(1))
      return { r: c.r / 255, g: c.g / 255, b: c.b / 255 }
    }

    // WebGL 3D pieces: render each piece's flat 2D art into a packed atlas, then
    // map it onto an extruded, depth-sorted 3D solid. Falls back to the 2D
    // billboard loop below if WebGL is unavailable.
    const renderBlocksGL = (blocks: BlockEntity[]): boolean => {
      const scale = Math.min(2, Math.max(1, s.view.dpr))
      const M = 4 // tile margin around each piece (world px). Was 22 for the piece
      // glow; with the glow removed only a few px are needed for the 2px outline
      // stroke + bilinear edge, which shrinks every atlas tile and its upload.
      const SEP = 2 // atlas px gap so neighbours don't bleed under bilinear
      const AW_MAX = 2048
      type Slot = {
        b: BlockEntity
        bcx: number
        bcy: number
        sx: number
        sy: number
        sw: number
        sh: number
        minX: number
        minY: number
        cw: number
        ch: number
      }
      const slots: Slot[] = []
      let curX = SEP
      let curY = SEP
      let rowH = 0
      let atlasW = 1
      for (const b of blocks) {
        const visualY = b.pos.y - s.dropAnimOffset - b.dropAnimExtra
        const minX = b.localAabb.minX
        const minY = b.localAabb.minY
        const w = b.localAabb.maxX - minX
        const h = b.localAabb.maxY - minY
        const cw = w + 2 * M
        const ch = h + 2 * M
        const sw = Math.ceil(cw * scale)
        const sh = Math.ceil(ch * scale)
        if (curX + sw + SEP > AW_MAX) {
          curX = SEP
          curY += rowH + SEP
          rowH = 0
        }
        const bcx = b.pos.x + (minX + b.localAabb.maxX) * 0.5
        const bcy = visualY + (minY + b.localAabb.maxY) * 0.5
        slots.push({ b, bcx, bcy, sx: curX, sy: curY, sw, sh, minX, minY, cw, ch })
        curX += sw + SEP
        rowH = Math.max(rowH, sh)
        atlasW = Math.max(atlasW, curX)
      }
      const atlasH = curY + rowH + SEP
      const actx = getPieceAtlas(atlasW, atlasH)
      if (!actx || !pieceAtlas) return false
      actx.setTransform(1, 0, 0, 1, 0, 0)
      actx.clearRect(0, 0, atlasW, atlasH)

      const glPieces: GLPiece[] = []
      for (const sl of slots) {
        const { b, bcx, bcy } = sl
        actx.save()
        actx.setTransform(scale, 0, 0, scale, sl.sx, sl.sy)
        drawPieceBody(actx, b, M - sl.minX, M - sl.minY, bcx, bcy)
        actx.restore()

        const visualX = b.pos.x
        const visualY = b.pos.y - s.dropAnimOffset - b.dropAnimExtra
        const col = glPieceColor(b, bcx, bcy)
        // Walls follow the rounded silhouette (matching the top art), nudged
        // slightly inward toward the piece center so they tuck under the top face
        // instead of poking out past the rounded corners.
        const sig = `${b.cellSize}|${b.cornerRadius}|${b.loop.length}`
        let cached = blockOutlineCache.get(b)
        if (!cached || cached.sig !== sig) {
          const outline = roundedOutlinePoints(b.loop, b.cellSize, b.cornerRadius)
          let ocx = 0
          let ocy = 0
          for (const p of outline) {
            ocx += p.x
            ocy += p.y
          }
          ocx /= outline.length || 1
          ocy /= outline.length || 1
          const INSET = 1.5
          const local = outline.map((p) => {
            const dx = ocx - p.x
            const dy = ocy - p.y
            const dl = Math.hypot(dx, dy) || 1
            return { x: p.x + (dx / dl) * INSET, y: p.y + (dy / dl) * INSET }
          })
          cached = { sig, local }
          blockOutlineCache.set(b, cached)
        }
        const localPts = cached.local
        const loop: { x: number; y: number }[] = new Array(localPts.length)
        for (let i = 0; i < localPts.length; i++) {
          loop[i] = { x: visualX + localPts[i]!.x, y: visualY + localPts[i]!.y }
        }
        glPieces.push({
          loop,
          qx: visualX + sl.minX - M,
          qy: visualY + sl.minY - M,
          qw: sl.cw,
          qh: sl.ch,
          u0: sl.sx / atlasW,
          v0: sl.sy / atlasH,
          u1: (sl.sx + sl.sw) / atlasW,
          v1: (sl.sy + sl.sh) / atlasH,
          cr: col.r,
          cg: col.g,
          cb: col.b,
          height: b.cellSize * PIECE_EXTRUDE,
        })
      }

      // Contact shadows on the grid (drawn before the GL pieces composite over
      // them) so the slabs feel placed in the field rather than floating. Drawn
      // unblurred into a scratch canvas, then composited with ONE blur pass.
      const sdpr = s.view.dpr
      const shadow = DRAW_CONTACT_SHADOWS
        ? getShadowPair(ctx.canvas.width, ctx.canvas.height)
        : null
      if (shadow && shadow.actx && shadow.bctx) {
        const sactx = shadow.actx
        const sbctx = shadow.bctx
        sactx.setTransform(sdpr * shadow.scale, 0, 0, sdpr * shadow.scale, 0, 0)
        sactx.clearRect(0, 0, s.view.width, s.view.height)
        sactx.fillStyle = 'rgba(0,0,0,0.34)'
        for (const sl of slots) {
          const b = sl.b
          const visualX = b.pos.x
          const visualY = b.pos.y - s.dropAnimOffset - b.dropAnimExtra
          const pc = project(sl.bcx, sl.bcy)
          sactx.save()
          sactx.translate(pc.x + 5 * pc.scale, pc.y + 9 * pc.scale)
          sactx.scale(pc.scale, pc.scale)
          sactx.translate(-sl.bcx, -sl.bcy)
          drawRoundedPolyomino(sactx, b.loop, { x: visualX, y: visualY }, b.cellSize, b.cornerRadius)
          sactx.fill()
          sactx.restore()
        }
        // Single blur pass at half resolution, then a cheap (filter-free) upscale.
        sbctx.setTransform(1, 0, 0, 1, 0, 0)
        sbctx.clearRect(0, 0, shadow.hw, shadow.hh)
        sbctx.filter = `blur(${(4 * sdpr * shadow.scale).toFixed(2)}px)`
        sbctx.drawImage(shadow.ca, 0, 0)
        sbctx.filter = 'none'
        ctx.save()
        ctx.setTransform(1, 0, 0, 1, 0, 0)
        ctx.globalCompositeOperation = 'source-over'
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = 'low'
        ctx.drawImage(shadow.cb, 0, 0, shadow.hw, shadow.hh, 0, 0, ctx.canvas.width, ctx.canvas.height)
        ctx.restore()
      }

      const out = renderPiecesGL(
        pieceAtlas,
        glPieces,
        {
          cx: proj.cx,
          strength: proj.strength,
          nearWorldY: proj.nearWorldY,
          horizonY: proj.horizonY,
          span: proj.span,
          pMin: proj.pMin,
          pMax: proj.pMax,
        },
        s.view.width,
        s.view.height,
        s.view.dpr,
      )
      if (!out) return false
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.globalAlpha = 1
      ctx.drawImage(out, 0, 0, s.view.width, s.view.height)
      ctx.restore()
      return true
    }

    const glPiecesDrawn =
      USE_GL_PIECES && sortedBlocks.length > 0 ? renderBlocksGL(sortedBlocks) : false

    for (const b of glPiecesDrawn ? [] : sortedBlocks) {
      // Apply smooth drop animation offset (plus the per-block extra so fast
      // double-steppers ease instead of snapping).
      const visualPos = { x: b.pos.x, y: b.pos.y - s.dropAnimOffset - b.dropAnimExtra }

      ctx.save()
      ctx.globalCompositeOperation = 'source-over'

      // Music: gentle, smooth breathing — envelope-driven (never beat-flashed),
      // with a slow per-piece phase so the board sways like a field, not a strobe.
      const bcx = visualPos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
      const bcy = visualPos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
      const sway = 0.5 + 0.5 * Math.sin(tNow * 2.1 - bcy * 0.01)
      const blockScale = 1 + mPulse * 0.05 * sway + mBass * 0.02
      // Perspective: place the piece at its projected center and scale it by its
      // depth (per-piece uniform scaling preserves all the polish below). The
      // music breathing folds into the same transform.
      {
        const pc = project(bcx, bcy)
        const totalScale = pc.scale * blockScale
        ctx.translate(pc.x, pc.y)
        ctx.scale(totalScale, totalScale)
        ctx.translate(-bcx, -bcy)
      }

      // All the per-piece polish (identity fill, domed depth, rim, outline,
      // routing-kind overlay, HP drain gauge) lives in drawPieceBody, shared with
      // the WebGL atlas so the 3D pieces sample the exact same artwork.
      drawPieceBody(ctx, b, visualPos.x, visualPos.y, bcx, bcy)
      ctx.restore()
    }

    // Piece-dissolve flashes: the dead block's silhouette pops outward and fades
    // as its motes burst, so the piece reads as breaking into energy instead of
    // blinking out. Cheap: one additive fill + rim per dying piece for ~0.18s.
    if (s.pieceBursts.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const fx of s.pieceBursts) {
        const p = clamp(fx.t / Math.max(0.0001, fx.dur), 0, 1)
        const ease = 1 - (1 - p) * (1 - p) // ease-out
        const ax0 = fx.pos.x + fx.localAabb.minX
        const ay0 = fx.pos.y + fx.localAabb.minY
        const w0 = fx.localAabb.maxX - fx.localAabb.minX
        const h0 = fx.localAabb.maxY - fx.localAabb.minY
        const cx0 = ax0 + w0 * 0.5
        const cy0 = ay0 + h0 * 0.5
        const mp = project(cx0, cy0)
        const burstScale = mp.scale * (1 + 0.28 * ease)
        const alpha = 1 - ease // fade out
        const burstHue = fx.isGold ? 44 : hueAt(cx0, cy0)

        ctx.save()
        ctx.translate(mp.x, mp.y)
        ctx.scale(burstScale, burstScale)
        ctx.translate(-cx0, -cy0)

        // Colored energy body, brightest at the instant of death.
        drawRoundedPolyomino(ctx, fx.loop, fx.pos, fx.cellSize, fx.cornerRadius)
        ctx.fillStyle = hsl(burstHue, 100, 68, 0.5 * alpha)
        ctx.fill()
        // White-hot core that decays faster than the body, so the flash "cools".
        ctx.fillStyle = `rgba(255,255,255,${(0.55 * alpha * (1 - ease)).toFixed(3)})`
        ctx.fill()
        // Expanding rim that keeps a constant on-screen weight as it scales up.
        drawRoundedPolyomino(ctx, fx.loop, fx.pos, fx.cellSize, fx.cornerRadius)
        ctx.lineWidth = 2 / burstScale
        ctx.strokeStyle = hsl(burstHue, 100, 82, 0.8 * alpha)
        ctx.stroke()
        ctx.restore()
      }
      ctx.restore()
    }

    // Board features: mirrors (destructible diagonal deflectors) / prisms / black holes.
    // Mirrors + splitters render as 3D solids in a single GL pass (matching the
    // block slabs); the black hole stays 2D. `glFeaturesDrawn` gates the 2D
    // fallback shapes in the loop below.
    let glFeaturesDrawn = false
    if (USE_GL_PIECES && s.features.length > 0) {
      // Chrome panel for a mirror's diagonal face (u along the edge, v top→down).
      const bakeMirrorPanel = (
        c: CanvasRenderingContext2D,
        w: number,
        h: number,
        hp: number,
        hpMax: number,
      ) => {
        c.clearRect(0, 0, w, h)
        // Chrome: light "sky" up top, a hot horizon band, dark "ground" below.
        const g = c.createLinearGradient(0, 0, 0, h)
        g.addColorStop(0, 'rgb(150,172,205)')
        g.addColorStop(0.34, 'rgb(206,224,248)')
        g.addColorStop(0.5, 'rgb(248,253,255)')
        g.addColorStop(0.62, 'rgb(150,176,210)')
        g.addColorStop(1, 'rgb(54,70,98)')
        c.fillStyle = g
        c.fillRect(0, 0, w, h)
        // Offset specular hotspot (light from upper-left).
        c.globalCompositeOperation = 'lighter'
        const hs = c.createRadialGradient(w * 0.34, h * 0.42, 1, w * 0.34, h * 0.42, h * 0.85)
        hs.addColorStop(0, 'rgba(255,255,255,0.85)')
        hs.addColorStop(0.4, 'rgba(210,235,255,0.3)')
        hs.addColorStop(1, 'rgba(210,235,255,0)')
        c.fillStyle = hs
        c.fillRect(0, 0, w, h)
        // Faint cool environment tint streak.
        const en = c.createLinearGradient(0, 0, w, h)
        en.addColorStop(0, 'rgba(120,200,255,0.0)')
        en.addColorStop(0.5, 'rgba(150,215,255,0.16)')
        en.addColorStop(1, 'rgba(120,200,255,0.0)')
        c.fillStyle = en
        c.fillRect(0, 0, w, h)
        c.globalCompositeOperation = 'source-over'
        // Bright top lip.
        c.fillStyle = 'rgba(255,255,255,0.55)'
        c.fillRect(0, 0, w, Math.max(1, h * 0.04))
        // Wear cracks burn in as the mirror takes damage.
        const wear = clamp(1 - hp / Math.max(1, hpMax), 0, 1)
        if (wear > 0.12) {
          c.strokeStyle = `rgba(12,8,14,${(0.5 * wear).toFixed(3)})`
          c.lineWidth = Math.max(1, h * 0.02)
          c.lineCap = 'round'
          const cracks = 2 + Math.round(wear * 3)
          for (let i = 0; i < cracks; i++) {
            const fx = (i + 0.5) / cracks
            const x = fx * w
            c.beginPath()
            c.moveTo(x, h * (0.2 + 0.1 * i))
            c.lineTo(x + (i % 2 ? 1 : -1) * w * 0.05, h * (0.7 - 0.05 * i))
            c.stroke()
          }
        }
      }

      // Splitter HUB top facet: a glowing crystalline core. Direction is carried
      // by the 3D prongs now, so this stays a clean luminous gem (faceted bevel +
      // hot core), tinted to the music hue.
      const bakeSplitterTop = (c: CanvasRenderingContext2D, size: number, hue: number) => {
        c.clearRect(0, 0, size, size)
        const cx = size / 2
        const cy = size / 2
        const R = size / 2
        // Glassy crystal body.
        const body = c.createRadialGradient(cx - R * 0.22, cy - R * 0.22, R * 0.04, cx, cy, R)
        body.addColorStop(0, heat(hue, 150, 210, 245, 85, 70, 0.98))
        body.addColorStop(0.5, heat(hue, 70, 150, 205, 80, 52, 0.96))
        body.addColorStop(0.82, 'rgba(30,80,135,0.96)')
        body.addColorStop(1, 'rgba(12,36,66,0.96)')
        c.fillStyle = body
        c.beginPath()
        c.arc(cx, cy, R * 0.98, 0, Math.PI * 2)
        c.fill()
        // Faceted octagon bevel so the hub reads as a cut crystal, not a sphere.
        c.globalCompositeOperation = 'screen'
        c.lineWidth = Math.max(1.5, size * 0.04)
        c.strokeStyle = 'rgba(170,220,255,0.5)'
        c.beginPath()
        for (let i = 0; i < 8; i++) {
          const a = -Math.PI / 2 + (i / 8) * Math.PI * 2
          const x = cx + Math.cos(a) * R * 0.82
          const y = cy + Math.sin(a) * R * 0.82
          if (i === 0) c.moveTo(x, y)
          else c.lineTo(x, y)
        }
        c.closePath()
        c.stroke()
        // Hot core the beam erupts from.
        const core = c.createRadialGradient(cx, cy, 0, cx, cy, R * 0.42)
        core.addColorStop(0, 'rgba(250,254,255,1)')
        core.addColorStop(0.5, heat(hue, 200, 235, 255, 90, 78, 0.9))
        core.addColorStop(1, heat(hue, 120, 190, 240, 85, 60, 0))
        c.fillStyle = core
        c.beginPath()
        c.arc(cx, cy, R * 0.42, 0, Math.PI * 2)
        c.fill()
        c.globalCompositeOperation = 'source-over'
      }

      const fscale = Math.min(2, Math.max(1, s.view.dpr))
      const FSEP = 2
      type FSlot =
        | { kind: 'mirror'; f: MirrorFeature; sx: number; sy: number; sw: number; sh: number }
        | { kind: 'splitter'; f: PrismFeature; sx: number; sy: number; sw: number; sh: number }
      const fslots: FSlot[] = []
      let fx = FSEP
      let frowH = 0
      let fatlasW = 1
      const place = (sw: number, sh: number) => {
        if (fx + sw + FSEP > 2048) {
          fx = FSEP
          fatlasW = Math.max(fatlasW, fx)
        }
        const slot = { sx: fx, sy: FSEP, sw, sh }
        fx += sw + FSEP
        frowH = Math.max(frowH, sh)
        fatlasW = Math.max(fatlasW, fx)
        return slot
      }
      for (const f of s.features) {
        if (f.kind === 'mirror') {
          const w = Math.max(8, Math.round(f.sizePx * 1.42 * fscale))
          const h = Math.max(8, Math.round(f.sizePx * 0.78 * fscale))
          const p = place(w, h)
          fslots.push({ kind: 'mirror', f, ...p })
        } else if (f.kind === 'prism') {
          // Only the hub needs a baked texture; prongs are untextured 3D.
          const sz = Math.max(8, Math.round(f.r * 2.0 * fscale))
          const p = place(sz, sz)
          fslots.push({ kind: 'splitter', f, ...p })
        }
      }
      if (fslots.length > 0) {
        const fatlasH = FSEP + frowH + FSEP
        const fac = getFeatAtlas(fatlasW, fatlasH)
        if (fac && featAtlas) {
          fac.setTransform(1, 0, 0, 1, 0, 0)
          fac.clearRect(0, 0, fatlasW, fatlasH)
          const glFeatures: GLFeature[] = []
          for (const sl of fslots) {
            fac.save()
            fac.beginPath()
            fac.rect(sl.sx, sl.sy, sl.sw, sl.sh)
            fac.clip()
            fac.translate(sl.sx, sl.sy)
            if (sl.kind === 'mirror') {
              bakeMirrorPanel(fac, sl.sw, sl.sh, sl.f.hp, sl.f.hpMax)
            } else {
              bakeSplitterTop(fac, sl.sw, hueAt(sl.f.pos.x, sl.f.pos.y))
            }
            fac.restore()
            const u0 = sl.sx / fatlasW
            const v0 = sl.sy / fatlasH
            const u1 = (sl.sx + sl.sw) / fatlasW
            const v1 = (sl.sy + sl.sh) / fatlasH
            if (sl.kind === 'mirror') {
              const f = sl.f
              const vx = f.pos.x
              const vy = f.pos.y - s.dropAnimOffset
              const sz = f.sizePx
              glFeatures.push({
                kind: 'mirror',
                tl: { x: vx, y: vy },
                tr: { x: vx + sz, y: vy },
                br: { x: vx + sz, y: vy + sz },
                bl: { x: vx, y: vy + sz },
                orient: f.orient,
                height: sz * PIECE_EXTRUDE,
                cr: 0.46,
                cg: 0.51,
                cb: 0.6,
                u0,
                v0,
                u1,
                v1,
              })
            } else {
              const f = sl.f
              const cx = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
              const cy =
                f.pos.y - s.dropAnimOffset + (f.localAabb.minY + f.localAabb.maxY) * 0.5
              const half = (f.localAabb.maxX - f.localAabb.minX) * 0.5
              glFeatures.push({
                kind: 'splitter',
                cx,
                cy,
                hubR: f.r,
                prongLen: half * 0.96,
                prongW: f.cellSize * 0.18,
                height: f.cellSize * PIECE_EXTRUDE * 0.62,
                cr: 0.28,
                cg: 0.74,
                cb: 0.98,
                exits: Array.isArray(f.exitsDeg) ? f.exitsDeg : [45, -45],
                lit: typeof f.lit === 'number' ? f.lit : 0,
                u0,
                v0,
                u1,
                v1,
              })
            }
          }

          // Contact shadows under the features (single batched, half-res blur).
          const sdpr = s.view.dpr
          const shadow = DRAW_CONTACT_SHADOWS
            ? getShadowPair(ctx.canvas.width, ctx.canvas.height)
            : null
          if (shadow && shadow.actx && shadow.bctx) {
            const sactx = shadow.actx
            const sbctx = shadow.bctx
            sactx.setTransform(sdpr * shadow.scale, 0, 0, sdpr * shadow.scale, 0, 0)
            sactx.clearRect(0, 0, s.view.width, s.view.height)
            sactx.fillStyle = 'rgba(0,0,0,0.3)'
            for (const sl of fslots) {
              const f = sl.f
              const fcx = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
              const fcy =
                f.pos.y - s.dropAnimOffset + (f.localAabb.minY + f.localAabb.maxY) * 0.5
              const pc = project(fcx, fcy)
              const rr =
                sl.kind === 'splitter'
                  ? (sl.f.localAabb.maxX - sl.f.localAabb.minX) * 0.42
                  : sl.f.sizePx * 0.6
              sactx.save()
              sactx.translate(pc.x + 4 * pc.scale, pc.y + 8 * pc.scale)
              sactx.scale(pc.scale, pc.scale)
              sactx.beginPath()
              sactx.ellipse(0, 0, rr, rr * 0.6, 0, 0, Math.PI * 2)
              sactx.fill()
              sactx.restore()
            }
            sbctx.setTransform(1, 0, 0, 1, 0, 0)
            sbctx.clearRect(0, 0, shadow.hw, shadow.hh)
            sbctx.filter = `blur(${(5 * sdpr * shadow.scale).toFixed(2)}px)`
            sbctx.drawImage(shadow.ca, 0, 0)
            sbctx.filter = 'none'
            ctx.save()
            ctx.setTransform(1, 0, 0, 1, 0, 0)
            ctx.globalCompositeOperation = 'source-over'
            ctx.imageSmoothingEnabled = true
            ctx.imageSmoothingQuality = 'low'
            ctx.drawImage(shadow.cb, 0, 0, shadow.hw, shadow.hh, 0, 0, ctx.canvas.width, ctx.canvas.height)
            ctx.restore()
          }

          const out = renderFeaturesGL(
            featAtlas,
            glFeatures,
            {
              cx: proj.cx,
              strength: proj.strength,
              nearWorldY: proj.nearWorldY,
              horizonY: proj.horizonY,
              span: proj.span,
              pMin: proj.pMin,
              pMax: proj.pMax,
            },
            s.view.width,
            s.view.height,
            s.view.dpr,
          )
          if (out) {
            ctx.save()
            ctx.globalCompositeOperation = 'source-over'
            ctx.globalAlpha = 1
            ctx.drawImage(out, 0, 0, s.view.width, s.view.height)
            ctx.restore()
            glFeaturesDrawn = true
          }
        }
      }
    }

    if (s.features.length > 0) {
      for (const f of s.features) {
        if (glFeaturesDrawn && (f.kind === 'mirror' || f.kind === 'prism')) continue
        // Apply smooth drop animation offset
        const visualPos = { x: f.pos.x, y: f.pos.y - s.dropAnimOffset }

        // Perspective: wrap the whole feature in a per-entity transform at its
        // projected center so all the world-space drawing below recedes with the
        // board. Skip only once it has shrunk to nothing far up the shaft.
        const fcx = visualPos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
        const fcy = visualPos.y + (f.localAabb.minY + f.localAabb.maxY) * 0.5
        const fp = project(fcx, fcy)
        if (fp.scale < 0.04) continue
        ctx.save()
        ctx.translate(fp.x, fp.y)
        ctx.scale(fp.scale, fp.scale)
        ctx.translate(-fcx, -fcy)

        if (f.kind === 'mirror') {
          const m = f
          drawMirrorShape(ctx, {
            pos: { x: visualPos.x, y: visualPos.y },
            sizePx: m.sizePx,
            orient: m.orient,
            hp: m.hp,
            hpMax: m.hpMax,
          })
          ctx.restore() // feature perspective transform
          continue
        }

        if (f.kind === 'prism') {
          const p = f
          const exitsDeg = (p as { exitsDeg?: number[] }).exitsDeg
          drawPrismShape(ctx, {
            pos: { x: visualPos.x, y: visualPos.y },
            cellSize: p.cellSize,
            r: p.r,
            footprint: p.localAabb.maxX - p.localAabb.minX,
            exitsDeg: Array.isArray(exitsDeg) ? exitsDeg : [45, -45],
          })
          ctx.restore() // feature perspective transform
          continue
        }

      }
    }

    // Splitter energy overlay: pulsing conduits along each prong + a core flare,
    // driven by `lit` (a beam is routing through) over a faint idle shimmer.
    // Additive, drawn on top of the 3D crystal so it reads as live laser energy
    // travelling out each exit. Works for both the GL and 2D-fallback crystals.
    if (s.features.length > 0) {
      for (const f of s.features) {
        if (f.kind !== 'prism') continue
        const exits = Array.isArray(f.exitsDeg) ? f.exitsDeg : [45, -45]
        const lit = typeof f.lit === 'number' ? f.lit : 0
        const cxw = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
        const cyw = f.pos.y - s.dropAnimOffset + (f.localAabb.minY + f.localAabb.maxY) * 0.5
        const fp = project(cxw, cyw)
        if (fp.scale < 0.04) continue
        const hue = hueAt(cxw, cyw)
        const idle = 0.16 + 0.1 * Math.sin(tNow * 3 + f.id)
        const energy = clamp(idle + lit * (0.9 + 0.4 * mEnergy), 0, 1.3)
        const half = (f.localAabb.maxX - f.localAabb.minX) * 0.5
        const hubR = f.r

        ctx.save()
        ctx.translate(fp.x, fp.y)
        ctx.scale(fp.scale, fp.scale)
        ctx.translate(-cxw, -cyw)
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'

        const drawConduit = (deg: number, len: number, intensity: number) => {
          const rad = (deg * Math.PI) / 180
          const dx = Math.sin(rad)
          const dy = -Math.cos(rad)
          const x0 = cxw + dx * hubR * 0.5
          const y0 = cyw + dy * hubR * 0.5
          const x1 = cxw + dx * len
          const y1 = cyw + dy * len
          ctx.strokeStyle = hsl(hue, 100, 70, 0.35 * intensity)
          ctx.lineWidth = 2.4
          ctx.beginPath()
          ctx.moveTo(x0, y0)
          ctx.lineTo(x1, y1)
          ctx.stroke()
          if (intensity > 0.25) {
            const t = (s.timeSec * 1.6 + f.id * 0.13) % 1
            const px = x0 + (x1 - x0) * t
            const py = y0 + (y1 - y0) * t
            ctx.fillStyle = hsl(hue, 100, 86, Math.min(1, intensity))
            ctx.beginPath()
            ctx.arc(px, py, 2.2, 0, Math.PI * 2)
            ctx.fill()
            ctx.fillStyle = hsl(hue, 100, 80, 0.5 * intensity)
            ctx.beginPath()
            ctx.arc(x1, y1, 2.6, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        for (const deg of exits) drawConduit(deg, half * 0.96, energy)
        drawConduit(180, hubR + f.cellSize * 0.18 * 1.6, energy * 0.5)

        const flare = ctx.createRadialGradient(cxw, cyw, 0, cxw, cyw, hubR * 1.25)
        flare.addColorStop(0, hsl(hue, 100, 92, 0.6 * energy))
        flare.addColorStop(0.5, hsl(hue, 100, 74, 0.28 * energy))
        flare.addColorStop(1, hsl(hue, 100, 60, 0))
        ctx.fillStyle = flare
        ctx.beginPath()
        ctx.arc(cxw, cyw, hubR * 1.25, 0, Math.PI * 2)
        ctx.fill()

        ctx.restore()
      }
    }

}
