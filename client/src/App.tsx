import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import type { UpgradeId } from './game/upgrades'
import { createInitialRunState, type RunState } from './game/runState'
import { getUpgradeDef, listUpgradesInOrder } from './game/upgrades'
import { stepSim } from './game/sim'
import { drawFrame } from './render/draw'

type HudSnapshot = {
  currency: number
  dps: number
  maxBounces: number
  blocksDestroyed: number
  paused: boolean
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const hudBucketRef = useRef<number>(-1)

  const stateRef = useRef<RunState>(createInitialRunState())

  const [upgradeOpen, setUpgradeOpen] = useState(false)
  const [hud, setHud] = useState<HudSnapshot>(() => ({
    currency: 0,
    dps: stateRef.current.stats.dps,
    maxBounces: stateRef.current.stats.maxBounces,
    blocksDestroyed: 0,
    paused: false,
  }))

  const upgrades = useMemo(() => listUpgradesInOrder(), [])

  const setPaused = useCallback((paused: boolean) => {
    stateRef.current.paused = paused
    setHud((h) => ({ ...h, paused }))
  }, [])

  const toggleUpgradeMenu = useCallback(() => {
    setUpgradeOpen((open) => {
      const next = !open
      setPaused(next)
      return next
    })
  }, [setPaused])

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
          s.input.aimPointerId = e.pointerId
          s.input.aimActive = true
          s.input.aimX = local.x
          s.input.aimY = local.y
        } else if (s.input.aimPointerId === e.pointerId) {
          s.input.aimActive = false
        }
      }

      if (s.input.aimPointerId === e.pointerId) {
        s.input.aimActive = true
        s.input.aimX = local.x
        s.input.aimY = local.y
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
      toggleUpgradeMenu()
    }
    window.addEventListener('keydown', onKeyDown, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [toggleUpgradeMenu])

  // Main loop.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const s = stateRef.current
    let last = performance.now()
    let accumulator = 0
    const FIXED_DT = 1 / 60

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

      // Read safe-area bottom inset via CSS custom property (px).
      const rootStyle = window.getComputedStyle(document.documentElement)
      const safeBottomStr = rootStyle.getPropertyValue('--safe-area-bottom').trim()
      const safeBottom = safeBottomStr.endsWith('px') ? Number(safeBottomStr.replace('px', '')) : Number(safeBottomStr)
      s.view.safeBottom = Number.isFinite(safeBottom) ? safeBottom : 0
    }

    resize()
    window.addEventListener('resize', resize)

    const tick = (now: number) => {
      const dtSec = Math.min(0.05, (now - last) / 1000)
      last = now
      accumulator += dtSec

      while (accumulator >= FIXED_DT) {
        if (!s.paused) {
          stepSim(s, FIXED_DT)
        }
        accumulator -= FIXED_DT
      }

      drawFrame(canvas, s)

      // HUD: update at ~10fps to keep React cheap (avoid depending on React state inside RAF).
      const bucket = Math.floor(now / 100)
      if (bucket !== hudBucketRef.current) {
        hudBucketRef.current = bucket
        setHud({
          currency: Math.floor(s.currency),
          dps: s.stats.dps,
          maxBounces: s.stats.maxBounces,
          blocksDestroyed: s.blocksDestroyed,
          paused: s.paused,
        })
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('resize', resize)
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const buyUpgrade = useCallback((id: UpgradeId) => {
    const s = stateRef.current
    const def = getUpgradeDef(id)
    const level = s.upgrades[id] ?? 0
    const cost = def.cost(level)
    if (s.currency < cost) return
    s.currency -= cost
    s.upgrades[id] = level + 1
    def.apply(s, level + 1)

    // micro haptics
    const nav: any = navigator
    if (nav && typeof nav.vibrate === 'function') {
      nav.vibrate(8)
    }

    setHud((h) => ({
      ...h,
      currency: Math.floor(s.currency),
      dps: s.stats.dps,
      maxBounces: s.stats.maxBounces,
    }))
  }, [])

  const restart = useCallback(() => {
    stateRef.current = createInitialRunState()
    setUpgradeOpen(false)
    setHud({
      currency: 0,
      dps: stateRef.current.stats.dps,
      maxBounces: stateRef.current.stats.maxBounces,
      blocksDestroyed: 0,
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
              <span className="k">Currency</span>
              <span className="v">{hud.currency}</span>
            </div>
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
          </div>

          <div className="hudActions">
            <button type="button" className="hudBtn primary" onClick={toggleUpgradeMenu}>
              {upgradeOpen ? 'Resume' : 'Upgrades'}
            </button>
            <button type="button" className="hudBtn" onClick={() => setPaused(!hud.paused)}>
              {hud.paused ? 'Play' : 'Pause'}
            </button>
          </div>
        </header>

        <main className="lg-main">
          <div className="lg-arena">
            <canvas ref={canvasRef} className="lg-canvas" />

            {upgradeOpen && (
              <div className="upgradeOverlay" role="dialog" aria-label="Upgrades">
                <div className="upgradePanel">
                  <div className="upgradeHeader">
                    <div className="upgradeHeaderLeft">
                      <div className="upgradeTitle">Upgrades</div>
                      <div className="upgradeSub">
                        Currency <b>{hud.currency}</b>
                      </div>
                    </div>
                    <div className="upgradeHeaderRight">
                      <button
                        type="button"
                        className="upgradeClose"
                        onClick={toggleUpgradeMenu}
                        aria-label="Close upgrades"
                      >
                        Close
                      </button>
                    </div>
                  </div>

                  <div className="upgradeList" aria-label="Available upgrades">
                    {upgrades.map((id) => {
                      const def = getUpgradeDef(id)
                      const level = stateRef.current.upgrades[id] ?? 0
                      const cost = def.cost(level)
                      const canBuy = hud.currency >= cost
                      return (
                        <button
                          key={id}
                          type="button"
                          className={['upgradeTile', canBuy ? '' : 'disabled']
                            .filter(Boolean)
                            .join(' ')}
                          onClick={() => buyUpgrade(id)}
                          disabled={!canBuy}
                        >
                          <div className="upgradeTileMain">
                            <div className="upgradeTileName">{def.name}</div>
                            <div className="upgradeTileDesc">{def.desc(level)}</div>
                          </div>
                          <div className="upgradeTileMeta">
                            <div className="upgradeTileLevel">Level {level}</div>
                            <div className="upgradeTileCost">Cost {cost}</div>
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <div className="upgradeFooter">
                    <button type="button" className="hudBtn primary" onClick={toggleUpgradeMenu}>
                      Resume
                    </button>
                    <button type="button" className="hudBtn" onClick={restart}>
                      Restart
                    </button>
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


