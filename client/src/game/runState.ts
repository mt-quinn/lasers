import type { Vec2 } from './math'
import { getTodayDateKey, hashDateKey } from './rng'

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

// Brief "piece dissolving into motes" flash. Captures the dead block's
// silhouette so the renderer can pop + fade it in-place as the motes burst out,
// bridging the otherwise-instant piece→mote transition. Purely visual.
export type PieceBurstFx = {
  id: number
  pos: Vec2
  cellSize: number
  cornerRadius: number
  loop: Vec2[]
  localAabb: { minX: number; minY: number; maxX: number; maxY: number }
  isGold: boolean
  t: number
  dur: number
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

// A "heat mote": glowing debris flung out when a block is destroyed. Motes hang
// in the field (world space) carrying a slice of the kill's heat value. The
// player vacuums them with the gravity well; on capture a mote flies to the heat
// gauge and delivers its heat on arrival. Uncollected motes fade and are lost,
// so the well is the heat-collection mechanic (score is still granted at kill).
export type HeatMote = {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  // Heat (0..1 contribution) delivered to the gauge when this mote arrives.
  heat: number
  // True for motes spawned by an Overdrive-surge kill: they carry a reduced
  // charge value (so a surge can't fund its own sequel) and render dimmer.
  dim: boolean
  // Identity hue seed (used when the music-reactive palette is on).
  hue: number
  size: number
  seed: number
  // Collection: once captured by the well, the mote flies (in screen space, from
  // the projected capture point) to the heat gauge and delivers `heat` on arrival.
  collecting: boolean
  // Once the well's gravity has grabbed a mote (it entered the pull radius), it
  // stays hooked and homes in regardless of distance.
  hooked: boolean
  ct: number
  cdur: number
  // World-space point where it was captured (the renderer projects this as the
  // start of the delivery flight toward the screen-space gauge).
  cfx: number
  cfy: number
}

// Short-lived text/number floater that pops at the Heat gauge when a mote is
// collected, so the player SEES what a pickup is worth in the current state:
//   'charge' -> "+N" charge toward Overdrive (building)
//   'score'  -> "+N" bonus score (collecting while charged/armed; overflow)
//   'bank'   -> "+N" banked toward the next charge (collecting during a surge)
export type GaugeFx = {
  id: number
  t: number
  dur: number
  text: string
  kind: 'charge' | 'score' | 'bank'
  // Optional anchor. When set, the floater pops here (e.g. over the well, for
  // overflow score absorbed by the black hole) instead of at the gauge.
  x?: number
  y?: number
  // When true, (x,y) are WORLD coords the renderer must project (the well lives
  // in world space); otherwise they're raw screen-space px.
  world?: boolean
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
// - armored: armored UNDERSIDE — the straight-up beam is deflected harmlessly
//   off the bottom face, but every other face (sides + top) takes damage, so you
//   must route the beam around to hit it from a side or above.
// - chrome: reflects the beam (scrambling your routing) and burns through fast
//   under sustained contact.
// - shatter: a fast descender that, when destroyed, breaks into a cluster of 1x1
//   slow normal blocks filling its footprint — killing it multiplies the threat
//   instead of clearing it.
export type BlockKind = 'normal' | 'fast' | 'armored' | 'chrome' | 'shatter'

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
  // Extra per-block visual drop offset (px) so fast double-steppers ease smoothly
  // instead of snapping. Decays to 0 alongside the global drop animation.
  dropAnimExtra: number
  // Armored only: counts down after a deflected (bottom-face) beam hit so the
  // renderer can flash a "deflected, no damage" cue on the armored underside.
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
  // Live "beam is passing through me" energy, 0..1. Set to 1 whenever a beam
  // splits here this frame, then decays. Drives the conduit/core pulse so the
  // splitter visibly lights up only while routing a beam. Purely visual.
  lit: number
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

// ---- First-time onboarding (FTUE) -----------------------------------------
// The directed warmup is a short, action-gated piloted segment that teaches the
// core loop (steer -> combo -> charge -> overdrive) and then morphs seamlessly
// into the live daily run. Each beat advances only when the player performs the
// matching action, never on a timer.
export type TutorialBeat = 'steer' | 'combo' | 'charge' | 'overdrive' | 'handoff'

export type TutorialState = {
  phase: 'warmup'
  beat: TutorialBeat
  // Time spent in the current beat (seconds) — used for intro delays / handoff.
  beatT: number
  // Whether this beat has already injected its scripted pieces.
  spawnedThisBeat: boolean
  // Block the current beat wants the renderer to ring (or -1).
  targetBlockId: number
}

// Piece types taught just-in-time the first time each appears. Mirrors the
// pause-menu Key kinds (so the same copy/art is reused for the coachmark).
export type TeachKind = 'fast' | 'armored' | 'shatter' | 'gold' | 'mirror' | 'splitter'

// An active just-in-time coachmark: the game is paused, the referenced entity is
// highlighted, and App shows an OK card. Dismissing it marks the kind seen.
export type JitCallout = {
  kind: TeachKind
  entityId: number
  isFeature: boolean
}

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
  // Score-commit guards, persisted with the run so a refresh of a game-over'd run
  // can never submit the same score again. `globalSubmitted` = the daily global
  // upsert has fired for this run; `localSaved` = the local high-score row has
  // been committed (Save / auto-save). Once set, both are one-way for the run.
  globalSubmitted: boolean
  localSaved: boolean

  // Tutorial/first-play helpers.
  tutorialMovedEmitter: boolean

  // Lives: 3 max. Lose one when a block reaches the fail line; board clears and play continues.
  lives: number
  // Fail-line grace: the drop-step (`depth`) at which a block was first detected
  // past the fail line. The run only ends if a block is STILL past the line after
  // a further descent step, giving the player one extra turn to clear it. -1 when
  // nothing is currently past the line.
  failGraceDepth: number
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
  // (0..1) fills as you chain kills and decays when you idle. Topping it out no
  // longer auto-fires — it ARMS (overdriveArmed). The player banks the charge
  // and unleashes the surge on demand with a tap (see fireOverdrive), choosing
  // the moment: cash it on a dense cluster, or clutch it to dig out a backlog.
  heat: number
  // Charge accumulated from motes collected DURING an active surge. It is held
  // separately (so the surge's visible drain isn't disturbed) and seeded into
  // `heat` when the surge ends — this is how mote-collection stays productive
  // mid-Overdrive without letting a surge instantly re-arm itself.
  heatNext: number
  overdriveSec: number
  // True once heat tops out and the surge is charged but not yet spent. Held
  // (heat pinned at 1) until the player taps to fire. Transient (not saved).
  overdriveArmed: boolean

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
  pieceBursts: PieceBurstFx[]
  nextPieceBurstId: number
  sparks: SparkParticle[]
  weldGlows: WeldGlow[]
  sparkEmitAcc: number
  weld: { blockId: number; x: number; y: number; dwell: number }
  // Heat motes: destroyed-block debris the player vacuums with the well to fill
  // the heat gauge (see HeatMote).
  heatMotes: HeatMote[]
  nextMoteId: number
  // Gauge floaters: "+N" feedback popped at the Heat gauge on mote collection.
  gaugeFx: GaugeFx[]
  nextGaugeFxId: number

  blocks: BlockEntity[]
  nextBlockId: number
  features: BoardFeature[]
  nextFeatureId: number
  // Spawn director: enforce spacing so we never spawn too many undamageable board features in a row.
  // Requirement: at least 3 normal blocks must spawn between each feature.
  normalBlocksSinceFeature: number
  spawnTimer: number

  // Daily seeded board. The run belongs to `dateKey` (YYYY-MM-DD); `dailySeed`
  // is its hash. Each scheduled board-spawn draws an independent RNG seeded from
  // (dailySeed, boardSpawnIndex), so everyone playing that day faces the same
  // piece sequence. `boardSpawnIndex` increments once per spawnBoardThing call
  // and also drives content variety (so the ramp is index-based, hence identical
  // for everyone, rather than wall-clock-based which diverges under pacing).
  dailySeed: number
  dateKey: string
  boardSpawnIndex: number

  // First-time onboarding. `tutorial` is the directed warmup (null outside it);
  // `jit` is the active just-in-time piece coachmark (pauses play until OK).
  // Both are transient (not persisted) and only ever set on a first-time run.
  tutorial: TutorialState | null
  jit: JitCallout | null
}

export const createInitialRunState = (): RunState => {
  // Every run is today's daily board.
  const dateKey = getTodayDateKey()
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
    globalSubmitted: false,
    localSaved: false,
    tutorialMovedEmitter: false,
    // Single life: "how deep" score-attack. One fail ends the run.
    lives: 1,
    failGraceDepth: -1,
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
    heatNext: 0,
    overdriveSec: 0,
    overdriveArmed: false,
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
    pieceBursts: [],
    nextPieceBurstId: 1,
    sparks: [],
    weldGlows: [],
    sparkEmitAcc: 0,
    weld: { blockId: -1, x: 0, y: 0, dwell: 0 },
    heatMotes: [],
    nextMoteId: 1,
    gaugeFx: [],
    nextGaugeFxId: 1,
    blocks: [],
    nextBlockId: 1,
    features: [],
    nextFeatureId: 1,
    // Allow features immediately at the start (no prior feature to "cool down" from).
    normalBlocksSinceFeature: 3,
    dailySeed: hashDateKey(dateKey),
    dateKey,
    boardSpawnIndex: 0,
    // Give the player a moment to orient before the first block arrives.
    spawnTimer: 1.3,
    tutorial: null,
    jit: null,
  }
}


