import type { FrameCtx } from '../frame'
import { PIECE_EXTRUDE, lerp } from '../frame'
import { clamp } from '../../game/math'
import { XP_ORB_CONDENSE_DUR, XP_ORB_FLY_DUR } from '../../game/runState'

export const drawWorldFxPass = (c: FrameCtx) => {
  const { ctx, s, layout, project, scaleAt, tNow, hueAt, heat } = c
    // XP orbs (condense -> fly).
    if (s.xpOrbs.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      for (const orb of s.xpOrbs) {
        // The orb starts on the (projected) dying piece and flies to the XP
        // gauge, which is screen-space HUD. So project the start, then lerp in
        // screen space toward the unprojected gauge target, easing the depth
        // scale back to 1 as it arrives at the HUD.
        const fromS = project(orb.from.x, orb.from.y)
        const tt = Math.pow(clamp(orb.t / XP_ORB_FLY_DUR, 0, 1), 0.75)
        const px = orb.phase === 'condense' ? fromS.x : fromS.x + (orb.to.x - fromS.x) * tt
        const py = orb.phase === 'condense' ? fromS.y : fromS.y + (orb.to.y - fromS.y) * tt
        const z = orb.phase === 'condense' ? fromS.scale : lerp(fromS.scale, 1, tt)
        const r = (orb.phase === 'condense' ? 16 * (1 - clamp(orb.t / XP_ORB_CONDENSE_DUR, 0, 1)) + 4 : 5) * z
        // Dead-piece ember: follows the live hue (red when music off).
        const oHue = hueAt(orb.from.x, orb.from.y)
        ctx.fillStyle = heat(oHue, 255, 59, 92, 85, 60, 0.32)
        ctx.beginPath()
        ctx.arc(px, py, r * 2.2, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = heat(oHue, 255, 59, 92, 85, 62, 0.92)
        ctx.beginPath()
        ctx.arc(px, py, r, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.restore()
    }

    // Heat motes: glowing debris from destroyed blocks. Loose motes hover in the
    // field (world-space, projected like sparks); once the well captures one it
    // flies (screen-space) to the heat gauge and winks out as it delivers.
    if (s.heatMotes.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'
      const hgw = layout.xpGauge.w
      const hgh = layout.xpGauge.h
      const gaugeTx = layout.xpGauge.x + hgw / 2
      const gaugeTy = layout.xpGauge.y + (hgh - hgh * clamp(s.heat, 0, 1))
      ctx.lineCap = 'round'
      for (const m of s.heatMotes) {
        const mHue = hueAt(m.x, m.y)
        // Surge-spawned debris is worth a fraction of charge, so it reads dimmer.
        const dimMul = m.dim ? 0.5 : 1
        if (m.collecting) {
          // Fly from the projected capture point to the screen-space gauge, with a
          // short comet tail pointing back along the flight path.
          const tt = Math.pow(clamp(m.ct / m.cdur, 0, 1), 0.7)
          const fromS = project(m.cfx, m.cfy)
          const px = fromS.x + (gaugeTx - fromS.x) * tt
          const py = fromS.y + (gaugeTy - fromS.y) * tt
          const z = lerp(fromS.scale, 1, tt)
          const r = (2.2 + 1.8 * (1 - tt)) * z + 1.4
          const dxs = gaugeTx - fromS.x
          const dys = gaugeTy - fromS.y
          const dl = Math.hypot(dxs, dys) || 1
          const tlen = (14 + 26 * (1 - tt)) * z
          const bx = px - (dxs / dl) * tlen
          const by = py - (dys / dl) * tlen
          ctx.strokeStyle = heat(mHue, 255, 150, 70, 85, 60, 0.5 * dimMul)
          ctx.lineWidth = Math.max(1, r * 1.1)
          ctx.beginPath()
          ctx.moveTo(bx, by)
          ctx.lineTo(px, py)
          ctx.stroke()
          ctx.fillStyle = heat(mHue, 255, 180, 90, 85, 66, 0.32 * dimMul)
          ctx.beginPath()
          ctx.arc(px, py, r * 2.4, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = heat(mHue, 255, 222, 140, 85, 72, 0.95 * dimMul)
          ctx.beginPath()
          ctx.arc(px, py, r, 0, Math.PI * 2)
          ctx.fill()
          ctx.fillStyle = `rgba(255,250,240,${(0.9 * dimMul).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(px, py, Math.max(0.7, r * 0.5), 0, Math.PI * 2)
          ctx.fill()
        } else {
          // Loose ember: a flickering hot cinder with a velocity-aligned tail. At
          // rest it twinkles like a coal; once the well hooks it the tail stretches
          // into a bright streak racing inward.
          const flick = 0.7 + 0.3 * Math.sin(tNow * (8 + (m.seed % 5)) + m.seed)
          const sp = project(m.x, m.y - s.dropAnimOffset)
          const z = sp.scale
          const a = (m.hooked ? 1 : 0.9) * flick * dimMul
          const r = m.size * 0.85 * z + 0.9
          // LOD: far up the board a mote is only a few px; the halo/tail/twinkle
          // are imperceptible there, so collapse to a single ember dot.
          // Keeps full detail for near motes.
          if (z < 0.32) {
            ctx.fillStyle = heat(mHue, 255, 205, 115, 85, 66, 0.95 * a)
            ctx.beginPath()
            ctx.arc(sp.x, sp.y, Math.max(0.8, r * 1.15), 0, Math.PI * 2)
            ctx.fill()
            continue
          }
          const speed = Math.hypot(m.vx, m.vy)
          const dirx = speed > 1e-3 ? m.vx / speed : 0
          const diry = speed > 1e-3 ? m.vy / speed : 0
          const tailLen = Math.min(36, speed * 0.026 + (m.hooked ? 9 : 1.5))
          const back = project(m.x - dirx * tailLen, m.y - diry * tailLen - s.dropAnimOffset)

          // Soft outer glow.
          ctx.fillStyle = heat(mHue, 255, 150, 70, 82, 60, 0.22 * a)
          ctx.beginPath()
          ctx.arc(sp.x, sp.y, r * 2.8, 0, Math.PI * 2)
          ctx.fill()

          // Comet tail: warm wide pass + bright thin core.
          ctx.strokeStyle = heat(mHue, 255, 120, 50, 85, 58, 0.4 * a)
          ctx.lineWidth = Math.max(1, r * 1.3)
          ctx.beginPath()
          ctx.moveTo(back.x, back.y)
          ctx.lineTo(sp.x, sp.y)
          ctx.stroke()
          ctx.strokeStyle = heat(mHue, 255, 210, 120, 88, 70, 0.72 * a)
          ctx.lineWidth = Math.max(0.8, r * 0.6)
          ctx.beginPath()
          ctx.moveTo(back.x, back.y)
          ctx.lineTo(sp.x, sp.y)
          ctx.stroke()

          // White-hot head.
          ctx.fillStyle = `rgba(255,250,240,${(0.92 * a).toFixed(3)})`
          ctx.beginPath()
          ctx.arc(sp.x, sp.y, Math.max(0.8, r * 0.7), 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.restore()
    }

    // Welding hit FX sparks at beam contact points. (The on-piece hot-spot glow
    // is baked into the piece body in drawPieceBody so it rides the 3D top face;
    // here we only fling the sparks, lifted onto that top face.)
    if (s.sparks.length > 0) {
      ctx.save()
      ctx.globalCompositeOperation = 'lighter'

      // Lift FX off the plane onto the piece top face (sparks spawn at beam/piece
      // contacts). The GL shader raises a point of height z up-screen by z*scale.
      const fxLift = (s.blocks[0]?.cellSize ?? 40) * PIECE_EXTRUDE
      const projLifted = (x: number, y: number) => {
        const pp = project(x, y)
        pp.y -= fxLift * pp.scale
        return pp
      }

      // Sparks
      for (const p of s.sparks) {
        const t = clamp(p.age / Math.max(0.0001, p.life), 0, 1)
        const a = (1 - t) * (0.45 + 0.65 * p.heat)
        // Hot metal spark: white -> yellow -> hue-tinted tail (rainbow with the
        // music; pink when off). Cold "deflection" sparks (armored shield hit)
        // instead read icy blue-white so a no-damage hit is unmistakable.
        const c0 = p.cold
          ? `rgba(232,244,255,${0.95 * a})`
          : `rgba(255,252,240,${0.95 * a})`
        const c1 = p.cold
          ? `rgba(150,200,255,${0.8 * a})`
          : `rgba(255,210,140,${0.75 * a})`
        const c2 = p.cold
          ? `rgba(90,150,235,${0.5 * a})`
          : heat(hueAt(p.x, p.y), 255, 120, 210, 85, 65, 0.35 * a)

        const tail = 0.018 + 0.022 * p.heat
        // Project the streak endpoints (lifted onto the piece top face) and scale
        // its weight with depth.
        const z = scaleAt(p.y)
        const head = projLifted(p.x, p.y)
        const back = projLifted(p.x - p.vx * tail, p.y - p.vy * tail)

        ctx.lineCap = 'round'
        ctx.lineWidth = Math.max(1, p.size) * z
        ctx.strokeStyle = c2
        ctx.beginPath()
        ctx.moveTo(back.x, back.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()

        ctx.lineWidth = Math.max(0.8, p.size * 0.65) * z
        ctx.strokeStyle = c1
        ctx.beginPath()
        ctx.moveTo(back.x, back.y)
        ctx.lineTo(head.x, head.y)
        ctx.stroke()

        ctx.fillStyle = c0
        ctx.beginPath()
        ctx.arc(head.x, head.y, Math.max(0.9, p.size * 0.55) * z, 0, Math.PI * 2)
        ctx.fill()
      }

      ctx.restore()
    }

}
