import type { Vec2 } from './math'

export const XP_ORB_CONDENSE_DUR = 0.5
export const XP_ORB_FLY_DUR = 0.55
export const BLOCK_MELT_DUR = 0.5

export type BlockCell = { x: number; y: number }

export type XpOrb = {
  id: string
  from: Vec2
  to: Vec2
  t: number
  phase: 'condense' | 'fly'
  value: number
}

export type MeltFx = {
  id: string
  pos: Vec2
  cellSize: number
  cornerRadius: number
  loop: Vec2[]
  localAabb: { minX: number; minY: number; maxX: number; maxY: number }
  t: number
  dur: number
  // Where the molten blob collapses into (gravity squish target).
  orbFrom: Vec2
  // Where the XP orb flies to (usually the XP gauge target).
  orbTo: Vec2
  value: number
  seed: number
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

export type UpgradeType = 'damage' | 'bounces' | 'bounceFalloff' | 'dropSlow' | 'life'

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

export type BoardFeatureKind = 'mirror' | 'prism' | 'blackHole'

export type MirrorFeature = {
  id: number
  kind: 'mirror'
  cells: BlockCell[]
  cellSize: number
  cornerRadius: number
  pos: Vec2 // top-left in world coords
  loop: Vec2[]
  localAabb: { minX: number; minY: number; maxX: number; maxY: number }
}

export type PrismFeature = {
  id: number
  kind: 'prism'
  pos: Vec2 // top-left in world coords
  cellSize: number
  // collision radius (px) around center
  r: number
  // Outgoing direction offsets (degrees) relative to the incoming beam direction.
  // Allowed values: 0, ±15, ±45, ±90. Each prism picks 2-4 distinct values at spawn.
  exitsDeg: number[]
  localAabb: { minX: number; minY: number; maxX: number; maxY: number }
}

export type BlackHoleFeature = {
  id: number
  kind: 'blackHole'
  pos: Vec2 // top-left in world coords
  cellSize: number
  // absorber core radius (px) around center
  rCore: number
  // influence radius (px) around center, within which beams curve
  rInfluence: number
  localAabb: { minX: number; minY: number; maxX: number; maxY: number }
}

export type BoardFeature = MirrorFeature | PrismFeature | BlackHoleFeature

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

  // Tutorial/first-play helpers.
  tutorialMovedEmitter: boolean

  // Lives: 3 max. Lose one when a block reaches the fail line; board clears and play continues.
  lives: number
  // Short breather after losing a life (spawns paused).
  respiteSec: number
  // Life-loss presentation: wipe + banner that makes it clear the run continues.
  lifeLossFx: null | {
    t: number
    wipeDur: number
    bannerDur: number
    livesAfter: number
    cleared: boolean
  }

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
  meltFx: MeltFx[]
  nextMeltId: number
  sparks: SparkParticle[]
  weldGlows: WeldGlow[]
  sparkEmitAcc: number
  weld: { blockId: number; x: number; y: number; dwell: number }

  blocks: BlockEntity[]
  nextBlockId: number
  features: BoardFeature[]
  nextFeatureId: number
  // Spawn director: enforce spacing so we never spawn too many undamageable board features in a row.
  // Requirement: at least 3 normal blocks must spawn between each feature.
  normalBlocksSinceFeature: number
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
    tutorialMovedEmitter: false,
    lives: 3,
    respiteSec: 0,
    lifeLossFx: null,
    // Start with a full interval so the player sees the cadence before the first step.
    dropIntervalSec: 1.275,
    dropTimerSec: 1.275,
    stats: {
      // Scale down visible numbers (HP/DPS) without changing time-to-kill:
      // we scale both damage and health by the same factor.
      dps: 9,
      // Default beam width increased by 50% (width is no longer an upgrade).
      beamWidth: 6.0,
      maxBounces: 1,
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
    xpCap: 5,
    level: 0,
    pendingLevelUps: 0,
    levelUpActive: false,
    levelUpOptions: [],
    xpOrbs: [],
    nextOrbId: 1,
    meltFx: [],
    nextMeltId: 1,
    sparks: [],
    weldGlows: [],
    sparkEmitAcc: 0,
    weld: { blockId: -1, x: 0, y: 0, dwell: 0 },
    blocks: [],
    nextBlockId: 1,
    features: [],
    nextFeatureId: 1,
    // Allow features immediately at the start (no prior feature to "cool down" from).
    normalBlocksSinceFeature: 3,
    // Give the player a moment to orient before the first block arrives.
    spawnTimer: 1.3,
  }
}


