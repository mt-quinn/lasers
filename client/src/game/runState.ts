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
  // Cold sparks render icy blue-white instead of hot orange — used for the
  // "deflected, no damage" spray when the beam hits an armored block's shield.
  cold?: boolean
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

export type UpgradeType = 'damage' | 'bounces' | 'dropSlow' | 'life' | 'splitterChance' | 'noWallPenalty' | 'extraChoice' | 'bounceTrade'

export type UpgradeOffer = {
  type: UpgradeType
  rarity: Rarity
  title: string
  description: string
}

// Routing-focused block variety. None of these are HP sponges — they change HOW
// you must route the beam, not how long you hold it:
// - normal: damageable from anywhere; the beam pierces it.
// - fast: descends two cells per step (prioritization pressure).
// - armored: only its glowing weak face takes damage; the beam pierces the
//   shielded faces harmlessly, so you must route the beam onto the weak side.
// - chrome: reflects the beam (scrambling your routing) and burns through fast
//   under sustained contact.
export type BlockKind = 'normal' | 'fast' | 'armored' | 'chrome'

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
  isGold: boolean
  kind: BlockKind
  // Armored only: outward normal of the weak face (damage applies when the beam's
  // hit normal points the same way). {0,0} = vulnerable everywhere.
  vulnNormal: Vec2
  // Extra per-block visual drop offset (px) so fast double-steppers ease smoothly
  // instead of snapping. Decays to 0 alongside the global drop animation.
  dropAnimExtra: number
  // Armored only: counts down after a wrong-side (shielded) beam hit so the
  // renderer can flash a "deflected, no damage" cue and pulse the weak face.
  shieldFlashSec: number
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
  pos: Vec2 // top-left of the square bounding box, world coords
  cellSize: number
  // Side length (px) of the square whose diagonal is the reflective surface.
  sizePx: number
  // Diagonal orientation. 1 = '\' (top-left → bottom-right), -1 = '/'
  // (bottom-left → top-right). A straight-up beam off '\' deflects left and off
  // '/' deflects right — it can NEVER reflect back into the muzzle, which was the
  // old "blocked emitter" dead-state.
  orient: 1 | -1
  // Mirrors are destructible: sustained beam contact burns them away, so an
  // inconvenient one is never a permanent wall.
  hp: number
  hpMax: number
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
  beamGlowWidth: number
  maxBounces: number
  bounceFalloff: number
  // The beam pierces through blocks (routing = throughput). It can pass through
  // up to `maxPierces` blocks per path, losing `pierceFalloff` of its intensity
  // (and thus damage) on each one, so focusing still beats spraying.
  maxPierces: number
  pierceFalloff: number
  splitterChance: number
  noWallPenalty: boolean
  extraChoices: number
  goldSpawnChance: number
  goldXpBonus: number
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

  // Target reticle position for smoothing touch input
  reticleTargetX: number
  reticleTargetY: number

  // Freeze reticle updates until next unique input after upgrade selection
  freezeReticleUntilNextInput: boolean
  frozenReticleX: number
  frozenReticleY: number
}

export type LaserState = {
  segments: Array<{
    a: Vec2
    b: Vec2
    intensity: number
  }>
  hitBlockId: number | null
}

// Player's gravity-well puck (the single control surface). Lives in SCREEN
// space (px) so its physics bounce off the visible playfield walls and feel
// uniform; the beam unprojects it to world space to solve its arc.
export type WellState = {
  // True once the player has placed it at least once this run.
  placed: boolean
  // True while the finger/cursor is held down (well follows the pointer).
  grabbed: boolean
  pos: Vec2
  vel: Vec2
}

// Live signals derived from the streaming soundtrack (Audius). All band/
// envelope values are smoothed to 0..1. These are read by the renderer and
// (visual-only) sim FX to make the whole game react to the music.
export type MusicSignals = {
  // True while a track is actively playing and the analyser is returning data.
  playing: boolean
  // Smoothed frequency bands (0..1), adaptively normalized per-track.
  bass: number
  mid: number
  treble: number
  // Adaptively-normalized overall loudness motion (0..1).
  energy: number
  // Sustained "loudness motion" envelope (0..1) — good for breathing/swell.
  pulse: number
  // Transient attack envelope (0..1) — spikes on note/percussion onsets.
  onset: number
  // Beat flash (0..1): snaps to 1 on a detected beat, then decays. Good for flashes.
  beat: number
  // Increments once per detected beat (lets consumers fire one-shot events).
  beatToken: number
  // Continuously-advancing rainbow hue (0..360). The backbone of the color
  // motion: it never flashes, it glides — speed nudged by mid/treble.
  hue: number
  // Smoothed per-band spectrum (0..1), low->high frequency. Drives the depth
  // grid's per-line glow without re-running analysis in the renderer.
  spectrum: number[]
  // User-facing reactivity strength (0..1). Scales how strongly signals drive FX.
  intensity: number
}

// Number of spectrum bins exposed to the renderer (cheap, smoothed).
export const MUSIC_SPECTRUM_BINS = 16

export type RunState = {
  paused: boolean

  view: ViewState
  input: InputState

  timeSec: number
  blocksDestroyed: number
  // Number of global drop steps that have occurred (0 at run start).
  depth: number
  // Number of normal blocks spawned since run start (used for early-game spawn safeguards).
  blocksSpawned: number
  // Local best depth (top score on this device). Used for HUD "BEST" readout.
  bestDepthLocal: number
  // True when the run has ended (out of lives). App will show game-over UI and optionally save score.
  gameOver: boolean

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
  
  // Level-up notification: shows "Level up! +1dps" text in center of screen
  levelUpNotificationFx: null | {
    t: number
    displayDur: number
    fadeDur: number
  }

  // Global "tetris-like" drop pacing. The field steps down one cell per music
  // beat (see beat-descent fields below); dropIntervalSec is the silent fallback
  // tempo used when no beats are arriving.
  dropIntervalSec: number
  dropTimerSec: number
  // Smooth drop animation: visual offset from 0 to cellSize (40px)
  dropAnimOffset: number
  dropAnimDuration: number
  // Beat-synced descent: seconds since the last step, and the last consumed
  // music beat token (so we step once per detected beat, bounded by tempo).
  sinceStepSec: number
  lastBeatToken: number

  stats: RunStats

  // Persistent aim reticle (screen-space in arena coordinates).
  reticle: Vec2

  emitter: {
    pos: Vec2
    aimDir: Vec2
  }

  // Player gravity-well puck (the control surface).
  well: WellState

  laser: LaserState

  // Live music-reactive signals (driven by the streaming soundtrack).
  music: MusicSignals

  // Heat / Overdrive: a skill-expressed, self-resetting beam amplifier. Heat
  // (0..1) fills as you chain kills and decays when you idle; topping it out
  // fires Overdrive (a temporary beam surge + score multiplier) that drains it.
  heat: number
  overdriveSec: number

  // XP orbs are kept purely as kill juice (the melt orb that flies to the corner
  // gauge). xp/level are vestigial now (power is fixed; no leveling).
  xp: number
  xpCap: number
  level: number
  pendingLevelUps: number
  levelUpActive: boolean
  levelUpOptions: UpgradeOffer[]
  xpOrbs: XpOrb[]
  nextOrbId: number

  // Score-attack: depth x combo. `score` is the leaderboard value; `combo`
  // counts kills inside a rolling window (resets when comboTimerSec hits 0);
  // `crescendo` (0..1) is a visual surge the renderer amplifies on big plays.
  score: number
  combo: number
  comboBest: number
  comboTimerSec: number
  crescendo: number
  bestScoreLocal: number

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
      reticleTargetX: 180,
      reticleTargetY: 220,
      freezeReticleUntilNextInput: false,
      frozenReticleX: 180,
      frozenReticleY: 220,
    },
    timeSec: 0,
    blocksDestroyed: 0,
    depth: 0,
    blocksSpawned: 0,
    bestDepthLocal: 0,
    gameOver: false,
    tutorialMovedEmitter: false,
    // Single life: "how deep" score-attack. One fail ends the run.
    lives: 1,
    respiteSec: 0,
    lifeLossFx: null,
    levelUpNotificationFx: null,
    // Fallback descent tempo (used when no music beats are arriving). With music
    // on, the field steps on the beat instead.
    dropIntervalSec: 1.1,
    dropTimerSec: 1.1,
    dropAnimOffset: 0,
    dropAnimDuration: 0.2, // 200ms animation
    sinceStepSec: 0,
    lastBeatToken: 0,
    stats: {
      // Fixed beam power. The player's "power" is their routing skill, not a
      // growing stat, so this never changes during a run (no DPS upgrades). Tuned
      // against the flat per-cell HP so a focused piece melts in ~1-2s (8hp/cell:
      // ~0.4s for a 1-cell, ~1.6s for a 4-cell) -- quick, but slow enough that the
      // board builds up and descends instead of being vaporized on arrival.
      dps: 20,
      // Default beam width doubled (width is no longer an upgrade).
      beamWidth: 12.0,
      // Outer glow width (kept at original value for visual balance).
      beamGlowWidth: 20.4,
      maxBounces: 10,
      // Starting bounce multiplier (lower means more degradation; >1 means amplification per bounce).
      bounceFalloff: 0.85,
      // Piercing: how many blocks PAST the first the beam rakes through. Kept
      // scarce on purpose. With a generous count one beam damages a whole stacked
      // column at once (front + N behind), so stacking/quantity shields nothing
      // and nothing survives to descend -- the exact reason the opening felt
      // trivial. At 1, a beam damages the front piece and one behind it; stacks of
      // 3+ shield the pieces at the back, which then advance toward the player.
      // Overdrive grants bonus pierces as the "punch through the backlog" reward.
      maxPierces: 1,
      pierceFalloff: 0.8,
      splitterChance: 0,
      noWallPenalty: false,
      extraChoices: 0,
      goldSpawnChance: 0.03,
      goldXpBonus: 0,
    },
    reticle: { x: 180, y: 220 },
    emitter: {
      pos: { x: 180, y: 600 },
      aimDir: { x: 0, y: -1 },
    },
    well: {
      placed: false,
      grabbed: false,
      pos: { x: 180, y: 320 },
      vel: { x: 0, y: 0 },
    },
    laser: {
      segments: [],
      hitBlockId: null,
    },
    music: {
      playing: false,
      bass: 0,
      mid: 0,
      treble: 0,
      energy: 0,
      pulse: 0,
      onset: 0,
      beat: 0,
      beatToken: 0,
      hue: 0,
      spectrum: new Array(MUSIC_SPECTRUM_BINS).fill(0),
      // Default reactivity: punchy but still legible.
      intensity: 0.8,
    },
    heat: 0,
    overdriveSec: 0,
    xp: 0,
    xpCap: 5,
    level: 0,
    pendingLevelUps: 0,
    levelUpActive: false,
    levelUpOptions: [],
    xpOrbs: [],
    nextOrbId: 1,
    score: 0,
    combo: 0,
    comboBest: 0,
    comboTimerSec: 0,
    crescendo: 0,
    bestScoreLocal: 0,
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


