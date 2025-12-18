import type { UpgradeId } from './upgrades'
import type { Vec2 } from './math'

export type BlockCell = { x: number; y: number }

export type BlockEntity = {
  id: number
  // grid cells describing the polyomino in local cell coords
  cells: BlockCell[]
  cellSize: number
  cornerRadius: number
  pos: Vec2 // top-left in world coords
  vel: Vec2
  hpMax: number
  hp: number
  value: number
  // local-space loop points in *cell* units (not pixels), closed (last==first)
  loop: Vec2[]
  // local-space AABB in pixels (for quick reject); updated at spawn from shape
  localAabb: { minX: number; minY: number; maxX: number; maxY: number }
  // Local-space (pixel) anchor for HP text, guaranteed inside the shape.
  hpAnchorLocalPx: Vec2
}

export type RunStats = {
  dps: number
  beamWidth: number
  maxBounces: number
  bounceFalloff: number
}

export type ViewState = {
  width: number
  height: number
  dpr: number
  safeBottom: number
}

export type InputState = {
  aimPointerId: number | null
  aimActive: boolean
  aimX: number
  aimY: number

  movePointerId: number | null
  moveActive: boolean
  moveX: number
  moveY: number

  keyLeft: boolean
  keyRight: boolean
}

export type LaserState = {
  segments: Array<{
    a: Vec2
    b: Vec2
    intensity: number
  }>
  hitBlockId: number | null
}

export type RunState = {
  paused: boolean

  view: ViewState
  input: InputState

  timeSec: number
  currency: number
  blocksDestroyed: number

  // Global "tetris-like" drop pacing.
  dropIntervalSec: number
  dropTimerSec: number

  upgrades: Partial<Record<UpgradeId, number>>
  stats: RunStats

  // Persistent aim reticle (screen-space in arena coordinates).
  reticle: Vec2

  emitter: {
    pos: Vec2
    aimDir: Vec2
  }

  laser: LaserState

  blocks: BlockEntity[]
  nextBlockId: number
  spawnTimer: number
}

export const createInitialRunState = (): RunState => {
  return {
    paused: false,
    view: { width: 360, height: 640, dpr: 1, safeBottom: 0 },
    input: {
      aimPointerId: null,
      aimActive: false,
      aimX: 0,
      aimY: 0,
      movePointerId: null,
      moveActive: false,
      moveX: 0,
      moveY: 0,
      keyLeft: false,
      keyRight: false,
    },
    timeSec: 0,
    currency: 0,
    blocksDestroyed: 0,
    // Start with a full interval so the player sees the cadence before the first step.
    dropIntervalSec: 1.275,
    dropTimerSec: 1.275,
    upgrades: {},
    stats: {
      dps: 90,
      beamWidth: 4.0,
      maxBounces: 0,
      bounceFalloff: 0.82,
    },
    reticle: { x: 180, y: 220 },
    emitter: {
      pos: { x: 180, y: 600 },
      aimDir: { x: 0, y: -1 },
    },
    laser: {
      segments: [],
      hitBlockId: null,
    },
    blocks: [],
    nextBlockId: 1,
    // Give the player a moment to orient before the first block arrives.
    spawnTimer: 1.3,
  }
}


