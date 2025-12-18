import type { Vec2 } from './math'
import { add, clamp, cross, dot, len, mul, normalize, sub } from './math'
import type { BlockEntity } from './runState'

export type RayHit = {
  t: number
  point: Vec2
  normal: Vec2
  blockId: number
}

type Segment = { a: Vec2; b: Vec2; normalOut: Vec2 }
type Arc = { c: Vec2; r: number; start: number; end: number }

const TAU = Math.PI * 2

const normAngle = (a: number) => {
  let x = a % TAU
  if (x < 0) x += TAU
  return x
}

const angleInArcCCW = (angle: number, start: number, end: number) => {
  const a = normAngle(angle)
  const s = normAngle(start)
  const e = normAngle(end)
  const total = normAngle(e - s)
  const delta = normAngle(a - s)
  return delta <= total + 1e-6
}

const raySegment = (o: Vec2, d: Vec2, a: Vec2, b: Vec2): { t: number; p: Vec2 } | null => {
  const v = sub(b, a)
  const denom = cross(d, v)
  if (Math.abs(denom) < 1e-9) return null
  const ao = sub(a, o)
  const t = cross(ao, v) / denom
  const u = cross(ao, d) / denom
  if (t < 0) return null
  if (u < 0 || u > 1) return null
  return { t, p: add(o, mul(d, t)) }
}

const rayCircle = (o: Vec2, d: Vec2, c: Vec2, r: number): number[] => {
  const oc = sub(o, c)
  const a = dot(d, d)
  const b = 2 * dot(oc, d)
  const cc = dot(oc, oc) - r * r
  const disc = b * b - 4 * a * cc
  if (disc < 0) return []
  const s = Math.sqrt(disc)
  const t1 = (-b - s) / (2 * a)
  const t2 = (-b + s) / (2 * a)
  const out: number[] = []
  if (t1 >= 0) out.push(t1)
  if (t2 >= 0) out.push(t2)
  return out.sort((x, y) => x - y)
}

// Convert a block's cell-loop into world-space collision primitives (segments + convex corner arcs).
// This is translation-only and called per raycast; in v1 we keep it simple.
const buildPrimsForBlock = (block: BlockEntity): { segments: Segment[]; arcs: Arc[] } => {
  const ptsLocal = block.loop
  const n = ptsLocal.length
  const m = Math.max(0, n - 1) // unique vertices (closed loop duplicates first at end)
  const r = clamp(block.cornerRadius, 0, block.cellSize * 0.49)
  const segments: Segment[] = []
  const arcs: Arc[] = []

  const world = (p: Vec2): Vec2 => ({
    x: block.pos.x + p.x * block.cellSize,
    y: block.pos.y + p.y * block.cellSize,
  })

  const pt = (i: number) => ptsLocal[((i % m) + m) % m]!

  const dirAt = (i0: number, i1: number): Vec2 => {
    const a = pt(i0)
    const b = pt(i1)
    return normalize({ x: b.x - a.x, y: b.y - a.y })
  }

  const isConvexCorner = (i: number) => {
    if (m < 3) return false
    const inD = dirAt(i - 1, i)
    const outD = dirAt(i, i + 1)
    // With y-down and clockwise boundary, convex corners have positive cross(in,out).
    return cross(inD, outD) > 0.5
  }

  const convex: boolean[] = []
  for (let i = 0; i < m; i++) convex[i] = isConvexCorner(i)

  // Build shortened segments + arcs.
  for (let i = 0; i < m; i++) {
    const a0 = pt(i)
    const b0 = pt(i + 1)
    const d = normalize({ x: b0.x - a0.x, y: b0.y - a0.y })
    const segLen = len({ x: (b0.x - a0.x) * block.cellSize, y: (b0.y - a0.y) * block.cellSize })
    const cutA = convex[i] ? Math.min(r, segLen * 0.49) : 0
    const cutB = convex[(i + 1) % m] ? Math.min(r, segLen * 0.49) : 0

    const a = world(add(a0, mul(d, cutA / block.cellSize)))
    const b = world(sub(b0, mul(d, cutB / block.cellSize)))
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-3) {
      // Outward normal for clockwise boundary in y-down is (dy, -dx).
      const normalOut = normalize({ x: d.y, y: -d.x })
      segments.push({ a, b, normalOut })
    }

  }

  for (let i = 0; i < m; i++) {
    if (!convex[i]) continue
    const p = pt(i)
    const inD = dirAt(i - 1, i)
    const outD = dirAt(i, i + 1)
    const rp = Math.min(r, block.cellSize * 0.49)

    const startPt = world(sub(p, mul(inD, rp / block.cellSize)))
    const endPt = world(add(p, mul(outD, rp / block.cellSize)))
    const center = world(add(sub(p, mul(inD, rp / block.cellSize)), mul(outD, rp / block.cellSize)))

    const start = Math.atan2(startPt.y - center.y, startPt.x - center.x)
    const end = Math.atan2(endPt.y - center.y, endPt.x - center.x)

    // For our clockwise boundary in y-down, these fillet arcs traverse CCW by 90 degrees.
    arcs.push({ c: center, r: rp, start, end })
  }

  return { segments, arcs }
}

const quickRejectRayAabb = (o: Vec2, d: Vec2, minX: number, minY: number, maxX: number, maxY: number) => {
  // Ray-AABB slab test; returns whether intersection exists with t>=0.
  const invDx = d.x !== 0 ? 1 / d.x : Infinity
  const invDy = d.y !== 0 ? 1 / d.y : Infinity
  let tmin = (minX - o.x) * invDx
  let tmax = (maxX - o.x) * invDx
  if (tmin > tmax) [tmin, tmax] = [tmax, tmin]
  let tymin = (minY - o.y) * invDy
  let tymax = (maxY - o.y) * invDy
  if (tymin > tymax) [tymin, tymax] = [tymax, tymin]
  if (tmin > tymax || tymin > tmax) return false
  tmin = Math.max(tmin, tymin)
  tmax = Math.min(tmax, tymax)
  return tmax >= Math.max(0, tmin)
}

export const raycastBlocks = (
  o: Vec2,
  dIn: Vec2,
  blocks: BlockEntity[],
  maxDist: number,
  minT: number = 0,
): RayHit | null => {
  const d = normalize(dIn)
  let best: RayHit | null = null

  for (const b of blocks) {
    const aabb = b.localAabb
    const minX = b.pos.x + aabb.minX
    const minY = b.pos.y + aabb.minY
    const maxX = b.pos.x + aabb.maxX
    const maxY = b.pos.y + aabb.maxY

    // Gameplay rule: blocks are not shootable until they are visible.
    // If the block is fully above the top edge of the screen, skip it.
    if (maxY < 0) continue

    if (!quickRejectRayAabb(o, d, minX, minY, maxX, maxY)) continue

    const prims = buildPrimsForBlock(b)

    for (const s of prims.segments) {
      const hit = raySegment(o, d, s.a, s.b)
      if (!hit) continue
      if (hit.t < minT) continue
      if (hit.t > maxDist) continue
      if (!best || hit.t < best.t) {
        best = { t: hit.t, point: hit.p, normal: s.normalOut, blockId: b.id }
      }
    }

    for (const arc of prims.arcs) {
      const ts = rayCircle(o, d, arc.c, arc.r)
      for (const t of ts) {
        if (t < minT) continue
        if (t > maxDist) break
        const p = add(o, mul(d, t))
        const a = Math.atan2(p.y - arc.c.y, p.x - arc.c.x)
        if (!angleInArcCCW(a, arc.start, arc.end)) continue
        const normal = normalize(sub(p, arc.c))
        if (!best || t < best.t) {
          best = { t, point: p, normal, blockId: b.id }
        }
      }
    }
  }

  return best
}

export const raycastBlocksThick = (
  o: Vec2,
  dIn: Vec2,
  blocks: BlockEntity[],
  maxDist: number,
  radius: number,
  minT: number = 0,
): RayHit | null => {
  if (radius <= 0.01) return raycastBlocks(o, dIn, blocks, maxDist, minT)

  const d = normalize(dIn)
  const perp = normalize({ x: -d.y, y: d.x })

  // Simple, stable approximation: cast 3 rays (center + ±radius).
  // This makes beam width *matter* for hitting near-misses.
  const offsets = [0, -radius, radius]

  let best: RayHit | null = null
  for (const off of offsets) {
    const oo = off === 0 ? o : add(o, mul(perp, off))
    const hit = raycastBlocks(oo, d, blocks, maxDist, minT)
    if (!hit) continue
    if (!best || hit.t < best.t) best = hit
  }

  return best
}


