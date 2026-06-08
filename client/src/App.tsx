import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './app.css'
import { createInitialRunState, type RunState } from './game/runState'
import { stepSim, fireOverdrive } from './game/sim'
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
import type { TrackInfo } from './audio/music'
import { sfxEngine } from './audio/sfx'
import { drawPieceSwatch, type SwatchKind } from './render/swatch'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import { getOrCreatePlayerId, isConvexConfigured } from './game/playerId'
import { getTodayDateKey } from './game/rng'

type HudSnapshot = {
  paused: boolean
  pauseBtnBottomPx: number
  depth: number
  score: number
  gameOver: boolean
}

// Game-over leaderboard: rows shown per page. Kept small so the panel stays
// within the viewport (no scrolling) regardless of how many entries exist;
// the player flips through pages with the prev/next chevrons.
const GAMEOVER_LB_PAGE_SIZE = 5

// Legend shown in the pause menu: the special pieces/features and what each one
// does, in plain language. Each row renders the REAL in-game artwork (via the
// shared piece renderer) rather than a stand-in glyph, so it's instantly
// recognizable. Block kinds are drawn as a 2x2 footprint.
const PIECE_KEY: { kind: SwatchKind; name: string; desc: string }[] = [
  {
    kind: 'fast',
    name: 'Fast block',
    desc: 'Drops 2x as far every other time it drops.',
  },
  {
    kind: 'armored',
    name: 'Armored block',
    desc: 'A reflective bottom requires damaging it from the sides or top.',
  },
  {
    kind: 'shatter',
    name: 'Shatter block',
    desc: 'Spawns a cluster of normal blocks when destroyed.',
  },
  {
    kind: 'mirror',
    name: 'Mirror',
    desc: 'Reflects the beam off its diagonal. Burns away under sustained fire.',
  },
  {
    kind: 'splitter',
    name: 'Splitter',
    desc: 'Splits the beam into two at the angles indicated by the arrows. Both beams maintain full power.',
  },
]

// A single legend icon: draws the real piece artwork into a small canvas.
const SWATCH_BOX = 44
const PieceSwatch = ({ kind }: { kind: SwatchKind }) => {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (canvas) drawPieceSwatch(canvas, kind, SWATCH_BOX)
  }, [kind])
  return <canvas ref={ref} className="menuKeyIcon" aria-hidden="true" />
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
  // Latest values for use inside the (stable, []-dep) RAF + pointer effects:
  // the on-canvas control dock reads musicOn to draw its state, and the pointer
  // handlers call these to toggle on a tap.
  const musicOnRef = useRef(false)
  const dockActionsRef = useRef<{ togglePause: () => void; toggleMusic: () => void }>({
    togglePause: () => {},
    toggleMusic: () => {},
  })
  const saveBucketRef = useRef<number>(-1)
  const safeProbeRef = useRef<HTMLDivElement | null>(null)
  // Adaptive resolution: multiplies the (capped) device-pixel ratio. Dropped when
  // the smoothed frame time exceeds budget, restored when there's headroom, so a
  // struggling phone trades a little sharpness for a steady framerate.
  const renderScaleRef = useRef(1)
  const frameEmaRef = useRef(16.7)
  const lastResChangeRef = useRef(0)

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
  // "Now playing" corner card: shows briefly when a new song starts.
  const [nowPlaying, setNowPlaying] = useState<TrackInfo | null>(null)
  const [npLeaving, setNpLeaving] = useState(false)
  const npTokenRef = useRef(-1)
  const npHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const npRemoveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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
  // Game-over leaderboard view: which board, and which page within it.
  const [lbTab, setLbTab] = useState<'daily' | 'local'>('daily')
  const [lbPage, setLbPage] = useState(0)

  // Anonymous identity + global leaderboard wiring. All of this no-ops cleanly
  // when no Convex deployment is configured (queries skip, mutations unused),
  // so the game still runs fully offline with just the local board.
  const playerIdRef = useRef<string>(getOrCreatePlayerId())
  const convexConfigured = useMemo(() => isConvexConfigured(), [])
  // The whole game is a daily run, so the global board is today's daily board.
  const todayKey = useMemo(() => getTodayDateKey(), [])
  const submitDailyGlobal = useMutation(api.leaderboard.submitDailyScore)
  const globalDailyScores = useQuery(
    api.leaderboard.getTopDailyScoresForDate,
    convexConfigured && hud.gameOver ? { dateKey: todayKey } : 'skip',
  )

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
      if (s.gameOver) return
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
  }, [])

  // Attach the DOM <audio> element to the music engine once mounted.
  useEffect(() => {
    if (musicAudioRef.current) musicEngine.attach(musicAudioRef.current)
  }, [])

  // Mirror the engine's "needs unlock" signal so we can show the tap prompt.
  useEffect(() => musicEngine.subscribeAudioNeedsUnlock(setAudioNeedsUnlock), [])

  // While the tap-to-resume prompt is up, freeze the sim so the player can't
  // lose a run behind it. A ref so the rAF loop reads the current value.
  const audioGateRef = useRef(false)
  const audioPromptVisible = audioNeedsUnlock && isTouchDevice && !hud.paused && !hud.gameOver
  useEffect(() => {
    audioGateRef.current = audioPromptVisible
  }, [audioPromptVisible])

  // Start the soundtrack on the first user gesture (autoplay policy requires
  // it). Listeners stay installed so we also recover audio after the tab is
  // backgrounded / an iOS audio-session interruption.
  useEffect(() => {
    const onGesture = () => {
      if (musicEngine.isWantPlaying()) void musicEngine.start()
      // Unlock the SFX context too so piece-destroyed sounds can play (they're
      // independent of the music toggle).
      sfxEngine.unlock()
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

  // Feed the latest dock state/handlers to the []-dep RAF + pointer effects via
  // refs (so the on-canvas dock can draw + respond without re-subscribing).
  musicOnRef.current = musicOn
  dockActionsRef.current.toggleMusic = toggleMusic
  dockActionsRef.current.togglePause = () => {
    if (stateRef.current.gameOver) return
    if (stateRef.current.levelUpActive) return
    setPaused(!stateRef.current.paused)
  }

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
      // Base cap 2.0 (down from 2.5): pixel work scales with dpr², so this alone
      // cuts ~30% of fill/blur/upload cost on dense-DPI phones for a barely
      // perceptible sharpness change. The adaptive scale trims further if needed.
      const baseCap = Math.min(2.0, window.devicePixelRatio || 1)
      const dpr = Math.max(0.75, baseCap * renderScaleRef.current)
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

      // Adaptive resolution governor. Smooth the frame time and, with a cooldown
      // to avoid thrash, step the render scale down when we're missing frames and
      // back up when there's comfortable headroom. Skipped while paused (dt is
      // meaningless then).
      if (!s.paused) {
        frameEmaRef.current += (dtSec * 1000 - frameEmaRef.current) * 0.1
        const ema = frameEmaRef.current
        if (now - lastResChangeRef.current > 1400) {
          if (ema > 22 && renderScaleRef.current > 0.7) {
            renderScaleRef.current = Math.max(0.7, renderScaleRef.current - 0.15)
            lastResChangeRef.current = now
            resize()
          } else if (ema < 14 && renderScaleRef.current < 1) {
            renderScaleRef.current = Math.min(1, renderScaleRef.current + 0.15)
            lastResChangeRef.current = now
            resize()
          }
        }
      }

      if (!s.paused && !audioGateRef.current) stepSim(s, dtSec)

      // Sample the soundtrack every frame (even while paused) so the visuals
      // keep breathing, then push the live signals onto the run state. Also feed
      // the current board drop rate so the next track is picked to match tempo.
      musicEngine.setBoardTempo(s.dropIntervalSec)
      musicEngine.sample(now)
      musicEngine.applyTo(s.music)

      drawFrame(canvas, s, { musicOn: musicOnRef.current })

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
        // Publish the live music hue so the DOM menus (pause / game over) can ride
        // the soundtrack like the canvas does. Frozen to the cold cyan accent when
        // nothing is playing. Throttled with the HUD bucket (hue drifts slowly).
        document.documentElement.style.setProperty(
          '--accent-hue',
          (s.music.playing ? s.music.hue : 200).toFixed(1),
        )

        // New song started? Pop the unobtrusive "now playing" card, then auto-hide.
        const np = musicEngine.getNowPlaying()
        if (np && np.token !== npTokenRef.current) {
          npTokenRef.current = np.token
          if (npHideTimerRef.current) clearTimeout(npHideTimerRef.current)
          if (npRemoveTimerRef.current) clearTimeout(npRemoveTimerRef.current)
          setNpLeaving(false)
          setNowPlaying(np.info)
          npHideTimerRef.current = setTimeout(() => setNpLeaving(true), 10400)
          npRemoveTimerRef.current = setTimeout(() => setNowPlaying(null), 10850)
        }
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
      if (npHideTimerRef.current) clearTimeout(npHideTimerRef.current)
      if (npRemoveTimerRef.current) clearTimeout(npRemoveTimerRef.current)
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
      setLbTab('daily')
      setLbPage(0)
      return
    }
    if (handledGameOverRef.current) return
    handledGameOverRef.current = true

    setPendingScoreDepth(hud.depth)
    setPendingScore(hud.score)
    if (qualifiesTop5(highScores, hud.score)) {
      setShowNamePrompt(true)
    }

    // Fire-and-forget global submit on every run end. The server upserts the
    // player's best row FOR THIS DAY, so playing as much as they want only ever
    // keeps their single best daily score globally. Uses the last saved name
    // until the player enters a new one.
    if (convexConfigured && hud.score > 0) {
      submitDailyGlobal({
        playerId: playerIdRef.current,
        name: loadLastPlayerName() || 'PLAYER',
        score: hud.score,
        depth: hud.depth,
        dateKey: stateRef.current.dateKey,
        savedAt: Date.now(),
      }).catch(() => {})
    }
  }, [hud.gameOver, hud.depth, hud.score, highScores, convexConfigured, submitDailyGlobal])

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
    // Re-submit globally with the chosen name so the daily row shows it too.
    if (convexConfigured) {
      submitDailyGlobal({
        playerId: playerIdRef.current,
        name: nameDraft,
        score: pendingScore,
        depth: pendingScoreDepth,
        dateKey: stateRef.current.dateKey,
        savedAt: Date.now(),
      }).catch(() => {})
    }
  }, [highScores, nameDraft, pendingScoreDepth, pendingScore, convexConfigured, submitDailyGlobal])

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

  // Game-over leaderboard view model: a single bounded, tabbed, paginated
  // region so the panel never grows past the viewport no matter how many rows
  // exist. The active tab falls back to whichever board has data.
  const dailyRows = convexConfigured && globalDailyScores ? globalDailyScores : []
  const hasDaily = dailyRows.length > 0
  const hasLocal = highScores.length > 0
  const activeTab: 'daily' | 'local' =
    lbTab === 'daily' ? (hasDaily ? 'daily' : 'local') : hasLocal ? 'local' : 'daily'
  const lbRows = activeTab === 'daily' ? dailyRows : highScores
  const lbPageCount = Math.max(1, Math.ceil(lbRows.length / GAMEOVER_LB_PAGE_SIZE))
  const lbSafePage = Math.min(Math.max(0, lbPage), lbPageCount - 1)
  const lbStart = lbSafePage * GAMEOVER_LB_PAGE_SIZE
  const lbPageRows = lbRows.slice(lbStart, lbStart + GAMEOVER_LB_PAGE_SIZE)
  // On the daily board, pin the player's own row when it falls off the visible
  // page so they can always see their standing without hunting through pages.
  const myDailyIdx =
    activeTab === 'daily' ? dailyRows.findIndex((e) => e.playerId === playerIdRef.current) : -1
  const myOnPage = myDailyIdx >= lbStart && myDailyIdx < lbStart + GAMEOVER_LB_PAGE_SIZE
  const lbPinnedMe = myDailyIdx >= 0 && !myOnPage ? dailyRows[myDailyIdx]! : null

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

            {/* "Now playing" corner card — pops in when a new song starts, holds
                briefly, then fades. Non-interactive so taps pass to gameplay. */}
            {nowPlaying && (
              <div
                className={`nowPlaying${npLeaving ? ' leaving' : ''}`}
                role="status"
                aria-live="polite"
              >
                {nowPlaying.artwork ? (
                  <img
                    className="npArt"
                    src={nowPlaying.artwork}
                    alt=""
                    aria-hidden="true"
                  />
                ) : (
                  <div className="npArt npArtFallback" aria-hidden="true">♪</div>
                )}
                <div className="npText">
                  <div className="npEyebrow">Now Playing</div>
                  <div className="npTitle">{nowPlaying.title}</div>
                  <div className="npArtist">{nowPlaying.artist}</div>
                  {(nowPlaying.album || nowPlaying.genre) && (
                    <div className="npAlbum">{nowPlaying.album || nowPlaying.genre}</div>
                  )}
                </div>
              </div>
            )}

            {/* The pause + music control dock is drawn ON the canvas (see
                drawControlDock in draw.ts) so the gravity-well lens warps it
                with the rest of the HUD; taps are hit-tested in the pointer
                handlers above against layout.dock. */}

            {/* Mobile audio-unlock prompt. A drag (the beam control) can't
                resume audio on iOS; a tap on this full-screen overlay is a valid
                activation gesture. The whole game is frozen while it's up (see
                the audio gate in the main loop) so the player never loses a run
                reading it. Suppressed while a menu is up (its buttons already
                unlock on tap). */}
            {audioNeedsUnlock && isTouchDevice && !hud.paused && !hud.gameOver && (
              <div
                className="audioUnlock"
                role="button"
                tabIndex={0}
                aria-label="Tap to resume"
                onClick={() => {
                  musicEngine.setWantPlaying(true)
                  setMusicOn(true)
                  void musicEngine.start()
                }}
              >
                <div className="audioUnlockCard">
                  <div className="audioUnlockIcon" aria-hidden="true">♪</div>
                  <div className="audioUnlockTitle">Tap to resume</div>
                </div>
              </div>
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

                  <div className="menuSection">
                    <div className="menuSectionTitle">Key</div>
                    <ul className="menuKey">
                      {PIECE_KEY.map((item) => (
                        <li key={item.name} className="menuKeyRow">
                          <PieceSwatch kind={item.kind} />
                          <span className="menuKeyText">
                            <span className="menuKeyName">{item.name}</span>
                            <span className="menuKeyDesc">{item.desc}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="menuActions pauseActions">
                    <button type="button" className="menuBtn danger" onClick={restart}>
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
                      <div className="menuSectionTitle">New high score — enter your name</div>
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

                  {!showNamePrompt && (hasDaily || hasLocal) && (
                    <div className="menuSection menuLeaderboard">
                      <div className="lbTabs" role="tablist">
                        {hasDaily && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'daily'}
                            className={`lbTab${activeTab === 'daily' ? ' active' : ''}`}
                            onClick={() => {
                              setLbTab('daily')
                              setLbPage(0)
                            }}
                          >
                            Daily Global
                          </button>
                        )}
                        {hasLocal && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'local'}
                            className={`lbTab${activeTab === 'local' ? ' active' : ''}`}
                            onClick={() => {
                              setLbTab('local')
                              setLbPage(0)
                            }}
                          >
                            Your Best
                          </button>
                        )}
                      </div>

                      <ol className="menuScoreList lbList">
                        {lbPageRows.map((e, i) => {
                          const rank = lbStart + i + 1
                          const mine =
                            activeTab === 'daily' &&
                            'playerId' in e &&
                            e.playerId === playerIdRef.current
                          const key =
                            'playerId' in e ? `${e.playerId}-${rank}` : `${e.ts}-${rank}`
                          return (
                            <li key={key} className={`menuScoreRow${mine ? ' isMe' : ''}`}>
                              <span className="rank">{rank}</span>
                              <span className="name">{e.name}</span>
                              <span className="val">
                                {e.score.toLocaleString()}
                                <span className="depth">d{e.depth}</span>
                              </span>
                            </li>
                          )
                        })}
                        {lbPinnedMe && (
                          <li className="menuScoreRow isMe pinned">
                            <span className="rank">{myDailyIdx + 1}</span>
                            <span className="name">{lbPinnedMe.name}</span>
                            <span className="val">
                              {lbPinnedMe.score.toLocaleString()}
                              <span className="depth">d{lbPinnedMe.depth}</span>
                            </span>
                          </li>
                        )}
                      </ol>

                      {lbPageCount > 1 && (
                        <div className="lbPager">
                          <button
                            type="button"
                            className="lbPagerBtn"
                            disabled={lbSafePage === 0}
                            aria-label="Previous page"
                            onClick={() => setLbPage((p) => Math.max(0, p - 1))}
                          >
                            ‹
                          </button>
                          <span className="lbPagerLabel">
                            {lbSafePage + 1} / {lbPageCount}
                          </span>
                          <button
                            type="button"
                            className="lbPagerBtn"
                            disabled={lbSafePage >= lbPageCount - 1}
                            aria-label="Next page"
                            onClick={() => setLbPage((p) => Math.min(lbPageCount - 1, p + 1))}
                          >
                            ›
                          </button>
                        </div>
                      )}
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
