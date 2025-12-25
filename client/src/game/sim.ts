import { add, clamp, dot, lerpVec, mul, normalize, reflect, sub } from './math'
import type { Vec2 } from './math'
import type { RunState } from './runState'
import { raycastSceneThick } from './raycast'
import { spawnBoardThing, spawnPrismAt } from './spawn'
import { BLOCK_MELT_DUR, XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR, createInitialRunState } from './runState'
import { getArenaLayout, MIN_RETICLE_GAP, SLIDER_PAD } from './layout'
import { rollUpgradeOptions } from './levelUp'

const EPS = 1.0
const MAX_SPARKS = 280
const MAX_GLOWS = 24
const MAX_RAYS = 24
const MAX_SEGMENTS = 180
const MAX_CURVE_STEPS = 260

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

  // Life-loss FX runs on top of the sim. During the wipe, freeze gameplay so it doesn't read as death.
  if (s.lifeLossFx) {
    s.lifeLossFx.t += dt

    // Clear the board once, after the wipe has visually passed.
    if (!s.lifeLossFx.cleared && s.lifeLossFx.t >= s.lifeLossFx.wipeDur) {
      s.lifeLossFx.cleared = true

      s.blocks = []
      s.features = []
      s.xpOrbs = []
      s.sparks = []
      s.weldGlows = []
      s.sparkEmitAcc = 0
      s.weld = { blockId: -1, x: 0, y: 0, dwell: 0 }

      // Breather after the wipe.
      s.respiteSec = Math.max(s.respiteSec, 1.1)
      s.spawnTimer = Math.max(s.spawnTimer, 1.2)
      s.dropTimerSec = s.dropIntervalSec
    }

    // End banner after duration.
    if (s.lifeLossFx.t >= s.lifeLossFx.bannerDur) {
      s.lifeLossFx = null
    }

    // During the wipe phase, freeze gameplay (no spawns, no movement, no laser damage).
    if (s.lifeLossFx && s.lifeLossFx.t < s.lifeLossFx.wipeDur) {
      // Keep laser visuals quiet during the wipe.
      s.laser.segments = []
      s.laser.hitBlockId = null
      return
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

  // Emitter position (move pointer or keyboard) + aim (aim pointer).
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

  targetX = clamp(targetX, SLIDER_PAD, s.view.width - SLIDER_PAD)

  const prevEmitterX = s.emitter.pos.x
  s.emitter.pos = lerpVec(s.emitter.pos, { x: targetX, y: emitterY }, 0.35)
  if (!s.tutorialMovedEmitter && Math.abs(s.emitter.pos.x - prevEmitterX) > 0.5) {
    s.tutorialMovedEmitter = true
  }

  // Keep the reticle in a physically-aimable region (above the emitter) so
  // we can aim *exactly* at it without introducing non-physical clamps.
  if (s.reticle.y > emitterY - MIN_RETICLE_GAP) {
    s.reticle.y = emitterY - MIN_RETICLE_GAP
  }

  // Lock-on: aim direction is computed directly from emitter -> reticle every frame,
  // after emitter movement is applied, so the beam stays pinned to the reticle.
  const aimRaw = sub(s.reticle, s.emitter.pos)
  s.emitter.aimDir = clampAimUpwards(aimRaw)

  // Global drop step with smooth animation.
  s.dropTimerSec -= dt
  
  // Smooth drop animation: continuously update the visual offset
  if (s.dropAnimOffset > 0) {
    // Animation in progress - advance the offset smoothly
    const animSpeed = cellSize / s.dropAnimDuration
    s.dropAnimOffset = Math.max(0, s.dropAnimOffset - animSpeed * dt)
  }
  
  // When timer hits zero, start the animation by setting offset to full cellSize
  if (s.dropTimerSec <= 0) {
    const overshoot = Math.max(0, -s.dropTimerSec)
    s.dropTimerSec = s.dropIntervalSec - (overshoot % s.dropIntervalSec)
    
    // Snap logical positions forward immediately (physics/collision use this)
    s.depth += 1
    for (const b of s.blocks) {
      b.pos.y += b.cellSize
    }
    for (const f of s.features) {
      f.pos.y += f.cellSize
    }
    
    // Start visual animation by setting offset to cellSize (will count down to 0)
    s.dropAnimOffset = cellSize
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
      // Lose a life, clear the board, and continue with a short respite.
      s.lives = Math.max(0, s.lives - 1)

      // If out of lives, reset the run.
      if (s.lives <= 0) {
        // Enter game-over mode. App will present UI + handle optional local score saving.
        s.gameOver = true
        s.paused = true
        s.levelUpActive = false
        s.levelUpOptions = []
        s.pendingLevelUps = 0
        s.xpOrbs = []
        // Freeze presentation; board can remain as-is behind the overlay.
        return
      }

      // Kick off a wipe + banner so this reads as "life lost" (not run over).
      // Board clear is delayed until the wipe passes.
      s.lifeLossFx = {
        t: 0,
        wipeDur: 0.35,
        bannerDur: 0.95,
        livesAfter: s.lives,
        cleared: false,
      }

      // Stop spawns immediately; full respite is applied after wipe.
      s.respiteSec = Math.max(s.respiteSec, 0.35)
      s.spawnTimer = Math.max(s.spawnTimer, 0.7)

      // Light haptic feedback on life loss (if available).
      const nav: any = navigator
      if (nav && typeof nav.vibrate === 'function') {
        nav.vibrate([12, 40, 10])
      }
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

  const blackHoles = s.features.filter((f) => f.kind === 'blackHole') as Array<
    { id: number; pos: Vec2; cellSize: number; rCore: number; rInfluence: number; localAabb: { maxY: number } }
  >
  const holeInfos = blackHoles.map((bh) => ({
    id: bh.id,
    c: { x: bh.pos.x + bh.cellSize * 0.5, y: bh.pos.y + bh.cellSize * 0.5 },
    rCore: bh.rCore,
    rInf: bh.rInfluence,
    maxY: bh.pos.y + bh.localAabb.maxY,
  }))

  const rayCircleEnterT = (o: Vec2, d: Vec2, c: Vec2, r: number): number | null => {
    const oc = sub(o, c)
    const inside = dot(oc, oc) < r * r
    if (inside) return 0
    const a = dot(d, d)
    const b = 2 * dot(oc, d)
    const cc = dot(oc, oc) - r * r
    const disc = b * b - 4 * a * cc
    if (disc < 0) return null
    const sdisc = Math.sqrt(disc)
    const t1 = (-b - sdisc) / (2 * a)
    const t2 = (-b + sdisc) / (2 * a)
    const t = t1 >= 0 ? t1 : t2 >= 0 ? t2 : null
    return t
  }

  type RayWork = { o: Vec2; d: Vec2; intensity: number; bouncesLeft: number; minT: number; ignorePrismId: number }
  const queue: RayWork[] = [
    { o: { ...s.emitter.pos }, d: { ...s.emitter.aimDir }, intensity: 1, bouncesLeft: s.stats.maxBounces, minT: 0, ignorePrismId: -1 },
  ]

  const enqueueRay = (work: RayWork) => {
    // Prevent rays from being dropped due to the MAX_RAYS processing cap: don't enqueue more
    // than we can possibly process this frame.
    if (raysProcessed + queue.length >= MAX_RAYS) return false
    queue.push(work)
    return true
  }

  const emitPrismRays = (prismId: number, hitPoint: Vec2, incoming: Vec2, intensity: number, bouncesLeft: number) => {
    const prism = s.features.find((f) => f.kind === 'prism' && f.id === prismId) as any
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
      })
      if (!ok) break
    }
  }

  const tryAddSeg = (a: Vec2, b: Vec2, intensity: number) => {
    if (s.laser.segments.length >= MAX_SEGMENTS) return false
    s.laser.segments.push({ a, b, intensity })
    return true
  }

  const dealDamageAtHit = (blockId: number, point: Vec2, normal: Vec2, intensity: number) => {
    const b = s.blocks.find((bb) => bb.id === blockId)
    if (!b) return
    b.hp -= s.stats.dps * dt * intensity
    didDamageBlockThisFrame = true
    s.laser.hitBlockId = blockId

    // Sparks.
    const sparksPerSec = 130 * clamp(intensity, 0.15, 1)
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
      
      // Increment golden XP bonus when a golden block is destroyed
      if (b.isGold) {
        s.stats.goldXpBonus += 1
      }
      
      const cx = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
      const cy = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
      const w = b.localAabb.maxX - b.localAabb.minX
      const h = b.localAabb.maxY - b.localAabb.minY
      // Melt collapses downward into a small blob near the *bottom* of the piece, then releases the XP orb.
      const bottom = b.pos.y + b.localAabb.maxY
      const orbFrom = { x: cx, y: bottom - 6 }
      
      // For gold blocks, spawn multiple XP orbs with offsets and delays
      if (b.isGold && b.xpValue >= 5) {
        const orbCount = 5
        const xpPerOrb = (5 + s.stats.goldXpBonus) / 5 // distribute total XP evenly
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

      const nav: any = navigator
      if (nav && typeof nav.vibrate === 'function') {
        nav.vibrate([10, 30, 14])
      }
    }
  }

  const bounds = { w: s.view.width, h: s.view.height }

  let raysProcessed = 0
  while (queue.length > 0 && raysProcessed < MAX_RAYS && s.laser.segments.length < MAX_SEGMENTS) {
    const ray = queue.pop()!
    raysProcessed++

    let o = { ...ray.o }
    let d = normalize(ray.d)
    let intensity = ray.intensity
    let bouncesLeft = ray.bouncesLeft
    let minT = ray.minT
    let ignorePrismId = ray.ignorePrismId

    for (let guard = 0; guard < 64 && s.laser.segments.length < MAX_SEGMENTS; guard++) {
      // If we will enter a black hole influence region before the next solid hit, switch into curved integration.
      let enterT: number | null = null
      if (holeInfos.length > 0) {
        const perp = normalize({ x: -d.y, y: d.x })
        const offsets = beamRadius <= 0.01 ? [0] : [0, -beamRadius, beamRadius]
        for (const h of holeInfos) {
          if (h.maxY < 0) continue
          for (const off of offsets) {
            const oo = off === 0 ? o : add(o, mul(perp, off))
            const tEnter = rayCircleEnterT(oo, d, h.c, h.rInf)
            if (tEnter == null) continue
            if (tEnter < minT) continue
            if (tEnter > maxDist) continue
            if (enterT == null || tEnter < enterT) enterT = tEnter
          }
        }
      }

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

      // Enter black hole influence mode only when we'd reach influence BEFORE any solid hit.
      // Use hysteresis in the *decision* (not in the entry point), otherwise we can start outside the
      // influence circle and immediately "give up" without drawing any curved segment.
      const enterDecisionT = enterT
      if (enterDecisionT != null && (!hit || enterDecisionT < hit.t - 0.6)) {
        // Segment to influence boundary, then integrate curvature inside the field.
        const entry = enterDecisionT <= 0 ? o : add(o, mul(d, enterDecisionT))
        if (enterDecisionT > 0) {
          if (!tryAddSeg(o, entry, intensity)) break
        }
        // Nudge slightly inside the influence region so we don't get stuck on the exact boundary.
        const insideEps = 0.75
        const entryInside = add(entry, mul(d, insideEps))
        if (!tryAddSeg(entry, entryInside, intensity)) break
        o = entryInside

        // Smaller step length reduces visible "kinks" in the arc.
        const stepLen = 6
        for (let step = 0; step < MAX_CURVE_STEPS && s.laser.segments.length < MAX_SEGMENTS; step++) {
          // Smooth curvature: sum a *turn amount* from all nearby holes, then rotate the ray a bit.
          // This avoids "winner switching" flicker and also prevents the ray from being sucked straight
          // into the hole just for entering the influence radius.
          const perp = normalize({ x: -d.y, y: d.x })
          let turnSum = 0
          let any = false
          for (const h of holeInfos) {
            if (h.maxY < 0) continue
            const dx = h.c.x - o.x
            const dy = h.c.y - o.y
            const dist = Math.hypot(dx, dy)
            if (dist < h.rInf) {
              // Strength curve: give the *edge* a non-zero baseline so the field always feels active,
              // then ramp strongly as you approach the hole.
              const t = 1 - dist / h.rInf // 0..1
              const minStrength = 0.28
              const strength = minStrength + (1 - minStrength) * t
              const w = strength * strength * strength
              // Lateral component determines which direction we curve around the hole.
              const inv = dist > 1e-3 ? 1 / dist : 0
              const toward = { x: dx * inv, y: dy * inv }
              const lateral = dot(perp, toward) // [-1,1]
              turnSum += lateral * w
              any = true
            }
          }

          if (!any) {
            // Exited all influence fields; continue straight from here.
            minT = 0
            break
          }

          // Bend: pull direction slightly toward center; produces an arc.
          // Rotate slightly around the hole(s). Tuned to produce a clean visible arc without
          // immediately capturing the ray unless it truly hits the black-hole tile.
          // Higher turn rate so close approaches can start to "orbit" the hole.
          const bendK = 0.042
          d = normalize(add(d, mul(perp, bendK * turnSum * stepLen)))

          const stepHit = raycastSceneThick(
            o,
            d,
            s.blocks,
            s.features,
            stepLen,
            beamRadius,
            0.25,
            bounds,
            ignorePrismId >= 0 ? ignorePrismId : undefined,
          )
          if (!stepHit) {
            const next = add(o, mul(d, stepLen))
            if (!tryAddSeg(o, next, intensity)) break
            o = next
            minT = 0
            continue
          }

          if (!tryAddSeg(o, stepHit.point, intensity)) break

          if (stepHit.kind === 'block') {
            dealDamageAtHit(stepHit.id, stepHit.point, stepHit.normal, intensity)
            if (bouncesLeft <= 0) break
            d = normalize(reflect(d, stepHit.normal))
            intensity *= s.stats.bounceFalloff
            bouncesLeft -= 1
            o = add(stepHit.point, mul(d, EPS + beamRadius))
            minT = EPS + beamRadius * 0.75
            continue
          }
          if (stepHit.kind === 'mirror' || stepHit.kind === 'wall') {
            // Wall bounces: apply penalty unless noWallPenalty upgrade is active
            const isWall = stepHit.kind === 'wall'
            const skipPenalty = isWall && s.stats.noWallPenalty
            
            if (!skipPenalty && bouncesLeft <= 0) break
            d = normalize(reflect(d, stepHit.normal))
            if (!skipPenalty) {
              intensity *= s.stats.bounceFalloff
              bouncesLeft -= 1
            }
            o = add(stepHit.point, mul(d, EPS + beamRadius))
            minT = EPS + beamRadius * 0.75
            continue
          }
          if (stepHit.kind === 'prism') {
            emitPrismRays(stepHit.id, stepHit.point, d, intensity, bouncesLeft)
            break
          }
          // blackHole core hit: absorb
          break
        }

        // If we terminated inside the curve loop, stop this ray entirely.
        if (intensity <= 0) break

        // Continue outer tracing loop from current o/d.
        minT = 0
        continue
      }

      if (!hit) {
        const end = add(o, mul(d, maxDist))
        tryAddSeg(o, end, intensity)
        break
      }

      if (!tryAddSeg(o, hit.point, intensity)) break

      if (hit.kind === 'block') {
        dealDamageAtHit(hit.id, hit.point, hit.normal, intensity)
        if (bouncesLeft <= 0) break
        d = normalize(reflect(d, hit.normal))
        intensity *= s.stats.bounceFalloff
        bouncesLeft -= 1
        o = add(hit.point, mul(d, EPS + beamRadius))
        minT = EPS + beamRadius * 0.75
        continue
      }

      if (hit.kind === 'mirror' || hit.kind === 'wall') {
        // Wall bounces: apply penalty unless noWallPenalty upgrade is active
        const isWall = hit.kind === 'wall'
        const skipPenalty = isWall && s.stats.noWallPenalty
        
        if (!skipPenalty && bouncesLeft <= 0) break
        d = normalize(reflect(d, hit.normal))
        if (!skipPenalty) {
          intensity *= s.stats.bounceFalloff
          bouncesLeft -= 1
        }
        o = add(hit.point, mul(d, EPS + beamRadius))
        minT = EPS + beamRadius * 0.75
        continue
      }

      if (hit.kind === 'prism') {
        emitPrismRays(hit.id, hit.point, d, intensity, bouncesLeft)
        break
      }

      // blackHole core hit: absorb
      break
    }
  }

  // If we're not actively damaging a block this frame, let dwell cool off.
  if (!didDamageBlockThisFrame) {
    s.weld.dwell = Math.max(0, s.weld.dwell - dt * 6.5)
    if (s.weld.dwell === 0) s.weld.blockId = -1
  }

  // Restore logical positions after laser computation.
  restoreLogicalPositions(s)
}

