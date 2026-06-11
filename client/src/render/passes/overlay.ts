import type { FrameCtx } from '../frame'
import { clamp } from '../../game/math'
import { PALETTE } from '../theme'
import { renderLens } from '../lensGL'

// Reusable offscreen buffers for the black-hole gravitational-lens effect. We
// snapshot the already-drawn background around the hole into `lensSnap` once per
// frame and sample from it while warping (so the lens never feeds back on
// itself), and we draw the warped rings into `lensOut` at a SUPERSAMPLED
// resolution, then downscale it onto the scene — this anti-aliases the hard
// circular clip edges and the per-ring scale seams that otherwise look jagged.
let lensSnap: HTMLCanvasElement | null = null
let lensSnapCtx: CanvasRenderingContext2D | null = null
let lensOut: HTMLCanvasElement | null = null
let lensOutCtx: CanvasRenderingContext2D | null = null
const getLensBuf = (wDev: number, hDev: number) => {
  if (!lensSnap) {
    lensSnap = document.createElement('canvas')
    lensSnapCtx = lensSnap.getContext('2d')
  }
  // Size the buffer to EXACTLY the box. The GPU warp uploads the whole buffer
  // as a texture (flipped about the full buffer height); if the buffer were
  // larger than the box, the flipped texture coords would sample the wrong rows
  // and the lens would appear offset/clipped near the screen edges where the box
  // is clamped. An exact fit keeps texScale == 1 so sampling is always aligned.
  if (lensSnap.width !== wDev) lensSnap.width = wDev
  if (lensSnap.height !== hDev) lensSnap.height = hDev
  return { buf: lensSnap, bctx: lensSnapCtx }
}
const getLensOut = (wDev: number, hDev: number) => {
  if (!lensOut) {
    lensOut = document.createElement('canvas')
    lensOutCtx = lensOut.getContext('2d')
  }
  if (lensOut.width < wDev || lensOut.height < hDev) {
    lensOut.width = Math.max(lensOut.width, wDev)
    lensOut.height = Math.max(lensOut.height, hDev)
  }
  return { out: lensOut, octx: lensOutCtx }
}

// Parallax starfield for the void backdrop. Generated once (deterministic), then
// drawn each frame with a slow downward drift (reinforcing the descent) and a
// per-star twinkle. Layered by `z` (0 far .. 1 near) for cheap depth. The GL
// black-hole lens snapshots the background, so these get lensed for free.
// `mag` scales brightness/size (a few rare "hero" stars anchor the field); `ti`
export const drawOverlayPass = (c: FrameCtx) => {
  const { ctx, s, ui, layout, proj, project, mi, mHue, dpr, hsl, roundedRectPath } = c
    // Control dock (pause + music): drawn ON the canvas as part of the HUD, so
    // the gravity-well lens below samples and warps it exactly like the rest of
    // the UI (the DOM-overlay version could never be lensed). Hit-testing lives
    // in App.tsx against the same layout.dock geometry. Hidden on game over (the
    // overlay covers the field) so it doesn't peek through the blur.
    if (!s.gameOver) {
      const d = layout.dock
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'

      // Glass pill (matches the HUD L's fill/stroke language).
      const pillBg = ctx.createLinearGradient(0, d.y, 0, d.y + d.h)
      pillBg.addColorStop(0, 'rgba(12, 10, 28, 0.62)')
      pillBg.addColorStop(1, 'rgba(10, 8, 22, 0.5)')
      ctx.fillStyle = pillBg
      roundedRectPath(d.x, d.y, d.w, d.h, d.r)
      ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'
      ctx.lineWidth = 1.5
      roundedRectPath(d.x, d.y, d.w, d.h, d.r)
      ctx.stroke()

      // Icon glyphs are authored in a 24x24 box (mirrors the old SVGs); scale to
      // the 19px on-button glyph and center on each button.
      const drawGlyph = (cx: number, cy: number, paint: () => void) => {
        const g = 19 / 24
        ctx.save()
        ctx.translate(cx - (24 * g) / 2, cy - (24 * g) / 2)
        ctx.scale(g, g)
        paint()
        ctx.restore()
      }

      // Pause / play button.
      {
        const c = d.pause
        ctx.fillStyle = 'rgba(255,255,255,0.04)'
        ctx.beginPath()
        ctx.arc(c.cx, c.cy, d.btnR, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,245,200,0.16)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(c.cx, c.cy, d.btnR - 0.5, 0, Math.PI * 2)
        ctx.stroke()

        ctx.fillStyle = 'rgba(255,246,213,0.92)'
        drawGlyph(c.cx, c.cy, () => {
          if (s.paused) {
            ctx.beginPath()
            ctx.moveTo(8, 5.5)
            ctx.lineTo(8, 18.5)
            ctx.lineTo(19, 12)
            ctx.closePath()
            ctx.fill()
          } else {
            roundedRectPath(7, 5.5, 3.5, 13, 1.4)
            ctx.fill()
            roundedRectPath(13.5, 5.5, 3.5, 13, 1.4)
            ctx.fill()
          }
        })
      }

      // Music button. ON = cyan accent + glow; OFF = dimmed with a mute slash.
      {
        const c = d.music
        const on = ui.musicOn
        // The music button literally controls the soundtrack, so its lit accent
        // rides the live music hue (falls back to the cold cyan when paused/silent).
        const noteHue = mi > 0 ? mHue : 196
        ctx.save()
        if (on) {
          ctx.fillStyle = hsl(noteHue, 55, 22, 0.6)
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR, 0, Math.PI * 2)
          ctx.fill()
          ctx.shadowColor = hsl(noteHue, 100, 72, 0.6)
          ctx.shadowBlur = 14
          ctx.strokeStyle = hsl(noteHue, 100, 76, 0.85)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR - 0.5, 0, Math.PI * 2)
          ctx.stroke()
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.04)'
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR, 0, Math.PI * 2)
          ctx.fill()
          ctx.strokeStyle = 'rgba(255,245,200,0.16)'
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.arc(c.cx, c.cy, d.btnR - 0.5, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()

        const note = on ? hsl(noteHue, 100, 95) : 'rgba(255,246,213,0.42)'
        drawGlyph(c.cx, c.cy, () => {
          // Note stem + flag (stroked path) + two beam heads (filled circles).
          ctx.strokeStyle = note
          ctx.fillStyle = note
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.beginPath()
          ctx.moveTo(9, 16.5)
          ctx.lineTo(9, 7)
          ctx.lineTo(18, 5)
          ctx.lineTo(18, 14)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(6.5, 16.5, 2.6, 0, Math.PI * 2)
          ctx.fill()
          ctx.beginPath()
          ctx.arc(15.5, 14, 2.6, 0, Math.PI * 2)
          ctx.fill()
        })
        if (!on) {
          // Diagonal mute slash across the button.
          ctx.save()
          ctx.strokeStyle = 'rgba(255,246,213,0.7)'
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          const r = d.btnR - 8
          ctx.beginPath()
          ctx.moveTo(c.cx - r, c.cy + r)
          ctx.lineTo(c.cx + r, c.cy - r)
          ctx.stroke()
          ctx.restore()
        }
      }

      ctx.restore()
    }

    // Gravity-well puck: the player's single control surface — a gravitational
    // LENS that bends the beam around it. Dark core + real lensing of the board
    // behind it + a neon energy ring, tinted by the music hue and amplified by
    // the crescendo. Drawn in SCREEN space at the puck.
    if (s.well.placed) {
      // The well lives in world space; project it and scale its size with depth
      // so it belongs to the perspective playfield.
      const wp = proj.project(s.well.pos.x, s.well.pos.y)
      const cx = wp.x
      const cy = wp.y
      const wScale = clamp(wp.scale, 0.18, 1.6)
      const grabbed = s.well.grabbed
      // The lens is always energized — there's no inert "held" damage state
      // anymore, so the active glow/swirl stays live even while it's being
      // carried (it reads better and the steering lens never looks "off").
      const active = true
      // Event-horizon shadow radius. The whole black hole scales off this — and
      // off the perspective depth so it shrinks as it travels up the board.
      const rCore = (16 + (grabbed ? 2 : 0)) * wScale
      const hue = mi > 0 ? mHue : PALETTE.energyHue
      const surge = clamp(s.crescendo, 0, 1)

      const TWO_PI = Math.PI * 2
      const ell = (rx: number, ry: number, rot: number) => {
        ctx.beginPath()
        ctx.ellipse(cx, cy, rx, ry, rot, 0, TWO_PI)
      }

      // ----------------------------------------------------------------------
      // GRAVITATIONAL LENS (real, cheap). We snapshot the already-drawn board
      // (grid + blocks + laser) around the hole, then re-draw it as a series of
      // concentric ring bands, each magnified about the centre using the thin-
      // lens equation beta = theta - thetaE^2/theta. Light from just behind the
      // hole is stretched outward into an Einstein ring, so the grid lines
      // visibly bow around the shadow. The deflection tapers to zero at the lens
      // edge so there's no seam with the undistorted board.
      // ----------------------------------------------------------------------
      const rEin = rCore * 1.8 // Einstein radius — sets where the ring sits AND how wide the inner minified smear is; smaller = tighter central disc
      // Warp the ENTIRE disc down to (just under) the core edge. If we left an
      // inner gap, the real unwarped scene would show through it while the lensed
      // copy appeared farther out — a visible double image. The black core is
      // drawn on top afterwards, covering the heavily-magnified centre.
      const rLensIn = rCore * 0.9
      const rLens = rCore * 7 // outer edge: distortion fades to nothing here (was 10; the taper is ~0 well before this, so a tighter box cuts the per-frame copy+upload area ~2× with no visible change)
      const RINGS = 26
      // Cap the longest snapshot dimension so the per-frame texture upload stays
      // bounded on big screens / large holes. The warp is bilinear, so sampling a
      // slightly lower-res source is invisible after the upscale.
      const LENS_MAX_DIM = 768

      // Device-pixel-aligned sample box. Snapshotting and compositing on integer
      // device pixels is what lets the identity (zero-deflection) region of the
      // warp reproduce the original pixels EXACTLY. Because the deflection tapers
      // to zero before the box edge, the box rim samples 1:1 and is invisible —
      // so we can replace the whole box wholesale with no disc clip, no feather,
      // and therefore no seam and no double image.
      const viewDevW = Math.round(s.view.width * dpr)
      const viewDevH = Math.round(s.view.height * dpr)
      const devL = clamp(Math.floor((cx - rLens) * dpr), 0, viewDevW)
      const devT = clamp(Math.floor((cy - rLens) * dpr), 0, viewDevH)
      const devR = clamp(Math.ceil((cx + rLens) * dpr), 0, viewDevW)
      const devB = clamp(Math.ceil((cy + rLens) * dpr), 0, viewDevH)
      const sizeDevW = devR - devL
      const sizeDevH = devB - devT
      const boxL = devL / dpr
      const boxT = devT / dpr
      const boxWcss = sizeDevW / dpr
      const boxHcss = sizeDevH / dpr

      if (sizeDevW > 4 && sizeDevH > 4) {
        // Downscale factor applied to the snapshot/upload (1 = full device res).
        const lensRes = Math.min(1, LENS_MAX_DIM / Math.max(sizeDevW, sizeDevH))
        const bufW = Math.max(1, Math.round(sizeDevW * lensRes))
        const bufH = Math.max(1, Math.round(sizeDevH * lensRes))
        const ld = dpr * lensRes // box-local px -> buffer px
        const { buf, bctx } = getLensBuf(bufW, bufH)
        if (bctx) {
          // Snapshot the background patch into the (possibly downscaled) buffer so
          // the warp samples a clean copy and never feeds back on itself.
          bctx.setTransform(1, 0, 0, 1, 0, 0)
          bctx.clearRect(0, 0, buf.width, buf.height)
          bctx.imageSmoothingEnabled = true
          bctx.imageSmoothingQuality = 'low'
          bctx.drawImage(ctx.canvas, devL, devT, sizeDevW, sizeDevH, 0, 0, bufW, bufH)

          // Preferred path: a GPU per-pixel warp — smooth (bilinear) and cheap.
          let gpu = true
          let warped: HTMLCanvasElement | null = renderLens(buf, {
            cx: (cx - boxL) * ld,
            cy: (cy - boxT) * ld,
            rCore: rCore * ld,
            rEin: rEin * ld,
            rLensIn: rLensIn * ld,
            rLens: rLens * ld,
            boxDevW: bufW,
            boxDevH: bufH,
            snapW: buf.width,
            snapH: buf.height,
          })
          let warpW = bufW
          let warpH = bufH

          // Fallback (no WebGL): the CPU ring approach, supersampled for AA.
          if (!warped) {
            gpu = false
            const SS = 2
            const outScale = dpr * SS
            const outW = Math.ceil(boxWcss * outScale)
            const outH = Math.ceil(boxHcss * outScale)
            const { out, octx } = getLensOut(outW, outH)
            if (octx) {
              octx.setTransform(outScale, 0, 0, outScale, -boxL * outScale, -boxT * outScale)
              octx.clearRect(boxL, boxT, boxWcss, boxHcss)
              octx.imageSmoothingEnabled = true
              octx.imageSmoothingQuality = 'high'
              for (let k = RINGS - 1; k >= 0; k--) {
                const r0 = rLensIn + (rLens - rLensIn) * (k / RINGS)
                const r1 = rLensIn + (rLens - rLensIn) * ((k + 1) / RINGS)
                const rm = (r0 + r1) * 0.5
                let taper = (rLens - rm) / (rLens - rLensIn)
                taper = clamp(taper, 0, 1)
                taper = taper * taper * (3 - 2 * taper)
                const defl = ((rEin * rEin) / rm) * taper
                const beta = Math.max(rm * 0.12, rm - defl)
                const scale = rm / beta
                octx.save()
                octx.beginPath()
                octx.arc(cx, cy, r1 + 0.6, 0, TWO_PI)
                octx.arc(cx, cy, r0 - 0.6, 0, TWO_PI, true)
                octx.clip('evenodd')
                octx.translate(cx, cy)
                octx.scale(scale, scale)
                octx.translate(-cx, -cy)
                octx.drawImage(buf, 0, 0, buf.width, buf.height, boxL, boxT, boxWcss, boxHcss)
                octx.restore()
              }
              warped = out
              warpW = outW
              warpH = outH
            }
          }

          if (warped) {
            ctx.save()
            // The board canvas is transparent in the gaps between strokes (the
            // CSS background shows through). Drawing the warp straight on top
            // would composite a second semi-transparent copy over the original
            // and shift it. So clear the whole box first, then drop the warp in.
            // The warp's identity rim reproduces the originals 1:1, so the box
            // edge is invisible — no clip, no feather, no double image.
            ctx.globalCompositeOperation = 'destination-out'
            ctx.fillStyle = '#000'
            ctx.fillRect(boxL, boxT, boxWcss, boxHcss)
            ctx.globalCompositeOperation = 'source-over'
            // GPU path is a device-pixel copy — keep it crisp when uploaded 1:1,
            // but smooth when the snapshot was downscaled. The fallback is always
            // supersampled, so it smooths on the downscale too.
            ctx.imageSmoothingEnabled = !gpu || lensRes < 1
            ctx.imageSmoothingQuality = 'high'
            ctx.drawImage(warped, 0, 0, warpW, warpH, boxL, boxT, boxWcss, boxHcss)
            ctx.restore()
          }
        }
      }

      ctx.save()

      const tNowS = s.timeSec
      // Organic flicker so the active state seethes instead of pulsing cleanly.
      const flick = clamp(0.62 + 0.26 * Math.sin(tNowS * 13) + 0.16 * Math.sin(tNowS * 7.3 + 1.7), 0, 1.3)

      // Energized corona (behind the core): a hot, flickering glow that appears
      // while the lens is parked and steering the beam.
      if (active) {
        ctx.globalCompositeOperation = 'lighter'
        const coronaR = rCore * 2.35
        const corA = (0.16 + 0.22 * surge) * flick
        const cor = ctx.createRadialGradient(cx, cy, rCore * 0.7, cx, cy, coronaR)
        cor.addColorStop(0, hsl(hue, 100, 62, 0))
        cor.addColorStop(0.45, hsl(hue, 100, 64, corA))
        cor.addColorStop(1, hsl(hue, 100, 62, 0))
        ctx.fillStyle = cor
        ell(coronaR, coronaR, 0)
        ctx.fill()
      }

      // Event horizon: a firm black disc with a softly feathered edge (the inner
      // ~88% is solid black, then it fades over a couple of px so it doesn't read
      // as a hard vector cut-out).
      ctx.globalCompositeOperation = 'source-over'
      const core = ctx.createRadialGradient(cx, cy, rCore * 0.5, cx, cy, rCore)
      core.addColorStop(0, 'rgba(0,0,0,1)')
      core.addColorStop(0.88, 'rgba(0,0,0,1)')
      core.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = core
      ell(rCore, rCore, 0)
      ctx.fill()

      // Accretion disk: a warm, tilted, flattened glow ring around the event
      // horizon — the matter you've shredded spiralling in. This is what makes
      // the well read as the warm energy SOURCE everything orbits, not a UI dot.
      const diskTilt = -0.42
      const diskFlat = 0.42
      if (active) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.translate(cx, cy)
        ctx.rotate(diskTilt)
        ctx.scale(1, diskFlat)
        const rIn = rCore * 1.02
        const rOut = rCore * 2.7
        const ring = ctx.createRadialGradient(0, 0, rIn, 0, 0, rOut)
        ring.addColorStop(0, hsl(hue, 100, 72, 0))
        ring.addColorStop(0.4, hsl(hue, 100, 66, (0.16 + 0.26 * surge) * flick))
        ring.addColorStop(1, hsl(hue, 100, 60, 0))
        ctx.fillStyle = ring
        ctx.beginPath()
        ctx.arc(0, 0, rOut, 0, TWO_PI)
        ctx.fill()
        ctx.restore()
      }

      // Orbiting light: hot streaks spiralling inward along the tilted disk plane
      // — the beam's energy caught and bent by the lens. A subtle Doppler tint
      // (cooler/brighter on the approaching arc) sells the rotation.
      if (active) {
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        ctx.translate(cx, cy)
        ctx.rotate(diskTilt)
        ctx.scale(1, diskFlat)
        ctx.lineCap = 'round'
        ctx.shadowColor = hsl(hue, 100, 60, 0.85)
        ctx.shadowBlur = 6
        const N = 9
        const baseRot = tNowS * 2.1
        for (let i = 0; i < N; i++) {
          const ph = (tNowS * 0.85 + i * 0.31) % 1 // 0..1 infall progress
          const rr = rCore * (1.95 + (1.05 - 1.95) * ph) // spirals inward
          const a0 = baseRot + (i / N) * TWO_PI + ph * 1.4 // trailing swirl
          const arcLen = (0.5 + 0.5 * (1 - ph)) * (0.7 + 0.3 * Math.sin(tNowS * 5 + i))
          const fade = (1 - ph) * flick
          const dop = Math.cos(a0) // -1..1 approaching/receding
          ctx.lineWidth = 1.2 + 1.9 * (1 - ph)
          ctx.strokeStyle = hsl(hue + dop * 8, 100, 66 + ph * 16 + dop * 8, 0.2 + 0.5 * fade)
          ctx.beginPath()
          ctx.arc(0, 0, rr, a0, a0 + arcLen)
          ctx.stroke()
        }
        ctx.shadowBlur = 0
        ctx.restore()
      }

      // Armed Overdrive: the well is where the eye and finger already are, so it
      // carries the primary "ready, tap to release" signal. A breathing gold
      // halo + a steady charged ring + a contracting "tap-target" pulse that
      // repeatedly converges on the core — an unmistakable affordance that this
      // is now a button — all in the gold Overdrive identity. (The gauge's "TAP
      // TO FIRE" and the screen rim reinforce it; this is the focal one.)
      if (s.overdriveArmed && s.overdriveSec <= 0) {
        const GOLD = 46
        const breath = 0.5 + 0.5 * Math.sin(s.timeSec * 4.2)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'

        // Charged halo (bigger + brighter than the idle corona).
        const rGlow = rCore * (2.4 + 0.5 * breath)
        const g = ctx.createRadialGradient(cx, cy, rCore * 0.6, cx, cy, rGlow)
        g.addColorStop(0, hsl(GOLD, 100, 74, 0.22 + 0.16 * breath))
        g.addColorStop(0.5, hsl(GOLD, 100, 66, 0.16 + 0.14 * breath))
        g.addColorStop(1, hsl(GOLD, 100, 58, 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, rGlow, 0, TWO_PI)
        ctx.fill()

        // Steady charged ring hugging the event horizon — a solid "loaded" band.
        ctx.lineWidth = 2.2
        ctx.strokeStyle = hsl(GOLD, 100, 76, 0.55 + 0.35 * breath)
        ctx.shadowColor = hsl(GOLD, 100, 64, 0.9)
        ctx.shadowBlur = 8
        ctx.beginPath()
        ctx.arc(cx, cy, rCore * 1.7, 0, TWO_PI)
        ctx.stroke()
        ctx.shadowBlur = 0

        // Tap-target pulse: a ring that converges on the core and fades, on a
        // steady ~1s beat. Reads as "press here".
        const tp = (s.timeSec % 1.05) / 1.05
        const tpR = rCore * (3.4 - 1.7 * tp)
        const tpA = 0.6 * (1 - tp) * (1 - tp)
        ctx.lineWidth = 2 + 1.6 * (1 - tp)
        ctx.strokeStyle = hsl(GOLD, 100, 80, tpA)
        ctx.beginPath()
        ctx.arc(cx, cy, tpR, 0, TWO_PI)
        ctx.stroke()
        ctx.restore()
      }

      // Firing: the well is the hot muzzle — a bright gold flare that blooms on
      // the tap and winds down with the surge (s.heat == overdriveSec/duration).
      if (s.overdriveSec > 0) {
        const drain = clamp(s.heat, 0, 1)
        const onset = clamp((drain - 0.86) / 0.14, 0, 1)
        const fl = 0.5 + 0.5 * Math.sin(s.timeSec * 16)
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'
        const rF = rCore * (2.6 + 1.4 * drain + 1.2 * onset)
        const g = ctx.createRadialGradient(cx, cy, rCore * 0.5, cx, cy, rF)
        g.addColorStop(0, hsl(48, 100, 86, (0.3 + 0.4 * drain) * (0.7 + 0.3 * fl) + 0.5 * onset))
        g.addColorStop(0.5, hsl(46, 100, 70, (0.18 + 0.3 * drain) * (0.7 + 0.3 * fl)))
        g.addColorStop(1, hsl(44, 100, 60, 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(cx, cy, rF, 0, TWO_PI)
        ctx.fill()
        ctx.restore()
      }

      ctx.restore()
    } else if (!s.tutorial && !s.jit) {
      // First-run hint: the entire surface is the control. Suppressed during the
      // onboarding warmup / coachmarks (the React callouts speak instead).
      const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(s.timeSec * 3))
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "800 15px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const label = 'Drag anywhere to steer the beam'
      const cxx = s.view.width / 2
      const cyy = s.view.height * 0.46
      ctx.globalAlpha = pulse
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 10
      ctx.fillStyle = 'rgba(255,246,213,0.96)'
      ctx.fillText(label, cxx, cyy)
      ctx.restore()
    }

    // Overdrive screen-state: a peripheral energy frame (transparent center, so
    // the playfield stays fully legible). Armed = a calm breathing gold rim
    // ("loaded"); firing = the same frame ignited brighter with living corner
    // flares + a crisp edge line, winding down as the surge drains. The center is
    // never washed — character lives at the edges, not over the action.
    {
      const odOn = s.overdriveSec > 0
      const odArmed = s.overdriveArmed && !odOn
      if (odOn || odArmed) {
        const W = s.view.width
        const H = s.view.height
        const cx = W * 0.5
        const cy = H * 0.52
        const rIn = Math.min(W, H) * 0.46
        const rOut = Math.max(W, H) * 0.86
        ctx.save()
        ctx.globalCompositeOperation = 'lighter'

        if (odArmed) {
          // Loaded: a calm, slow gold breath hugging the edges.
          const breath = 0.5 + 0.5 * Math.sin(s.timeSec * 3.2)
          const a = 0.12 + 0.12 * breath
          const g = ctx.createRadialGradient(cx, cy, rIn, cx, cy, rOut)
          g.addColorStop(0, hsl(46, 100, 60, 0))
          g.addColorStop(0.72, hsl(46, 100, 58, a * 0.45))
          g.addColorStop(1, hsl(44, 100, 62, a))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)
        } else {
          // FIRING — deliberately distinct from the calm gold "armed" breath:
          // hotter/whiter, with motion (a one-shot shockwave bursting from the
          // well on the tap, then a fast-pulsing white-hot edge that cools as the
          // surge drains). s.heat == overdriveSec/duration -> wind-down envelope.
          const drain = clamp(s.heat, 0, 1)
          const fireProg = 1 - drain // 0 at the instant of fire -> 1 at surge end
          const onset = clamp((drain - 0.8) / 0.2, 0, 1)
          const fastPulse = 0.5 + 0.5 * Math.sin(s.timeSec * 14)

          // Edge bloom — WHITE-hot (low saturation, high lightness) so it reads as
          // a hotter temperature than the gold armed state. Kept tight to the very
          // edges (large transparent center) and low-alpha so it never obscures
          // the playfield.
          const rInFire = Math.min(W, H) * 0.66
          const a = 0.09 + 0.16 * drain
          const g = ctx.createRadialGradient(cx, cy, rInFire, cx, cy, rOut)
          g.addColorStop(0, hsl(50, 100, 80, 0))
          g.addColorStop(0.72, hsl(49, 90, 72, a * 0.35 * (0.8 + 0.2 * fastPulse)))
          g.addColorStop(1, hsl(48, 95, 78, Math.min(0.55, a + 0.18 * onset)))
          ctx.fillStyle = g
          ctx.fillRect(0, 0, W, H)

          // Living corner flares (out of phase) keep the frame alive — small and
          // faint so they read as edge accents, not a wash.
          const corners: Array<[number, number, number]> = [
            [0, 0, 0],
            [W, 0, 1.6],
            [0, H, 3.1],
            [W, H, 4.7],
          ]
          const cr = Math.min(W, H) * 0.46
          for (const [qx, qy, ph] of corners) {
            const sh = 0.5 + 0.5 * Math.sin(s.timeSec * 7 + ph)
            const ca = (0.06 + 0.13 * drain) * (0.4 + 0.6 * sh) + 0.16 * onset
            const cg = ctx.createRadialGradient(qx, qy, 0, qx, qy, cr)
            cg.addColorStop(0, hsl(50, 95, 85, Math.min(0.5, ca)))
            cg.addColorStop(0.5, hsl(47, 100, 66, ca * 0.35))
            cg.addColorStop(1, hsl(45, 100, 58, 0))
            ctx.fillStyle = cg
            ctx.fillRect(0, 0, W, H)
          }

          // Crisp inset border, fast-pulsing white-gold, cooling as it drains.
          ctx.strokeStyle = hsl(50, 100, 86, Math.min(0.95, (0.34 + 0.3 * fastPulse) * drain + 0.55 * onset))
          ctx.lineWidth = 3
          ctx.strokeRect(3.5, 3.5, W - 7, H - 7)

          // One-shot ignition shockwave: a bright ring bursting OUT from the well
          // (the muzzle) the instant you tap — the unmistakable "fire" moment.
          const shock = clamp(fireProg / 0.13, 0, 1)
          if (shock < 1) {
            const oc = s.well.placed ? project(s.well.pos.x, s.well.pos.y) : { x: cx, y: cy }
            const maxR = Math.hypot(W, H) * 0.62
            const sr = shock * maxR
            const sa = (1 - shock) * (1 - shock)
            ctx.strokeStyle = hsl(49, 100, 78, 0.55 * sa)
            ctx.lineWidth = 3 + 14 * (1 - shock)
            ctx.beginPath()
            ctx.arc(oc.x, oc.y, sr, 0, Math.PI * 2)
            ctx.stroke()
            ctx.strokeStyle = hsl(52, 100, 94, 0.7 * sa)
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.arc(oc.x, oc.y, sr * 1.05, 0, Math.PI * 2)
            ctx.stroke()
          }
        }
        ctx.restore()
      }
    }

    // Power-up flash: a compact neon badge that pops in, holds briefly, then
    // drifts upward and fades. Sits in the upper third so it never blocks the
    // beam/hole action, and is themed to the live music hue.
    if (s.levelUpNotificationFx) {
      const t = s.levelUpNotificationFx.t
      const displayDur = s.levelUpNotificationFx.displayDur
      const fadeDur = s.levelUpNotificationFx.fadeDur

      const introDur = 0.22
      const intro = clamp(t / introDur, 0, 1)
      // easeOutBack for a little overshoot on entry (impact).
      const c1 = 1.70158
      const c3 = c1 + 1
      const back = 1 + c3 * Math.pow(intro - 1, 3) + c1 * Math.pow(intro - 1, 2)

      let alpha = 1
      let riseY = 0
      if (t < introDur) {
        alpha = intro
        riseY = (1 - intro) * 8
      }
      if (t > displayDur) {
        const f = clamp((t - displayDur) / fadeDur, 0, 1)
        alpha = 1 - f
        riseY = -f * 22
      }

      if (alpha > 0.001) {
        const cx = s.view.width * 0.5
        const cy = s.view.height * 0.3 + riseY
        const scale = 0.72 + 0.28 * back
        // Overdrive's identity color is gold (matches the ignition frame),
        // distinct from the music-reactive rest of the scene.
        const hue = 45

        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.textAlign = 'center'
        ctx.translate(cx, cy)
        ctx.scale(scale, scale)

        // No eyebrow text — the screen-wide ignition frame carries the "this is a
        // big deal" signal, so the banner is a single iconic word.

        // Main: "OVERDRIVE" — white-hot core with a hue bloom.
        ctx.textBaseline = 'middle'
        ctx.font = '900 30px Oxanium'
        ctx.shadowColor = hsl(hue, 100, 62, 0.95 * alpha)
        ctx.shadowBlur = 18
        ctx.fillStyle = `rgba(255,250,240,${alpha})`
        ctx.fillText('OVERDRIVE', 0, 12)

        // Neon underline that grows with the entry pop.
        ctx.shadowBlur = 10
        const uw = 86 * intro
        const ug = ctx.createLinearGradient(-uw, 0, uw, 0)
        ug.addColorStop(0, hsl(hue, 95, 70, 0))
        ug.addColorStop(0.5, hsl((hue + 18) % 360, 100, 78, 0.95 * alpha))
        ug.addColorStop(1, hsl(hue, 95, 70, 0))
        ctx.strokeStyle = ug
        ctx.lineWidth = 2.5
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(-uw, 34)
        ctx.lineTo(uw, 34)
        ctx.stroke()

        ctx.restore()
      }
    }

    // ---- First-run onboarding overlays ------------------------------------
    // Warmup: ring the targeted block (steer), the Heat gauge (charge/overdrive),
    // and flash the fail line (handoff). JIT: dim the whole screen with a soft
    // cutout so the OK card's subject piece stays bright and unmistakable.
    {
      const TAU = Math.PI * 2
      const tnow =
        (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000

      const ring = (sx: number, sy: number, r: number, hue: number) => {
        const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tnow * 4))
        ctx.save()
        ctx.globalCompositeOperation = 'screen'
        ctx.lineWidth = 3
        ctx.strokeStyle = hsl(hue, 100, 70, 0.9 * pulse)
        ctx.shadowColor = hsl(hue, 100, 65, 0.85)
        ctx.shadowBlur = 16
        ctx.beginPath()
        ctx.arc(sx, sy, r * (1 + 0.04 * Math.sin(tnow * 4)), 0, TAU)
        ctx.stroke()
        ctx.restore()
      }

      const tut = s.tutorial
      if (tut && tut.phase === 'warmup' && !s.jit) {
        if (tut.beat === 'steer' && tut.targetBlockId >= 0) {
          const b = s.blocks.find((x) => x.id === tut.targetBlockId)
          if (b) {
            const cxw = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
            const cyw = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
            const pp = project(cxw, cyw)
            const ext =
              Math.max(b.localAabb.maxX - b.localAabb.minX, b.localAabb.maxY - b.localAabb.minY) * 0.7
            ring(pp.x, pp.y, ext * pp.scale + 8, 190)
          }
        } else if (tut.beat === 'charge' || tut.beat === 'overdrive') {
          // Fitted outline hugging the Heat/Overdrive gauge (not a giant circle).
          const g = layout.xpGauge
          const pad = 5
          const rx = g.x - pad
          const ry = g.y - pad
          const rw = g.w + pad * 2
          const rh = g.h + pad * 2
          const rr = Math.min(12, rw / 2)
          const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(tnow * 4))
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.lineWidth = 3
          ctx.strokeStyle = hsl(45, 100, 70, 0.9 * pulse)
          ctx.shadowColor = hsl(45, 100, 65, 0.85)
          ctx.shadowBlur = 16
          roundedRectPath(rx, ry, rw, rh, rr)
          ctx.stroke()
          ctx.restore()
        } else if (tut.beat === 'handoff') {
          const pulse = 0.5 + 0.5 * Math.sin(tnow * 5)
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.strokeStyle = hsl(8, 100, 62, 0.5 + 0.4 * pulse)
          ctx.lineWidth = 3
          ctx.shadowColor = hsl(8, 100, 55, 0.85)
          ctx.shadowBlur = 14
          ctx.beginPath()
          ctx.moveTo(0, layout.failY)
          ctx.lineTo(s.view.width, layout.failY)
          ctx.stroke()
          ctx.restore()
        }
      }

      const jit = s.jit
      if (jit) {
        let cxw = s.view.width / 2
        let cyw = s.view.height / 2
        let ext = 40
        if (jit.isFeature) {
          const f = s.features.find((x) => x.id === jit.entityId)
          if (f) {
            cxw = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
            cyw = f.pos.y + (f.localAabb.minY + f.localAabb.maxY) * 0.5
            ext = Math.max(f.localAabb.maxX - f.localAabb.minX, f.localAabb.maxY - f.localAabb.minY) * 0.6
          }
        } else {
          const b = s.blocks.find((x) => x.id === jit.entityId)
          if (b) {
            cxw = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
            cyw = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
            ext = Math.max(b.localAabb.maxX - b.localAabb.minX, b.localAabb.maxY - b.localAabb.minY) * 0.6
          }
        }
        const pp = project(cxw, cyw)
        const rHole = ext * pp.scale + 22

        const grad = ctx.createRadialGradient(pp.x, pp.y, rHole * 0.6, pp.x, pp.y, rHole + 90)
        grad.addColorStop(0, 'rgba(4,6,12,0)')
        grad.addColorStop(0.55, 'rgba(4,6,12,0.55)')
        grad.addColorStop(1, 'rgba(4,6,12,0.82)')
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, s.view.width, s.view.height)
        ctx.restore()

        ring(pp.x, pp.y, rHole, 50)
      }
    }
}
