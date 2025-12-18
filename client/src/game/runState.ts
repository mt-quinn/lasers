import type { Vec2 } from './math'

export type BlockCell = { x: number; y: number }

export type XpOrb = {
  id: string
  from: Vec2
  to: Vec2
  t: number
  phase: 'condense' | 'fly'
  value: number
}

export type SparkParticle = {
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  size: number
  heat: number // 0..1, used for color/brightness
}

export type WeldGlow = {
  x: number
  y: number
  blockId: number
  bloom: number // 1.., grows with dwell at a stable contact point
  age: number
  life: number
  intensity: number
}

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary'

export type UpgradeType = 'damage' | 'bounces' | 'bounceFalloff' | 'dropSlow'

export type UpgradeOffer = {
  type: UpgradeType
  rarity: Rarity
  title: string
  description: string
}

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
  xpValue: number
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
  blocksDestroyed: number

  // Global "tetris-like" drop pacing.
  dropIntervalSec: number
  dropTimerSec: number

  stats: RunStats

  // Persistent aim reticle (screen-space in arena coordinates).
  reticle: Vec2

  emitter: {
    pos: Vec2
    aimDir: Vec2
  }

  laser: LaserState

  // XP / level-up loop
  xp: number
  xpCap: number
  level: number
  pendingLevelUps: number
  levelUpActive: boolean
  levelUpOptions: UpgradeOffer[]
  xpOrbs: XpOrb[]
  nextOrbId: number

  // FX
  sparks: SparkParticle[]
  weldGlows: WeldGlow[]
  sparkEmitAcc: number
  weld: { blockId: number; x: number; y: number; dwell: number }

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
    blocksDestroyed: 0,
    // Start with a full interval so the player sees the cadence before the first step.
    dropIntervalSec: 1.275,
    dropTimerSec: 1.275,
    stats: {
      // Scale down visible numbers (HP/DPS) without changing time-to-kill:
      // we scale both damage and health by the same factor.
      dps: 9,
      // Default beam width increased by 50% (width is no longer an upgrade).
      beamWidth: 6.0,
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
    xp: 0,
    xpCap: 10,
    level: 0,
    pendingLevelUps: 0,
    levelUpActive: false,
    levelUpOptions: [],
    xpOrbs: [],
    nextOrbId: 1,
    sparks: [],
    weldGlows: [],
    sparkEmitAcc: 0,
    weld: { blockId: -1, x: 0, y: 0, dwell: 0 },
    blocks: [],
    nextBlockId: 1,
    // Give the player a moment to orient before the first block arrives.
    spawnTimer: 1.3,
  }
}


