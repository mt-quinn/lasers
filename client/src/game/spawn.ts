import { clamp } from './math'
import type { BlockEntity, BlockKind, BoardFeature, MirrorFeature, PrismFeature, RunState } from './runState'
import { buildCellLoop, computeLocalAabbPx } from './outline'
import { SHAPES, type ShapeDef } from './shapes'
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
//
// Kinds are dealt from a deterministic BAG, not rolled i.i.d. per spawn.
// Independent rolls made armored "clusters" (2-3 armored within a handful of
// spawns, often in adjacent lanes where they shield each other's side faces) a
// regular occurrence at full ramp — measured at ~35 such clusters per 10
// minutes, the first landing right where the difficulty curve is steepest.
// Each 12-spawn bag carries a CAPPED count of every special kind (ramped by
// schedule time), and armored slots are kept at least 3 spawns apart (and away
// from the bag edges, so two bags can't abut armored back-to-back). The deal is
// a pure function of (dailySeed, bagIndex): the daily contract — everyone faces
// the same sequence — holds exactly.
const BAG_SIZE = 12
// Offset added to the bag index so its rng stream can't collide with the
// per-spawn streams (which are seeded by the raw spawn index).
const BAG_STREAM_OFFSET = 0x40000000

const bagKinds = (seed: number, bagIndex: number): BlockKind[] => {
  const rng = spawnRng(seed, BAG_STREAM_OFFSET + bagIndex)
  // Schedule time at the bag's first slot. Content ramps are stretched (vs the
  // old i.i.d. ramps) so the mix stops compounding with the speed/cap ramps:
  // fast from ~40s, armored from ~80s, chrome ~110s, shatter ~150s.
  const t = bagIndex * BAG_SIZE * NOMINAL_SPAWN_SEC
  const pFast = clamp((t - 40) / 140, 0, 1) * 0.18
  const pArmored = clamp((t - 80) / 180, 0, 1) * 0.12
  const pChrome = clamp((t - 110) / 200, 0, 1) * 0.08
  const pShatter = clamp((t - 150) / 210, 0, 1) * 0.08
  // Expected count per bag, stochastically rounded (so e.g. 1.4 armored/bag is
  // sometimes 1, sometimes 2) and hard-capped.
  const count = (p: number, cap: number) => {
    const e = p * BAG_SIZE
    let n = Math.floor(e)
    if (rng() < e - n) n += 1
    return Math.min(cap, n)
  }
  const nArmored = count(pArmored, 2)
  const nFast = count(pFast, 3)
  const nChrome = count(pChrome, 1)
  const nShatter = count(pShatter, 1)

  const kinds: BlockKind[] = new Array(BAG_SIZE).fill('normal')
  const free: number[] = []
  for (let i = 0; i < BAG_SIZE; i++) free.push(i)

  // Armored first, with the spacing rule: slots 1..BAG_SIZE-2 only (edge slots
  // excluded so consecutive bags keep a >=3 gap too), and >=3 apart in-bag.
  const armoredSlots: number[] = []
  for (let k = 0; k < nArmored; k++) {
    const candidates = free.filter(
      (i) => i >= 1 && i <= BAG_SIZE - 2 && armoredSlots.every((a) => Math.abs(a - i) >= 3),
    )
    if (candidates.length === 0) break
    const slot = candidates[Math.floor(rng() * candidates.length)]!
    armoredSlots.push(slot)
    free.splice(free.indexOf(slot), 1)
    kinds[slot] = 'armored'
  }
  const deal = (kind: BlockKind, n: number) => {
    for (let k = 0; k < n && free.length > 0; k++) {
      const j = Math.floor(rng() * free.length)
      kinds[free[j]!] = kind
      free.splice(j, 1)
    }
  }
  deal('fast', nFast)
  deal('shatter', nShatter)
  deal('chrome', nChrome)
  return kinds
}

// The dealt kind for the Nth board-spawn of the day. (Feature spawns consume a
// slot without using its kind — harmless dilution that keeps this a pure
// function of the index.)
const kindForIndex = (seed: number, index: number): BlockKind =>
  bagKinds(seed, Math.floor(index / BAG_SIZE))[index % BAG_SIZE]!

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
    return spawnBlock(s, rng, schedSec, index)
  }
  // Protection: require at least 3 normal blocks between each feature spawn.
  if (kind != null && s.normalBlocksSinceFeature < 3) {
    return spawnBlock(s, rng, schedSec, index)
  }
  if (kind === 'mirror') return spawnMirror(s, rng)
  if (kind === 'prism') return spawnPrism(s, rng)
  return spawnBlock(s, rng, schedSec, index)
}

export const spawnBlock = (s: RunState, rng: Rng, schedSec: number, index: number) => {
  const t = schedSec
  // Cell size is constant so the global drop step is always exactly "1x1 block".
  const cellSize = 40
  // Big rounding: for a 1-cell-thick block, ends should read as a half-circle (capsule).
  // Use ~cellSize/2, with a tiny epsilon to avoid degenerate geometry.
  const cornerRadius = cellSize * 0.5 - 0.6

  // Routing-focused kind, dealt from the deterministic per-day bag (scheduled
  // introduction; early game is normal-only).
  let kind = kindForIndex(s.dailySeed, index)

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
  // Armored must be at least 2 cells TALL: a 1-cell-thick horizontal piece (I3/I4)
  // makes a tediously long target whose only damageable faces are a sliver of
  // top/sides, so route-around play degenerates. Restrict to taller shapes.
  const shapeHeight = (sh: ShapeDef) => shapeCellBounds(normalizeCellsToOrigin(sh.cells)).h
  const armoredPool = pool.filter((sh) => shapeHeight(sh) >= 2)
  const shape =
    kind === 'chrome'
      ? (SHAPES.find((sh) => sh.id === 'Dot') ?? randOf(pool, rng))
      : kind === 'shatter'
        ? randOf(shatterPool.length > 0 ? shatterPool : pool, rng)
        : kind === 'armored'
          ? randOf(armoredPool.length > 0 ? armoredPool : pool, rng)
          : randOf(pool, rng)
  const cells = normalizeCellsToOrigin(shape.cells)
  const bounds = shapeCellBounds(cells)
  // Defensive: never leave a 1-cell-tall piece armored (annoying target).
  if (kind === 'armored' && bounds.h < 2) kind = 'normal'
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
  //
  // Armored lane separation: keep each armored's preferred lane well away from
  // the previous armored's, so two of them can never wall off adjacent columns
  // and shield each other's side faces. The remap consumes the same single rng
  // draw, and the previous lane is itself part of the deterministic spawn
  // sequence, so this stays identical for everyone.
  let laneFrac = rng()
  if (kind === 'armored') {
    const last = s.lastArmoredLaneFrac
    if (last >= 0) {
      const MIN_GAP = 0.35
      const lo = Math.max(0, last - MIN_GAP) // allowed: [0, lo) ...
      const hi = Math.min(1, last + MIN_GAP) // ... and (hi, 1]
      const total = lo + (1 - hi)
      if (total > 1e-4) {
        const u = laneFrac * total
        laneFrac = u < lo ? u : hi + (u - lo)
      }
    }
    s.lastArmoredLaneFrac = laneFrac
  }
  const placed = placeAabb(s, wPx, hPx, { preferredXFrac: laneFrac })

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

// Scripted spawn for the directed warmup. Places a block of a chosen shape/kind
// in a chosen horizontal lane, just above the visible top edge so it descends
// into view. No collision checks (the warmup board is fully authored). Returns
// the new block id so the tutorial can track / highlight it.
export const spawnTutorialBlock = (
  s: RunState,
  opts: { shapeId?: string; kind?: BlockKind; isGold?: boolean; laneFrac?: number; rowsAbove?: number },
): number => {
  const cellSize = 40
  const cornerRadius = cellSize * 0.5 - 0.6
  const shape = SHAPES.find((sh) => sh.id === (opts.shapeId ?? 'O4')) ?? SHAPES[0]!
  const cells = normalizeCellsToOrigin(shape.cells)
  const bounds = shapeCellBounds(cells)
  const wPx = bounds.w * cellSize
  const hPx = bounds.h * cellSize

  const HP_PER_CELL = 8
  const hpMax = Math.max(1, Math.round(HP_PER_CELL * cells.length))
  const isGold = !!opts.isGold
  const xpValue = isGold ? 5 + s.stats.goldXpBonus : 1

  const loop = buildCellLoop(cells)
  const localAabb = computeLocalAabbPx(cells, cellSize)

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
    const d = (cx - avgX) ** 2 + (cy - avgY) ** 2
    if (d < bestD) {
      bestD = d
      best = { x: cx, y: cy }
    }
  }
  const hpAnchorLocalPx = { x: best.x * cellSize, y: best.y * cellSize }

  const layout = getArenaLayout(s.view)
  const topWorldY = screenTopWorldY(s.view, layout)
  const laneFrac = clamp(opts.laneFrac ?? 0.5, 0, 1)
  const x = clamp(laneFrac * s.view.width - wPx / 2, 4, Math.max(4, s.view.width - wPx - 4))
  const y = topWorldY - hPx - (opts.rowsAbove ?? 1) * cellSize

  const block: BlockEntity = {
    id: s.nextBlockId++,
    cells,
    cellSize,
    cornerRadius,
    pos: { x, y },
    vel: { x: 0, y: 0 },
    hpMax,
    hp: hpMax,
    xpValue,
    isGold,
    kind: opts.kind ?? 'normal',
    dropAnimExtra: 0,
    shieldFlashSec: 0,
    loop,
    localAabb,
    hpAnchorLocalPx,
  }
  s.blocks.push(block)
  return block.id
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
  // Children spawn at HALF the normal per-cell HP. At full HP a shatter piece
  // cost double any other piece its size (parent + a full-HP cell per cell) —
  // quietly the most expensive kill in the game, AND fast-class, landing right
  // where the difficulty curve is steepest. Half-HP children keep the
  // "multiplies the threat" identity at 1.5x total cost instead of 2x.
  const HP_PER_CELL = 4

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


