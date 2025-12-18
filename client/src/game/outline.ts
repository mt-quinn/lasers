import type { Vec2 } from './math'
import type { BlockCell } from './runState'

type Edge = { a: Vec2; b: Vec2 }

const key = (p: Vec2) => `${p.x},${p.y}`

// Build the directed boundary loop (clockwise, interior on the right) for a set of filled grid cells.
// Points are returned in *cell* coordinates (integers), closed (last equals first).
export const buildCellLoop = (cells: BlockCell[]): Vec2[] => {
  const filled = new Set<string>(cells.map((c) => `${c.x},${c.y}`))

  const edges: Edge[] = []
  const has = (x: number, y: number) => filled.has(`${x},${y}`)

  for (const c of cells) {
    const x = c.x
    const y = c.y
    // Top edge: (x,y)->(x+1,y) if no neighbor above
    if (!has(x, y - 1)) edges.push({ a: { x, y }, b: { x: x + 1, y } })
    // Right edge: (x+1,y)->(x+1,y+1) if no neighbor right
    if (!has(x + 1, y)) edges.push({ a: { x: x + 1, y }, b: { x: x + 1, y: y + 1 } })
    // Bottom edge: (x+1,y+1)->(x,y+1) if no neighbor below
    if (!has(x, y + 1)) edges.push({ a: { x: x + 1, y: y + 1 }, b: { x, y: y + 1 } })
    // Left edge: (x,y+1)->(x,y) if no neighbor left
    if (!has(x - 1, y)) edges.push({ a: { x, y: y + 1 }, b: { x, y } })
  }

  if (edges.length === 0) return [{ x: 0, y: 0 }]

  const byStart = new Map<string, Edge[]>()
  for (const e of edges) {
    const k = key(e.a)
    const arr = byStart.get(k)
    if (arr) arr.push(e)
    else byStart.set(k, [e])
  }

  // Find a stable start: lowest y then lowest x.
  let start = edges[0]!
  for (const e of edges) {
    if (e.a.y < start.a.y || (e.a.y === start.a.y && e.a.x < start.a.x)) start = e
  }

  const loop: Vec2[] = [start.a]
  let cur = start
  let guard = 0
  while (guard++ < edges.length + 8) {
    loop.push(cur.b)
    if (cur.b.x === loop[0]!.x && cur.b.y === loop[0]!.y) {
      break
    }
    const nextEdges = byStart.get(key(cur.b))
    if (!nextEdges || nextEdges.length === 0) break
    // For simple polyomino outer hull, there should be exactly one outgoing edge.
    cur = nextEdges[0]!
  }

  // Ensure closed.
  const first = loop[0]!
  const last = loop[loop.length - 1]!
  if (first.x !== last.x || first.y !== last.y) loop.push({ ...first })

  return loop
}

export const computeLocalAabbPx = (cells: BlockCell[], cellSize: number) => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cells) {
    minX = Math.min(minX, c.x * cellSize)
    minY = Math.min(minY, c.y * cellSize)
    maxX = Math.max(maxX, (c.x + 1) * cellSize)
    maxY = Math.max(maxY, (c.y + 1) * cellSize)
  }
  if (!Number.isFinite(minX)) minX = minY = maxX = maxY = 0
  return { minX, minY, maxX, maxY }
}


