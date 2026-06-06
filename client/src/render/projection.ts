import type { ViewState } from '../game/runState'
import type { ArenaLayout } from '../game/layout'

// Perspective projection for the whole scene.
//
// The simulation lives in a flat "world" arena space (origin top-left, +Y down)
// where the VERTICAL axis is effectively depth: pieces spawn far "up" (y < 0),
// descend toward the emitter at the bottom, and the player aims up the shaft.
// This module maps that flat world to the screen with a real perspective
// homography whose denominator depends only on world Y, so straight world lines
// (the laser) stay straight on screen, and points farther up the shaft render
// smaller and bunched toward a high horizon.
//
// p(y) in (0..1]: 1 at the near plane (emitter), shrinking toward 0 at the
// horizon. The near plane is the identity (so the bottom of the screen renders
// exactly as it did before this projection existed).

export type ProjectedPoint = { x: number; y: number; scale: number }

export type Projection = {
  project: (x: number, y: number) => ProjectedPoint
  unproject: (sx: number, sy: number) => { x: number; y: number }
  scaleAt: (y: number) => number
  horizonY: number
  nearScreenY: number
  nearWorldY: number
}

// --- Tunables -------------------------------------------------------------
// In a real perspective the vanishing point's height and the size of a piece at
// the top edge are inherently coupled, so the horizon position is the primary
// knob: the closer the horizon sits to the top edge, the more pronounced the
// recede.
//   HORIZON_FRAC  - vanishing point as a fraction of view height, negative =
//                   above the canvas. Just above the top edge (small magnitude)
//                   => strong, pronounced perspective. Far above => subtle.
//   DEPTH_SCREENS - how many screen-heights of WORLD depth are visible from the
//                   near plane to the top edge (controls shrink rate / view
//                   length independently of the horizon height).
const HORIZON_FRAC = -0.22
const DEPTH_SCREENS = 1.6
// Clamp the projective factor for safety (off-screen spawn backlog / slider zone).
const P_MIN = 0.04
const P_MAX = 1.8

export const makeProjection = (view: ViewState, layout: ArenaLayout): Projection => {
  const W = view.width
  const H = Math.max(1, view.height)
  const cx = W * 0.5
  // Near plane: the emitter row. project() is the identity here.
  const nearWorldY = layout.emitterY
  const nearScreenY = layout.emitterY
  // Horizon position is the primary knob. The top edge (screenY == 0) then maps
  // to p_top = -horizonY / span (size at the top), and strength is chosen so the
  // far plane at depth D = DEPTH_SCREENS * H lands exactly at that top edge.
  const horizonY = HORIZON_FRAC * H
  const span = nearScreenY - horizonY // > 0
  const pTop = -horizonY / span
  const D = DEPTH_SCREENS * H
  const strength = (1 / pTop - 1) / D

  const clampP = (p: number) => (p < P_MIN ? P_MIN : p > P_MAX ? P_MAX : p)
  const pAt = (y: number) => 1 / (1 + strength * (nearWorldY - y))

  const scaleAt = (y: number) => clampP(pAt(y))

  const project = (x: number, y: number): ProjectedPoint => {
    const p = clampP(pAt(y))
    return {
      x: cx + (x - cx) * p,
      y: horizonY + span * p,
      scale: p,
    }
  }

  const unproject = (sx: number, sy: number) => {
    // Invert screenY = horizonY + span * p  =>  p = (sy - horizonY) / span
    let p = (sy - horizonY) / span
    if (p < 1e-4) p = 1e-4
    const y = nearWorldY - (1 / p - 1) / strength
    const x = cx + (sx - cx) / p
    return { x, y }
  }

  return { project, unproject, scaleAt, horizonY, nearScreenY, nearWorldY }
}

// World Y that maps to the very top edge of the visible screen (screenY == 0).
// Used to align the laser's top wall and the off-screen spawn line with what the
// player actually sees.
export const screenTopWorldY = (view: ViewState, layout: ArenaLayout): number => {
  const proj = makeProjection(view, layout)
  return proj.unproject(view.width * 0.5, 0).y
}
