import { XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR } from '../game/runState'
import {
  COMBO_PIERCE_TIER1,
  COMBO_PIERCE_TIER2,
  COMBO_SCORE_MULT_CAP,
} from '../game/sim'
import type { RunState, BlockEntity, MirrorFeature, PrismFeature } from '../game/runState'
import type { Vec2 } from '../game/math'
import { clamp } from '../game/math'
import { getArenaLayout } from '../game/layout'
import { makeProjection } from './projection'
import { PALETTE, gradeHue } from './theme'
import { renderLens } from './lensGL'
import { renderPiecesGL, type GLPiece } from './piecesGL'
import { renderFeaturesGL, type GLFeature } from './featuresGL'

// --- Board style experiment --------------------------------------------------
// `?board=shaft` swaps the synthwave wireframe board for the "machined shaft":
// interlocking floor plates with lane checkering, bulkhead ribs every 4th row,
// emissive conduit lanes that carry the music (the floor is the EQ), parapet
// walls with real height, an iris gate at the horizon, and distance fog. The
// wireframe stays the default while the new board is evaluated side by side.
const BOARD_SHAFT = (() => {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('board') === 'shaft'
  } catch {
    return false
  }
})()

// Render pieces as extruded 3D solids via WebGL (with a 2D-billboard fallback if
// WebGL is unavailable). Toggle off to compare against the legacy 2D path.
const USE_GL_PIECES = true

// Contact shadows under pieces/features. Even at half resolution the per-frame
// silhouette redraw + Canvas2D blur + upscale composite is a measurable cost, so
// it's the first quality sacrifice when the framerate is tight. Off = no shadows.
const DRAW_CONTACT_SHADOWS = false

// Piece extrusion height as a fraction of cell size. Shared by the GL piece pass
// and the screen-space FX (sparks) so on-piece effects sit on the 3D top face.
const PIECE_EXTRUDE = 0.95

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
import {
  drawRoundedPolyomino,
  buildRoundedPolyominoPath,
  roundedOutlinePoints,
  applyDomedDepth,
  drawBlockKindOverlay,
  drawMirrorShape,
  drawPrismShape,
} from './pieces'
// (getRarityColor will be used by the level-up menu overlay; keep renderer lean for now.)

// Depth-grid descent-pulse state (purely visual; module-local so the renderer
// stays stateless per-frame otherwise). A pulse is a single bright horizontal
// line that races down the grid each time the board steps down a row.
let gridSweepStart = -1
let gridLastDepth = -1

// Cache of each block's inset wall outline in LOCAL (untranslated) coords. The
// silhouette only depends on the piece's fixed shape (loop/cellSize/cornerRadius),
// so it's computed once per block and merely re-translated each frame — skipping
// the per-vertex arc sampling + centroid + inset math the GL wall pass would
// otherwise redo every frame. Keyed weakly so it's freed when a block is dropped.
const blockOutlineCache = new WeakMap<
  BlockEntity,
  { sig: string; local: { x: number; y: number }[] }
>()

// Reusable offscreen buffers for the black-hole gravitational-lens effect. We
// snapshot the already-drawn background around the hole into `lensSnap` once per
// frame and sample from it while warping (so the lens never feeds back on
// itself), and we draw the warped rings into `lensOut` at a SUPERSAMPLED
// resolution, then downscale it onto the scene — this anti-aliases the hard
// circular clip edges and the per-ring scale seams that otherwise look jagged.
let lensSnap: HTMLCanvasElement | null = null
let lensSnapCtx: CanvasRenderingContext2D | null = null
let lensOut: HTMLCanvasElement | null = null
let lensOutCtx: CanvasRenderingContext2D | null = null
const getLensBuf = (wDev: number, hDev: number) => {
  if (!lensSnap) {
    lensSnap = document.createElement('canvas')
    lensSnapCtx = lensSnap.getContext('2d')
  }
  // Size the buffer to EXACTLY the box. The GPU warp uploads the whole buffer
  // as a texture (flipped about the full buffer height); if the buffer were
  // larger than the box, the flipped texture coords would sample the wrong rows
  // and the lens would appear offset/clipped near the screen edges where the box
  // is clamped. An exact fit keeps texScale == 1 so sampling is always aligned.
  if (lensSnap.width !== wDev) lensSnap.width = wDev
  if (lensSnap.height !== hDev) lensSnap.height = hDev
  return { buf: lensSnap, bctx: lensSnapCtx }
}
const getLensOut = (wDev: number, hDev: number) => {
  if (!lensOut) {
    lensOut = document.createElement('canvas')
    lensOutCtx = lensOut.getContext('2d')
  }
  if (lensOut.width < wDev || lensOut.height < hDev) {
    lensOut.width = Math.max(lensOut.width, wDev)
    lensOut.height = Math.max(lensOut.height, hDev)
  }
  return { out: lensOut, octx: lensOutCtx }
}

// Parallax starfield for the void backdrop. Generated once (deterministic), then
// drawn each frame with a slow downward drift (reinforcing the descent) and a
// per-star twinkle. Layered by `z` (0 far .. 1 near) for cheap depth. The GL
// black-hole lens snapshots the background, so these get lensed for free.
// `mag` scales brightness/size (a few rare "hero" stars anchor the field); `ti`
// indexes a pre-rendered tint sprite for subtle stellar color variation.
type Star = { x: number; y: number; z: number; ph: number; sp: number; mag: number; ti: number }
let starfield: Star[] | null = null
const getStarfield = (): Star[] => {
  if (!starfield) {
    starfield = []
    let s = 0x9e3779b9 >>> 0
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
    for (let i = 0; i < 200; i++) {
      const z = rnd()
      // ~7% hero stars sit noticeably brighter/larger so the field has structure
      // instead of reading as uniform noise.
      const hero = rnd() < 0.07
      const mag = hero ? 1.7 + rnd() * 1.1 : 0.55 + rnd() * 0.7
      // Mostly white, with a minority of cool and warm stars for depth/quality.
      const r = rnd()
      const ti = r < 0.68 ? 0 : r < 0.86 ? 1 : 2
      starfield.push({ x: rnd(), y: rnd(), z, ph: rnd() * 6.283, sp: 0.006 + z * 0.02, mag, ti })
    }
  }
  return starfield
}

// Soft star sprites (white / cool / warm), pre-rendered once into small offscreen
// canvases. Drawing stars as scaled sprites gives each a crisp core plus a soft
// glow at no per-frame allocation cost — far higher quality than a hard arc, and
// cheaper than building a radial gradient per star per frame.
let starSprites: HTMLCanvasElement[] | null = null
const getStarSprites = (): HTMLCanvasElement[] => {
  if (starSprites) return starSprites
  const tints: Array<[number, number, number]> = [
    [255, 255, 255], // white
    [196, 216, 255], // cool blue-white
    [255, 228, 196], // warm amber-white
  ]
  starSprites = tints.map(([r, g, b]) => {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const g2 = c.getContext('2d')!
    const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0.0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.16, `rgba(${r},${g},${b},0.9)`)
    grad.addColorStop(0.45, `rgba(${r},${g},${b},0.22)`)
    grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`)
    g2.fillStyle = grad
    g2.fillRect(0, 0, 64, 64)
    return c
  })
  return starSprites
}

const withDpr = (ctx: CanvasRenderingContext2D, dpr: number, fn: () => void) => {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fn()
  ctx.restore()
}

const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '').trim()
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const hslToRgb = (h: number, sPct: number, lPct: number) => {
  const hh = (((h % 360) + 360) % 360) / 360
  const s = clamp(sPct / 100, 0, 1)
  const l = clamp(lPct / 100, 0, 1)
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue2rgb = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(hue2rgb(hh + 1 / 3) * 255),
    g: Math.round(hue2rgb(hh) * 255),
    b: Math.round(hue2rgb(hh - 1 / 3) * 255),
  }
}

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
export const healthFill = (hpPct: number) => {
  const t = clamp(hpPct, 0, 1)
  // "Singularity" health ramp: cold solid matter at full HP, heating to danger
  // as it dies (cold cyan -> teal -> energy amber -> danger red). Full health
  // is the dormant (music-off) matter identity color.
  const c0 = '#ff3b30' // low: danger red
  const c1 = '#ff9d3d' // mid-low: energy amber ("getting hurt")
  const c2 = '#7fc2de' // mid-high: cooling teal
  const c3 = '#bfe6f2' // high: cold mineral (matterFull)
  if (t < 0.33) return lerpColor(c0, c1, t / 0.33)
  if (t < 0.66) return lerpColor(c1, c2, (t - 0.33) / 0.33)
  return lerpColor(c2, c3, (t - 0.66) / 0.34)
}

export const relativeLuma = (cssRgb: string) => {
  // cssRgb is "rgb(r g b)" from lerpColor; parse quickly.
  const m = cssRgb.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
  if (!m) return 1
  const r = Number(m[1]) / 255
  const g = Number(m[2]) / 255
  const b = Number(m[3]) / 255
  // sRGB luminance approximation
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export type DrawUi = { musicOn: boolean }

export const drawFrame = (
  canvas: HTMLCanvasElement,
  s: RunState,
  ui: DrawUi = { musicOn: false },
) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = s.view.dpr
  withDpr(ctx, dpr, () => {
    ctx.clearRect(0, 0, s.view.width, s.view.height)
    const layout = getArenaLayout(s.view)

    // Perspective projection for the whole scene. World (sim) coordinates are
    // flat; everything visual is mapped through this so the board recedes toward
    // a high horizon. Built once per frame.
    const proj = makeProjection(s.view, layout)
    const project = proj.project
    const scaleAt = proj.scaleAt

    // Live music signals (0..1), pre-scaled by the user's reactivity intensity.
    // When nothing is playing, `mi` collapses to 0 so the game looks exactly
    // like its non-reactive baseline.
    const music = s.music
    const playing = music.playing
    const mi = playing ? music.intensity : 0
    const mBass = music.bass * mi
    const mPulse = music.pulse * mi
    const mEnergy = music.energy * mi
    // Continuous rainbow hue (0..360); frozen by the engine when not playing.
    const mHue = music.hue
    const spectrum = music.spectrum
    // Wall clock (seconds) so the background keeps gliding even while the sim is
    // paused; gameplay uses s.timeSec elsewhere. Motion in the background is
    // gated by `mi` so it still settles when music is off.
    const tNow =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000
    const hsl = (h: number, sPct: number, lPct: number, a = 1) =>
      `hsla(${(((h % 360) + 360) % 360).toFixed(1)},${sPct.toFixed(1)}%,${lPct.toFixed(1)}%,${a})`
    // Per-element rainbow hue keyed off screen position (same spread the blocks
    // use), so heat FX on a piece match that piece's color.
    // The board's per-position hue spread widens with musical energy, so the
    // color gradient across the pieces blooms on big moments and tightens in
    // quiet passages — reactivity you feel, not just see.
    const hueAt = (x: number, y: number) => mHue + (y * 0.16 + x * 0.1) * (1 + mEnergy * 0.6)
    // Blend a baked "heat" color (white-hot orange/red) toward the live rainbow
    // hue by the music mix. When music is off it returns the original color, so
    // the molten/weld look is unchanged in the non-reactive baseline.
    const heat = (
      hueDeg: number,
      baseR: number,
      baseG: number,
      baseB: number,
      satPct: number,
      lightPct: number,
      alpha: number,
    ) => {
      if (mi <= 0) return `rgba(${baseR},${baseG},${baseB},${alpha})`
      const hc = hslToRgb(hueDeg, satPct, lightPct)
      const r = Math.round(lerp(baseR, hc.r, mi))
      const g = Math.round(lerp(baseG, hc.g, mi))
      const b = Math.round(lerp(baseB, hc.b, mi))
      return `rgba(${r},${g},${b},${alpha})`
    }
    const roundedRectPath = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + w, y, x + w, y + h, rr)
      ctx.arcTo(x + w, y + h, x, y + h, rr)
      ctx.arcTo(x, y + h, x, y, rr)
      ctx.arcTo(x, y, x + w, y, rr)
      ctx.closePath()
    }
    // ======================================================================
    // BACKGROUND — "Event-Horizon Descent". Opaque so the whole look lives on
    // the canvas (and the GL lens samples a real backdrop, not the CSS page).
    // A deliberate deep-space gradient + a corner vignette that frames the
    // shaft, plus a glowing horizon aperture where the pieces are born.
    // ======================================================================
    {
      const W = s.view.width
      const H = s.view.height

      // Framing gradient: deep blue-black void, a touch lighter toward the
      // bottom so the playfield reads as a pool of light.
      const base = ctx.createLinearGradient(0, 0, 0, H)
      base.addColorStop(0, PALETTE.voidTop)
      base.addColorStop(0.55, PALETTE.voidMid)
      base.addColorStop(1, PALETTE.voidNear)
      ctx.fillStyle = base
      ctx.fillRect(0, 0, W, H)

      // Parallax starfield drifting slowly downward through the void.
      {
        const stars = getStarfield()
        const sprites = getStarSprites()
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        for (const st of stars) {
          const xx = st.x * W
          const yy = ((st.y + tNow * st.sp) % 1) * H
          const tw = 0.5 + 0.5 * Math.sin(tNow * (0.6 + st.z) + st.ph)
          // Brighter and more legible than before, but the twinkle still pulls the
          // dimmest stars near zero so the field shimmers instead of glaring.
          const a = Math.min(0.95, (0.1 + 0.42 * st.z) * (0.4 + 0.6 * tw) * st.mag)
          const size = (1.5 + st.z * 3.4) * st.mag
          ctx.globalAlpha = a
          const sp = sprites[st.ti]
          ctx.drawImage(sp, xx - size / 2, yy - size / 2, size, size)
        }
        ctx.globalAlpha = 1
        ctx.restore()
      }

      // Corner vignette: darken the edges so the playfield reads as a pool of
      // light. Deliberate (not a faint shimmer) — pure framing, no animation.
      const vig = ctx.createRadialGradient(W * 0.5, H * 0.52, H * 0.18, W * 0.5, H * 0.52, Math.max(W, H) * 0.82)
      vig.addColorStop(0, 'rgba(0,0,0,0)')
      vig.addColorStop(0.6, 'rgba(0,0,0,0)')
      vig.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Horizon aperture: a soft bloom at the on-screen convergence (top of
      //    the shaft), the source the pieces emerge from. Pulses with the bass.
      // (The machined-shaft board draws its own iris gate instead.)
      if (!BOARD_SHAFT) {
        const wTop = proj.unproject(W * 0.5, 0).y
        const lx = project(0, wTop).x
        const rx = project(W, wTop).x
        const apX = (lx + rx) * 0.5
        const apY = 2
        const apR = Math.max(60, (rx - lx) * 1.05)
        const apHue = mi > 0 ? mHue : PALETTE.horizonHue
        const pulse = 0.32 + 0.5 * mBass + 0.12 * Math.sin(tNow * 0.8)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const halo = ctx.createRadialGradient(apX, apY, 0, apX, apY, apR)
        halo.addColorStop(0, hsl(apHue, 80, 70, clamp(0.38 * pulse + 0.12, 0, 0.85)))
        halo.addColorStop(0.4, hsl(apHue + 14, 78, 56, clamp(0.18 * pulse, 0, 0.5)))
        halo.addColorStop(1, hsl(apHue + 20, 70, 40, 0))
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(apX, apY, apR, 0, Math.PI * 2)
        ctx.fill()
        // Bright inner seed.
        const seed = ctx.createRadialGradient(apX, apY, 0, apX, apY, apR * 0.32)
        seed.addColorStop(0, hsl(apHue, 90, 92, clamp(0.4 * pulse + 0.16, 0, 0.9)))
        seed.addColorStop(1, hsl(apHue, 85, 70, 0))
        ctx.fillStyle = seed
        ctx.beginPath()
        ctx.arc(apX, apY, apR * 0.32, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }

    // Synthwave depth grid — the shaft you descend. Thin neon lines receding to
    // a vanishing point near the top; horizontals scroll DOWNWARD to sell the
    // descent. Always present (faint, on-brand purple) and comes alive with the
    // music: rainbow hue, brighter/faster with energy, per-line spectrum glow.
    // No full-screen flashes; the only beat event is a single sweeping line.
    {
      const W = s.view.width
      // The grid is the world ground plane drawn through the SAME projection as
      // the pieces, so they are guaranteed co-perspective. Rows are spaced in
      // world px up the shaft from the near plane (emitter) toward the horizon.
      // One grid row == one piece cell so rungs line up with where pieces rest,
      // and the rungs move with the EXACT same stepped motion as the board (see
      // the gridShift below) — the pieces look bolted to the grid.
      const GRID_ROW = 40 // must match the sim's cellSize
      const ROWS = 48
      const farWorldY = proj.nearWorldY - ROWS * GRID_ROW
      const totalDepth = ROWS * GRID_ROW

      // Base look settles to on-brand purple when music is off (mi == 0); when
      // playing it leans into the live rainbow hue.
      const baseHue = PALETTE.latticeHue + (mHue - PALETTE.latticeHue) * mi
      const baseAlpha = 0.11 + mEnergy * 0.07

      // Scroll phase shared by both board styles: the exact world distance the
      // board has visually travelled this frame (steps minus the in-progress
      // catch-up), modulo one row — so board furniture steps and eases
      // identically to the pieces.
      const gridShift =
        (((s.depth * GRID_ROW - s.dropAnimOffset) % GRID_ROW) + GRID_ROW) % GRID_ROW

      if (BOARD_SHAFT) {
        // ================== MACHINED SHAFT (?board=shaft) ===================
        // The board as physical hardware, in the emitter's design language:
        //  1. Floor: interlocking machined plates (lane-checkered, per-plate
        //     tint variance, a slow specular sheen) instead of graph paper.
        //  2. Row seams with HIERARCHY: faint joins normally, a glowing
        //     bulkhead rib every 4th row that also ribs the walls — rhythm,
        //     scale, and descent speed you can feel.
        //  3. Conduit lanes: three emissive channels cut into the floor that
        //     ARE the equalizer (bass/mid/treble), with energy packets
        //     streaming down to feed the cannon.
        //  4. Walls with real height: dark parapet faces, bulkhead ribs, a
        //     bright top rail with node lights — the beam ricochets off
        //     structure, not a line.
        //  5. Distance fog and an iris gate at the horizon (where pieces are
        //     born), plus a soft light pool at the muzzle.
        // Plate/seam identity is keyed to (row - depth) so the material
        // travels with the board; everything shares the piece projection.
        const LANES = 8
        const mBeat = music.beat * mi
        // Structural identity: cold steel-blue when music is off; leans gently
        // into the live hue when playing (full rainbow stays on the emissive
        // elements, not the matter).
        const structHue = 218 + (mHue - 218) * (mi * 0.35)
        const voidC = hexToRgb(PALETTE.voidTop)
        const hash2 = (a: number, b: number) => {
          const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
          return x - Math.floor(x)
        }
        const bulkAt = (rowKey: number) => ((rowKey % 4) + 4) % 4 === 0
        type Pt = { x: number; y: number }
        const quad = (a: Pt, b: Pt, c: Pt, d: Pt) => {
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.lineTo(c.x, c.y)
          ctx.lineTo(d.x, d.y)
          ctx.closePath()
        }

        // ---- 1. Floor plates (source-over) -------------------------------
        for (let i = 0; i < ROWS; i++) {
          const yBot = Math.min(proj.nearWorldY, proj.nearWorldY - i * GRID_ROW + gridShift)
          const yTop = proj.nearWorldY - (i + 1) * GRID_ROW + gridShift
          if (yTop >= proj.nearWorldY) continue
          const aL = project(0, yTop)
          const cL = project(0, yBot)
          if (cL.scale < 0.05) continue
          const near = cL.scale
          const rowKey = i - s.depth
          const rowH = cL.y - aL.y
          const atmos = clamp(0.1 + near * 1.05, 0, 1)
          const depthDim = 0.45 + 0.55 * near
          if (rowH < 3.2) {
            // Too thin for the checker to read: one clean full-width plate
            // keeps the far shaft quiet instead of noisy.
            const bR = project(W, yTop)
            const cR = project(W, yBot)
            ctx.fillStyle = hsl(structHue, 30, 7.2 * depthDim + 1.2, atmos)
            quad(aL, bR, cR, cL)
            ctx.fill()
            continue
          }
          for (let l = 0; l < LANES; l++) {
            const x0 = (l / LANES) * W
            const x1 = ((l + 1) / LANES) * W
            const a = project(x0, yTop)
            const b = project(x1, yTop)
            const c = project(x1, yBot)
            const d = project(x0, yBot)
            const ck = ((rowKey + l) % 2 + 2) % 2
            const hv = hash2(rowKey, l)
            // Slow specular sheen sweeping diagonally across the plates, like
            // light moving over brushed metal. Pure lightness, no extra draws.
            const sw = 0.5 + 0.5 * Math.sin(rowKey * 0.55 + l * 0.9 - tNow * 0.55)
            const sheen = Math.pow(sw, 6) * 2.2 * near
            const lit = (6.2 + ck * 2.1 + hv * 1.3 + sheen) * depthDim + 1.2
            ctx.fillStyle = hsl(structHue, 32, lit, atmos)
            quad(a, b, c, d)
            ctx.fill()
          }
        }

        // Conduit grooves: dark channels cut into the plates (the emissive
        // cores render in the additive pass below).
        for (let k = 0; k < 3; k++) {
          const xw = (((k + 1) * 2) / LANES) * W
          const a = project(xw, proj.nearWorldY)
          const b = project(xw, farWorldY)
          ctx.strokeStyle = hsl(structHue, 35, 3.5, 0.85)
          ctx.lineWidth = 3.4
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }

        // ---- 2+3. Additive pass: seams, bulkheads, conduit energy ---------
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'
        for (let i = 0; i <= ROWS; i++) {
          const y = proj.nearWorldY - i * GRID_ROW + gridShift
          if (y > proj.nearWorldY) continue
          const a = project(0, y)
          if (a.scale < 0.05) continue
          const b = project(W, y)
          const rowKey = i - s.depth
          if (bulkAt(rowKey)) {
            // Bulkhead rib: the heavy structural beat of the shaft. Breathes
            // with the bass and flashes a touch on the musical beat.
            const glow = 0.1 + a.scale * 0.2 + mBass * 0.08 + mBeat * 0.1
            ctx.shadowColor = hsl(baseHue, 80, 60, 0.5)
            ctx.shadowBlur = 7 * a.scale
            ctx.strokeStyle = hsl(baseHue, 60, 62, clamp(glow, 0, 0.5))
            ctx.lineWidth = 1.1 + a.scale * 1.7
          } else {
            // Plain plate join: barely-there, just enough to read the cells.
            ctx.shadowBlur = 0
            ctx.strokeStyle = hsl(structHue, 30, 55, 0.035 + a.scale * 0.05)
            ctx.lineWidth = 0.7 + a.scale * 0.5
          }
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
        ctx.shadowBlur = 0

        // Conduit cores: three channels = bass / mids / treble. The floor is
        // the equalizer; with music off they idle at a faint steady glow.
        const bandFor = (k: number) => {
          const n = spectrum.length
          const s0 = Math.floor((k / 3) * n)
          const s1 = Math.max(s0 + 1, Math.floor(((k + 1) / 3) * n))
          let acc = 0
          for (let j = s0; j < s1; j++) acc += spectrum[j] ?? 0
          return (acc / (s1 - s0)) * mi
        }
        for (let k = 0; k < 3; k++) {
          const xw = (((k + 1) * 2) / LANES) * W
          const a = project(xw, proj.nearWorldY)
          const b = project(xw, farWorldY)
          const band = bandFor(k)
          ctx.shadowColor = hsl(baseHue, 85, 62, 0.4 + band * 0.4)
          ctx.shadowBlur = 6 * band
          ctx.strokeStyle = hsl(baseHue, 75, 62, 0.06 + 0.17 * band)
          ctx.lineWidth = 1.3 + band * 1.7
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          // Energy packets streaming down-shaft to feed the cannon.
          for (let j = 0; j < 3; j++) {
            const u = (tNow * (0.1 + 0.02 * k) + j / 3 + k * 0.21) % 1
            const p = project(xw, proj.nearWorldY - (1 - u) * totalDepth)
            if (p.scale < 0.07) continue
            const pa =
              (0.1 + 0.3 * band + 0.08 * mEnergy + (mi <= 0 ? 0.08 : 0)) *
              clamp(p.scale * 1.4, 0, 1)
            ctx.fillStyle = hsl(baseHue + 10, 95, 76, clamp(pa, 0, 0.55))
            ctx.beginPath()
            ctx.arc(p.x, p.y, 0.8 + 2.4 * p.scale, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        ctx.restore()

        // ---- 4. Parapet walls ---------------------------------------------
        const WALL_H = 30 // wall height in screen px at the near plane
        const wallHue = PALETTE.wallHue + (mHue - PALETTE.wallHue) * mi
        for (const xw of [0, W]) {
          const edge: Array<{ x: number; y: number; s: number }> = []
          const top: Array<{ x: number; y: number; s: number }> = []
          for (let i = 0; i <= ROWS; i++) {
            const y = Math.min(proj.nearWorldY, proj.nearWorldY - i * GRID_ROW + gridShift)
            const p = project(xw, y)
            if (p.scale < 0.05) break
            edge.push({ x: p.x, y: p.y, s: p.scale })
            top.push({ x: p.x, y: p.y - WALL_H * p.scale, s: p.scale })
          }
          if (edge.length < 2) continue
          // Wall face: a dark machined parapet (occludes the void behind it).
          ctx.beginPath()
          ctx.moveTo(edge[0]!.x, edge[0]!.y)
          for (const p of edge) ctx.lineTo(p.x, p.y)
          for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i]!.x, top[i]!.y)
          ctx.closePath()
          ctx.fillStyle = hsl(structHue + 2, 30, 8, 0.94)
          ctx.fill()
          // Vertical ribs at bulkhead rows tie the wall to the floor's rhythm.
          for (let i = 0; i < edge.length; i++) {
            if (!bulkAt(i - s.depth)) continue
            ctx.strokeStyle = hsl(structHue, 24, 26, 0.22 + 0.4 * edge[i]!.s)
            ctx.lineWidth = 1 + edge[i]!.s
            ctx.beginPath()
            ctx.moveTo(edge[i]!.x, edge[i]!.y)
            ctx.lineTo(top[i]!.x, top[i]!.y)
            ctx.stroke()
          }
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          // Bright top rail — the lit edge the eye tracks down the shaft.
          ctx.shadowColor = hsl(wallHue, 82, 60, 0.7)
          ctx.shadowBlur = 10
          ctx.strokeStyle = hsl(wallHue, 72, 62, 0.55)
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(top[0]!.x, top[0]!.y)
          for (const p of top) ctx.lineTo(p.x, p.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          // Node lights at bulkheads only — deliberate, not a dotted line.
          for (let i = 0; i < top.length; i++) {
            if (!bulkAt(i - s.depth)) continue
            const p = top[i]!
            ctx.fillStyle = hsl(wallHue + 8, 85, 74, clamp(0.18 + p.s * 0.55 + mBeat * 0.2, 0, 0.85))
            ctx.beginPath()
            ctx.arc(p.x, p.y, 0.9 + 2.2 * p.s, 0, Math.PI * 2)
            ctx.fill()
          }
          // Faint base seam where wall meets floor.
          ctx.strokeStyle = hsl(wallHue, 50, 55, 0.16)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(edge[0]!.x, edge[0]!.y)
          for (const p of edge) ctx.lineTo(p.x, p.y)
          ctx.stroke()
          ctx.restore()
        }

        // Bounce blooms: laser vertices that landed on a wall flare the surface.
        {
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          const wallTol = 2.2
          const bh = mi > 0 ? mHue : wallHue
          for (const seg of s.laser.segments) {
            for (const v of [seg.a, seg.b]) {
              if (v.x <= wallTol || v.x >= W - wallTol) {
                const p = project(v.x, v.y)
                const br = 6 + 11 * p.scale
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, br)
                g.addColorStop(0, hsl(bh, 95, 82, 0.5))
                g.addColorStop(1, hsl(bh, 90, 60, 0))
                ctx.fillStyle = g
                ctx.beginPath()
                ctx.arc(p.x, p.y, br, 0, Math.PI * 2)
                ctx.fill()
              }
            }
          }
          ctx.restore()
        }

        // ---- 5. Distance fog ----------------------------------------------
        {
          const apTopY = project(W / 2, farWorldY).y
          const fog = ctx.createLinearGradient(0, apTopY - 26, 0, apTopY + 100)
          fog.addColorStop(0, `rgba(${voidC.r},${voidC.g},${voidC.b},0.92)`)
          fog.addColorStop(1, `rgba(${voidC.r},${voidC.g},${voidC.b},0)`)
          ctx.fillStyle = fog
          ctx.fillRect(0, 0, W, Math.max(0, apTopY + 100))
        }

        // ---- 6. Iris gate at the horizon -----------------------------------
        // Where the pieces are born: a mechanical iris of counter-rotating arc
        // segments around a tight bloom, replacing the plain aperture glow.
        {
          const wTop = proj.unproject(W * 0.5, 0).y
          const lx = project(0, wTop).x
          const rx = project(W, wTop).x
          const apX = (lx + rx) * 0.5
          const apY = 2
          const gateR = Math.max(26, (rx - lx) * 0.5)
          const apHue = mi > 0 ? mHue : PALETTE.horizonHue
          const pulse = 0.32 + 0.5 * mBass + 0.12 * Math.sin(tNow * 0.8)
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          const halo = ctx.createRadialGradient(apX, apY, 0, apX, apY, gateR * 2.2)
          halo.addColorStop(0, hsl(apHue, 80, 72, clamp(0.3 * pulse + 0.12, 0, 0.7)))
          halo.addColorStop(0.4, hsl(apHue + 14, 78, 56, clamp(0.14 * pulse, 0, 0.4)))
          halo.addColorStop(1, hsl(apHue + 20, 70, 40, 0))
          ctx.fillStyle = halo
          ctx.beginPath()
          ctx.arc(apX, apY, gateR * 2.2, 0, Math.PI * 2)
          ctx.fill()
          ctx.lineCap = 'round'
          for (let r = 0; r < 3; r++) {
            const rad = gateR * (0.55 + r * 0.3)
            const rot = tNow * (0.12 + 0.07 * r) * (r % 2 ? -1 : 1)
            ctx.strokeStyle = hsl(
              apHue,
              75,
              66,
              (0.42 - r * 0.1) * (0.65 + 0.35 * pulse + 0.45 * mBeat),
            )
            ctx.lineWidth = 1.7 - r * 0.35
            for (let k2 = 0; k2 < 4; k2++) {
              ctx.beginPath()
              ctx.arc(apX, apY, rad, rot + (k2 * Math.PI) / 2, rot + (k2 * Math.PI) / 2 + 1.05)
              ctx.stroke()
            }
          }
          const seed = ctx.createRadialGradient(apX, apY, 0, apX, apY, gateR * 0.3)
          seed.addColorStop(0, hsl(apHue, 90, 92, clamp(0.34 * pulse + 0.14, 0, 0.8)))
          seed.addColorStop(1, hsl(apHue, 85, 70, 0))
          ctx.fillStyle = seed
          ctx.beginPath()
          ctx.arc(apX, apY, gateR * 0.3, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }

        // ---- 7. Muzzle light pool ------------------------------------------
        // The cannon's plasma throat spills a soft pool onto the nearby plates.
        {
          const ex = W / 2
          const ey = layout.emitterY
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.translate(ex, ey)
          ctx.scale(1, 0.42)
          const ph = mi > 0 ? mHue : PALETTE.horizonHue
          const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, 130)
          pool.addColorStop(0, hsl(ph, 70, 62, 0.1 + 0.06 * mPulse))
          pool.addColorStop(1, hsl(ph, 70, 50, 0))
          ctx.fillStyle = pool
          ctx.beginPath()
          ctx.arc(0, 0, 130, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      } else {

      // Distinct "floor" beneath the grid: fill the projected ground-plane quad
      // so the shaft reads as its own surface, separate from the page background.
      // A vertical gradient sits darkest at the horizon and warms toward the
      // player; it leans into the music hue but stays subdued so lines pop.
      {
        const nl = project(0, proj.nearWorldY)
        const nr = project(W, proj.nearWorldY)
        const fl = project(0, farWorldY)
        const fr = project(W, farWorldY)
        const floor = ctx.createLinearGradient(0, fl.y, 0, nl.y)
        const floorHue = PALETTE.floorHue + (mHue - PALETTE.floorHue) * mi
        floor.addColorStop(0, hsl(floorHue + 8, 55, 6, 0.0)) // fade out at horizon
        floor.addColorStop(0.18, hsl(floorHue + 8, 58, 8, 0.55))
        floor.addColorStop(1, hsl(floorHue, 62, 13, 0.8)) // near the player
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(fl.x, fl.y)
        ctx.lineTo(fr.x, fr.y)
        ctx.lineTo(nr.x, nr.y)
        ctx.lineTo(nl.x, nl.y)
        ctx.closePath()
        ctx.fillStyle = floor
        ctx.fill()
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'

      // Converging vertical rails (static — they define the shaft). Each rail is
      // a constant-world-X line from the near plane to the far plane; projection
      // makes them converge toward the vanishing point.
      const COLS = 9
      for (let c = 0; c <= COLS; c++) {
        const xW = (c / COLS) * W
        const a = project(xW, proj.nearWorldY)
        const b = project(xW, farWorldY)
        ctx.strokeStyle = hsl(baseHue + (c / COLS - 0.5) * 36 * mi, 80, 62, baseAlpha * 1.25)
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Horizontal rungs locked to the board's descent (gridShift above), so the
      // rungs step and ease-in identically to the pieces instead of free-scrolling.
      for (let i = 0; i <= ROWS; i++) {
        const worldY = proj.nearWorldY - i * GRID_ROW + gridShift
        if (worldY > proj.nearWorldY) continue
        const a = project(0, worldY)
        if (a.scale < 0.04) continue
        const b = project(W, worldY)
        const depthFrac = clamp((proj.nearWorldY - worldY) / totalDepth, 0, 1) // 0 near .. 1 far
        // Per-row spectrum glow: nearer rows read more bass, far rows treble.
        const bin = Math.min(spectrum.length - 1, Math.floor(depthFrac * spectrum.length))
        const band = (spectrum[bin] ?? 0) * mi
        const near = a.scale // ~1 near .. small far
        // Atmospheric perspective: far rungs fade and desaturate toward the void
        // so the shaft reads as real receding depth, not a flat ramp.
        const atmos = 0.42 + 0.58 * near
        const alpha = clamp((baseAlpha + near * (0.06 + 0.18 * band)) * atmos, 0, 0.5)
        const lwidth = 0.8 + near * 1.4 + band * 1.6
        const sat = (82 - depthFrac * 46) + band * 10
        ctx.strokeStyle = hsl(baseHue + depthFrac * 40 * mi, sat, 58 + band * 14, alpha)
        ctx.lineWidth = lwidth
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Shaft walls — the bounce surfaces. The two boundaries (world x=0 and
      // x=W) become bright, lit edge rails with light nodes that scroll on the
      // descent, so the beam visibly ricochets off solid structure instead of
      // an invisible edge. Still inside the 'lighter' pass for an additive glow.
      {
        const wallHue = PALETTE.wallHue + (mHue - PALETTE.wallHue) * mi
        for (const xW of [0, W]) {
          const a = project(xW, proj.nearWorldY)
          const b = project(xW, farWorldY)
          ctx.shadowColor = hsl(wallHue, 82, 60, 0.7)
          ctx.shadowBlur = 12
          ctx.strokeStyle = hsl(wallHue, 72, 60, 0.5)
          ctx.lineWidth = 2.4
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          // Light nodes at each row, brighter near the player; they scroll with
          // gridShift so the wall reads as moving with the board.
          for (let i = 0; i <= ROWS; i++) {
            const worldY = proj.nearWorldY - i * GRID_ROW + gridShift
            if (worldY > proj.nearWorldY) continue
            const p = project(xW, worldY)
            if (p.scale < 0.05) continue
            ctx.fillStyle = hsl(wallHue + 8, 85, 72, clamp(0.12 + p.scale * 0.5, 0, 0.7))
            ctx.beginPath()
            ctx.arc(p.x, p.y, 0.8 + p.scale * 2.2, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        // Bounce blooms: laser vertices that landed on a wall flare the surface.
        const wallTol = 2.2
        const bh = mi > 0 ? mHue : wallHue
        for (const seg of s.laser.segments) {
          for (const v of [seg.a, seg.b]) {
            if (v.x <= wallTol || v.x >= W - wallTol) {
              const p = project(v.x, v.y)
              const br = 6 + 11 * p.scale
              const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, br)
              g.addColorStop(0, hsl(bh, 95, 82, 0.5))
              g.addColorStop(1, hsl(bh, 90, 60, 0))
              ctx.fillStyle = g
              ctx.beginPath()
              ctx.arc(p.x, p.y, br, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }

      ctx.restore()
      }

      // Descent pulse: one bright rung races down the shaft (far -> near) every
      // time the board steps down a row, so the descent is unmistakably legible.
      // Triggered off depth (the canonical step counter), so it fires with or
      // without music and stays in lockstep with the pieces.
      if (s.depth !== gridLastDepth) {
        gridLastDepth = s.depth
        gridSweepStart = tNow
      }
      if (gridSweepStart >= 0) {
        const sweepDur = 0.55
        const sp = (tNow - gridSweepStart) / sweepDur
        if (sp >= 0 && sp < 1) {
          const surge = clamp(s.crescendo, 0, 1)
          // Accelerate toward the player so it reads as "falling" with the board.
          const ease = sp * sp
          const worldY = farWorldY + ease * (proj.nearWorldY - farWorldY)
          const a = project(0, worldY)
          const b = project(W, worldY)
          const fade = 1 - sp
          const hue = mi > 0 ? mHue + 12 : baseHue
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          ctx.shadowColor = hsl(hue, 95, 70, 0.9)
          ctx.shadowBlur = 14 * a.scale + 5
          ctx.strokeStyle = hsl(hue, 95, 75, clamp(0.42 + (0.5 + 0.4 * surge) * fade, 0, 0.98))
          ctx.lineWidth = (1.8 + 3.4 * a.scale) * (1 + 0.7 * surge)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.restore()
        } else if (sp >= 1) {
          gridSweepStart = -1
        }
      }
    }

    // Fail line: a charged danger threshold. A faint dashed baseline is always
    // present; an amber glow ignites and pulses as the nearest piece nears it.
    const failY = layout.failY
    {
      let danger = 0
      for (const b of s.blocks) {
        const by = b.pos.y - s.dropAnimOffset - b.dropAnimExtra + b.localAabb.maxY
        danger = Math.max(danger, 1 - clamp((failY - by) / 160, 0, 1))
      }
      const fa = project(0, failY)
      const fb = project(s.view.width, failY)
      const pulse = 0.6 + 0.4 * Math.sin(tNow * 4)
      const DH = PALETTE.dangerHue // reserved danger red
      ctx.save()
      ctx.lineCap = 'round'
      // Danger glow (additive), intensity + blur ride the proximity pulse.
      ctx.globalCompositeOperation = 'lighter'
      ctx.shadowColor = hsl(DH, 100, 55, 0.85)
      ctx.shadowBlur = 5 + 18 * danger * pulse
      ctx.strokeStyle = hsl(DH, 100, 62, clamp(0.16 + 0.6 * danger, 0, 0.95))
      ctx.lineWidth = 2 + 2.4 * danger
      ctx.beginPath()
      ctx.moveTo(fa.x, fa.y)
      ctx.lineTo(fb.x, fb.y)
      ctx.stroke()
      ctx.shadowBlur = 0
      // Dashed baseline so the boundary is legible even at zero danger.
      ctx.globalCompositeOperation = 'source-over'
      ctx.setLineDash([8, 10])
      ctx.strokeStyle = hsl(DH, 85, 70, 0.42)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(fa.x, fa.y)
      ctx.lineTo(fb.x, fb.y)
      ctx.stroke()
      ctx.setLineDash([])
      // End notches anchor the threshold to the walls.
      ctx.fillStyle = hsl(DH, 95, 66, clamp(0.4 + 0.5 * danger, 0, 1))
      for (const e of [fa, fb]) {
        ctx.beginPath()
        ctx.arc(e.x, e.y, 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

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

    // Melt-on-death FX: the block turns red-hot and squishes (gravity) into the XP particle.
    if (s.meltFx.length > 0) {
      const smoothstep = (x: number) => {
        const t = clamp(x, 0, 1)
        return t * t * (3 - 2 * t)
      }
      const drawSmoothClosed = (pts: Vec2[]) => {
        if (pts.length < 3) return
        // If closed (last == first), drop the duplicate.
        const p0 = pts[0]!
        const pn = pts[pts.length - 1]!
        const arr =
          Math.abs(pn.x - p0.x) < 1e-6 && Math.abs(pn.y - p0.y) < 1e-6 ? pts.slice(0, -1) : pts
        const n = arr.length
        if (n < 3) return
        const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 })
        const m0 = mid(arr[0]!, arr[1]!)
        ctx.beginPath()
        ctx.moveTo(m0.x, m0.y)
        for (let i = 1; i < n; i++) {
          const a = arr[i]!
          const b = arr[(i + 1) % n]!
          const m = mid(a, b)
          ctx.quadraticCurveTo(a.x, a.y, m.x, m.y)
        }
        // close via first vertex
        const mEnd = mid(arr[0]!, arr[1]!)
        ctx.quadraticCurveTo(arr[0]!.x, arr[0]!.y, mEnd.x, mEnd.y)
        ctx.closePath()
      }
      for (const fx of s.meltFx) {
        const p = clamp(fx.t / Math.max(0.0001, fx.dur), 0, 1)

        const ax0 = fx.pos.x + fx.localAabb.minX
        const ay0 = fx.pos.y + fx.localAabb.minY
        const w0 = fx.localAabb.maxX - fx.localAabb.minX
        const h0 = fx.localAabb.maxY - fx.localAabb.minY
        const cx0 = ax0 + w0 * 0.5

        // Perspective: render the whole molten morph at its projected center,
        // scaled by depth, so a dying piece melts in-place on the receding board.
        const mp = project(cx0, ay0 + h0 * 0.5)
        ctx.save()
        ctx.translate(mp.x, mp.y)
        ctx.scale(mp.scale, mp.scale)
        ctx.translate(-cx0, -(ay0 + h0 * 0.5))

        // Molten body follows the live rainbow hue (reverts to dead-piece red
        // when music is off), so a dying block doesn't snap to red mid-melt.
        const meltHue = hueAt(cx0, ay0 + h0 * 0.5)
        const molten = heat(meltHue, 255, 59, 92, 90, 60, 1)

        // Single-shape morph (no fades, no separate puddle/orb draw):
        // - Early: gravity sag + pooling deformation (stronger near the bottom).
        // - Late: smoothly morph into a circle at orbFrom with the same radius as the XP orb.
        const phase1End = 0.78
        const a = smoothstep(p / phase1End) // pooling/sag amount
        const c = smoothstep((p - phase1End) / (1 - phase1End)) // circle morph amount

        const top0 = ay0
        const bottom0 = ay0 + h0
        const wob = Math.sin(fx.seed + fx.t * 7.5)

        const ptsWorld: Vec2[] = fx.loop.map((q) => ({
          x: fx.pos.x + q.x * fx.cellSize,
          y: fx.pos.y + q.y * fx.cellSize,
        }))
        const ptsWarp: Vec2[] = []
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity
        const R = 5 // must match XP orb fly radius

        // 1) Warp points with a gravity + pooling field.
        for (const pt of ptsWorld) {
          const v = clamp((pt.y - top0) / Math.max(1, h0), 0, 1) // 0 top -> 1 bottom
          const dy = bottom0 - pt.y
          const edge01 = clamp(Math.abs(pt.x - cx0) / Math.max(1, w0 * 0.5), 0, 1)

          // Compress upper mass downward (sag), much less at the bottom so it "piles up".
          const compress = 1 - a * 0.80 * Math.pow(1 - v, 1.7)
          let y1 = bottom0 - dy * compress
          // Downward drift: affects edges too so horizontal surfaces don't only divot in the middle.
          y1 += a * 0.07 * h0 * Math.pow(v, 2.2) * (0.65 + 0.35 * edge01)

          // Spread more near the bottom (puddle) + a bit of viscous lateral slop.
          // Additionally, cantilevered parts (high + far from center) should flow inward as they melt
          // instead of "dripping" straight down as thin strings.
          const spread = 1 + a * (0.55 * v * v) + a * 0.06 * wob * Math.pow(v, 2.8)

          // Inward reflow is strongest for points that are:
          // - higher up (1 - v)
          // - further from center (edge01)
          // This helps overhangs collapse back toward the body of the piece.
          const inward = a * 0.62 * Math.pow(1 - v, 1.55) * Math.pow(edge01, 1.35)
          const spreadAdj = Math.max(0.15, spread * (1 - inward))

          let x1 = cx0 + (pt.x - cx0) * spreadAdj
          x1 += a * 6.5 * wob * (1 - v) * 0.25

          ptsWarp.push({ x: x1, y: y1 })
        }

        // 2) Viscosity smoothing to combat “balloon animal” pinches (diffuses sharp necks).
        // This keeps thin connectors from collapsing into single vertices with long smooth curves.
        if (ptsWarp.length >= 6) {
          const iters = 2
          const k = 0.22
          for (let it = 0; it < iters; it++) {
            const next: Vec2[] = []
            for (let i = 0; i < ptsWarp.length; i++) {
              const prev = ptsWarp[(i - 1 + ptsWarp.length) % ptsWarp.length]!
              const cur = ptsWarp[i]!
              const nxt = ptsWarp[(i + 1) % ptsWarp.length]!
              next.push({
                x: cur.x + k * ((prev.x + nxt.x) * 0.5 - cur.x),
                y: cur.y + k * ((prev.y + nxt.y) * 0.5 - cur.y),
              })
            }
            for (let i = 0; i < ptsWarp.length; i++) ptsWarp[i] = next[i]!
          }

          // Extra mild “nub killer” near the end: remove tiny protrusions without changing the overall melt.
          // Only activates late to avoid over-smoothing the early recognizable silhouette.
          const nub = smoothstep((p - 0.68) / 0.32)
          if (nub > 0.001) {
            const n = ptsWarp.length
            const extraIters = nub > 0.85 ? 2 : 1
            const kk = 0.10 + 0.10 * nub
            const minEdge = Math.max(1.2, fx.cellSize * 0.06)
            for (let it = 0; it < extraIters; it++) {
              const next: Vec2[] = []
              for (let i = 0; i < n; i++) {
                const prev = ptsWarp[(i - 1 + n) % n]!
                const cur = ptsWarp[i]!
                const nxt = ptsWarp[(i + 1) % n]!
                const lp = Math.hypot(cur.x - prev.x, cur.y - prev.y)
                const ln = Math.hypot(nxt.x - cur.x, nxt.y - cur.y)
                // Only damp when we see very short edges (typical nub signature).
                const w = clamp((minEdge - Math.min(lp, ln)) / minEdge, 0, 1) * nub
                const kLocal = kk * (0.25 + 0.75 * w)
                next.push({
                  x: cur.x + kLocal * ((prev.x + nxt.x) * 0.5 - cur.x),
                  y: cur.y + kLocal * ((prev.y + nxt.y) * 0.5 - cur.y),
                })
              }
              for (let i = 0; i < n; i++) ptsWarp[i] = next[i]!
            }
          }
        }

        // 3) Late circle morph: preserve perimeter order using arclength parameterization.
        // Mapping by polar angle can reorder points and self-intersect (the “inside-out” artifact).
        //
        // Also apply a mild late-stage "surface tension" smoothing in *radius-vs-parameter* space.
        // This specifically combats small lobes/nubbins ("balloon animal" artifacts) that show up
        // near the end (e.g. the T-piece smile + corner blobs).
        //
        // Finally, enforce a consistent "ground plane" (bottom) reference to avoid any perceived
        // rotation: anchor the parameter start at the bottom-most point, and use a fixed downward
        // angle as the phase reference.
        const ptsM: Vec2[] = []
        if (ptsWarp.length >= 3) {
          // Center for radius smoothing: use centroid of the warped loop so the blob stays coherent.
          let cxx = 0
          let cyy = 0
          for (const q of ptsWarp) {
            cxx += q.x
            cyy += q.y
          }
          cxx /= ptsWarp.length
          cyy /= ptsWarp.length

          // Rotate the loop so index 0 is the bottom-most point (stable "ground" anchor).
          let i0 = 0
          let bestY = -Infinity
          let bestDx = Infinity
          for (let i = 0; i < ptsWarp.length; i++) {
            const q = ptsWarp[i]!
            const dx = Math.abs(q.x - cx0)
            if (q.y > bestY + 0.001 || (Math.abs(q.y - bestY) <= 0.001 && dx < bestDx)) {
              bestY = q.y
              bestDx = dx
              i0 = i
            }
          }
          const pts = ptsWarp.slice(i0).concat(ptsWarp.slice(0, i0))

          let total = 0
          const cum: number[] = [0]
          for (let i = 1; i < pts.length; i++) {
            const a0 = pts[i - 1]!
            const b0 = pts[i]!
            total += Math.hypot(b0.x - a0.x, b0.y - a0.y)
            cum.push(total)
          }
          // close
          total += Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y)
          const inv = 1 / Math.max(1e-6, total)

          // Angle parameterization is based on perimeter order (t), not geometric angle.
          // Use a fixed downward phase so the blob doesn't "rotate" as it melts.
          const baseAng = Math.PI / 2

          // Late-stage surface tension: smooth radius along the loop parameter.
          const tension = smoothstep((p - 0.62) / 0.28)
          const n = pts.length
          const angParam: number[] = new Array(n)
          for (let i = 0; i < n; i++) {
            const tt = (cum[i]! * inv) % 1
            angParam[i] = baseAng + tt * Math.PI * 2
          }
          const radii: number[] = new Array(n)
          for (let i = 0; i < n; i++) {
            const dx = pts[i]!.x - cxx
            const dy = pts[i]!.y - cyy
            radii[i] = Math.hypot(dx, dy)
          }
          if (tension > 0.001 && n >= 6) {
            const iters = tension > 0.82 ? 3 : 2
            const alpha = 0.35 * tension
            let r = radii
            for (let it = 0; it < iters; it++) {
              const next = new Array(n)
              for (let i = 0; i < n; i++) {
                const rm1 = r[(i - 1 + n) % n]!
                const r0 = r[i]!
                const rp1 = r[(i + 1) % n]!
                const avg = (rm1 + 2 * r0 + rp1) / 4
                // Stronger smoothing on the *upper* surfaces to remove lingering sag-divots.
                // With baseAng=pi/2, "top" is around ang=-pi/2 (sin is -1).
                const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
                // Increase smoothing as it progresses; reduce slightly once fully circle-morphing.
                const aLocal = alpha * (1 + 0.95 * top01) * (0.8 + 0.2 * (1 - c))
                next[i] = lerp(r0, avg, aLocal)
              }
              r = next
            }
            // Clamp high-frequency bumps AND divots.
            // Max clamp kills tiny lobes; min clamp fills in sharp concave dents that can persist as it shrinks.
            const capHi = Math.max(0.75, fx.cellSize * 0.08) * (1 - 0.35 * c)
            // Keep the allowed "divot depth" quite small on the upper surfaces; otherwise you get
            // those unnatural V-notches that become more pronounced as the blob shrinks.
            const capLoBase = Math.max(0.30, fx.cellSize * 0.04) * (1 - 0.35 * c)
            for (let i = 0; i < n; i++) {
              const rm1 = r[(i - 1 + n) % n]!
              const r0 = r[i]!
              const rp1 = r[(i + 1) % n]!
              const base = (rm1 + rp1) * 0.5
              const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
              const capLo = capLoBase * (1 + 1.55 * top01)
              if (r0 > base + capHi) r[i] = base + capHi
              if (r[i]! < base - capLo) r[i] = base - capLo
            }

            // Explicitly fill persistent V-divots on the upper arc by biasing radii upward
            // toward the neighbor baseline (surface tension "rounds out" dents).
            // This prevents top dents from sharpening as the blob shrinks.
            const fill = smoothstep((p - 0.50) / 0.40) * (1 - 0.15 * c)
            if (fill > 0.001) {
              const passIters = fill > 0.8 ? 2 : 1
              for (let it = 0; it < passIters; it++) {
                const next = r.slice()
                for (let i = 0; i < n; i++) {
                  const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
                  if (top01 < 0.55) continue
                  const rm1 = r[(i - 1 + n) % n]!
                  const r0 = r[i]!
                  const rp1 = r[(i + 1) % n]!
                  const base = (rm1 + rp1) * 0.5
                  // If we're below the baseline (a divot), push up strongly.
                  if (r0 < base) {
                    const k = fill * (0.45 + 0.55 * top01)
                    next[i] = lerp(r0, base, k)
                  }
                }
                r = next
              }
            }
            for (let i = 0; i < n; i++) radii[i] = r[i]!
          }

          for (let i = 0; i < pts.length; i++) {
            const ang = angParam[i]!
            // Use the smoothed radius to build a single-lobed blob, then morph to the final circle.
            const bx = cxx + Math.cos(ang) * radii[i]!
            const by = cyy + Math.sin(ang) * radii[i]!
            const tx = fx.orbFrom.x + Math.cos(ang) * R
            const ty = fx.orbFrom.y + Math.sin(ang) * R
            const x2 = lerp(bx, tx, c)
            const y2 = lerp(by, ty, c)
            ptsM.push({ x: x2, y: y2 })
            minX = Math.min(minX, x2)
            minY = Math.min(minY, y2)
            maxX = Math.max(maxX, x2)
            maxY = Math.max(maxY, y2)
          }
        }

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.shadowColor = heat(meltHue, 255, 80, 80, 85, 62, 0.14)
        ctx.shadowBlur = 12 * (1 - c)
        drawSmoothClosed(ptsM)
        ctx.fillStyle = molten
        ctx.fill()
        ctx.shadowBlur = 0

        // Face lighting + molten flow (clipped) for the whole morph.
        const bbW = Math.max(1, maxX - minX)
        const bbH = Math.max(1, maxY - minY)
        applyDomedDepth(ctx, minX, minY, bbW, bbH, 1.0)

        ctx.save()
        ctx.clip()
        ctx.globalCompositeOperation = 'screen'
        const tt = fx.t * 2.3 + fx.seed
        const bandH = Math.max(10, bbH * 0.28)
        for (let k = 0; k < 3; k++) {
          const yy = minY + ((tt * 34 + k * bandH * 1.25) % (bbH + bandH)) - bandH
          const band = ctx.createLinearGradient(minX, yy, minX, yy + bandH)
          band.addColorStop(0, 'rgba(255,255,255,0)')
          band.addColorStop(0.5, `rgba(255,255,255,${0.10 * (1 - c)})`)
          band.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = band
          ctx.fillRect(minX - 2, yy, bbW + 4, bandH)
        }
        ctx.restore()

        ctx.restore()
        ctx.restore() // melt perspective transform
      }
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

        // black hole
        const bh = f
        const cx = visualPos.x + bh.cellSize * 0.5
        const cy = visualPos.y + bh.cellSize * 0.5
        const rCore = bh.rCore
        const rInf = bh.rInfluence

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'

        // Subtle influence boundary (helps players read gravity radius).
        // Drawn behind the core effects and kept very faint.
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = 'rgba(255,190,120,0.08)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([6, 10])
        ctx.beginPath()
        ctx.arc(cx, cy, rInf, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
        // very soft outer haze ring
        const haze = ctx.createRadialGradient(cx, cy, rInf * 0.92, cx, cy, rInf)
        haze.addColorStop(0, 'rgba(255,190,120,0)')
        haze.addColorStop(1, 'rgba(255,120,210,0.05)')
        ctx.fillStyle = haze
        ctx.beginPath()
        ctx.arc(cx, cy, rInf, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        // Dark core
        ctx.fillStyle = 'rgba(5,3,10,0.95)'
        ctx.beginPath()
        ctx.arc(cx, cy, rCore, 0, Math.PI * 2)
        ctx.fill()

        // Accretion ring (neon edge)
        ctx.globalCompositeOperation = 'lighter'
        const ringR = rCore * 1.35
        const ring = ctx.createRadialGradient(cx, cy, rCore * 0.85, cx, cy, ringR)
        ring.addColorStop(0, 'rgba(0,0,0,0)')
        ring.addColorStop(0.55, 'rgba(255,120,210,0.08)')
        ring.addColorStop(0.78, 'rgba(255,190,120,0.18)')
        ring.addColorStop(1, 'rgba(255,120,210,0)')
        ctx.fillStyle = ring
        ctx.beginPath()
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
        ctx.fill()

        // Subtle lens sparkle
        ctx.strokeStyle = 'rgba(255,255,255,0.10)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(cx, cy, rCore * 0.85, 0, Math.PI * 2)
        ctx.stroke()

        ctx.restore()
        ctx.restore() // feature perspective transform
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

    // HUD module: bottom-right L-shape (single container + single outline).
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    // Heat meter: the vertical bar charges as you chain kills and, when full,
    // fires Overdrive (a beam surge); during the surge it drains back to empty.
    const heatFrac = clamp(s.heat, 0, 1)
    const overdriveOn = s.overdriveSec > 0
    const comboMult =
      s.combo > 0 ? Math.min(COMBO_SCORE_MULT_CAP, 1 + 0.1 * (s.combo - 1)) : 1
    // Active combo pierce tier (the beam rakes +N extra blocks while hot).
    const comboPierceTier =
      s.combo >= COMBO_PIERCE_TIER2 ? 2 : s.combo >= COMBO_PIERCE_TIER1 ? 1 : 0
    // The corner dial ring now reflects the crescendo (big-play surge).
    const crescendoArc = clamp(s.crescendo, 0, 1)

    // Geometry: union shape = vertical bar (xp) + horizontal cap (stats), with a dial in the elbow.
    const barX = gx
    const barY = gy
    const barW = gw
    const barH = gh
    const cutRight = s.view.width
    const cutBottom = layout.failY
    const bottomY = barY + barH
    // Horizontal leg height: just enough for the inline score readout with padding.
    const capH = 36
    const capW = 184
    const capX = barX + barW - capW
    const capY = bottomY - capH
    const dialD = 38
    const dialR = dialD / 2
    const dialCX = barX + barW - dialR - 8
    const dialCY = bottomY - dialR - 8
    // Leave a little more breathing room above the dial intrusion.
    const dialTop = dialCY - dialR - 14

    const lPath = (outerR: number) => {
      const r = outerR
      const vx0 = barX
      // Extend beyond the right edge so rounding gets clipped into a flat edge.
      const vx1 = cutRight + r
      const vy0 = barY
      // Extend beyond the death line so rounding gets clipped into a flat edge.
      const vy1 = cutBottom + r
      const hx0 = capX
      const hy0 = capY
      // "Skin bulge" around the dial: round the inner corner using an arc around the dial center.
      const bulgeR = dialR + 9

      ctx.beginPath()
      ctx.moveTo(vx1 - r, vy0)
      ctx.arcTo(vx1, vy0, vx1, vy0 + r, r)
      ctx.lineTo(vx1, vy1 - r)
      ctx.arcTo(vx1, vy1, vx1 - r, vy1, r)
      ctx.lineTo(hx0 + r, vy1)
      ctx.arcTo(hx0, vy1, hx0, vy1 - r, r)
      ctx.lineTo(hx0, hy0 + r)
      ctx.arcTo(hx0, hy0, hx0 + r, hy0, r)
      // Inner elbow: replace sharp corner with a circular intrusion so the dial feels like it's
      // pushing out the skin of the HUD, while keeping consistent padding.
      const dy = hy0 - dialCY
      const dx = vx0 - dialCX
      const canBulge = bulgeR * bulgeR > dy * dy && bulgeR * bulgeR > dx * dx
      if (canBulge) {
        const xJoin = dialCX - Math.sqrt(Math.max(0, bulgeR * bulgeR - dy * dy))
        const yJoin = dialCY - Math.sqrt(Math.max(0, bulgeR * bulgeR - dx * dx))
        // Join from horizontal top edge to arc start.
        ctx.lineTo(xJoin, hy0)
        const a0 = Math.atan2(hy0 - dialCY, xJoin - dialCX)
        const a1 = Math.atan2(yJoin - dialCY, vx0 - dialCX)
        // Sweep through the upper-left quadrant around the dial.
        ctx.arc(dialCX, dialCY, bulgeR, a0, a1, true)
        ctx.lineTo(vx0, yJoin)
      } else {
        ctx.lineTo(vx0, hy0)
      }
      ctx.lineTo(vx0, vy0 + r)
      ctx.arcTo(vx0, vy0, vx0 + r, vy0, r)
      ctx.closePath()
    }

    // Single container fill + single outline (no overlapping boxes), clipped to:
    // - right edge of the screen
    // - bottom edge at the death line
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.beginPath()
    ctx.rect(0, 0, cutRight, cutBottom)
    ctx.clip()
    const outerR = 18
    const bg = ctx.createLinearGradient(0, barY, 0, bottomY)
    bg.addColorStop(0, 'rgba(9, 12, 22, 0.72)')
    bg.addColorStop(1, 'rgba(6, 8, 16, 0.58)')
    ctx.fillStyle = bg
    lPath(outerR)
    ctx.fill()
    // Panel edge: subtly rides the music hue when playing (cold cyan when off),
    // so the HUD frame breathes with the rest of the scene without losing legibility.
    ctx.strokeStyle = mi > 0 ? hsl(mHue, 70, 78, 0.2) : 'rgba(143, 224, 255, 0.16)'
    ctx.lineWidth = 1.25
    lPath(outerR)
    ctx.stroke()
    ctx.restore()

    // XP groove + fill (kept above the dial so nothing overlaps).
    {
      const gx2 = barX + 7
      // Extra top padding reserves a clean header band for the charge % readout
      // above the groove (so it never crowds the bar or the 25% markers).
      const gy2 = barY + 22
      const gw2 = barW - 14
      const gh2 = Math.max(26, dialTop - gy2)
      const groove = ctx.createLinearGradient(0, gy2, 0, gy2 + gh2)
      groove.addColorStop(0, 'rgba(0,0,0,0.38)')
      groove.addColorStop(1, 'rgba(255,255,255,0.05)')
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = groove
      roundedRectPath(gx2, gy2, gw2, gh2, 10)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      roundedRectPath(gx2, gy2, gw2, gh2, 10)
      ctx.stroke()

      // Armed = topped out and banked, waiting for the player's tap. A slower,
      // brighter "breathing" gold pulse so the gauge reads READY — distinct from
      // the faster flicker of an in-progress surge.
      const armed = s.overdriveArmed && !overdriveOn
      const charged = overdriveOn || armed
      const odPulse = overdriveOn ? 0.7 + 0.3 * Math.sin(s.timeSec * 18) : 1
      const armPulse = 0.6 + 0.4 * Math.sin(s.timeSec * 6.5)
      const pulseA = overdriveOn ? odPulse : armed ? armPulse : 1

      const fh = gh2 * heatFrac
      ctx.globalCompositeOperation = 'lighter'
      // Heat fill: a warm "charge" that brightens as it fills; charged (armed or
      // mid-surge) it flips to a pulsing white-gold.
      const heatHue = charged ? 45 : 28
      const heatA = (overdriveOn ? 0.55 : armed ? 0.6 : 0.2 + 0.25 * heatFrac) * pulseA
      ctx.fillStyle = hsl(heatHue, 95, 58, heatA)
      roundedRectPath(gx2, gy2 + (gh2 - fh), gw2, fh, 10)
      ctx.fill()
      ctx.fillStyle = hsl(heatHue, 98, charged ? 90 : 62 + 16 * heatFrac, 0.82 * pulseA)
      roundedRectPath(gx2 + 1, gy2 + (gh2 - fh) + 1, gw2 - 2, Math.max(0, fh - 2), 9)
      ctx.fill()

      // Banking the NEXT charge: motes collected during a surge bank separately
      // and seed the next charge when the surge ends. Show it as a cool-cyan
      // underlay rising from the bottom (distinct from the draining gold surge),
      // so collecting mid-Overdrive visibly pays.
      if (overdriveOn && s.heatNext > 0) {
        const bh = gh2 * clamp(s.heatNext, 0, 1)
        ctx.fillStyle = hsl(190, 92, 62, 0.5)
        roundedRectPath(gx2 + 2, gy2 + (gh2 - bh), gw2 - 4, bh, 9)
        ctx.fill()
      }

      // Segment the groove into 4 pips at 25/50/75% so partial charge reads at a
      // glance. Engraved look: a dark cut with a 1px light bevel beneath, plus
      // bright nubs biting in from both edges so the divisions stay distinct over
      // the fill instead of washing out.
      ctx.globalCompositeOperation = 'source-over'
      const nub = 4
      for (let i = 1; i < 4; i++) {
        const ty2 = Math.round(gy2 + (gh2 * i) / 4) + 0.5
        // Engraved groove line: dark cut + light bevel highlight below it.
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(gx2 + 2, ty2)
        ctx.lineTo(gx2 + gw2 - 2, ty2)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'
        ctx.beginPath()
        ctx.moveTo(gx2 + 2, ty2 + 1)
        ctx.lineTo(gx2 + gw2 - 2, ty2 + 1)
        ctx.stroke()
        // Edge nubs: short, bright ticks biting inward from each side.
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(gx2, ty2)
        ctx.lineTo(gx2 + nub, ty2)
        ctx.moveTo(gx2 + gw2 - nub, ty2)
        ctx.lineTo(gx2 + gw2, ty2)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'lighter'

      // Armed: a breathing glow ring hugging the whole groove so the charged
      // meter pops even in peripheral vision while the eye is on the beam.
      if (armed) {
        ctx.save()
        ctx.shadowColor = hsl(45, 100, 65, 0.9)
        ctx.shadowBlur = 10 + 12 * armPulse
        ctx.strokeStyle = hsl(48, 100, 72, 0.5 + 0.4 * armPulse)
        ctx.lineWidth = 2
        roundedRectPath(gx2, gy2, gw2, gh2, 10)
        ctx.stroke()
        ctx.restore()
      }

      // Groove label. Normal play: the charge level (0-100%), so the "+N" mote
      // floaters visibly accrue toward it (the combo multiplier moved to the
      // score leg, where it reads as the score multiplier it is). Armed: a
      // vertical "TAP TO FIRE" running up the bar — it fits the tall, narrow
      // gauge and fuses the ready-state with the call-to-action.
      ctx.globalCompositeOperation = 'source-over'
      const cxBar = barX + barW / 2
      if (armed) {
        ctx.save()
        ctx.translate(cxBar, gy2 + gh2 / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        try {
          ctx.letterSpacing = '3px'
        } catch {
          /* older engines: skip */
        }
        ctx.font = "900 15px 'Oxanium', system-ui, sans-serif"
        // Dark ink on the bright gold fill (with a faint light halo so it stays
        // crisp); a gentle alpha breath keeps it alive.
        ctx.shadowColor = hsl(50, 100, 92, 0.55)
        ctx.shadowBlur = 5
        ctx.fillStyle = `rgba(36,22,0,${(0.82 + 0.18 * armPulse).toFixed(3)})`
        ctx.fillText('TAP TO FIRE', 0, 0)
        try {
          ctx.letterSpacing = '0px'
        } catch {
          /* noop */
        }
        ctx.restore()
      } else {
        // Bespoke charge readout: a clean number seated in the header band ABOVE
        // the groove (out of the 25% marker zone). Sized to fit the narrow 34px
        // bar with comfortable padding — the digits carry the value, with a small
        // raised "%" superscript. (At 100% the bar arms and shows TAP TO FIRE, so
        // this only ever renders 1-2 digits.)
        const pct = Math.round(heatFrac * 100)
        const numStr = `${pct}`
        const hy = barY + 12
        const numFont = "800 13px 'Oxanium', system-ui, sans-serif"
        const pctFont = "800 8px 'Oxanium', system-ui, sans-serif"
        const gap = 1.5
        ctx.save()
        ctx.textBaseline = 'middle'
        ctx.shadowColor = 'rgba(0,0,0,0.6)'
        ctx.shadowBlur = 3
        ctx.font = numFont
        const numW = ctx.measureText(numStr).width
        ctx.font = pctFont
        const pctW = ctx.measureText('%').width
        const total = numW + gap + pctW
        const startX = cxBar - total / 2
        const lift = 16 + 30 * heatFrac
        // Number — warms and brightens as the charge climbs.
        ctx.textAlign = 'left'
        ctx.font = numFont
        ctx.fillStyle = hsl(44, 92, 56 + lift, 0.72 + 0.28 * heatFrac)
        ctx.fillText(numStr, startX, hy)
        // "%" — smaller, dimmer, raised as a superscript for a polished look.
        ctx.font = pctFont
        ctx.fillStyle = hsl(44, 70, 66 + lift * 0.4, 0.55 + 0.3 * heatFrac)
        ctx.fillText('%', startX + numW + gap, hy - 3)
        ctx.restore()
      }
      ctx.restore()
    }

    // Gauge floaters: "+N" feedback popped on mote collection so the player SEES
    // a pickup's worth — and that combo/gold make motes worth more. Color codes
    // the state: gold charge, cool-cyan banked-to-next, bright-gold overflow score.
    if (s.gaugeFx.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.textBaseline = 'middle'
      for (const fx of s.gaugeFx) {
        const p = clamp(fx.t / fx.dur, 0, 1)
        const a = (1 - p) * 0.95
        const col =
          fx.kind === 'score'
            ? hsl(45, 100, 70, a)
            : fx.kind === 'bank'
              ? hsl(190, 92, 72, a)
              : hsl(48, 96, 78, a)
        ctx.fillStyle = col
        if (fx.x != null && fx.y != null) {
          // Anchored (overflow score absorbed by the well): projected + lifted
          // above the hole so it clears the player's finger.
          ctx.font = "900 13px 'Oxanium', system-ui, sans-serif"
          ctx.textAlign = 'center'
          const jitter = ((fx.id % 5) - 2) * 7
          let ax = fx.x
          let ay = fx.y
          if (fx.world) {
            const wp = project(fx.x, fx.y)
            ax = wp.x
            ay = wp.y - 44
          }
          ctx.fillText(fx.text, ax + jitter, ay - 30 * p)
        } else {
          // Gauge stream: a staggered ledger rising just LEFT of the bar. Five
          // vertical slots keyed off the id keep rapid pickups from piling onto
          // each other, and right-alignment keeps them clear of the bar/markers.
          ctx.font = "800 12px 'Oxanium', system-ui, sans-serif"
          ctx.textAlign = 'right'
          const slot = fx.id % 5
          const baseY = barY + 20 + slot * 13
          ctx.fillText(fx.text, barX - 8, baseY - 34 * p)
        }
      }
      ctx.restore()
    }

    // Corner dial: DEPTH (the primary "how deep" stat). The ring now lights with
    // the crescendo so big plays flare the HUD.
    {
      const cx = dialCX
      const cy = dialCY
      const rr = dialR
      const dialHue = mi > 0 ? mHue : PALETTE.latticeHue
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      const disc = ctx.createRadialGradient(cx, cy, 1, cx, cy, rr)
      disc.addColorStop(0, 'rgba(0,0,0,0.12)')
      disc.addColorStop(1, 'rgba(0,0,0,0.28)')
      ctx.fillStyle = disc
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Crescendo ring (full sweep, brightness driven by the surge).
      if (crescendoArc > 0.02) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = hsl(dialHue, 95, 65, 0.25 + 0.6 * crescendoArc)
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(cx, cy, rr - 1.5, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "950 15px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,246,213,0.95)'
      ctx.fillText(`${s.depth}`, cx, cy + 0.5)
      ctx.restore()
    }

    // Score readout in the leg. The score is the hero, right-anchored at the dial
    // so it never leaps. The combo multiplier is restrained gold text grouped
    // immediately to the LEFT of the score (gold = its identity, distinct from the
    // white score it multiplies) — it brightens with a quick lift on each kill and
    // fades as the window lapses. No pill: it matches the HUD's text-readout style.
    {
      const insetR = dialCX - dialR - 20
      const ty = capY + capH / 2 + 0.5
      const scoreStr = s.score.toLocaleString()
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.textBaseline = 'middle'
      // Score (hero).
      ctx.textAlign = 'right'
      ctx.font = "900 17px 'Oxanium', system-ui, sans-serif"
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 3
      ctx.fillStyle = 'rgba(255,248,232,0.98)'
      ctx.fillText(scoreStr, insetR, ty)
      const scoreW = ctx.measureText(scoreStr).width
      ctx.shadowBlur = 0
      // Combo multiplier — gold text just left of the score.
      if (comboMult > 1) {
        const fresh = clamp((s.comboTimerSec - 3.55) / 0.45, 0, 1)
        const fade = clamp(s.comboTimerSec / 0.5, 0, 1)
        const label = `×${comboMult.toFixed(1)}`
        // Reactive: ride the music hue (like the rest of the scene); fall back to
        // the gold accent when music is off.
        const comboHue = mi > 0 ? mHue : 46
        ctx.textAlign = 'right'
        ctx.font = "800 14px 'Oxanium', system-ui, sans-serif"
        // Warmup COMBO beat: a fitted glowing pill behind the multiplier so the
        // player's eye is drawn to the thing the callout is talking about.
        if (s.tutorial?.phase === 'warmup' && s.tutorial.beat === 'combo') {
          const lw = ctx.measureText(label).width
          const lx = insetR - scoreW - 9
          const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(s.timeSec * 4))
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.lineWidth = 2.5
          ctx.strokeStyle = hsl(46, 100, 70, 0.9 * pulse)
          ctx.shadowColor = hsl(46, 100, 64, 0.85)
          ctx.shadowBlur = 14
          roundedRectPath(lx - lw - 7, ty - 12, lw + 14, 24, 8)
          ctx.stroke()
          ctx.restore()
        }
        ctx.shadowColor = hsl(comboHue, 100, 60, (0.5 + 0.4 * fresh) * fade)
        ctx.shadowBlur = 5 + 6 * fresh
        ctx.fillStyle = hsl(comboHue, 100, 62 + 12 * fresh, (0.85 + 0.15 * fresh) * fade)
        ctx.fillText(label, insetR - scoreW - 9, ty)
        ctx.shadowBlur = 0
        // Combo pierce tier: a small "PIERCE +N" tag under the multiplier so the
        // earned beam penetration is legible (it's the chain's real payoff).
        if (comboPierceTier > 0) {
          ctx.font = "800 9px 'Oxanium', system-ui, sans-serif"
          ctx.shadowColor = hsl(comboHue, 100, 60, 0.4 * fade)
          ctx.shadowBlur = 4
          ctx.fillStyle = hsl(comboHue, 90, 74, 0.9 * fade)
          ctx.fillText(`PIERCE +${comboPierceTier}`, insetR - scoreW - 9, ty + 13)
          ctx.shadowBlur = 0
        }
      }
      ctx.restore()
    }

    // Best score readout: a small, dim line above the leg (its original home), so
    // the leg's proportions stay clean.
    if (s.bestScoreLocal > 0 || s.score > 0) {
      const bestLive = Math.max(s.bestScoreLocal, s.score)
      const label = `BEST ${bestLive.toLocaleString()}`
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "800 12px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 3
      ctx.fillStyle = hsl(46, 30, 84, 0.62)
      ctx.fillText(label, dialCX - dialR - 20, capY - 12)
      ctx.restore()
    }

    // XP orbs (condense -> fly).
    if (s.xpOrbs.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const orb of s.xpOrbs) {
        // The orb starts on the (projected) dying piece and flies to the XP
        // gauge, which is screen-space HUD. So project the start, then lerp in
        // screen space toward the unprojected gauge target, easing the depth
        // scale back to 1 as it arrives at the HUD.
        const fromS = project(orb.from.x, orb.from.y)
        const tt = Math.pow(clamp(orb.t / XP_ORB_FLY_DUR, 0, 1), 0.75)
        const px = orb.phase === 'condense' ? fromS.x : fromS.x + (orb.to.x - fromS.x) * tt
        const py = orb.phase === 'condense' ? fromS.y : fromS.y + (orb.to.y - fromS.y) * tt
        const z = orb.phase === 'condense' ? fromS.scale : lerp(fromS.scale, 1, tt)
        const r = (orb.phase === 'condense' ? 16 * (1 - clamp(orb.t / XP_ORB_CONDENSE_DUR, 0, 1)) + 4 : 5) * z
        // Dead-piece ember: follows the live hue (red when music off).
        const oHue = hueAt(orb.from.x, orb.from.y)
        ctx.fillStyle = heat(oHue, 255, 59, 92, 85, 60, 0.32)
        ctx.beginPath()
        ctx.arc(px, py, r * 2.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = heat(oHue, 255, 59, 92, 85, 62, 0.92)
        ctx.beginPath()
        ctx.arc(px, py, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // Heat motes: glowing debris from destroyed blocks. Loose motes hover in the
    // field (world-space, projected like sparks); once the well captures one it
    // flies (screen-space) to the heat gauge and winks out as it delivers.
    if (s.heatMotes.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const hgw = layout.xpGauge.w
      const hgh = layout.xpGauge.h
      const gaugeTx = layout.xpGauge.x + hgw / 2
      const gaugeTy = layout.xpGauge.y + (hgh - hgh * clamp(s.heat, 0, 1))
      ctx.lineCap = 'round'
      for (const m of s.heatMotes) {
        const mHue = hueAt(m.x, m.y)
        // Surge-spawned debris is worth a fraction of charge, so it reads dimmer.
        const dimMul = m.dim ? 0.5 : 1
        if (m.collecting) {
          // Fly from the projected capture point to the screen-space gauge, with a
          // short comet tail pointing back along the flight path.
          const tt = Math.pow(clamp(m.ct / m.cdur, 0, 1), 0.7)
          const fromS = project(m.cfx, m.cfy)
          const px = fromS.x + (gaugeTx - fromS.x) * tt
          const py = fromS.y + (gaugeTy - fromS.y) * tt
          const z = lerp(fromS.scale, 1, tt)
          const r = (2.2 + 1.8 * (1 - tt)) * z + 1.4
          const dxs = gaugeTx - fromS.x
          const dys = gaugeTy - fromS.y
          const dl = Math.hypot(dxs, dys) || 1
          const tlen = (14 + 26 * (1 - tt)) * z
          const bx = px - (dxs / dl) * tlen
          const by = py - (dys / dl) * tlen
          ctx.strokeStyle = heat(mHue, 255, 150, 70, 85, 60, 0.5 * dimMul)
          ctx.lineWidth = Math.max(1, r * 1.1)
          ctx.beginPath()
          ctx.moveTo(bx, by)
          ctx.lineTo(px, py)
          ctx.stroke()
          ctx.fillStyle = heat(mHue, 255, 180, 90, 85, 66, 0.32 * dimMul)
          ctx.beginPath()
          ctx.arc(px, py, r * 2.4, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = heat(mHue, 255, 222, 140, 85, 72, 0.95 * dimMul)
          ctx.beginPath()
          ctx.arc(px, py, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = `rgba(255,250,240,${(0.9 * dimMul).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(px, py, Math.max(0.7, r * 0.5), 0, Math.PI * 2)
          ctx.fill()
        } else {
          // Loose ember: a flickering hot cinder with a velocity-aligned tail. At
          // rest it twinkles like a coal; once the well hooks it the tail stretches
          // into a bright streak racing inward.
          const flick = 0.7 + 0.3 * Math.sin(tNow * (8 + (m.seed % 5)) + m.seed)
          const sp = project(m.x, m.y - s.dropAnimOffset)
          const z = sp.scale
          const a = (m.hooked ? 1 : 0.9) * flick * dimMul
          const r = m.size * 0.85 * z + 0.9
          // LOD: far up the board a mote is only a few px; the halo/tail/twinkle
          // are imperceptible there, so collapse to a single ember dot.
          // Keeps full detail for near motes.
          if (z < 0.32) {
            ctx.fillStyle = heat(mHue, 255, 205, 115, 85, 66, 0.95 * a)
            ctx.beginPath()
            ctx.arc(sp.x, sp.y, Math.max(0.8, r * 1.15), 0, Math.PI * 2)
            ctx.fill()
            continue
          }
          const speed = Math.hypot(m.vx, m.vy)
          const dirx = speed > 1e-3 ? m.vx / speed : 0
          const diry = speed > 1e-3 ? m.vy / speed : 0
          const tailLen = Math.min(36, speed * 0.026 + (m.hooked ? 9 : 1.5))
          const back = project(m.x - dirx * tailLen, m.y - diry * tailLen - s.dropAnimOffset)

          // Soft outer glow.
          ctx.fillStyle = heat(mHue, 255, 150, 70, 82, 60, 0.22 * a)
          ctx.beginPath()
          ctx.arc(sp.x, sp.y, r * 2.8, 0, Math.PI * 2)
          ctx.fill()

          // Comet tail: warm wide pass + bright thin core.
          ctx.strokeStyle = heat(mHue, 255, 120, 50, 85, 58, 0.4 * a)
          ctx.lineWidth = Math.max(1, r * 1.3)
          ctx.beginPath()
          ctx.moveTo(back.x, back.y)
          ctx.lineTo(sp.x, sp.y)
          ctx.stroke()
          ctx.strokeStyle = heat(mHue, 255, 210, 120, 88, 70, 0.72 * a)
          ctx.lineWidth = Math.max(0.8, r * 0.6)
          ctx.beginPath()
          ctx.moveTo(back.x, back.y)
          ctx.lineTo(sp.x, sp.y)
          ctx.stroke()

          // White-hot head.
          ctx.fillStyle = `rgba(255,250,240,${(0.92 * a).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(sp.x, sp.y, Math.max(0.8, r * 0.7), 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.restore()
    }

    // Welding hit FX sparks at beam contact points. (The on-piece hot-spot glow
    // is baked into the piece body in drawPieceBody so it rides the 3D top face;
    // here we only fling the sparks, lifted onto that top face.)
    if (s.sparks.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'

      // Lift FX off the plane onto the piece top face (sparks spawn at beam/piece
      // contacts). The GL shader raises a point of height z up-screen by z*scale.
      const fxLift = (sortedBlocks[0]?.cellSize ?? 40) * PIECE_EXTRUDE
      const projLifted = (x: number, y: number) => {
        const pp = project(x, y)
        pp.y -= fxLift * pp.scale
        return pp
      }

      // Sparks
      for (const p of s.sparks) {
        const t = clamp(p.age / Math.max(0.0001, p.life), 0, 1)
        const a = (1 - t) * (0.45 + 0.65 * p.heat)
        // Hot metal spark: white -> yellow -> hue-tinted tail (rainbow with the
        // music; pink when off). Cold "deflection" sparks (armored shield hit)
        // instead read icy blue-white so a no-damage hit is unmistakable.
        const c0 = p.cold
          ? `rgba(232,244,255,${0.95 * a})`
          : `rgba(255,252,240,${0.95 * a})`
        const c1 = p.cold
          ? `rgba(150,200,255,${0.8 * a})`
          : `rgba(255,210,140,${0.75 * a})`
        const c2 = p.cold
          ? `rgba(90,150,235,${0.5 * a})`
          : heat(hueAt(p.x, p.y), 255, 120, 210, 85, 65, 0.35 * a)

        const tail = 0.018 + 0.022 * p.heat
        // Project the streak endpoints (lifted onto the piece top face) and scale
        // its weight with depth.
        const z = scaleAt(p.y)
        const head = projLifted(p.x, p.y)
        const back = projLifted(p.x - p.vx * tail, p.y - p.vy * tail)

        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(1, p.size) * z
        ctx.strokeStyle = c2
        ctx.beginPath()
        ctx.moveTo(back.x, back.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()

        ctx.lineWidth = Math.max(0.8, p.size * 0.65) * z
        ctx.strokeStyle = c1
        ctx.beginPath()
        ctx.moveTo(back.x, back.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()

        ctx.fillStyle = c0
        ctx.beginPath()
        ctx.arc(head.x, head.y, Math.max(0.9, p.size * 0.55) * z, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()
    }

    // Laser segments.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // IMPORTANT: draw contiguous segments as a single polyline so we don't get bright "striations"
    // at every vertex (per-segment round caps overlap heavily, especially on curved black-hole arcs).
    const stitched: Array<{ pts: Vec2[]; intensity: number }> = []
    const eps2 = 0.9 * 0.9
    const intEps = 0.035
    for (const seg of s.laser.segments) {
      const dx = seg.b.x - seg.a.x
      const dy = seg.b.y - seg.a.y
      if (dx * dx + dy * dy < 0.0001) continue

      const last = stitched[stitched.length - 1]
      if (last) {
        const p = last.pts[last.pts.length - 1]!
        const dxa = seg.a.x - p.x
        const dya = seg.a.y - p.y
        const canJoin = dxa * dxa + dya * dya <= eps2 && Math.abs(last.intensity - seg.intensity) <= intEps
        if (canJoin) {
          last.pts.push(seg.b)
          continue
        }
      }
      stitched.push({ pts: [seg.a, seg.b], intensity: seg.intensity })
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pathLen = (pts: Vec2[]) => {
      let L = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!
        const b = pts[i]!
        L += Math.hypot(b.x - a.x, b.y - a.y)
      }
      return L
    }

    const pointAndTanAt = (pts: Vec2[], dist: number): { p: Vec2; tan: Vec2 } | null => {
      if (pts.length < 2) return null
      let acc = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!
        const b = pts[i]!
        const segL = Math.hypot(b.x - a.x, b.y - a.y)
        if (segL <= 1e-6) continue
        if (acc + segL >= dist) {
          const t = clamp((dist - acc) / segL, 0, 1)
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          const inv = 1 / segL
          const tan = { x: (b.x - a.x) * inv, y: (b.y - a.y) * inv }
          return { p, tan }
        }
        acc += segL
      }
      // Past the end: return last segment tangent.
      const a = pts[pts.length - 2]!
      const b = pts[pts.length - 1]!
      const segL = Math.hypot(b.x - a.x, b.y - a.y) || 1
      return { p: { ...b }, tan: { x: (b.x - a.x) / segL, y: (b.y - a.y) / segL } }
    }

    // Build a tapered ribbon polygon from projected screen points + per-vertex
    // half-widths (forward down one side, back up the other). A single filled
    // polygon avoids the bright vertex "striations" that overlapping stroked
    // segments would create, while letting the width shrink with depth.
    const buildRibbon = (scr: Vec2[], halfAt: number[]) => {
      const n = scr.length
      if (n < 2) return
      const nrm: Vec2[] = []
      for (let i = 0; i < n; i++) {
        let nx = 0
        let ny = 0
        if (i > 0) {
          const a = scr[i - 1]!
          const b = scr[i]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const l = Math.hypot(dx, dy) || 1
          nx += -dy / l
          ny += dx / l
        }
        if (i < n - 1) {
          const a = scr[i]!
          const b = scr[i + 1]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const l = Math.hypot(dx, dy) || 1
          nx += -dy / l
          ny += dx / l
        }
        const l = Math.hypot(nx, ny) || 1
        nrm.push({ x: nx / l, y: ny / l })
      }
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const p = scr[i]!
        const m = nrm[i]!
        const h = halfAt[i]!
        const x = p.x + m.x * h
        const y = p.y + m.y * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      for (let i = n - 1; i >= 0; i--) {
        const p = scr[i]!
        const m = nrm[i]!
        const h = halfAt[i]!
        ctx.lineTo(p.x - m.x * h, p.y - m.y * h)
      }
      ctx.closePath()
    }

    // Overdrive: the beam fattens and flips to a white-gold while the surge is up.
    const overdrive = s.overdriveSec > 0
    const odWidth = overdrive ? 1.45 : 1
    for (let li = 0; li < stitched.length; li++) {
      const line = stitched[li]!
      const alpha = clamp(line.intensity, 0, 1)
      if (alpha <= 0) continue

      // Project each vertex; keep the per-vertex depth scale so the beam narrows
      // as it falls toward the horizon, matching the grid.
      const scr: Vec2[] = []
      const sc: number[] = []
      for (const wp of line.pts) {
        const pp = project(wp.x, wp.y)
        scr.push({ x: pp.x, y: pp.y })
        sc.push(pp.scale)
      }
      if (scr.length < 2) continue

      // Laser palette: red by default, but the beam drifts through the rainbow
      // hue with the music. Motion is smooth (sustained energy), never beat-keyed,
      // so the width only breathes a few percent. The hot core stays bright.
      const beamSwell = (1 + mPulse * 0.16 + mBass * 0.1) * odWidth
      const glowAlpha = Math.min(0.7, (0.16 + (overdrive ? 0.16 : 0)) * alpha * (1 + mPulse * 0.6))
      const coreAlpha = Math.min(1, (0.78 + (overdrive ? 0.15 : 0)) * alpha)

      // Outer glow ribbon. A faint lateral shimmer (heat-haze) wobbles the glow
      // edge so the beam reads as superheated air; the core/spine below stay
      // crisp on the unjittered path so aim never looks fuzzy.
      const glowHalf = sc.map((z) => s.stats.beamGlowWidth * beamSwell * 0.5 * z)
      const hazeScr = scr.map((p, i) => ({
        x: p.x + Math.sin(tNow * 7 + line.pts[i]!.y * 0.05 + i * 0.9) * 1.2 * sc[i]!,
        y: p.y,
      }))
      ctx.fillStyle = overdrive
        ? hsl(PALETTE.energyGoldHue, 100, 60, glowAlpha)
        : mi > 0
          ? hsl(mHue, 95, 62, glowAlpha)
          : hsl(PALETTE.energyHue, 100, 56, glowAlpha)
      buildRibbon(hazeScr, glowHalf)
      ctx.fill()

      // Core ribbon (restroke same path) — kept bright (high lightness).
      const coreHalf = sc.map((z) => s.stats.beamWidth * 0.5 * odWidth * z)
      ctx.fillStyle = overdrive
        ? hsl(PALETTE.energyGoldHue, 100, 82, coreAlpha)
        : mi > 0
          ? hsl(mHue, 90, 72, coreAlpha)
          : hsl(PALETTE.energyHue, 100, 72, coreAlpha)
      buildRibbon(scr, coreHalf)
      ctx.fill()

      // Hot white spine — a thin near-white inner ribbon so the beam reads as a
      // superheated filament rather than a flat tube.
      const spineHalf = sc.map((z) => s.stats.beamWidth * 0.22 * odWidth * z)
      ctx.fillStyle = overdrive
        ? `rgba(255,252,240,${Math.min(1, 0.8 * alpha).toFixed(3)})`
        : mi > 0
          ? hsl(mHue, 100, 93, Math.min(1, 0.62 * alpha))
          : `rgba(255,244,224,${(0.62 * alpha).toFixed(3)})`
      buildRibbon(scr, spineHalf)
      ctx.fill()

      // Animated pulse streak: a white scanline (perpendicular to the beam) that travels forward.
      const L = pathLen(line.pts)
      if (L > 6) {
        const speedPxPerSec = 410
        const spacing = 240 // distance between pulses on long beams
        const base = (s.timeSec * speedPxPerSec + li * 37) % (spacing * 4)
        const pulses = Math.max(1, Math.min(3, Math.floor(L / spacing)))
        for (let k = 0; k < pulses; k++) {
          const d = (base + k * spacing) % L
          const pt = pointAndTanAt(line.pts, d)
          if (!pt) continue
          const perp = { x: -pt.tan.y, y: pt.tan.x }
          // Streak length matches the *core* beam width (project both ends so it
          // shrinks with depth too).
          const half = s.stats.beamWidth * 0.52
          const a1 = project(pt.p.x - perp.x * half, pt.p.y - perp.y * half)
          const a2 = project(pt.p.x + perp.x * half, pt.p.y + perp.y * half)

          // Thin crisp white streak (no wide glow band).
          ctx.strokeStyle = `rgba(255,255,255,${0.55 * alpha})`
          ctx.lineWidth = Math.max(2, s.stats.beamWidth * 0.84 * scaleAt(pt.p.y))
          ctx.beginPath()
          ctx.moveTo(a1.x, a1.y)
          ctx.lineTo(a2.x, a2.y)
          ctx.stroke()
        }
      }
    }
    ctx.restore()

    // Static laser emitter. A floor-mounted focusing array, rendered as a real
    // object: a curved gunmetal housing with lit/shadowed bevels, a recessed
    // machined lens dish drawn in perspective, twin focusing rails framing the
    // aperture, and a plasma core with a throat glow + flickering arcs. Drawn in
    // SCREEN space at the near plane (project() is the identity here), so the
    // aperture sits exactly on the beam root at bottom-center. Everything rides
    // the music hue/energy.
    {
      const W = s.view.width
      const cx2 = W / 2
      const baseY = layout.emitterY
      const emHue = mi > 0 ? mHue : PALETTE.energyHue
      const beat = s.music.beat * mi
      const breath = 0.5 + 0.5 * Math.sin(tNow * 2.4)
      const glow = clamp(0.4 + 0.45 * mEnergy + 0.18 * breath + 0.35 * beat, 0, 1.4)
      // Fast charge throb for the energy that fills the recessed niches — a base
      // pulse lifted by live energy and punched on the beat, so the hollows read
      // as live plasma chambers rather than ambiguous dark geometry.
      const pulse = 0.5 + 0.5 * Math.sin(tNow * 5.2 + beat * 4)
      const energy = clamp((0.45 + 0.55 * mEnergy) * (0.55 + 0.45 * pulse) + 0.4 * beat, 0, 1.3)
      const halfW = Math.min(W * 0.34, 240)

      // Smooth swept top edge of the housing (reused for fill, clip, and the
      // bevel highlight). `dy` offsets it for the inner highlight pass.
      const traceTop = (dy: number): void => {
        ctx.moveTo(cx2 - halfW, baseY + 5 + dy)
        ctx.quadraticCurveTo(cx2 - halfW * 0.7, baseY - 2 + dy, cx2 - halfW * 0.4, baseY - 6 + dy)
        ctx.quadraticCurveTo(cx2 - 58, baseY - 10 + dy, cx2 - 34, baseY - 11 + dy)
        ctx.quadraticCurveTo(cx2, baseY - 13 + dy, cx2 + 34, baseY - 11 + dy)
        ctx.quadraticCurveTo(cx2 + 58, baseY - 10 + dy, cx2 + halfW * 0.4, baseY - 6 + dy)
        ctx.quadraticCurveTo(cx2 + halfW * 0.7, baseY - 2 + dy, cx2 + halfW, baseY + 5 + dy)
      }
      const housingPath = (): void => {
        ctx.beginPath()
        traceTop(0)
        ctx.lineTo(cx2 + halfW - 6, baseY + 16)
        ctx.quadraticCurveTo(cx2, baseY + 19, cx2 - halfW + 6, baseY + 16)
        ctx.closePath()
      }

      ctx.save()

      // (1) Seating shadow — grounds the array into the floor.
      const seat = ctx.createRadialGradient(cx2, baseY + 11, 6, cx2, baseY + 11, halfW * 1.05)
      seat.addColorStop(0, 'rgba(1,1,6,0.6)')
      seat.addColorStop(1, 'rgba(1,1,6,0)')
      ctx.fillStyle = seat
      ctx.beginPath()
      ctx.ellipse(cx2, baseY + 12, halfW * 1.05, 13, 0, 0, Math.PI * 2)
      ctx.fill()

      // (2) Housing body — cool brushed steel, lit at the crest, dark at the base.
      const body = ctx.createLinearGradient(0, baseY - 13, 0, baseY + 18)
      body.addColorStop(0, '#33384e')
      body.addColorStop(0.16, '#222538')
      body.addColorStop(0.5, '#13131f')
      body.addColorStop(1, '#06060e')
      housingPath()
      ctx.fillStyle = body
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.stroke()

      // Inner detail clipped to the housing.
      ctx.save()
      housingPath()
      ctx.clip()

      // (2a) Specular sheen on the upper body.
      const sheen = ctx.createLinearGradient(0, baseY - 13, 0, baseY + 4)
      sheen.addColorStop(0, 'rgba(150,165,210,0.22)')
      sheen.addColorStop(1, 'rgba(150,165,210,0)')
      ctx.fillStyle = sheen
      ctx.fillRect(cx2 - halfW, baseY - 13, halfW * 2, 18)

      // (2b) Bevel highlight tracing the crest — bright at the muzzle, fading out.
      const bevel = ctx.createLinearGradient(cx2 - halfW, 0, cx2 + halfW, 0)
      bevel.addColorStop(0, 'rgba(200,215,255,0)')
      bevel.addColorStop(0.5, `rgba(220,235,255,${(0.5 + 0.35 * glow).toFixed(3)})`)
      bevel.addColorStop(1, 'rgba(200,215,255,0)')
      ctx.strokeStyle = bevel
      ctx.lineWidth = 1.4
      ctx.beginPath()
      traceTop(1.4)
      ctx.stroke()

      // (2c) Engraved panel seams that follow the form (dark groove + lit lip).
      for (const sy of [baseY + 3, baseY + 9]) {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx2 - halfW + 12, sy)
        ctx.quadraticCurveTo(cx2, sy + 2, cx2 + halfW - 12, sy)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(150,160,200,0.10)'
        ctx.beginPath()
        ctx.moveTo(cx2 - halfW + 12, sy - 1)
        ctx.quadraticCurveTo(cx2, sy + 1, cx2 + halfW - 12, sy - 1)
        ctx.stroke()
      }

      // (2d) Heat-sink louvers near each shoulder — slanted slits that glow with
      // pulsing laser energy. A dark groove gives depth; an additive energy core
      // fills it, each notch phase-offset so the bank shimmers along its length.
      for (const sign of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const lx = cx2 + sign * (halfW * 0.5 + k * 7)
          // Recessed groove for depth.
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.moveTo(lx - 3, baseY + 9)
          ctx.lineTo(lx + 3, baseY - 1)
          ctx.stroke()
          // Pulsing energy filling the notch (travelling phase per slit).
          const ph = 0.5 + 0.5 * Math.sin(tNow * 5.2 + beat * 4 - k * 0.9 - (sign < 0 ? 0 : 0.45))
          const lit = clamp((0.4 + 0.6 * mEnergy) * (0.4 + 0.6 * ph) + 0.35 * beat, 0, 1.2)
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          ctx.strokeStyle = hsl(emHue, 100, 72, 0.55 * lit)
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(lx - 2, baseY + 8)
          ctx.lineTo(lx + 2, baseY)
          ctx.stroke()
          ctx.globalCompositeOperation = 'source-over'
        }
      }
      ctx.lineCap = 'butt'
      ctx.restore() // end housing clip

      // (3) Recessed machined lens dish, drawn in a Y-squashed space so circles
      // read as floor-plane ellipses.
      const R = 27
      const ry = 0.46
      ctx.save()
      ctx.translate(cx2, baseY)
      ctx.scale(1, ry)
      // Collar: turned-metal ring, lit on its upper face.
      const collar = ctx.createLinearGradient(0, -R, 0, R)
      collar.addColorStop(0, '#3a4258')
      collar.addColorStop(0.5, '#171722')
      collar.addColorStop(1, '#0a0a12')
      ctx.fillStyle = collar
      ctx.beginPath()
      ctx.arc(0, 0, R, 0, Math.PI * 2)
      ctx.fill()
      // Concentric machined steps.
      for (const rr of [0.82, 0.62]) {
        const stepGrad = ctx.createLinearGradient(0, -R * rr, 0, R * rr)
        stepGrad.addColorStop(0, 'rgba(180,195,235,0.30)')
        stepGrad.addColorStop(0.5, 'rgba(0,0,0,0.25)')
        stepGrad.addColorStop(1, 'rgba(0,0,0,0.4)')
        ctx.strokeStyle = stepGrad
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(0, 0, R * rr, 0, Math.PI * 2)
        ctx.stroke()
      }
      // Dark well sinking to the throat (transparent center so the core shows).
      const well = ctx.createRadialGradient(0, 0, R * 0.12, 0, 0, R * 0.6)
      well.addColorStop(0, 'rgba(0,0,0,0)')
      well.addColorStop(0.55, 'rgba(3,2,10,0.5)')
      well.addColorStop(1, 'rgba(3,2,10,0.92)')
      ctx.fillStyle = well
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.6, 0, Math.PI * 2)
      ctx.fill()
      // Pulsing plasma flooding the recessed dish so the niche reads as a live
      // energy chamber, not a dark hole.
      ctx.globalCompositeOperation = 'lighter'
      const wellGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.62)
      wellGlow.addColorStop(0, hsl(emHue, 100, 78, 0.5 * energy))
      wellGlow.addColorStop(0.55, hsl(emHue, 100, 62, 0.2 * energy))
      wellGlow.addColorStop(1, hsl(emHue, 100, 55, 0))
      ctx.fillStyle = wellGlow
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.62, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      ctx.restore()

      // (4) Twin focusing rails framing the aperture — tapered blades rising from
      // the dish, steel-shaded with a core-lit inner edge and a glowing tip.
      for (const sign of [-1, 1]) {
        const yBase = baseY + 3
        const yTop = baseY - 13
        ctx.beginPath()
        ctx.moveTo(cx2 + sign * 22, yBase)
        ctx.quadraticCurveTo(cx2 + sign * 27, baseY - 6, cx2 + sign * 12, yTop)
        ctx.lineTo(cx2 + sign * 8, yTop + 1)
        ctx.quadraticCurveTo(cx2 + sign * 14, baseY - 5, cx2 + sign * 12, yBase)
        ctx.closePath()
        const rg = ctx.createLinearGradient(0, yTop, 0, yBase)
        rg.addColorStop(0, '#3b4258')
        rg.addColorStop(1, '#0c0c16')
        ctx.fillStyle = rg
        ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        ctx.lineWidth = 1
        ctx.stroke()
        // Inner edge lit by the plasma core.
        ctx.strokeStyle = hsl(emHue, 95, 70, 0.55 + 0.35 * glow)
        ctx.lineWidth = 1.3
        ctx.beginPath()
        ctx.moveTo(cx2 + sign * 12, yBase)
        ctx.quadraticCurveTo(cx2 + sign * 14, baseY - 5, cx2 + sign * 8, yTop + 1)
        ctx.stroke()
      }

      // (4b) Pulsing energy filling the niche between the rails — the V-channel
      // the beam exits through reads as a charged plasma slot instead of a dark
      // notch. Clipped to the channel so the glow can't spill onto the blades.
      {
        const yBase = baseY + 3
        const yTop = baseY - 13
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(cx2 - 8, yTop + 1)
        ctx.quadraticCurveTo(cx2 - 14, baseY - 5, cx2 - 12, yBase)
        ctx.lineTo(cx2 + 12, yBase)
        ctx.quadraticCurveTo(cx2 + 14, baseY - 5, cx2 + 8, yTop + 1)
        ctx.closePath()
        ctx.clip()
        ctx.globalCompositeOperation = 'lighter'
        const slot = ctx.createLinearGradient(0, yBase, 0, yTop)
        slot.addColorStop(0, hsl(emHue, 100, 80, 0.7 * energy))
        slot.addColorStop(0.6, hsl(emHue, 100, 66, 0.34 * energy))
        slot.addColorStop(1, hsl(emHue, 100, 60, 0.06 * energy))
        ctx.fillStyle = slot
        ctx.fillRect(cx2 - 16, yTop, 32, yBase - yTop + 2)
        ctx.restore()
      }

      // (5) Plasma throat — a tall, soft glow column rising between the rails.
      ctx.globalCompositeOperation = 'lighter'
      ctx.save()
      ctx.translate(cx2, baseY - 4)
      ctx.scale(0.5, 1)
      const throat = ctx.createRadialGradient(0, 0, 0, 0, 0, 16)
      throat.addColorStop(0, hsl(emHue, 100, 82, 0.55 * glow))
      throat.addColorStop(0.5, hsl(emHue, 100, 70, 0.25 * glow))
      throat.addColorStop(1, hsl(emHue, 100, 60, 0))
      ctx.fillStyle = throat
      ctx.beginPath()
      ctx.arc(0, 0, 16, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // (6) Flickering plasma arcs from the core up to each rail tip.
      const arcAmp = (0.35 + 0.65 * mEnergy) * (0.4 + 0.6 * glow)
      if (arcAmp > 0.25) {
        for (const sign of [-1, 1]) {
          const tipX = cx2 + sign * 8
          const tipY = baseY - 12
          ctx.strokeStyle = hsl(emHue, 100, 86, Math.min(0.9, arcAmp))
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(cx2, baseY - 1)
          const segs = 4
          for (let q = 1; q <= segs; q++) {
            const f = q / segs
            const jx = Math.sin(tNow * 37 + q * 2.3 + sign) * 3 * (1 - f) * arcAmp
            ctx.lineTo(cx2 + (tipX - cx2) * f + jx, baseY - 1 + (tipY - (baseY - 1)) * f)
          }
          ctx.stroke()
        }
      }

      // (7) Beat charge ring — a thin ellipse that flares on the beat.
      if (beat > 0.15) {
        ctx.strokeStyle = hsl(emHue, 100, 80, beat * 0.5)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.ellipse(cx2, baseY, R * (0.7 + beat * 0.5), R * ry * (0.7 + beat * 0.5), 0, 0, Math.PI * 2)
        ctx.stroke()
      }

      // (8) Hot core the beam erupts from (the brightest point).
      ctx.shadowColor = hsl(emHue, 90, 66, 0.7)
      ctx.shadowBlur = 16 + mEnergy * 18
      const core = ctx.createRadialGradient(cx2, baseY, 0, cx2, baseY, 12)
      core.addColorStop(0, `rgba(255,255,255,${(0.9 * (0.6 + 0.4 * glow)).toFixed(3)})`)
      core.addColorStop(0.4, hsl(emHue, 95, 78, 0.85))
      core.addColorStop(1, hsl(emHue, 90, 60, 0))
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx2, baseY, 12, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
    }

    // Control dock (pause + music): drawn ON the canvas as part of the HUD, so
    // the gravity-well lens below samples and warps it exactly like the rest of
    // the UI (the DOM-overlay version could never be lensed). Hit-testing lives
    // in App.tsx against the same layout.dock geometry. Hidden on game over (the
    // overlay covers the field) so it doesn't peek through the blur.
    if (!s.gameOver) {
      const d = layout.dock
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'

      // Glass pill (matches the HUD L's fill/stroke language).
      const pillBg = ctx.createLinearGradient(0, d.y, 0, d.y + d.h)
      pillBg.addColorStop(0, 'rgba(12, 10, 28, 0.62)')
      pillBg.addColorStop(1, 'rgba(10, 8, 22, 0.5)')
      ctx.fillStyle = pillBg
      roundedRectPath(d.x, d.y, d.w, d.h, d.r)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1.5
      roundedRectPath(d.x, d.y, d.w, d.h, d.r)
      ctx.stroke()

      // Icon glyphs are authored in a 24x24 box (mirrors the old SVGs); scale to
      // the 19px on-button glyph and center on each button.
      const drawGlyph = (cx: number, cy: number, paint: () => void) => {
        const g = 19 / 24
        ctx.save()
        ctx.translate(cx - (24 * g) / 2, cy - (24 * g) / 2)
        ctx.scale(g, g)
        paint()
        ctx.restore()
      }

      // Pause / play button. Hidden during the (currently unused) upgrade pause.
      if (!s.levelUpActive) {
        const c = d.pause
        ctx.fillStyle = 'rgba(255,255,255,0.04)'
        ctx.beginPath()
        ctx.arc(c.cx, c.cy, d.btnR, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,245,200,0.16)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(c.cx, c.cy, d.btnR - 0.5, 0, Math.PI * 2)
        ctx.stroke()

        ctx.fillStyle = 'rgba(255,246,213,0.92)'
        drawGlyph(c.cx, c.cy, () => {
          if (s.paused) {
            ctx.beginPath()
            ctx.moveTo(8, 5.5)
            ctx.lineTo(8, 18.5)
            ctx.lineTo(19, 12)
            ctx.closePath()
            ctx.fill()
          } else {
            roundedRectPath(7, 5.5, 3.5, 13, 1.4)
            ctx.fill()
            roundedRectPath(13.5, 5.5, 3.5, 13, 1.4)
            ctx.fill()
          }
        })
      }

      // Music button. ON = cyan accent + glow; OFF = dimmed with a mute slash.
      {
        const c = d.music
        const on = ui.musicOn
        // The music button literally controls the soundtrack, so its lit accent
        // rides the live music hue (falls back to the cold cyan when paused/silent).
        const noteHue = mi > 0 ? mHue : 196
        ctx.save()
        if (on) {
          ctx.fillStyle = hsl(noteHue, 55, 22, 0.6)
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowColor = hsl(noteHue, 100, 72, 0.6)
          ctx.shadowBlur = 14
          ctx.strokeStyle = hsl(noteHue, 100, 76, 0.85)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR - 0.5, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.04)'
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,245,200,0.16)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR - 0.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()

        const note = on ? hsl(noteHue, 100, 95) : 'rgba(255,246,213,0.42)'
        drawGlyph(c.cx, c.cy, () => {
          // Note stem + flag (stroked path) + two beam heads (filled circles).
          ctx.strokeStyle = note
          ctx.fillStyle = note
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.beginPath()
          ctx.moveTo(9, 16.5)
          ctx.lineTo(9, 7)
          ctx.lineTo(18, 5)
          ctx.lineTo(18, 14)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(6.5, 16.5, 2.6, 0, Math.PI * 2)
          ctx.fill()
          ctx.beginPath()
          ctx.arc(15.5, 14, 2.6, 0, Math.PI * 2)
          ctx.fill()
        })
        if (!on) {
          // Diagonal mute slash across the button.
          ctx.save()
          ctx.strokeStyle = 'rgba(255,246,213,0.7)'
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          const r = d.btnR - 8
          ctx.beginPath()
          ctx.moveTo(c.cx - r, c.cy + r)
          ctx.lineTo(c.cx + r, c.cy - r)
          ctx.stroke()
          ctx.restore()
        }
      }

      ctx.restore()
    }

    // Gravity-well puck: the player's single control surface — a gravitational
    // LENS that bends the beam around it. Dark core + real lensing of the board
    // behind it + a neon energy ring, tinted by the music hue and amplified by
    // the crescendo. Drawn in SCREEN space at the puck.
    if (s.well.placed) {
      // The well lives in world space; project it and scale its size with depth
      // so it belongs to the perspective playfield.
      const wp = proj.project(s.well.pos.x, s.well.pos.y)
      const cx = wp.x
      const cy = wp.y
      const wScale = clamp(wp.scale, 0.18, 1.6)
      const grabbed = s.well.grabbed
      // The lens is always energized — there's no inert "held" damage state
      // anymore, so the active glow/swirl stays live even while it's being
      // carried (it reads better and the steering lens never looks "off").
      const active = true
      // Event-horizon shadow radius. The whole black hole scales off this — and
      // off the perspective depth so it shrinks as it travels up the board.
      const rCore = (16 + (grabbed ? 2 : 0)) * wScale
      const hue = mi > 0 ? mHue : PALETTE.energyHue
      const surge = clamp(s.crescendo, 0, 1)

      const TWO_PI = Math.PI * 2
      const ell = (rx: number, ry: number, rot: number) => {
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry, rot, 0, TWO_PI)
      }

      // ----------------------------------------------------------------------
      // GRAVITATIONAL LENS (real, cheap). We snapshot the already-drawn board
      // (grid + blocks + laser) around the hole, then re-draw it as a series of
      // concentric ring bands, each magnified about the centre using the thin-
      // lens equation beta = theta - thetaE^2/theta. Light from just behind the
      // hole is stretched outward into an Einstein ring, so the grid lines
      // visibly bow around the shadow. The deflection tapers to zero at the lens
      // edge so there's no seam with the undistorted board.
      // ----------------------------------------------------------------------
      const rEin = rCore * 1.8 // Einstein radius — sets where the ring sits AND how wide the inner minified smear is; smaller = tighter central disc
      // Warp the ENTIRE disc down to (just under) the core edge. If we left an
      // inner gap, the real unwarped scene would show through it while the lensed
      // copy appeared farther out — a visible double image. The black core is
      // drawn on top afterwards, covering the heavily-magnified centre.
      const rLensIn = rCore * 0.9
      const rLens = rCore * 7 // outer edge: distortion fades to nothing here (was 10; the taper is ~0 well before this, so a tighter box cuts the per-frame copy+upload area ~2× with no visible change)
      const RINGS = 26
      // Cap the longest snapshot dimension so the per-frame texture upload stays
      // bounded on big screens / large holes. The warp is bilinear, so sampling a
      // slightly lower-res source is invisible after the upscale.
      const LENS_MAX_DIM = 768

      // Device-pixel-aligned sample box. Snapshotting and compositing on integer
      // device pixels is what lets the identity (zero-deflection) region of the
      // warp reproduce the original pixels EXACTLY. Because the deflection tapers
      // to zero before the box edge, the box rim samples 1:1 and is invisible —
      // so we can replace the whole box wholesale with no disc clip, no feather,
      // and therefore no seam and no double image.
      const viewDevW = Math.round(s.view.width * dpr)
      const viewDevH = Math.round(s.view.height * dpr)
      const devL = clamp(Math.floor((cx - rLens) * dpr), 0, viewDevW)
      const devT = clamp(Math.floor((cy - rLens) * dpr), 0, viewDevH)
      const devR = clamp(Math.ceil((cx + rLens) * dpr), 0, viewDevW)
      const devB = clamp(Math.ceil((cy + rLens) * dpr), 0, viewDevH)
      const sizeDevW = devR - devL
      const sizeDevH = devB - devT
      const boxL = devL / dpr
      const boxT = devT / dpr
      const boxWcss = sizeDevW / dpr
      const boxHcss = sizeDevH / dpr

      if (sizeDevW > 4 && sizeDevH > 4) {
        // Downscale factor applied to the snapshot/upload (1 = full device res).
        const lensRes = Math.min(1, LENS_MAX_DIM / Math.max(sizeDevW, sizeDevH))
        const bufW = Math.max(1, Math.round(sizeDevW * lensRes))
        const bufH = Math.max(1, Math.round(sizeDevH * lensRes))
        const ld = dpr * lensRes // box-local px -> buffer px
        const { buf, bctx } = getLensBuf(bufW, bufH)
        if (bctx) {
          // Snapshot the background patch into the (possibly downscaled) buffer so
          // the warp samples a clean copy and never feeds back on itself.
          bctx.setTransform(1, 0, 0, 1, 0, 0)
          bctx.clearRect(0, 0, buf.width, buf.height)
          bctx.imageSmoothingEnabled = true
          bctx.imageSmoothingQuality = 'low'
          bctx.drawImage(canvas, devL, devT, sizeDevW, sizeDevH, 0, 0, bufW, bufH)

          // Preferred path: a GPU per-pixel warp — smooth (bilinear) and cheap.
          let gpu = true
          let warped: HTMLCanvasElement | null = renderLens(buf, {
            cx: (cx - boxL) * ld,
            cy: (cy - boxT) * ld,
            rCore: rCore * ld,
            rEin: rEin * ld,
            rLensIn: rLensIn * ld,
            rLens: rLens * ld,
            boxDevW: bufW,
            boxDevH: bufH,
            snapW: buf.width,
            snapH: buf.height,
          })
          let warpW = bufW
          let warpH = bufH

          // Fallback (no WebGL): the CPU ring approach, supersampled for AA.
          if (!warped) {
            gpu = false
            const SS = 2
            const outScale = dpr * SS
            const outW = Math.ceil(boxWcss * outScale)
            const outH = Math.ceil(boxHcss * outScale)
            const { out, octx } = getLensOut(outW, outH)
            if (octx) {
              octx.setTransform(outScale, 0, 0, outScale, -boxL * outScale, -boxT * outScale)
              octx.clearRect(boxL, boxT, boxWcss, boxHcss)
              octx.imageSmoothingEnabled = true
              octx.imageSmoothingQuality = 'high'
              for (let k = RINGS - 1; k >= 0; k--) {
                const r0 = rLensIn + (rLens - rLensIn) * (k / RINGS)
                const r1 = rLensIn + (rLens - rLensIn) * ((k + 1) / RINGS)
                const rm = (r0 + r1) * 0.5
                let taper = (rLens - rm) / (rLens - rLensIn)
                taper = clamp(taper, 0, 1)
                taper = taper * taper * (3 - 2 * taper)
                const defl = ((rEin * rEin) / rm) * taper
                const beta = Math.max(rm * 0.12, rm - defl)
                const scale = rm / beta
                octx.save()
                octx.beginPath()
                octx.arc(cx, cy, r1 + 0.6, 0, TWO_PI)
                octx.arc(cx, cy, r0 - 0.6, 0, TWO_PI, true)
                octx.clip('evenodd')
                octx.translate(cx, cy)
                octx.scale(scale, scale)
                octx.translate(-cx, -cy)
                octx.drawImage(buf, 0, 0, buf.width, buf.height, boxL, boxT, boxWcss, boxHcss)
                octx.restore()
              }
              warped = out
              warpW = outW
              warpH = outH
            }
          }

          if (warped) {
            ctx.save()
            // The board canvas is transparent in the gaps between strokes (the
            // CSS background shows through). Drawing the warp straight on top
            // would composite a second semi-transparent copy over the original
            // and shift it. So clear the whole box first, then drop the warp in.
            // The warp's identity rim reproduces the originals 1:1, so the box
            // edge is invisible — no clip, no feather, no double image.
            ctx.globalCompositeOperation = 'destination-out'
            ctx.fillStyle = '#000'
            ctx.fillRect(boxL, boxT, boxWcss, boxHcss)
            ctx.globalCompositeOperation = 'source-over'
            // GPU path is a device-pixel copy — keep it crisp when uploaded 1:1,
            // but smooth when the snapshot was downscaled. The fallback is always
            // supersampled, so it smooths on the downscale too.
            ctx.imageSmoothingEnabled = !gpu || lensRes < 1
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(warped, 0, 0, warpW, warpH, boxL, boxT, boxWcss, boxHcss)
            ctx.restore()
          }
        }
      }

      ctx.save()

      const tNowS = s.timeSec
      // Organic flicker so the active state seethes instead of pulsing cleanly.
      const flick = clamp(0.62 + 0.26 * Math.sin(tNowS * 13) + 0.16 * Math.sin(tNowS * 7.3 + 1.7), 0, 1.3)

      // Energized corona (behind the core): a hot, flickering glow that appears
      // while the lens is parked and steering the beam.
      if (active) {
        ctx.globalCompositeOperation = 'lighter'
        const coronaR = rCore * 2.35
        const corA = (0.16 + 0.22 * surge) * flick
        const cor = ctx.createRadialGradient(cx, cy, rCore * 0.7, cx, cy, coronaR)
        cor.addColorStop(0, hsl(hue, 100, 62, 0))
        cor.addColorStop(0.45, hsl(hue, 100, 64, corA))
        cor.addColorStop(1, hsl(hue, 100, 62, 0))
        ctx.fillStyle = cor
        ell(coronaR, coronaR, 0)
        ctx.fill()
      }

      // Event horizon: a firm black disc with a softly feathered edge (the inner
      // ~88% is solid black, then it fades over a couple of px so it doesn't read
      // as a hard vector cut-out).
      ctx.globalCompositeOperation = 'source-over'
      const core = ctx.createRadialGradient(cx, cy, rCore * 0.5, cx, cy, rCore)
      core.addColorStop(0, 'rgba(0,0,0,1)')
      core.addColorStop(0.88, 'rgba(0,0,0,1)')
      core.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = core
      ell(rCore, rCore, 0)
      ctx.fill()

      // Accretion disk: a warm, tilted, flattened glow ring around the event
      // horizon — the matter you've shredded spiralling in. This is what makes
      // the well read as the warm energy SOURCE everything orbits, not a UI dot.
      const diskTilt = -0.42
      const diskFlat = 0.42
      if (active) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.translate(cx, cy)
        ctx.rotate(diskTilt)
        ctx.scale(1, diskFlat)
        const rIn = rCore * 1.02
        const rOut = rCore * 2.7
        const ring = ctx.createRadialGradient(0, 0, rIn, 0, 0, rOut)
        ring.addColorStop(0, hsl(hue, 100, 72, 0))
        ring.addColorStop(0.4, hsl(hue, 100, 66, (0.16 + 0.26 * surge) * flick))
        ring.addColorStop(1, hsl(hue, 100, 60, 0))
        ctx.fillStyle = ring
        ctx.beginPath()
        ctx.arc(0, 0, rOut, 0, TWO_PI)
        ctx.fill()
        ctx.restore()
      }

      // Orbiting light: hot streaks spiralling inward along the tilted disk plane
      // — the beam's energy caught and bent by the lens. A subtle Doppler tint
      // (cooler/brighter on the approaching arc) sells the rotation.
      if (active) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.translate(cx, cy)
        ctx.rotate(diskTilt)
        ctx.scale(1, diskFlat)
        ctx.lineCap = 'round'
        ctx.shadowColor = hsl(hue, 100, 60, 0.85)
        ctx.shadowBlur = 6
        const N = 9
        const baseRot = tNowS * 2.1
        for (let i = 0; i < N; i++) {
          const ph = (tNowS * 0.85 + i * 0.31) % 1 // 0..1 infall progress
          const rr = rCore * (1.95 + (1.05 - 1.95) * ph) // spirals inward
          const a0 = baseRot + (i / N) * TWO_PI + ph * 1.4 // trailing swirl
          const arcLen = (0.5 + 0.5 * (1 - ph)) * (0.7 + 0.3 * Math.sin(tNowS * 5 + i))
          const fade = (1 - ph) * flick
          const dop = Math.cos(a0) // -1..1 approaching/receding
          ctx.lineWidth = 1.2 + 1.9 * (1 - ph)
          ctx.strokeStyle = hsl(hue + dop * 8, 100, 66 + ph * 16 + dop * 8, 0.2 + 0.5 * fade)
          ctx.beginPath()
          ctx.arc(0, 0, rr, a0, a0 + arcLen)
          ctx.stroke()
        }
        ctx.shadowBlur = 0
        ctx.restore()
      }

      // Armed Overdrive: the well is where the eye and finger already are, so it
      // carries the primary "ready, tap to release" signal. A breathing gold
      // halo + a steady charged ring + a contracting "tap-target" pulse that
      // repeatedly converges on the core — an unmistakable affordance that this
      // is now a button — all in the gold Overdrive identity. (The gauge's "TAP
      // TO FIRE" and the screen rim reinforce it; this is the focal one.)
      if (s.overdriveArmed && s.overdriveSec <= 0) {
        const GOLD = 46
        const breath = 0.5 + 0.5 * Math.sin(s.timeSec * 4.2)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'

        // Charged halo (bigger + brighter than the idle corona).
        const rGlow = rCore * (2.4 + 0.5 * breath)
        const g = ctx.createRadialGradient(cx, cy, rCore * 0.6, cx, cy, rGlow)
        g.addColorStop(0, hsl(GOLD, 100, 74, 0.22 + 0.16 * breath))
        g.addColorStop(0.5, hsl(GOLD, 100, 66, 0.16 + 0.14 * breath))
        g.addColorStop(1, hsl(GOLD, 100, 58, 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, rGlow, 0, TWO_PI)
        ctx.fill()

        // Steady charged ring hugging the event horizon — a solid "loaded" band.
        ctx.lineWidth = 2.2
        ctx.strokeStyle = hsl(GOLD, 100, 76, 0.55 + 0.35 * breath)
        ctx.shadowColor = hsl(GOLD, 100, 64, 0.9)
        ctx.shadowBlur = 8
        ctx.beginPath()
        ctx.arc(cx, cy, rCore * 1.7, 0, TWO_PI)
        ctx.stroke()
        ctx.shadowBlur = 0

        // Tap-target pulse: a ring that converges on the core and fades, on a
        // steady ~1s beat. Reads as "press here".
        const tp = (s.timeSec % 1.05) / 1.05
        const tpR = rCore * (3.4 - 1.7 * tp)
        const tpA = 0.6 * (1 - tp) * (1 - tp)
        ctx.lineWidth = 2 + 1.6 * (1 - tp)
        ctx.strokeStyle = hsl(GOLD, 100, 80, tpA)
        ctx.beginPath()
        ctx.arc(cx, cy, tpR, 0, TWO_PI)
        ctx.stroke()
        ctx.restore()
      }

      // Firing: the well is the hot muzzle — a bright gold flare that blooms on
      // the tap and winds down with the surge (s.heat == overdriveSec/duration).
      if (s.overdriveSec > 0) {
        const drain = clamp(s.heat, 0, 1)
        const onset = clamp((drain - 0.86) / 0.14, 0, 1)
        const fl = 0.5 + 0.5 * Math.sin(s.timeSec * 16)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const rF = rCore * (2.6 + 1.4 * drain + 1.2 * onset)
        const g = ctx.createRadialGradient(cx, cy, rCore * 0.5, cx, cy, rF)
        g.addColorStop(0, hsl(48, 100, 86, (0.3 + 0.4 * drain) * (0.7 + 0.3 * fl) + 0.5 * onset))
        g.addColorStop(0.5, hsl(46, 100, 70, (0.18 + 0.3 * drain) * (0.7 + 0.3 * fl)))
        g.addColorStop(1, hsl(44, 100, 60, 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, rF, 0, TWO_PI)
        ctx.fill()
        ctx.restore()
      }

      ctx.restore()
    } else if (!s.tutorial && !s.jit) {
      // First-run hint: the entire surface is the control. Suppressed during the
      // onboarding warmup / coachmarks (the React callouts speak instead).
      const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(s.timeSec * 3))
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "800 15px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = 'Drag anywhere to steer the beam'
      const cxx = s.view.width / 2
      const cyy = s.view.height * 0.46
      ctx.globalAlpha = pulse
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 10
      ctx.fillStyle = 'rgba(255,246,213,0.96)'
      ctx.fillText(label, cxx, cyy)
      ctx.restore()
    }

    // Overdrive screen-state: a peripheral energy frame (transparent center, so
    // the playfield stays fully legible). Armed = a calm breathing gold rim
    // ("loaded"); firing = the same frame ignited brighter with living corner
    // flares + a crisp edge line, winding down as the surge drains. The center is
    // never washed — character lives at the edges, not over the action.
    {
      const odOn = s.overdriveSec > 0
      const odArmed = s.overdriveArmed && !odOn
      if (odOn || odArmed) {
        const W = s.view.width
        const H = s.view.height
        const cx = W * 0.5
        const cy = H * 0.52
        const rIn = Math.min(W, H) * 0.46
        const rOut = Math.max(W, H) * 0.86
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'

        if (odArmed) {
          // Loaded: a calm, slow gold breath hugging the edges.
          const breath = 0.5 + 0.5 * Math.sin(s.timeSec * 3.2)
          const a = 0.12 + 0.12 * breath
          const g = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut)
          g.addColorStop(0, hsl(46, 100, 60, 0))
          g.addColorStop(0.72, hsl(46, 100, 58, a * 0.45))
          g.addColorStop(1, hsl(44, 100, 62, a))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)
        } else {
          // FIRING — deliberately distinct from the calm gold "armed" breath:
          // hotter/whiter, with motion (a one-shot shockwave bursting from the
          // well on the tap, then a fast-pulsing white-hot edge that cools as the
          // surge drains). s.heat == overdriveSec/duration -> wind-down envelope.
          const drain = clamp(s.heat, 0, 1)
          const fireProg = 1 - drain // 0 at the instant of fire -> 1 at surge end
          const onset = clamp((drain - 0.8) / 0.2, 0, 1)
          const fastPulse = 0.5 + 0.5 * Math.sin(s.timeSec * 14)

          // Edge bloom — WHITE-hot (low saturation, high lightness) so it reads as
          // a hotter temperature than the gold armed state. Kept tight to the very
          // edges (large transparent center) and low-alpha so it never obscures
          // the playfield.
          const rInFire = Math.min(W, H) * 0.66
          const a = 0.09 + 0.16 * drain
          const g = ctx.createRadialGradient(cx, cy, rInFire, cx, cy, rOut)
          g.addColorStop(0, hsl(50, 100, 80, 0))
          g.addColorStop(0.72, hsl(49, 90, 72, a * 0.35 * (0.8 + 0.2 * fastPulse)))
          g.addColorStop(1, hsl(48, 95, 78, Math.min(0.55, a + 0.18 * onset)))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)

          // Living corner flares (out of phase) keep the frame alive — small and
          // faint so they read as edge accents, not a wash.
          const corners: Array<[number, number, number]> = [
            [0, 0, 0],
            [W, 0, 1.6],
            [0, H, 3.1],
            [W, H, 4.7],
          ]
          const cr = Math.min(W, H) * 0.46
          for (const [qx, qy, ph] of corners) {
            const sh = 0.5 + 0.5 * Math.sin(s.timeSec * 7 + ph)
            const ca = (0.06 + 0.13 * drain) * (0.4 + 0.6 * sh) + 0.16 * onset
            const cg = ctx.createRadialGradient(qx, qy, 0, qx, qy, cr)
            cg.addColorStop(0, hsl(50, 95, 85, Math.min(0.5, ca)))
            cg.addColorStop(0.5, hsl(47, 100, 66, ca * 0.35))
            cg.addColorStop(1, hsl(45, 100, 58, 0))
            ctx.fillStyle = cg
            ctx.fillRect(0, 0, W, H)
          }

          // Crisp inset border, fast-pulsing white-gold, cooling as it drains.
          ctx.strokeStyle = hsl(50, 100, 86, Math.min(0.95, (0.34 + 0.3 * fastPulse) * drain + 0.55 * onset))
          ctx.lineWidth = 3
          ctx.strokeRect(3.5, 3.5, W - 7, H - 7)

          // One-shot ignition shockwave: a bright ring bursting OUT from the well
          // (the muzzle) the instant you tap — the unmistakable "fire" moment.
          const shock = clamp(fireProg / 0.13, 0, 1)
          if (shock < 1) {
            const oc = s.well.placed ? project(s.well.pos.x, s.well.pos.y) : { x: cx, y: cy }
            const maxR = Math.hypot(W, H) * 0.62
            const sr = shock * maxR
            const sa = (1 - shock) * (1 - shock)
            ctx.strokeStyle = hsl(49, 100, 78, 0.55 * sa)
            ctx.lineWidth = 3 + 14 * (1 - shock)
            ctx.beginPath()
            ctx.arc(oc.x, oc.y, sr, 0, Math.PI * 2)
            ctx.stroke()
            ctx.strokeStyle = hsl(52, 100, 94, 0.7 * sa)
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.arc(oc.x, oc.y, sr * 1.05, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        ctx.restore()
      }
    }

    // Power-up flash: a compact neon badge that pops in, holds briefly, then
    // drifts upward and fades. Sits in the upper third so it never blocks the
    // beam/hole action, and is themed to the live music hue.
    if (s.levelUpNotificationFx) {
      const t = s.levelUpNotificationFx.t
      const displayDur = s.levelUpNotificationFx.displayDur
      const fadeDur = s.levelUpNotificationFx.fadeDur

      const introDur = 0.22
      const intro = clamp(t / introDur, 0, 1)
      // easeOutBack for a little overshoot on entry (impact).
      const c1 = 1.70158
      const c3 = c1 + 1
      const back = 1 + c3 * Math.pow(intro - 1, 3) + c1 * Math.pow(intro - 1, 2)

      let alpha = 1
      let riseY = 0
      if (t < introDur) {
        alpha = intro
        riseY = (1 - intro) * 8
      }
      if (t > displayDur) {
        const f = clamp((t - displayDur) / fadeDur, 0, 1)
        alpha = 1 - f
        riseY = -f * 22
      }

      if (alpha > 0.001) {
        const cx = s.view.width * 0.5
        const cy = s.view.height * 0.3 + riseY
        const scale = 0.72 + 0.28 * back
        // Overdrive's identity color is gold (matches the ignition frame),
        // distinct from the music-reactive rest of the scene.
        const hue = 45

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.textAlign = 'center'
        ctx.translate(cx, cy)
        ctx.scale(scale, scale)

        // No eyebrow text — the screen-wide ignition frame carries the "this is a
        // big deal" signal, so the banner is a single iconic word.

        // Main: "OVERDRIVE" — white-hot core with a hue bloom.
        ctx.textBaseline = 'middle'
        ctx.font = '900 30px Oxanium'
        ctx.shadowColor = hsl(hue, 100, 62, 0.95 * alpha)
        ctx.shadowBlur = 18
        ctx.fillStyle = `rgba(255,250,240,${alpha})`
        ctx.fillText('OVERDRIVE', 0, 12)

        // Neon underline that grows with the entry pop.
        ctx.shadowBlur = 10
        const uw = 86 * intro
        const ug = ctx.createLinearGradient(-uw, 0, uw, 0)
        ug.addColorStop(0, hsl(hue, 95, 70, 0))
        ug.addColorStop(0.5, hsl((hue + 18) % 360, 100, 78, 0.95 * alpha))
        ug.addColorStop(1, hsl(hue, 95, 70, 0))
        ctx.strokeStyle = ug
        ctx.lineWidth = 2.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(-uw, 34)
        ctx.lineTo(uw, 34)
        ctx.stroke()

        ctx.restore()
      }
    }

    // ---- First-run onboarding overlays ------------------------------------
    // Warmup: ring the targeted block (steer), the Heat gauge (charge/overdrive),
    // and flash the fail line (handoff). JIT: dim the whole screen with a soft
    // cutout so the OK card's subject piece stays bright and unmistakable.
    {
      const TAU = Math.PI * 2
      const tnow =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000

      const ring = (sx: number, sy: number, r: number, hue: number) => {
        const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tnow * 4))
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        ctx.lineWidth = 3
        ctx.strokeStyle = hsl(hue, 100, 70, 0.9 * pulse)
        ctx.shadowColor = hsl(hue, 100, 65, 0.85)
        ctx.shadowBlur = 16
        ctx.beginPath()
        ctx.arc(sx, sy, r * (1 + 0.04 * Math.sin(tnow * 4)), 0, TAU)
        ctx.stroke()
        ctx.restore()
      }

      const tut = s.tutorial
      if (tut && tut.phase === 'warmup' && !s.jit) {
        if (tut.beat === 'steer' && tut.targetBlockId >= 0) {
          const b = s.blocks.find((x) => x.id === tut.targetBlockId)
          if (b) {
            const cxw = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
            const cyw = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
            const pp = project(cxw, cyw)
            const ext =
              Math.max(b.localAabb.maxX - b.localAabb.minX, b.localAabb.maxY - b.localAabb.minY) * 0.7
            ring(pp.x, pp.y, ext * pp.scale + 8, 190)
          }
        } else if (tut.beat === 'charge' || tut.beat === 'overdrive') {
          // Fitted outline hugging the Heat/Overdrive gauge (not a giant circle).
          const g = layout.xpGauge
          const pad = 5
          const rx = g.x - pad
          const ry = g.y - pad
          const rw = g.w + pad * 2
          const rh = g.h + pad * 2
          const rr = Math.min(12, rw / 2)
          const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tnow * 4))
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.lineWidth = 3
          ctx.strokeStyle = hsl(45, 100, 70, 0.9 * pulse)
          ctx.shadowColor = hsl(45, 100, 65, 0.85)
          ctx.shadowBlur = 16
          roundedRectPath(rx, ry, rw, rh, rr)
          ctx.stroke()
          ctx.restore()
        } else if (tut.beat === 'handoff') {
          const pulse = 0.5 + 0.5 * Math.sin(tnow * 5)
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = hsl(8, 100, 62, 0.5 + 0.4 * pulse)
          ctx.lineWidth = 3
          ctx.shadowColor = hsl(8, 100, 55, 0.85)
          ctx.shadowBlur = 14
          ctx.beginPath()
          ctx.moveTo(0, layout.failY)
          ctx.lineTo(s.view.width, layout.failY)
          ctx.stroke()
          ctx.restore()
        }
      }

      const jit = s.jit
      if (jit) {
        let cxw = s.view.width / 2
        let cyw = s.view.height / 2
        let ext = 40
        if (jit.isFeature) {
          const f = s.features.find((x) => x.id === jit.entityId)
          if (f) {
            cxw = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
            cyw = f.pos.y + (f.localAabb.minY + f.localAabb.maxY) * 0.5
            ext = Math.max(f.localAabb.maxX - f.localAabb.minX, f.localAabb.maxY - f.localAabb.minY) * 0.6
          }
        } else {
          const b = s.blocks.find((x) => x.id === jit.entityId)
          if (b) {
            cxw = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
            cyw = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
            ext = Math.max(b.localAabb.maxX - b.localAabb.minX, b.localAabb.maxY - b.localAabb.minY) * 0.6
          }
        }
        const pp = project(cxw, cyw)
        const rHole = ext * pp.scale + 22

        const grad = ctx.createRadialGradient(pp.x, pp.y, rHole * 0.6, pp.x, pp.y, rHole + 90)
        grad.addColorStop(0, 'rgba(4,6,12,0)')
        grad.addColorStop(0.55, 'rgba(4,6,12,0.55)')
        grad.addColorStop(1, 'rgba(4,6,12,0.82)')
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, s.view.width, s.view.height)
        ctx.restore()

        ring(pp.x, pp.y, rHole, 50)
      }
    }
  })

}


