import { add, clamp, mul, normalize, reflect } from './math'
import type { Vec2 } from './math'
import type { RunState } from './runState'
import { raycastSceneThick } from './raycast'
import { spawnBoardThing, spawnPrismAt } from './spawn'
import { BLOCK_MELT_DUR, XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR } from './runState'
import { getArenaLayout } from './layout'
import { makeProjection, screenTopWorldY } from '../render/projection'
import { computeXpCap, autoApplyLevelUp } from './levelUp'

const EPS = 1.0
const MAX_SPARKS = 280
const MAX_GLOWS = 24
const MAX_RAYS = 24
const MAX_SEGMENTS = 180
// Max small steps spent integrating the beam inside the well's curving field.
const MAX_CURVE_STEPS = 260

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

// Score-attack tuning.
export const COMBO_WINDOW_SEC = 4.0 // a kill must land within this window to keep the combo
// Beat-synced descent: floor between beat steps (fast tracks can't avalanche).
const MIN_STEP_SEC = 0.3
// With music, drop the board every Nth detected beat (every beat was far too
// fast). 2 = half speed, 4 = quarter speed. (Tunable.)
const BEAT_STEP_DIVISOR = 4
// If beats stall (a silent passage), still nudge the board after this long so the
// run keeps forward pressure even mid-track.
const BEAT_DROPOUT_SEC = 3.0

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
// World-space contact radius for the parked hole's "consume" damage. Matches
// the rendered black core (which is this size at the near plane) so contact
// reads true to the visual at every depth.
const WELL_DAMAGE_R = 17

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

// Helper functions for smooth drop animation hitbox adjustment
const adjustPositionsForAnimation = (s: RunState) => {
  if (s.dropAnimOffset > 0) {
    for (const b of s.blocks) {
      b.pos.y -= s.dropAnimOffset
    }
    for (const f of s.features) {
      f.pos.y -= s.dropAnimOffset
    }
  }
}

const restoreLogicalPositions = (s: RunState) => {
  if (s.dropAnimOffset > 0) {
    for (const b of s.blocks) {
      b.pos.y += s.dropAnimOffset
    }
    for (const f of s.features) {
      f.pos.y += s.dropAnimOffset
    }
  }
}

export const stepSim = (s: RunState, dt: number) => {
  s.timeSec += dt

  // Level-up notification FX
  if (s.levelUpNotificationFx) {
    s.levelUpNotificationFx.t += dt
    const totalDur = s.levelUpNotificationFx.displayDur + s.levelUpNotificationFx.fadeDur
    if (s.levelUpNotificationFx.t >= totalDur) {
      s.levelUpNotificationFx = null
    }
  }

  const smoothstep = (x: number) => x * x * (3 - 2 * x)

  // Difficulty curve: deliberately easy first minute so players can buy upgrades,
  // then ramp over the next ~5 minutes.
  const earlyT = clamp(s.timeSec / 60, 0, 1)
  const lateT = clamp((s.timeSec - 60) / 300, 0, 1)
  const e = smoothstep(earlyT)
  const l = smoothstep(lateT)

  // Movement is now tetris-like: blocks step down together on a global timer.

  const layout = getArenaLayout(s.view)
  const cellSize = 40

  const xpOrbTarget = (): Vec2 => {
    // Aim for the *current* top of the filled portion of the XP bar.
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    const xpFrac = clamp(s.xp / Math.max(1, s.xpCap), 0, 1)
    const fillH = gh * xpFrac
    return { x: gx + gw / 2, y: gy + (gh - fillH) }
  }

  // Respite after losing a life: no spawns for a moment.
  if (s.respiteSec > 0) {
    s.respiteSec = Math.max(0, s.respiteSec - dt)
  }

  // Spawn pacing (director-style): a time-based target curve, with pressure guardrails
  // so the game ramps without spiraling into impossible states.
  // Increased density: ~20% faster spawn rates
  s.spawnTimer -= dt
  const spawnEveryEarly = 0.94 + (0.66 - 0.94) * e // 0-60s: 0.94 -> 0.66 (20% faster than before)
  const spawnEveryLate = 1.24 + (0.76 - 1.24) * l // 60-360s: 1.24 -> 0.76 (20% faster than before)
  const spawnEveryBase = s.timeSec < 60 ? spawnEveryEarly : spawnEveryLate

  const maxBlocksEarly = Math.floor(5 + 2 * e) // 5 -> 7 (increased from 4->6)
  const maxBlocksLate = Math.floor(7 + 6 * l) // 7 -> 13 (increased from 6->11)
  const maxBlocksBase = s.timeSec < 60 ? maxBlocksEarly : maxBlocksLate

  // Pressure: if blocks are close to failing, slow/stop spawns to preserve fairness.
  const dangerY = layout.failY - 2 * cellSize
  let dangerCount = 0
  for (const b of s.blocks) {
    const bottom = b.pos.y + b.localAabb.maxY
    if (bottom >= dangerY) dangerCount++
  }
  const pressure01 = clamp(dangerCount / 3, 0, 1)
  const spawnEvery = spawnEveryBase * (1 + 0.85 * pressure01)
  const maxBlocks = Math.max(3, maxBlocksBase - Math.floor(2 * pressure01))

  const allowSpawn = dangerCount === 0 && s.respiteSec <= 0
  if (allowSpawn && s.spawnTimer <= 0) {
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

  // Combo + crescendo decay. The combo lapses if no kill lands inside the rolling
  // window; the crescendo (visual surge) eases back continuously.
  if (s.comboTimerSec > 0) {
    s.comboTimerSec = Math.max(0, s.comboTimerSec - dt)
    if (s.comboTimerSec === 0) s.combo = 0
  }
  if (s.crescendo > 0) {
    s.crescendo = Math.max(0, s.crescendo - dt * 0.9)
  }

  // Field descent: the board steps down one cell per *music beat*, with a
  // silent-mode metronome (dropIntervalSec) guaranteeing forward pressure when
  // no beats arrive. Beat steps are rate-limited by MIN_STEP_SEC so fast tracks
  // can't avalanche the board.
  s.sinceStepSec += dt

  // Smooth drop animation: continuously ease the visual offset back to 0.
  if (s.dropAnimOffset > 0) {
    const animSpeed = cellSize / s.dropAnimDuration
    s.dropAnimOffset = Math.max(0, s.dropAnimOffset - animSpeed * dt)
  }

  const beatFired = s.music.playing && s.music.beatToken !== s.lastBeatToken
  s.lastBeatToken = s.music.beatToken
  const fallbackStep = Math.max(MIN_STEP_SEC, s.dropIntervalSec)
  let stepNow: boolean
  if (s.music.playing) {
    // Step only every Nth beat so the descent reads musically without
    // avalanching; a beat-dropout safety covers silent passages. The fallback
    // metronome does NOT apply here, or it would quietly override the slower
    // musical cadence.
    const descentBeat = beatFired && s.music.beatToken % BEAT_STEP_DIVISOR === 0
    stepNow =
      (descentBeat && s.sinceStepSec >= MIN_STEP_SEC) || s.sinceStepSec >= BEAT_DROPOUT_SEC
  } else {
    stepNow = s.sinceStepSec >= fallbackStep
  }

  if (stepNow) {
    s.sinceStepSec = 0
    s.dropTimerSec = s.dropIntervalSec

    // Snap logical positions forward immediately (physics/collision use this).
    s.depth += 1
    for (const b of s.blocks) {
      b.pos.y += b.cellSize
    }
    for (const f of s.features) {
      f.pos.y += f.cellSize
    }

    // Start the visual catch-up animation (offset counts back down to 0).
    s.dropAnimOffset = cellSize
  } else {
    // Expose time-to-forced-step as the HUD countdown value (a beat can fire
    // sooner; this is the guaranteed fallback / dropout safety).
    const guaranteed = s.music.playing ? BEAT_DROPOUT_SEC : fallbackStep
    s.dropTimerSec = Math.max(0, guaranteed - s.sinceStepSec)
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

  // Melt FX: blocks collapse into a molten blob, then release an XP orb that flies away.
  if (s.meltFx.length > 0) {
    const done: string[] = []
    for (const fx of s.meltFx) {
      fx.t += dt
      if (fx.t >= fx.dur) {
        // Spawn the XP orb in fly phase at the end of the melt.
        s.xpOrbs.push({
          id: `orb-${s.nextOrbId++}`,
          from: { ...fx.orbFrom },
          to: xpOrbTarget(),
          t: 0,
          phase: 'fly',
          value: fx.value,
        })
        done.push(fx.id)
      }
    }
    if (done.length > 0) {
      s.meltFx = s.meltFx.filter((f) => !done.includes(f.id))
    }
  }

  // Update XP orbs (condense -> fly -> deliver).
  if (s.xpOrbs.length > 0) {
    const delivered: string[] = []
    for (const orb of s.xpOrbs) {
      orb.t += dt
      if (orb.phase === 'condense') {
        if (orb.t >= XP_ORB_CONDENSE_DUR) {
          orb.phase = 'fly'
          orb.t = 0
        }
      } else {
        if (orb.t >= XP_ORB_FLY_DUR) {
          // Deliver XP at end of flight.
          s.xp += orb.value
          delivered.push(orb.id)
        }
      }
    }
    if (delivered.length > 0) {
      s.xpOrbs = s.xpOrbs.filter((o) => !delivered.includes(o.id))
    }
  }

  // Level-up trigger: when XP fills, automatically apply +1 DPS (no menu).
  if (!s.levelUpActive && s.xp >= s.xpCap) {
    s.xp -= s.xpCap
    s.level += 1
    s.xpCap = computeXpCap(s.level)
    autoApplyLevelUp(s)
    // Show level-up notification (1s display + 300ms fade)
    s.levelUpNotificationFx = {
      t: 0,
      displayDur: 1.0,
      fadeDur: 0.3,
    }
    // Micro "breather" after level-up so the board doesn't immediately spawn into pressure.
    s.spawnTimer = Math.max(s.spawnTimer, 0.75)
  }

  // Fail line sits just above the bottom rail. Single life: the first block to
  // cross it ends the run ("how deep did you get").
  const failY = layout.failY
  for (const b of s.blocks) {
    const bottom = b.pos.y + b.localAabb.maxY
    if (bottom >= failY) {
      s.lives = 0
      s.gameOver = true
      s.paused = true
      s.levelUpActive = false
      s.levelUpOptions = []
      s.pendingLevelUps = 0
      s.xpOrbs = []
      s.bestScoreLocal = Math.max(s.bestScoreLocal, s.score)

      // Stronger end-of-run haptic.
      const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }
      if (typeof nav.vibrate === 'function') {
        nav.vibrate([18, 50, 16, 50, 24])
      }
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

  // Apply smooth drop animation offset to hitboxes for laser interactions.
  // Temporarily adjust positions to visual positions so hitboxes animate smoothly.
  adjustPositionsForAnimation(s)

  // Range is effectively infinite (within the screen). Always cast far enough to cross the whole view.
  const maxDist = Math.hypot(s.view.width, s.view.height) * 1.35
  const beamRadius = Math.max(0, s.stats.beamWidth * 0.45)
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

  const emitPrismRays = (prismId: number, hitPoint: Vec2, incoming: Vec2, intensity: number, bouncesLeft: number) => {
    const prism = s.features.find((f) => f.kind === 'prism' && f.id === prismId) as
      | { exitsDeg?: number[] }
      | undefined
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

  const dealDamageAtHit = (
    blockId: number,
    point: Vec2,
    normal: Vec2,
    intensity: number,
    viaOptics: boolean,
  ) => {
    const b = s.blocks.find((bb) => bb.id === blockId)
    if (!b) return
    b.hp -= s.stats.dps * dt * intensity
    didDamageBlockThisFrame = true
    s.laser.hitBlockId = blockId

    // Sparks. Emission swells with musical onsets so impacts crackle a little
    // harder with the track (smooth onset envelope, not the discrete beat).
    const musicSparkBoost = 1 + s.music.intensity * s.music.onset * 1.6
    const sparksPerSec = 130 * clamp(intensity, 0.15, 1) * musicSparkBoost
    s.sparkEmitAcc += sparksPerSec * dt
    const emitN = Math.min(6, Math.floor(s.sparkEmitAcc))
    if (emitN > 0) s.sparkEmitAcc -= emitN
    if (emitN > 0) {
      const n = normal
      const tx = -n.y
      const ty = n.x
      for (let i = 0; i < emitN; i++) {
        const alongN = 80 + Math.random() * 220
        const alongT = (Math.random() * 2 - 1) * (70 + Math.random() * 180)
        const jitter = 2.5
        s.sparks.push({
          x: point.x + (Math.random() * 2 - 1) * jitter,
          y: point.y + (Math.random() * 2 - 1) * jitter,
          vx: n.x * alongN + tx * alongT + (Math.random() * 2 - 1) * 35,
          vy: n.y * alongN + ty * alongT + (Math.random() * 2 - 1) * 35,
          age: 0,
          life: 0.12 + Math.random() * 0.22,
          size: 0.9 + Math.random() * 2.4,
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

    if (b.hp > 0) {
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

      // Score: depth x combo. Each kill bumps the combo (refreshing its rolling
      // window) and scores base x combo-multiplier x route-bonus, where the base
      // scales with depth and optics-routed kills (bank/split shots) score more.
      s.combo += 1
      s.comboBest = Math.max(s.comboBest, s.combo)
      s.comboTimerSec = COMBO_WINDOW_SEC
      const comboMult = 1 + 0.1 * (s.combo - 1)
      const routeBonus = viaOptics ? 1.75 : 1
      const depthBase = 10 + s.depth * 0.5
      const gained = Math.round(depthBase * comboMult * routeBonus * Math.max(1, b.xpValue))
      s.score += gained
      // Surge the music-reactive layer on satisfying plays (bigger combos /
      // optic routes push harder). Renderer reads `crescendo`.
      s.crescendo = clamp(s.crescendo + 0.12 + 0.02 * s.combo + (viaOptics ? 0.15 : 0), 0, 1)

      // Increment golden XP bonus when a golden block is destroyed
      if (b.isGold) {
        s.stats.goldXpBonus += 1
      }
      
      const cx = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
      // Melt collapses downward into a small blob near the *bottom* of the piece, then releases the XP orb.
      const bottom = b.pos.y + b.localAabb.maxY
      const orbFrom = { x: cx, y: bottom - 6 }
      
      // For gold blocks, spawn multiple XP orbs with offsets and delays
      if (b.isGold && b.xpValue >= 5) {
        const orbCount = b.xpValue
        const xpPerOrb = b.xpValue / orbCount // distribute total XP evenly
        for (let i = 0; i < orbCount; i++) {
          const angle = (i / orbCount) * Math.PI * 2
          const radius = 8
          const offsetX = Math.cos(angle) * radius
          const offsetY = Math.sin(angle) * radius
          const delay = i * 0.08 // slight animation delay between orbs
          
          s.meltFx.push({
            id: `melt-${s.nextMeltId++}`,
            pos: { ...b.pos },
            cellSize: b.cellSize,
            cornerRadius: b.cornerRadius,
            loop: b.loop,
            localAabb: { ...b.localAabb },
            t: -delay, // negative time creates delay effect; melt update adds dt each frame
            dur: BLOCK_MELT_DUR,
            orbFrom: { x: orbFrom.x + offsetX, y: orbFrom.y + offsetY },
            orbTo: { ...layout.xpTarget },
            value: xpPerOrb,
            seed: Math.random() * 1000,
          })
        }
      } else {
        s.meltFx.push({
          id: `melt-${s.nextMeltId++}`,
          pos: { ...b.pos },
          cellSize: b.cellSize,
          cornerRadius: b.cornerRadius,
          loop: b.loop,
          localAabb: { ...b.localAabb },
          t: 0,
          dur: BLOCK_MELT_DUR,
          orbFrom,
          orbTo: { ...layout.xpTarget },
          value: b.xpValue,
          seed: Math.random() * 1000,
        })
      }

      // Check if this destroyed block should spawn a splitter (prism)
      if (s.stats.splitterChance > 0 && Math.random() < s.stats.splitterChance) {
        // Spawn prism at the block's position
        spawnPrismAt(s, b.pos.x, b.pos.y)
      }

      s.blocks = s.blocks.filter((x) => x.id !== b.id)

      const nav = navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }
      if (typeof nav.vibrate === 'function') {
        nav.vibrate([10, 30, 14])
      }
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
  enqueueRay({
    o: { ...s.emitter.pos },
    d: { x: 0, y: -1 },
    intensity: 1,
    bouncesLeft: s.stats.maxBounces,
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
    let minT = ray.minT
    const ignorePrismId = ray.ignorePrismId
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
          const w = strength * strength * strength
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
            // First-hit weld: damage and stop (no bounce off blocks).
            dealDamageAtHit(stepHit.id, stepHit.point, stepHit.normal, intensity, routedOptics)
            rayLive = false
            break
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
            routedOptics = true
            d = normalize(reflect(d, stepHit.normal))
            if (!skipPenalty) {
              intensity *= s.stats.bounceFalloff
              bouncesLeft -= 1
            }
            o = add(stepHit.point, mul(stepHit.normal, EPS + beamRadius))
            minT = EPS + beamRadius * 0.75
            break // resume the outer tracing loop (re-detect the field)
          }
          if (stepHit.kind === 'prism') {
            emitPrismRays(stepHit.id, stepHit.point, d, intensity, bouncesLeft)
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
        // First-hit weld: damage and stop (no bounce off blocks).
        dealDamageAtHit(hit.id, hit.point, hit.normal, intensity, routedOptics)
        break
      }

      if (hit.kind === 'mirror' || hit.kind === 'wall') {
        // Bottom wall (id -4) doesn't reflect - laser terminates
        if (hit.kind === 'wall' && hit.id === -4) break

        // Wall bounces: apply penalty unless noWallPenalty upgrade is active.
        const isWall = hit.kind === 'wall'
        const skipPenalty = isWall && s.stats.noWallPenalty

        if (!skipPenalty && bouncesLeft <= 0) break
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
        continue
      }

      if (hit.kind === 'prism') {
        emitPrismRays(hit.id, hit.point, d, intensity, bouncesLeft)
        break
      }

      break
    }
  }

  // ---- Black-hole contact damage ----
  // A parked (not held) hole consumes whatever it touches, dealing the beam's
  // full DPS to every block overlapping its core. Runs here so it shares the
  // visual (drop-animated) positions and the destruction/combo/melt path.
  {
    const well = s.well
    let damaging = false
    if (well.placed && !well.grabbed) {
      // Well position is already world-space; contact radius is world units.
      const wc = { x: well.pos.x, y: well.pos.y }
      const wr = WELL_DAMAGE_R
      const wr2 = wr * wr
      // Snapshot ids first: dealDamageAtHit mutates s.blocks on destruction.
      for (const b of s.blocks.slice()) {
        const a = b.localAabb
        const minX = b.pos.x + a.minX
        const maxX = b.pos.x + a.maxX
        const minY = b.pos.y + a.minY
        const maxY = b.pos.y + a.maxY
        const nx = clamp(wc.x, minX, maxX)
        const ny = clamp(wc.y, minY, maxY)
        const ddx = wc.x - nx
        const ddy = wc.y - ny
        if (ddx * ddx + ddy * ddy > wr2) continue
        damaging = true
        // Damage point on the block surface nearest the core; normal points from
        // the block center toward the hole so sparks spit outward sensibly.
        const cxB = (minX + maxX) * 0.5
        const cyB = (minY + maxY) * 0.5
        const nlen = Math.hypot(wc.x - cxB, wc.y - cyB)
        const normal =
          nlen > 1e-3 ? { x: (wc.x - cxB) / nlen, y: (wc.y - cyB) / nlen } : { x: 0, y: -1 }
        // Direct consume = full intensity, not an optics route.
        dealDamageAtHit(b.id, { x: nx, y: ny }, normal, 1, false)
      }
    }
    well.damaging = damaging
  }

  // If we're not actively damaging a block this frame, let dwell cool off.
  if (!didDamageBlockThisFrame) {
    s.weld.dwell = Math.max(0, s.weld.dwell - dt * 6.5)
    if (s.weld.dwell === 0) s.weld.blockId = -1
  }

  // Restore logical positions after laser computation.
  restoreLogicalPositions(s)
}

