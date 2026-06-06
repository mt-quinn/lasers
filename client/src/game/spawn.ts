import { clamp } from './math'
import type { BlockEntity, BlockKind, BoardFeature, MirrorFeature, PrismFeature, RunState } from './runState'
import { buildCellLoop, computeLocalAabbPx } from './outline'
import { SHAPES } from './shapes'
import { getArenaLayout } from './layout'
import { screenTopWorldY } from '../render/projection'

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

// Routing-focused block variety, introduced on a schedule so the player learns
// the base verb (pierce) first, then fast-droppers, then armored, then chrome.
// These add routing/prioritization decisions, never HP-sponge tedium.
const rollBlockKind = (tSec: number): BlockKind => {
  if (tSec < 30) return 'normal'
  const pFast = clamp((tSec - 30) / 90, 0, 1) * 0.2 // ramps to ~20%
  const pArmored = clamp((tSec - 60) / 120, 0, 1) * 0.16 // ramps to ~16%
  const pChrome = clamp((tSec - 100) / 150, 0, 1) * 0.1 // ramps to ~10%
  const r = Math.random()
  if (r < pChrome) return 'chrome'
  if (r < pChrome + pArmored) return 'armored'
  if (r < pChrome + pArmored + pFast) return 'fast'
  return 'normal'
}

const rollFeatureKind = (tSec: number): BoardFeature['kind'] | null => {
  // Tunable knobs. Start rare so the board reads cleanly; ramp slightly over time.
  // Optics (mirror/prism) are now the player's routing *tools*, so they appear a
  // bit more often than the old per-feature rate (black holes are gone).
  const ramp = clamp((tSec - 25) / 180, 0, 1)
  const pMirror = 0.07 + 0.04 * ramp
  const pPrism = 0.07 + 0.04 * ramp

  const r = Math.random()
  if (r < pPrism) return 'prism'
  if (r < pPrism + pMirror) return 'mirror'
  return null
}

type PlaceOpts = {
  // Keep the piece out of the central column (mirrors, which would otherwise
  // reflect the straight-up beam back down and stall the game).
  avoidCenterHalf?: number
  // Keep the piece off one side wall so a routed beam can reach that face.
  // -1 = hold off the LEFT wall, +1 = hold off the RIGHT wall. Used for armored
  // blocks whose weak (damageable) side points at that wall.
  clearWallSide?: -1 | 0 | 1
  clearWallPx?: number
}

const placeAabb = (s: RunState, wPx: number, hPx: number, opts: PlaceOpts = {}) => {
  const avoidCenterHalf = opts.avoidCenterHalf ?? 0
  const clearWallSide = opts.clearWallSide ?? 0
  const clearWallPx = opts.clearWallPx ?? 0
  const pad = 18
  const gap = 16
  let xMin = pad
  let xMax = s.view.width - wPx - pad
  // Reserve a routing lane between the weak face and its wall.
  if (clearWallSide < 0) xMin = Math.min(xMax, xMin + clearWallPx)
  else if (clearWallSide > 0) xMax = Math.max(xMin, xMax - clearWallPx)

  const centerX = s.view.width / 2
  const genX = () => {
    if (avoidCenterHalf > 0) {
      // Left lane: piece's right edge stays left of the protected band.
      const leftHi = centerX - avoidCenterHalf - wPx
      // Right lane: piece's left edge stays right of the protected band.
      const rightLo = centerX + avoidCenterHalf
      const leftOk = leftHi >= xMin
      const rightOk = rightLo <= xMax
      if (leftOk || rightOk) {
        const pickLeft = leftOk && (!rightOk || Math.random() < 0.5)
        if (pickLeft) return clamp(xMin + Math.random() * (leftHi - xMin), xMin, leftHi)
        return clamp(rightLo + Math.random() * (xMax - rightLo), rightLo, xMax)
      }
      // Fallback (piece too wide to dodge the band): fall through to full width.
    }
    return clamp(xMin + Math.random() * Math.max(0, xMax - xMin), xMin, xMax)
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
    const x = genX()

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
    placedY = Math.max(backlogFloor, yRaw)
  }

  return { x: placedX, y: placedY }
}

// Mirror durability: how much beam contact a deflector survives. High enough to
// be a reliable routing tool, low enough that you can deliberately burn down one
// that's in your way.
const MIRROR_HP = 80
const MIRROR_SIZE_CELLS = 2

const spawnMirror = (s: RunState) => {
  const cellSize = 40
  const sizePx = MIRROR_SIZE_CELLS * cellSize
  // Diagonal-only: a vertical beam is always kicked sideways, never straight back.
  const orient: 1 | -1 = Math.random() < 0.5 ? 1 : -1
  // Keep a small launch corridor at center so the muzzle usually has clearance,
  // but mirrors can sit near-center for routing (they deflect, never block).
  const placed = placeAabb(s, sizePx, sizePx, { avoidCenterHalf: s.view.width * 0.12 })

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

const spawnPrism = (s: RunState) => {
  const cellSize = 40
  const r = cellSize * 0.36
  const wPx = cellSize
  const hPx = cellSize
  const placed = placeAabb(s, wPx, hPx)

  // Prism exit configurations: pick 2 distinct offsets from the allowed set.
  // These are *relative* to the incoming beam direction.
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
    localAabb: { minX: 0, minY: 0, maxX: cellSize, maxY: cellSize },
  }
  s.features.push(prism)
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
  return spawnBlock(s)
}

export const spawnBlock = (s: RunState) => {
  const t = s.timeSec
  // Cell size is constant so the global drop step is always exactly "1x1 block".
  const cellSize = 40
  // Big rounding: for a 1-cell-thick block, ends should read as a half-circle (capsule).
  // Use ~cellSize/2, with a tiny epsilon to avoid degenerate geometry.
  const cornerRadius = cellSize * 0.5 - 0.6

  // Routing-focused kind (scheduled introduction; early game is normal-only).
  // `let` because a piece with no fair armored weak face is demoted to normal.
  let kind = rollBlockKind(t)

  // Shape weighting: simpler early, bigger later. Chrome is always a single cell
  // so its reflective phase is brief — it dies fast and can't wall the muzzle.
  const pool =
    t < 25
      ? SHAPES.filter((sh) => sh.id !== 'Dot' && sh.id !== 'I4')
      : t < 60
        ? SHAPES.filter((sh) => sh.id !== 'Dot')
        : SHAPES

  const shape = kind === 'chrome' ? (SHAPES.find((sh) => sh.id === 'Dot') ?? randOf(pool)) : randOf(pool)
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

  // Armored weak face: a non-bottom side so the straight-up beam can't trivially
  // reach it — you must bend/route the beam onto it. The weak face must also be a
  // *fair* target, i.e. span at least 2 cells: hitting the 1-cell-tall side of a
  // long horizontal bar (I3/I4) isn't fun, so those only ever expose their wide
  // top. A piece with no fair face at all (a 1x1) can't be a meaningful armored
  // block, so it's demoted to a normal block.
  let vulnNormal = { x: 0, y: 0 }
  if (kind === 'armored') {
    const sideFair = bounds.h >= 2 // left/right faces tall enough to aim at
    const topFair = bounds.w >= 2 // top face wide enough to aim at
    const r = Math.random()
    if (sideFair && topFair) {
      vulnNormal = r < 0.42 ? { x: -1, y: 0 } : r < 0.84 ? { x: 1, y: 0 } : { x: 0, y: -1 }
    } else if (sideFair) {
      vulnNormal = r < 0.5 ? { x: -1, y: 0 } : { x: 1, y: 0 }
    } else if (topFair) {
      vulnNormal = { x: 0, y: -1 }
    } else {
      kind = 'normal'
    }
  }

  // Gold blocks are a normal-kind bonus only (no special-kind gold).
  const isGold = kind === 'normal' && Math.random() < s.stats.goldSpawnChance

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
  // newly-spawned blocks above). Armored pieces with a side-facing weak face are
  // held off that wall so there's room to route the beam onto it (a left-weak
  // block never spawns flush against the left wall, etc.).
  const placeOpts: PlaceOpts =
    kind === 'armored' && vulnNormal.x !== 0
      ? { clearWallSide: vulnNormal.x < 0 ? -1 : 1, clearWallPx: cellSize * 1.5 }
      : {}
  const placed = placeAabb(s, wPx, hPx, placeOpts)

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
    vulnNormal,
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


