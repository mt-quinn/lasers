import type { FrameCtx } from '../frame'
import { hexToRgb } from '../frame'
import { clamp } from '../../game/math'
import { PALETTE } from '../theme'
import { renderBoardGL } from '../boardGL'
import { buildTrenchMesh } from '../boardMesh'

// --- Board style experiment --------------------------------------------------
// `?board=shaft` swaps the synthwave wireframe board for the "machined shaft":
// interlocking floor plates with lane checkering, bulkhead ribs every 4th row,
// emissive conduit lanes that carry the music (the floor is the EQ), parapet
// walls with real height, an iris gate at the horizon, and distance fog. The
// wireframe stays the default while the new board is evaluated side by side.
const BOARD_SHAFT = (() => {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('board') === 'shaft'
  } catch {
    return false
  }
})()

// Depth-grid descent-pulse state (purely visual; module-local so the renderer
// stays stateless per-frame otherwise). A pulse is a single bright horizontal
// line that races down the grid each time the board steps down a row.
let gridSweepStart = -1
let gridLastDepth = -1

type Star = { x: number; y: number; z: number; ph: number; sp: number; mag: number; ti: number }
let starfield: Star[] | null = null
const getStarfield = (): Star[] => {
  if (!starfield) {
    starfield = []
    let s = 0x9e3779b9 >>> 0
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 4294967296
    }
    for (let i = 0; i < 200; i++) {
      const z = rnd()
      // ~7% hero stars sit noticeably brighter/larger so the field has structure
      // instead of reading as uniform noise.
      const hero = rnd() < 0.07
      const mag = hero ? 1.7 + rnd() * 1.1 : 0.55 + rnd() * 0.7
      // Mostly white, with a minority of cool and warm stars for depth/quality.
      const r = rnd()
      const ti = r < 0.68 ? 0 : r < 0.86 ? 1 : 2
      starfield.push({ x: rnd(), y: rnd(), z, ph: rnd() * 6.283, sp: 0.006 + z * 0.02, mag, ti })
    }
  }
  return starfield
}

// Soft star sprites (white / cool / warm), pre-rendered once into small offscreen
// canvases. Drawing stars as scaled sprites gives each a crisp core plus a soft
// glow at no per-frame allocation cost — far higher quality than a hard arc, and
// cheaper than building a radial gradient per star per frame.
let starSprites: HTMLCanvasElement[] | null = null
const getStarSprites = (): HTMLCanvasElement[] => {
  if (starSprites) return starSprites
  const tints: Array<[number, number, number]> = [
    [255, 255, 255], // white
    [196, 216, 255], // cool blue-white
    [255, 228, 196], // warm amber-white
  ]
  starSprites = tints.map(([r, g, b]) => {
    const c = document.createElement('canvas')
    c.width = 64
    c.height = 64
    const g2 = c.getContext('2d')!
    const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0.0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.16, `rgba(${r},${g},${b},0.9)`)
    grad.addColorStop(0.45, `rgba(${r},${g},${b},0.22)`)
    grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`)
    g2.fillStyle = grad
    g2.fillRect(0, 0, 64, 64)
    return c
  })
  return starSprites
}
export const drawBackgroundPass = (c: FrameCtx) => {
  const { ctx, s, layout, proj, project, music, mi, mBass, mPulse, mEnergy, mHue, spectrum, tNow, hsl } = c
    // ======================================================================
    // BACKGROUND — "Event-Horizon Descent". Opaque so the whole look lives on
    // the canvas (and the GL lens samples a real backdrop, not the CSS page).
    // A deliberate deep-space gradient + a corner vignette that frames the
    // shaft, plus a glowing horizon aperture where the pieces are born.
    // ======================================================================
    {
      const W = s.view.width
      const H = s.view.height

      // Framing gradient: deep blue-black void, a touch lighter toward the
      // bottom so the playfield reads as a pool of light.
      const base = ctx.createLinearGradient(0, 0, 0, H)
      base.addColorStop(0, PALETTE.voidTop)
      base.addColorStop(0.55, PALETTE.voidMid)
      base.addColorStop(1, PALETTE.voidNear)
      ctx.fillStyle = base
      ctx.fillRect(0, 0, W, H)

      // Parallax starfield drifting slowly downward through the void.
      {
        const stars = getStarfield()
        const sprites = getStarSprites()
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        for (const st of stars) {
          const xx = st.x * W
          const yy = ((st.y + tNow * st.sp) % 1) * H
          const tw = 0.5 + 0.5 * Math.sin(tNow * (0.6 + st.z) + st.ph)
          // Brighter and more legible than before, but the twinkle still pulls the
          // dimmest stars near zero so the field shimmers instead of glaring.
          const a = Math.min(0.95, (0.1 + 0.42 * st.z) * (0.4 + 0.6 * tw) * st.mag)
          const size = (1.5 + st.z * 3.4) * st.mag
          ctx.globalAlpha = a
          const sp = sprites[st.ti]
          ctx.drawImage(sp, xx - size / 2, yy - size / 2, size, size)
        }
        ctx.globalAlpha = 1
        ctx.restore()
      }

      // Corner vignette: darken the edges so the playfield reads as a pool of
      // light. Deliberate (not a faint shimmer) — pure framing, no animation.
      const vig = ctx.createRadialGradient(W * 0.5, H * 0.52, H * 0.18, W * 0.5, H * 0.52, Math.max(W, H) * 0.82)
      vig.addColorStop(0, 'rgba(0,0,0,0)')
      vig.addColorStop(0.6, 'rgba(0,0,0,0)')
      vig.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = vig
      ctx.fillRect(0, 0, W, H)

      // Horizon aperture: a soft bloom at the on-screen convergence (top of
      //    the shaft), the source the pieces emerge from. Pulses with the bass.
      // (The machined-shaft board draws its own iris gate instead.)
      if (!BOARD_SHAFT) {
        const wTop = proj.unproject(W * 0.5, 0).y
        const lx = project(0, wTop).x
        const rx = project(W, wTop).x
        const apX = (lx + rx) * 0.5
        const apY = 2
        const apR = Math.max(60, (rx - lx) * 1.05)
        const apHue = mi > 0 ? mHue : PALETTE.horizonHue
        const pulse = 0.32 + 0.5 * mBass + 0.12 * Math.sin(tNow * 0.8)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const halo = ctx.createRadialGradient(apX, apY, 0, apX, apY, apR)
        halo.addColorStop(0, hsl(apHue, 80, 70, clamp(0.38 * pulse + 0.12, 0, 0.85)))
        halo.addColorStop(0.4, hsl(apHue + 14, 78, 56, clamp(0.18 * pulse, 0, 0.5)))
        halo.addColorStop(1, hsl(apHue + 20, 70, 40, 0))
        ctx.fillStyle = halo
        ctx.beginPath()
        ctx.arc(apX, apY, apR, 0, Math.PI * 2)
        ctx.fill()
        // Bright inner seed.
        const seed = ctx.createRadialGradient(apX, apY, 0, apX, apY, apR * 0.32)
        seed.addColorStop(0, hsl(apHue, 90, 92, clamp(0.4 * pulse + 0.16, 0, 0.9)))
        seed.addColorStop(1, hsl(apHue, 85, 70, 0))
        ctx.fillStyle = seed
        ctx.beginPath()
        ctx.arc(apX, apY, apR * 0.32, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }

    // Synthwave depth grid — the shaft you descend. Thin neon lines receding to
    // a vanishing point near the top; horizontals scroll DOWNWARD to sell the
    // descent. Always present (faint, on-brand purple) and comes alive with the
    // music: rainbow hue, brighter/faster with energy, per-line spectrum glow.
    // No full-screen flashes; the only beat event is a single sweeping line.
    {
      const W = s.view.width
      // The grid is the world ground plane drawn through the SAME projection as
      // the pieces, so they are guaranteed co-perspective. Rows are spaced in
      // world px up the shaft from the near plane (emitter) toward the horizon.
      // One grid row == one piece cell so rungs line up with where pieces rest,
      // and the rungs move with the EXACT same stepped motion as the board (see
      // the gridShift below) — the pieces look bolted to the grid.
      const GRID_ROW = 40 // must match the sim's cellSize
      const ROWS = 48
      const farWorldY = proj.nearWorldY - ROWS * GRID_ROW
      const totalDepth = ROWS * GRID_ROW

      // Base look settles to on-brand purple when music is off (mi == 0); when
      // playing it leans into the live rainbow hue.
      const baseHue = PALETTE.latticeHue + (mHue - PALETTE.latticeHue) * mi
      const baseAlpha = 0.11 + mEnergy * 0.07

      // Scroll phase shared by both board styles. CRITICAL: the phase and the
      // per-row content identity must derive from the SAME continuous scroll
      // distance. Deriving the phase from (depth·row − dropAnim) but keys from
      // raw `depth` made the board's pattern teleport one row at each step and
      // slide back during the ease — the "scrolls forward, jumps back" bug.
      // `scroll` is the exact world distance travelled; `scrollSteps` is its
      // whole-row part (the key base) and `gridShift` the fractional remainder
      // (the phase). Both flip in the same instant, so bands never relabel.
      const scroll = s.depth * GRID_ROW - s.dropAnimOffset
      const scrollSteps = Math.floor(scroll / GRID_ROW)
      const gridShift = scroll - scrollSteps * GRID_ROW

      if (BOARD_SHAFT) {
        // ================== MACHINED TRENCH (?board=shaft) ==================
        // v2 — the board as a weapon trench, not a tiled floor:
        //  1. A RECESSED CENTER CHANNEL the beam fires along (the cannon's
        //     accelerator groove), cut below deck level with stepped lips.
        //  2. Flanking APRONS decked with machined plates of varying widths
        //     (1-3 segments per row, beveled edges, sheen, service lights) —
        //     believable decking instead of a checkerboard.
        //  3. RING BRACES every 4th row: chunky machined crossbeams that
        //     bridge the trench (the strongest depth cue), with glowing
        //     leading edges and wall posts.
        //  4. The music lives in the trench: left lip trim = bass, channel
        //     current = mids, right lip trim = treble, with energy packets
        //     streaming down-channel to feed the cannon. Idle baseline keeps
        //     it alive with music off.
        // Identity is keyed to (row + depth) — invariant for a material point
        // as the board scrolls — so plates/braces travel with the pieces.
        const mBeat = music.beat * mi
        // Structural identity: cold steel-blue when music is off; leans gently
        // into the live hue when playing (full rainbow stays on the emissive
        // elements, not the matter).
        const structHue = 218 + (mHue - 218) * (mi * 0.35)
        const wallHueLive = PALETTE.wallHue + (mHue - PALETTE.wallHue) * mi
        const voidC = hexToRgb(PALETTE.voidTop)
        const hash2 = (a: number, b: number) => {
          const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
          return x - Math.floor(x)
        }
        const ringAt = (rowKey: number) => ((rowKey % 4) + 4) % 4 === 0
        type Pt = { x: number; y: number }
        const quad = (a: Pt, b: Pt, c: Pt, d: Pt) => {
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.lineTo(c.x, c.y)
          ctx.lineTo(d.x, d.y)
          ctx.closePath()
        }
        // Trench cross-section (world X) and the step-down depth of the
        // channel (screen px at the near plane, scaled with distance).
        const CH_L = 0.34 * W
        const CH_R = 0.66 * W
        const LIP_H = 7

        // Spectrum thirds (bass / mids / treble) — feeds both the GL mesh's
        // emissive strips and the 2D fallback's trim lights.
        const bandFor = (k: number) => {
          const n = spectrum.length
          const s0 = Math.floor((k / 3) * n)
          const s1 = Math.max(s0 + 1, Math.floor(((k + 1) / 3) * n))
          let acc = 0
          for (let j = s0; j < s1; j++) acc += spectrum[j] ?? 0
          return (acc / (s1 - s0)) * mi
        }

        // The real 3D board: build the trench mesh (boardMesh.ts) and render
        // it through the same homography the pieces use (boardGL.ts). When
        // WebGL is unavailable the flat 2D trench below remains the fallback.
        let glBoardDrawn = false
        {
          const mesh = buildTrenchMesh({
            W,
            nearWorldY: proj.nearWorldY,
            strength: proj.strength,
            pMin: proj.pMin,
            gridRow: GRID_ROW,
            totalRows: ROWS,
            gridShift,
            depth: scrollSteps,
            structHue,
            emissiveHue: baseHue,
            wallHue: wallHueLive,
            mi,
            bands: [bandFor(0), bandFor(1), bandFor(2)],
            beat: mBeat,
            tNow,
          })
          const out = renderBoardGL(
            mesh,
            {
              cx: proj.cx,
              strength: proj.strength,
              nearWorldY: proj.nearWorldY,
              horizonY: proj.horizonY,
              span: proj.span,
              pMin: proj.pMin,
              pMax: proj.pMax,
            },
            s.view.width,
            s.view.height,
            s.view.dpr,
          )
          if (out) {
            ctx.drawImage(out, 0, 0, s.view.width, s.view.height)
            glBoardDrawn = true
          }
        }

        if (!glBoardDrawn) {
        // Visible rows near -> far, shared by every band below.
        type TrenchRow = { yTop: number; yBot: number; key: number; near: number; rowH: number }
        const rows: TrenchRow[] = []
        for (let i = 0; i < ROWS; i++) {
          const yBot = Math.min(proj.nearWorldY, proj.nearWorldY - i * GRID_ROW + gridShift)
          const yTop = proj.nearWorldY - (i + 1) * GRID_ROW + gridShift
          if (yTop >= proj.nearWorldY) continue
          const sc = project(0, yBot).scale
          if (sc < 0.05) break
          rows.push({
            yTop,
            yBot,
            key: i + scrollSteps,
            near: sc,
            rowH: project(0, yBot).y - project(0, yTop).y,
          })
        }
        // Project a channel-floor point: deck-level projection dropped by the
        // lip depth (scaled), so the channel reads as genuinely recessed.
        const chProj = (x: number, y: number) => {
          const p = project(x, y)
          return { x: p.x, y: p.y + LIP_H * p.scale, scale: p.scale }
        }

        // ---- 1. Floor (source-over): channel, aprons, lips, braces --------
        // Recessed channel floor: darker than the decks, one quad per row.
        for (const r of rows) {
          const atmos = clamp(0.1 + r.near * 1.05, 0, 1)
          const dim = 0.45 + 0.55 * r.near
          ctx.fillStyle = hsl(structHue, 36, 4.6 * dim + 0.8, atmos)
          quad(chProj(CH_L, r.yTop), chProj(CH_R, r.yTop), chProj(CH_R, r.yBot), chProj(CH_L, r.yBot))
          ctx.fill()
        }
        // Apron decking: 1-3 machined plates per row and side, widths from the
        // row hash, with bevel edges and the occasional service light.
        for (const r of rows) {
          const atmos = clamp(0.1 + r.near * 1.05, 0, 1)
          const dim = 0.45 + 0.55 * r.near
          for (const side of [0, 1]) {
            const x0 = side === 0 ? 0 : CH_R
            const x1 = side === 0 ? CH_L : W
            const nSeg = r.rowH < 4 ? 1 : 1 + Math.floor(hash2(r.key, 11 + side * 7) * 3)
            let u0 = 0
            for (let g2 = 0; g2 < nSeg; g2++) {
              const u1 =
                g2 === nSeg - 1 ? 1 : u0 + (1 - u0) * (0.3 + 0.5 * hash2(r.key, side * 31 + g2 * 13 + 3))
              const sx0 = x0 + (x1 - x0) * u0
              const sx1 = x0 + (x1 - x0) * u1
              const a = project(sx0, r.yTop)
              const b = project(sx1, r.yTop)
              const c = project(sx1, r.yBot)
              const d = project(sx0, r.yBot)
              const hv = hash2(r.key, side * 97 + g2 * 17)
              // Brushed-metal sheen drifting slowly across the deck.
              const sw = 0.5 + 0.5 * Math.sin(r.key * 0.55 + (sx0 / W) * 5 - tNow * 0.5)
              const sheen = Math.pow(sw, 6) * 2.4 * r.near
              ctx.fillStyle = hsl(structHue, 26, (7.2 + hv * 2.4 + sheen) * dim + 1.2, atmos)
              quad(a, b, c, d)
              ctx.fill()
              if (r.near > 0.3 && r.rowH >= 4) {
                // Bevel: catch-light on the far edge, shadow on the near edge.
                ctx.lineWidth = 1
                ctx.strokeStyle = hsl(structHue, 22, 34, 0.1 + 0.16 * r.near)
                ctx.beginPath()
                ctx.moveTo(a.x, a.y)
                ctx.lineTo(b.x, b.y)
                ctx.stroke()
                ctx.strokeStyle = hsl(structHue, 40, 2, 0.4 * r.near)
                ctx.beginPath()
                ctx.moveTo(d.x, d.y)
                ctx.lineTo(c.x, c.y)
                ctx.stroke()
                if (g2 > 0) {
                  // Vertical seam between adjacent plates.
                  ctx.strokeStyle = hsl(structHue, 40, 2, 0.45 * r.near)
                  ctx.beginPath()
                  ctx.moveTo(a.x, a.y)
                  ctx.lineTo(d.x, d.y)
                  ctx.stroke()
                }
              }
              u0 = u1
            }
            // Service lights: occasional tiny status LEDs on the deck.
            if (r.near > 0.35 && hash2(r.key, side * 53 + 5) < 0.22) {
              const ux = x0 + (x1 - x0) * (0.15 + 0.7 * hash2(r.key, side * 71 + 9))
              const uy = r.yTop + (r.yBot - r.yTop) * (0.25 + 0.5 * hash2(r.key, side * 41 + 4))
              const p = project(ux, uy)
              const warm = hash2(r.key, side * 23 + 8) < 0.3
              ctx.fillStyle = hsl(warm ? 38 : baseHue, 85, 62, 0.22 + 0.3 * r.near)
              ctx.beginPath()
              ctx.arc(p.x, p.y, 0.7 + 1.1 * p.scale, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
        // Step faces: continuous dark strips between deck level and channel
        // floor along both lips — the visible vertical cut of the trench.
        for (const lx of [CH_L, CH_R]) {
          const deck: Pt[] = []
          const floor2: Pt[] = []
          for (const r of rows) {
            const p = project(lx, r.yBot)
            deck.push({ x: p.x, y: p.y })
            floor2.push({ x: p.x, y: p.y + LIP_H * p.scale })
          }
          const last = rows[rows.length - 1]
          if (last) {
            const p = project(lx, last.yTop)
            deck.push({ x: p.x, y: p.y })
            floor2.push({ x: p.x, y: p.y + LIP_H * p.scale })
          }
          if (deck.length < 2) continue
          ctx.beginPath()
          ctx.moveTo(deck[0]!.x, deck[0]!.y)
          for (const p of deck) ctx.lineTo(p.x, p.y)
          for (let i = floor2.length - 1; i >= 0; i--) ctx.lineTo(floor2[i]!.x, floor2[i]!.y)
          ctx.closePath()
          ctx.fillStyle = hsl(structHue, 34, 3, 0.92)
          ctx.fill()
        }
        // Ring braces: every 4th row boundary a machined crossbeam bridges the
        // trench — drawn over channel and lips, so it visibly spans the cut.
        for (const r of rows) {
          if (!ringAt(r.key)) continue
          const yB = r.yTop
          const yT = r.yTop - 9
          const a = project(0, yT)
          const b = project(W, yT)
          const c = project(W, yB)
          const d = project(0, yB)
          if (c.scale < 0.06) continue
          ctx.fillStyle = hsl(structHue, 24, 12 * (0.5 + 0.5 * c.scale) + 1.5, clamp(0.3 + c.scale, 0, 1))
          quad(a, b, c, d)
          ctx.fill()
          ctx.lineWidth = 1
          ctx.strokeStyle = hsl(structHue, 20, 40, 0.18 + 0.25 * c.scale)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.strokeStyle = hsl(structHue, 40, 2, 0.5 * c.scale)
          ctx.beginPath()
          ctx.moveTo(d.x, d.y)
          ctx.lineTo(c.x, c.y)
          ctx.stroke()
        }

        // ---- 2. Additive pass: trench energy + brace trims -----------------
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.lineCap = 'round'
        // Lip trim lights: the trench IS the equalizer. Left lip rides the
        // bass, right lip the treble; both idle faintly with music off.
        for (const [lx, k] of [
          [CH_L, 0],
          [CH_R, 2],
        ] as Array<[number, number]>) {
          const band = bandFor(k)
          const a = project(lx, proj.nearWorldY)
          const b = project(lx, farWorldY)
          ctx.shadowColor = hsl(baseHue, 85, 62, 0.35 + band * 0.45)
          ctx.shadowBlur = 5 * band
          ctx.strokeStyle = hsl(baseHue, 75, 64, clamp(0.13 + 0.24 * band, 0, 0.5))
          ctx.lineWidth = 1.1 + band * 1.6
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.shadowBlur = 0
        }
        // Channel current (mids): a soft glow flowing down the recessed floor,
        // plus energy packets streaming toward the cannon.
        {
          const cband = bandFor(1)
          const pts: Pt[] = []
          for (const r of rows) {
            const p = chProj(W / 2, r.yBot)
            pts.push({ x: p.x, y: p.y })
          }
          if (pts.length >= 2) {
            ctx.strokeStyle = hsl(baseHue, 80, 60, clamp(0.08 + 0.2 * cband + 0.04 * mEnergy, 0, 0.42))
            ctx.lineWidth = 2.4 + 2.4 * cband
            ctx.shadowColor = hsl(baseHue, 85, 62, 0.5)
            ctx.shadowBlur = 8 * cband
            ctx.beginPath()
            ctx.moveTo(pts[0]!.x, pts[0]!.y)
            for (const p of pts) ctx.lineTo(p.x, p.y)
            ctx.stroke()
            ctx.shadowBlur = 0
          }
          for (let j = 0; j < 4; j++) {
            const u = (tNow * 0.11 + j / 4) % 1
            const p = chProj(W / 2 + Math.sin(j * 9.2) * 9, proj.nearWorldY - (1 - u) * totalDepth)
            if (p.scale < 0.07) continue
            const pa =
              (0.12 + 0.3 * cband + 0.08 * mEnergy + (mi <= 0 ? 0.08 : 0)) *
              clamp(p.scale * 1.4, 0, 1)
            ctx.fillStyle = hsl(baseHue + 10, 95, 76, clamp(pa, 0, 0.55))
            ctx.beginPath()
            ctx.arc(p.x, p.y, 0.8 + 2.6 * p.scale, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        // Brace trims: the leading edge of each ring brace glows and breathes
        // with the bass; hazard ticks mark it as machinery, not a gridline.
        for (const r of rows) {
          if (!ringAt(r.key)) continue
          const d0 = project(0, r.yTop)
          const d1 = project(W, r.yTop)
          if (d0.scale < 0.07) continue
          const g = 0.1 + d0.scale * 0.18 + mBass * 0.1 + mBeat * 0.12
          ctx.shadowColor = hsl(baseHue, 80, 60, 0.5)
          ctx.shadowBlur = 7 * d0.scale
          ctx.strokeStyle = hsl(baseHue, 65, 62, clamp(g, 0, 0.55))
          ctx.lineWidth = 1 + d0.scale * 1.6
          ctx.beginPath()
          ctx.moveTo(d0.x, d0.y)
          ctx.lineTo(d1.x, d1.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          if (d0.scale > 0.3) {
            ctx.strokeStyle = hsl(baseHue, 60, 70, 0.22 * d0.scale)
            ctx.lineWidth = 1
            for (let t = 1; t <= 7; t++) {
              const p = project((W * t) / 8, r.yTop - 4)
              const q = project((W * t) / 8, r.yTop - 9 + 4)
              ctx.beginPath()
              ctx.moveTo(p.x, p.y)
              ctx.lineTo(q.x, q.y)
              ctx.stroke()
            }
          }
        }
        ctx.restore()

        // ---- 3. Parapet walls -----------------------------------------------
        const WALL_H = 36 // wall height in screen px at the near plane
        const wallHue = PALETTE.wallHue + (mHue - PALETTE.wallHue) * mi
        for (const xw of [0, W]) {
          const edge: Array<{ x: number; y: number; s: number; key: number }> = []
          const top: Array<{ x: number; y: number; s: number; key: number }> = []
          for (let i = 0; i <= ROWS; i++) {
            const y = Math.min(proj.nearWorldY, proj.nearWorldY - i * GRID_ROW + gridShift)
            const p = project(xw, y)
            if (p.scale < 0.05) break
            // (row + depth): invariant for a material point as the board scrolls.
            edge.push({ x: p.x, y: p.y, s: p.scale, key: i + scrollSteps })
            top.push({ x: p.x, y: p.y - WALL_H * p.scale, s: p.scale, key: i + scrollSteps })
          }
          if (edge.length < 2) continue
          // Wall face: a dark machined parapet (occludes the void behind it).
          ctx.beginPath()
          ctx.moveTo(edge[0]!.x, edge[0]!.y)
          for (const p of edge) ctx.lineTo(p.x, p.y)
          for (let i = top.length - 1; i >= 0; i--) ctx.lineTo(top[i]!.x, top[i]!.y)
          ctx.closePath()
          ctx.fillStyle = hsl(structHue + 2, 30, 8, 0.94)
          ctx.fill()
          // Vertical ribs where the ring braces meet the walls.
          for (let i = 0; i < edge.length; i++) {
            if (!ringAt(edge[i]!.key)) continue
            ctx.strokeStyle = hsl(structHue, 24, 26, 0.22 + 0.4 * edge[i]!.s)
            ctx.lineWidth = 1 + edge[i]!.s
            ctx.beginPath()
            ctx.moveTo(edge[i]!.x, edge[i]!.y)
            ctx.lineTo(top[i]!.x, top[i]!.y)
            ctx.stroke()
          }
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          // Bright top rail — the lit edge the eye tracks down the shaft.
          ctx.shadowColor = hsl(wallHue, 82, 60, 0.7)
          ctx.shadowBlur = 10
          ctx.strokeStyle = hsl(wallHue, 72, 62, 0.55)
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(top[0]!.x, top[0]!.y)
          for (const p of top) ctx.lineTo(p.x, p.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          // Ring posts: at each brace the wall carries a short lit post above
          // the rail with a beacon cap — deliberate structure, not a dotted line.
          for (let i = 0; i < top.length; i++) {
            if (!ringAt(top[i]!.key)) continue
            const p = top[i]!
            const postTop = p.y - 12 * p.s
            ctx.strokeStyle = hsl(wallHue, 60, 64, clamp(0.2 + 0.4 * p.s, 0, 0.7))
            ctx.lineWidth = 1 + p.s
            ctx.beginPath()
            ctx.moveTo(p.x, p.y)
            ctx.lineTo(p.x, postTop)
            ctx.stroke()
            ctx.fillStyle = hsl(wallHue + 8, 85, 74, clamp(0.22 + p.s * 0.55 + mBeat * 0.2, 0, 0.9))
            ctx.beginPath()
            ctx.arc(p.x, postTop, 0.9 + 2.2 * p.s, 0, Math.PI * 2)
            ctx.fill()
          }
          // Faint base seam where wall meets floor.
          ctx.strokeStyle = hsl(wallHue, 50, 55, 0.16)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(edge[0]!.x, edge[0]!.y)
          for (const p of edge) ctx.lineTo(p.x, p.y)
          ctx.stroke()
          ctx.restore()
        }
        } // end 2D fallback board (!glBoardDrawn)

        // Bounce blooms: laser vertices that landed on a wall flare the surface.
        {
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          const wallTol = 2.2
          const bh = mi > 0 ? mHue : wallHueLive
          for (const seg of s.laser.segments) {
            for (const v of [seg.a, seg.b]) {
              if (v.x <= wallTol || v.x >= W - wallTol) {
                const p = project(v.x, v.y)
                const br = 6 + 11 * p.scale
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, br)
                g.addColorStop(0, hsl(bh, 95, 82, 0.5))
                g.addColorStop(1, hsl(bh, 90, 60, 0))
                ctx.fillStyle = g
                ctx.beginPath()
                ctx.arc(p.x, p.y, br, 0, Math.PI * 2)
                ctx.fill()
              }
            }
          }
          ctx.restore()
        }

        // ---- 4. Distance fog ----------------------------------------------
        {
          const apTopY = project(W / 2, farWorldY).y
          const fog = ctx.createLinearGradient(0, apTopY - 26, 0, apTopY + 100)
          fog.addColorStop(0, `rgba(${voidC.r},${voidC.g},${voidC.b},0.92)`)
          fog.addColorStop(1, `rgba(${voidC.r},${voidC.g},${voidC.b},0)`)
          ctx.fillStyle = fog
          ctx.fillRect(0, 0, W, Math.max(0, apTopY + 100))
        }

        // ---- 5. Iris gate at the horizon -----------------------------------
        // Where the pieces are born: a mechanical iris of counter-rotating arc
        // segments around a tight bloom, replacing the plain aperture glow.
        {
          const wTop = proj.unproject(W * 0.5, 0).y
          const lx = project(0, wTop).x
          const rx = project(W, wTop).x
          const apX = (lx + rx) * 0.5
          const apY = 2
          const gateR = Math.max(26, (rx - lx) * 0.5)
          const apHue = mi > 0 ? mHue : PALETTE.horizonHue
          const pulse = 0.32 + 0.5 * mBass + 0.12 * Math.sin(tNow * 0.8)
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          const halo = ctx.createRadialGradient(apX, apY, 0, apX, apY, gateR * 2.2)
          halo.addColorStop(0, hsl(apHue, 80, 72, clamp(0.3 * pulse + 0.12, 0, 0.7)))
          halo.addColorStop(0.4, hsl(apHue + 14, 78, 56, clamp(0.14 * pulse, 0, 0.4)))
          halo.addColorStop(1, hsl(apHue + 20, 70, 40, 0))
          ctx.fillStyle = halo
          ctx.beginPath()
          ctx.arc(apX, apY, gateR * 2.2, 0, Math.PI * 2)
          ctx.fill()
          ctx.lineCap = 'round'
          for (let r = 0; r < 3; r++) {
            const rad = gateR * (0.55 + r * 0.3)
            const rot = tNow * (0.12 + 0.07 * r) * (r % 2 ? -1 : 1)
            ctx.strokeStyle = hsl(
              apHue,
              75,
              66,
              (0.42 - r * 0.1) * (0.65 + 0.35 * pulse + 0.45 * mBeat),
            )
            ctx.lineWidth = 1.7 - r * 0.35
            for (let k2 = 0; k2 < 4; k2++) {
              ctx.beginPath()
              ctx.arc(apX, apY, rad, rot + (k2 * Math.PI) / 2, rot + (k2 * Math.PI) / 2 + 1.05)
              ctx.stroke()
            }
          }
          const seed = ctx.createRadialGradient(apX, apY, 0, apX, apY, gateR * 0.3)
          seed.addColorStop(0, hsl(apHue, 90, 92, clamp(0.34 * pulse + 0.14, 0, 0.8)))
          seed.addColorStop(1, hsl(apHue, 85, 70, 0))
          ctx.fillStyle = seed
          ctx.beginPath()
          ctx.arc(apX, apY, gateR * 0.3, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }

        // ---- 6. Muzzle light pool ------------------------------------------
        // The cannon's plasma throat spills a soft pool onto the nearby plates.
        {
          const ex = W / 2
          const ey = layout.emitterY
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.translate(ex, ey)
          ctx.scale(1, 0.42)
          const ph = mi > 0 ? mHue : PALETTE.horizonHue
          const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, 130)
          pool.addColorStop(0, hsl(ph, 70, 62, 0.1 + 0.06 * mPulse))
          pool.addColorStop(1, hsl(ph, 70, 50, 0))
          ctx.fillStyle = pool
          ctx.beginPath()
          ctx.arc(0, 0, 130, 0, Math.PI * 2)
          ctx.fill()
          ctx.restore()
        }
      } else {

      // Distinct "floor" beneath the grid: fill the projected ground-plane quad
      // so the shaft reads as its own surface, separate from the page background.
      // A vertical gradient sits darkest at the horizon and warms toward the
      // player; it leans into the music hue but stays subdued so lines pop.
      {
        const nl = project(0, proj.nearWorldY)
        const nr = project(W, proj.nearWorldY)
        const fl = project(0, farWorldY)
        const fr = project(W, farWorldY)
        const floor = ctx.createLinearGradient(0, fl.y, 0, nl.y)
        const floorHue = PALETTE.floorHue + (mHue - PALETTE.floorHue) * mi
        floor.addColorStop(0, hsl(floorHue + 8, 55, 6, 0.0)) // fade out at horizon
        floor.addColorStop(0.18, hsl(floorHue + 8, 58, 8, 0.55))
        floor.addColorStop(1, hsl(floorHue, 62, 13, 0.8)) // near the player
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(fl.x, fl.y)
        ctx.lineTo(fr.x, fr.y)
        ctx.lineTo(nr.x, nr.y)
        ctx.lineTo(nl.x, nl.y)
        ctx.closePath()
        ctx.fillStyle = floor
        ctx.fill()
        ctx.restore()
      }

      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.lineCap = 'round'

      // Converging vertical rails (static — they define the shaft). Each rail is
      // a constant-world-X line from the near plane to the far plane; projection
      // makes them converge toward the vanishing point.
      const COLS = 9
      for (let c = 0; c <= COLS; c++) {
        const xW = (c / COLS) * W
        const a = project(xW, proj.nearWorldY)
        const b = project(xW, farWorldY)
        ctx.strokeStyle = hsl(baseHue + (c / COLS - 0.5) * 36 * mi, 80, 62, baseAlpha * 1.25)
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Horizontal rungs locked to the board's descent (gridShift above), so the
      // rungs step and ease-in identically to the pieces instead of free-scrolling.
      for (let i = 0; i <= ROWS; i++) {
        const worldY = proj.nearWorldY - i * GRID_ROW + gridShift
        if (worldY > proj.nearWorldY) continue
        const a = project(0, worldY)
        if (a.scale < 0.04) continue
        const b = project(W, worldY)
        const depthFrac = clamp((proj.nearWorldY - worldY) / totalDepth, 0, 1) // 0 near .. 1 far
        // Per-row spectrum glow: nearer rows read more bass, far rows treble.
        const bin = Math.min(spectrum.length - 1, Math.floor(depthFrac * spectrum.length))
        const band = (spectrum[bin] ?? 0) * mi
        const near = a.scale // ~1 near .. small far
        // Atmospheric perspective: far rungs fade and desaturate toward the void
        // so the shaft reads as real receding depth, not a flat ramp.
        const atmos = 0.42 + 0.58 * near
        const alpha = clamp((baseAlpha + near * (0.06 + 0.18 * band)) * atmos, 0, 0.5)
        const lwidth = 0.8 + near * 1.4 + band * 1.6
        const sat = (82 - depthFrac * 46) + band * 10
        ctx.strokeStyle = hsl(baseHue + depthFrac * 40 * mi, sat, 58 + band * 14, alpha)
        ctx.lineWidth = lwidth
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      // Shaft walls — the bounce surfaces. The two boundaries (world x=0 and
      // x=W) become bright, lit edge rails with light nodes that scroll on the
      // descent, so the beam visibly ricochets off solid structure instead of
      // an invisible edge. Still inside the 'lighter' pass for an additive glow.
      {
        const wallHue = PALETTE.wallHue + (mHue - PALETTE.wallHue) * mi
        for (const xW of [0, W]) {
          const a = project(xW, proj.nearWorldY)
          const b = project(xW, farWorldY)
          ctx.shadowColor = hsl(wallHue, 82, 60, 0.7)
          ctx.shadowBlur = 12
          ctx.strokeStyle = hsl(wallHue, 72, 60, 0.5)
          ctx.lineWidth = 2.4
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.shadowBlur = 0
          // Light nodes at each row, brighter near the player; they scroll with
          // gridShift so the wall reads as moving with the board.
          for (let i = 0; i <= ROWS; i++) {
            const worldY = proj.nearWorldY - i * GRID_ROW + gridShift
            if (worldY > proj.nearWorldY) continue
            const p = project(xW, worldY)
            if (p.scale < 0.05) continue
            ctx.fillStyle = hsl(wallHue + 8, 85, 72, clamp(0.12 + p.scale * 0.5, 0, 0.7))
            ctx.beginPath()
            ctx.arc(p.x, p.y, 0.8 + p.scale * 2.2, 0, Math.PI * 2)
            ctx.fill()
          }
        }
        // Bounce blooms: laser vertices that landed on a wall flare the surface.
        const wallTol = 2.2
        const bh = mi > 0 ? mHue : wallHue
        for (const seg of s.laser.segments) {
          for (const v of [seg.a, seg.b]) {
            if (v.x <= wallTol || v.x >= W - wallTol) {
              const p = project(v.x, v.y)
              const br = 6 + 11 * p.scale
              const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, br)
              g.addColorStop(0, hsl(bh, 95, 82, 0.5))
              g.addColorStop(1, hsl(bh, 90, 60, 0))
              ctx.fillStyle = g
              ctx.beginPath()
              ctx.arc(p.x, p.y, br, 0, Math.PI * 2)
              ctx.fill()
            }
          }
        }
      }

      ctx.restore()
      }

      // Descent pulse: one bright rung races down the shaft (far -> near) every
      // time the board steps down a row, so the descent is unmistakably legible.
      // Triggered off depth (the canonical step counter), so it fires with or
      // without music and stays in lockstep with the pieces.
      if (s.depth !== gridLastDepth) {
        gridLastDepth = s.depth
        gridSweepStart = tNow
      }
      if (gridSweepStart >= 0) {
        const sweepDur = 0.55
        const sp = (tNow - gridSweepStart) / sweepDur
        if (sp >= 0 && sp < 1) {
          const surge = clamp(s.crescendo, 0, 1)
          // Accelerate toward the player so it reads as "falling" with the board.
          const ease = sp * sp
          const worldY = farWorldY + ease * (proj.nearWorldY - farWorldY)
          const a = project(0, worldY)
          const b = project(W, worldY)
          const fade = 1 - sp
          const hue = mi > 0 ? mHue + 12 : baseHue
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          ctx.shadowColor = hsl(hue, 95, 70, 0.9)
          ctx.shadowBlur = 14 * a.scale + 5
          ctx.strokeStyle = hsl(hue, 95, 75, clamp(0.42 + (0.5 + 0.4 * surge) * fade, 0, 0.98))
          ctx.lineWidth = (1.8 + 3.4 * a.scale) * (1 + 0.7 * surge)
          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
          ctx.restore()
        } else if (sp >= 1) {
          gridSweepStart = -1
        }
      }
    }

    // Fail line: a charged danger threshold. A faint dashed baseline is always
    // present; an amber glow ignites and pulses as the nearest piece nears it.
    const failY = layout.failY
    {
      // Fail-grace alarm: while a block sits past the line (one descent step
      // from ending the run) the threshold goes to a fast, full-strength
      // strobe so the player KNOWS they're in the grace window.
      const graceArmed = s.failGraceDepth >= 0 && !s.gameOver
      let danger = graceArmed ? 1 : 0
      for (const b of s.blocks) {
        const by = b.pos.y - s.dropAnimOffset - b.dropAnimExtra + b.localAabb.maxY
        danger = Math.max(danger, 1 - clamp((failY - by) / 160, 0, 1))
      }
      const fa = project(0, failY)
      const fb = project(s.view.width, failY)
      const pulse = graceArmed ? 0.45 + 0.55 * Math.sin(tNow * 12) : 0.6 + 0.4 * Math.sin(tNow * 4)
      const DH = PALETTE.dangerHue // reserved danger red
      ctx.save()
      ctx.lineCap = 'round'
      // Danger glow (additive), intensity + blur ride the proximity pulse.
      ctx.globalCompositeOperation = 'lighter'
      ctx.shadowColor = hsl(DH, 100, 55, 0.85)
      ctx.shadowBlur = 5 + 18 * danger * pulse
      ctx.strokeStyle = hsl(DH, 100, 62, clamp(0.16 + 0.6 * danger, 0, 0.95))
      ctx.lineWidth = 2 + 2.4 * danger
      ctx.beginPath()
      ctx.moveTo(fa.x, fa.y)
      ctx.lineTo(fb.x, fb.y)
      ctx.stroke()
      ctx.shadowBlur = 0
      // Dashed baseline so the boundary is legible even at zero danger.
      ctx.globalCompositeOperation = 'source-over'
      ctx.setLineDash([8, 10])
      ctx.strokeStyle = hsl(DH, 85, 70, 0.42)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(fa.x, fa.y)
      ctx.lineTo(fb.x, fb.y)
      ctx.stroke()
      ctx.setLineDash([])
      // End notches anchor the threshold to the walls.
      ctx.fillStyle = hsl(DH, 95, 66, clamp(0.4 + 0.5 * danger, 0, 1))
      for (const e of [fa, fb]) {
        ctx.beginPath()
        ctx.arc(e.x, e.y, 3, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

}
