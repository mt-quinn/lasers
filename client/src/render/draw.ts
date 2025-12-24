import { XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR } from '../game/runState'
import type { RunState } from '../game/runState'
import type { Vec2 } from '../game/math'
import { clamp } from '../game/math'
import { getArenaLayout } from '../game/layout'
// (getRarityColor will be used by the level-up menu overlay; keep renderer lean for now.)

const withDpr = (ctx: CanvasRenderingContext2D, dpr: number, fn: () => void) => {
  ctx.save()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  fn()
  ctx.restore()
}

const drawRoundedPolyomino = (ctx: CanvasRenderingContext2D, loop: Vec2[], pos: Vec2, cellSize: number, rPx: number) => {
  if (loop.length < 3) return

  // Convert loop points to world px.
  const pts: Vec2[] = loop.map((p) => ({
    x: pos.x + p.x * cellSize,
    y: pos.y + p.y * cellSize,
  }))

  // Ensure closed.
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  if (first.x !== last.x || first.y !== last.y) pts.push({ ...first })

  const n = pts.length
  const m = Math.max(0, n - 1) // unique vertices
  const r = clamp(rPx, 0, cellSize * 0.5 - 0.6)

  const dir = (a: Vec2, b: Vec2): Vec2 => {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    return { x: dx / l, y: dy / l }
  }

  const cross = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x

  const isConvex = (i: number) => {
    if (m < 3) return false
    const prev = pts[((i - 1 + m) % m)]!
    const cur = pts[i % m]!
    const next = pts[((i + 1) % m)]!
    const inD = dir(prev, cur)
    const outD = dir(cur, next)
    return cross(inD, outD) > 0.5
  }

  ctx.beginPath()

  // Start at first point, possibly offset if convex.
  let p0 = pts[0]!
  let p1 = pts[1]!
  let d01 = dir(p0, p1)
  const startCut = isConvex(0) ? r : 0
  const start = { x: p0.x + d01.x * startCut, y: p0.y + d01.y * startCut }
  ctx.moveTo(start.x, start.y)

  for (let i = 0; i < m; i++) {
    const a = pts[i]!
    const b = pts[i + 1]!
    const d = dir(a, b)
    const segLen = Math.hypot(b.x - a.x, b.y - a.y)
    const cutA = isConvex(i) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const cutB = isConvex(i + 1) ? Math.min(r, segLen * 0.5 - 0.6) : 0
    const a2 = { x: a.x + d.x * cutA, y: a.y + d.y * cutA }
    const b2 = { x: b.x - d.x * cutB, y: b.y - d.y * cutB }
    ctx.lineTo(b2.x, b2.y)

    // Arc at vertex b if convex.
    if (isConvex(i + 1)) {
      const inD = d
      const outD = dir(b, pts[((i + 2) % m)]!)
      const center = {
        x: b.x - inD.x * r + outD.x * r,
        y: b.y - inD.y * r + outD.y * r,
      }
      const startAng = Math.atan2((b.y - inD.y * r) - center.y, (b.x - inD.x * r) - center.x)
      const endAng = Math.atan2((b.y + outD.y * r) - center.y, (b.x + outD.x * r) - center.x)
      ctx.arc(center.x, center.y, r, startAng, endAng, false)
    }
  }

  ctx.closePath()
}

const hexToRgb = (hex: string) => {
  const h = hex.replace('#', '').trim()
  const v = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t

const lerpColor = (a: string, b: string, t: number) => {
  const c0 = hexToRgb(a)
  const c1 = hexToRgb(b)
  const r = Math.round(lerp(c0.r, c1.r, t))
  const g = Math.round(lerp(c0.g, c1.g, t))
  const b2 = Math.round(lerp(c0.b, c1.b, t))
  return `rgb(${r} ${g} ${b2})`
}

// Health gradient: high HP is cooler/lighter; low HP is warmer/more urgent.
// This fits the existing purple/pink scheme while remaining readable.
const healthFill = (hpPct: number) => {
  const t = clamp(hpPct, 0, 1)
  // Stops (low -> high):
  const c0 = '#ff3b5c' // low: hot red
  const c1 = '#ff6bd6' // mid-low: neon pink
  const c2 = '#c7a2ff' // mid-high: lilac
  const c3 = '#e7ddff' // high: icy lavender
  if (t < 0.33) return lerpColor(c0, c1, t / 0.33)
  if (t < 0.66) return lerpColor(c1, c2, (t - 0.33) / 0.33)
  return lerpColor(c2, c3, (t - 0.66) / 0.34)
}

const relativeLuma = (cssRgb: string) => {
  // cssRgb is "rgb(r g b)" from lerpColor; parse quickly.
  const m = cssRgb.match(/rgb\((\d+)\s+(\d+)\s+(\d+)\)/)
  if (!m) return 1
  const r = Number(m[1]) / 255
  const g = Number(m[2]) / 255
  const b = Number(m[3]) / 255
  // sRGB luminance approximation
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

const pickHpAnchor = (s: RunState, b: RunState['blocks'][number]) => {
  // Use cached inside-the-shape anchor, then apply the "slide up as it becomes visible" rule.
  const target = { x: b.pos.x + b.hpAnchorLocalPx.x, y: b.pos.y + b.hpAnchorLocalPx.y }

  const pieceTop = b.pos.y + b.localAabb.minY
  const pieceBottom = b.pos.y + b.localAabb.maxY
  const visibleTop = 0
  const visibleBottom = s.view.height

  const visiblePieceTop = Math.max(pieceTop, visibleTop)
  const visiblePieceBottom = Math.min(pieceBottom, visibleBottom)
  const pieceH = Math.max(1, pieceBottom - pieceTop)
  const visibleFrac = clamp((visiblePieceBottom - visiblePieceTop) / pieceH, 0, 1)

  const pad = 10
  const yBottomVisible = visiblePieceBottom - pad
  const t = Math.pow(visibleFrac, 2.2)
  const y = lerp(yBottomVisible, target.y, t)

  // Clamp inside the piece's AABB (conservative walls clamp).
  const left = b.pos.x + b.localAabb.minX + pad
  const right = b.pos.x + b.localAabb.maxX - pad
  const top = Math.max(visibleTop + pad, b.pos.y + b.localAabb.minY + pad)
  const bottom = b.pos.y + b.localAabb.maxY - pad
  return { x: clamp(target.x, left, right), y: clamp(y, top, bottom) }
}

export const drawFrame = (canvas: HTMLCanvasElement, s: RunState) => {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const dpr = s.view.dpr
  withDpr(ctx, dpr, () => {
    ctx.clearRect(0, 0, s.view.width, s.view.height)
    const layout = getArenaLayout(s.view)
    const roundedRectPath = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2))
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + w, y, x + w, y + h, rr)
      ctx.arcTo(x + w, y + h, x, y + h, rr)
      ctx.arcTo(x, y + h, x, y, rr)
      ctx.arcTo(x, y, x + w, y, rr)
      ctx.closePath()
    }
    const applyDomedDepth = (ax: number, ay: number, w: number, h: number, strength: number) => {
      // “Pressed pill” look: depth comes from lighting/shadow *on the face* only.
      // No drop shadow, no thick rim strokes—just clipped gradients.
      const s01 = clamp(strength, 0, 1)
      const r = Math.max(w, h) * 0.95

      ctx.save()
      ctx.clip()

      // Broad highlight (top-left)
      ctx.globalCompositeOperation = 'screen'
      const hi = ctx.createRadialGradient(ax + w * 0.28, ay + h * 0.22, 0, ax + w * 0.28, ay + h * 0.22, r)
      hi.addColorStop(0, `rgba(255,255,255,${0.34 * s01})`)
      hi.addColorStop(0.35, `rgba(255,255,255,${0.14 * s01})`)
      hi.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = hi
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      // Soft shadow falloff (bottom-right)
      ctx.globalCompositeOperation = 'multiply'
      const sh = ctx.createRadialGradient(ax + w * 0.80, ay + h * 0.86, 0, ax + w * 0.80, ay + h * 0.86, r)
      sh.addColorStop(0, `rgba(0,0,0,${0.30 * s01})`)
      sh.addColorStop(0.55, `rgba(0,0,0,${0.10 * s01})`)
      sh.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = sh
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      // Edge vignette (darken near edges slightly to sell curvature without a “stroke”)
      ctx.globalCompositeOperation = 'multiply'
      const cx = ax + w * 0.5
      const cy = ay + h * 0.5
      const edge = ctx.createRadialGradient(cx, cy, Math.max(4, r * 0.22), cx, cy, r * 0.98)
      edge.addColorStop(0, 'rgba(0,0,0,0)')
      edge.addColorStop(0.72, 'rgba(0,0,0,0)')
      edge.addColorStop(1, `rgba(0,0,0,${0.16 * s01})`)
      ctx.fillStyle = edge
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      // Small specular “pill shine” streak (very subtle, keeps it tactile)
      ctx.globalCompositeOperation = 'screen'
      const sx = ax + w * 0.30
      const sy = ay + h * 0.26
      const sw = w * 0.55
      const shh = Math.max(10, h * 0.18)
      const sheen = ctx.createLinearGradient(sx, sy, sx + sw, sy + shh)
      sheen.addColorStop(0, 'rgba(255,255,255,0)')
      sheen.addColorStop(0.35, `rgba(255,255,255,${0.11 * s01})`)
      sheen.addColorStop(0.7, 'rgba(255,255,255,0)')
      ctx.fillStyle = sheen
      ctx.fillRect(ax - 2, ay - 2, w + 4, h + 4)

      ctx.restore()
    }

    // Arena glow vignette.
    const grd = ctx.createRadialGradient(
      s.view.width * 0.5,
      s.view.height * 0.35,
      40,
      s.view.width * 0.5,
      s.view.height * 0.5,
      Math.max(s.view.width, s.view.height) * 0.75,
    )
    grd.addColorStop(0, 'rgba(160,120,255,0.10)')
    grd.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = grd
    ctx.fillRect(0, 0, s.view.width, s.view.height)

    // Fail line: keep it tight to the bottom to maximize board height.
    const railY = layout.railY
    const failY = layout.failY
    ctx.strokeStyle = 'rgba(255,220,180,0.18)'
    ctx.lineWidth = 2
    ctx.setLineDash([8, 10])
    ctx.beginPath()
    ctx.moveTo(0, failY)
    ctx.lineTo(s.view.width, failY)
    ctx.stroke()
    ctx.setLineDash([])

    // Blocks (base render; HP text is drawn at the very end so it stays above glow/laser).
    for (const b of s.blocks) {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const glow = 0.35 + 0.65 * (1 - hpPct)

      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      const fillBase = healthFill(hpPct)
      const lum = relativeLuma(fillBase)
      ctx.shadowColor = `rgba(255,120,210,${0.14 * glow})`
      ctx.shadowBlur = 18 * glow

      drawRoundedPolyomino(ctx, b.loop, b.pos, b.cellSize, b.cornerRadius)

      // Solid fill (health gradient is applied as a per-piece color, not as an internal gradient).
      ctx.fillStyle = fillBase
      ctx.fill()

      // Tactile depth: make blocks read as slightly domed/protruding.
      {
        const ax = b.pos.x + b.localAabb.minX
        const ay = b.pos.y + b.localAabb.minY
        const w = b.localAabb.maxX - b.localAabb.minX
        const h = b.localAabb.maxY - b.localAabb.minY
        // Strong but still “face-only” so it reads like a pressed, domed pill.
        applyDomedDepth(ax, ay, w, h, 1.0)
      }

      ctx.lineWidth = 2
      ctx.strokeStyle = lum > 0.62 ? 'rgba(40,18,60,0.70)' : 'rgba(255,245,220,0.35)'
      ctx.stroke()
      ctx.restore()
    }

    // Melt-on-death FX: the block turns red-hot and squishes (gravity) into the XP particle.
    if (s.meltFx.length > 0) {
      const smoothstep = (x: number) => {
        const t = clamp(x, 0, 1)
        return t * t * (3 - 2 * t)
      }
      const drawSmoothClosed = (pts: Vec2[]) => {
        if (pts.length < 3) return
        // If closed (last == first), drop the duplicate.
        const p0 = pts[0]!
        const pn = pts[pts.length - 1]!
        const arr =
          Math.abs(pn.x - p0.x) < 1e-6 && Math.abs(pn.y - p0.y) < 1e-6 ? pts.slice(0, -1) : pts
        const n = arr.length
        if (n < 3) return
        const mid = (a: Vec2, b: Vec2) => ({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 })
        const m0 = mid(arr[0]!, arr[1]!)
        ctx.beginPath()
        ctx.moveTo(m0.x, m0.y)
        for (let i = 1; i < n; i++) {
          const a = arr[i]!
          const b = arr[(i + 1) % n]!
          const m = mid(a, b)
          ctx.quadraticCurveTo(a.x, a.y, m.x, m.y)
        }
        // close via first vertex
        const mEnd = mid(arr[0]!, arr[1]!)
        ctx.quadraticCurveTo(arr[0]!.x, arr[0]!.y, mEnd.x, mEnd.y)
        ctx.closePath()
      }
      for (const fx of s.meltFx) {
        const p = clamp(fx.t / Math.max(0.0001, fx.dur), 0, 1)
        const e = smoothstep(p)

        const ax0 = fx.pos.x + fx.localAabb.minX
        const ay0 = fx.pos.y + fx.localAabb.minY
        const w0 = fx.localAabb.maxX - fx.localAabb.minX
        const h0 = fx.localAabb.maxY - fx.localAabb.minY
        const cx0 = ax0 + w0 * 0.5

        // Keep the melt/orb the exact "dead piece" red (healthFill(0) == #ff3b5c).
        // No hue shift during the melt—only shape changes.
        const molten = 'rgb(255 59 92)'

        // Single-shape morph (no fades, no separate puddle/orb draw):
        // - Early: gravity sag + pooling deformation (stronger near the bottom).
        // - Late: smoothly morph into a circle at orbFrom with the same radius as the XP orb.
        const phase1End = 0.78
        const a = smoothstep(p / phase1End) // pooling/sag amount
        const c = smoothstep((p - phase1End) / (1 - phase1End)) // circle morph amount

        const top0 = ay0
        const bottom0 = ay0 + h0
        const wob = Math.sin(fx.seed + fx.t * 7.5)

        const ptsWorld: Vec2[] = fx.loop.map((q) => ({
          x: fx.pos.x + q.x * fx.cellSize,
          y: fx.pos.y + q.y * fx.cellSize,
        }))
        const ptsWarp: Vec2[] = []
        let minX = Infinity,
          minY = Infinity,
          maxX = -Infinity,
          maxY = -Infinity
        const R = 5 // must match XP orb fly radius

        // 1) Warp points with a gravity + pooling field.
        for (const pt of ptsWorld) {
          const v = clamp((pt.y - top0) / Math.max(1, h0), 0, 1) // 0 top -> 1 bottom
          const dy = bottom0 - pt.y
          const edge01 = clamp(Math.abs(pt.x - cx0) / Math.max(1, w0 * 0.5), 0, 1)

          // Compress upper mass downward (sag), much less at the bottom so it "piles up".
          const compress = 1 - a * 0.80 * Math.pow(1 - v, 1.7)
          let y1 = bottom0 - dy * compress
          // Downward drift: affects edges too so horizontal surfaces don't only divot in the middle.
          y1 += a * 0.07 * h0 * Math.pow(v, 2.2) * (0.65 + 0.35 * edge01)

          // Spread more near the bottom (puddle) + a bit of viscous lateral slop.
          // Additionally, cantilevered parts (high + far from center) should flow inward as they melt
          // instead of "dripping" straight down as thin strings.
          const spread = 1 + a * (0.55 * v * v) + a * 0.06 * wob * Math.pow(v, 2.8)

          // Inward reflow is strongest for points that are:
          // - higher up (1 - v)
          // - further from center (edge01)
          // This helps overhangs collapse back toward the body of the piece.
          const inward = a * 0.62 * Math.pow(1 - v, 1.55) * Math.pow(edge01, 1.35)
          const spreadAdj = Math.max(0.15, spread * (1 - inward))

          let x1 = cx0 + (pt.x - cx0) * spreadAdj
          x1 += a * 6.5 * wob * (1 - v) * 0.25

          ptsWarp.push({ x: x1, y: y1 })
        }

        // 2) Viscosity smoothing to combat “balloon animal” pinches (diffuses sharp necks).
        // This keeps thin connectors from collapsing into single vertices with long smooth curves.
        if (ptsWarp.length >= 6) {
          const iters = 2
          const k = 0.22
          for (let it = 0; it < iters; it++) {
            const next: Vec2[] = []
            for (let i = 0; i < ptsWarp.length; i++) {
              const prev = ptsWarp[(i - 1 + ptsWarp.length) % ptsWarp.length]!
              const cur = ptsWarp[i]!
              const nxt = ptsWarp[(i + 1) % ptsWarp.length]!
              next.push({
                x: cur.x + k * ((prev.x + nxt.x) * 0.5 - cur.x),
                y: cur.y + k * ((prev.y + nxt.y) * 0.5 - cur.y),
              })
            }
            for (let i = 0; i < ptsWarp.length; i++) ptsWarp[i] = next[i]!
          }

          // Extra mild “nub killer” near the end: remove tiny protrusions without changing the overall melt.
          // Only activates late to avoid over-smoothing the early recognizable silhouette.
          const nub = smoothstep((p - 0.68) / 0.32)
          if (nub > 0.001) {
            const n = ptsWarp.length
            const extraIters = nub > 0.85 ? 2 : 1
            const kk = 0.10 + 0.10 * nub
            const minEdge = Math.max(1.2, fx.cellSize * 0.06)
            for (let it = 0; it < extraIters; it++) {
              const next: Vec2[] = []
              for (let i = 0; i < n; i++) {
                const prev = ptsWarp[(i - 1 + n) % n]!
                const cur = ptsWarp[i]!
                const nxt = ptsWarp[(i + 1) % n]!
                const lp = Math.hypot(cur.x - prev.x, cur.y - prev.y)
                const ln = Math.hypot(nxt.x - cur.x, nxt.y - cur.y)
                // Only damp when we see very short edges (typical nub signature).
                const w = clamp((minEdge - Math.min(lp, ln)) / minEdge, 0, 1) * nub
                const kLocal = kk * (0.25 + 0.75 * w)
                next.push({
                  x: cur.x + kLocal * ((prev.x + nxt.x) * 0.5 - cur.x),
                  y: cur.y + kLocal * ((prev.y + nxt.y) * 0.5 - cur.y),
                })
              }
              for (let i = 0; i < n; i++) ptsWarp[i] = next[i]!
            }
          }
        }

        // 3) Late circle morph: preserve perimeter order using arclength parameterization.
        // Mapping by polar angle can reorder points and self-intersect (the “inside-out” artifact).
        //
        // Also apply a mild late-stage "surface tension" smoothing in *radius-vs-parameter* space.
        // This specifically combats small lobes/nubbins ("balloon animal" artifacts) that show up
        // near the end (e.g. the T-piece smile + corner blobs).
        //
        // Finally, enforce a consistent "ground plane" (bottom) reference to avoid any perceived
        // rotation: anchor the parameter start at the bottom-most point, and use a fixed downward
        // angle as the phase reference.
        const ptsM: Vec2[] = []
        if (ptsWarp.length >= 3) {
          // Center for radius smoothing: use centroid of the warped loop so the blob stays coherent.
          let cxx = 0
          let cyy = 0
          for (const q of ptsWarp) {
            cxx += q.x
            cyy += q.y
          }
          cxx /= ptsWarp.length
          cyy /= ptsWarp.length

          // Rotate the loop so index 0 is the bottom-most point (stable "ground" anchor).
          let i0 = 0
          let bestY = -Infinity
          let bestDx = Infinity
          for (let i = 0; i < ptsWarp.length; i++) {
            const q = ptsWarp[i]!
            const dx = Math.abs(q.x - cx0)
            if (q.y > bestY + 0.001 || (Math.abs(q.y - bestY) <= 0.001 && dx < bestDx)) {
              bestY = q.y
              bestDx = dx
              i0 = i
            }
          }
          const pts = ptsWarp.slice(i0).concat(ptsWarp.slice(0, i0))

          let total = 0
          const cum: number[] = [0]
          for (let i = 1; i < pts.length; i++) {
            const a0 = pts[i - 1]!
            const b0 = pts[i]!
            total += Math.hypot(b0.x - a0.x, b0.y - a0.y)
            cum.push(total)
          }
          // close
          total += Math.hypot(pts[0]!.x - pts[pts.length - 1]!.x, pts[0]!.y - pts[pts.length - 1]!.y)
          const inv = 1 / Math.max(1e-6, total)

          // Angle parameterization is based on perimeter order (t), not geometric angle.
          // Use a fixed downward phase so the blob doesn't "rotate" as it melts.
          const baseAng = Math.PI / 2

          // Late-stage surface tension: smooth radius along the loop parameter.
          const tension = smoothstep((p - 0.62) / 0.28)
          const n = pts.length
          const tParam: number[] = new Array(n)
          const angParam: number[] = new Array(n)
          for (let i = 0; i < n; i++) {
            const tt = (cum[i]! * inv) % 1
            tParam[i] = tt
            angParam[i] = baseAng + tt * Math.PI * 2
          }
          const radii: number[] = new Array(n)
          for (let i = 0; i < n; i++) {
            const dx = pts[i]!.x - cxx
            const dy = pts[i]!.y - cyy
            radii[i] = Math.hypot(dx, dy)
          }
          if (tension > 0.001 && n >= 6) {
            const iters = tension > 0.82 ? 3 : 2
            const alpha = 0.35 * tension
            let r = radii
            for (let it = 0; it < iters; it++) {
              const next = new Array(n)
              for (let i = 0; i < n; i++) {
                const rm1 = r[(i - 1 + n) % n]!
                const r0 = r[i]!
                const rp1 = r[(i + 1) % n]!
                const avg = (rm1 + 2 * r0 + rp1) / 4
                // Stronger smoothing on the *upper* surfaces to remove lingering sag-divots.
                // With baseAng=pi/2, "top" is around ang=-pi/2 (sin is -1).
                const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
                // Increase smoothing as it progresses; reduce slightly once fully circle-morphing.
                const aLocal = alpha * (1 + 0.95 * top01) * (0.8 + 0.2 * (1 - c))
                next[i] = lerp(r0, avg, aLocal)
              }
              r = next
            }
            // Clamp high-frequency bumps AND divots.
            // Max clamp kills tiny lobes; min clamp fills in sharp concave dents that can persist as it shrinks.
            const capHi = Math.max(0.75, fx.cellSize * 0.08) * (1 - 0.35 * c)
            // Keep the allowed "divot depth" quite small on the upper surfaces; otherwise you get
            // those unnatural V-notches that become more pronounced as the blob shrinks.
            const capLoBase = Math.max(0.30, fx.cellSize * 0.04) * (1 - 0.35 * c)
            for (let i = 0; i < n; i++) {
              const rm1 = r[(i - 1 + n) % n]!
              const r0 = r[i]!
              const rp1 = r[(i + 1) % n]!
              const base = (rm1 + rp1) * 0.5
              const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
              const capLo = capLoBase * (1 + 1.55 * top01)
              if (r0 > base + capHi) r[i] = base + capHi
              if (r[i]! < base - capLo) r[i] = base - capLo
            }

            // Explicitly fill persistent V-divots on the upper arc by biasing radii upward
            // toward the neighbor baseline (surface tension "rounds out" dents).
            // This prevents top dents from sharpening as the blob shrinks.
            const fill = smoothstep((p - 0.50) / 0.40) * (1 - 0.15 * c)
            if (fill > 0.001) {
              const passIters = fill > 0.8 ? 2 : 1
              for (let it = 0; it < passIters; it++) {
                const next = r.slice()
                for (let i = 0; i < n; i++) {
                  const top01 = clamp((-Math.sin(angParam[i]!)) * 0.5 + 0.5, 0, 1)
                  if (top01 < 0.55) continue
                  const rm1 = r[(i - 1 + n) % n]!
                  const r0 = r[i]!
                  const rp1 = r[(i + 1) % n]!
                  const base = (rm1 + rp1) * 0.5
                  // If we're below the baseline (a divot), push up strongly.
                  if (r0 < base) {
                    const k = fill * (0.45 + 0.55 * top01)
                    next[i] = lerp(r0, base, k)
                  }
                }
                r = next
              }
            }
            for (let i = 0; i < n; i++) radii[i] = r[i]!
          }

          for (let i = 0; i < pts.length; i++) {
            const t = tParam[i]!
            const ang = angParam[i]!
            // Use the smoothed radius to build a single-lobed blob, then morph to the final circle.
            const bx = cxx + Math.cos(ang) * radii[i]!
            const by = cyy + Math.sin(ang) * radii[i]!
            const tx = fx.orbFrom.x + Math.cos(ang) * R
            const ty = fx.orbFrom.y + Math.sin(ang) * R
            const x2 = lerp(bx, tx, c)
            const y2 = lerp(by, ty, c)
            ptsM.push({ x: x2, y: y2 })
            minX = Math.min(minX, x2)
            minY = Math.min(minY, y2)
            maxX = Math.max(maxX, x2)
            maxY = Math.max(maxY, y2)
          }
        }

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.shadowColor = 'rgba(255,80,80,0.14)'
        ctx.shadowBlur = 12 * (1 - c)
        drawSmoothClosed(ptsM)
        ctx.fillStyle = molten
        ctx.fill()
        ctx.shadowBlur = 0

        // Face lighting + molten flow (clipped) for the whole morph.
        const bbW = Math.max(1, maxX - minX)
        const bbH = Math.max(1, maxY - minY)
        applyDomedDepth(minX, minY, bbW, bbH, 1.0)

        ctx.save()
        ctx.clip()
        ctx.globalCompositeOperation = 'screen'
        const tt = fx.t * 2.3 + fx.seed
        const bandH = Math.max(10, bbH * 0.28)
        for (let k = 0; k < 3; k++) {
          const yy = minY + ((tt * 34 + k * bandH * 1.25) % (bbH + bandH)) - bandH
          const band = ctx.createLinearGradient(minX, yy, minX, yy + bandH)
          band.addColorStop(0, 'rgba(255,255,255,0)')
          band.addColorStop(0.5, `rgba(255,255,255,${0.10 * (1 - c)})`)
          band.addColorStop(1, 'rgba(255,255,255,0)')
          ctx.fillStyle = band
          ctx.fillRect(minX - 2, yy, bbW + 4, bandH)
        }
        ctx.restore()

        ctx.restore()
      }
    }

    // Board features: mirrors / prisms / black holes (indestructible, no HP numbers).
    if (s.features.length > 0) {
      for (const f of s.features) {
        // Skip if fully above the screen (matches the "not shootable until visible" vibe visually too).
        const maxY = f.pos.y + f.localAabb.maxY
        if (maxY < 0) continue

        if (f.kind === 'mirror') {
          const m = f
          const ax = m.pos.x + m.localAabb.minX
          const ay = m.pos.y + m.localAabb.minY
          const w = m.localAabb.maxX - m.localAabb.minX
          const h = m.localAabb.maxY - m.localAabb.minY

          ctx.save()
          ctx.globalCompositeOperation = 'source-over'
          ctx.shadowColor = 'rgba(180,220,255,0.20)'
          ctx.shadowBlur = 14

          drawRoundedPolyomino(ctx, m.loop, m.pos, m.cellSize, m.cornerRadius)

          const grad = ctx.createLinearGradient(ax, ay, ax + w, ay + h)
          grad.addColorStop(0, 'rgb(60 75 105)')
          grad.addColorStop(0.45, 'rgb(145 170 210)')
          grad.addColorStop(1, 'rgb(55 65 90)')
          ctx.fillStyle = grad
          ctx.fill()

          // Tactile depth on mirrors too (face-only).
          applyDomedDepth(ax, ay, w, h, 0.78)

          // Important: confine the shadow glow to the *fill* only.
          // Leaving shadowBlur on will make the outline/top edge read as a thick horizontal glare band.
          ctx.shadowBlur = 0
          ctx.shadowColor = 'rgba(0,0,0,0)'

          // Specular diagonal sheen lines.
          ctx.save()
          ctx.clip()
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'
          ctx.lineWidth = 3
          const step = 16
          for (let x = -h; x < w + h; x += step) {
            ctx.beginPath()
            ctx.moveTo(ax + x, ay)
            ctx.lineTo(ax + x + h, ay + h)
            ctx.stroke()
          }
          ctx.restore()

          // Outline (must redraw path; the sheen loop overwrote the current path).
          drawRoundedPolyomino(ctx, m.loop, m.pos, m.cellSize, m.cornerRadius)
          ctx.lineWidth = 2
          ctx.strokeStyle = 'rgba(245,250,255,0.35)'
          ctx.stroke()

          ctx.restore()
          continue
        }

        if (f.kind === 'prism') {
          const p = f
          const cx = p.pos.x + p.cellSize * 0.5
          const cy = p.pos.y + p.cellSize * 0.5
          const r = p.r

          // Prism visual: prioritize glyph legibility. Use a darker crystal body + a subtle dark
          // readability disc behind the glyph, then render the glyph with a dark outline + bright stroke.

          // Soft outer halo (keeps the "special" read without washing out the glyph).
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.fillStyle = 'rgba(80,180,255,0.08)'
          ctx.beginPath()
          ctx.arc(cx, cy, r * 2.0, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()

          ctx.save()
          ctx.globalCompositeOperation = 'source-over'

          // Dark crystal sphere (less bright-on-bright).
          const grd = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r)
          grd.addColorStop(0, 'rgba(235,250,255,0.55)')
          grd.addColorStop(0.35, 'rgba(70,140,190,0.45)')
          grd.addColorStop(1, 'rgba(10,25,40,0.55)')
          ctx.fillStyle = grd
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.fill()

          // Rim
          ctx.strokeStyle = 'rgba(255,255,255,0.18)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
          ctx.stroke()

          // Readability disc behind glyph.
          ctx.fillStyle = 'rgba(0,0,0,0.22)'
          ctx.beginPath()
          ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2)
          ctx.fill()

          // Exit-direction glyph: render relative to a fixed "forward" axis (up).
          const exits: number[] = Array.isArray((p as any).exitsDeg) ? (p as any).exitsDeg : [45, -45]
          const base = { x: 0, y: -1 }
          const toRad = (deg: number) => (deg * Math.PI) / 180
          const rot = (v: Vec2, rad: number): Vec2 => {
            const c = Math.cos(rad)
            const sn = Math.sin(rad)
            return { x: v.x * c - v.y * sn, y: v.x * sn + v.y * c }
          }
          const rayLen = r * 0.88
          const headLen = r * 0.20
          const headAng = Math.PI / 7 // ~25deg

          const drawGlyphPass = (strokeStyle: string, lineWidth: number) => {
            ctx.strokeStyle = strokeStyle
            ctx.lineWidth = lineWidth
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'
            for (const deg of exits) {
              const d = rot(base, toRad(deg))
              const ex = cx + d.x * rayLen
              const ey = cy + d.y * rayLen
              ctx.beginPath()
              ctx.moveTo(cx, cy)
              ctx.lineTo(ex, ey)

              // arrowhead
              const back = { x: -d.x, y: -d.y }
              const left = rot(back, headAng)
              const right = rot(back, -headAng)
              ctx.moveTo(ex, ey)
              ctx.lineTo(ex + left.x * headLen, ey + left.y * headLen)
              ctx.moveTo(ex, ey)
              ctx.lineTo(ex + right.x * headLen, ey + right.y * headLen)
              ctx.stroke()
            }
          }

          // Outline then bright stroke for legibility on any background.
          drawGlyphPass('rgba(0,0,0,0.55)', 6)
          drawGlyphPass('rgba(245,255,255,0.92)', 2.8)

          // Center dot to anchor the glyph.
          ctx.fillStyle = 'rgba(245,255,255,0.65)'
          ctx.beginPath()
          ctx.arc(cx, cy, Math.max(1.4, r * 0.11), 0, Math.PI * 2)
          ctx.fill()

          ctx.restore()
          continue
        }

        // black hole
        const bh = f
        const cx = bh.pos.x + bh.cellSize * 0.5
        const cy = bh.pos.y + bh.cellSize * 0.5
        const rCore = bh.rCore
        const rInf = bh.rInfluence

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'

        // Subtle influence boundary (helps players read gravity radius).
        // Drawn behind the core effects and kept very faint.
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.strokeStyle = 'rgba(255,190,120,0.08)'
        ctx.lineWidth = 1.5
        ctx.setLineDash([6, 10])
        ctx.beginPath()
        ctx.arc(cx, cy, rInf, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
        // very soft outer haze ring
        const haze = ctx.createRadialGradient(cx, cy, rInf * 0.92, cx, cy, rInf)
        haze.addColorStop(0, 'rgba(255,190,120,0)')
        haze.addColorStop(1, 'rgba(255,120,210,0.05)')
        ctx.fillStyle = haze
        ctx.beginPath()
        ctx.arc(cx, cy, rInf, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()

        // Dark core
        ctx.fillStyle = 'rgba(5,3,10,0.95)'
        ctx.beginPath()
        ctx.arc(cx, cy, rCore, 0, Math.PI * 2)
        ctx.fill()

        // Accretion ring (neon edge)
        ctx.globalCompositeOperation = 'lighter'
        const ringR = rCore * 1.35
        const ring = ctx.createRadialGradient(cx, cy, rCore * 0.85, cx, cy, ringR)
        ring.addColorStop(0, 'rgba(0,0,0,0)')
        ring.addColorStop(0.55, 'rgba(255,120,210,0.08)')
        ring.addColorStop(0.78, 'rgba(255,190,120,0.18)')
        ring.addColorStop(1, 'rgba(255,120,210,0)')
        ctx.fillStyle = ring
        ctx.beginPath()
        ctx.arc(cx, cy, ringR, 0, Math.PI * 2)
        ctx.fill()

        // Subtle lens sparkle
        ctx.strokeStyle = 'rgba(255,255,255,0.10)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(cx, cy, rCore * 0.85, 0, Math.PI * 2)
        ctx.stroke()

        ctx.restore()
      }
    }

    // HUD module: bottom-right L-shape (single container + single outline).
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    const xpFrac = clamp(s.xp / Math.max(1, s.xpCap), 0, 1)
    // Countdown: full -> empty as we approach the next drop.
    const dropRemain = clamp(s.dropTimerSec / Math.max(0.001, s.dropIntervalSec), 0, 1)

    // Geometry: union shape = vertical bar (xp) + horizontal cap (stats), with a dial in the elbow.
    const barX = gx
    const barY = gy
    const barW = gw
    const barH = gh
    const cutRight = s.view.width
    const cutBottom = layout.failY
    const bottomY = barY + barH
    // Horizontal leg height: just enough for inline stats with padding.
    const capH = 36
    // Wider horizontal leg so DPS/♥ can sit further left with the same left padding.
    const capW = 184
    const capX = barX + barW - capW
    const capY = bottomY - capH
    const dialD = 38
    const dialR = dialD / 2
    const dialCX = barX + barW - dialR - 8
    const dialCY = bottomY - dialR - 8
    // Leave a little more breathing room above the dial intrusion.
    const dialTop = dialCY - dialR - 14

    const lPath = (outerR: number) => {
      const r = outerR
      const vx0 = barX
      // Extend beyond the right edge so rounding gets clipped into a flat edge.
      const vx1 = cutRight + r
      const vy0 = barY
      // Extend beyond the death line so rounding gets clipped into a flat edge.
      const vy1 = cutBottom + r
      const hx0 = capX
      const hy0 = capY
      // "Skin bulge" around the dial: round the inner corner using an arc around the dial center.
      const bulgeR = dialR + 9

      ctx.beginPath()
      ctx.moveTo(vx1 - r, vy0)
      ctx.arcTo(vx1, vy0, vx1, vy0 + r, r)
      ctx.lineTo(vx1, vy1 - r)
      ctx.arcTo(vx1, vy1, vx1 - r, vy1, r)
      ctx.lineTo(hx0 + r, vy1)
      ctx.arcTo(hx0, vy1, hx0, vy1 - r, r)
      ctx.lineTo(hx0, hy0 + r)
      ctx.arcTo(hx0, hy0, hx0 + r, hy0, r)
      // Inner elbow: replace sharp corner with a circular intrusion so the dial feels like it's
      // pushing out the skin of the HUD, while keeping consistent padding.
      const dy = hy0 - dialCY
      const dx = vx0 - dialCX
      const canBulge = bulgeR * bulgeR > dy * dy && bulgeR * bulgeR > dx * dx
      if (canBulge) {
        const xJoin = dialCX - Math.sqrt(Math.max(0, bulgeR * bulgeR - dy * dy))
        const yJoin = dialCY - Math.sqrt(Math.max(0, bulgeR * bulgeR - dx * dx))
        // Join from horizontal top edge to arc start.
        ctx.lineTo(xJoin, hy0)
        const a0 = Math.atan2(hy0 - dialCY, xJoin - dialCX)
        const a1 = Math.atan2(yJoin - dialCY, vx0 - dialCX)
        // Sweep through the upper-left quadrant around the dial.
        ctx.arc(dialCX, dialCY, bulgeR, a0, a1, true)
        ctx.lineTo(vx0, yJoin)
      } else {
        ctx.lineTo(vx0, hy0)
      }
      ctx.lineTo(vx0, vy0 + r)
      ctx.arcTo(vx0, vy0, vx0 + r, vy0, r)
      ctx.closePath()
    }

    // Single container fill + single outline (no overlapping boxes), clipped to:
    // - right edge of the screen
    // - bottom edge at the death line
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.beginPath()
    ctx.rect(0, 0, cutRight, cutBottom)
    ctx.clip()
    const outerR = 18
    const bg = ctx.createLinearGradient(0, barY, 0, bottomY)
    bg.addColorStop(0, 'rgba(12, 10, 28, 0.62)')
    bg.addColorStop(1, 'rgba(10, 8, 22, 0.48)')
    ctx.fillStyle = bg
    lPath(outerR)
    ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'
    ctx.lineWidth = 1.5
    lPath(outerR)
    ctx.stroke()
    ctx.restore()

    // XP groove + fill (kept above the dial so nothing overlaps).
    {
      const gx2 = barX + 7
      // More top padding so the XP track doesn't feel jammed against the top of the container.
      const gy2 = barY + 18
      const gw2 = barW - 14
      const gh2 = Math.max(26, dialTop - gy2)
      const groove = ctx.createLinearGradient(0, gy2, 0, gy2 + gh2)
      groove.addColorStop(0, 'rgba(0,0,0,0.38)')
      groove.addColorStop(1, 'rgba(255,255,255,0.05)')
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = groove
      roundedRectPath(gx2, gy2, gw2, gh2, 10)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      roundedRectPath(gx2, gy2, gw2, gh2, 10)
      ctx.stroke()

      const fh = gh2 * xpFrac
      ctx.globalCompositeOperation = 'lighter'
      ctx.fillStyle = 'rgba(255,120,210,0.22)'
      roundedRectPath(gx2, gy2 + (gh2 - fh), gw2, fh, 10)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,120,210,0.75)'
      roundedRectPath(gx2 + 1, gy2 + (gh2 - fh) + 1, gw2 - 2, Math.max(0, fh - 2), 9)
      ctx.fill()

      // XP counter centered in the groove (so it doesn't collide with the dial).
      ctx.globalCompositeOperation = 'source-over'
      const label = `${Math.floor(s.xp)}/${s.xpCap}`
      ctx.font = "950 13px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const tx = barX + barW / 2
      const ty = gy2 + gh2 * 0.55
      const tw = ctx.measureText(label).width
      ctx.fillStyle = 'rgba(0,0,0,0.22)'
      roundedRectPath(tx - tw / 2 - 8, ty - 10, tw + 16, 20, 10)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1
      roundedRectPath(tx - tw / 2 - 8, ty - 10, tw + 16, 20, 10)
      ctx.stroke()
      ctx.fillStyle = 'rgba(255,246,213,0.92)'
      ctx.fillText(label, tx, ty)
      ctx.restore()
    }

    // Corner dial: depth + drop countdown (disc) (sits in the elbow, no overlap).
    {
      const cx = dialCX
      const cy = dialCY
      const rr = dialR
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      const disc = ctx.createRadialGradient(cx, cy, 1, cx, cy, rr)
      disc.addColorStop(0, 'rgba(0,0,0,0.12)')
      disc.addColorStop(1, 'rgba(0,0,0,0.28)')
      ctx.fillStyle = disc
      ctx.beginPath()
      ctx.arc(cx, cy, rr, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.lineWidth = 1.5
      ctx.stroke()

      ctx.globalCompositeOperation = 'lighter'
      const start = -Math.PI / 2
      const end = start - Math.PI * 2 * dropRemain
      const fill = ctx.createRadialGradient(cx, cy, 1, cx, cy, rr)
      fill.addColorStop(0, 'rgba(255,120,210,0.50)')
      fill.addColorStop(0.86, 'rgba(255,120,210,0.50)')
      fill.addColorStop(1, 'rgba(255,120,210,0.32)')
      ctx.fillStyle = fill
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.arc(cx, cy, rr - 1, end, start, false)
      ctx.closePath()
      ctx.fill()

      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "950 13px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,246,213,0.95)'
      ctx.fillText(`${s.depth}`, cx, cy + 0.5)
      ctx.restore()
    }

    // Stats text in the horizontal leg (left of dial), inline (not stacked).
    {
      const insetL = capX + 10
      const insetR = dialCX - dialR - 10
      const tx = (insetL + insetR) / 2
      const ty = capY + capH / 2 + 0.5
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,246,213,0.94)'
      const left = `DPS ${Math.round(s.stats.dps)}`
      const right = `♥ ${s.lives}/3`
      ctx.font = "900 13px 'Oxanium', system-ui, sans-serif"
      const gap = 14
      const wL = ctx.measureText(left).width
      const wR = ctx.measureText(right).width
      const total = wL + gap + wR
      const x0 = tx - total / 2
      ctx.fillText(left, x0 + wL / 2, ty)
      ctx.fillText(right, x0 + wL + gap + wR / 2, ty)
      ctx.restore()
    }

    // Best depth readout (only if a local best exists). Updates live when current depth exceeds it.
    if (s.bestDepthLocal > 0) {
      const bestLive = Math.max(s.bestDepthLocal, s.depth)
      const label = `BEST: ${bestLive}`
      // Position per reference: just above the horizontal leg, tucked near the right HUD module.
      const x = barX - 10
      const y = capY - 14
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "950 14px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.fillStyle = 'rgba(255,246,213,0.92)'
      ctx.fillText(label, x, y)
      ctx.restore()
    }

    // XP orbs (condense -> fly).
    if (s.xpOrbs.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const orb of s.xpOrbs) {
        const p =
          orb.phase === 'condense'
            ? orb.from
            : {
                x: orb.from.x + (orb.to.x - orb.from.x) * Math.pow(clamp(orb.t / XP_ORB_FLY_DUR, 0, 1), 0.75),
                y: orb.from.y + (orb.to.y - orb.from.y) * Math.pow(clamp(orb.t / XP_ORB_FLY_DUR, 0, 1), 0.75),
              }
        const r = orb.phase === 'condense' ? 16 * (1 - clamp(orb.t / XP_ORB_CONDENSE_DUR, 0, 1)) + 4 : 5
        // Keep orb color the exact "dead piece" red (no hue shift).
        ctx.fillStyle = 'rgba(255,59,92,0.32)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = 'rgba(255,59,92,0.92)'
        ctx.beginPath()
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // Welding hit FX: glow + sparks at beam contact points.
    if (s.weldGlows.length > 0 || s.sparks.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'

      // Glows (radial gradients)
      for (const g of s.weldGlows) {
        const b = s.blocks.find((bb) => bb.id === g.blockId)
        const t = clamp(g.age / Math.max(0.0001, g.life), 0, 1)
        const aBase = (1 - t) * (0.35 + 0.55 * g.intensity)
        const a = b ? aBase : aBase * 0.22

        // Smaller, metal-like hot spot. Growth should be mostly inside the piece.
        const r0 = 1.5 + 2.2 * g.intensity
        const baseInside = 9 + 13 * g.intensity
        const rInside = baseInside * (g.bloom || 1)

        const gradInside = ctx.createRadialGradient(g.x, g.y, r0, g.x, g.y, rInside)
        // Heated metal: white-hot core -> orange -> deep red edge.
        gradInside.addColorStop(0, `rgba(255,255,255,${0.95 * a})`)
        gradInside.addColorStop(0.22, `rgba(255,210,120,${0.78 * a})`)
        gradInside.addColorStop(0.55, `rgba(255,120,40,${0.55 * a})`)
        gradInside.addColorStop(0.9, `rgba(255,45,25,${0.28 * a})`)
        gradInside.addColorStop(1, 'rgba(255,35,25,0)')

        if (b) {
          ctx.save()
          // Clip glow to the block shape so it reads like the metal is glowing.
          drawRoundedPolyomino(ctx, b.loop, b.pos, b.cellSize, b.cornerRadius)
          ctx.clip()
          ctx.fillStyle = gradInside
          ctx.beginPath()
          ctx.arc(g.x, g.y, rInside, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }

        // Subtle external halo (reduced outside-piece glow; NOT scaled by bloom).
        const rHalo = baseInside + 6 + 4 * g.intensity
        const gradHalo = ctx.createRadialGradient(g.x, g.y, baseInside * 0.6, g.x, g.y, rHalo)
        gradHalo.addColorStop(0, `rgba(255,150,60,${0.07 * a})`)
        gradHalo.addColorStop(0.6, `rgba(255,60,40,${0.035 * a})`)
        gradHalo.addColorStop(1, 'rgba(255,60,40,0)')
        ctx.fillStyle = gradHalo
        ctx.beginPath()
        ctx.arc(g.x, g.y, rHalo, 0, Math.PI * 2)
        ctx.fill()
      }

      // Sparks
      for (const p of s.sparks) {
        const t = clamp(p.age / Math.max(0.0001, p.life), 0, 1)
        const a = (1 - t) * (0.45 + 0.65 * p.heat)
        // "hot metal" spark color shifts from white -> yellow -> orange/pink
        const c0 = `rgba(255,252,240,${0.95 * a})`
        const c1 = `rgba(255,210,140,${0.75 * a})`
        const c2 = `rgba(255,120,210,${0.35 * a})`

        const tail = 0.018 + 0.022 * p.heat
        const x0 = p.x - p.vx * tail
        const y0 = p.y - p.vy * tail

        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(1, p.size)
        ctx.strokeStyle = c2
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(p.x, p.y)
        ctx.stroke()

        ctx.lineWidth = Math.max(0.8, p.size * 0.65)
        ctx.strokeStyle = c1
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(p.x, p.y)
        ctx.stroke()

        ctx.fillStyle = c0
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(0.9, p.size * 0.55), 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()
    }

    // Laser segments.
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    // IMPORTANT: draw contiguous segments as a single polyline so we don't get bright "striations"
    // at every vertex (per-segment round caps overlap heavily, especially on curved black-hole arcs).
    const stitched: Array<{ pts: Vec2[]; intensity: number }> = []
    const eps2 = 0.9 * 0.9
    const intEps = 0.035
    for (const seg of s.laser.segments) {
      const dx = seg.b.x - seg.a.x
      const dy = seg.b.y - seg.a.y
      if (dx * dx + dy * dy < 0.0001) continue

      const last = stitched[stitched.length - 1]
      if (last) {
        const p = last.pts[last.pts.length - 1]!
        const dxa = seg.a.x - p.x
        const dya = seg.a.y - p.y
        const canJoin = dxa * dxa + dya * dya <= eps2 && Math.abs(last.intensity - seg.intensity) <= intEps
        if (canJoin) {
          last.pts.push(seg.b)
          continue
        }
      }
      stitched.push({ pts: [seg.a, seg.b], intensity: seg.intensity })
    }

    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    const pathLen = (pts: Vec2[]) => {
      let L = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!
        const b = pts[i]!
        L += Math.hypot(b.x - a.x, b.y - a.y)
      }
      return L
    }

    const pointAndTanAt = (pts: Vec2[], dist: number): { p: Vec2; tan: Vec2 } | null => {
      if (pts.length < 2) return null
      let acc = 0
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1]!
        const b = pts[i]!
        const segL = Math.hypot(b.x - a.x, b.y - a.y)
        if (segL <= 1e-6) continue
        if (acc + segL >= dist) {
          const t = clamp((dist - acc) / segL, 0, 1)
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
          const inv = 1 / segL
          const tan = { x: (b.x - a.x) * inv, y: (b.y - a.y) * inv }
          return { p, tan }
        }
        acc += segL
      }
      // Past the end: return last segment tangent.
      const a = pts[pts.length - 2]!
      const b = pts[pts.length - 1]!
      const segL = Math.hypot(b.x - a.x, b.y - a.y) || 1
      return { p: { ...b }, tan: { x: (b.x - a.x) / segL, y: (b.y - a.y) / segL } }
    }

    for (let li = 0; li < stitched.length; li++) {
      const line = stitched[li]!
      const alpha = clamp(line.intensity, 0, 1)
      if (alpha <= 0) continue

      // Build path once.
      ctx.beginPath()
      ctx.moveTo(line.pts[0]!.x, line.pts[0]!.y)
      for (let i = 1; i < line.pts.length; i++) ctx.lineTo(line.pts[i]!.x, line.pts[i]!.y)

      // Laser palette: darker reticle-red, with a warm core.
      // (Reticle uses reds; keep this cohesive and more dangerous-looking.)
      // outer glow
      ctx.strokeStyle = `rgba(255,60,60,${0.16 * alpha})`
      ctx.lineWidth = s.stats.beamGlowWidth
      ctx.stroke()

      // core (restroke same path)
      ctx.strokeStyle = `rgba(255,90,90,${0.78 * alpha})`
      ctx.lineWidth = s.stats.beamWidth
      ctx.stroke()

      // Animated pulse streak: a white scanline (perpendicular to the beam) that travels forward.
      const L = pathLen(line.pts)
      if (L > 6) {
        const speedPxPerSec = 410
        const spacing = 240 // distance between pulses on long beams
        const base = (s.timeSec * speedPxPerSec + li * 37) % (spacing * 4)
        const pulses = Math.max(1, Math.min(3, Math.floor(L / spacing)))
        for (let k = 0; k < pulses; k++) {
          const d = (base + k * spacing) % L
          const pt = pointAndTanAt(line.pts, d)
          if (!pt) continue
          const perp = { x: -pt.tan.y, y: pt.tan.x }
          // Streak length should match the *core* beam width (not the outer glow).
          const half = s.stats.beamWidth * 0.52
          const a0 = pt.p
          const a1 = { x: a0.x - perp.x * half, y: a0.y - perp.y * half }
          const a2 = { x: a0.x + perp.x * half, y: a0.y + perp.y * half }

          // Thin crisp white streak (no wide glow band).
          ctx.strokeStyle = `rgba(255,255,255,${0.55 * alpha})`
          ctx.lineWidth = Math.max(3.2, s.stats.beamWidth * 0.84)
          ctx.beginPath()
          ctx.moveTo(a1.x, a1.y)
          ctx.lineTo(a2.x, a2.y)
          ctx.stroke()
        }
      }
    }
    ctx.restore()

    // Slider rail + emitter (at bottom, above safe-area). Draw *after* the laser so the emitter sits on top.
    {
      const railX = 16
      const railW = s.view.width - 32
      const railH = layout.railH
      const railR = railH / 2

      // Outer rail body
      ctx.save()
      const railGrad = ctx.createLinearGradient(0, railY, 0, railY + railH)
      railGrad.addColorStop(0, 'rgba(255,255,255,0.06)')
      railGrad.addColorStop(0.5, 'rgba(0,0,0,0.22)')
      railGrad.addColorStop(1, 'rgba(0,0,0,0.34)')
      ctx.fillStyle = railGrad
      roundedRectPath(railX, railY, railW, railH, railR)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.14)'
      ctx.lineWidth = 2
      ctx.stroke()

      // Inner groove
      const groovePad = 3
      const grooveH = Math.max(6, railH - 6)
      const grooveY = railY + (railH - grooveH) / 2
      const grooveR = grooveH / 2
      const grooveGrad = ctx.createLinearGradient(0, grooveY, 0, grooveY + grooveH)
      grooveGrad.addColorStop(0, 'rgba(0,0,0,0.38)')
      grooveGrad.addColorStop(1, 'rgba(255,255,255,0.05)')
      ctx.fillStyle = grooveGrad
      roundedRectPath(railX + groovePad, grooveY, railW - groovePad * 2, grooveH, grooveR)
      ctx.fill()
      ctx.restore()

      // Emitter knob (slider handle)
      const knobR = 13
      const knobX = s.emitter.pos.x
      const knobY = s.emitter.pos.y
      ctx.save()
      ctx.shadowColor = 'rgba(255,120,210,0.45)'
      ctx.shadowBlur = 18
      const knobGrad = ctx.createRadialGradient(
        knobX - knobR * 0.35,
        knobY - knobR * 0.45,
        2,
        knobX,
        knobY,
        knobR * 1.25,
      )
      knobGrad.addColorStop(0, 'rgba(255,255,255,0.95)')
      knobGrad.addColorStop(0.55, 'rgba(255,245,200,0.92)')
      knobGrad.addColorStop(1, 'rgba(180,150,255,0.70)')
      ctx.fillStyle = knobGrad
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(knobX, knobY, knobR, 0, Math.PI * 2)
      ctx.stroke()

      // Grip lines
      ctx.strokeStyle = 'rgba(0,0,0,0.26)'
      ctx.lineWidth = 1.5
      for (let i = -1; i <= 1; i++) {
        const xx = knobX + i * 3.5
        ctx.beginPath()
        ctx.moveTo(xx, knobY - 6)
        ctx.lineTo(xx, knobY + 6)
        ctx.stroke()
      }
      ctx.restore()

      // Tutorial label: persists until the player moves the emitter.
      if (!s.tutorialMovedEmitter) {
        const pulse = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(s.timeSec * 3.1))
        const label = 'Move Laser ↔'
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.font = "800 12px 'Oxanium', system-ui, sans-serif"
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const padX = 10
        const textW = ctx.measureText(label).width
        const boxW = Math.ceil(textW + padX * 2)
        const boxH = 22
        const boxX = knobX - boxW / 2
        const boxY = knobY - knobR - 10 - boxH
        ctx.globalAlpha = pulse
        ctx.shadowColor = 'rgba(255,120,210,0.35)'
        ctx.shadowBlur = 14
        ctx.fillStyle = 'rgba(10, 8, 22, 0.72)'
        roundedRectPath(boxX, boxY, boxW, boxH, 10)
        ctx.fill()
        ctx.shadowBlur = 0
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'
        ctx.lineWidth = 2
        roundedRectPath(boxX, boxY, boxW, boxH, 10)
        ctx.stroke()
        ctx.fillStyle = 'rgba(255,246,213,0.98)'
        ctx.fillText(label, knobX, boxY + boxH / 2)
        ctx.restore()
      }
    }

    // Aim reticle: draw late (above weld glow) and auto-darken when bright welding glow is behind it.
    {
      const rx = s.reticle.x
      const ry = s.reticle.y
      const pulse = 0.55 + 0.45 * Math.sin(s.timeSec * 5.2)
      const retScale = 0.75
      const retOuterR = (22 + pulse * 1.2) * retScale
      const retInnerR = 8.5 * retScale

      // Estimate "backlight" from nearby weld glows.
      let back = 0
      if (s.weldGlows.length > 0) {
        for (const g of s.weldGlows) {
          const tt = clamp(g.age / Math.max(0.0001, g.life), 0, 1)
          const a = (1 - tt) * (0.35 + 0.55 * g.intensity)
          const baseInside = 9 + 13 * g.intensity
          const rInside = baseInside * (g.bloom || 1)
          const rr = rInside + 18
          const dx = rx - g.x
          const dy = ry - g.y
          const d2 = dx * dx + dy * dy
          if (d2 > rr * rr) continue
          const d = Math.sqrt(d2)
          back += a * (1 - d / rr)
        }
      }
      back = clamp(back * 1.6, 0, 1)
      const darkMode = back > 0.22
      const aScale = darkMode ? 0.55 : 1

      // Dark underlay (improves legibility against bright additive glows).
      if (darkMode) {
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = `rgba(0,0,0,${0.62 * back})`
        ctx.lineWidth = 6
        ctx.beginPath()
        ctx.arc(rx, ry, retOuterR, 0, Math.PI * 2)
        ctx.stroke()
        ctx.lineWidth = 5
        const arm = retOuterR + 10 * retScale
        const innerStop = retInnerR + 2 * retScale
        ctx.beginPath()
        ctx.moveTo(rx - arm, ry)
        ctx.lineTo(rx - innerStop, ry)
        ctx.moveTo(rx + innerStop, ry)
        ctx.lineTo(rx + arm, ry)
        ctx.moveTo(rx, ry - arm)
        ctx.lineTo(rx, ry - innerStop)
        ctx.moveTo(rx, ry + innerStop)
        ctx.lineTo(rx, ry + arm)
        ctx.stroke()
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = darkMode ? 'source-over' : 'lighter'
      ctx.lineCap = 'round'

      // Red glow halo (reduced when backlit).
      ctx.strokeStyle = `rgba(255, 60, 60, ${(0.18 + pulse * 0.08) * aScale * 0.65})`
      ctx.lineWidth = 9
      ctx.beginPath()
      ctx.arc(rx, ry, retOuterR, 0, Math.PI * 2)
      ctx.stroke()

      // Outer ring with quadrant gaps (classic scope feel)
      ctx.strokeStyle = `rgba(255, 80, 80, ${0.85 * aScale})`
      ctx.lineWidth = 2.25
      const gap = Math.PI / 10
      for (let q = 0; q < 4; q++) {
        const a0 = q * (Math.PI / 2) + gap
        const a1 = (q + 1) * (Math.PI / 2) - gap
        ctx.beginPath()
        ctx.arc(rx, ry, retOuterR, a0, a1)
        ctx.stroke()
      }

      // Crosshair lines (stop short of center ring)
      const arm = retOuterR + 10 * retScale
      const innerStop = retInnerR + 2 * retScale
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.9 * aScale})`
      ctx.lineWidth = 2
      ctx.beginPath()
      // horizontal
      ctx.moveTo(rx - arm, ry)
      ctx.lineTo(rx - innerStop, ry)
      ctx.moveTo(rx + innerStop, ry)
      ctx.lineTo(rx + arm, ry)
      // vertical
      ctx.moveTo(rx, ry - arm)
      ctx.lineTo(rx, ry - innerStop)
      ctx.moveTo(rx, ry + innerStop)
      ctx.lineTo(rx, ry + arm)
      ctx.stroke()

      // Tick marks along crosshair (small, tight, and contained within the outer ring)
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.7 * aScale})`
      ctx.lineWidth = 1.4
      const tickStep = 4 * retScale
      const tickLen = 2.5 * retScale
      const tickInset = 4 * retScale
      const maxTicks = Math.max(0, Math.min(4, Math.floor((retOuterR - tickInset - innerStop) / tickStep)))
      for (let i = 1; i <= maxTicks; i++) {
        const dx = innerStop + i * tickStep
        ctx.beginPath()
        ctx.moveTo(rx - dx, ry - tickLen)
        ctx.lineTo(rx - dx, ry + tickLen)
        ctx.moveTo(rx + dx, ry - tickLen)
        ctx.lineTo(rx + dx, ry + tickLen)
        ctx.stroke()
      }
      for (let i = 1; i <= maxTicks; i++) {
        const dy = innerStop + i * tickStep
        ctx.beginPath()
        ctx.moveTo(rx - tickLen, ry - dy)
        ctx.lineTo(rx + tickLen, ry - dy)
        ctx.moveTo(rx - tickLen, ry + dy)
        ctx.lineTo(rx + tickLen, ry + dy)
        ctx.stroke()
      }

      // Center ring + dot
      ctx.strokeStyle = `rgba(255, 120, 120, ${0.9 * aScale})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(rx, ry, retInnerR, 0, Math.PI * 2)
      ctx.stroke()

      ctx.fillStyle = `rgba(255, 210, 210, ${0.95 * aScale})`
      ctx.beginPath()
      ctx.arc(rx, ry, 1.7, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
    }

    // HP text last so it stays readable above welding glow + sparks + laser.
    for (const b of s.blocks) {
      const hpPct = clamp(b.hp / b.hpMax, 0, 1)
      const fillBase = healthFill(hpPct)
      const lum = relativeLuma(fillBase)

      const anchor = pickHpAnchor(s, b)
      const cx = anchor.x
      const cy = anchor.y
      ctx.font = '900 18px Nunito'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const darkText = lum > 0.55
      ctx.fillStyle = darkText ? 'rgba(10,5,18,0.92)' : 'rgba(255,248,230,0.95)'
      ctx.strokeStyle = darkText ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
      ctx.lineWidth = 3
      const label = String(Math.max(0, Math.ceil(b.hp)))
      ctx.strokeText(label, cx, cy)
      ctx.fillText(label, cx, cy)
    }

    // Life loss presentation: board wipe + banner (run continues).
    if (s.lifeLossFx) {
      const t = s.lifeLossFx.t
      const wipeDur = s.lifeLossFx.wipeDur
      const bannerDur = s.lifeLossFx.bannerDur

      // Wipe: a bright scan band that moves top->bottom, "vaporizing" the board.
      const p = clamp(t / Math.max(0.001, wipeDur), 0, 1)
      if (p < 1) {
        const y = p * s.view.height
        const band = 90
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const grad = ctx.createLinearGradient(0, y - band, 0, y + band)
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(0.35, 'rgba(255,80,120,0.10)')
        grad.addColorStop(0.5, 'rgba(255,240,220,0.18)')
        grad.addColorStop(0.65, 'rgba(255,80,120,0.10)')
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.fillRect(0, y - band, s.view.width, band * 2)

        // subtle trailing vignette above the band so the wipe reads as an event.
        const haze = ctx.createLinearGradient(0, 0, 0, y)
        haze.addColorStop(0, 'rgba(0,0,0,0)')
        haze.addColorStop(1, 'rgba(0,0,0,0.10)')
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = haze
        ctx.fillRect(0, 0, s.view.width, y)
        ctx.restore()
      }

      // Banner: "LIFE LOST" + remaining lives.
      const bt = clamp(t / Math.max(0.001, bannerDur), 0, 1)
      const fadeIn = clamp(bt / 0.12, 0, 1)
      const fadeOut = clamp((1 - bt) / 0.25, 0, 1)
      const a = fadeIn * fadeOut
      if (a > 0.001) {
        const cx = s.view.width * 0.5
        const cy = s.view.height * 0.32
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'

        // Panel
        ctx.fillStyle = `rgba(0,0,0,${0.35 * a})`
        const w = Math.min(320, s.view.width - 44)
        const h = 72
        const x = cx - w / 2
        const y = cy - h / 2
        ctx.beginPath()
        const r = 14
        ctx.moveTo(x + r, y)
        ctx.arcTo(x + w, y, x + w, y + h, r)
        ctx.arcTo(x + w, y + h, x, y + h, r)
        ctx.arcTo(x, y + h, x, y, r)
        ctx.arcTo(x, y, x + w, y, r)
        ctx.closePath()
        ctx.fill()

        // Accent line
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = `rgba(255,80,120,${0.45 * a})`
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(x + 18, y + 14)
        ctx.lineTo(x + w - 18, y + 14)
        ctx.stroke()
        ctx.restore()

        // Text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = `rgba(255,245,235,${0.95 * a})`
        ctx.font = '900 18px Oxanium'
        ctx.fillText('LIFE LOST', cx, cy - 10)
        ctx.fillStyle = `rgba(255,210,210,${0.75 * a})`
        ctx.font = '800 13px Nunito'
        ctx.fillText(`${s.lifeLossFx.livesAfter}/3 lives remaining`, cx, cy + 14)

        ctx.restore()
      }
    }
  })
}


