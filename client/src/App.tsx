import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import { createInitialRunState, type RunState } from './game/runState'
import { stepSim } from './game/sim'
import { drawFrame } from './render/draw'
import { clamp } from './game/math'
import { applyOffer, computeXpCap, getOfferPreview, getRarityColor } from './game/levelUp'
import { getArenaLayout } from './game/layout'
import {
  addHighScore,
  getBestDepth,
  loadHighScores,
  loadLastPlayerName,
  qualifiesTop5,
  saveHighScores,
  saveLastPlayerName,
  type HighScoreEntry,
} from './game/highScores'

type HudSnapshot = {
  paused: boolean
  pauseBtnBottomPx: number
  depth: number
  gameOver: boolean
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const hudBucketRef = useRef<number>(-1)
  const safeProbeRef = useRef<HTMLDivElement | null>(null)

  const stateRef = useRef<RunState>(createInitialRunState())

  const computePauseBtnBottomPx = useCallback(() => {
    const s = stateRef.current
    const layout = getArenaLayout(s.view)
    // Place the button just above the death line.
    const margin = 8
    return Math.max(10, s.view.height - layout.failY + margin)
  }, [])

  const [hud, setHud] = useState<HudSnapshot>(() => ({
    paused: false,
    pauseBtnBottomPx: computePauseBtnBottomPx(),
    depth: 0,
    gameOver: false,
  }))

  const [highScores, setHighScores] = useState<HighScoreEntry[]>(() => loadHighScores())
  const [nameDraft, setNameDraft] = useState<string>(() => loadLastPlayerName())
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [pendingScoreDepth, setPendingScoreDepth] = useState<number | null>(null)
  const handledGameOverRef = useRef(false)

  const setPaused = useCallback((paused: boolean) => {
    stateRef.current.paused = paused
    setHud((h) => ({ ...h, paused }))
  }, [])

  // Keep the sim/draw layer informed of the device-best depth so the HUD "BEST" label can render.
  useEffect(() => {
    stateRef.current.bestDepthLocal = getBestDepth(highScores)
  }, [highScores])

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

    const pickRoleForPointerDown = (localY: number, s: RunState) => {
      // Any interaction below the death line should move the slider (easy to control),
      // while anything above should aim (prevents accidental grabs when aiming low).
      const layout = getArenaLayout(s.view)
      return localY >= layout.failY ? 'move' : 'aim'
    }

    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current
      const local = getLocal(e)
      if (!local) return

      const preferredRole = pickRoleForPointerDown(local.y, s)

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
      // While the upgrade chooser is open, do not allow manual unpause.
      // The only way to resume is to pick an upgrade.
      if (stateRef.current.levelUpActive) return
      if (stateRef.current.gameOver) return
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
      const s = stateRef.current
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
      const s = stateRef.current
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
          paused: s.paused,
          pauseBtnBottomPx: computePauseBtnBottomPx(),
          depth: s.depth,
          gameOver: s.gameOver,
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
    // IMPORTANT: keep the same object identity so the RAF loop (and any other refs)
    // continue to operate on the reset state.
    const prev = stateRef.current
    const fresh = createInitialRunState()
    fresh.view = prev.view
    fresh.input = prev.input
    fresh.bestDepthLocal = getBestDepth(highScores)
    Object.assign(prev, fresh)
    handledGameOverRef.current = false
    setHud({
      paused: false,
      pauseBtnBottomPx: computePauseBtnBottomPx(),
      depth: 0,
      gameOver: false,
    })
  }, [computePauseBtnBottomPx, highScores])

  // When a run ends, decide whether we need to prompt for a name (top-5).
  useEffect(() => {
    if (!hud.gameOver) {
      handledGameOverRef.current = false
      setShowNamePrompt(false)
      setPendingScoreDepth(null)
      return
    }
    if (handledGameOverRef.current) return
    handledGameOverRef.current = true

    const depth = hud.depth
    setPendingScoreDepth(depth)
    if (qualifiesTop5(highScores, depth)) {
      setShowNamePrompt(true)
    }
  }, [hud.gameOver, hud.depth, highScores])

  const submitHighScore = useCallback(() => {
    if (pendingScoreDepth == null) return
    const next = addHighScore(highScores, { name: nameDraft, depth: pendingScoreDepth })
    setHighScores(next)
    saveHighScores(next)
    saveLastPlayerName(nameDraft)
    setShowNamePrompt(false)
    // Update local best immediately for the live HUD label on subsequent runs.
    stateRef.current.bestDepthLocal = getBestDepth(next)
  }, [highScores, nameDraft, pendingScoreDepth])

  const skipHighScore = useCallback(() => {
    setShowNamePrompt(false)
  }, [])

  return (
    <div className="lg-viewport">
      <div className="lg-shell">
        <main className="lg-main">
          <div className="lg-arena">
            <canvas ref={canvasRef} className="lg-canvas" />

            {!stateRef.current.levelUpActive && (
              <button
                type="button"
                className="arenaPauseBtn"
                style={{ bottom: `${hud.pauseBtnBottomPx}px` }}
                onClick={() => {
                  if (hud.gameOver) return
                  setPaused(!hud.paused)
                }}
              >
                {hud.paused ? 'Play' : 'Pause'}
              </button>
            )}

            {/* Pause overlay (shows local leaderboard). */}
            {hud.paused && !stateRef.current.levelUpActive && !hud.gameOver && (
              <div className="pauseOverlay" role="dialog" aria-label="Paused">
                <div className="pausePanel">
                  <div className="pauseTitle">Paused</div>
                  {highScores.length > 0 && (
                    <div className="pauseScores">
                      <div className="pauseScoresTitle">Top Depths</div>
                      <ol className="scoreList">
                        {highScores.map((e, i) => (
                          <li key={`${e.ts}-${i}`} className="scoreRow">
                            <span className="scoreRank">{i + 1}</span>
                            <span className="scoreName">{e.name}</span>
                            <span className="scoreValue">{e.depth}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <div className="pauseActions">
                    <button type="button" className="btn ghost" onClick={() => setPaused(false)}>
                      Resume
                    </button>
                    <button type="button" className="btn" onClick={restart}>
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Game-over overlay + optional name prompt for top-5. */}
            {hud.gameOver && (
              <div className="pauseOverlay" role="dialog" aria-label="Game over">
                <div className="pausePanel">
                  <div className="pauseTitle">Game Over</div>
                  <div className="gameOverDepth">Depth: {hud.depth}</div>

                  {showNamePrompt && (
                    <div className="namePrompt">
                      <div className="namePromptTitle">New Top 5 — enter your name</div>
                      <input
                        className="nameInput"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        maxLength={16}
                        placeholder="PLAYER"
                        autoFocus
                      />
                      <div className="pauseActions">
                        <button type="button" className="btn ghost" onClick={skipHighScore}>
                          Skip
                        </button>
                        <button type="button" className="btn" onClick={submitHighScore}>
                          Save
                        </button>
                      </div>
                    </div>
                  )}

                  {highScores.length > 0 && (
                    <div className="pauseScores">
                      <div className="pauseScoresTitle">Top Depths</div>
                      <ol className="scoreList">
                        {highScores.map((e, i) => (
                          <li key={`${e.ts}-${i}`} className="scoreRow">
                            <span className="scoreRank">{i + 1}</span>
                            <span className="scoreName">{e.name}</span>
                            <span className="scoreValue">{e.depth}</span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  <div className="pauseActions">
                    <button type="button" className="btn" onClick={restart}>
                      Restart
                    </button>
                  </div>
                </div>
              </div>
            )}

            {stateRef.current.levelUpActive && (
              <div className="upgradeOverlay" role="dialog" aria-label="Choose an upgrade">
                <div className="upgradePanel">
                  <div className="upgradeCards" aria-label="Upgrade choices">
                    {stateRef.current.levelUpOptions.map((opt, idx) => {
                      const prev = getOfferPreview(stateRef.current, opt)
                      const rarityColor = getRarityColor(opt.rarity)
                      return (
                        <button
                          key={opt.type + opt.rarity + idx}
                          type="button"
                          className="upgradeCard"
                          data-rarity={opt.rarity}
                          style={{
                            borderColor: `${rarityColor}66`,
                            boxShadow: `0 0 0 1px rgba(0,0,0,0.35), 0 18px 55px rgba(0,0,0,0.55), 0 0 42px ${rarityColor}33`,
                          }}
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
                          <div className="upgradeCardTop">
                            <div className="upgradeRarity" style={{ color: rarityColor }}>
                              {opt.rarity.toUpperCase()}
                            </div>
                            <div className="upgradeCardTitle">{opt.title}</div>
                          </div>

                          <div className="upgradeDelta">
                            <div className="upgradeDeltaLabel">{prev.label}</div>
                            <div className="upgradeDeltaValues">
                              <span className="before">{prev.before}</span>
                              <span className="arrow">→</span>
                              <span className="after">{prev.after}</span>
                            </div>
                            {prev.delta && <div className="upgradeDeltaPill">{prev.delta}</div>}
                          </div>

                          <div className="upgradeCardCta">
                            <span>Take</span>
                          </div>
                        </button>
                      )
                    })}
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


