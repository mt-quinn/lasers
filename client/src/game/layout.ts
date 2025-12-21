import type { ViewState } from './runState'

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

  // Compact HUD module (top-right): pill container with a radial timer at the top,
  // then a full-width XP bar below.
  // xpGauge describes the inner XP bar track.
  const pad = 12
  const xpW = 36
  const xpH = 86
  const radialH = 30 // space reserved above xpGauge for the radial timer
  const gaugeX = view.width - pad - xpW
  const gaugeY = 14 + radialH + 8
  const gauge = { x: gaugeX, y: gaugeY, w: xpW, h: xpH, pad }

  // Default target for XP orbs (used for legacy paths); most code now targets the top-of-fill dynamically.
  const xpTarget = { x: gaugeX + xpW / 2, y: gaugeY + gauge.h }

  return { railH, bottomPad, railY, failY, emitterY, xpGauge: gauge, xpTarget }
}


