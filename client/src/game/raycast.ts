import type { Vec2 } from './math'
import { add, clamp, cross, dot, len, mul, normalize, sub } from './math'
import type { BlockEntity, BlackHoleFeature, BoardFeature, MirrorFeature, PrismFeature } from './runState'

export type RayHit = {
  t: number
  point: Vec2
  normal: Vec2
  blockId: number
}

export type SceneHit = {
  t: number
  point: Vec2
  normal: Vec2
  kind: 'block' | 'mirror' | 'prism' | 'blackHole' | 'wall'
  id: number
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
const buildPrimsForBlock = (block: Pick<BlockEntity, 'loop' | 'cornerRadius' | 'cellSize' | 'pos'>): { segments: Segment[]; arcs: Arc[] } => {
  const ptsLocal = block.loop
  const n = ptsLocal.length
  const m = Math.max(0, n - 1) // unique vertices (closed loop duplicates first at end)
  const r = clamp(block.cornerRadius, 0, block.cellSize * 0.5 - 0.6)
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
    const cutA = convex[i] ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const cutB = convex[(i + 1) % m] ? Math.min(r, segLen * 0.5 - 0.6) : 0

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
    const rp = Math.min(r, block.cellSize * 0.5 - 0.6)

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

const raycastScenePolys = (
  o: Vec2,
  dIn: Vec2,
  polys: Array<{
    kind: SceneHit['kind']
    id: number
    poly: Pick<BlockEntity, 'loop' | 'cornerRadius' | 'cellSize' | 'pos'>
    localAabb: BlockEntity['localAabb']
  }>,
  maxDist: number,
  minT: number,
): SceneHit | null => {
  const d = normalize(dIn)
  let best: SceneHit | null = null

  for (const p of polys) {
    const aabb = p.localAabb
    const minX = p.poly.pos.x + aabb.minX
    const minY = p.poly.pos.y + aabb.minY
    const maxX = p.poly.pos.x + aabb.maxX
    const maxY = p.poly.pos.y + aabb.maxY

    if (maxY < 0) continue
    if (!quickRejectRayAabb(o, d, minX, minY, maxX, maxY)) continue

    const prims = buildPrimsForBlock(p.poly)

    for (const s of prims.segments) {
      const hit = raySegment(o, d, s.a, s.b)
      if (!hit) continue
      if (hit.t < minT) continue
      if (hit.t > maxDist) continue
      if (!best || hit.t < best.t) best = { t: hit.t, point: hit.p, normal: s.normalOut, kind: p.kind, id: p.id }
    }

    for (const arc of prims.arcs) {
      const ts = rayCircle(o, d, arc.c, arc.r)
      for (const t of ts) {
        if (t < minT) continue
        if (t > maxDist) break
        const point = add(o, mul(d, t))
        const a = Math.atan2(point.y - arc.c.y, point.x - arc.c.x)
        if (!angleInArcCCW(a, arc.start, arc.end)) continue
        const normal = normalize(sub(point, arc.c))
        if (!best || t < best.t) best = { t, point, normal, kind: p.kind, id: p.id }
        break
      }
    }
  }

  return best
}

const raycastSceneCircles = (
  o: Vec2,
  dIn: Vec2,
  circles: Array<{ kind: SceneHit['kind']; id: number; c: Vec2; r: number; maxY: number }>,
  maxDist: number,
  minT: number,
  ignorePrismId?: number,
): SceneHit | null => {
  const d = normalize(dIn)
  let best: SceneHit | null = null

  for (const c of circles) {
    if (c.maxY < 0) continue
    if (c.kind === 'prism' && ignorePrismId != null && c.id === ignorePrismId) continue
    // Important: if the ray starts inside a prism's circle (common immediately after splitting),
    // we must NOT "hit" it again on the way out, otherwise it will repeatedly split from a single pass.
    if (c.kind === 'prism') {
      const oc = sub(o, c.c)
      if (dot(oc, oc) < c.r * c.r) continue
    }
    const ts = rayCircle(o, d, c.c, c.r)
    for (const t of ts) {
      if (t < minT) continue
      if (t > maxDist) break
      const point = add(o, mul(d, t))
      const normal = normalize(sub(point, c.c))
      if (!best || t < best.t) best = { t, point, normal, kind: c.kind, id: c.id }
      break
    }
  }

  return best
}

const rayAabb = (
  o: Vec2,
  d: Vec2,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): { t: number; p: Vec2; n: Vec2 } | null => {
  // Slab intersection (t>=0). Returns entry hit.
  // If already inside, treat as immediate hit.
  if (o.x > minX && o.x < maxX && o.y > minY && o.y < maxY) {
    return { t: 0, p: { x: o.x, y: o.y }, n: normalize({ x: -d.x, y: -d.y }) }
  }
  const invDx = Math.abs(d.x) > 1e-9 ? 1 / d.x : Infinity
  const invDy = Math.abs(d.y) > 1e-9 ? 1 / d.y : Infinity

  let tmin = (minX - o.x) * invDx
  let tmax = (maxX - o.x) * invDx
  let nxMin = -1
  let nyMin = 0
  if (tmin > tmax) {
    ;[tmin, tmax] = [tmax, tmin]
    nxMin = 1
    nyMin = 0
  }

  let tymin = (minY - o.y) * invDy
  let tymax = (maxY - o.y) * invDy
  let nxY = 0
  let nyY = -1
  if (tymin > tymax) {
    ;[tymin, tymax] = [tymax, tymin]
    nxY = 0
    nyY = 1
  }

  if (tmin > tymax || tymin > tmax) return null
  if (tymin > tmin) {
    tmin = tymin
    nxMin = nxY
    nyMin = nyY
  }
  const tEntry = tmin
  if (tEntry < 0) return null
  const p = add(o, mul(d, tEntry))
  return { t: tEntry, p, n: normalize({ x: nxMin, y: nyMin }) }
}

const raycastSceneAabbs = (
  o: Vec2,
  dIn: Vec2,
  aabbs: Array<{ kind: SceneHit['kind']; id: number; minX: number; minY: number; maxX: number; maxY: number }>,
  maxDist: number,
  minT: number,
): SceneHit | null => {
  const d = normalize(dIn)
  let best: SceneHit | null = null
  for (const a of aabbs) {
    if (a.maxY < 0) continue
    if (!quickRejectRayAabb(o, d, a.minX, a.minY, a.maxX, a.maxY)) continue
    const hit = rayAabb(o, d, a.minX, a.minY, a.maxX, a.maxY)
    if (!hit) continue
    // Black holes must absorb even on extremely tiny t (especially with curved step integration).
    const effectiveMinT = a.kind === 'blackHole' ? 0 : minT
    if (hit.t < effectiveMinT) continue
    if (hit.t > maxDist) continue
    if (!best || hit.t < best.t) best = { t: hit.t, point: hit.p, normal: hit.n, kind: a.kind, id: a.id }
  }
  return best
}

const raycastSceneWalls = (
  o: Vec2,
  d: Vec2,
  w: number,
  h: number,
  maxDist: number,
  minT: number,
): SceneHit | null => {
  let bestT = Infinity
  let best: SceneHit | null = null

  const consider = (t: number, nx: number, ny: number, wallId: number) => {
    if (t < minT || t > maxDist) return
    if (t >= bestT) return
    const point = add(o, mul(d, t))
    const eps = 1e-3
    if (point.x < -eps || point.x > w + eps || point.y < -eps || point.y > h + eps) return
    bestT = t
    best = { t, point, normal: normalize({ x: nx, y: ny }), kind: 'wall', id: wallId }
  }

  // Left wall x=0 (normal +X)
  if (Math.abs(d.x) > 1e-9 && d.x < 0) {
    const t = (0 - o.x) / d.x
    consider(t, 1, 0, -1)
  }
  // Right wall x=w (normal -X)
  if (Math.abs(d.x) > 1e-9 && d.x > 0) {
    const t = (w - o.x) / d.x
    consider(t, -1, 0, -2)
  }
  // Top wall y=0 (normal +Y)
  if (Math.abs(d.y) > 1e-9 && d.y < 0) {
    const t = (0 - o.y) / d.y
    consider(t, 0, 1, -3)
  }
  // Bottom wall y=h (normal -Y) - the back wall behind the emitter
  if (Math.abs(d.y) > 1e-9 && d.y > 0) {
    const t = (h - o.y) / d.y
    consider(t, 0, -1, -4)
  }

  return best
}

export const raycastSceneThick = (
  o: Vec2,
  dIn: Vec2,
  blocks: BlockEntity[],
  features: BoardFeature[],
  maxDist: number,
  radius: number,
  minT: number = 0,
  bounds?: { w: number; h: number },
  ignorePrismId?: number,
): SceneHit | null => {
  const d = normalize(dIn)
  const perp = normalize({ x: -d.y, y: d.x })

  const polys: Array<{
    kind: SceneHit['kind']
    id: number
    poly: Pick<BlockEntity, 'loop' | 'cornerRadius' | 'cellSize' | 'pos'>
    localAabb: BlockEntity['localAabb']
  }> = []
  for (const b of blocks) polys.push({ kind: 'block', id: b.id, poly: b, localAabb: b.localAabb })
  for (const f of features) {
    if (f.kind === 'mirror') {
      const m = f as MirrorFeature
      polys.push({ kind: 'mirror', id: m.id, poly: m, localAabb: m.localAabb })
    }
  }

  const circles: Array<{ kind: SceneHit['kind']; id: number; c: Vec2; r: number; maxY: number }> = []
  const aabbs: Array<{ kind: SceneHit['kind']; id: number; minX: number; minY: number; maxX: number; maxY: number }> = []
  for (const f of features) {
    if (f.kind === 'prism') {
      const p = f as PrismFeature
      if (ignorePrismId != null && p.id === ignorePrismId) continue
      circles.push({
        kind: 'prism',
        id: p.id,
        c: { x: p.pos.x + p.cellSize * 0.5, y: p.pos.y + p.cellSize * 0.5 },
        r: p.r,
        maxY: p.pos.y + p.localAabb.maxY,
      })
    } else if (f.kind === 'blackHole') {
      const bh = f as BlackHoleFeature
      aabbs.push({
        kind: 'blackHole',
        id: bh.id,
        minX: bh.pos.x,
        minY: bh.pos.y,
        maxX: bh.pos.x + bh.cellSize,
        maxY: bh.pos.y + bh.cellSize,
      })
    }
  }

  const offsets = radius <= 0.01 ? [0] : [0, -radius, radius]
  let best: SceneHit | null = null

  // Important gameplay feel: black holes should bend light when you pass nearby, and only absorb
  // when you actually hit the 1x1 tile. Using thick-ray offsets for black holes makes them feel
  // like they "eat" the beam the moment you enter the influence radius (edge rays clip the tile).
  // So we collide black holes using the center ray only.
  const hitAabbCenter = aabbs.length ? raycastSceneAabbs(o, d, aabbs, maxDist, minT) : null

  for (const off of offsets) {
    const oo = off === 0 ? o : add(o, mul(perp, off))
    const hitPoly = polys.length ? raycastScenePolys(oo, d, polys, maxDist, minT) : null
    const hitCircle = circles.length ? raycastSceneCircles(oo, d, circles, maxDist, minT, ignorePrismId) : null
    const hitWall = bounds ? raycastSceneWalls(oo, d, bounds.w, bounds.h, maxDist, minT) : null

    let hitObj: SceneHit | null = null
    const a = hitPoly
    const b = hitCircle
    const c = hitAabbCenter
    // pick the closest among a/b/c
    hitObj = a
    if (b && (!hitObj || b.t < hitObj.t)) hitObj = b
    if (c && (!hitObj || c.t < hitObj.t)) hitObj = c
    const hit = hitObj && hitWall ? (hitObj.t <= hitWall.t ? hitObj : hitWall) : hitObj ?? hitWall
    if (!hit) continue
    if (!best || hit.t < best.t) best = hit
  }

  return best
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
  bounds?: { w: number; h: number },
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
    const hitBlock = raycastBlocks(oo, d, blocks, maxDist, minT)
    const hitWall = bounds ? raycastWalls(oo, d, bounds.w, bounds.h, maxDist, minT) : null
    const hit =
      hitBlock && hitWall ? (hitBlock.t <= hitWall.t ? hitBlock : hitWall) : hitBlock ?? hitWall
    if (!hit) continue
    if (!best || hit.t < best.t) best = hit
  }

  return best
}

const raycastWalls = (
  o: Vec2,
  d: Vec2,
  w: number,
  h: number,
  maxDist: number,
  minT: number,
): RayHit | null => {
  let bestT = Infinity
  let best: RayHit | null = null

  const consider = (t: number, nx: number, ny: number, wallId: number) => {
    if (t < minT || t > maxDist) return
    if (t >= bestT) return
    const p = add(o, mul(d, t))
    // Only accept if the point lies on-screen (with a tiny tolerance).
    const eps = 1e-3
    if (p.x < -eps || p.x > w + eps || p.y < -eps || p.y > h + eps) return
    bestT = t
    best = { t, point: p, normal: normalize({ x: nx, y: ny }), blockId: wallId }
  }

  // Left wall x=0 (normal +X)
  if (Math.abs(d.x) > 1e-9 && d.x < 0) {
    const t = (0 - o.x) / d.x
    consider(t, 1, 0, -1)
  }
  // Right wall x=w (normal -X)
  if (Math.abs(d.x) > 1e-9 && d.x > 0) {
    const t = (w - o.x) / d.x
    consider(t, -1, 0, -2)
  }
  // Top wall y=0 (normal +Y)
  if (Math.abs(d.y) > 1e-9 && d.y < 0) {
    const t = (0 - o.y) / d.y
    consider(t, 0, 1, -3)
  }
  // Bottom wall y=h (normal -Y) - the back wall behind the emitter
  if (Math.abs(d.y) > 1e-9 && d.y > 0) {
    const t = (h - o.y) / d.y
    consider(t, 0, -1, -4)
  }

  return best
}


