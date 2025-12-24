import { clamp } from './math'
import type { BlockEntity, BoardFeature, BlackHoleFeature, MirrorFeature, PrismFeature, RunState } from './runState'
import { buildCellLoop, computeLocalAabbPx } from './outline'
import { SHAPES } from './shapes'

const randOf = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)]!

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

const rollFeatureKind = (tSec: number): BoardFeature['kind'] | null => {
  // Tunable knobs. Start rare so the board reads cleanly; ramp slightly over time.
  const ramp = clamp((tSec - 25) / 180, 0, 1)
  // Requested: 5% each before ramp, 8% each after ramp.
  const pMirror = 0.05 + 0.03 * ramp
  const pPrism = 0.05 + 0.03 * ramp
  const pHole = 0.05 + 0.03 * ramp

  const r = Math.random()
  if (r < pHole) return 'blackHole'
  if (r < pHole + pPrism) return 'prism'
  if (r < pHole + pPrism + pMirror) return 'mirror'
  return null
}

const placeAabb = (s: RunState, wPx: number, hPx: number) => {
  const pad = 18
  const gap = 16
  const xMin = pad
  const xMax = s.view.width - wPx - pad

  const baseY = -hPx - 28
  const maxBacklog = Math.max(260, s.view.height * 0.65)

  let placedX = clamp(Math.random() * (s.view.width - wPx), xMin, xMax)
  let placedY = baseY
  let found = false
  let bestScore = -Infinity

  for (let attempt = 0; attempt < 22; attempt++) {
    const x = clamp(Math.random() * (s.view.width - wPx), xMin, xMax)

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
    const y = Math.max(-maxBacklog - hPx, yRaw)
    const cand = { minX: x, minY: y, maxX: x + wPx, maxY: y + hPx }

    if (!collidesAny(cand, s)) {
      const clearance = baseY - y
      const score = -overlapCount * 3 - clearance * 0.01 + Math.random() * 0.15
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
    placedY = Math.max(-maxBacklog - hPx, yRaw)
  }

  return { x: placedX, y: placedY }
}

const spawnMirror = (s: RunState) => {
  const t = s.timeSec
  const cellSize = 40
  const cornerRadius = cellSize * 0.5 - 0.6

  const pool =
    t < 25
      ? SHAPES.filter((sh) => sh.id !== 'Dot' && sh.id !== 'I4')
      : t < 60
        ? SHAPES.filter((sh) => sh.id !== 'Dot')
        : SHAPES.filter((sh) => sh.id !== 'Dot')

  const shape = randOf(pool)
  const cells = normalizeCellsToOrigin(shape.cells)
  const bounds = shapeCellBounds(cells)
  const wPx = bounds.w * cellSize
  const hPx = bounds.h * cellSize

  const loop = buildCellLoop(cells)
  const localAabb = computeLocalAabbPx(cells, cellSize)
  const placed = placeAabb(s, wPx, hPx)

  const mirror: MirrorFeature = {
    id: s.nextFeatureId++,
    kind: 'mirror',
    cells,
    cellSize,
    cornerRadius,
    pos: { x: placed.x, y: placed.y },
    loop,
    localAabb,
  }
  s.features.push(mirror)
  s.normalBlocksSinceFeature = 0
}

const spawnPrism = (s: RunState) => {
  const cellSize = 40
  const r = cellSize * 0.36
  const wPx = cellSize
  const hPx = cellSize
  const placed = placeAabb(s, wPx, hPx)

  // Prism exit configurations: pick 2-4 distinct offsets from the allowed set.
  // These are *relative* to the incoming beam direction.
  const allowed: number[] = [0, 15, -15, 45, -45, 90, -90]
  const count = 2 + Math.floor(Math.random() * 3) // 2..4
  const exits: number[] = []
  while (exits.length < count) {
    const d = allowed[Math.floor(Math.random() * allowed.length)]!
    if (exits.includes(d)) continue
    exits.push(d)
  }

  const prism: PrismFeature = {
    id: s.nextFeatureId++,
    kind: 'prism',
    pos: { x: placed.x, y: placed.y },
    cellSize,
    r,
    exitsDeg: exits,
    localAabb: { minX: 0, minY: 0, maxX: cellSize, maxY: cellSize },
  }
  s.features.push(prism)
  s.normalBlocksSinceFeature = 0
}

export const spawnPrismAt = (s: RunState, x: number, y: number) => {
  const cellSize = 40
  const r = cellSize * 0.36
  
  // Prism exit configurations: pick 2-4 distinct offsets from the allowed set.
  const allowed: number[] = [0, 15, -15, 45, -45, 90, -90]
  const count = 2 + Math.floor(Math.random() * 3) // 2..4
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
    localAabb: { minX: 0, minY: 0, maxX: cellSize, maxY: cellSize },
  }
  s.features.push(prism)
}

const spawnBlackHole = (s: RunState) => {
  const cellSize = 40
  const rCore = cellSize * 0.38 // core absorber (slightly smaller than the tile)
  const rInfluence = cellSize * 1.65 * 2.0 * 0.85 // ~15% smaller influence radius
  const wPx = cellSize
  const hPx = cellSize
  const placed = placeAabb(s, wPx, hPx)
  const hole: BlackHoleFeature = {
    id: s.nextFeatureId++,
    kind: 'blackHole',
    pos: { x: placed.x, y: placed.y },
    cellSize,
    rCore,
    rInfluence,
    localAabb: { minX: 0, minY: 0, maxX: cellSize, maxY: cellSize },
  }
  s.features.push(hole)
  s.normalBlocksSinceFeature = 0
}

export const spawnBoardThing = (s: RunState) => {
  const kind = rollFeatureKind(s.timeSec)
  // Early-run safeguard: first 15 blocks must be normal (no undamageable features).
  if (s.blocksSpawned < 15) {
    return spawnBlock(s)
  }
  // Protection: require at least 3 normal blocks between each feature spawn.
  if (kind != null && s.normalBlocksSinceFeature < 3) {
    return spawnBlock(s)
  }
  if (kind === 'mirror') return spawnMirror(s)
  if (kind === 'prism') return spawnPrism(s)
  if (kind === 'blackHole') return spawnBlackHole(s)
  return spawnBlock(s)
}

export const spawnBlock = (s: RunState) => {
  const t = s.timeSec
  // Cell size is constant so the global drop step is always exactly "1x1 block".
  const cellSize = 40
  // Big rounding: for a 1-cell-thick block, ends should read as a half-circle (capsule).
  // Use ~cellSize/2, with a tiny epsilon to avoid degenerate geometry.
  const cornerRadius = cellSize * 0.5 - 0.6

  // Shape weighting: simpler early, bigger later.
  const pool =
    t < 25
      ? SHAPES.filter((sh) => sh.id !== 'Dot' && sh.id !== 'I4')
      : t < 60
        ? SHAPES.filter((sh) => sh.id !== 'Dot')
        : SHAPES

  const shape = randOf(pool)
  const cells = normalizeCellsToOrigin(shape.cells)
  const bounds = shapeCellBounds(cells)
  const wPx = bounds.w * cellSize
  const hPx = bounds.h * cellSize
 
  // Difficulty scaling: based on DEPTH (global drop steps), not time.
  //
  // Difficulty scaling: base HP ramps up faster over time, based on DEPTH (global drops),
  // mapped to minutes at the *baseline* drop interval.
  //
  // Target per-minute base HP increase schedule:
  // - minute 0..1: +6 base HP
  // - minute 1..2: +8 base HP
  // - minute 2..3: +10 base HP
  // - minute 3..4: +12 base HP
  // - minute 4+: capped at +12 base HP per minute
  //
  // Baseline drop interval is 1.2s => drops/minute = 60 / 1.2 = 50.
  // We treat depth/100 as "minutes elapsed" and integrate that piecewise-linear rate.
  //
  // Note: this uses a fixed slope per depth, so slowing the drop interval means HP grows
  // more slowly in real time (but stays consistent per “lines survived”).
  const baseHp0 = 9
  const dropsPerMinBaseline = 100
  const initialRate = 6
  const rateIncrement = 2
  const maxRate = 12
  const minutes = Math.max(0, s.depth) / dropsPerMinBaseline
  const whole = Math.floor(minutes)
  const frac = minutes - whole
  // Sum of full minutes using arithmetic progression: Σ_{i=0..whole-1} (initialRate + rateIncrement*i)
  // = whole*initialRate + rateIncrement*whole*(whole-1)/2
  // Calculate when cap is reached: initialRate + rateIncrement * capMinute = maxRate
  const capMinute = (maxRate - initialRate) / rateIncrement
  let fullInc: number
  let curRate: number
  if (whole <= capMinute) {
    fullInc = whole * initialRate + rateIncrement * whole * (whole - 1) / 2
    curRate = initialRate + rateIncrement * whole
  } else {
    // Sum up to cap minute, then add capped rate for remaining minutes
    const cappedInc = capMinute * initialRate + rateIncrement * capMinute * (capMinute - 1) / 2
    const extraMinutes = whole - capMinute
    fullInc = cappedInc + maxRate * extraMinutes
    curRate = maxRate
  }
  const inc = fullInc + frac * curRate
  const baseHp = baseHp0 + inc
  const sizeMult = 0.7 + 0.22 * Math.sqrt(shape.cells.length)
  // HP now has a capped growth rate, preventing runaway difficulty.
  const hpMax = Math.round(baseHp * sizeMult * 1.5)
  
  // Gold block spawn chance
  const isGold = Math.random() < s.stats.goldSpawnChance
  
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

  // Spawn placement: never overlap any existing block AABB (including other newly-spawned blocks above).
  const placed = placeAabb(s, wPx, hPx)

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
    loop,
    localAabb,
    hpAnchorLocalPx,
  }

  s.blocks.push(block)
  s.blocksSpawned += 1
  s.normalBlocksSinceFeature = Math.min(3, s.normalBlocksSinceFeature + 1)
}


