import type { FrameCtx } from '../frame'
import { clamp } from '../../game/math'
import { PALETTE } from '../theme'
import {
  COMBO_PIERCE_TIER1,
  COMBO_PIERCE_TIER2,
  COMBO_SCORE_MULT_CAP,
  COMBO_WINDOW_SEC,
} from '../../game/sim'

export const drawHudPass = (c: FrameCtx) => {
  const { ctx, s, layout, project, mi, mHue, hsl, roundedRectPath } = c
    // HUD module: bottom-right L-shape (single container + single outline).
    const gx = layout.xpGauge.x
    const gy = layout.xpGauge.y
    const gw = layout.xpGauge.w
    const gh = layout.xpGauge.h
    // Heat meter: the vertical bar charges as you chain kills and, when full,
    // fires Overdrive (a beam surge); during the surge it drains back to empty.
    const heatFrac = clamp(s.heat, 0, 1)
    const overdriveOn = s.overdriveSec > 0
    const comboMult =
      s.combo > 0 ? Math.min(COMBO_SCORE_MULT_CAP, 1 + 0.1 * (s.combo - 1)) : 1
    // Active combo pierce tier (the beam rakes +N extra blocks while hot).
    const comboPierceTier =
      s.combo >= COMBO_PIERCE_TIER2 ? 2 : s.combo >= COMBO_PIERCE_TIER1 ? 1 : 0
    // The corner dial ring now reflects the crescendo (big-play surge).
    const crescendoArc = clamp(s.crescendo, 0, 1)

    // Geometry: union shape = vertical bar (xp) + horizontal cap (stats), with a dial in the elbow.
    const barX = gx
    const barY = gy
    const barW = gw
    const barH = gh
    const cutRight = s.view.width
    const cutBottom = layout.failY
    const bottomY = barY + barH
    // Horizontal leg height: just enough for the inline score readout with padding.
    const capH = 36
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
    bg.addColorStop(0, 'rgba(9, 12, 22, 0.72)')
    bg.addColorStop(1, 'rgba(6, 8, 16, 0.58)')
    ctx.fillStyle = bg
    lPath(outerR)
    ctx.fill()
    // Panel edge: subtly rides the music hue when playing (cold cyan when off),
    // so the HUD frame breathes with the rest of the scene without losing legibility.
    ctx.strokeStyle = mi > 0 ? hsl(mHue, 70, 78, 0.2) : 'rgba(143, 224, 255, 0.16)'
    ctx.lineWidth = 1.25
    lPath(outerR)
    ctx.stroke()
    ctx.restore()

    // XP groove + fill (kept above the dial so nothing overlaps).
    {
      const gx2 = barX + 7
      // Extra top padding reserves a clean header band for the charge % readout
      // above the groove (so it never crowds the bar or the 25% markers).
      const gy2 = barY + 22
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

      // Armed = topped out and banked, waiting for the player's tap. A slower,
      // brighter "breathing" gold pulse so the gauge reads READY — distinct from
      // the faster flicker of an in-progress surge.
      const armed = s.overdriveArmed && !overdriveOn
      const charged = overdriveOn || armed
      const odPulse = overdriveOn ? 0.7 + 0.3 * Math.sin(s.timeSec * 18) : 1
      const armPulse = 0.6 + 0.4 * Math.sin(s.timeSec * 6.5)
      const pulseA = overdriveOn ? odPulse : armed ? armPulse : 1

      const fh = gh2 * heatFrac
      ctx.globalCompositeOperation = 'lighter'
      // Heat fill: a warm "charge" that brightens as it fills; charged (armed or
      // mid-surge) it flips to a pulsing white-gold.
      const heatHue = charged ? 45 : 28
      const heatA = (overdriveOn ? 0.55 : armed ? 0.6 : 0.2 + 0.25 * heatFrac) * pulseA
      ctx.fillStyle = hsl(heatHue, 95, 58, heatA)
      roundedRectPath(gx2, gy2 + (gh2 - fh), gw2, fh, 10)
      ctx.fill()
      ctx.fillStyle = hsl(heatHue, 98, charged ? 90 : 62 + 16 * heatFrac, 0.82 * pulseA)
      roundedRectPath(gx2 + 1, gy2 + (gh2 - fh) + 1, gw2 - 2, Math.max(0, fh - 2), 9)
      ctx.fill()

      // Banking the NEXT charge: motes collected during a surge bank separately
      // and seed the next charge when the surge ends. Show it as a cool-cyan
      // underlay rising from the bottom (distinct from the draining gold surge),
      // so collecting mid-Overdrive visibly pays.
      if (overdriveOn && s.heatNext > 0) {
        const bh = gh2 * clamp(s.heatNext, 0, 1)
        ctx.fillStyle = hsl(190, 92, 62, 0.5)
        roundedRectPath(gx2 + 2, gy2 + (gh2 - bh), gw2 - 4, bh, 9)
        ctx.fill()
      }

      // Segment the groove into 4 pips at 25/50/75% so partial charge reads at a
      // glance. Engraved look: a dark cut with a 1px light bevel beneath, plus
      // bright nubs biting in from both edges so the divisions stay distinct over
      // the fill instead of washing out.
      ctx.globalCompositeOperation = 'source-over'
      const nub = 4
      for (let i = 1; i < 4; i++) {
        const ty2 = Math.round(gy2 + (gh2 * i) / 4) + 0.5
        // Engraved groove line: dark cut + light bevel highlight below it.
        ctx.strokeStyle = 'rgba(0,0,0,0.5)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(gx2 + 2, ty2)
        ctx.lineTo(gx2 + gw2 - 2, ty2)
        ctx.stroke()
        ctx.strokeStyle = 'rgba(255,255,255,0.14)'
        ctx.beginPath()
        ctx.moveTo(gx2 + 2, ty2 + 1)
        ctx.lineTo(gx2 + gw2 - 2, ty2 + 1)
        ctx.stroke()
        // Edge nubs: short, bright ticks biting inward from each side.
        ctx.strokeStyle = 'rgba(255,255,255,0.55)'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(gx2, ty2)
        ctx.lineTo(gx2 + nub, ty2)
        ctx.moveTo(gx2 + gw2 - nub, ty2)
        ctx.lineTo(gx2 + gw2, ty2)
        ctx.stroke()
      }
      ctx.globalCompositeOperation = 'lighter'

      // Armed: a breathing glow ring hugging the whole groove so the charged
      // meter pops even in peripheral vision while the eye is on the beam.
      if (armed) {
        ctx.save()
        ctx.shadowColor = hsl(45, 100, 65, 0.9)
        ctx.shadowBlur = 10 + 12 * armPulse
        ctx.strokeStyle = hsl(48, 100, 72, 0.5 + 0.4 * armPulse)
        ctx.lineWidth = 2
        roundedRectPath(gx2, gy2, gw2, gh2, 10)
        ctx.stroke()
        ctx.restore()
      }

      // Groove label. Normal play: the charge level (0-100%), so the "+N" mote
      // floaters visibly accrue toward it (the combo multiplier moved to the
      // score leg, where it reads as the score multiplier it is). Armed: a
      // vertical "TAP TO FIRE" running up the bar — it fits the tall, narrow
      // gauge and fuses the ready-state with the call-to-action.
      ctx.globalCompositeOperation = 'source-over'
      const cxBar = barX + barW / 2
      if (armed) {
        ctx.save()
        ctx.translate(cxBar, gy2 + gh2 / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        try {
          ctx.letterSpacing = '3px'
        } catch {
          /* older engines: skip */
        }
        ctx.font = "900 15px 'Oxanium', system-ui, sans-serif"
        // Dark ink on the bright gold fill (with a faint light halo so it stays
        // crisp); a gentle alpha breath keeps it alive.
        ctx.shadowColor = hsl(50, 100, 92, 0.55)
        ctx.shadowBlur = 5
        ctx.fillStyle = `rgba(36,22,0,${(0.82 + 0.18 * armPulse).toFixed(3)})`
        ctx.fillText('TAP TO FIRE', 0, 0)
        try {
          ctx.letterSpacing = '0px'
        } catch {
          /* noop */
        }
        ctx.restore()
      } else {
        // Bespoke charge readout: a clean number seated in the header band ABOVE
        // the groove (out of the 25% marker zone). Sized to fit the narrow 34px
        // bar with comfortable padding — the digits carry the value, with a small
        // raised "%" superscript. (At 100% the bar arms and shows TAP TO FIRE, so
        // this only ever renders 1-2 digits.)
        const pct = Math.round(heatFrac * 100)
        const numStr = `${pct}`
        const hy = barY + 12
        const numFont = "800 13px 'Oxanium', system-ui, sans-serif"
        const pctFont = "800 8px 'Oxanium', system-ui, sans-serif"
        const gap = 1.5
        ctx.save()
        ctx.textBaseline = 'middle'
        ctx.shadowColor = 'rgba(0,0,0,0.6)'
        ctx.shadowBlur = 3
        ctx.font = numFont
        const numW = ctx.measureText(numStr).width
        ctx.font = pctFont
        const pctW = ctx.measureText('%').width
        const total = numW + gap + pctW
        const startX = cxBar - total / 2
        const lift = 16 + 30 * heatFrac
        // Number — warms and brightens as the charge climbs.
        ctx.textAlign = 'left'
        ctx.font = numFont
        ctx.fillStyle = hsl(44, 92, 56 + lift, 0.72 + 0.28 * heatFrac)
        ctx.fillText(numStr, startX, hy)
        // "%" — smaller, dimmer, raised as a superscript for a polished look.
        ctx.font = pctFont
        ctx.fillStyle = hsl(44, 70, 66 + lift * 0.4, 0.55 + 0.3 * heatFrac)
        ctx.fillText('%', startX + numW + gap, hy - 3)
        ctx.restore()
      }
      ctx.restore()
    }

    // Gauge floaters: "+N" feedback popped on mote collection so the player SEES
    // a pickup's worth — and that combo/gold make motes worth more. Color codes
    // the state: gold charge, cool-cyan banked-to-next, bright-gold overflow score.
    if (s.gaugeFx.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      ctx.textBaseline = 'middle'
      for (const fx of s.gaugeFx) {
        const p = clamp(fx.t / fx.dur, 0, 1)
        const a = (1 - p) * 0.95
        const col =
          fx.kind === 'score'
            ? hsl(45, 100, 70, a)
            : fx.kind === 'bank'
              ? hsl(190, 92, 72, a)
              : hsl(48, 96, 78, a)
        ctx.fillStyle = col
        if (fx.x != null && fx.y != null) {
          // Anchored (overflow score absorbed by the well): projected + lifted
          // above the hole so it clears the player's finger.
          ctx.font = "900 13px 'Oxanium', system-ui, sans-serif"
          ctx.textAlign = 'center'
          const jitter = ((fx.id % 5) - 2) * 7
          let ax = fx.x
          let ay = fx.y
          if (fx.world) {
            const wp = project(fx.x, fx.y)
            ax = wp.x
            ay = wp.y - 44
          }
          ctx.fillText(fx.text, ax + jitter, ay - 30 * p)
        } else {
          // Gauge stream: a staggered ledger rising just LEFT of the bar. Five
          // vertical slots keyed off the id keep rapid pickups from piling onto
          // each other, and right-alignment keeps them clear of the bar/markers.
          ctx.font = "800 12px 'Oxanium', system-ui, sans-serif"
          ctx.textAlign = 'right'
          const slot = fx.id % 5
          const baseY = barY + 20 + slot * 13
          ctx.fillText(fx.text, barX - 8, baseY - 34 * p)
        }
      }
      ctx.restore()
    }

    // Corner dial: DEPTH (the primary "how deep" stat). The ring now lights with
    // the crescendo so big plays flare the HUD.
    {
      const cx = dialCX
      const cy = dialCY
      const rr = dialR
      const dialHue = mi > 0 ? mHue : PALETTE.latticeHue
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

      // Crescendo ring (full sweep, brightness driven by the surge).
      if (crescendoArc > 0.02) {
        ctx.globalCompositeOperation = 'lighter'
        ctx.strokeStyle = hsl(dialHue, 95, 65, 0.25 + 0.6 * crescendoArc)
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(cx, cy, rr - 1.5, 0, Math.PI * 2)
        ctx.stroke()
      }

      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "950 15px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = 'rgba(255,246,213,0.95)'
      ctx.fillText(`${s.depth}`, cx, cy + 0.5)
      ctx.restore()
    }

    // Score readout in the leg. The score is the hero, right-anchored at the dial
    // so it never leaps. The combo multiplier is restrained gold text grouped
    // immediately to the LEFT of the score (gold = its identity, distinct from the
    // white score it multiplies) — it brightens with a quick lift on each kill and
    // fades as the window lapses. No pill: it matches the HUD's text-readout style.
    {
      const insetR = dialCX - dialR - 20
      const ty = capY + capH / 2 + 0.5
      const scoreStr = s.score.toLocaleString()
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.textBaseline = 'middle'
      // Score (hero).
      ctx.textAlign = 'right'
      ctx.font = "900 17px 'Oxanium', system-ui, sans-serif"
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 3
      ctx.fillStyle = 'rgba(255,248,232,0.98)'
      ctx.fillText(scoreStr, insetR, ty)
      const scoreW = ctx.measureText(scoreStr).width
      ctx.shadowBlur = 0
      // Combo multiplier — gold text just left of the score.
      if (comboMult > 1) {
        const fresh = clamp((s.comboTimerSec - 3.55) / 0.45, 0, 1)
        const fade = clamp(s.comboTimerSec / 0.5, 0, 1)
        const label = `×${comboMult.toFixed(1)}`
        // Reactive: ride the music hue (like the rest of the scene); fall back to
        // the gold accent when music is off.
        const comboHue = mi > 0 ? mHue : 46
        ctx.textAlign = 'right'
        ctx.font = "800 14px 'Oxanium', system-ui, sans-serif"
        // Warmup COMBO beat: a fitted glowing pill behind the multiplier so the
        // player's eye is drawn to the thing the callout is talking about.
        if (s.tutorial?.phase === 'warmup' && s.tutorial.beat === 'combo') {
          const lw = ctx.measureText(label).width
          const lx = insetR - scoreW - 9
          const pulse = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(s.timeSec * 4))
          ctx.save()
          ctx.globalCompositeOperation = 'screen'
          ctx.lineWidth = 2.5
          ctx.strokeStyle = hsl(46, 100, 70, 0.9 * pulse)
          ctx.shadowColor = hsl(46, 100, 64, 0.85)
          ctx.shadowBlur = 14
          roundedRectPath(lx - lw - 7, ty - 12, lw + 14, 24, 8)
          ctx.stroke()
          ctx.restore()
        }
        ctx.shadowColor = hsl(comboHue, 100, 60, (0.5 + 0.4 * fresh) * fade)
        ctx.shadowBlur = 5 + 6 * fresh
        ctx.fillStyle = hsl(comboHue, 100, 62 + 12 * fresh, (0.85 + 0.15 * fresh) * fade)
        ctx.fillText(label, insetR - scoreW - 9, ty)
        ctx.shadowBlur = 0
        // Draining window bar above the multiplier: the rolling combo window
        // made visible (full = just refreshed, empty = about to halve), so
        // keeping the chain alive is a conscious skill instead of a hidden
        // timer. Cools from the combo hue to amber to red as it runs out,
        // with a pulse in the final stretch.
        {
          const frac = clamp(s.comboTimerSec / COMBO_WINDOW_SEC, 0, 1)
          const lw = ctx.measureText(label).width
          const bx1 = insetR - scoreW - 9 // right edge (label is right-aligned)
          const bx0 = bx1 - lw
          const by = ty - 10.5
          ctx.lineCap = 'round'
          ctx.lineWidth = 2
          ctx.strokeStyle = hsl(comboHue, 30, 40, 0.28)
          ctx.beginPath()
          ctx.moveTo(bx0, by)
          ctx.lineTo(bx1, by)
          ctx.stroke()
          const barHue = frac > 0.5 ? comboHue : frac > 0.25 ? 38 : 4
          const pulse = frac < 0.25 ? 0.5 + 0.5 * Math.sin(s.timeSec * 11) : 0
          ctx.strokeStyle = hsl(barHue, 95, 62, 0.72 + 0.28 * pulse)
          ctx.beginPath()
          ctx.moveTo(bx1 - lw * frac, by)
          ctx.lineTo(bx1, by)
          ctx.stroke()
        }
        // Combo pierce tier: a small "PIERCE +N" tag under the multiplier so the
        // earned beam penetration is legible (it's the chain's real payoff).
        if (comboPierceTier > 0) {
          ctx.font = "800 9px 'Oxanium', system-ui, sans-serif"
          ctx.shadowColor = hsl(comboHue, 100, 60, 0.4 * fade)
          ctx.shadowBlur = 4
          ctx.fillStyle = hsl(comboHue, 90, 74, 0.9 * fade)
          ctx.fillText(`PIERCE +${comboPierceTier}`, insetR - scoreW - 9, ty + 13)
          ctx.shadowBlur = 0
        }
      }
      ctx.restore()
    }

    // Best score readout: a small, dim line above the leg (its original home), so
    // the leg's proportions stay clean.
    if (s.bestScoreLocal > 0 || s.score > 0) {
      const bestLive = Math.max(s.bestScoreLocal, s.score)
      const label = `BEST ${bestLive.toLocaleString()}`
      ctx.save()
      ctx.globalCompositeOperation = 'source-over'
      ctx.font = "800 12px 'Oxanium', system-ui, sans-serif"
      ctx.textAlign = 'right'
      ctx.textBaseline = 'alphabetic'
      ctx.shadowColor = 'rgba(0,0,0,0.5)'
      ctx.shadowBlur = 3
      ctx.fillStyle = hsl(46, 30, 84, 0.62)
      ctx.fillText(label, dialCX - dialR - 20, capY - 12)
      ctx.restore()
    }

}
