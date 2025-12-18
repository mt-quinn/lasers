import { clamp } from './math'
import type { BlockEntity, RunState } from './runState'
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

export const spawnBlock = (s: RunState) => {
  const t = s.timeSec
  const cellSize = clamp(42 - Math.floor(t / 80) * 2, 32, 44)
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
  const lateT = clamp((t - 60) / 300, 0, 1)
  const e = smoothstep(earlyT)
  const l = smoothstep(lateT)

  const baseHpEarly = 90 + (240 - 90) * e
  const baseHpLate = 180 + (1200 - 180) * l
  const baseHp = t < 60 ? baseHpEarly : baseHpLate
  const sizeMult = 0.7 + 0.25 * Math.sqrt(shape.cells.length)
  const hpMax = Math.round(baseHp * sizeMult)
  // Keep value proportional to HP; slightly more generous so milestone purchases
  // like Ricochet are reachable before the run ends.
  const value = Math.round(6 + hpMax * 0.07)

  const loop = buildCellLoop(cells)
  const localAabb = computeLocalAabbPx(cells, cellSize)

  // Spawn placement: never overlap any existing block AABB (including other newly-spawned blocks above).
  const pad = 18
  const gap = 16
  const xMin = pad
  const xMax = s.view.width - wPx - pad

  const worldAabbFor = (x: number, y: number) => ({
    minX: x + localAabb.minX,
    minY: y + localAabb.minY,
    maxX: x + localAabb.maxX,
    maxY: y + localAabb.maxY,
  })

  const intersects = (a: ReturnType<typeof worldAabbFor>, b: ReturnType<typeof worldAabbFor>) =>
    a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY

  const baseY = -hPx - 28
  const maxBacklog = Math.max(260, s.view.height * 0.65)

  let placedX = clamp(Math.random() * (s.view.width - wPx), xMin, xMax)
  let placedY = baseY
  let found = false

  // Try multiple X locations; if horizontal overlap is unavoidable, spawn above
  // the highest block in that horizontal band so we never overlap.
  // We also score candidates to avoid creating unfair vertical "death columns".
  // Prefer positions with fewer horizontally-overlapping blocks and more clearance.
  let bestScore = -Infinity
  for (let attempt = 0; attempt < 22; attempt++) {
    const x = clamp(Math.random() * (s.view.width - wPx), xMin, xMax)

    // Find all blocks that overlap horizontally, then spawn above the topmost of them.
    let minTopY = Infinity
    let overlapCount = 0
    for (const other of s.blocks) {
      const o = worldAabbFor(other.pos.x, other.pos.y)
      const candX0 = x + localAabb.minX
      const candX1 = x + localAabb.maxX
      const overlapsX = candX0 < o.maxX && candX1 > o.minX
      if (!overlapsX) continue
      overlapCount++
      minTopY = Math.min(minTopY, o.minY)
    }

    const yRaw = Number.isFinite(minTopY) ? Math.min(baseY, minTopY - (hPx + gap)) : baseY
    const y = Math.max(-maxBacklog - hPx, yRaw)
    const cand = worldAabbFor(x, y)

    let ok = true
    for (const other of s.blocks) {
      const o = worldAabbFor(other.pos.x, other.pos.y)
      if (intersects(cand, o)) {
        ok = false
        break
      }
    }

    if (ok) {
      // Score: prefer fewer overlaps and less backlog (closer to baseY).
      const clearance = baseY - y // >= 0
      const score = -overlapCount * 3 - clearance * 0.01 + Math.random() * 0.15
      if (!found || score > bestScore) {
        bestScore = score
        placedX = x
        placedY = y
        found = true
      }
    }
  }

  // If we somehow fail to place (should be rare), push it far above the topmost block.
  if (!found && s.blocks.length > 0) {
    let minY = Infinity
    for (const other of s.blocks) {
      const o = worldAabbFor(other.pos.x, other.pos.y)
      minY = Math.min(minY, o.minY)
    }
    placedY = Math.max(-maxBacklog - hPx, Math.min(baseY, minY - (hPx + gap)))
  }

  const block: BlockEntity = {
    id: s.nextBlockId++,
    cells,
    cellSize,
    cornerRadius,
    pos: { x: placedX, y: placedY },
    // Vel is assigned in sim as a global fall speed so blocks never "catch up" and overlap.
    vel: { x: 0, y: 0 },
    hpMax,
    hp: hpMax,
    value,
    loop,
    localAabb,
  }

  s.blocks.push(block)
}


