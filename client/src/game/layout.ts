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

  const pad = 14
  const gaugeW = 10
  const gaugeH = Math.max(80, railY - 26)
  const gaugeX = view.width - pad - gaugeW
  const gaugeY = 16
  const gauge = { x: gaugeX, y: gaugeY, w: gaugeW, h: gaugeH - gaugeY, pad }

  const xpTarget = { x: gaugeX + gaugeW / 2, y: gaugeY + gauge.h + 2 }

  return { railH, bottomPad, railY, failY, emitterY, xpGauge: gauge, xpTarget }
}


