import { add, clamp, mul, normalize, reflect } from './math'
import type { Vec2 } from './math'
import type { RunState, MirrorFeature } from './runState'
import { raycastSceneThick } from './raycast'
import { spawnBoardThing, spawnPrismAt } from './spawn'
import { BLOCK_MELT_DUR, XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR } from './runState'
import { getArenaLayout } from './layout'
import { makeProjection, screenTopWorldY } from '../render/projection'
import { sfxEngine } from '../audio/sfx'

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

// Score-attack tuning.
export const COMBO_WINDOW_SEC = 4.0 // a kill must land within this window to keep the combo

// Heat / Overdrive: the skill-expressed, self-resetting beam amplifier. Heat
// builds from chained kills and decays when idle; topping out fires a short
// Overdrive surge (more damage, more pierces, double score) that then drains it.
const HEAT_PER_KILL = 0.06 // base heat per kill (scaled up by combo + piece value)
const HEAT_DECAY = 0.11 // heat lost per second when not killing / not in overdrive
const OVERDRIVE_DURATION = 5.0 // seconds of surge once heat tops out
const OVERDRIVE_DPS_MULT = 1.7
const OVERDRIVE_BONUS_PIERCES = 3
const OVERDRIVE_SCORE_MULT = 2
const OVERDRIVE_BEAM_WIDEN = 1.35 // beam forgiveness multiplier during overdrive
// How long an armored block keeps flashing its "deflected, no damage" cue after
// the last wrong-side hit (the renderer fades it out over this window).
const SHIELD_FLASH_SEC = 0.3
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
  // means internalizing it. `prog` ramps 0->1 over the first RAMP_SECONDS;
  // `creep` keeps nudging upward forever after so even the best players meet a
  // ceiling eventually (their reaction/routing speed, never an HP wall).
  const RAMP_SECONDS = 210
  // Front-load the curve: `prog` rises fast in the first ~20s (pow < 1) so the
  // board is already busy and demands routing right away, then eases toward the
  // steady-state. A flat-early curve (smoothstep) was exactly what made the
  // opening trivial.
  const prog = Math.pow(clamp(s.timeSec / RAMP_SECONDS, 0, 1), 0.7)
  const creep = clamp((s.timeSec - RAMP_SECONDS) / 600, 0, 1)

  // Movement is tetris-like: blocks step down together on a global timer. The
  // descent interval is the "gravity": brisk from the very start so pieces
  // actually travel down the board (and you must route immediately), tightening
  // to a fast floor.
  s.dropIntervalSec = Math.max(0.2, 0.7 + (0.3 - 0.7) * prog - 0.1 * creep)

  const layout = getArenaLayout(s.view)
  const cellSize = 40

  const xpOrbTarget = (): Vec2 => {
    // Aim for the *current* top of the filled portion of the Heat bar.
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    const fillH = gh * clamp(s.heat, 0, 1)
    return { x: gx + gw / 2, y: gy + (gh - fillH) }
  }

  // Respite after losing a life: no spawns for a moment.
  if (s.respiteSec > 0) {
    s.respiteSec = Math.max(0, s.respiteSec - dt)
  }

  // Spawn pacing (director-style): a deterministic target curve, with pressure
  // guardrails so the game ramps without spiraling into impossible states.
  // Arrival rate and the on-screen cap ramp together: more simultaneous threats
  // to route between as you go deeper.
  s.spawnTimer -= dt
  const spawnEveryBase = Math.max(0.34, 0.62 + (0.42 - 0.62) * prog - 0.08 * creep) // 0.62s -> 0.42s -> ~0.34s
  const maxBlocksBase = Math.floor(7 + 8 * prog + 4 * creep) // 7 -> 15 -> ~19

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
    // Fast-droppers fall two cells per step (prioritization pressure) and get an
    // extra cell of visual catch-up so they ease instead of snapping.
    s.depth += 1
    for (const b of s.blocks) {
      if (b.kind === 'fast') {
        b.pos.y += b.cellSize * 2
        b.dropAnimExtra = b.cellSize
      } else {
        b.pos.y += b.cellSize
      }
    }
    for (const f of s.features) {
      f.pos.y += f.cellSize
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
  // Fade out the armored "deflected" flash after the last wrong-side hit.
  for (const b of s.blocks) {
    if (b.shieldFlashSec > 0) b.shieldFlashSec = Math.max(0, b.shieldFlashSec - dt)
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
          // Orbs are pure kill juice now (power is fixed); they just wink out at
          // the gauge. Heat is added at kill time for responsive feedback.
          delivered.push(orb.id)
        }
      }
    }
    if (delivered.length > 0) {
      s.xpOrbs = s.xpOrbs.filter((o) => !delivered.includes(o.id))
    }
  }

  // Heat / Overdrive: fills from chained kills (added in dealDamageAtHit), decays
  // when idle, and on topping out fires a short surge that drains it back down.
  if (s.overdriveSec > 0) {
    s.overdriveSec = Math.max(0, s.overdriveSec - dt)
    // The meter visibly drains across the surge, then resets so it must rebuild.
    s.heat = s.overdriveSec > 0 ? clamp(s.overdriveSec / OVERDRIVE_DURATION, 0, 1) : 0
  } else if (s.heat >= 1) {
    s.heat = 1
    s.overdriveSec = OVERDRIVE_DURATION
    // Reuse the center banner FX slot to announce OVERDRIVE.
    s.levelUpNotificationFx = { t: 0, displayDur: 1.0, fadeDur: 0.35 }
    s.crescendo = clamp(s.crescendo + 0.5, 0, 1)
  } else {
    s.heat = Math.max(0, s.heat - HEAT_DECAY * dt)
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

    // Armored: only the glowing weak face takes damage. A hit on a shielded face
    // deals nothing (the beam still pierces past it at the call site), so you must
    // route the beam onto the weak side. Make that obvious: spray cold blue-white
    // "deflection" sparks that grind off the plate, and flag the block so the
    // renderer flashes a no-damage cue and pulses the real weak face.
    if (b.kind === 'armored' && (b.vulnNormal.x !== 0 || b.vulnNormal.y !== 0)) {
      const aligned = normal.x * b.vulnNormal.x + normal.y * b.vulnNormal.y
      if (aligned <= 0.45) {
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
        return
      }
    }

    const overdriveMult = s.overdriveSec > 0 ? OVERDRIVE_DPS_MULT : 1
    b.hp -= s.stats.dps * overdriveMult * dt * intensity
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
      // Piece-destroyed SFX. Polyphonic + bus-limited, so multi-kills and rapid
      // chains overlap cleanly without the volume piling up.
      sfxEngine.playQuench()

      // Score: depth x combo. Each kill bumps the combo (refreshing its rolling
      // window) and scores base x combo-multiplier x route-bonus, where the base
      // scales with depth and optics-routed kills (bank/split shots) score more.
      s.combo += 1
      s.comboBest = Math.max(s.comboBest, s.combo)
      s.comboTimerSec = COMBO_WINDOW_SEC

      // Heat builds from chained kills (combo + piece value). It only accrues
      // outside Overdrive (during the surge the meter is draining).
      if (s.overdriveSec <= 0) {
        const heatGain = HEAT_PER_KILL * Math.max(1, b.xpValue) * (1 + 0.05 * s.combo)
        s.heat = clamp(s.heat + heatGain, 0, 1)
      }

      // Multi-kill: each additional block killed in the SAME beam pass (this
      // frame) is worth progressively more — the direct reward for carving a
      // path that lines up several targets at once.
      killsThisFrame += 1
      const multiKillMult = Math.min(3, 1 + 0.4 * (killsThisFrame - 1))

      const comboMult = 1 + 0.1 * (s.combo - 1)
      const routeBonus = viaOptics ? 1.75 : 1
      const overdriveScore = s.overdriveSec > 0 ? OVERDRIVE_SCORE_MULT : 1
      const depthBase = 10 + s.depth * 0.5
      const gained = Math.round(depthBase * comboMult * routeBonus * overdriveScore * multiKillMult * Math.max(1, b.xpValue))
      s.score += gained
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
    piercesLeft: s.stats.maxPierces + (overdrive ? OVERDRIVE_BONUS_PIERCES : 0),
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
}

