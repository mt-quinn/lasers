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
  // Control dock (pause + music): a glass pill at bottom-left, drawn ON the
  // canvas (so the gravity-well lens warps it like the rest of the HUD) and
  // hit-tested for taps. All values are in CSS px (canvas style px).
  dock: {
    x: number
    y: number
    w: number
    h: number
    r: number
    btnR: number
    pause: { cx: number; cy: number }
    music: { cx: number; cy: number }
  }
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

  // Control dock: bottom-left glass pill holding two equal icon buttons. Its
  // bottom edge sits just above the death line (failY), mirroring the HUD L.
  const dockBtn = 38
  const dockBtnR = dockBtn / 2
  const dockPad = 5
  const dockGap = 6
  const dockH = dockBtn + dockPad * 2
  const dockW = dockBtn * 2 + dockGap + dockPad * 2
  const dockX = 12
  const dockBottom = failY - 8
  const dockY = dockBottom - dockH
  const dockCY = dockY + dockH / 2
  const dock = {
    x: dockX,
    y: dockY,
    w: dockW,
    h: dockH,
    r: dockH / 2,
    btnR: dockBtnR,
    pause: { cx: dockX + dockPad + dockBtnR, cy: dockCY },
    music: { cx: dockX + dockPad + dockBtn + dockGap + dockBtnR, cy: dockCY },
  }

  return { railH, bottomPad, railY, failY, emitterY, xpGauge: gauge, xpTarget, dock }
}

