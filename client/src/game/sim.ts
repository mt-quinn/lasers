import { add, clamp, lerpVec, mul, normalize, reflect, sub } from './math'
import type { Vec2 } from './math'
import type { RunState } from './runState'
import { raycastBlocksThick } from './raycast'
import { spawnBlock } from './spawn'
import { createInitialRunState } from './runState'
import { getArenaLayout } from './layout'
import { rollUpgradeOptions } from './levelUp'

const EPS = 1.0
const MAX_SPARKS = 280
const MAX_GLOWS = 24

const clampAimUpwards = (dir: Vec2) => {
  // Ensure we're aiming at least somewhat upward.
  const minUp = 0.15
  const d = normalize(dir)
  if (d.y <= -minUp) return d
  // Force y component upward while preserving horizontal sign.
  const x = d.x
  const y = -minUp
  return normalize({ x, y })
}

export const stepSim = (s: RunState, dt: number) => {
  s.timeSec += dt

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

  // Spawn pacing (director-style): a time-based target curve, with pressure guardrails
  // so the game ramps without spiraling into impossible states.
  s.spawnTimer -= dt
  const spawnEveryEarly = 2.35 + (1.65 - 2.35) * e // 0-60s: 2.35 -> 1.65
  const spawnEveryLate = 1.55 + (0.95 - 1.55) * l // 60-360s: 1.55 -> 0.95
  const spawnEveryBase = s.timeSec < 60 ? spawnEveryEarly : spawnEveryLate

  const maxBlocksEarly = Math.floor(4 + 2 * e) // 4 -> 6
  const maxBlocksLate = Math.floor(6 + 5 * l) // 6 -> 11
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

  const allowSpawn = dangerCount === 0
  if (allowSpawn && s.spawnTimer <= 0) {
    if (s.blocks.length < maxBlocks) {
      spawnBlock(s)
      s.spawnTimer = spawnEvery
    } else {
      // Back off slightly and try again soon; helps prevent overstacking at cap.
      s.spawnTimer = 0.25
    }
  } else if (!allowSpawn) {
    // If we're in a danger state, keep checking frequently so spawns resume quickly after recovery.
    s.spawnTimer = Math.min(s.spawnTimer, 0.18)
  }

  // Emitter position (move pointer or keyboard) + aim (aim pointer).
  const sliderPad = 22
  const emitterY = layout.emitterY
  let targetX = s.emitter.pos.x

  if (s.input.moveActive) {
    targetX = s.input.moveX
  } else {
    const dir = (s.input.keyRight ? 1 : 0) - (s.input.keyLeft ? 1 : 0)
    if (dir !== 0) {
      targetX = s.emitter.pos.x + dir * 520 * dt
    }
  }

  targetX = clamp(targetX, sliderPad, s.view.width - sliderPad)

  s.emitter.pos = lerpVec(s.emitter.pos, { x: targetX, y: emitterY }, 0.35)

  // Keep the reticle in a physically-aimable region (above the emitter) so
  // we can aim *exactly* at it without introducing non-physical clamps.
  const minReticleGap = 18
  if (s.reticle.y > emitterY - minReticleGap) {
    s.reticle.y = emitterY - minReticleGap
  }

  // Lock-on: aim direction is computed directly from emitter -> reticle every frame,
  // after emitter movement is applied, so the beam stays pinned to the reticle.
  const aimRaw = sub(s.reticle, s.emitter.pos)
  s.emitter.aimDir = clampAimUpwards(aimRaw)

  // Global drop step.
  s.dropTimerSec -= dt
  if (s.dropTimerSec <= 0) {
    const overshoot = Math.max(0, -s.dropTimerSec)
    s.dropTimerSec = s.dropIntervalSec - (overshoot % s.dropIntervalSec)
    for (const b of s.blocks) {
      b.pos.y += b.cellSize
    }
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

  // Update XP orbs (condense -> fly -> deliver).
  if (s.xpOrbs.length > 0) {
    const delivered: string[] = []
    for (const orb of s.xpOrbs) {
      orb.t += dt
      if (orb.phase === 'condense') {
        if (orb.t >= 0.12) {
          orb.phase = 'fly'
          orb.t = 0
        }
      } else {
        if (orb.t >= 0.55) {
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

  // Level-up trigger: when XP fills, open the choice menu (pause).
  if (!s.levelUpActive && s.xp >= s.xpCap) {
    s.xp -= s.xpCap
    s.pendingLevelUps += 1
  }
  if (!s.levelUpActive && s.pendingLevelUps > 0) {
    s.levelUpActive = true
    s.paused = true
    s.pendingLevelUps -= 1
    s.levelUpOptions = rollUpgradeOptions(s, Math.random)
  }

  // Fail line sits just above the bottom rail.
  const failY = layout.failY
  for (const b of s.blocks) {
    const bottom = b.pos.y + b.localAabb.maxY
    if (bottom >= failY) {
      // Reset run immediately.
      const fresh = createInitialRunState()
      fresh.view = s.view
      fresh.input = s.input
      // Preserve pause state to avoid fighting the UI.
      fresh.paused = s.paused
      Object.assign(s, fresh)
      return
    }
  }

  // Laser: compute segments + apply damage.
  s.laser.segments = []
  s.laser.hitBlockId = null

  let didDamageBlockThisFrame = false

  let origin = { ...s.emitter.pos }
  let dir = { ...s.emitter.aimDir }
  let intensity = 1
  // Range is effectively infinite (within the screen). Always cast far enough
  // to cross the whole view.
  const maxDist = Math.hypot(s.view.width, s.view.height) * 1.35
  const maxBounces = s.stats.maxBounces
  const beamRadius = Math.max(0, s.stats.beamWidth * 0.45)
  let minT = 0

  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    const hit = raycastBlocksThick(origin, dir, s.blocks, maxDist, beamRadius, minT, {
      w: s.view.width,
      h: s.view.height,
    })
    if (!hit) {
      const end = add(origin, mul(dir, maxDist))
      s.laser.segments.push({ a: origin, b: end, intensity })
      break
    }

    s.laser.segments.push({ a: origin, b: hit.point, intensity })
    s.laser.hitBlockId = hit.blockId >= 0 ? hit.blockId : null

    // Apply damage to hit block for this segment.
    const b = hit.blockId >= 0 ? s.blocks.find((bb) => bb.id === hit.blockId) : undefined
    if (b) {
      b.hp -= s.stats.dps * dt * intensity
      didDamageBlockThisFrame = true

      // Welding FX at the damage contact point.
      // Emit a small number of sparks per second, biased away from the surface normal.
      const sparksPerSec = 130 * clamp(intensity, 0.15, 1)
      s.sparkEmitAcc += sparksPerSec * dt
      const emitN = Math.min(6, Math.floor(s.sparkEmitAcc))
      if (emitN > 0) s.sparkEmitAcc -= emitN

      if (emitN > 0) {
        const n = hit.normal
        const tx = -n.y
        const ty = n.x
        for (let i = 0; i < emitN; i++) {
          const alongN = 80 + Math.random() * 220
          const alongT = (Math.random() * 2 - 1) * (70 + Math.random() * 180)
          const jitter = 2.5
          s.sparks.push({
            x: hit.point.x + (Math.random() * 2 - 1) * jitter,
            y: hit.point.y + (Math.random() * 2 - 1) * jitter,
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

      // "Dwell" bloom: if the beam stays on the same spot of the same block,
      // the inside glow grows. Moving the contact point shrinks it quickly.
      const sameBlock = s.weld.blockId === hit.blockId
      const dx = hit.point.x - s.weld.x
      const dy = hit.point.y - s.weld.y
      const sameSpot = sameBlock && dx * dx + dy * dy <= 8 * 8
      if (sameSpot) {
        s.weld.dwell = Math.min(1, s.weld.dwell + dt * 3.2) // ~0.3s to full
      } else {
        s.weld.dwell = Math.max(0, s.weld.dwell - dt * 7.0) // quick decay when moving
        s.weld.blockId = hit.blockId
        s.weld.x = hit.point.x
        s.weld.y = hit.point.y
      }

      // Glow: only while the block is alive. If the block dies this frame, avoid
      // spawning a new glow that would render unclipped (and flash) after removal.
      if (b.hp > 0) {
        const bloom = 1 + 1.15 * s.weld.dwell
        s.weldGlows.push({
          x: hit.point.x,
          y: hit.point.y,
          blockId: hit.blockId,
          bloom,
          age: 0,
          life: 0.08 + 0.08 * Math.random(),
          intensity: clamp(intensity, 0.25, 1),
        })
        if (s.weldGlows.length > MAX_GLOWS) s.weldGlows.splice(0, s.weldGlows.length - MAX_GLOWS)
      }

      if (b.hp <= 0) {
        s.blocksDestroyed += 1
        // Spawn XP orb VFX that condenses into a sphere then flies to the XP gauge.
        const cx = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
        const cy = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
        s.xpOrbs.push({
          id: `orb-${s.nextOrbId++}`,
          from: { x: cx, y: cy },
          to: { ...layout.xpTarget },
          t: 0,
          phase: 'condense',
          value: b.xpValue,
        })
        s.blocks = s.blocks.filter((x) => x.id !== b.id)

        // Stronger haptic on destroy.
        const nav: any = navigator
        if (nav && typeof nav.vibrate === 'function') {
          nav.vibrate([10, 30, 14])
        }
      }
    }

    if (bounce >= maxBounces) break

    // Reflect (perfect mirror): the outgoing direction is purely determined by
    // incoming direction and surface normal.
    const reflected = reflect(dir, hit.normal)
    dir = normalize(reflected)
    intensity *= s.stats.bounceFalloff
    // Move the origin forward enough that we don't immediately re-hit the same surface due
    // to floating point precision or thick-ray offsets.
    origin = add(hit.point, mul(dir, EPS + beamRadius))
    // After the first impact, ignore any t extremely close to 0 on subsequent casts.
    minT = EPS + beamRadius * 0.75
  }

  // If we're not actively damaging a block this frame, let dwell cool off.
  if (!didDamageBlockThisFrame) {
    s.weld.dwell = Math.max(0, s.weld.dwell - dt * 6.5)
    if (s.weld.dwell === 0) s.weld.blockId = -1
  }
}


