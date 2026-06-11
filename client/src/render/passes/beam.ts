import type { FrameCtx } from '../frame'
import { clamp } from '../../game/math'
import type { Vec2 } from '../../game/math'
import { PALETTE } from '../theme'

export const drawBeamPass = (c: FrameCtx) => {
  const { ctx, s, layout, project, scaleAt, mi, mBass, mPulse, mEnergy, mHue, tNow, hsl } = c
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

    // Build a tapered ribbon polygon from projected screen points + per-vertex
    // half-widths (forward down one side, back up the other). A single filled
    // polygon avoids the bright vertex "striations" that overlapping stroked
    // segments would create, while letting the width shrink with depth.
    const buildRibbon = (scr: Vec2[], halfAt: number[]) => {
      const n = scr.length
      if (n < 2) return
      const nrm: Vec2[] = []
      for (let i = 0; i < n; i++) {
        let nx = 0
        let ny = 0
        if (i > 0) {
          const a = scr[i - 1]!
          const b = scr[i]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const l = Math.hypot(dx, dy) || 1
          nx += -dy / l
          ny += dx / l
        }
        if (i < n - 1) {
          const a = scr[i]!
          const b = scr[i + 1]!
          const dx = b.x - a.x
          const dy = b.y - a.y
          const l = Math.hypot(dx, dy) || 1
          nx += -dy / l
          ny += dx / l
        }
        const l = Math.hypot(nx, ny) || 1
        nrm.push({ x: nx / l, y: ny / l })
      }
      ctx.beginPath()
      for (let i = 0; i < n; i++) {
        const p = scr[i]!
        const m = nrm[i]!
        const h = halfAt[i]!
        const x = p.x + m.x * h
        const y = p.y + m.y * h
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      for (let i = n - 1; i >= 0; i--) {
        const p = scr[i]!
        const m = nrm[i]!
        const h = halfAt[i]!
        ctx.lineTo(p.x - m.x * h, p.y - m.y * h)
      }
      ctx.closePath()
    }

    // Overdrive: the beam fattens and flips to a white-gold while the surge is up.
    const overdrive = s.overdriveSec > 0
    const odWidth = overdrive ? 1.45 : 1
    for (let li = 0; li < stitched.length; li++) {
      const line = stitched[li]!
      const alpha = clamp(line.intensity, 0, 1)
      if (alpha <= 0) continue

      // Project each vertex; keep the per-vertex depth scale so the beam narrows
      // as it falls toward the horizon, matching the grid.
      const scr: Vec2[] = []
      const sc: number[] = []
      for (const wp of line.pts) {
        const pp = project(wp.x, wp.y)
        scr.push({ x: pp.x, y: pp.y })
        sc.push(pp.scale)
      }
      if (scr.length < 2) continue

      // Laser palette: red by default, but the beam drifts through the rainbow
      // hue with the music. Motion is smooth (sustained energy), never beat-keyed,
      // so the width only breathes a few percent. The hot core stays bright.
      const beamSwell = (1 + mPulse * 0.16 + mBass * 0.1) * odWidth
      const glowAlpha = Math.min(0.7, (0.16 + (overdrive ? 0.16 : 0)) * alpha * (1 + mPulse * 0.6))
      const coreAlpha = Math.min(1, (0.78 + (overdrive ? 0.15 : 0)) * alpha)

      // Outer glow ribbon. A faint lateral shimmer (heat-haze) wobbles the glow
      // edge so the beam reads as superheated air; the core/spine below stay
      // crisp on the unjittered path so aim never looks fuzzy.
      const glowHalf = sc.map((z) => s.stats.beamGlowWidth * beamSwell * 0.5 * z)
      const hazeScr = scr.map((p, i) => ({
        x: p.x + Math.sin(tNow * 7 + line.pts[i]!.y * 0.05 + i * 0.9) * 1.2 * sc[i]!,
        y: p.y,
      }))
      ctx.fillStyle = overdrive
        ? hsl(PALETTE.energyGoldHue, 100, 60, glowAlpha)
        : mi > 0
          ? hsl(mHue, 95, 62, glowAlpha)
          : hsl(PALETTE.energyHue, 100, 56, glowAlpha)
      buildRibbon(hazeScr, glowHalf)
      ctx.fill()

      // Core ribbon (restroke same path) — kept bright (high lightness).
      const coreHalf = sc.map((z) => s.stats.beamWidth * 0.5 * odWidth * z)
      ctx.fillStyle = overdrive
        ? hsl(PALETTE.energyGoldHue, 100, 82, coreAlpha)
        : mi > 0
          ? hsl(mHue, 90, 72, coreAlpha)
          : hsl(PALETTE.energyHue, 100, 72, coreAlpha)
      buildRibbon(scr, coreHalf)
      ctx.fill()

      // Hot white spine — a thin near-white inner ribbon so the beam reads as a
      // superheated filament rather than a flat tube.
      const spineHalf = sc.map((z) => s.stats.beamWidth * 0.22 * odWidth * z)
      ctx.fillStyle = overdrive
        ? `rgba(255,252,240,${Math.min(1, 0.8 * alpha).toFixed(3)})`
        : mi > 0
          ? hsl(mHue, 100, 93, Math.min(1, 0.62 * alpha))
          : `rgba(255,244,224,${(0.62 * alpha).toFixed(3)})`
      buildRibbon(scr, spineHalf)
      ctx.fill()

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
          // Streak length matches the *core* beam width (project both ends so it
          // shrinks with depth too).
          const half = s.stats.beamWidth * 0.52
          const a1 = project(pt.p.x - perp.x * half, pt.p.y - perp.y * half)
          const a2 = project(pt.p.x + perp.x * half, pt.p.y + perp.y * half)

          // Thin crisp white streak (no wide glow band).
          ctx.strokeStyle = `rgba(255,255,255,${0.55 * alpha})`
          ctx.lineWidth = Math.max(2, s.stats.beamWidth * 0.84 * scaleAt(pt.p.y))
          ctx.beginPath()
          ctx.moveTo(a1.x, a1.y)
          ctx.lineTo(a2.x, a2.y)
          ctx.stroke()
        }
      }
    }
    ctx.restore()

    // Static laser emitter. A floor-mounted focusing array, rendered as a real
    // object: a curved gunmetal housing with lit/shadowed bevels, a recessed
    // machined lens dish drawn in perspective, twin focusing rails framing the
    // aperture, and a plasma core with a throat glow + flickering arcs. Drawn in
    // SCREEN space at the near plane (project() is the identity here), so the
    // aperture sits exactly on the beam root at bottom-center. Everything rides
    // the music hue/energy.
    {
      const W = s.view.width
      const cx2 = W / 2
      const baseY = layout.emitterY
      const emHue = mi > 0 ? mHue : PALETTE.energyHue
      const beat = s.music.beat * mi
      const breath = 0.5 + 0.5 * Math.sin(tNow * 2.4)
      const glow = clamp(0.4 + 0.45 * mEnergy + 0.18 * breath + 0.35 * beat, 0, 1.4)
      // Fast charge throb for the energy that fills the recessed niches — a base
      // pulse lifted by live energy and punched on the beat, so the hollows read
      // as live plasma chambers rather than ambiguous dark geometry.
      const pulse = 0.5 + 0.5 * Math.sin(tNow * 5.2 + beat * 4)
      const energy = clamp((0.45 + 0.55 * mEnergy) * (0.55 + 0.45 * pulse) + 0.4 * beat, 0, 1.3)
      const halfW = Math.min(W * 0.34, 240)

      // Smooth swept top edge of the housing (reused for fill, clip, and the
      // bevel highlight). `dy` offsets it for the inner highlight pass.
      const traceTop = (dy: number): void => {
        ctx.moveTo(cx2 - halfW, baseY + 5 + dy)
        ctx.quadraticCurveTo(cx2 - halfW * 0.7, baseY - 2 + dy, cx2 - halfW * 0.4, baseY - 6 + dy)
        ctx.quadraticCurveTo(cx2 - 58, baseY - 10 + dy, cx2 - 34, baseY - 11 + dy)
        ctx.quadraticCurveTo(cx2, baseY - 13 + dy, cx2 + 34, baseY - 11 + dy)
        ctx.quadraticCurveTo(cx2 + 58, baseY - 10 + dy, cx2 + halfW * 0.4, baseY - 6 + dy)
        ctx.quadraticCurveTo(cx2 + halfW * 0.7, baseY - 2 + dy, cx2 + halfW, baseY + 5 + dy)
      }
      const housingPath = (): void => {
        ctx.beginPath()
        traceTop(0)
        ctx.lineTo(cx2 + halfW - 6, baseY + 16)
        ctx.quadraticCurveTo(cx2, baseY + 19, cx2 - halfW + 6, baseY + 16)
        ctx.closePath()
      }

      ctx.save()

      // (1) Seating shadow — grounds the array into the floor.
      const seat = ctx.createRadialGradient(cx2, baseY + 11, 6, cx2, baseY + 11, halfW * 1.05)
      seat.addColorStop(0, 'rgba(1,1,6,0.6)')
      seat.addColorStop(1, 'rgba(1,1,6,0)')
      ctx.fillStyle = seat
      ctx.beginPath()
      ctx.ellipse(cx2, baseY + 12, halfW * 1.05, 13, 0, 0, Math.PI * 2)
      ctx.fill()

      // (2) Housing body — cool brushed steel, lit at the crest, dark at the base.
      const body = ctx.createLinearGradient(0, baseY - 13, 0, baseY + 18)
      body.addColorStop(0, '#33384e')
      body.addColorStop(0.16, '#222538')
      body.addColorStop(0.5, '#13131f')
      body.addColorStop(1, '#06060e')
      housingPath()
      ctx.fillStyle = body
      ctx.fill()
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'
      ctx.stroke()

      // Inner detail clipped to the housing.
      ctx.save()
      housingPath()
      ctx.clip()

      // (2a) Specular sheen on the upper body.
      const sheen = ctx.createLinearGradient(0, baseY - 13, 0, baseY + 4)
      sheen.addColorStop(0, 'rgba(150,165,210,0.22)')
      sheen.addColorStop(1, 'rgba(150,165,210,0)')
      ctx.fillStyle = sheen
      ctx.fillRect(cx2 - halfW, baseY - 13, halfW * 2, 18)

      // (2b) Bevel highlight tracing the crest — bright at the muzzle, fading out.
      const bevel = ctx.createLinearGradient(cx2 - halfW, 0, cx2 + halfW, 0)
      bevel.addColorStop(0, 'rgba(200,215,255,0)')
      bevel.addColorStop(0.5, `rgba(220,235,255,${(0.5 + 0.35 * glow).toFixed(3)})`)
      bevel.addColorStop(1, 'rgba(200,215,255,0)')
      ctx.strokeStyle = bevel
      ctx.lineWidth = 1.4
      ctx.beginPath()
      traceTop(1.4)
      ctx.stroke()

      // (2c) Engraved panel seams that follow the form (dark groove + lit lip).
      for (const sy of [baseY + 3, baseY + 9]) {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx2 - halfW + 12, sy)
        ctx.quadraticCurveTo(cx2, sy + 2, cx2 + halfW - 12, sy)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(150,160,200,0.10)'
        ctx.beginPath()
        ctx.moveTo(cx2 - halfW + 12, sy - 1)
        ctx.quadraticCurveTo(cx2, sy + 1, cx2 + halfW - 12, sy - 1)
        ctx.stroke()
      }

      // (2d) Heat-sink louvers near each shoulder — slanted slits that glow with
      // pulsing laser energy. A dark groove gives depth; an additive energy core
      // fills it, each notch phase-offset so the bank shimmers along its length.
      for (const sign of [-1, 1]) {
        for (let k = 0; k < 4; k++) {
          const lx = cx2 + sign * (halfW * 0.5 + k * 7)
          // Recessed groove for depth.
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.moveTo(lx - 3, baseY + 9)
          ctx.lineTo(lx + 3, baseY - 1)
          ctx.stroke()
          // Pulsing energy filling the notch (travelling phase per slit).
          const ph = 0.5 + 0.5 * Math.sin(tNow * 5.2 + beat * 4 - k * 0.9 - (sign < 0 ? 0 : 0.45))
          const lit = clamp((0.4 + 0.6 * mEnergy) * (0.4 + 0.6 * ph) + 0.35 * beat, 0, 1.2)
          ctx.globalCompositeOperation = 'lighter'
          ctx.lineCap = 'round'
          ctx.strokeStyle = hsl(emHue, 100, 72, 0.55 * lit)
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(lx - 2, baseY + 8)
          ctx.lineTo(lx + 2, baseY)
          ctx.stroke()
          ctx.globalCompositeOperation = 'source-over'
        }
      }
      ctx.lineCap = 'butt'
      ctx.restore() // end housing clip

      // (3) Recessed machined lens dish, drawn in a Y-squashed space so circles
      // read as floor-plane ellipses.
      const R = 27
      const ry = 0.46
      ctx.save()
      ctx.translate(cx2, baseY)
      ctx.scale(1, ry)
      // Collar: turned-metal ring, lit on its upper face.
      const collar = ctx.createLinearGradient(0, -R, 0, R)
      collar.addColorStop(0, '#3a4258')
      collar.addColorStop(0.5, '#171722')
      collar.addColorStop(1, '#0a0a12')
      ctx.fillStyle = collar
      ctx.beginPath()
      ctx.arc(0, 0, R, 0, Math.PI * 2)
      ctx.fill()
      // Concentric machined steps.
      for (const rr of [0.82, 0.62]) {
        const stepGrad = ctx.createLinearGradient(0, -R * rr, 0, R * rr)
        stepGrad.addColorStop(0, 'rgba(180,195,235,0.30)')
        stepGrad.addColorStop(0.5, 'rgba(0,0,0,0.25)')
        stepGrad.addColorStop(1, 'rgba(0,0,0,0.4)')
        ctx.strokeStyle = stepGrad
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(0, 0, R * rr, 0, Math.PI * 2)
        ctx.stroke()
      }
      // Dark well sinking to the throat (transparent center so the core shows).
      const well = ctx.createRadialGradient(0, 0, R * 0.12, 0, 0, R * 0.6)
      well.addColorStop(0, 'rgba(0,0,0,0)')
      well.addColorStop(0.55, 'rgba(3,2,10,0.5)')
      well.addColorStop(1, 'rgba(3,2,10,0.92)')
      ctx.fillStyle = well
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.6, 0, Math.PI * 2)
      ctx.fill()
      // Pulsing plasma flooding the recessed dish so the niche reads as a live
      // energy chamber, not a dark hole.
      ctx.globalCompositeOperation = 'lighter'
      const wellGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 0.62)
      wellGlow.addColorStop(0, hsl(emHue, 100, 78, 0.5 * energy))
      wellGlow.addColorStop(0.55, hsl(emHue, 100, 62, 0.2 * energy))
      wellGlow.addColorStop(1, hsl(emHue, 100, 55, 0))
      ctx.fillStyle = wellGlow
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.62, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalCompositeOperation = 'source-over'
      ctx.restore()

      // (4) Twin focusing rails framing the aperture — tapered blades rising from
      // the dish, steel-shaded with a core-lit inner edge and a glowing tip.
      for (const sign of [-1, 1]) {
        const yBase = baseY + 3
        const yTop = baseY - 13
        ctx.beginPath()
        ctx.moveTo(cx2 + sign * 22, yBase)
        ctx.quadraticCurveTo(cx2 + sign * 27, baseY - 6, cx2 + sign * 12, yTop)
        ctx.lineTo(cx2 + sign * 8, yTop + 1)
        ctx.quadraticCurveTo(cx2 + sign * 14, baseY - 5, cx2 + sign * 12, yBase)
        ctx.closePath()
        const rg = ctx.createLinearGradient(0, yTop, 0, yBase)
        rg.addColorStop(0, '#3b4258')
        rg.addColorStop(1, '#0c0c16')
        ctx.fillStyle = rg
        ctx.fill()
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        ctx.lineWidth = 1
        ctx.stroke()
        // Inner edge lit by the plasma core.
        ctx.strokeStyle = hsl(emHue, 95, 70, 0.55 + 0.35 * glow)
        ctx.lineWidth = 1.3
        ctx.beginPath()
        ctx.moveTo(cx2 + sign * 12, yBase)
        ctx.quadraticCurveTo(cx2 + sign * 14, baseY - 5, cx2 + sign * 8, yTop + 1)
        ctx.stroke()
      }

      // (4b) Pulsing energy filling the niche between the rails — the V-channel
      // the beam exits through reads as a charged plasma slot instead of a dark
      // notch. Clipped to the channel so the glow can't spill onto the blades.
      {
        const yBase = baseY + 3
        const yTop = baseY - 13
        ctx.save()
        ctx.beginPath()
        ctx.moveTo(cx2 - 8, yTop + 1)
        ctx.quadraticCurveTo(cx2 - 14, baseY - 5, cx2 - 12, yBase)
        ctx.lineTo(cx2 + 12, yBase)
        ctx.quadraticCurveTo(cx2 + 14, baseY - 5, cx2 + 8, yTop + 1)
        ctx.closePath()
        ctx.clip()
        ctx.globalCompositeOperation = 'lighter'
        const slot = ctx.createLinearGradient(0, yBase, 0, yTop)
        slot.addColorStop(0, hsl(emHue, 100, 80, 0.7 * energy))
        slot.addColorStop(0.6, hsl(emHue, 100, 66, 0.34 * energy))
        slot.addColorStop(1, hsl(emHue, 100, 60, 0.06 * energy))
        ctx.fillStyle = slot
        ctx.fillRect(cx2 - 16, yTop, 32, yBase - yTop + 2)
        ctx.restore()
      }

      // (5) Plasma throat — a tall, soft glow column rising between the rails.
      ctx.globalCompositeOperation = 'lighter'
      ctx.save()
      ctx.translate(cx2, baseY - 4)
      ctx.scale(0.5, 1)
      const throat = ctx.createRadialGradient(0, 0, 0, 0, 0, 16)
      throat.addColorStop(0, hsl(emHue, 100, 82, 0.55 * glow))
      throat.addColorStop(0.5, hsl(emHue, 100, 70, 0.25 * glow))
      throat.addColorStop(1, hsl(emHue, 100, 60, 0))
      ctx.fillStyle = throat
      ctx.beginPath()
      ctx.arc(0, 0, 16, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()

      // (6) Flickering plasma arcs from the core up to each rail tip.
      const arcAmp = (0.35 + 0.65 * mEnergy) * (0.4 + 0.6 * glow)
      if (arcAmp > 0.25) {
        for (const sign of [-1, 1]) {
          const tipX = cx2 + sign * 8
          const tipY = baseY - 12
          ctx.strokeStyle = hsl(emHue, 100, 86, Math.min(0.9, arcAmp))
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(cx2, baseY - 1)
          const segs = 4
          for (let q = 1; q <= segs; q++) {
            const f = q / segs
            const jx = Math.sin(tNow * 37 + q * 2.3 + sign) * 3 * (1 - f) * arcAmp
            ctx.lineTo(cx2 + (tipX - cx2) * f + jx, baseY - 1 + (tipY - (baseY - 1)) * f)
          }
          ctx.stroke()
        }
      }

      // (7) Beat charge ring — a thin ellipse that flares on the beat.
      if (beat > 0.15) {
        ctx.strokeStyle = hsl(emHue, 100, 80, beat * 0.5)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.ellipse(cx2, baseY, R * (0.7 + beat * 0.5), R * ry * (0.7 + beat * 0.5), 0, 0, Math.PI * 2)
        ctx.stroke()
      }

      // (8) Hot core the beam erupts from (the brightest point).
      ctx.shadowColor = hsl(emHue, 90, 66, 0.7)
      ctx.shadowBlur = 16 + mEnergy * 18
      const core = ctx.createRadialGradient(cx2, baseY, 0, cx2, baseY, 12)
      core.addColorStop(0, `rgba(255,255,255,${(0.9 * (0.6 + 0.4 * glow)).toFixed(3)})`)
      core.addColorStop(0.4, hsl(emHue, 95, 78, 0.85))
      core.addColorStop(1, hsl(emHue, 90, 60, 0))
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx2, baseY, 12, 0, Math.PI * 2)
      ctx.fill()

      ctx.restore()
    }

}
