// drawFrame orchestrator. The renderer is split into ordered passes (see
// ./passes/*): background+board, pieces+features+death FX, HUD, world FX,
// beam+emitter, and overlays (dock, gravity-well lens, banners, FTUE). Each
// pass receives the per-frame FrameCtx built here (projection, music signals,
// shared helpers); module-level caches live with their pass.

import { makeProjection } from './projection'
import { getArenaLayout } from '../game/layout'
import type { RunState } from '../game/runState'
import { withDpr, lerp, hslToRgb } from './frame'
import { reducedMotion } from '../game/settings'
import type { DrawUi, FrameCtx } from './frame'
import { drawBackgroundPass } from './passes/background'
import { drawPiecesPass } from './passes/piecesPass'
import { drawHudPass } from './passes/hud'
import { drawWorldFxPass } from './passes/worldFx'
import { drawBeamPass } from './passes/beam'
import { drawOverlayPass } from './passes/overlay'

// Back-compat re-exports: several modules import these from './draw'.
export { healthFill, relativeLuma } from './frame'
export type { DrawUi } from './frame'

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

    // Screenshake: map trauma^2 to a small pre-frame camera offset (a couple
    // of px at typical impulses, ~7px at full trauma). Multi-frequency noise
    // so it reads as a jolt, not a sine wobble. Honors the reduced-motion pref.
    if (s.trauma > 0 && !reducedMotion()) {
      const amp = s.trauma * s.trauma * 7
      const ox = amp * (Math.sin(tNow * 91.7) * 0.6 + Math.sin(tNow * 47.3) * 0.4)
      const oy = amp * (Math.cos(tNow * 83.1) * 0.6 + Math.cos(tNow * 59.7) * 0.4)
      ctx.translate(ox, oy)
    }

    const c: FrameCtx = {
      ctx,
      s,
      ui,
      layout,
      proj,
      project,
      scaleAt,
      music,
      mi,
      mBass,
      mPulse,
      mEnergy,
      mHue,
      spectrum,
      tNow,
      dpr,
      hsl,
      hueAt,
      heat,
      roundedRectPath,
    }

    drawBackgroundPass(c)
    drawPiecesPass(c)
    drawHudPass(c)
    drawWorldFxPass(c)
    drawBeamPass(c)
    drawOverlayPass(c)
  })
}
