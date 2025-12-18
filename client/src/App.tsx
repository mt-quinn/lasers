import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import { createInitialRunState, type RunState } from './game/runState'
import { stepSim } from './game/sim'
import { drawFrame } from './render/draw'
import { clamp } from './game/math'
import { applyOffer, computeXpCap, getRarityColor } from './game/levelUp'

type HudSnapshot = {
  dps: number
  maxBounces: number
  blocksDestroyed: number
  lives: number
  paused: boolean
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const hudBucketRef = useRef<number>(-1)
  const safeProbeRef = useRef<HTMLDivElement | null>(null)

  const stateRef = useRef<RunState>(createInitialRunState())

  const [hud, setHud] = useState<HudSnapshot>(() => ({
    dps: stateRef.current.stats.dps,
    maxBounces: stateRef.current.stats.maxBounces,
    blocksDestroyed: 0,
    lives: stateRef.current.lives,
    paused: false,
  }))

  const setPaused = useCallback((paused: boolean) => {
    stateRef.current.paused = paused
    setHud((h) => ({ ...h, paused }))
  }, [])

  // Pointer input: touch anywhere -> slider position + aim direction.
  useEffect(() => {
    const getLocal = (e: PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      return {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        w: rect.width,
        h: rect.height,
      }
    }

    const pickRoleForPointerDown = (localY: number, viewH: number) => {
      // Bottom band is primarily for the slider finger.
      const controlBand = 140
      return localY >= viewH - controlBand ? 'move' : 'aim'
    }

    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current
      const local = getLocal(e)
      if (!local) return

      const preferredRole =
        e.pointerType === 'mouse' ? 'aim' : pickRoleForPointerDown(local.y, local.h)

      const assign = (role: 'aim' | 'move') => {
        if (role === 'aim') {
          s.input.aimPointerId = e.pointerId
          s.input.aimActive = true
          s.input.aimX = local.x
          s.input.aimY = local.y
        } else {
          s.input.movePointerId = e.pointerId
          s.input.moveActive = true
          s.input.moveX = local.x
          s.input.moveY = local.y
        }
      }

      // Assign to preferred role if free; otherwise use the other role if free.
      if (preferredRole === 'aim') {
        if (s.input.aimPointerId == null) assign('aim')
        else if (s.input.movePointerId == null && e.pointerType !== 'mouse') assign('move')
      } else {
        if (s.input.movePointerId == null) assign('move')
        else if (s.input.aimPointerId == null) assign('aim')
      }
    }

    const onPointerMove = (e: PointerEvent) => {
      const s = stateRef.current
      const local = getLocal(e)
      if (!local) return

      // Desktop UX: while the mouse is inside the play area, aim should track
      // the cursor continuously (no click needed).
      if (e.pointerType === 'mouse') {
        const inside =
          local.x >= 0 && local.x <= local.w && local.y >= 0 && local.y <= local.h
        if (inside) {
          // Reticle follows mouse while inside; stays where it was when you leave.
          s.reticle.x = local.x
          s.reticle.y = local.y
        }
      }

      if (s.input.aimPointerId === e.pointerId) {
        s.input.aimActive = true
        s.input.aimX = local.x
        s.input.aimY = local.y
        // Touch/stylus aim updates reticle; reticle remains stationary after release.
        s.reticle.x = local.x
        s.reticle.y = local.y
      }
      if (s.input.movePointerId === e.pointerId) {
        s.input.moveActive = true
        s.input.moveX = local.x
        s.input.moveY = local.y
      }
    }

    const onPointerUp = (e: PointerEvent) => {
      const s = stateRef.current
      if (s.input.aimPointerId === e.pointerId) {
        // Mouse aiming is hover-driven; don't disable aim on mouseup.
        if (e.pointerType !== 'mouse') {
          s.input.aimPointerId = null
          s.input.aimActive = false
        }
      }
      if (s.input.movePointerId === e.pointerId) {
        s.input.movePointerId = null
        s.input.moveActive = false
      }
    }

    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [])

  // Keyboard movement: left/right arrows + A/D.
  useEffect(() => {
    const setKey = (e: KeyboardEvent, isDown: boolean) => {
      const s = stateRef.current
      const k = e.key
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') {
        s.input.keyLeft = isDown
        e.preventDefault()
      } else if (k === 'ArrowRight' || k === 'd' || k === 'D') {
        s.input.keyRight = isDown
        e.preventDefault()
      }
    }
    const onDown = (e: KeyboardEvent) => setKey(e, true)
    const onUp = (e: KeyboardEvent) => setKey(e, false)
    window.addEventListener('keydown', onDown, { passive: false })
    window.addEventListener('keyup', onUp, { passive: false })
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
    }
  }, [])

  // Esc toggles the upgrade menu (and pauses/resumes accordingly).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.repeat) return
      e.preventDefault()
      setPaused(!stateRef.current.paused)
    }
    window.addEventListener('keydown', onKeyDown, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [setPaused])

  // Main loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const s = stateRef.current
    let last = performance.now()

    // Probe element to reliably resolve env(safe-area-inset-bottom) on mobile browsers.
    // (Reading CSS variables can return "env(...)" instead of a computed px value.)
    if (!safeProbeRef.current) {
      const el = document.createElement('div')
      el.style.position = 'fixed'
      el.style.left = '0'
      el.style.right = '0'
      el.style.bottom = '0'
      el.style.height = '0'
      el.style.paddingBottom = 'env(safe-area-inset-bottom)'
      el.style.pointerEvents = 'none'
      el.style.visibility = 'hidden'
      document.body.appendChild(el)
      safeProbeRef.current = el
    }

    const resize = () => {
      const dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1))
      const parent = canvas.parentElement
      if (!parent) return
      const rect = parent.getBoundingClientRect()
      const w = Math.max(1, rect.width)
      const h = Math.max(1, rect.height)
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      s.view.dpr = dpr
      s.view.width = w
      s.view.height = h

      // Read safe-area bottom inset as a resolved px value via the probe element.
      const probe = safeProbeRef.current
      if (probe) {
        const pb = window.getComputedStyle(probe).paddingBottom
        const safeBottom = parseFloat(pb)
        s.view.safeBottom = Number.isFinite(safeBottom) ? safeBottom : 0
      } else {
        s.view.safeBottom = 0
      }

      // Keep reticle within the arena bounds after resize.
      s.reticle.x = clamp(s.reticle.x, 0, w)
      s.reticle.y = clamp(s.reticle.y, 0, h)
    }

    resize()
    window.addEventListener('resize', resize)

    const tick = (now: number) => {
      // Use variable dt for simulation so damage/visuals update every frame even on
      // 90/120Hz displays (fixed-step would "pause" every other frame).
      const dtSec = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!s.paused) stepSim(s, dtSec)

      drawFrame(canvas, s)

      // HUD: update at ~10fps to keep React cheap (avoid depending on React state inside RAF).
      const bucket = Math.floor(now / 100)
      if (bucket !== hudBucketRef.current) {
        hudBucketRef.current = bucket
        setHud({
          dps: s.stats.dps,
          maxBounces: s.stats.maxBounces,
          blocksDestroyed: s.blocksDestroyed,
          lives: s.lives,
          paused: s.paused,
        })
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('resize', resize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (safeProbeRef.current) {
        safeProbeRef.current.remove()
        safeProbeRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const restart = useCallback(() => {
    stateRef.current = createInitialRunState()
    setHud({
      dps: stateRef.current.stats.dps,
      maxBounces: stateRef.current.stats.maxBounces,
      blocksDestroyed: 0,
      lives: stateRef.current.lives,
      paused: false,
    })
  }, [])

  return (
    <div className="lg-viewport">
      <div className="lg-shell">
        <header className="hudBar">
          <div className="hudTitle">Big Lasers</div>

          <div className="hudStats" aria-label="Run stats">
            <div className="hudKvp">
              <span className="k">DPS</span>
              <span className="v">{hud.dps.toFixed(0)}</span>
            </div>
            <div className="hudKvp">
              <span className="k">Bounces</span>
              <span className="v">{hud.maxBounces}</span>
            </div>
            <div className="hudKvp">
              <span className="k">Destroyed</span>
              <span className="v">{hud.blocksDestroyed}</span>
            </div>
            <div className="hudKvp">
              <span className="k">Lives</span>
              <span className="v">{hud.lives}/3</span>
            </div>
          </div>

          <div className="hudActions">
            <button type="button" className="hudBtn primary" onClick={() => setPaused(!hud.paused)}>
              {hud.paused ? 'Play' : 'Pause'}
            </button>
          </div>
        </header>

        <main className="lg-main">
          <div className="lg-arena">
            <canvas ref={canvasRef} className="lg-canvas" />

            {stateRef.current.levelUpActive && (
              <div className="upgradeOverlay" role="dialog" aria-label="Choose an upgrade">
                <div className="upgradePanel">
                  <div className="upgradeHeader">
                    <div className="upgradeHeaderLeft">
                      <div className="upgradeTitle">Choose an Upgrade</div>
                      <div className="upgradeSub">Select one</div>
                    </div>
                  </div>
                  <div className="upgradeList" aria-label="Upgrade choices">
                    {stateRef.current.levelUpOptions.map((opt, idx) => (
                      <button
                        key={opt.type + opt.rarity + idx}
                        type="button"
                        className="upgradeTile"
                        style={{ borderColor: `${getRarityColor(opt.rarity)}55` }}
                        onClick={() => {
                          const s = stateRef.current
                          applyOffer(s, opt)
                          s.level += 1
                          s.xpCap = computeXpCap(s.level)
                          s.levelUpActive = false
                          s.levelUpOptions = []
                          // Micro "breather" after choices so the board doesn't immediately re-spawn into pressure.
                          s.spawnTimer = Math.max(s.spawnTimer, 0.75)
                          // Resume; sim will re-open if more pending levels.
                          s.paused = false
                        }}
                      >
                        <div className="upgradeTileMain">
                          <div className="upgradeTileName">
                            {opt.title} ({opt.rarity})
                          </div>
                          <div className="upgradeTileDesc">{opt.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}


