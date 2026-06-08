import { clamp } from './math'
import type { BlockEntity, BlockKind, BoardFeature, MirrorFeature, PrismFeature, RunState } from './runState'
import { buildCellLoop, computeLocalAabbPx } from './outline'
import { SHAPES } from './shapes'
import { getArenaLayout } from './layout'
import { screenTopWorldY } from '../render/projection'
import { spawnRng, type Rng } from './rng'

const randOf = <T,>(arr: T[], rng: Rng) => arr[Math.floor(rng() * arr.length)]!

// Content difficulty is driven by the deterministic board-spawn INDEX, not
// wall-clock time: under adaptive pacing two players reach a given timeSec at
// different spawn counts, so a time-based ramp would desync the piece sequence.
// This nominal interval converts an index into the equivalent "schedule
// seconds" the variety thresholds were tuned in (~2 spawns/sec).
const NOMINAL_SPAWN_SEC = 0.5

const shapeCellBounds = (cells: { x: number; y: number }[]) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cells) {
    minX = Math.min(minX, c.x)
    minY = Math.min(minY, c.y)
    maxX = Math.max(maxX, c.x + 1)
    maxY = Math.max(maxY, c.y + 1)
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

const normalizeCellsToOrigin = (cells: { x: number; y: number }[]) => {
  const b = shapeCellBounds(cells)
  return cells.map((c) => ({ x: c.x - b.minX, y: c.y - b.minY }))
}

type WorldAabb = { minX: number; minY: number; maxX: number; maxY: number }

const intersects = (a: WorldAabb, b: WorldAabb) => a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY

const featureWorldAabb = (f: BoardFeature): WorldAabb => {
  const a = f.localAabb
  return { minX: f.pos.x + a.minX, minY: f.pos.y + a.minY, maxX: f.pos.x + a.maxX, maxY: f.pos.y + a.maxY }
}

const blockWorldAabb = (b: BlockEntity): WorldAabb => {
  const a = b.localAabb
  return { minX: b.pos.x + a.minX, minY: b.pos.y + a.minY, maxX: b.pos.x + a.maxX, maxY: b.pos.y + a.maxY }
}

const collidesAny = (cand: WorldAabb, s: RunState) => {
  for (const b of s.blocks) {
    if (intersects(cand, blockWorldAabb(b))) return true
  }
  for (const f of s.features) {
    if (intersects(cand, featureWorldAabb(f))) return true
  }
  return false
}

// Routing-focused block variety, introduced on a schedule so the player learns
// the base verb (pierce) first, then fast-droppers, then armored, then chrome.
// These add routing/prioritization decisions, never HP-sponge tedium.
const rollBlockKind = (tSec: number, rng: Rng): BlockKind => {
  if (tSec < 30) return 'normal'
  const pFast = clamp((tSec - 30) / 90, 0, 1) * 0.2 // ramps to ~20%
  const pArmored = clamp((tSec - 60) / 120, 0, 1) * 0.16 // ramps to ~16%
  const pChrome = clamp((tSec - 100) / 150, 0, 1) * 0.1 // ramps to ~10%
  // Shatter is the late-game spice: shows up ~2 min in and stays uncommon. On
  // death it multiplies into a cluster of slow 1x1s, so it's a deliberate
  // difficulty spike rather than a constant presence.
  const pShatter = clamp((tSec - 120) / 150, 0, 1) * 0.1 // ramps to ~10%
  const r = rng()
  if (r < pShatter) return 'shatter'
  if (r < pShatter + pChrome) return 'chrome'
  if (r < pShatter + pChrome + pArmored) return 'armored'
  if (r < pShatter + pChrome + pArmored + pFast) return 'fast'
  return 'normal'
}

const rollFeatureKind = (tSec: number, rng: Rng): BoardFeature['kind'] | null => {
  // Tunable knobs. Start rare so the board reads cleanly; ramp slightly over time.
  // Optics (mirror/prism) are now the player's routing *tools*, so they appear a
  // bit more often than the old per-feature rate (black holes are gone).
  const ramp = clamp((tSec - 25) / 180, 0, 1)
  const pMirror = 0.07 + 0.04 * ramp
  const pPrism = 0.07 + 0.04 * ramp

  const r = rng()
  if (r < pPrism) return 'prism'
  if (r < pPrism + pMirror) return 'mirror'
  return null
}

type PlaceOpts = {
  // Keep the piece out of the central column (mirrors, which would otherwise
  // reflect the straight-up beam back down and stall the game).
  avoidCenterHalf?: number
  // Deterministic lane in [0,1) from the daily seed. When the resulting column
  // is collision-free it's used outright (so everyone's board lands pieces in
  // the same lanes); otherwise the adaptive search below picks a free spot.
  preferredXFrac?: number
}

const placeAabb = (s: RunState, wPx: number, hPx: number, opts: PlaceOpts = {}) => {
  const avoidCenterHalf = opts.avoidCenterHalf ?? 0
  const preferredXFrac = opts.preferredXFrac
  const pad = 18
  const gap = 16
  const xMin = pad
  const xMax = s.view.width - wPx - pad

  const centerX = s.view.width / 2
  // `src` (when provided) makes the lane deterministic; otherwise it's random.
  const genX = (src?: number) => {
    const r = src != null ? src : Math.random()
    if (avoidCenterHalf > 0) {
      // Left lane: piece's right edge stays left of the protected band.
      const leftHi = centerX - avoidCenterHalf - wPx
      // Right lane: piece's left edge stays right of the protected band.
      const rightLo = centerX + avoidCenterHalf
      const leftOk = leftHi >= xMin
      const rightOk = rightLo <= xMax
      if (leftOk || rightOk) {
        const pickLeft = leftOk && (!rightOk || r < 0.5)
        if (pickLeft) return clamp(xMin + r * (leftHi - xMin), xMin, leftHi)
        return clamp(rightLo + r * (xMax - rightLo), rightLo, xMax)
      }
      // Fallback (piece too wide to dodge the band): fall through to full width.
    }
    return clamp(xMin + r * Math.max(0, xMax - xMin), xMin, xMax)
  }

  // Spawn fully ABOVE the visible top edge so pieces descend into view (rather
  // than popping into the middle of the now-visible perspective shaft).
  const topWorldY = screenTopWorldY(s.view, getArenaLayout(s.view))
  const spawnMargin = 28
  const baseY = topWorldY - hPx - spawnMargin
  const maxBacklog = Math.max(260, s.view.height * 0.65)
  const backlogFloor = baseY - maxBacklog

  let placedX = genX()
  let placedY = baseY
  let found = false
  let bestScore = -Infinity

  for (let attempt = 0; attempt < 22; attempt++) {
    const usePreferred = attempt === 0 && preferredXFrac != null
    const x = usePreferred ? genX(preferredXFrac) : genX()

    // Find all occupants that overlap horizontally, then spawn above the topmost of them.
    let minTopY = Infinity
    let overlapCount = 0

    for (const b of s.blocks) {
      const o = blockWorldAabb(b)
      const candX0 = x
      const candX1 = x + wPx
      const overlapsX = candX0 < o.maxX && candX1 > o.minX
      if (!overlapsX) continue
      overlapCount++
      minTopY = Math.min(minTopY, o.minY)
    }
    for (const f of s.features) {
      const o = featureWorldAabb(f)
      const candX0 = x
      const candX1 = x + wPx
      const overlapsX = candX0 < o.maxX && candX1 > o.minX
      if (!overlapsX) continue
      overlapCount++
      minTopY = Math.min(minTopY, o.minY)
    }

    const yRaw = Number.isFinite(minTopY) ? Math.min(baseY, minTopY - (hPx + gap)) : baseY
    const y = Math.max(backlogFloor, yRaw)
    const cand = { minX: x, minY: y, maxX: x + wPx, maxY: y + hPx }

    if (!collidesAny(cand, s)) {
      const clearance = baseY - y
      // The deterministic preferred column wins outright when collision-free so
      // the daily lanes match across players; the jittered search is fallback.
      const score =
        -overlapCount * 3 - clearance * 0.01 + (usePreferred ? 1000 : Math.random() * 0.15)
      if (!found || score > bestScore) {
        bestScore = score
        placedX = x
        placedY = y
        found = true
      }
    }
  }

  if (!found) {
    // Push far above the topmost occupant.
    let minY = Infinity
    for (const b of s.blocks) minY = Math.min(minY, blockWorldAabb(b).minY)
    for (const f of s.features) minY = Math.min(minY, featureWorldAabb(f).minY)
    const yRaw = Number.isFinite(minY) ? Math.min(baseY, minY - (hPx + gap)) : baseY
    placedY = Math.max(backlogFloor, yRaw)
  }

  return { x: placedX, y: placedY }
}

// Mirror durability: how much beam contact a deflector survives. High enough to
// be a reliable routing tool, low enough that you can deliberately burn down one
// that's in your way.
const MIRROR_HP = 80
const MIRROR_SIZE_CELLS = 2

// Prism exit configurations (degrees, relative to the incoming beam). Pick two
// distinct ones; the rng variant uses exactly two draws so it stays clean.
const PRISM_EXIT_CHOICES: number[] = [0, 15, -15, 45, -45, 90, -90]

const pickTwoExits = (rng: Rng): number[] => {
  const i = Math.floor(rng() * PRISM_EXIT_CHOICES.length)
  let j = Math.floor(rng() * (PRISM_EXIT_CHOICES.length - 1))
  if (j >= i) j += 1
  return [PRISM_EXIT_CHOICES[i]!, PRISM_EXIT_CHOICES[j]!]
}

const spawnMirror = (s: RunState, rng: Rng) => {
  const cellSize = 40
  const sizePx = MIRROR_SIZE_CELLS * cellSize
  // Diagonal-only: a vertical beam is always kicked sideways, never straight back.
  const orient: 1 | -1 = rng() < 0.5 ? 1 : -1
  // Keep a small launch corridor at center so the muzzle usually has clearance,
  // but mirrors can sit near-center for routing (they deflect, never block).
  const placed = placeAabb(s, sizePx, sizePx, {
    avoidCenterHalf: s.view.width * 0.12,
    preferredXFrac: rng(),
  })

  const mirror: MirrorFeature = {
    id: s.nextFeatureId++,
    kind: 'mirror',
    pos: { x: placed.x, y: placed.y },
    cellSize,
    sizePx,
    orient,
    hp: MIRROR_HP,
    hpMax: MIRROR_HP,
    localAabb: { minX: 0, minY: 0, maxX: sizePx, maxY: sizePx },
  }
  s.features.push(mirror)
  s.normalBlocksSinceFeature = 0
}

// Splitter footprint: a 2x2-cell crystal so its directional silhouette reads
// from a distance (the old 1-cell gem looked like a stray 1x1 block). `r` is the
// central HUB collision radius — the beam enters the hub and splits; the prongs
// are visual direction indicators that overhang the hub.
const PRISM_FOOTPRINT_CELLS = 2
const prismFootprintPx = (cellSize: number) => PRISM_FOOTPRINT_CELLS * cellSize
const prismHubRadius = (cellSize: number) => cellSize * 0.5

const spawnPrism = (s: RunState, rng: Rng) => {
  const cellSize = 40
  const size = prismFootprintPx(cellSize)
  const r = prismHubRadius(cellSize)
  const exits = pickTwoExits(rng)
  const placed = placeAabb(s, size, size, { preferredXFrac: rng() })

  const prism: PrismFeature = {
    id: s.nextFeatureId++,
    kind: 'prism',
    pos: { x: placed.x, y: placed.y },
    cellSize,
    r,
    exitsDeg: exits,
    lit: 0,
    localAabb: { minX: 0, minY: 0, maxX: size, maxY: size },
  }
  s.features.push(prism)
  s.normalBlocksSinceFeature = 0
}

export const spawnPrismAt = (s: RunState, x: number, y: number) => {
  const cellSize = 40
  const size = prismFootprintPx(cellSize)
  const r = prismHubRadius(cellSize)

  // Prism exit configurations: pick 2 distinct offsets from the allowed set.
  const allowed: number[] = [0, 15, -15, 45, -45, 90, -90]
  const count = 2 // Always spawn with 2 outputs
  const exits: number[] = []
  while (exits.length < count) {
    const d = allowed[Math.floor(Math.random() * allowed.length)]!
    if (exits.includes(d)) continue
    exits.push(d)
  }

  const prism: PrismFeature = {
    id: s.nextFeatureId++,
    kind: 'prism',
    pos: { x, y },
    cellSize,
    r,
    exitsDeg: exits,
    lit: 0,
    localAabb: { minX: 0, minY: 0, maxX: size, maxY: size },
  }
  s.features.push(prism)
}

export const spawnBoardThing = (s: RunState) => {
  // One independent RNG per scheduled board-spawn -> the Nth piece of the day is
  // identical for everyone regardless of how their pacing diverges.
  const index = s.boardSpawnIndex++
  const rng = spawnRng(s.dailySeed, index)
  // Index-based schedule clock so content variety is deterministic per player.
  const schedSec = index * NOMINAL_SPAWN_SEC

  const kind = rollFeatureKind(schedSec, rng)
  // Early-run safeguard: first 15 blocks must be normal (no undamageable features).
  if (s.blocksSpawned < 15) {
    return spawnBlock(s, rng, schedSec)
  }
  // Protection: require at least 3 normal blocks between each feature spawn.
  if (kind != null && s.normalBlocksSinceFeature < 3) {
    return spawnBlock(s, rng, schedSec)
  }
  if (kind === 'mirror') return spawnMirror(s, rng)
  if (kind === 'prism') return spawnPrism(s, rng)
  return spawnBlock(s, rng, schedSec)
}

export const spawnBlock = (s: RunState, rng: Rng, schedSec: number) => {
  const t = schedSec
  // Cell size is constant so the global drop step is always exactly "1x1 block".
  const cellSize = 40
  // Big rounding: for a 1-cell-thick block, ends should read as a half-circle (capsule).
  // Use ~cellSize/2, with a tiny epsilon to avoid degenerate geometry.
  const cornerRadius = cellSize * 0.5 - 0.6

  // Routing-focused kind (scheduled introduction; early game is normal-only).
  const kind = rollBlockKind(t, rng)

  // Shape weighting: simpler early, bigger later. Chrome is always a single cell
  // so its reflective phase is brief — it dies fast and can't wall the muzzle.
  const pool =
    t < 25
      ? SHAPES.filter((sh) => sh.id !== 'Dot' && sh.id !== 'I4')
      : t < 60
        ? SHAPES.filter((sh) => sh.id !== 'Dot')
        : SHAPES

  // Shatter must be multi-cell so it actually fragments into a cluster (a 1x1
  // would just become a single block), so never let it roll the Dot.
  const shatterPool = pool.filter((sh) => sh.id !== 'Dot')
  const shape =
    kind === 'chrome'
      ? (SHAPES.find((sh) => sh.id === 'Dot') ?? randOf(pool, rng))
      : kind === 'shatter'
        ? randOf(shatterPool.length > 0 ? shatterPool : pool, rng)
        : randOf(pool, rng)
  const cells = normalizeCellsToOrigin(shape.cells)
  const bounds = shapeCellBounds(cells)
  const wPx = bounds.w * cellSize
  const hPx = bounds.h * cellSize
 
  // Constant time-to-kill: a block's HP depends ONLY on its size (cell count),
  // never on depth/time. Player power is fixed, so any HP inflation would create
  // an eventual unbeatable wall. Difficulty instead comes from descent speed,
  // arrival density, and routing complexity — all answerable by skill. A focused
  // beam clears ~HP_PER_CELL per cell, so a 1-cell melts fast and a big piece
  // needs you to dwell (or pierce) a touch longer.
  const HP_PER_CELL = 8
  const hpMax = Math.max(1, Math.round(HP_PER_CELL * cells.length))

  // Armored pieces now have an armored UNDERSIDE: the straight-up beam deflects
  // off the bottom, but the sides and top all take damage, so the puzzle is just
  // "route the beam around to any other face." No per-block weak-face data or
  // wall-clearance placement is needed anymore — they can spawn anywhere.

  // Gold blocks are a normal-kind bonus only (no special-kind gold).
  const isGold = kind === 'normal' && rng() < s.stats.goldSpawnChance

  // XP per block: 1 for normal, 5 + bonus for gold blocks
  const xpValue = isGold ? 5 + s.stats.goldXpBonus : 1

  const loop = buildCellLoop(cells)
  const localAabb = computeLocalAabbPx(cells, cellSize)

  // Cache an "inside the piece" HP anchor in local pixel space to avoid per-frame allocations/GC.
  // Using the nearest cell center to the average cell center keeps it always inside, even for concave shapes.
  let avgX = 0
  let avgY = 0
  for (const c of cells) {
    avgX += c.x + 0.5
    avgY += c.y + 0.5
  }
  avgX /= Math.max(1, cells.length)
  avgY /= Math.max(1, cells.length)
  let best = { x: (cells[0]?.x ?? 0) + 0.5, y: (cells[0]?.y ?? 0) + 0.5 }
  let bestD = Infinity
  for (const c of cells) {
    const cx = c.x + 0.5
    const cy = c.y + 0.5
    const dx = cx - avgX
    const dy = cy - avgY
    const d = dx * dx + dy * dy
    if (d < bestD) {
      bestD = d
      best = { x: cx, y: cy }
    }
  }
  const hpAnchorLocalPx = { x: best.x * cellSize, y: best.y * cellSize }

  // Spawn placement: never overlap any existing block AABB (including other
  // newly-spawned blocks above). The deterministic lane comes from the daily
  // seed; vertical stacking still adapts to the live board.
  const placed = placeAabb(s, wPx, hPx, { preferredXFrac: rng() })

  const block: BlockEntity = {
    id: s.nextBlockId++,
    cells,
    cellSize,
    cornerRadius,
    pos: { x: placed.x, y: placed.y },
    // Vel is assigned in sim as a global fall speed so blocks never "catch up" and overlap.
    vel: { x: 0, y: 0 },
    hpMax,
    hp: hpMax,
    xpValue,
    isGold,
    kind,
    dropAnimExtra: 0,
    shieldFlashSec: 0,
    loop,
    localAabb,
    hpAnchorLocalPx,
  }

  s.blocks.push(block)
  s.blocksSpawned += 1
  s.normalBlocksSinceFeature = Math.min(3, s.normalBlocksSinceFeature + 1)
}

// Shatter payload: when a shatter piece dies it breaks into one full-HP 1x1
// "normal" block per cell of its footprint, materialized in place (same grid
// cells the parent occupied at the moment of death) so the threat multiplies
// right where you let it get to. Children descend at the normal slow rate.
export const spawnShatterChildren = (s: RunState, parent: BlockEntity) => {
  const cs = parent.cellSize
  const cornerRadius = parent.cornerRadius
  const childCells = [{ x: 0, y: 0 }]
  const loop = buildCellLoop(childCells)
  const localAabb = computeLocalAabbPx(childCells, cs)
  // Center of the single cell — always inside the shape.
  const hpAnchorLocalPx = { x: 0.5 * cs, y: 0.5 * cs }
  const HP_PER_CELL = 8

  for (const c of parent.cells) {
    const child: BlockEntity = {
      id: s.nextBlockId++,
      cells: childCells.map((cc) => ({ ...cc })),
      cellSize: cs,
      cornerRadius,
      pos: { x: parent.pos.x + c.x * cs, y: parent.pos.y + c.y * cs },
      vel: { x: 0, y: 0 },
      hpMax: HP_PER_CELL,
      hp: HP_PER_CELL,
      xpValue: 1,
      isGold: false,
      kind: 'normal',
      dropAnimExtra: 0,
      shieldFlashSec: 0,
      loop: loop.map((p) => ({ ...p })),
      localAabb: { ...localAabb },
      hpAnchorLocalPx: { ...hpAnchorLocalPx },
    }
    s.blocks.push(child)
  }
}


