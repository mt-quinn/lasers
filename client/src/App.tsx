import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import './app.css'
import { createInitialRunState, type RunState } from './game/runState'
import type { TeachKind, TutorialBeat } from './game/runState'
import { stepSim, fireOverdrive } from './game/sim'
import {
  applyTutorialUrlFlag,
  isTutorialDone,
  startTutorial,
  skipTutorial,
  dismissJit,
  resetTutorialProgress,
  isReplayTipSeen,
  markReplayTipSeen,
  WARMUP_COPY,
} from './game/tutorial'
import { drawFrame } from './render/draw'
import { clamp } from './game/math'
import { getArenaLayout } from './game/layout'
import { makeProjection } from './render/projection'
import {
  addHighScore,
  entriesForDate,
  getBestDepth,
  getBestScoreForDate,
  loadHighScores,
  loadLastPlayerName,
  localDates,
  qualifiesForDate,
  saveHighScores,
  saveLastPlayerName,
  type HighScoreEntry,
} from './game/highScores'
import { clearGameState, loadGameState, saveGameState } from './game/gameState'
import { musicEngine } from './audio/music'
import type { TrackInfo } from './audio/music'
import { sfxEngine } from './audio/sfx'
import { useMutation, useQuery } from 'convex/react'
import { api } from '../convex/_generated/api'
import { getOrCreatePlayerId, isConvexConfigured } from './game/playerId'
import { getTodayDateKey } from './game/rng'
import { PIECE_KEY, PieceSwatch } from './components/pieceKey'
import { MusicHud } from './components/MusicHud'
import { GameOverScreen, stepDateKey } from './components/GameOverScreen'
import { useWellInput } from './hooks/useWellInput'
import { SettingsPanel } from './components/SettingsPanel'

type HudSnapshot = {
  paused: boolean
  pauseBtnBottomPx: number
  depth: number
  score: number
  gameOver: boolean
  // First-run onboarding: the active warmup beat (drives the callout band) and
  // the active just-in-time coachmark kind (drives the OK card). Null otherwise.
  tutorialBeat: TutorialBeat | null
  jitKind: TeachKind | null
  // Screen-space anchor (CSS px) of the highlighted JIT piece, so the OK card can
  // appear right next to it. `r` is the spotlight radius. Null when no coachmark.
  jitAnchor: { x: number; y: number; r: number } | null
}

// Game-over leaderboard: rows shown for the selected day. Kept small so the
// panel stays within the viewport (no scrolling); the board is navigated by
// DATE (prev/next day) rather than by score page, and the player's own row is
// pinned below when it falls outside this top slice.
const GAMEOVER_LB_PAGE_SIZE = 5

// How far back the date stepper can travel (days). A generous floor that avoids
// stepping forever into empty history.
const MAX_DATE_BACK_DAYS = 365

// Touch capability — used only to tailor the warmup OVERDRIVE callout (desktop
// players also get the Space shortcut). Computed once at module load.
const HAS_TOUCH =
  typeof window !== 'undefined' &&
  ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0)

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
  // Read by the window-level pointer handlers so a tap while the music panel is
  // open is consumed only by the panel's outside-tap scrim (it must not also
  // re-trigger the canvas dock button or steer the well).
  const musicPanelOpenRef = useRef(false)
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
      // URL override (?tutorial=1 / ?tutorial=0) definitively forces all tutorial
      // flags on or off before we decide how to boot. No-op when absent.
      applyTutorialUrlFlag()
      // Only resume a saved mid-run once the tutorial is complete; if onboarding
      // is still pending (first-time player, or ?tutorial=1), ignore any stale
      // save and (re)start the warmup so the override is honored.
      const boot = (() => {
        if (isTutorialDone()) {
          const saved = loadGameState()
          if (saved) return saved
          return createInitialRunState()
        }
        const fresh = createInitialRunState()
        startTutorial(fresh)
        return fresh
      })()
      // The title screen owns the boot moment: hold the sim paused until the
      // player presses Play (a restored game-over skips the title and lands on
      // its own screen).
      if (!boot.gameOver) boot.paused = true
      return boot
    })()
  )
  // Whether boot restored a mid-run save (title shows Resume + Restart).
  const bootHadSaveRef = useRef(
    stateRef.current.timeSec > 0.5 && !stateRef.current.gameOver,
  )
  // 'title' until the player presses Play; the Esc/Space handlers and the
  // pause overlay are gated on this so the title can't be escaped around.
  const [screen, setScreen] = useState<'title' | 'playing'>(() =>
    stateRef.current.gameOver ? 'playing' : 'title',
  )
  const screenRef = useRef(screen)
  useEffect(() => {
    screenRef.current = screen
  }, [screen])
  const [settingsOpen, setSettingsOpen] = useState(false)

  const computePauseBtnBottomPx = useCallback(() => {
    const s = stateRef.current
    const layout = getArenaLayout(s.view)
    // Place the button just above the death line.
    const margin = 8
    return Math.max(10, s.view.height - layout.failY + margin)
  }, [])

  // Screen-space anchor (CSS px) + spotlight radius of the active JIT piece, so
  // the OK card can be placed right beside it. Mirrors the canvas spotlight math.
  const computeJitAnchor = useCallback((s: RunState) => {
    if (!s.jit) return null
    const layout = getArenaLayout(s.view)
    const proj = makeProjection(s.view, layout)
    let cxw = s.view.width / 2
    let cyw = s.view.height / 2
    let ext = 40
    if (s.jit.isFeature) {
      const f = s.features.find((x) => x.id === s.jit!.entityId)
      if (f) {
        cxw = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
        cyw = f.pos.y + (f.localAabb.minY + f.localAabb.maxY) * 0.5
        ext = Math.max(f.localAabb.maxX - f.localAabb.minX, f.localAabb.maxY - f.localAabb.minY) * 0.6
      }
    } else {
      const b = s.blocks.find((x) => x.id === s.jit!.entityId)
      if (b) {
        cxw = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
        cyw = b.pos.y + (b.localAabb.minY + b.localAabb.maxY) * 0.5
        ext = Math.max(b.localAabb.maxX - b.localAabb.minX, b.localAabb.maxY - b.localAabb.minY) * 0.6
      }
    }
    const pp = proj.project(cxw, cyw)
    return { x: pp.x, y: pp.y, r: ext * pp.scale + 22 }
  }, [])

  const [hud, setHud] = useState<HudSnapshot>(() => ({
    paused: stateRef.current.paused,
    pauseBtnBottomPx: computePauseBtnBottomPx(),
    depth: stateRef.current.depth,
    score: stateRef.current.score,
    // Honor a restored game-over so the screen shows instantly on refresh.
    gameOver: stateRef.current.gameOver,
    tutorialBeat:
      stateRef.current.tutorial?.phase === 'warmup' ? stateRef.current.tutorial.beat : null,
    jitKind: stateRef.current.jit?.kind ?? null,
    jitAnchor: computeJitAnchor(stateRef.current),
  }))
  // True only for the very first game-over render after a refresh that restored a
  // game-over'd run — used to skip the death wind-down (jump straight to the modal).
  const restoredGameOverRef = useRef(stateRef.current.gameOver)

  const [musicOn, setMusicOn] = useState<boolean>(() => musicEngine.isWantPlaying())
  // Music control panel: a small popover (Pause / Next / Volume) opened from the
  // in-game canvas music button or the bottom-right button on the pause / game-over
  // screens. `musicPanelPos` is the fixed px anchor (computed per trigger).
  const [musicPanelOpen, setMusicPanelOpen] = useState(false)
  const [musicPanelPos, setMusicPanelPos] = useState<{ left: number; bottom: number }>({
    left: 16,
    bottom: 84,
  })
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [volume, setVolume] = useState<number>(() => musicEngine.getVolume())
  // Track shown by the now-playing card while the panel is open (the live current
  // track, independent of the auto-pop timer).
  const [panelTrack, setPanelTrack] = useState<TrackInfo | null>(null)
  // Artwork URL that failed to load (404 / not an image). When the card's art
  // matches this, we drop the art box entirely and let the card shrink.
  const [brokenArtSrc, setBrokenArtSrc] = useState<string | null>(null)
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
  // `qualifiesBest` = this run earned a top-N local spot (offer the inline name
  // save). `savedThisRun` collapses that row once saved. `gameOverReady` gates the
  // modal so the run gets a brief wind-down beat before it appears.
  const [showNamePrompt, setShowNamePrompt] = useState(false)
  const [savedThisRun, setSavedThisRun] = useState(false)
  const [gameOverReady, setGameOverReady] = useState(false)
  // One-time first-run game-over note that sells the daily replay loop.
  const [showReplayTip, setShowReplayTip] = useState(false)
  const [pendingScoreDepth, setPendingScoreDepth] = useState<number | null>(null)
  const [pendingScore, setPendingScore] = useState<number | null>(null)
  const handledGameOverRef = useRef(false)
  // Game-over leaderboard view: which board, and which day is being viewed. Both
  // the local and global boards are keyed by `viewDate` and stepped together.
  const [lbTab, setLbTab] = useState<'daily' | 'local'>('daily')
  const [viewDate, setViewDate] = useState<string>(() => getTodayDateKey())

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
    convexConfigured && hud.gameOver ? { dateKey: viewDate } : 'skip',
  )
  // Earliest day the global board has any record for, so backward date paging
  // stops at the start of recorded history rather than scrolling indefinitely.
  const earliestGlobalDate = useQuery(
    api.leaderboard.getEarliestDailyDate,
    convexConfigured && hud.gameOver ? {} : 'skip',
  )

  const setPaused = useCallback((paused: boolean) => {
    stateRef.current.paused = paused
    setHud((h) => ({ ...h, paused }))
  }, [])

  // Keep the sim/draw layer informed of the device-best depth + score so the HUD
  // "BEST" label can render.
  useEffect(() => {
    stateRef.current.bestDepthLocal = getBestDepth(highScores)
    stateRef.current.bestScoreLocal = getBestScoreForDate(highScores, stateRef.current.dateKey)
  }, [highScores])

  // Pointer input: the gravity-well puck (see hooks/useWellInput).
  useWellInput({ stateRef, canvasRef, musicPanelOpenRef, dockActionsRef })


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

  // Music transport (panel buttons). Driven synchronously inside the click
  // handler so audio.play()/ctx.resume() keep the user-activation they need.
  const toggleMusicPlayback = useCallback(() => {
    const next = !musicEngine.isWantPlaying()
    musicEngine.setWantPlaying(next)
    setMusicOn(next)
  }, [])

  const nextTrack = useCallback(() => {
    void musicEngine.next()
    setMusicOn(true)
    // Reflect the freshly-picked track in the now-playing card right away.
    const np = musicEngine.getNowPlaying()
    if (np) setPanelTrack(np.info)
  }, [])

  const changeVolume = useCallback((v: number) => {
    musicEngine.setVolume(v)
    setVolume(v)
  }, [])

  const closeMusicPanel = useCallback(() => {
    setMusicPanelOpen(false)
    setVolumeOpen(false)
  }, [])

  // Open (or toggle) the panel, anchored to whichever button triggered it.
  // `anchor` is the fixed px box the panel should float above.
  const openMusicPanel = useCallback(
    (left: number, bottom: number) => {
      setMusicPanelPos({ left, bottom })
      setPanelTrack(musicEngine.getNowPlaying()?.info ?? null)
      setVolume(musicEngine.getVolume())
      setMusicPanelOpen(true)
    },
    [],
  )

  // In-game trigger: the canvas music button (bottom-left dock). Anchor the panel
  // just above it, centered, clamped to the viewport.
  const PANEL_W = 244
  const toggleDockMusicPanel = useCallback(() => {
    if (musicPanelOpen) {
      closeMusicPanel()
      return
    }
    const canvas = canvasRef.current
    const s = stateRef.current
    let left = 16
    let bottom = 84
    if (canvas) {
      const rect = canvas.getBoundingClientRect()
      const d = getArenaLayout(s.view).dock
      const cx = rect.left + d.music.cx
      const btnTop = rect.top + d.music.cy - d.btnR
      left = Math.min(
        Math.max(8, cx - PANEL_W / 2),
        window.innerWidth - PANEL_W - 8,
      )
      bottom = Math.max(8, window.innerHeight - btnTop + 12)
    }
    openMusicPanel(left, bottom)
  }, [musicPanelOpen, closeMusicPanel, openMusicPanel])

  // Bottom-right trigger used on the pause / game-over overlays.
  const toggleCornerMusicPanel = useCallback(() => {
    if (musicPanelOpen) {
      closeMusicPanel()
      return
    }
    const left = Math.max(8, window.innerWidth - PANEL_W - 16)
    openMusicPanel(left, 84)
  }, [musicPanelOpen, closeMusicPanel, openMusicPanel])

  // Muffle the soundtrack whenever the game isn't live (title, pause, game
  // over): lowpass + gain dip, smoothly ramped in the engine.
  useEffect(() => {
    musicEngine.setDucked(hud.paused || hud.gameOver)
  }, [hud.paused, hud.gameOver])

  // Close the music panel when the game transitions between play / pause /
  // game-over so a panel anchored to a now-gone trigger never lingers.
  useEffect(() => {
    closeMusicPanel()
  }, [hud.paused, hud.gameOver, closeMusicPanel])

  // While the music panel is open, keep the now-playing card current: a track
  // that begins or changes after the panel opened (e.g. it was still loading, or
  // the player hit Next) gets reflected without waiting for the auto-pop tick.
  useEffect(() => {
    if (!musicPanelOpen) return
    const refresh = () => setPanelTrack(musicEngine.getNowPlaying()?.info ?? null)
    refresh()
    const id = window.setInterval(refresh, 500)
    return () => window.clearInterval(id)
  }, [musicPanelOpen])

  // Feed the latest dock state/handlers to the []-dep RAF + pointer effects via
  // refs (so the on-canvas dock can draw + respond without re-subscribing).
  musicOnRef.current = musicOn
  musicPanelOpenRef.current = musicPanelOpen
  dockActionsRef.current.toggleMusic = toggleDockMusicPanel
  dockActionsRef.current.togglePause = () => {
    if (screenRef.current !== 'playing') return
    if (stateRef.current.gameOver) return
    // A just-in-time coachmark owns the pause; the OK card resumes it.
    if (stateRef.current.jit) return
    setPaused(!stateRef.current.paused)
  }

  // Esc toggles the upgrade menu (and pauses/resumes accordingly).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Spacebar fires overdrive on desktop (mirrors the tap-to-fire gesture).
      if (e.key === ' ' || e.code === 'Space') {
        if (e.repeat) return
        if (screenRef.current !== 'playing') return
        e.preventDefault()
        const s = stateRef.current
        if (s.paused || s.gameOver) return
        fireOverdrive(s)
        return
      }
      if (e.key !== 'Escape') return
      if (e.repeat) return
      if (screenRef.current !== 'playing') return
      e.preventDefault()
      if (stateRef.current.gameOver) return
      // A just-in-time coachmark owns the pause; only its OK button resumes.
      if (stateRef.current.jit) return
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

      // Hit-stop: a pending stop consumes frames instead of stepping the sim
      // (the renderer keeps drawing, so the freeze reads as impact, not jank).
      if (!s.paused && !s.gameOver && !audioGateRef.current) {
        if (s.hitStopSec > 0) s.hitStopSec = Math.max(0, s.hitStopSec - dtSec)
        else stepSim(s, dtSec)
      }

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
          tutorialBeat: s.tutorial?.phase === 'warmup' ? s.tutorial.beat : null,
          jitKind: s.jit?.kind ?? null,
          jitAnchor: computeJitAnchor(s),
        })
        // Publish the live music hue so the DOM menus (pause / game over) can ride
        // the soundtrack like the canvas does. Frozen to the cold cyan accent when
        // nothing is playing. Throttled with the HUD bucket (hue drifts slowly).
        document.documentElement.style.setProperty(
          '--accent-hue',
          (s.music.playing ? s.music.hue : 200).toFixed(1),
        )

        // Keep the now-playing card inside the empty top-left gutter so it never
        // covers the play trapezoid. The board's left edge slopes inward as it
        // descends, so the binding constraint is the card's BOTTOM: publish the
        // screen-x of the board's left edge there (minus margins) as the card's
        // max width.
        {
          const layout = getArenaLayout(s.view)
          const proj = makeProjection(s.view, layout)
          const cardLeft = 10
          // Card top (~10px) + height (~64px) + a buffer for any top safe-area
          // inset, so the published width stays conservative on notched phones.
          const cardBottomY = 96
          const worldYAtBottom = proj.unproject(0, cardBottomY).y
          const edgeX = proj.project(0, worldYAtBottom).x
          const maxW = Math.max(120, edgeX - cardLeft - 8)
          document.documentElement.style.setProperty('--np-max-w', `${maxW.toFixed(0)}px`)
        }

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
    fresh.bestScoreLocal = getBestScoreForDate(highScores, fresh.dateKey)
    Object.assign(prev, fresh)
    handledGameOverRef.current = false
    setHud({
      paused: false,
      pauseBtnBottomPx: computePauseBtnBottomPx(),
      depth: 0,
      score: 0,
      gameOver: false,
      tutorialBeat: null,
      jitKind: null,
      jitAnchor: null,
    })
    // Clear saved state when player explicitly restarts
    clearGameState()
  }, [computePauseBtnBottomPx, highScores])

  // "Replay tutorial" (pause menu): forget all first-run progress and drop back
  // into the directed warmup. Keeps the same run object so the RAF loop persists.
  const replayTutorial = useCallback(() => {
    resetTutorialProgress()
    const prev = stateRef.current
    const fresh = createInitialRunState()
    fresh.view = prev.view
    fresh.input = prev.input
    fresh.bestDepthLocal = getBestDepth(highScores)
    fresh.bestScoreLocal = getBestScoreForDate(highScores, fresh.dateKey)
    startTutorial(fresh)
    Object.assign(prev, fresh)
    handledGameOverRef.current = false
    setHud({
      paused: false,
      pauseBtnBottomPx: computePauseBtnBottomPx(),
      depth: 0,
      score: 0,
      gameOver: false,
      tutorialBeat: fresh.tutorial?.phase === 'warmup' ? fresh.tutorial.beat : null,
      jitKind: null,
      jitAnchor: null,
    })
    clearGameState()
  }, [computePauseBtnBottomPx, highScores])

  // Game-over wind-down: give the run a short beat (the death FX settle) before
  // the modal appears, instead of slamming it in the instant the run ends.
  // useLayoutEffect so the "not ready" state is committed before paint and the
  // modal never flashes for a frame.
  useLayoutEffect(() => {
    if (!hud.gameOver) {
      setGameOverReady(false)
      // A live run is now in progress, so any death from here earns the
      // wind-down beat. (Also retires the "restored" flag once a new run starts.)
      restoredGameOverRef.current = false
      return
    }
    // Restored game-over (page refresh into an already-ended run): show the modal
    // instantly, no wind-down. Don't consume the flag here — dev StrictMode double-
    // invokes effects, and the flag stays valid until a real new run begins (the
    // !hud.gameOver branch above), so the second invocation still shows instantly.
    if (restoredGameOverRef.current) {
      setGameOverReady(true)
      return
    }
    setGameOverReady(false)
    const tid = window.setTimeout(() => setGameOverReady(true), 1300)
    return () => window.clearTimeout(tid)
  }, [hud.gameOver])

  // One-time first-run game-over note (sells the daily replay loop). Shows once
  // on the first game over the player reaches, then never again.
  useEffect(() => {
    if (!hud.gameOver) {
      setShowReplayTip(false)
      return
    }
    if (gameOverReady && !isReplayTipSeen()) {
      setShowReplayTip(true)
      markReplayTipSeen()
    }
  }, [hud.gameOver, gameOverReady])

  // When a run ends, decide whether we need to prompt for a name (top-5 by score).
  useEffect(() => {
    if (!hud.gameOver) {
      handledGameOverRef.current = false
      setShowNamePrompt(false)
      setSavedThisRun(false)
      setPendingScoreDepth(null)
      setPendingScore(null)
      setLbTab('daily')
      setViewDate(getTodayDateKey())
      return
    }
    if (handledGameOverRef.current) return
    handledGameOverRef.current = true

    const s = stateRef.current
    // Each run lands on its own day; open the board on that day.
    setViewDate(s.dateKey)
    setPendingScoreDepth(hud.depth)
    setPendingScore(hud.score)
    // If the local score was already committed (e.g. saved before a refresh),
    // don't offer the save again — reflect it as already-saved instead.
    setSavedThisRun(s.localSaved)
    if (!s.localSaved && qualifiesForDate(highScores, s.dateKey, hud.score)) {
      setShowNamePrompt(true)
    }
    // Persist the game-over snapshot once so a refresh lands straight here (the
    // per-frame autosave stops at game over).
    saveGameState(s)

    // Fire-and-forget global submit on the FIRST game-over for this run only. The
    // server upserts the player's best row for the day, but we still guard with
    // `globalSubmitted` so a refresh of a game-over'd run never re-submits. Uses
    // the last saved name until the player enters a new one.
    if (convexConfigured && hud.score > 0 && !s.globalSubmitted) {
      s.globalSubmitted = true
      saveGameState(s)
      submitDailyGlobal({
        playerId: playerIdRef.current,
        name: loadLastPlayerName() || 'PLAYER',
        score: hud.score,
        depth: hud.depth,
        dateKey: s.dateKey,
        savedAt: Date.now(),
      }).catch(() => {})
    }
  }, [hud.gameOver, hud.depth, hud.score, highScores, convexConfigured, submitDailyGlobal])

  const saveRunScore = useCallback(
    (name: string) => {
      if (pendingScoreDepth == null || pendingScore == null) return
      const s = stateRef.current
      // Hard guard: a run's local high score is committed at most once, ever —
      // even across refreshes (the flag is persisted with the game-over snapshot).
      if (s.localSaved) {
        setSavedThisRun(true)
        return
      }
      const clean = name.trim() || 'PLAYER'
      const next = addHighScore(highScores, {
        name: clean,
        depth: pendingScoreDepth,
        score: pendingScore,
        dateKey: s.dateKey,
      })
      setHighScores(next)
      saveHighScores(next)
      saveLastPlayerName(clean)
      setSavedThisRun(true)
      // Mark + persist so a refresh can't re-open the save flow for this run.
      s.localSaved = true
      s.globalSubmitted = true
      saveGameState(s)
      // Update local bests immediately for the live HUD labels on subsequent runs.
      s.bestDepthLocal = getBestDepth(next)
      s.bestScoreLocal = getBestScoreForDate(next, s.dateKey)
      // Re-submit globally with the chosen name so the daily row shows it too.
      if (convexConfigured) {
        submitDailyGlobal({
          playerId: playerIdRef.current,
          name: clean,
          score: pendingScore,
          depth: pendingScoreDepth,
          dateKey: s.dateKey,
          savedAt: Date.now(),
        }).catch(() => {})
      }
    },
    [highScores, pendingScoreDepth, pendingScore, convexConfigured, submitDailyGlobal],
  )

  const submitHighScore = useCallback(() => {
    saveRunScore(nameDraft)
  }, [saveRunScore, nameDraft])

  // Play Again from the game-over screen. If the player earned a high score but
  // never tapped Save, persist it under their remembered name first so a qualifying
  // run is never silently lost just because they jumped straight back in.
  const playAgain = useCallback(() => {
    if (showNamePrompt && !savedThisRun) saveRunScore(nameDraft)
    restart()
  }, [showNamePrompt, savedThisRun, saveRunScore, nameDraft, restart])

  // ---- Title screen ------------------------------------------------------
  // Play / Resume: commits the name (so the global board never shows PLAYER
  // for want of asking), unlocks audio inside the click gesture (the iOS
  // tap-to-resume fix), and releases the sim.
  const startPlay = useCallback(() => {
    const clean = nameDraft.trim() || 'PLAYER'
    setNameDraft(clean)
    saveLastPlayerName(clean)
    sfxEngine.unlock()
    if (musicEngine.isWantPlaying()) void musicEngine.start()
    stateRef.current.paused = false
    setHud((h) => ({ ...h, paused: false }))
    setScreen('playing')
  }, [nameDraft])

  // Title "Restart today's run": discard the restored save but stay on the
  // title; the Play button then starts the fresh run.
  const restartFromTitle = useCallback(() => {
    restart()
    stateRef.current.paused = true
    setHud((h) => ({ ...h, paused: true }))
    bootHadSaveRef.current = false
  }, [restart])

  // Local placement of the just-finished run within ITS day (1-based), for the
  // "New high score" banner. Computed before this run was inserted.
  const runLocalRank = useMemo(() => {
    if (pendingScore == null) return null
    return (
      entriesForDate(highScores, stateRef.current.dateKey).filter(
        (e) => e.score >= pendingScore,
      ).length + 1
    )
  }, [highScores, pendingScore])

  // Whether this run is a new GLOBAL best — i.e. it beat the player's previous
  // best for today, so it improves their row on the global daily board. (The
  // global board keeps one best row per player per day.)
  const isGlobalBest = useMemo(() => {
    if (!convexConfigured || pendingScore == null) return false
    const prevBestToday = entriesForDate(highScores, stateRef.current.dateKey).reduce(
      (m, e) => Math.max(m, e.score),
      0,
    )
    return pendingScore > prevBestToday
  }, [convexConfigured, highScores, pendingScore])

  // Global placement (1-based) on today's daily board. Prefer the player's own
  // row once the submit lands; until then estimate from where the score slots.
  // null while the board is still loading so we don't flash a wrong rank.
  const runGlobalRank = useMemo(() => {
    if (!convexConfigured || pendingScore == null) return null
    const rows = globalDailyScores
    if (!rows || rows.length === 0) return null
    const mineIdx = rows.findIndex((r) => r.playerId === playerIdRef.current)
    if (mineIdx >= 0) return mineIdx + 1
    return rows.filter((r) => r.score > pendingScore).length + 1
  }, [convexConfigured, globalDailyScores, pendingScore])

  // Run stats for the menus (pause + game over). Recomputed only when a menu
  // is actually open.
  const pauseStats = useMemo(() => {
    const menuOpen = hud.paused || hud.gameOver
    if (!menuOpen) return null
    return computePauseStats(stateRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hud.paused, hud.gameOver, hud.depth, hud.score])

  // Game-over leaderboard view model: a single bounded, tabbed, paginated
  // region so the panel never grows past the viewport no matter how many rows
  // exist. The active tab falls back to whichever board has data.
  const dailyRows = convexConfigured && globalDailyScores ? globalDailyScores : []
  const localRows = entriesForDate(highScores, viewDate)
  const showGlobalTab = convexConfigured
  const hasAnyLocalEver = highScores.length > 0
  const showLeaderboard = showGlobalTab || hasAnyLocalEver
  // Global tab requires Convex; otherwise the board is local-only.
  const activeTab: 'daily' | 'local' = lbTab === 'daily' && showGlobalTab ? 'daily' : 'local'
  const lbRows = activeTab === 'daily' ? dailyRows : localRows
  const lbTopRows = lbRows.slice(0, GAMEOVER_LB_PAGE_SIZE)
  // On the global board, pin the player's own row when it's below the visible
  // top slice so they always see their standing for the day.
  const myDailyIdx =
    activeTab === 'daily' ? dailyRows.findIndex((e) => e.playerId === playerIdRef.current) : -1
  const lbPinnedMe = myDailyIdx >= GAMEOVER_LB_PAGE_SIZE ? dailyRows[myDailyIdx]! : null
  // Date stepper bounds: can't view the future, and stops at the earliest day
  // the active board actually has records for (no scrolling into empty history).
  // An absolute cap guards against any stray far-past dateKey.
  const capDate = stepDateKey(todayKey, -MAX_DATE_BACK_DAYS)
  const localFloor = (() => {
    const dates = localDates(highScores)
    return dates.length ? dates[dates.length - 1]! : todayKey
  })()
  const globalFloor = earliestGlobalDate ?? todayKey
  const activeFloor = activeTab === 'daily' ? globalFloor : localFloor
  const floorDate = activeFloor > capDate ? activeFloor : capDate
  const atToday = viewDate >= todayKey
  const atFloor = viewDate <= floorDate

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

            {/* Music UI: now-playing card, corner trigger, transport popover. */}
            <MusicHud
              musicOn={musicOn}
              musicPanelOpen={musicPanelOpen}
              musicPanelPos={musicPanelPos}
              panelTrack={panelTrack}
              nowPlaying={nowPlaying}
              npLeaving={npLeaving}
              brokenArtSrc={brokenArtSrc}
              setBrokenArtSrc={setBrokenArtSrc}
              showCornerBtn={hud.paused || (hud.gameOver && gameOverReady)}
              toggleCornerMusicPanel={toggleCornerMusicPanel}
              closeMusicPanel={closeMusicPanel}
              toggleMusicPlayback={toggleMusicPlayback}
              nextTrack={nextTrack}
              volumeOpen={volumeOpen}
              setVolumeOpen={setVolumeOpen}
              volume={volume}
              changeVolume={changeVolume}
            />


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

            {/* Directed-warmup callout band: one fixed location, plain language,
                with an always-available Skip. Hidden while paused or during a
                just-in-time coachmark. */}
            {hud.tutorialBeat && !hud.jitKind && !hud.paused && !hud.gameOver && (
              <div className="ftueBand" role="status">
                <span className="ftueBandText">
                  {hud.tutorialBeat === 'overdrive' && !HAS_TOUCH
                    ? 'Tap or press Space to OVERDRIVE your laser.'
                    : WARMUP_COPY[hud.tutorialBeat]}
                </span>
                <button
                  type="button"
                  className="ftueSkip"
                  onClick={() => {
                    skipTutorial(stateRef.current)
                    setHud((h) => ({ ...h, tutorialBeat: null }))
                  }}
                >
                  Skip
                </button>
              </div>
            )}

            {/* Just-in-time piece coachmark. The canvas dims the scene and
                spotlights the piece; this card carries the name + desc + art
                (reusing the pause-menu Key) and an OK button that resumes play. */}
            {hud.jitKind &&
              (() => {
                const item = PIECE_KEY.find((k) => k.kind === hud.jitKind)
                if (!item) return null
                // Place the card next to the highlighted piece: below it when the
                // piece is in the upper half, above it otherwise. Clamped on-screen.
                const a = hud.jitAnchor
                const vw = stateRef.current.view.width
                const vh = stateRef.current.view.height
                const cardW = Math.min(380, vw * 0.92)
                const cx = a
                  ? Math.min(Math.max(a.x, cardW / 2 + 8), vw - cardW / 2 - 8)
                  : vw / 2
                const below = a ? a.y < vh * 0.5 : true
                const panelStyle: CSSProperties = a
                  ? below
                    ? { left: cx, top: a.y + a.r + 16, transform: 'translateX(-50%)' }
                    : { left: cx, top: a.y - a.r - 16, transform: 'translate(-50%, -100%)' }
                  : { left: vw / 2, bottom: 24, transform: 'translateX(-50%)' }
                return (
                  <div className="ftueJitOverlay" role="dialog" aria-label={item.name}>
                    <div className="ftueJitPanel" style={panelStyle}>
                      <div className="menuKicker">New piece</div>
                      <div className="ftueJitRow">
                        <PieceSwatch kind={item.kind} />
                        <div className="ftueJitText">
                          <div className="ftueJitName">{item.name}</div>
                          <div className="ftueJitDesc">{item.desc}</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="menuBtn primary ftueJitOk"
                        onClick={() => {
                          dismissJit(stateRef.current)
                          setHud((h) => ({ ...h, jitKind: null, paused: false }))
                        }}
                      >
                        OK
                      </button>
                    </div>
                  </div>
                )
              })()}

            {/* Pause overlay. Suppressed while a just-in-time coachmark owns the
                pause (its own OK card shows instead). */}
            {screen === 'playing' && hud.paused && !hud.gameOver && !hud.jitKind && pauseStats && (
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

                  <button type="button" className="menuLink" onClick={() => setSettingsOpen(true)}>
                    Settings
                  </button>
                  <button type="button" className="menuLink ftueReplayLink" onClick={replayTutorial}>
                    Replay tutorial
                  </button>
                </div>
              </div>
            )}

            {/* Title screen: the daily ritual's front door. Frames today's
                board, carries the streak, takes the player's name up front
                (so the global board isn't full of PLAYER), and gives the
                music a real gesture to start from. */}
            {screen === 'title' && !hud.gameOver && (
              <div className="menuOverlay titleOverlay" role="dialog" aria-label="laserburn">
                <div className="menuPanel titlePanel">
                  <div className="titleLogo">LASERBURN</div>
                  <div className="titleSub">
                    Today&apos;s board ·{' '}
                    {new Date().toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                  <div className="titleChips">
                    {getBestScoreForDate(highScores, todayKey) > 0 && (
                      <span className="titleChip">
                        Best today {getBestScoreForDate(highScores, todayKey).toLocaleString()}
                      </span>
                    )}
                  </div>
                  <div className="nameSaveRow titleName">
                    <input
                      className="menuInput"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') startPlay()
                      }}
                      maxLength={16}
                      placeholder="PLAYER"
                      aria-label="Your name"
                    />
                  </div>
                  <div className="menuActions">
                    <button type="button" className="menuBtn primary titlePlay" onClick={startPlay}>
                      {bootHadSaveRef.current ? 'Resume' : 'Play'}
                    </button>
                  </div>
                  {bootHadSaveRef.current && (
                    <button type="button" className="menuLink" onClick={restartFromTitle}>
                      Restart today&apos;s run
                    </button>
                  )}
                  <button type="button" className="menuLink" onClick={() => setSettingsOpen(true)}>
                    Settings
                  </button>
                </div>
              </div>
            )}

            {settingsOpen && (
              <SettingsPanel
                musicVolume={volume}
                onMusicVolume={changeVolume}
                onClose={() => setSettingsOpen(false)}
              />
            )}

            {/* Game-over overlay. Appears after a short wind-down beat; the name
                save is inline and non-blocking (leaderboard + Play Again stay
                visible the whole time). */}
            {hud.gameOver && gameOverReady && (
              <GameOverScreen
                score={hud.score}
                depth={hud.depth}
                pauseStats={pauseStats}
                showReplayTip={showReplayTip}
                showNamePrompt={showNamePrompt}
                savedThisRun={savedThisRun}
                nameDraft={nameDraft}
                setNameDraft={setNameDraft}
                submitHighScore={submitHighScore}
                isGlobalBest={isGlobalBest}
                runGlobalRank={runGlobalRank}
                runLocalRank={runLocalRank}
                showLeaderboard={showLeaderboard}
                showGlobalTab={showGlobalTab}
                activeTab={activeTab}
                setLbTab={setLbTab}
                lbTopRows={lbTopRows}
                lbPinnedMe={lbPinnedMe}
                myDailyIdx={myDailyIdx}
                playerId={playerIdRef.current}
                pendingScore={pendingScore}
                pendingScoreDepth={pendingScoreDepth}
                runDateKey={stateRef.current.dateKey}
                viewDate={viewDate}
                setViewDate={setViewDate}
                todayKey={todayKey}
                atToday={atToday}
                atFloor={atFloor}
                playAgain={playAgain}
              />
            )}


          </div>
        </main>
      </div>
    </div>
  )
}
