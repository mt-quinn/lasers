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
}

export const spawnBoardThing = (s: RunState) => {
  const kind = rollFeatureKind(s.timeSec)
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
 
  // Difficulty scaling: extremely gentle early so players can afford upgrades.
  const smoothstep = (x: number) => x * x * (3 - 2 * x)
  const earlyT = clamp(t / 60, 0, 1)
  // Slow the late-game HP ramp: spread it over a longer window so it doesn't spike quickly.
  const lateT = clamp((t - 60) / 420, 0, 1)
  const e = smoothstep(earlyT)
  const l = smoothstep(lateT)
  const lEased = l * l // ease-in: slower growth early in the late phase

  // Scale down displayed HP numbers by 10x without changing TTK (DPS is scaled too).
  const baseHpEarly = 9 + (24 - 9) * e
  // Soften the harshest scenarios: reduce late-game endpoint and ramp more gently.
  const baseHpLate = 18 + (92 - 18) * lEased
  const baseHp = t < 60 ? baseHpEarly : baseHpLate
  const sizeMult = 0.7 + 0.22 * Math.sqrt(shape.cells.length)
  // Soft cap prevents late-game rolls from becoming effectively unkillable.
  const hpMax = Math.min(240, Math.round(baseHp * sizeMult * 1.5))
  // XP per block: keep simple for now (tunable). Larger shapes are worth a bit more.
  const xpValue = Math.max(1, Math.round(Math.sqrt(shape.cells.length)))

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
    loop,
    localAabb,
    hpAnchorLocalPx,
  }

  s.blocks.push(block)
}


