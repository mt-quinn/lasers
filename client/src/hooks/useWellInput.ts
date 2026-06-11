import { useEffect } from 'react'
import type { RunState } from '../game/runState'
import { fireOverdrive } from '../game/sim'
import { clamp } from '../game/math'
import { getArenaLayout } from '../game/layout'
import { makeProjection } from '../render/projection'

export type DockActions = { togglePause: () => void; toggleMusic: () => void }

  // Pointer input: the single control surface is the gravity-well puck.
  // Press anywhere -> the well teleports under the finger (momentum cancelled);
  // drag -> it follows; release -> it inherits the flick velocity (a still
  // release parks it). Physics (friction, wall bounces) run in the sim.
export const useWellInput = (opts: {
  stateRef: { current: RunState }
  canvasRef: { current: HTMLCanvasElement | null }
  musicPanelOpenRef: { current: boolean }
  dockActionsRef: { current: DockActions }
}) => {
  const { stateRef, canvasRef, musicPanelOpenRef, dockActionsRef } = opts
  useEffect(() => {
    // Map a pointer event to WORLD space: the well lives in the perspective
    // playfield (like the blocks), so it scales with depth and bounces off the
    // converging walls. We unproject the screen point through the same
    // homography the renderer uses.
    const getPoint = (e: PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const s = stateRef.current
      const layout = getArenaLayout(s.view)
      const proj = makeProjection(s.view, layout)
      const p = proj.unproject(sx, sy)
      // Constrain to the world playfield even while dragging, so the hole can't
      // be pulled outside the perspective space (it stays where you drop it).
      const topWorldY = proj.unproject(s.view.width / 2, 0).y
      p.x = clamp(p.x, 0, s.view.width)
      p.y = clamp(p.y, topWorldY, layout.emitterY)
      return p
    }

    // Ignore presses that land on UI buttons (pause/music) so they don't also
    // drop the well underneath.
    const onUi = (e: PointerEvent) =>
      e.target instanceof Element && e.target.closest('button') != null

    // The STEERING pointer (the one finger dragging the well). A second finger
    // that lands while steering is NOT allowed to grab the well — it's tracked
    // as a tap candidate so you can keep steering with one finger and tap with
    // another to unleash Overdrive in place.
    let steerId: number | null = null
    let lastX = 0
    let lastY = 0
    let lastT = 0
    let vx = 0
    let vy = 0
    // Down position/time of the STEERING pointer in SCREEN px, so its own quick
    // press+release (single-finger tap-to-fire) can be told apart from steering.
    let steerDownCX = 0
    let steerDownCY = 0
    let steerDownT = 0
    // Secondary pointers (extra fingers) tracked as potential taps: id -> down
    // screen pos/time + the farthest it has strayed (to reject drags).
    const taps = new Map<number, { cx: number; cy: number; t: number; moved: number }>()
    const TAP_MAX_MS = 250
    const TAP_MAX_PX = 14

    const isTapGesture = (cx: number, cy: number, t: number, downX: number, downY: number, downT: number) =>
      t - downT <= TAP_MAX_MS && Math.hypot(cx - downX, cy - downY) <= TAP_MAX_PX

    // The on-canvas control dock is hit-tested here (it's drawn in draw.ts, not a
    // DOM button). Returns which button the press landed on, in the dock's base
    // (unwarped) position — the lens displaces the glyph visually but the touch
    // target stays put. A tap toggles it; the gesture is consumed (no well drop).
    const dockHit = (e: PointerEvent): 'pause' | 'music' | null => {
      const canvas = canvasRef.current
      const s = stateRef.current
      if (!canvas || s.gameOver) return null
      const rect = canvas.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const d = getArenaLayout(s.view).dock
      const slop = d.btnR + 6
      if (!s.levelUpActive && Math.hypot(px - d.pause.cx, py - d.pause.cy) <= slop) return 'pause'
      if (Math.hypot(px - d.music.cx, py - d.music.cy) <= slop) return 'music'
      return null
    }
    let dockPress: { id: number; hit: 'pause' | 'music'; cx: number; cy: number } | null = null

    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current
      // While the music panel is open, the overlay scrim owns this tap (it just
      // dismisses the panel). Ignore it here so the dock button doesn't re-toggle
      // and the well doesn't get grabbed.
      if (musicPanelOpenRef.current) return
      if (s.gameOver) return
      // A just-in-time coachmark freezes play; its OK card (DOM) owns input.
      if (s.jit) return
      if (onUi(e)) return
      const hit = dockHit(e)
      if (hit) {
        dockPress = { id: e.pointerId, hit, cx: e.clientX, cy: e.clientY }
        return
      }
      if (steerId === null) {
        // First finger: take steering control — teleport under it and grab.
        const p = getPoint(e)
        if (!p) return
        steerId = e.pointerId
        s.well.pos.x = p.x
        s.well.pos.y = p.y
        s.well.vel.x = 0
        s.well.vel.y = 0
        s.well.grabbed = true
        s.well.placed = true
        lastX = p.x
        lastY = p.y
        lastT = e.timeStamp
        vx = 0
        vy = 0
        steerDownCX = e.clientX
        steerDownCY = e.clientY
        steerDownT = e.timeStamp
        return
      }
      // Another finger while already steering: don't move the well or steal
      // control — just watch for a clean tap to unleash Overdrive.
      taps.set(e.pointerId, { cx: e.clientX, cy: e.clientY, t: e.timeStamp, moved: 0 })
    }

    const onPointerMove = (e: PointerEvent) => {
      const s = stateRef.current
      if (e.pointerId === steerId) {
        const p = getPoint(e)
        if (!p) return
        s.well.pos.x = p.x
        s.well.pos.y = p.y
        // Track pointer velocity (px/sec), lightly smoothed, for the throw.
        const dt = Math.max(0.001, (e.timeStamp - lastT) / 1000)
        vx = vx * 0.4 + ((p.x - lastX) / dt) * 0.6
        vy = vy * 0.4 + ((p.y - lastY) / dt) * 0.6
        lastX = p.x
        lastY = p.y
        lastT = e.timeStamp
        return
      }
      // A secondary finger that strays too far stops counting as a tap.
      const tap = taps.get(e.pointerId)
      if (tap) {
        const d = Math.hypot(e.clientX - tap.cx, e.clientY - tap.cy)
        if (d > tap.moved) tap.moved = d
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const s = stateRef.current
      // Control-dock tap: fire the toggle if the finger lifted on the same button
      // without straying (consumes the gesture so no well drop / overdrive).
      if (dockPress && dockPress.id === e.pointerId) {
        const moved = Math.hypot(e.clientX - dockPress.cx, e.clientY - dockPress.cy)
        const which = dockPress.hit
        dockPress = null
        if (moved <= TAP_MAX_PX) {
          if (which === 'pause') dockActionsRef.current.togglePause()
          else dockActionsRef.current.toggleMusic()
        }
        return
      }
      // Secondary finger lifting: a clean tap fires Overdrive IN PLACE — the
      // steering finger keeps control and the well doesn't move.
      const tap = taps.get(e.pointerId)
      if (tap) {
        taps.delete(e.pointerId)
        const moved = Math.max(tap.moved, Math.hypot(e.clientX - tap.cx, e.clientY - tap.cy))
        if (e.timeStamp - tap.t <= TAP_MAX_MS && moved <= TAP_MAX_PX) fireOverdrive(s)
        return
      }
      if (e.pointerId !== steerId) return
      steerId = null
      s.well.grabbed = false
      // Single-finger tap-to-unleash: a quick press+release that didn't really
      // move fires the surge where the finger landed (the well teleported there
      // on press), and the gesture is consumed so the puck stays put.
      if (
        isTapGesture(e.clientX, e.clientY, e.timeStamp, steerDownCX, steerDownCY, steerDownT) &&
        fireOverdrive(s)
      ) {
        s.well.vel.x = 0
        s.well.vel.y = 0
        return
      }
      // A throw only if the finger was still moving at release; otherwise park.
      const sinceMove = (e.timeStamp - lastT) / 1000
      if (sinceMove > 0.05) {
        vx = 0
        vy = 0
      }
      s.well.vel.x = vx
      s.well.vel.y = vy
    }

    // Cancel (OS gesture, palm rejection, etc.): clean up without firing.
    const onPointerCancel = (e: PointerEvent) => {
      if (dockPress && dockPress.id === e.pointerId) {
        dockPress = null
        return
      }
      if (taps.delete(e.pointerId)) return
      if (e.pointerId !== steerId) return
      steerId = null
      const s = stateRef.current
      s.well.grabbed = false
      s.well.vel.x = 0
      s.well.vel.y = 0
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
    }
    // The args are refs (stable identities); re-subscribing on them would be churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
