import { add, clamp, mul, normalize, reflect } from './math'
import type { Vec2 } from './math'
import type { RunState, MirrorFeature, BlockEntity, HeatMote, GaugeFx } from './runState'
import { raycastSceneThick } from './raycast'
import { spawnBoardThing, spawnPrismAt, spawnShatterChildren } from './spawn'
import { stepTutorial, scanJitTrigger, WARMUP_HEAT_PER_KILL } from './tutorial'
import { getArenaLayout } from './layout'
import { makeProjection, screenTopWorldY } from '../render/projection'
import { sfxEngine } from '../audio/sfx'
import { vibrate } from './settings'

const EPS = 1.0
const MAX_SPARKS = 280
const MAX_GLOWS = 24
const MAX_RAYS = 24
const MAX_SEGMENTS = 180
// Max small steps spent integrating the beam inside the well's curving field.
const MAX_CURVE_STEPS = 260
// Below this beam intensity a piercing ray stops: it would do negligible damage
// and only draws faint hairlines through the rest of the board.
const MIN_PIERCE_INTENSITY = 0.05

// Gravity-well beam field (screen space). The well bends the beam by *proximity*
// like the original board black holes: the beam curves around it within the
// influence disc and is only absorbed if it actually crosses the core. Radii are
// screen pixels so the field feels uniform across the perspective. (Tunable.)
const WELL_INFLUENCE_R = 150 // curving field radius
const WELL_CORE_R = 12 // absorb the beam only when it crosses this
const WELL_BEND_K = 0.05 // turn rate (higher = tighter orbits)
const WELL_STEP_SCREEN = 6 // integration step, in screen px
// Beam is only eaten on a genuine inward dive: the screen-space travel dir must
// point at the core more than this (cos angle). A tangential skim whips around
// instead of getting swallowed, so the beam favors orbiting over capture.
const WELL_CAPTURE_DOT = 0.55
// Near-core "bite": extra turn weight applied ONLY at the closest approach to
// the core, so a straight pass-through can bend the beam past 90° without
// strengthening the wider field. It rides a high power of the normalized
// proximity (tNorm: 0 at the field edge, 1 at the core), so it's negligible
// through the low/mid field and spikes hard near the core. WELL_NEAR_BITE is
// the peak extra weight at the core; WELL_NEAR_BITE_POWER is how tightly it
// hugs the core (higher = narrower, affects only the very closest points).
const WELL_NEAR_BITE = 1.8
const WELL_NEAR_BITE_POWER = 10

// Score-attack tuning.
export const COMBO_WINDOW_SEC = 4.0 // a kill must land within this window to keep the combo
// Seconds per breather -> surge -> breather cadence cycle (the run's pulse).
// Module-scope because both the spawn pacing and the wave-trough respite key
// off it.
const CADENCE_PERIOD = 20
// Combo-gated pierce: sustained chains buy beam PENETRATION, the one lever that
// scales throughput with skill. At tier 1 the beam rakes one extra block per
// path; at tier 2, two extra. This is what lets a hot player answer the late
// board (the pierce cap of 1 otherwise hard-limits sustainable kill rate at
// ~36 hp/s while the board's demands keep growing) — and it's earned every
// run, decays with disengagement, and can't break the opening (combo starts
// at 0), which is why the base cap stays at 1.
export const COMBO_PIERCE_TIER1 = 8 // combo >= this: +1 pierce
export const COMBO_PIERCE_TIER2 = 16 // combo >= this: +2 pierce
// Score multiplier from combo is CAPPED so late-game score isn't dominated by
// a single unbounded variable (pierce tiers keep riding the raw combo).
export const COMBO_SCORE_MULT_CAP = 4

// Heat / Overdrive: the bankable beam amplifier. Heat is CHARGE you earn ONLY by
// vacuuming motes with the well; topping it out ARMS a surge you unleash on
// demand (fireOverdrive). The economy is built so the core verb (collecting
// motes) ALWAYS pays — building charge, overflowing to score when full, or
// banking toward the next charge during a surge — and so a surge can't fund its
// own sequel (its debris is worth a fraction).
const HEAT_PER_KILL = 0.057 // base charge per kill (scaled by combo + piece value); reduced ~1/3 so overdrive takes meaningfully longer to fill
// No always-on decay anymore (that made the early build a losing rate-race vs a
// constant leak). Charge is sticky while you're actively fighting; it only
// bleeds once your combo has fully lapsed — i.e. you've genuinely disengaged.
const HEAT_IDLE_BLEED = 0.08 // charge lost per second ONLY while combo == 0
// Motes spawned by Overdrive-surge kills are worth this fraction of normal
// charge (and render dimmer). A 5s surge produces a big debris flood; at full
// value it would instantly re-arm the meter (the old "trivial to chain"). At a
// fraction it helps a little but you must still earn most of the next charge
// from normal play — so banking and picking your moment is a real decision.
const OVERDRIVE_MOTE_CHARGE_MULT = 0.2
// Collecting while the meter is full/armed (holding the bomb) converts the
// overflow to bonus score: a mote's charge value x this x depth-scaled factor.
// Keeps sweeping rewarding even when you're saving the surge for a cluster.
const OVERDRIVE_OVERFLOW_SCORE = 700

// Heat motes (destroyed-block debris the player vacuums with the well). World
// units; radii are world px (≈ screen px at the near plane). The well is
// generous on purpose — collecting a batch at once is the satisfying payoff.
const MOTE_LIFE_MIN = 6.0
const MOTE_LIFE_MAX = 9.0
const MOTE_PULL_R = 340 // start curving motes toward the well within this radius
const MOTE_CAPTURE_R = 46 // captured (begins flying to the gauge) within this
const MOTE_PULL_ACCEL = 1500 // px/s^2 toward the well at the core, eased by distance
const MOTE_FLY_DUR = 0.5 // seconds for a captured mote to reach the gauge
const MAX_MOTES = 420
// Mote burst sizing: total heat is fixed by the kill; more motes = finer grain.
const MOTE_MIN_COUNT = 2
const MOTE_MAX_COUNT = 8
const OVERDRIVE_DURATION = 3.0 // seconds of surge once heat tops out
const OVERDRIVE_DPS_MULT = 1.7
const OVERDRIVE_BONUS_PIERCES = 3
const OVERDRIVE_SCORE_MULT = 2
const OVERDRIVE_BEAM_WIDEN = 1.35 // beam forgiveness multiplier during overdrive
// How long an armored block keeps flashing its "deflected, no damage" cue after
// the last wrong-side hit (the renderer fades it out over this window).
const SHIELD_FLASH_SEC = 0.3
// Armored underside: the bottom face DEFLECTS the beam (it reflects at the call
// sites) but is no longer fully immune — it takes this fraction of normal
// damage as chip. A wall of armored pieces is a slow grind from below instead
// of an impossible one; routing to a side or the top is still 4x faster and
// remains the intended answer.
const ARMORED_UNDERSIDE_DMG = 0.25
// Fraction of the beam's DPS a mirror absorbs (as wear) each frame of contact.
// The rest reflects. Sized with MIRROR_HP so a mirror lasts several seconds of
// continuous contact — a reliable tool you can still deliberately burn down.
const MIRROR_DAMAGE_FRAC = 0.35

// Gravity-well puck. Physics run in WORLD space so the hole lives inside the
// perspective playfield: it renders smaller with depth and bounces off the
// converging world walls (x in [0, width]) and the visible top / muzzle rows.
// Lengths below are world units (≈ screen px at the near plane).
const WELL_RADIUS = 24
// Fraction of velocity retained per second while coasting (then it settles).
const WELL_FRICTION = 0.45
const WELL_RESTITUTION = 0.86
// Below this speed (world px/s) a free puck snaps to rest.
const WELL_SLEEP_SPEED = 6

// Unleash a banked Overdrive surge. Called by the input layer when the player
// taps with the meter armed (heat topped out). Returns true if a surge actually
// fired so the caller can consume the gesture. The OVERDRIVE banner FX and the
// crescendo bump fire HERE (on the player's beat), not when the meter filled.
export const fireOverdrive = (s: RunState): boolean => {
  if (s.gameOver) return false
  if (!s.overdriveArmed || s.overdriveSec > 0) return false
  s.overdriveArmed = false
  s.overdriveSec = OVERDRIVE_DURATION
  s.heat = 1
  // Mid-surge collections bank here and seed the next charge when it ends.
  s.heatNext = 0
  s.levelUpNotificationFx = { t: 0, displayDur: 1.0, fadeDur: 0.35 }
  s.crescendo = clamp(s.crescendo + 0.5, 0, 1)
  s.trauma = Math.min(1, s.trauma + 0.3)
  // A short triple-tap of haptics so the unleash lands physically on mobile.
  vibrate([12, 22, 36])
  return true
}

// Integrate the free-flying well puck: coast with friction, bounce off the world
// playfield walls, settle when slow. While grabbed, App drives its position
// directly and we just keep momentum cleared.
const updateWellPuck = (s: RunState, dt: number) => {
  const well = s.well
  if (!well.placed) return
  if (well.grabbed) {
    well.vel.x = 0
    well.vel.y = 0
    return
  }
  const layout = getArenaLayout(s.view)
  const w = s.view.width
  const r = WELL_RADIUS
  const topY = screenTopWorldY(s.view, layout)
  const botY = layout.emitterY

  well.pos.x += well.vel.x * dt
  well.pos.y += well.vel.y * dt

  const k = Math.pow(WELL_FRICTION, dt)
  well.vel.x *= k
  well.vel.y *= k

  if (well.pos.x < r) {
    well.pos.x = r
    well.vel.x = Math.abs(well.vel.x) * WELL_RESTITUTION
  } else if (well.pos.x > w - r) {
    well.pos.x = w - r
    well.vel.x = -Math.abs(well.vel.x) * WELL_RESTITUTION
  }
  if (well.pos.y < topY + r) {
    well.pos.y = topY + r
    well.vel.y = Math.abs(well.vel.y) * WELL_RESTITUTION
  } else if (well.pos.y > botY) {
    well.pos.y = botY
    well.vel.y = -Math.abs(well.vel.y) * WELL_RESTITUTION
  }

  if (Math.hypot(well.vel.x, well.vel.y) < WELL_SLEEP_SPEED) {
    well.vel.x = 0
    well.vel.y = 0
  }
}

// Charge is presented to the player on a 0..100 scale (the bar fills to 100),
// so a mote's internal 0..1 value reads as a clean "+N" on pickup.
const CHARGE_DISPLAY = 100
const GAUGE_FX_DUR = 1.0

// ---- Mote sweep chain --------------------------------------------------
// Collecting motes in quick succession builds a CHAIN. Motes 1-2 in a window
// are the incidental trickle and pay exactly what they always did; from the
// 3rd mote on, each capture also pays a score bonus whose tier keeps climbing
// with the chain (uncapped), and every capture EXTENDS the window — so a
// sustained, deliberate vacuum run escalates further and further. Rising
// pickup ticks + an end-of-chain SWEEP pop celebrate it (politely Peggle).
const SWEEP_WINDOW_BASE = 0.7 // seconds granted by the first capture
const SWEEP_WINDOW_PER = 0.06 // extra window per mote already in the chain
const SWEEP_WINDOW_MAX = 1.8
const SWEEP_MIN_CELEBRATE = 4 // chains shorter than this end silently
const SWEEP_BONUS_BASE = 3 // per-mote bonus seed (scaled by depth and tier)

// A mote was CAPTURED by the well (either flight-to-gauge or full-charge
// absorb): advance the sweep chain, pay the escalating bonus, and harden the
// feedback at milestones.
const onMoteCaptured = (s: RunState) => {
  const sw = s.sweep
  sw.count += 1
  sw.timerSec = Math.min(SWEEP_WINDOW_MAX, SWEEP_WINDOW_BASE + sw.count * SWEEP_WINDOW_PER)
  if (sw.count >= 2) sfxEngine.playMoteTick(sw.count)
  const tier = sw.count - 2
  if (tier >= 1) {
    const per = Math.round((SWEEP_BONUS_BASE + 0.18 * s.depth) * tier)
    s.score += per
    sw.bonus += per
    pushGaugeFx(s, `+${per}`, 'score', s.well.pos.x, s.well.pos.y, true)
  }
  // Milestones (5, 10, 15, 20, ...) thump a little harder as the chain grows.
  if (sw.count >= 5 && sw.count % 5 === 0) {
    s.trauma = Math.min(1, s.trauma + 0.07)
    s.crescendo = clamp(s.crescendo + 0.12, 0, 1)
  }
}

const pushGaugeFx = (s: RunState, text: string, kind: GaugeFx['kind'], x?: number, y?: number, world?: boolean) => {
  s.gaugeFx.push({ id: s.nextGaugeFxId++, t: 0, dur: GAUGE_FX_DUR, text, kind, x, y, world })
  // Cap so a dense surge can't grow the list unbounded.
  if (s.gaugeFx.length > 24) s.gaugeFx.splice(0, s.gaugeFx.length - 24)
}

// Bonus score awarded when a mote is collected while the charge is full (the
// black hole absorbs it instead of feeding the maxed gauge).
const overflowScore = (s: RunState, m: HeatMote) =>
  Math.round(m.heat * OVERDRIVE_OVERFLOW_SCORE * (1 + s.depth * 0.01))

// Pay out a collected mote into the correct bucket for the CURRENT state, and
// pop a "+N" floater so the player sees the value. The core verb (vacuuming
// motes) always pays — building charge, overflowing to score when full, or
// banking toward the next charge during a surge.
const deliverMote = (s: RunState, m: HeatMote) => {
  if (s.overdriveSec > 0) {
    // Surge active: bank toward the NEXT charge (held separately so the surge's
    // visible drain isn't disturbed).
    s.heatNext = clamp(s.heatNext + m.heat, 0, 1)
    pushGaugeFx(s, `+${Math.max(1, Math.round(m.heat * CHARGE_DISPLAY))}`, 'bank')
  } else if (s.heat >= 1 || s.overdriveArmed) {
    // Charged & holding the bomb: overflow converts to bonus score so sweeping
    // still pays while you save the surge for the right cluster. (Normally
    // intercepted at capture so it pops over the well; this is the rare case
    // where the meter fills mid-flight.)
    const bonus = overflowScore(s, m)
    s.score += bonus
    pushGaugeFx(s, `+${bonus}`, 'score')
  } else {
    // Building: fill the charge. Topping out arms the surge.
    s.heat = clamp(s.heat + m.heat, 0, 1)
    if (s.heat >= 1) s.overdriveArmed = true
    pushGaugeFx(s, `+${Math.max(1, Math.round(m.heat * CHARGE_DISPLAY))}`, 'charge')
  }
}

// Burst a destroyed block into heat motes spread across its footprint. `heatBudget`
// (the heat this kill is worth) is divided evenly across the motes; collecting them
// with the well is what actually fills the gauge.
const spawnHeatMotes = (s: RunState, b: BlockEntity, heatBudget: number, hue: number, surge: boolean) => {
  const cells = b.cells.length
  // Half as many motes as before -> each carries double the heat (perHeat scales
  // automatically since the budget is fixed and just divided across the count).
  const count = Math.max(
    MOTE_MIN_COUNT,
    Math.min(MOTE_MAX_COUNT, Math.round(1 + b.xpValue * 0.55 + cells * 0.35)),
  )
  // Surge-spawned debris is worth a fraction (and rendered dim) so a surge can't
  // fund its own sequel.
  const budget = surge ? heatBudget * OVERDRIVE_MOTE_CHARGE_MULT : heatBudget
  const perHeat = budget / count
  const cx = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
  const cy = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
  for (let i = 0; i < count; i++) {
    // Spawn within a random footprint cell so the burst matches the block shape.
    const cell = b.cells[Math.floor(Math.random() * cells)]!
    const px = b.pos.x + (cell.x + Math.random()) * b.cellSize
    const py = b.pos.y + (cell.y + Math.random()) * b.cellSize
    // Explosive outward velocity from the block center + jitter; heavy drag in the
    // update settles them into a hovering cloud the player can sweep up.
    const dx = px - cx
    const dy = py - cy
    const dl = Math.hypot(dx, dy) || 1
    // Gentle outward pop so motes stay clustered over the block's footprint
    // (heavy drag settles them quickly) instead of spraying across the board.
    const speed = 12 + Math.random() * 26
    s.heatMotes.push({
      id: s.nextMoteId++,
      x: px,
      y: py,
      vx: (dx / dl) * speed + (Math.random() * 2 - 1) * 16,
      vy: (dy / dl) * speed + (Math.random() * 2 - 1) * 16 - 8,
      age: 0,
      life: MOTE_LIFE_MIN + Math.random() * (MOTE_LIFE_MAX - MOTE_LIFE_MIN),
      heat: perHeat,
      dim: surge,
      hue,
      size: 1.6 + Math.random() * 1.8,
      seed: Math.random() * 1000,
      collecting: false,
      hooked: false,
      ct: 0,
      cdur: MOTE_FLY_DUR,
      cfx: px,
      cfy: py,
    })
  }
  if (s.heatMotes.length > MAX_MOTES) s.heatMotes.splice(0, s.heatMotes.length - MAX_MOTES)
}

// Helper functions for smooth drop animation hitbox adjustment
const adjustPositionsForAnimation = (s: RunState) => {
  // Blocks include their per-block extra (fast double-steppers) so the beam hits
  // exactly where the block is drawn.
  for (const b of s.blocks) {
    const off = s.dropAnimOffset + b.dropAnimExtra
    if (off > 0) b.pos.y -= off
  }
  if (s.dropAnimOffset > 0) {
    for (const f of s.features) {
      f.pos.y -= s.dropAnimOffset
    }
  }
}

const restoreLogicalPositions = (s: RunState) => {
  for (const b of s.blocks) {
    const off = s.dropAnimOffset + b.dropAnimExtra
    if (off > 0) b.pos.y += off
  }
  if (s.dropAnimOffset > 0) {
    for (const f of s.features) {
      f.pos.y += s.dropAnimOffset
    }
  }
}

export const stepSim = (s: RunState, dt: number) => {
  s.timeSec += dt

  // First-run directed warmup: a slow, no-death board with scripted pieces and
  // suppressed scoring. The stepper advances beats on the player's actions and
  // hands off to the live run when it completes.
  const warmup = s.tutorial?.phase === 'warmup'

  // Level-up notification FX
  if (s.levelUpNotificationFx) {
    s.levelUpNotificationFx.t += dt
    const totalDur = s.levelUpNotificationFx.displayDur + s.levelUpNotificationFx.fadeDur
    if (s.levelUpNotificationFx.t >= totalDur) {
      s.levelUpNotificationFx = null
    }
  }

  // Deterministic, learnable difficulty schedule. Difficulty rises only on
  // skill-answerable axes — descent speed and arrival density (plus routing
  // complexity from features) — never block HP. Music is pure juice and no
  // longer drives the descent, so the ramp is identical every run and mastery
  // means internalizing it.
  //
  // The pressure levers are deliberately STAGGERED. When the on-screen cap, the
  // descent speed, and the content mix all finished ramping at the same moment
  // (the old single 210s ramp), the required kill throughput DOUBLED between
  // ~2:30 and ~3:30 and crossed every skill band within about a minute — every
  // run walled out at nearly the same time regardless of skill. Now the cap
  // finishes first (210s), descent keeps tightening until 300s, the content mix
  // (see the spawn bag in spawn.ts) stretches to ~360s, and the requirement
  // curve then *asymptotes* near a strong player's sustainable throughput
  // instead of sprinting past it. `creep` still nudges upward forever (over
  // 900s) so even perfect play meets a ceiling eventually — but mistakes, waves
  // and routing are what end runs, not arithmetic.
  const CAP_RAMP_SECONDS = 210
  const DROP_RAMP_SECONDS = 300
  // Global pace multiplier on the two time-based speed levers (descent metronome
  // + spawn interval). >1 slows the game uniformly at every point in the ramp.
  // The previous 1.15 is folded into the base constants below; keep this at 1.0
  // and use it only for quick whole-game pacing experiments.
  const GAME_PACE_SCALE = 1.0
  // Front-load the curves: `prog*` rises fast in the first ~20s (pow < 1) so the
  // board is already busy and demands routing right away, then eases toward the
  // steady-state. A flat-early curve (smoothstep) was exactly what made the
  // opening trivial.
  const progCap = Math.pow(clamp(s.timeSec / CAP_RAMP_SECONDS, 0, 1), 0.7)
  const progDrop = Math.pow(clamp(s.timeSec / DROP_RAMP_SECONDS, 0, 1), 0.7)
  const creep = clamp((s.timeSec - DROP_RAMP_SECONDS) / 900, 0, 1)

  // Movement is tetris-like: blocks step down together on a global timer. The
  // descent interval is the "gravity": brisk from the very start so pieces
  // actually travel down the board (and you must route immediately), easing to a
  // floor of ~0.34s/row. (The old floor of ~0.23s left a late-game piece on
  // screen for under 8 seconds — past any routing answer.)
  s.dropIntervalSec =
    Math.max(0.34, 0.8 + (0.36 - 0.8) * progDrop - 0.05 * creep) * GAME_PACE_SCALE
  // Warmup: a calm, slow descent so a first-timer is never rushed.
  if (warmup) s.dropIntervalSec = 1.6

  const layout = getArenaLayout(s.view)
  const cellSize = 40

  // Spawn respite countdown (armed each wave trough below; this field was
  // originally the post-life-loss breather, orphaned by the single-life rework).
  if (s.respiteSec > 0) {
    s.respiteSec = Math.max(0, s.respiteSec - dt)
  }

  // Wave-trough breather: once per cadence cycle, exactly at the trough, spawns
  // hold for a beat. This is the run's recovery valve — the moment to sweep
  // motes, bank Overdrive charge, and reset routing before the next surge.
  // Pure wall-clock (identical for everyone) and skipped in the opening so the
  // first minute keeps its momentum.
  if (!warmup && s.timeSec > 30) {
    const prevCycle = Math.floor((s.timeSec - dt) / CADENCE_PERIOD)
    const cycle = Math.floor(s.timeSec / CADENCE_PERIOD)
    if (cycle !== prevCycle) s.respiteSec = Math.max(s.respiteSec, 1.5)
  }

  // Spawn pacing (director-style): a deterministic target curve, with pressure
  // guardrails so the game ramps without spiraling into impossible states.
  // Arrival rate and the on-screen cap ramp together: more simultaneous threats
  // to route between as you go deeper.
  s.spawnTimer -= dt
  const spawnEveryBase =
    Math.max(0.42, 0.72 + (0.46 - 0.72) * progDrop - 0.06 * creep) * GAME_PACE_SCALE // ~0.72s -> ~0.46s -> 0.42s floor
  const maxBlocksBase = Math.floor(7 + 6 * progCap + 3 * creep) // 7 -> 13 -> ~16

  // Surge/breather cadence: a deterministic wave layered on the base interval so
  // arrivals come in rhythmic crunches with calm between, instead of a flat drip
  // — this is the run's pulse. Phase is pure wall-clock (identical for everyone)
  // and only modulates PACING, never the seeded piece sequence. Intensity ramps
  // with `progCap`, so early waves are gentle and late ones bite.
  //
  // The wave is meant to be FELT: the old breather was only ~10% slower than
  // baseline (it read as noise), so the breathers are now genuinely calm
  // (~45% slower, a couple of on-screen slots removed) while surges stay sharp.
  // The breather is also where motes get swept and Overdrive gets banked — the
  // run's recovery valve, not just a pause.
  const cadenceWave = 0.5 - 0.5 * Math.cos((s.timeSec / CADENCE_PERIOD) * Math.PI * 2) // 0..1
  const surge01 = Math.pow(cadenceWave, 2.2) * (0.4 + 0.6 * progCap) // sharpen into peaks + ramp in
  const cadenceInterval = 1.45 - 0.9 * surge01
  const cadenceCap = Math.round(6 * surge01) - 2 // -2 in the trough .. +4 at full surge

  // Pressure: if blocks are close to failing, slow/stop spawns to preserve fairness.
  const dangerY = layout.failY - 2 * cellSize
  let dangerCount = 0
  for (const b of s.blocks) {
    const bottom = b.pos.y + b.localAabb.maxY
    if (bottom >= dangerY) dangerCount++
  }
  const pressure01 = clamp(dangerCount / 3, 0, 1)
  const spawnEvery = spawnEveryBase * cadenceInterval * (1 + 0.85 * pressure01)
  const maxBlocks = Math.max(3, maxBlocksBase + cadenceCap - Math.floor(2 * pressure01))

  const allowSpawn = dangerCount === 0 && s.respiteSec <= 0
  // During the warmup, the live spawn director is silenced: the tutorial stepper
  // is the sole source of pieces (scripted beats).
  if (warmup) {
    stepTutorial(s, dt)
  } else if (allowSpawn && s.spawnTimer <= 0) {
    const occupants = s.blocks.length + s.features.length
    if (occupants < maxBlocks) {
      spawnBoardThing(s)
      s.spawnTimer = spawnEvery
    } else {
      // Back off slightly and try again soon; helps prevent overstacking at cap.
      s.spawnTimer = 0.25
    }
  } else if (!allowSpawn) {
    // If we're in a danger state, keep checking frequently so spawns resume quickly after recovery.
    s.spawnTimer = Math.min(s.spawnTimer, 0.18)
  }

  // The emitter is a fixed muzzle at bottom-center that always fires straight
  // up. The player no longer aims it; steering happens entirely through the
  // gravity-well puck (below), which bends the beam toward itself.
  s.emitter.pos = { x: s.view.width / 2, y: layout.emitterY }
  s.emitter.aimDir = { x: 0, y: -1 }

  // Advance the well puck's physics (coast/bounce/settle when free; held puck is
  // positioned by App). The beam path is solved from this each frame.
  updateWellPuck(s, dt)

  // Combo + crescendo decay. A lapse no longer wipes the chain: it HALVES it
  // (rounding down) and re-arms the window, so one bad beat costs a tier of
  // momentum, not the whole run's — repeated disengagement still decays to zero
  // in a few windows. The crescendo (visual surge) eases back continuously.
  if (s.comboTimerSec > 0) {
    s.comboTimerSec = Math.max(0, s.comboTimerSec - dt)
    if (s.comboTimerSec === 0 && s.combo > 0) {
      s.combo = Math.floor(s.combo / 2)
      if (s.combo > 0) s.comboTimerSec = COMBO_WINDOW_SEC
    }
  }
  if (s.crescendo > 0) {
    s.crescendo = Math.max(0, s.crescendo - dt * 0.9)
  }
  // Screenshake trauma decays quickly; impulses come from kills, overdrive
  // and game over. (The renderer maps trauma^2 to the camera offset, so the
  // tail is much subtler than the hit.)
  if (s.trauma > 0) {
    s.trauma = Math.max(0, s.trauma - dt * 1.8)
  }
  // Sweep chain window: counts down between captures; on expiry a worthwhile
  // chain gets its celebration (pop + arpeggio + jolt scaled by length), then
  // the chain resets. The fx itself just ages out.
  if (s.sweep.timerSec > 0) {
    s.sweep.timerSec = Math.max(0, s.sweep.timerSec - dt)
    if (s.sweep.timerSec === 0) {
      if (s.sweep.count >= SWEEP_MIN_CELEBRATE) {
        s.sweepFx = {
          t: 0,
          dur: 1.5,
          count: s.sweep.count,
          bonus: s.sweep.bonus,
          x: s.well.pos.x,
          y: s.well.pos.y,
        }
        s.trauma = Math.min(1, s.trauma + Math.min(0.3, 0.05 + s.sweep.count * 0.012))
        s.crescendo = clamp(s.crescendo + Math.min(0.5, s.sweep.count * 0.03), 0, 1)
        sfxEngine.playSweepEnd(s.sweep.count)
        vibrate(s.sweep.count >= 8 ? [12, 30, 18] : 14)
      }
      s.sweep.count = 0
      s.sweep.bonus = 0
    }
  }
  if (s.sweepFx) {
    s.sweepFx.t += dt
    if (s.sweepFx.t >= s.sweepFx.dur) s.sweepFx = null
  }

  // Field descent: the board steps down one cell on a deterministic metronome
  // (dropIntervalSec, set by the difficulty schedule above). The descent is
  // intentionally independent of the music so the ramp is identical every run.
  s.sinceStepSec += dt

  // Smooth drop animation: continuously ease the visual offset back to 0. Fast
  // blocks carry an extra per-block offset that eases at the same rate.
  if (s.dropAnimOffset > 0) {
    const animSpeed = cellSize / s.dropAnimDuration
    s.dropAnimOffset = Math.max(0, s.dropAnimOffset - animSpeed * dt)
    for (const b of s.blocks) {
      if (b.dropAnimExtra > 0) b.dropAnimExtra = Math.max(0, b.dropAnimExtra - animSpeed * dt)
    }
  }

  const stepNow = s.sinceStepSec >= s.dropIntervalSec

  if (stepNow) {
    s.sinceStepSec = 0
    s.dropTimerSec = s.dropIntervalSec

    // Snap logical positions forward immediately (physics/collision use this).
    // Fast-class pieces (fast + shatter, which is a fast piece that splits on
    // death) alternate 2 and 1 cells on successive beats instead of a constant 2.
    // That averages 1.5 cells/step — still clearly faster than normal, but it
    // removes the "always double-time" feel that could be unfair. The alternation
    // keys off the global step parity so every fast piece moves in lockstep.
    s.depth += 1
    const fastStepCells = s.depth % 2 === 0 ? 2 : 1
    for (const b of s.blocks) {
      if (b.kind === 'fast') {
        b.pos.y += b.cellSize * fastStepCells
        // Extra visual catch-up only for the cells beyond the global 1-cell drop
        // animation (so a 2-cell beat eases over two cells, a 1-cell beat reads
        // exactly like a normal piece).
        b.dropAnimExtra = b.cellSize * (fastStepCells - 1)
      } else {
        b.pos.y += b.cellSize
      }
    }
    for (const f of s.features) {
      f.pos.y += f.cellSize
    }
    // Heat motes ride the board: they step down one cell with the pieces (and
    // share the same drop animation), so collected debris drifts toward the
    // player in lockstep instead of hanging in place.
    for (const m of s.heatMotes) {
      // Hooked motes are flying to the well under gravity, so they ignore the
      // board's descent (otherwise the drop drags them off their homing path).
      if (!m.collecting && !m.hooked) m.y += cellSize
    }

    // Start the visual catch-up animation (offset counts back down to 0).
    s.dropAnimOffset = cellSize
  } else {
    // Expose time-to-next-step as the HUD countdown value.
    s.dropTimerSec = Math.max(0, s.dropIntervalSec - s.sinceStepSec)
  }

  // FX: update sparks + weld glows.
  if (s.sparks.length > 0) {
    for (const p of s.sparks) {
      p.age += dt
      p.vy += 780 * dt
      p.vx *= Math.pow(0.08, dt) // quick air drag, dt-stable
      p.vy *= Math.pow(0.12, dt)
      p.x += p.vx * dt
      p.y += p.vy * dt
      // cool down over life
      p.heat = Math.max(0, 1 - p.age / p.life)
    }
    s.sparks = s.sparks.filter((p) => p.age < p.life)
  }
  if (s.weldGlows.length > 0) {
    for (const g of s.weldGlows) g.age += dt
    s.weldGlows = s.weldGlows.filter((g) => g.age < g.life)
  }
  // Gauge floaters: age out the "+N" mote-collection feedback.
  if (s.gaugeFx.length > 0) {
    for (const fx of s.gaugeFx) fx.t += dt
    s.gaugeFx = s.gaugeFx.filter((fx) => fx.t < fx.dur)
  }
  // Fade out the armored "deflected" flash after the last wrong-side hit.
  for (const b of s.blocks) {
    if (b.shieldFlashSec > 0) b.shieldFlashSec = Math.max(0, b.shieldFlashSec - dt)
  }

  // Decay each splitter's "beam routing through me" glow. ~0.18s falloff so the
  // conduits pulse brightly while lasing and settle to idle when the beam moves.
  for (const f of s.features) {
    if (f.kind === 'prism' && f.lit > 0) f.lit = Math.max(0, f.lit - dt / 0.18)
  }

  // Piece-dissolve flashes: advance and cull.
  if (s.pieceBursts.length > 0) {
    for (const fx of s.pieceBursts) fx.t += dt
    if (s.pieceBursts.some((f) => f.t >= f.dur)) {
      s.pieceBursts = s.pieceBursts.filter((f) => f.t < f.dur)
    }
  }

  // Heat motes: vacuum destroyed-block debris toward the well; captured motes fly
  // to the gauge and deliver their heat on arrival (the collection IS the fill).
  if (s.heatMotes.length > 0) {
    const well = s.well
    // A mote is gone once it drifts past the bottom of the screen (no timeout).
    const offBottom = s.view.height + 30
    const dead: number[] = []
    for (const m of s.heatMotes) {
      if (m.collecting) {
        m.ct += dt
        if (m.ct >= m.cdur) {
          deliverMote(s, m)
          dead.push(m.id)
        }
        continue
      }
      m.age += dt
      // Heavy drag settles the initial burst; lighter drag once hooked so the
      // mote keeps building speed toward the well instead of stalling out.
      const k = Math.pow(m.hooked ? 0.45 : 0.1, dt)
      m.vx *= k
      m.vy *= k
      // Well attraction (generous). Active only once the player has placed it.
      if (well.placed) {
        const dx = well.pos.x - m.x
        const dy = well.pos.y - m.y
        const dist = Math.hypot(dx, dy)
        if (dist < MOTE_CAPTURE_R) {
          // Charge full (and not mid-surge): the black hole simply absorbs the
          // mote and pays out bonus score right there — no flight to the gauge.
          if (s.heat >= 1 && s.overdriveSec <= 0) {
            const bonus = overflowScore(s, m)
            s.score += bonus
            pushGaugeFx(s, `+${bonus}`, 'score', well.pos.x, well.pos.y, true)
            onMoteCaptured(s)
            dead.push(m.id)
            continue
          }
          m.collecting = true
          onMoteCaptured(s)
          m.ct = 0
          m.cfx = m.x
          // Capture from the on-screen (animated) position for a seamless handoff.
          m.cfy = m.y - s.dropAnimOffset
          continue
        }
        // Once a mote enters the pull radius it's hooked for good and homes in
        // regardless of how far the well later drifts.
        if (dist < MOTE_PULL_R) m.hooked = true
        if (m.hooked) {
          // Constant-strength pull toward the well (direction only), so the mote
          // accelerates in no matter the distance.
          const a = (MOTE_PULL_ACCEL * dt) / (dist || 1)
          m.vx += dx * a
          m.vy += dy * a
        }
      }
      m.x += m.vx * dt
      m.y += m.vy * dt
      if (m.y - s.dropAnimOffset > offBottom) dead.push(m.id)
    }
    if (dead.length > 0) {
      const ds = new Set(dead)
      s.heatMotes = s.heatMotes.filter((m) => !ds.has(m.id))
    }
  }

  // Heat / Overdrive: fills from collected heat motes (delivered above), decays
  // when idle, and on topping out ARMS a surge the player unleashes on demand.
  if (s.overdriveSec > 0) {
    s.overdriveSec = Math.max(0, s.overdriveSec - dt)
    if (s.overdriveSec > 0) {
      // The meter visibly drains across the surge.
      s.heat = clamp(s.overdriveSec / OVERDRIVE_DURATION, 0, 1)
    } else {
      // Surge ended: seed the next charge with whatever was banked DURING it
      // (motes collected mid-Overdrive). Surge debris is worth a fraction, so
      // this is usually a partial head-start, not a free re-arm.
      s.heat = clamp(s.heatNext, 0, 1)
      s.heatNext = 0
      s.overdriveArmed = s.heat >= 1
    }
  } else if (s.overdriveArmed || s.heat >= 1) {
    // Charged: hold at full and wait for the player to tap (fireOverdrive).
    // Banking the surge is the whole decision — cash it on a dense cluster, or
    // clutch it to punch through a backlog at the fail line. Collecting motes
    // while held overflows to bonus score (see deliverMote), so the verb stays
    // worthwhile instead of going dead.
    s.overdriveArmed = true
    s.heat = 1
  } else {
    // No always-on decay. Charge is sticky while you're actively fighting; it
    // only bleeds once the combo has fully lapsed (you've genuinely disengaged).
    if (s.combo <= 0) s.heat = Math.max(0, s.heat - HEAT_IDLE_BLEED * dt)
  }

  // Fail line sits just above the bottom rail. Single life: a block crossing it
  // ends the run ("how deep did you get") — but with one drop-step of grace. The
  // first step a block is past the line only arms a grace marker; the run ends
  // only if a block is STILL past the line after a further descent step, so the
  // player gets one more turn to clear it (the UI line is unchanged).
  const failY = layout.failY
  let anyPastFail = false
  // The warmup is a no-death sandbox: never end the run, never arm the grace.
  if (warmup) {
    s.failGraceDepth = -1
  } else {
    for (const b of s.blocks) {
      if (b.pos.y + b.localAabb.maxY >= failY) {
        anyPastFail = true
        break
      }
    }
    if (!anyPastFail) {
      // Nothing past the line (player cleared it, or never reached it): disarm.
      s.failGraceDepth = -1
    } else if (s.failGraceDepth < 0) {
      // First detection: arm the grace at the current step. Not fatal yet —
      // but make the brush with death unmistakable: alarm beeps, a haptic
      // buzz, a camera jolt, and (in the renderer) the fail line going to its
      // alarm state with brackets on the offending block.
      s.failGraceDepth = s.depth
      sfxEngine.playAlarm()
      vibrate([30, 40, 30])
      s.trauma = Math.min(1, s.trauma + 0.18)
    } else if (s.depth > s.failGraceDepth) {
      // A descent step has elapsed and a block is still past the line: end the run.
      s.lives = 0
      s.gameOver = true
      s.paused = true
      s.bestScoreLocal = Math.max(s.bestScoreLocal, s.score)
      s.trauma = Math.min(1, s.trauma + 0.65)

      // Stronger end-of-run haptic.
      vibrate([18, 50, 16, 50, 24])
      // Freeze presentation; board remains behind the overlay.
      return
    }
  }

  // Board features scroll off the bottom with no penalty.
  if (s.features.length > 0) {
    const margin = 120
    s.features = s.features.filter((f) => {
      const bottom = f.pos.y + f.localAabb.maxY
      return bottom < s.view.height + margin
    })
  }

  // Laser: compute segments + apply damage.
  s.laser.segments = []
  s.laser.hitBlockId = null

  let didDamageBlockThisFrame = false
  // Kills resolved this frame. A single beam pass that pierces/splits through many
  // blocks racks these up, so multi-kills (the payoff of good routing) score more.
  let killsThisFrame = 0

  // Apply smooth drop animation offset to hitboxes for laser interactions.
  // Temporarily adjust positions to visual positions so hitboxes animate smoothly.
  adjustPositionsForAnimation(s)

  // Range is effectively infinite (within the screen). Always cast far enough to cross the whole view.
  const maxDist = Math.hypot(s.view.width, s.view.height) * 1.35
  const overdrive = s.overdriveSec > 0
  const beamRadius = Math.max(0, s.stats.beamWidth * 0.45) * (overdrive ? OVERDRIVE_BEAM_WIDEN : 1)
  const rotate = (v: Vec2, rad: number): Vec2 => {
    const c = Math.cos(rad)
    const sn = Math.sin(rad)
    return { x: v.x * c - v.y * sn, y: v.x * sn + v.y * c }
  }

  // Post-optic rays travel straight (the only bend is the muzzle->well approach).
  // `viaOptics` marks rays that have passed through a mirror/prism so kills made
  // off a bank/split shot can score a route bonus.
  type RayWork = {
    o: Vec2
    d: Vec2
    intensity: number
    bouncesLeft: number
    piercesLeft: number
    minT: number
    ignorePrismId: number
    viaOptics: boolean
  }
  const queue: RayWork[] = []

  const enqueueRay = (work: RayWork) => {
    // Prevent rays from being dropped due to the MAX_RAYS processing cap: don't enqueue more
    // than we can possibly process this frame.
    if (raysProcessed + queue.length >= MAX_RAYS) return false
    queue.push(work)
    return true
  }

  const emitPrismRays = (prismId: number, hitPoint: Vec2, incoming: Vec2, intensity: number, bouncesLeft: number, piercesLeft: number) => {
    const prism = s.features.find((f) => f.kind === 'prism' && f.id === prismId) as
      | { exitsDeg?: number[]; lit?: number }
      | undefined
    // Light the crystal: a beam is routing through it this frame.
    if (prism) prism.lit = 1
    const allowed = new Set([0, 15, -15, 45, -45, 90, -90])
    const exitsRaw: number[] = Array.isArray(prism?.exitsDeg) && prism.exitsDeg.length > 0 ? prism.exitsDeg : [45, -45]
    const exits = [...new Set(exitsRaw.filter((x) => allowed.has(x)))].sort((a, b) => Math.abs(a) - Math.abs(b))
    for (const deg of exits) {
      const rad = (deg * Math.PI) / 180
      const outDir = normalize(rotate(incoming, rad))
      const start = add(hitPoint, mul(outDir, EPS + beamRadius))
      const ok = enqueueRay({
        o: { ...start },
        d: outDir,
        intensity,
        bouncesLeft,
        piercesLeft,
        minT: EPS + beamRadius * 0.75,
        ignorePrismId: prismId,
        viaOptics: true,
      })
      if (!ok) break
    }
  }

  const tryAddSeg = (a: Vec2, b: Vec2, intensity: number) => {
    if (s.laser.segments.length >= MAX_SEGMENTS) return false
    s.laser.segments.push({ a, b, intensity })
    return true
  }

  // Mirrors reflect the beam but slowly burn through under sustained contact, so
  // an inconvenient deflector is never a permanent wall. Returns nothing; the
  // reflection itself is handled at the call site.
  const damageMirror = (mirrorId: number, intensity: number) => {
    const m = s.features.find((f) => f.kind === 'mirror' && f.id === mirrorId) as MirrorFeature | undefined
    if (!m) return
    const odMult = s.overdriveSec > 0 ? OVERDRIVE_DPS_MULT : 1
    m.hp -= s.stats.dps * MIRROR_DAMAGE_FRAC * odMult * dt * intensity
    if (m.hp > 0) return
    // Burned through: remove it and pop a small cool-white spark burst.
    s.features = s.features.filter((f) => f.id !== m.id)
    const cx = m.pos.x + m.sizePx * 0.5
    const cy = m.pos.y + m.sizePx * 0.5
    for (let i = 0; i < 12; i++) {
      const ang = Math.random() * Math.PI * 2
      const spd = 120 + Math.random() * 220
      s.sparks.push({
        x: cx + (Math.random() * 2 - 1) * 4,
        y: cy + (Math.random() * 2 - 1) * 4,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd,
        age: 0,
        life: 0.16 + Math.random() * 0.26,
        size: 1.0 + Math.random() * 2.2,
        heat: 1,
      })
    }
    if (s.sparks.length > MAX_SPARKS) s.sparks.splice(0, s.sparks.length - MAX_SPARKS)
  }

  const dealDamageAtHit = (
    blockId: number,
    point: Vec2,
    normal: Vec2,
    intensity: number,
    viaOptics: boolean,
  ) => {
    const b = s.blocks.find((bb) => bb.id === blockId)
    if (!b) return

    // Armored underside: a hit on the bottom face DEFLECTS (the beam reflects at
    // the call site) and only chips — ARMORED_UNDERSIDE_DMG of normal damage —
    // so grinding from below is possible but routing to a side/top stays the
    // clearly better answer. The bottom face's outward normal points DOWN (+y),
    // so a downward-pointing hit normal means the beam struck the armored
    // underside. Make the resist obvious: spray cold blue-white "deflection"
    // sparks and flag the block so the renderer flashes a cue on the armored
    // base (the hot welding FX below are skipped for these hits).
    const armoredDeflect = b.kind === 'armored' && normal.y >= 0.45
    if (armoredDeflect) {
      b.shieldFlashSec = SHIELD_FLASH_SEC
      const tx = -normal.y
      const ty = normal.x
      for (let i = 0; i < 3; i++) {
        const along = (Math.random() * 2 - 1) * (150 + Math.random() * 170)
        const out = 70 + Math.random() * 130
        s.sparks.push({
          x: point.x,
          y: point.y,
          vx: tx * along + normal.x * out + (Math.random() * 2 - 1) * 30,
          vy: ty * along + normal.y * out + (Math.random() * 2 - 1) * 30,
          age: 0,
          life: 0.1 + Math.random() * 0.14,
          size: 1.0 + Math.random() * 1.8,
          heat: 1,
          cold: true,
        })
      }
      if (s.sparks.length > MAX_SPARKS) s.sparks.splice(0, s.sparks.length - MAX_SPARKS)
    }

    const overdriveMult = s.overdriveSec > 0 ? OVERDRIVE_DPS_MULT : 1
    const dmgMult = armoredDeflect ? ARMORED_UNDERSIDE_DMG : 1
    b.hp -= s.stats.dps * overdriveMult * dt * intensity * dmgMult
    didDamageBlockThisFrame = true
    s.laser.hitBlockId = blockId

    // Sparks. Emission swells with musical onsets so impacts crackle a little
    // harder with the track (smooth onset envelope, not the discrete beat).
    // Deflected (chip-damage) hits keep their cold spray only.
    const musicSparkBoost = 1 + s.music.intensity * s.music.onset * 1.6
    const sparksPerSec = armoredDeflect ? 0 : 130 * clamp(intensity, 0.15, 1) * musicSparkBoost
    s.sparkEmitAcc += sparksPerSec * dt
    const emitN = Math.min(6, Math.floor(s.sparkEmitAcc))
    if (emitN > 0) s.sparkEmitAcc -= emitN
    if (emitN > 0) {
      const n = normal
      const tx = -n.y
      const ty = n.x
      for (let i = 0; i < emitN; i++) {
        // Larger, longer-throw sparks for a beefier welding burst (the streak
        // length is velocity-driven and the widths are size-driven, so scaling
        // these grows the whole effect proportionally).
        const alongN = 120 + Math.random() * 320
        const alongT = (Math.random() * 2 - 1) * (100 + Math.random() * 250)
        const jitter = 3
        s.sparks.push({
          x: point.x + (Math.random() * 2 - 1) * jitter,
          y: point.y + (Math.random() * 2 - 1) * jitter,
          vx: n.x * alongN + tx * alongT + (Math.random() * 2 - 1) * 45,
          vy: n.y * alongN + ty * alongT + (Math.random() * 2 - 1) * 45,
          age: 0,
          life: 0.14 + Math.random() * 0.26,
          size: 1.5 + Math.random() * 3.6,
          heat: 1,
        })
      }
      if (s.sparks.length > MAX_SPARKS) s.sparks.splice(0, s.sparks.length - MAX_SPARKS)
    }

    // Dwell bloom tracking.
    const sameBlock = s.weld.blockId === blockId
    const dx = point.x - s.weld.x
    const dy = point.y - s.weld.y
    const sameSpot = sameBlock && dx * dx + dy * dy <= 8 * 8
    if (sameSpot) {
      s.weld.dwell = Math.min(1, s.weld.dwell + dt * 3.2)
    } else {
      s.weld.dwell = Math.max(0, s.weld.dwell - dt * 7.0)
      s.weld.blockId = blockId
      s.weld.x = point.x
      s.weld.y = point.y
    }

    if (b.hp > 0 && !armoredDeflect) {
      const bloom = 1 + 1.15 * s.weld.dwell
      s.weldGlows.push({
        x: point.x,
        y: point.y,
        blockId,
        bloom,
        age: 0,
        life: 0.08 + 0.08 * Math.random(),
        intensity: clamp(intensity, 0.25, 1),
      })
      if (s.weldGlows.length > MAX_GLOWS) s.weldGlows.splice(0, s.weldGlows.length - MAX_GLOWS)
    }

    if (b.hp <= 0) {
      s.blocksDestroyed += 1
      // Piece-destroyed SFX (pop.wav). Polyphonic + bus-limited, so multi-kills
      // and rapid chains overlap cleanly without the volume piling up.
      sfxEngine.playPop()

      // Score: depth x combo. Each kill bumps the combo (refreshing its rolling
      // window) and scores base x combo-multiplier x route-bonus, where the base
      // scales with depth and optics-routed kills (bank/split shots) score more.
      s.combo += 1
      s.comboBest = Math.max(s.comboBest, s.combo)
      s.comboTimerSec = COMBO_WINDOW_SEC

      // Heat is no longer granted at the moment of the kill. Instead the block
      // bursts into heat motes (spawned below) carrying this kill's heat value;
      // the player vacuums them with the well to fill the gauge. The budget still
      // scales with combo + piece value, captured here at kill time.
      const heatPerKill = warmup ? WARMUP_HEAT_PER_KILL : HEAT_PER_KILL
      const heatBudget = heatPerKill * Math.max(1, b.xpValue) * (1 + 0.05 * s.combo)

      // Multi-kill: each additional block killed in the SAME beam pass (this
      // frame) is worth progressively more — the direct reward for carving a
      // path that lines up several targets at once.
      killsThisFrame += 1
      const multiKillMult = Math.min(3, 1 + 0.4 * (killsThisFrame - 1))

      // Feel: a small camera impulse per kill, growing with the multi-kill;
      // 2+ kills in one beam pass also earn a ~45ms hit-stop so the big play
      // visibly lands (sim freezes, visuals keep breathing).
      s.trauma = Math.min(1, s.trauma + 0.1 + 0.07 * (killsThisFrame - 1))
      if (killsThisFrame >= 2) s.hitStopSec = Math.max(s.hitStopSec, 0.045)

      const comboMult = Math.min(COMBO_SCORE_MULT_CAP, 1 + 0.1 * (s.combo - 1))
      const routeBonus = viaOptics ? 1.75 : 1
      const overdriveScore = s.overdriveSec > 0 ? OVERDRIVE_SCORE_MULT : 1
      const depthBase = 10 + s.depth * 0.5
      const gained = Math.round(depthBase * comboMult * routeBonus * overdriveScore * multiKillMult * Math.max(1, b.xpValue))
      // Scoring is suppressed during the warmup (it resets to 0 at handoff), but
      // the combo + charge mechanics still run so the player learns them.
      if (!warmup) s.score += gained
      // Surge the music-reactive layer on satisfying plays (bigger combos /
      // optic routes / multi-kills push harder). Renderer reads `crescendo`.
      s.crescendo = clamp(
        s.crescendo + 0.12 + 0.02 * s.combo + (viaOptics ? 0.15 : 0) + 0.12 * (killsThisFrame - 1),
        0,
        1,
      )

      // Increment golden XP bonus when a golden block is destroyed
      if (b.isGold) {
        s.stats.goldXpBonus += 1
      }

      // Death FX: the block explodes into heat motes carrying this kill's heat
      // budget. The player vacuums them with the well to fill the gauge (replaces
      // the old melt-into-XP-orb flow). Gold blocks burst brighter (their large
      // heat budget is simply spread across the standard mote count).
      spawnHeatMotes(s, b, heatBudget, 0, s.overdriveSec > 0)

      // Brief dissolve flash so the piece doesn't blink out the instant its motes
      // appear — the silhouette pops + fades in-place as the debris bursts.
      s.pieceBursts.push({
        id: s.nextPieceBurstId++,
        pos: { x: b.pos.x, y: b.pos.y },
        cellSize: b.cellSize,
        cornerRadius: b.cornerRadius,
        loop: b.loop,
        localAabb: { ...b.localAabb },
        isGold: b.isGold,
        t: 0,
        dur: 0.3,
      })
      if (s.pieceBursts.length > 48) {
        s.pieceBursts.splice(0, s.pieceBursts.length - 48)
      }

      // Check if this destroyed block should spawn a splitter (prism)
      if (s.stats.splitterChance > 0 && Math.random() < s.stats.splitterChance) {
        // Spawn prism at the block's position
        spawnPrismAt(s, b.pos.x, b.pos.y)
      }

      s.blocks = s.blocks.filter((x) => x.id !== b.id)

      // Shatter: the kill scores normally above, but the piece doesn't just
      // vanish — it breaks into a cluster of slow 1x1 blocks across its footprint
      // (added after the parent is removed; they enter the scene next frame, so
      // the same beam pass can't instantly re-clear them).
      if (b.kind === 'shatter') {
        spawnShatterChildren(s, b)
      }

      vibrate([10, 30, 14])
    }
  }

  // Top wall sits at the world Y that maps to the visible top edge of the
  // screen, so the laser terminates exactly where the play area ends visually.
  const bounds = { w: s.view.width, h: s.view.height, top: screenTopWorldY(s.view, layout) }

  let raysProcessed = 0

  // ---- Beam path ----
  // The fixed muzzle fires straight up. The player's gravity-well puck warps the
  // beam by *proximity* (exactly like the old board black holes): when the beam
  // crosses into the well's influence it curves around it (slingshot / orbit),
  // and it is only absorbed when it actually crosses the tiny core. Mirrors/walls
  // reflect into a straight continuation (which the field can grab again); prisms
  // split. We trace in canonical world space but evaluate the field in *screen*
  // space so steering feels uniform across the perspective.
  const proj = makeProjection(s.view, layout)
  // The well lives in world space; project it to screen for the field math, and
  // shrink its screen-space influence/core with depth so it stays "in" the
  // perspective.
  const wellProj = proj.project(s.well.pos.x, s.well.pos.y)
  const wsx = wellProj.x
  const wsy = wellProj.y
  const wScale = clamp(wellProj.scale, 0.18, 1.6)
  const wellInfluenceR = WELL_INFLUENCE_R * wScale
  const wellCoreR = WELL_CORE_R * wScale

  // World distance along a (normalized) ray at which it first enters the well's
  // screen-space influence disc, or null if it never does ahead within maxDist.
  // The homography maps the world ray to a screen line, so we intersect that line
  // with the influence circle and map the entry point back to world.
  const wellEnterT = (o: Vec2, d: Vec2): number | null => {
    if (!s.well.placed) return null
    const aS = proj.project(o.x, o.y)
    const bS = proj.project(o.x + d.x * 240, o.y + d.y * 240)
    let lx = bS.x - aS.x
    let ly = bS.y - aS.y
    const ll = Math.hypot(lx, ly)
    if (ll < 1e-4) return null
    lx /= ll
    ly /= ll
    const ocx = aS.x - wsx
    const ocy = aS.y - wsy
    const b = ocx * lx + ocy * ly
    const c = ocx * ocx + ocy * ocy - wellInfluenceR * wellInfluenceR
    const disc = b * b - c
    if (disc < 0) return null
    const sdisc = Math.sqrt(disc)
    let uS = -b - sdisc
    if (c < 0) uS = 0 // already inside the disc
    else if (uS < 0) {
      uS = -b + sdisc
      if (uS < 0) return null
    }
    const exW = proj.unproject(aS.x + lx * uS, aS.y + ly * uS)
    return (exW.x - o.x) * d.x + (exW.y - o.y) * d.y
  }

  // The beam always exists as a straight-up ray from the muzzle; the field bends it.
  // Pierce budget = base + combo tiers (skill-elastic throughput) + overdrive bonus.
  const comboPierce =
    s.combo >= COMBO_PIERCE_TIER2 ? 2 : s.combo >= COMBO_PIERCE_TIER1 ? 1 : 0
  enqueueRay({
    o: { ...s.emitter.pos },
    d: { x: 0, y: -1 },
    intensity: 1,
    bouncesLeft: s.stats.maxBounces,
    piercesLeft:
      s.stats.maxPierces + comboPierce + (overdrive ? OVERDRIVE_BONUS_PIERCES : 0),
    minT: 0,
    ignorePrismId: -1,
    viaOptics: false,
  })

  while (queue.length > 0 && raysProcessed < MAX_RAYS && s.laser.segments.length < MAX_SEGMENTS) {
    const ray = queue.pop()!
    raysProcessed++

    let o = { ...ray.o }
    let d = normalize(ray.d)
    let intensity = ray.intensity
    let bouncesLeft = ray.bouncesLeft
    let piercesLeft = ray.piercesLeft
    let minT = ray.minT
    const ignorePrismId = ray.ignorePrismId
    // The single block the beam just pierced, skipped on the next cast so it
    // doesn't immediately re-hit that block's far face. Reset on any reflection.
    let ignoreBlockId = -1
    // The mirror the beam just reflected off, skipped on the next cast so the
    // thick beam doesn't immediately re-clip the same diagonal. Reset on a wall.
    let ignoreMirrorId = -1
    // A kill on this ray counts as "via optics" if it already passed an optic or
    // reflects off a mirror/wall before connecting (rewards bank/split shots).
    let routedOptics = ray.viaOptics
    let rayLive = true

    for (let guard = 0; guard < 96 && rayLive && s.laser.segments.length < MAX_SEGMENTS; guard++) {
      const enterT = wellEnterT(o, d)

      const hit = raycastSceneThick(
        o,
        d,
        s.blocks,
        s.features,
        maxDist,
        beamRadius,
        minT,
        bounds,
        ignorePrismId >= 0 ? ignorePrismId : undefined,
        ignoreBlockId >= 0 ? ignoreBlockId : undefined,
        ignoreMirrorId >= 0 ? ignoreMirrorId : undefined,
      )

      // If we'd reach the well's field before any solid hit, segment to the field
      // boundary and integrate the curve inside it.
      if (enterT != null && enterT >= minT && enterT <= maxDist && (!hit || enterT < hit.t - 0.6)) {
        const entry = enterT <= 0 ? o : add(o, mul(d, enterT))
        if (enterT > 0 && !tryAddSeg(o, entry, intensity)) break
        o = entry

        for (let step = 0; step < MAX_CURVE_STEPS && s.laser.segments.length < MAX_SEGMENTS; step++) {
          const oS = proj.project(o.x, o.y)
          const ddx = wsx - oS.x
          const ddy = wsy - oS.y
          const distS = Math.hypot(ddx, ddy)
          const invD = distS > 1e-3 ? 1 / distS : 0

          // Screen-space travel direction (perspective-correct).
          const fS = proj.project(o.x + d.x * 2, o.y + d.y * 2)
          let sdx = fS.x - oS.x
          let sdy = fS.y - oS.y
          const sl = Math.hypot(sdx, sdy) || 1
          sdx /= sl
          sdy /= sl

          // Inward = how directly the beam is heading at the core (>0 = toward).
          const inward = (sdx * ddx + sdy * ddy) * invD

          // Crossed the core: only absorbed on a genuine inward dive. A tangential
          // skim is left to whip around the well instead of getting eaten.
          if (distS <= wellCoreR && inward > WELL_CAPTURE_DOT) {
            rayLive = false
            break
          }

          // Lateral = which side the well is on, in screen space (perp . toward).
          const lateral = -sdy * ddx * invD + sdx * ddy * invD
          const tNorm = 1 - distS / wellInfluenceR
          const minStrength = 0.28
          const strength = minStrength + (1 - minStrength) * tNorm
          // Base falloff (unchanged across the low/mid field) + a near-core bite
          // that lifts only the top end of the curve so a head-on pass can bend
          // past 90°. tNorm is clamped so the even power can't add spurious turn
          // just outside the field boundary.
          const tBite = tNorm > 0 ? tNorm : 0
          const w =
            strength * strength * strength + WELL_NEAR_BITE * Math.pow(tBite, WELL_NEAR_BITE_POWER)
          const turnSum = lateral * w

          // Apply the bend to the *world* direction (orientation is preserved by
          // the projection, so the screen-derived sign curves the right way).
          const perpW = normalize({ x: -d.y, y: d.x })
          d = normalize(add(d, mul(perpW, WELL_BEND_K * turnSum * WELL_STEP_SCREEN)))

          // Advance a fixed screen step (converted to world via the local scale)
          // so the arc stays smooth regardless of depth.
          const sc = proj.scaleAt(o.y)
          const worldStep = clamp(WELL_STEP_SCREEN / Math.max(sc, 0.06), 4, 90)

          const stepHit = raycastSceneThick(
            o,
            d,
            s.blocks,
            s.features,
            worldStep,
            beamRadius,
            0.25,
            bounds,
            ignorePrismId >= 0 ? ignorePrismId : undefined,
            ignoreBlockId >= 0 ? ignoreBlockId : undefined,
            ignoreMirrorId >= 0 ? ignoreMirrorId : undefined,
          )
          if (!stepHit) {
            const next = add(o, mul(d, worldStep))
            if (!tryAddSeg(o, next, intensity)) {
              rayLive = false
              break
            }
            o = next
            // Left the field after this step -> resume straight tracing.
            const eS = proj.project(o.x, o.y)
            if (Math.hypot(wsx - eS.x, wsy - eS.y) >= wellInfluenceR) {
              minT = 0
              break
            }
            continue
          }

          if (!tryAddSeg(o, stepHit.point, intensity)) {
            rayLive = false
            break
          }
          if (stepHit.kind === 'block') {
            // Pierce: damage the block and keep going through it (routing =
            // throughput), with a per-block intensity falloff and a pierce cap.
            dealDamageAtHit(stepHit.id, stepHit.point, stepHit.normal, intensity, routedOptics)
            const cblk = s.blocks.find((bb) => bb.id === stepHit.id)
            if (cblk && cblk.kind === 'chrome') {
              // Chrome reflects (scrambles routing) instead of being pierced.
              if (bouncesLeft <= 0) {
                rayLive = false
                break
              }
              routedOptics = true
              d = normalize(reflect(d, stepHit.normal))
              intensity *= s.stats.bounceFalloff
              bouncesLeft -= 1
              o = add(stepHit.point, mul(stepHit.normal, EPS + beamRadius))
              minT = EPS + beamRadius * 0.75
              ignoreBlockId = -1
              break // resume outer tracing (re-detect the field)
            }
            if (cblk && cblk.kind === 'armored' && stepHit.normal.y >= 0.45) {
              // Armored underside acts as a fixed mirror: the beam bounces off it
              // (no pierce, no damage). Free reflection (like a wall) so the armor
              // always deflects regardless of the remaining bounce budget.
              routedOptics = true
              d = normalize(reflect(d, stepHit.normal))
              o = add(stepHit.point, mul(stepHit.normal, EPS + beamRadius))
              minT = EPS + beamRadius * 0.75
              ignoreBlockId = -1
              break // resume outer tracing (re-detect the field)
            }
            if (piercesLeft <= 0) {
              rayLive = false
              break
            }
            piercesLeft -= 1
            intensity *= s.stats.pierceFalloff
            if (intensity < MIN_PIERCE_INTENSITY) {
              rayLive = false
              break
            }
            ignoreBlockId = stepHit.id
            o = add(stepHit.point, mul(d, EPS + beamRadius))
            continue // keep integrating the curve through the block
          }
          if (stepHit.kind === 'mirror' || stepHit.kind === 'wall') {
            if (stepHit.kind === 'wall' && stepHit.id === -4) {
              rayLive = false
              break
            }
            const isWall = stepHit.kind === 'wall'
            const skipPenalty = isWall && s.stats.noWallPenalty
            if (!skipPenalty && bouncesLeft <= 0) {
              rayLive = false
              break
            }
            if (stepHit.kind === 'mirror') {
              damageMirror(stepHit.id, intensity)
              ignoreMirrorId = stepHit.id
            } else {
              ignoreMirrorId = -1
            }
            routedOptics = true
            d = normalize(reflect(d, stepHit.normal))
            if (!skipPenalty) {
              intensity *= s.stats.bounceFalloff
              bouncesLeft -= 1
            }
            o = add(stepHit.point, mul(stepHit.normal, EPS + beamRadius))
            minT = EPS + beamRadius * 0.75
            ignoreBlockId = -1
            break // resume the outer tracing loop (re-detect the field)
          }
          if (stepHit.kind === 'prism') {
            emitPrismRays(stepHit.id, stepHit.point, d, intensity, bouncesLeft, piercesLeft)
            rayLive = false
            break
          }
          rayLive = false
          break
        }

        continue
      }

      if (!hit) {
        const end = add(o, mul(d, maxDist))
        tryAddSeg(o, end, intensity)
        break
      }

      if (!tryAddSeg(o, hit.point, intensity)) break

      if (hit.kind === 'block') {
        // Pierce: damage the block and continue straight through it, with a
        // per-block intensity falloff and a pierce cap so focusing beats spraying.
        dealDamageAtHit(hit.id, hit.point, hit.normal, intensity, routedOptics)
        const cblk = s.blocks.find((bb) => bb.id === hit.id)
        if (cblk && cblk.kind === 'chrome') {
          // Chrome reflects (scrambles routing) instead of being pierced.
          if (bouncesLeft <= 0) break
          routedOptics = true
          d = normalize(reflect(d, hit.normal))
          intensity *= s.stats.bounceFalloff
          bouncesLeft -= 1
          o = add(hit.point, mul(hit.normal, EPS + beamRadius))
          minT = EPS + beamRadius * 0.75
          ignoreBlockId = -1
          continue
        }
        if (cblk && cblk.kind === 'armored' && hit.normal.y >= 0.45) {
          // Armored underside acts as a fixed mirror: the beam bounces off it
          // (no pierce, no damage). Free reflection (like a wall) so the armor
          // always deflects regardless of the remaining bounce budget.
          routedOptics = true
          d = normalize(reflect(d, hit.normal))
          o = add(hit.point, mul(hit.normal, EPS + beamRadius))
          minT = EPS + beamRadius * 0.75
          ignoreBlockId = -1
          continue
        }
        if (piercesLeft <= 0) break
        piercesLeft -= 1
        intensity *= s.stats.pierceFalloff
        if (intensity < MIN_PIERCE_INTENSITY) break
        ignoreBlockId = hit.id
        o = add(hit.point, mul(d, EPS + beamRadius))
        minT = EPS + beamRadius * 0.75
        continue
      }

      if (hit.kind === 'mirror' || hit.kind === 'wall') {
        // Bottom wall (id -4) doesn't reflect - laser terminates
        if (hit.kind === 'wall' && hit.id === -4) break

        // Wall bounces: apply penalty unless noWallPenalty upgrade is active.
        const isWall = hit.kind === 'wall'
        const skipPenalty = isWall && s.stats.noWallPenalty

        if (!skipPenalty && bouncesLeft <= 0) break
        // Mirrors take chip damage (and can burn through); walls just reflect.
        if (hit.kind === 'mirror') {
          damageMirror(hit.id, intensity)
          ignoreMirrorId = hit.id
        } else {
          ignoreMirrorId = -1
        }
        // Any reflection routes the beam; reward the resulting kill as a bank shot.
        routedOptics = true
        d = normalize(reflect(d, hit.normal))
        if (!skipPenalty) {
          intensity *= s.stats.bounceFalloff
          bouncesLeft -= 1
        }
        // Offset along the normal to ensure we start outside the surface, especially at acute angles
        o = add(hit.point, mul(hit.normal, EPS + beamRadius))
        minT = EPS + beamRadius * 0.75
        ignoreBlockId = -1
        continue
      }

      if (hit.kind === 'prism') {
        emitPrismRays(hit.id, hit.point, d, intensity, bouncesLeft, piercesLeft)
        break
      }

      break
    }
  }

  // The well is purely a beam lens now (it bends the beam by proximity above).
  // It deals no contact damage; all damage comes from the routed beam.

  // If we're not actively damaging a block this frame, let dwell cool off.
  if (!didDamageBlockThisFrame) {
    s.weld.dwell = Math.max(0, s.weld.dwell - dt * 6.5)
    if (s.weld.dwell === 0) s.weld.blockId = -1
  }

  // Restore logical positions after laser computation.
  restoreLogicalPositions(s)

  // Just-in-time piece coachmarks: once a never-seen piece kind is fully on
  // screen, pause and arm the OK card (App renders + dismisses it). Skipped
  // during the warmup; setting `paused` here stops further stepSim via the App
  // gate, freezing the piece fully in view.
  scanJitTrigger(s)
}

