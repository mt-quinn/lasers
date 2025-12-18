import { add, clamp, lerpVec, mul, normalize, reflect, sub } from './math'
import type { Vec2 } from './math'
import type { RunState } from './runState'
import { raycastBlocksThick } from './raycast'
import { spawnBlock } from './spawn'
import { createInitialRunState } from './runState'

const EPS = 1.0

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

  // Fall speed is NOT part of difficulty for now (aiming skill > twitch).
  // Keep the current globally-slower feel by using a single constant.
  const fallSpeed = 45

  // Spawn pacing: start slow enough that a new player can keep up.
  s.spawnTimer -= dt
  const spawnEveryEarly = 1.9 + (1.2 - 1.9) * e
  const spawnEveryLate = 1.4 + (0.70 - 1.4) * l
  const spawnEvery = s.timeSec < 60 ? spawnEveryEarly : spawnEveryLate

  const maxBlocksEarly = Math.floor(4 + 3 * e) // 4 -> 7
  const maxBlocksLate = Math.floor(7 + 7 * l) // 7 -> 14
  const maxBlocks = s.timeSec < 60 ? maxBlocksEarly : maxBlocksLate
  if (s.spawnTimer <= 0) {
    if (s.blocks.length < maxBlocks) {
      spawnBlock(s)
      s.spawnTimer = spawnEvery
    } else {
      // Back off slightly and try again soon; this also helps avoid overstacking.
      s.spawnTimer = 0.18
    }
  }

  // Emitter position (move pointer or keyboard) + aim (aim pointer).
  const sliderPad = 22
  const emitterY = s.view.height - 86
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

  const aimRaw = s.input.aimActive
    ? sub({ x: s.input.aimX, y: s.input.aimY }, { x: s.emitter.pos.x, y: emitterY })
    : s.emitter.aimDir

  const aimTarget = clampAimUpwards(aimRaw)
  s.emitter.pos = lerpVec(s.emitter.pos, { x: targetX, y: emitterY }, 0.35)
  s.emitter.aimDir = normalize(lerpVec(s.emitter.aimDir, aimTarget, 0.22))

  // Move blocks.
  for (const b of s.blocks) {
    // Global fall speed prevents later spawns from catching older blocks and overlapping.
    b.vel.y = fallSpeed
    b.pos = add(b.pos, mul(b.vel, dt))
  }

  // Fail line.
  // Slightly more generous than before so early-game isn't razor-thin.
  const failY = s.view.height - 110
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
    const hit = raycastBlocksThick(origin, dir, s.blocks, maxDist, beamRadius, minT)
    if (!hit) {
      const end = add(origin, mul(dir, maxDist))
      s.laser.segments.push({ a: origin, b: end, intensity })
      break
    }

    s.laser.segments.push({ a: origin, b: hit.point, intensity })
    s.laser.hitBlockId = hit.blockId

    // Apply damage to hit block for this segment.
    const b = s.blocks.find((bb) => bb.id === hit.blockId)
    if (b) {
      b.hp -= s.stats.dps * dt * intensity
      if (b.hp <= 0) {
        s.currency += b.value
        s.blocksDestroyed += 1
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
}


