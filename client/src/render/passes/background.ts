import type { FrameCtx } from '../frame'
import { hexToRgb } from '../frame'
import { clamp } from '../../game/math'
import { PALETTE } from '../theme'
import { renderBoardGL } from '../boardGL'
import { buildTrenchMesh } from '../boardMesh'


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
  const { ctx, s, layout, proj, project, music, mi, mBass, mPulse, mHue, spectrum, tNow, hsl } = c
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

    }

    // ======================================================================
    // BOARD — the machined trench, rendered as real 3D geometry through the
    // same homography as the pieces (boardMesh.ts builds the mesh, boardGL.ts
    // shades it: recessed accelerator channel, plated aprons, ring braces,
    // and raised MIRROR parapet walls with chamfered lips — the surfaces the
    // beam visibly bounces off). Distance fog, the iris gate where pieces are
    // born, and the muzzle light pool render on top in 2D. A minimal flat
    // stand-in covers the no-WebGL case.
    // ======================================================================
    {
      const W = s.view.width
      const GRID_ROW = 40 // must match the sim's cellSize
      const ROWS = 48
      const farWorldY = proj.nearWorldY - ROWS * GRID_ROW

      // Base look settles to on-brand purple when music is off (mi == 0); when
      // playing it leans into the live rainbow hue.
      const baseHue = PALETTE.latticeHue + (mHue - PALETTE.latticeHue) * mi

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

        const mBeat = music.beat * mi
        // Structural identity: cold steel-blue when music is off; leans gently
        // into the live hue when playing (full rainbow stays on the emissive
        // elements, not the matter).
        const structHue = 218 + (mHue - 218) * (mi * 0.35)
        const wallHueLive = PALETTE.wallHue + (mHue - PALETTE.wallHue) * mi
        const voidC = hexToRgb(PALETTE.voidTop)
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
          // No WebGL: a minimal flat stand-in (floor wash + lit wall rails) so
          // the playfield still reads. The real board is the GL trench above.
          const nl = project(0, proj.nearWorldY)
          const fl = project(0, farWorldY)
          const fr = project(W, farWorldY)
          const nr = project(W, proj.nearWorldY)
          const floor = ctx.createLinearGradient(0, fl.y, 0, nl.y)
          floor.addColorStop(0, hsl(structHue + 8, 55, 6, 0))
          floor.addColorStop(0.18, hsl(structHue + 8, 58, 8, 0.55))
          floor.addColorStop(1, hsl(structHue, 62, 13, 0.8))
          ctx.beginPath()
          ctx.moveTo(fl.x, fl.y)
          ctx.lineTo(fr.x, fr.y)
          ctx.lineTo(nr.x, nr.y)
          ctx.lineTo(nl.x, nl.y)
          ctx.closePath()
          ctx.fillStyle = floor
          ctx.fill()
          ctx.save()
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          for (const xw of [0, W]) {
            const a = project(xw, proj.nearWorldY)
            const b = project(xw, farWorldY)
            ctx.shadowColor = hsl(wallHueLive, 82, 60, 0.7)
            ctx.shadowBlur = 12
            ctx.strokeStyle = hsl(wallHueLive, 72, 60, 0.5)
            ctx.lineWidth = 2.4
            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
            ctx.shadowBlur = 0
          }
          ctx.restore()
        }

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
