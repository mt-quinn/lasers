import type { ViewState } from './runState'

export const SLIDER_PAD = 22
export const MIN_RETICLE_GAP = 18

export type ArenaLayout = {
  railH: number
  bottomPad: number
  railY: number
  failY: number
  emitterY: number
  xpGauge: { x: number; y: number; w: number; h: number; pad: number }
  xpTarget: { x: number; y: number }
}

export const getArenaLayout = (view: ViewState): ArenaLayout => {
  const railH = 14
  const bottomPad = 18 + (view.safeBottom || 0)
  const railY = view.height - bottomPad - railH
  const emitterY = railY + railH / 2
  const failY = railY - 8

  // HUD module: bottom-right L-shape.
  // xpGauge describes the vertical XP bar (right leg of the L).
  // Docked: flush to the right edge and clipped at the death line (failY).
  // (We draw with rounded corners and then clip against the playfield bounds.)
  const padRight = 0
  const bottomMargin = 0
  const xpW = 34
  // Much taller XP gauge (roughly 3x the prior height), but keep it within the visible playfield.
  const xpH = Math.max(220, Math.min(380, failY - 70))
  const gaugeX = view.width - padRight - xpW
  // Anchor to just above the fail line so it doesn't interfere with the slider zone.
  const bottomY = failY - bottomMargin
  const gaugeY = bottomY - xpH
  const gauge = { x: gaugeX, y: gaugeY, w: xpW, h: xpH, pad: padRight }

  // Default target for XP orbs (used for legacy paths); most code now targets the top-of-fill dynamically.
  const xpTarget = { x: gaugeX + xpW / 2, y: gaugeY + gauge.h }

  return { railH, bottomPad, railY, failY, emitterY, xpGauge: gauge, xpTarget }
}

