import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import { createInitialRunState, type RunState } from './game/runState'
import { stepSim } from './game/sim'
import { drawFrame } from './render/draw'
import { clamp } from './game/math'
// import { computeXpCap, getRarityColor } from './game/levelUp'  // Unused after upgrade system removal
import { getArenaLayout } from './game/layout'
import { makeProjection } from './render/projection'
import {
  addHighScore,
  getBestDepth,
  getBestScore,
  loadHighScores,
  loadLastPlayerName,
  qualifiesTop5,
  saveHighScores,
  saveLastPlayerName,
  type HighScoreEntry,
} from './game/highScores'
import { clearGameState, loadGameState, saveGameState } from './game/gameState'
import { musicEngine } from './audio/music'

type HudSnapshot = {
  paused: boolean
  pauseBtnBottomPx: number
  depth: number
  score: number
  gameOver: boolean
}

// The menus surface only the stats that matter to an endless run: how deep
// you got, how many pieces you cleared, and how long you lasted.
const computePauseStats = (state: RunState) => {
  const { depth, blocksDestroyed, timeSec } = state
  const mins = Math.floor(timeSec / 60)
  const secs = Math.floor(timeSec % 60)
  return {
    depth,
    piecesDestroyed: blocksDestroyed,
    runTime: `${mins}:${secs.toString().padStart(2, '0')}`,
  }
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const musicAudioRef = useRef<HTMLAudioElement | null>(null)
  const rafRef = useRef<number | null>(null)
  const hudBucketRef = useRef<number>(-1)
  const saveBucketRef = useRef<number>(-1)
  const safeProbeRef = useRef<HTMLDivElement | null>(null)

  const stateRef = useRef<RunState>(
    (() => {
      const saved = loadGameState()
      return saved || createInitialRunState()
    })()
  )

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
    depth: stateRef.current.depth,
    score: stateRef.current.score,
    gameOver: false,
  }))

  const [musicOn, setMusicOn] = useState<boolean>(() => musicEngine.isWantPlaying())
  // Mobile-only "Tap to resume" prompt: shown when music is wanted but the
  // AudioContext isn't running (iOS won't unlock audio from a drag gesture).
  const [audioNeedsUnlock, setAudioNeedsUnlock] = useState<boolean>(() =>
    musicEngine.getAudioNeedsUnlock(),
  )
  const isTouchDevice = useRef<boolean>(
    typeof window !== 'undefined' &&
      ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0),
  ).current
  const [highScores, setHighScores] = useState<HighScoreEntry[]>(() => loadHighScores())
  const [nameDraft, setNameDraft] = useState<string>(() => loadLastPlayerName())
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [pendingScoreDepth, setPendingScoreDepth] = useState<number | null>(null)
  const [pendingScore, setPendingScore] = useState<number | null>(null)
  const handledGameOverRef = useRef(false)

  const setPaused = useCallback((paused: boolean) => {
    stateRef.current.paused = paused
    setHud((h) => ({ ...h, paused }))
  }, [])

  // Keep the sim/draw layer informed of the device-best depth + score so the HUD
  // "BEST" label can render.
  useEffect(() => {
    stateRef.current.bestDepthLocal = getBestDepth(highScores)
    stateRef.current.bestScoreLocal = getBestScore(highScores)
  }, [highScores])

  // Pointer input: the single control surface is the gravity-well puck.
  // Press anywhere -> the well teleports under the finger (momentum cancelled);
  // drag -> it follows; release -> it inherits the flick velocity (a still
  // release parks it). Physics (friction, wall bounces) run in the sim.
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

    let activePointer: number | null = null
    let lastX = 0
    let lastY = 0
    let lastT = 0
    let vx = 0
    let vy = 0

    const onPointerDown = (e: PointerEvent) => {
      const s = stateRef.current
      if (s.gameOver) return
      if (onUi(e)) return
      const p = getPoint(e)
      if (!p) return
      activePointer = e.pointerId
      // Teleport under the finger and cancel momentum.
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
    }

    const onPointerMove = (e: PointerEvent) => {
      if (activePointer !== e.pointerId) return
      const p = getPoint(e)
      if (!p) return
      const s = stateRef.current
      s.well.pos.x = p.x
      s.well.pos.y = p.y
      // Track pointer velocity (px/sec), lightly smoothed, for the throw.
      const dt = Math.max(0.001, (e.timeStamp - lastT) / 1000)
      vx = vx * 0.4 + ((p.x - lastX) / dt) * 0.6
      vy = vy * 0.4 + ((p.y - lastY) / dt) * 0.6
      lastX = p.x
      lastY = p.y
      lastT = e.timeStamp
    }

    const onPointerUp = (e: PointerEvent) => {
      if (activePointer !== e.pointerId) return
      activePointer = null
      const s = stateRef.current
      s.well.grabbed = false
      // A throw only if the finger was still moving at release; otherwise park.
      const sinceMove = (e.timeStamp - lastT) / 1000
      if (sinceMove > 0.05) {
        vx = 0
        vy = 0
      }
      s.well.vel.x = vx
      s.well.vel.y = vy
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

  // Attach the DOM <audio> element to the music engine once mounted.
  useEffect(() => {
    if (musicAudioRef.current) musicEngine.attach(musicAudioRef.current)
  }, [])

  // Mirror the engine's "needs unlock" signal so we can show the tap prompt.
  useEffect(() => musicEngine.subscribeAudioNeedsUnlock(setAudioNeedsUnlock), [])

  // Start the soundtrack on the first user gesture (autoplay policy requires
  // it). Listeners stay installed so we also recover audio after the tab is
  // backgrounded / an iOS audio-session interruption.
  useEffect(() => {
    const onGesture = () => {
      if (musicEngine.isWantPlaying()) void musicEngine.start()
    }
    window.addEventListener('pointerdown', onGesture, { passive: true })
    window.addEventListener('touchend', onGesture, { passive: true })
    window.addEventListener('keydown', onGesture, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', onGesture)
      window.removeEventListener('touchend', onGesture)
      window.removeEventListener('keydown', onGesture)
    }
  }, [])

  const toggleMusic = useCallback(() => {
    // Drive the engine synchronously inside the click handler so audio.play()
    // keeps the user-activation it needs (calling it inside a setState updater
    // runs it during React's render phase — outside the gesture — and StrictMode
    // double-invokes updaters, so the side effect must live out here).
    const next = !musicEngine.isWantPlaying()
    musicEngine.setWantPlaying(next)
    setMusicOn(next)
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
      let h = Math.max(1, rect.height)
      if (h < 120) {
        const fallbackH = Math.max(
          h,
          window.innerHeight || document.documentElement.clientHeight || 0,
        )
        if (fallbackH > h) h = fallbackH
      }
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

      // Emitter is a fixed muzzle at bottom-center; snap it even while paused.
      const layout = getArenaLayout(s.view)
      s.emitter.pos.x = s.view.width / 2
      s.emitter.pos.y = layout.emitterY

      // Keep the well puck inside the (possibly resized) world playfield. World
      // X spans [0, width]; clamp Y between the visible top and the muzzle row.
      const proj = makeProjection(s.view, layout)
      const topWorldY = proj.unproject(w / 2, 0).y
      s.well.pos.x = clamp(s.well.pos.x, 0, w)
      s.well.pos.y = clamp(s.well.pos.y, topWorldY, layout.emitterY)
    }

    resize()
    requestAnimationFrame(resize)
    window.addEventListener('resize', resize)
    const onVisibility = () => {
      if (!document.hidden) resize()
    }
    document.addEventListener('visibilitychange', onVisibility)

    const tick = (now: number) => {
      const s = stateRef.current
      // Use variable dt for simulation so damage/visuals update every frame even on
      // 90/120Hz displays (fixed-step would "pause" every other frame).
      const dtSec = Math.min(0.05, (now - last) / 1000)
      last = now
      if (!s.paused) stepSim(s, dtSec)

      // Sample the soundtrack every frame (even while paused) so the visuals
      // keep breathing, then push the live signals onto the run state.
      musicEngine.sample(now)
      musicEngine.applyTo(s.music)

      drawFrame(canvas, s)

      // HUD: update at ~10fps to keep React cheap (avoid depending on React state inside RAF).
      const bucket = Math.floor(now / 100)
      if (bucket !== hudBucketRef.current) {
        hudBucketRef.current = bucket
        setHud({
          paused: s.paused,
          pauseBtnBottomPx: computePauseBtnBottomPx(),
          depth: s.depth,
          score: s.score,
          gameOver: s.gameOver,
        })
      }

      // Auto-save game state every 2 seconds (20 buckets)
      // Skip saving if game is over to avoid unnecessary localStorage operations
      const saveBucket = Math.floor(now / 2000)
      if (saveBucket !== saveBucketRef.current) {
        saveBucketRef.current = saveBucket
        if (!s.gameOver) {
          saveGameState(s)
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    }

    if (import.meta.env.DEV) {
      ;(window as unknown as { __music?: () => unknown }).__music = () =>
        stateRef.current.music
      ;(window as unknown as { __game?: () => unknown }).__game = () => {
        const s = stateRef.current
        return {
          depth: s.depth,
          score: s.score,
          combo: s.combo,
          comboBest: s.comboBest,
          crescendo: s.crescendo,
          gameOver: s.gameOver,
          lives: s.lives,
          blocks: s.blocks.length,
          dps: s.stats.dps,
          well: {
            placed: s.well.placed,
            grabbed: s.well.grabbed,
            pos: s.well.pos,
            vel: s.well.vel,
          },
          segs: s.laser.segments.length,
        }
      }
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('resize', resize)
      document.removeEventListener('visibilitychange', onVisibility)
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
      score: 0,
      gameOver: false,
    })
    // Clear saved state when player explicitly restarts
    clearGameState()
  }, [computePauseBtnBottomPx, highScores])

  // When a run ends, decide whether we need to prompt for a name (top-5 by score).
  useEffect(() => {
    if (!hud.gameOver) {
      handledGameOverRef.current = false
      setShowNamePrompt(false)
      setPendingScoreDepth(null)
      setPendingScore(null)
      return
    }
    if (handledGameOverRef.current) return
    handledGameOverRef.current = true

    setPendingScoreDepth(hud.depth)
    setPendingScore(hud.score)
    if (qualifiesTop5(highScores, hud.score)) {
      setShowNamePrompt(true)
    }
  }, [hud.gameOver, hud.depth, hud.score, highScores])

  const submitHighScore = useCallback(() => {
    if (pendingScoreDepth == null || pendingScore == null) return
    const next = addHighScore(highScores, {
      name: nameDraft,
      depth: pendingScoreDepth,
      score: pendingScore,
    })
    setHighScores(next)
    saveHighScores(next)
    saveLastPlayerName(nameDraft)
    setShowNamePrompt(false)
    // Update local bests immediately for the live HUD labels on subsequent runs.
    stateRef.current.bestDepthLocal = getBestDepth(next)
    stateRef.current.bestScoreLocal = getBestScore(next)
  }, [highScores, nameDraft, pendingScoreDepth, pendingScore])

  const skipHighScore = useCallback(() => {
    setShowNamePrompt(false)
  }, [])

  // Run stats for the menus (pause + game over). Recomputed only when a menu
  // is actually open.
  const pauseStats = useMemo(() => {
    const menuOpen = (hud.paused && !stateRef.current.levelUpActive) || hud.gameOver
    if (!menuOpen) return null
    return computePauseStats(stateRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud.paused, hud.gameOver, hud.depth, hud.score])

  return (
    <div className="lg-viewport">
      <audio
        ref={musicAudioRef}
        crossOrigin="anonymous"
        loop
        playsInline
        preload="auto"
        style={{ display: 'none' }}
      />
      <div className="lg-shell">
        <main className="lg-main">
          <div className="lg-arena">
            <canvas ref={canvasRef} className="lg-canvas" />

            {/* Unified control dock: one glass cluster of equal-size icon
                buttons, matching the HUD L's glass/stroke language. */}
            <div className="controlDock" style={{ bottom: `${hud.pauseBtnBottomPx}px` }}>
              {!stateRef.current.levelUpActive && (
                <button
                  type="button"
                  className="dockBtn"
                  onClick={() => {
                    if (hud.gameOver) return
                    setPaused(!hud.paused)
                  }}
                  aria-label={hud.paused ? 'Play' : 'Pause'}
                  title={hud.paused ? 'Resume' : 'Pause'}
                >
                  {hud.paused ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M8 5.5v13l11-6.5z" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <rect x="7" y="5.5" width="3.5" height="13" rx="1.4" />
                      <rect x="13.5" y="5.5" width="3.5" height="13" rx="1.4" />
                    </svg>
                  )}
                </button>
              )}

              <button
                type="button"
                className={`dockBtn music${musicOn ? ' is-on' : ''}`}
                onClick={toggleMusic}
                aria-pressed={musicOn}
                aria-label={musicOn ? 'Mute music' : 'Play music'}
                title={musicOn ? 'Music on — click to mute' : 'Music off — click to play'}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 16.5V7l9-2v9" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="6.5" cy="16.5" r="2.6" />
                  <circle cx="15.5" cy="14" r="2.6" />
                </svg>
                {!musicOn && <span className="muteSlash" aria-hidden="true" />}
              </button>
            </div>

            {/* Mobile audio-unlock prompt. A drag (the beam control) can't
                resume audio on iOS; a tap on this overlay is a valid activation
                gesture. Hidden once audio runs, and suppressed while a menu is
                up (its buttons already unlock on tap). */}
            {audioNeedsUnlock && isTouchDevice && !hud.paused && !hud.gameOver && (
              <button
                type="button"
                className="audioUnlock"
                aria-label="Tap to resume audio"
                onClick={() => {
                  musicEngine.setWantPlaying(true)
                  setMusicOn(true)
                  void musicEngine.start()
                }}
              >
                <span className="audioUnlockCard">
                  <span className="audioUnlockIcon" aria-hidden="true">♪</span>
                  <span className="audioUnlockText">Tap to resume music</span>
                </span>
              </button>
            )}

            {/* Pause overlay. */}
            {hud.paused && !stateRef.current.levelUpActive && !hud.gameOver && pauseStats && (
              <div className="menuOverlay" role="dialog" aria-label="Paused">
                <div className="menuPanel">
                  <div className="menuKicker">Run in progress</div>
                  <div className="menuTitle">Paused</div>

                  <div className="menuHero">
                    <span className="menuHeroLabel">Score</span>
                    <span className="menuHeroValue">{hud.score.toLocaleString()}</span>
                  </div>

                  <div className="menuChips">
                    <div className="menuChip">
                      <span className="v">{pauseStats.depth}</span>
                      <span className="k">Depth</span>
                    </div>
                    <div className="menuChip">
                      <span className="v">{pauseStats.piecesDestroyed}</span>
                      <span className="k">Pieces</span>
                    </div>
                    <div className="menuChip">
                      <span className="v">{pauseStats.runTime}</span>
                      <span className="k">Time</span>
                    </div>
                  </div>

                  {highScores.length > 0 && (
                    <div className="menuSection">
                      <div className="menuSectionTitle">Top Scores</div>
                      <ol className="menuScoreList">
                        {highScores.slice(0, 5).map((e, i) => (
                          <li key={`${e.ts}-${i}`} className="menuScoreRow">
                            <span className="rank">{i + 1}</span>
                            <span className="name">{e.name}</span>
                            <span className="val">
                              {e.score.toLocaleString()}
                              <span className="depth">d{e.depth}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  <div className="menuActions">
                    <button type="button" className="menuBtn ghost" onClick={restart}>
                      Restart
                    </button>
                    <button type="button" className="menuBtn primary" onClick={() => setPaused(false)}>
                      Resume
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Game-over overlay + optional name prompt for top-5. */}
            {hud.gameOver && (
              <div className="menuOverlay" role="dialog" aria-label="Game over">
                <div className="menuPanel">
                  <div className="menuKicker">Run ended</div>
                  <div className="menuTitle">Game Over</div>

                  <div className="menuHero">
                    <span className="menuHeroLabel">Final Score</span>
                    <span className="menuHeroValue">{hud.score.toLocaleString()}</span>
                  </div>

                  {pauseStats && (
                    <div className="menuChips">
                      <div className="menuChip">
                        <span className="v">{hud.depth}</span>
                        <span className="k">Depth</span>
                      </div>
                      <div className="menuChip">
                        <span className="v">{pauseStats.piecesDestroyed}</span>
                        <span className="k">Pieces</span>
                      </div>
                      <div className="menuChip">
                        <span className="v">{pauseStats.runTime}</span>
                        <span className="k">Time</span>
                      </div>
                    </div>
                  )}

                  {showNamePrompt && (
                    <div className="menuSection">
                      <div className="menuSectionTitle">New Top 5 — enter your name</div>
                      <input
                        className="menuInput"
                        value={nameDraft}
                        onChange={(e) => setNameDraft(e.target.value)}
                        maxLength={16}
                        placeholder="PLAYER"
                        autoFocus
                      />
                      <div className="menuActions">
                        <button type="button" className="menuBtn ghost" onClick={skipHighScore}>
                          Skip
                        </button>
                        <button type="button" className="menuBtn primary" onClick={submitHighScore}>
                          Save
                        </button>
                      </div>
                    </div>
                  )}

                  {highScores.length > 0 && (
                    <div className="menuSection">
                      <div className="menuSectionTitle">Top Scores</div>
                      <ol className="menuScoreList">
                        {highScores.slice(0, 5).map((e, i) => (
                          <li key={`${e.ts}-${i}`} className="menuScoreRow">
                            <span className="rank">{i + 1}</span>
                            <span className="name">{e.name}</span>
                            <span className="val">
                              {e.score.toLocaleString()}
                              <span className="depth">d{e.depth}</span>
                            </span>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}

                  {!showNamePrompt && (
                    <div className="menuActions">
                      <button type="button" className="menuBtn primary" onClick={restart}>
                        Play Again
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Upgrade system disabled - automatic +1 DPS per level now */}
            {/*
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
            */}
          </div>
        </main>
      </div>
    </div>
  )
}
