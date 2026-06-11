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
// import { computeXpCap, getRarityColor } from './game/levelUp'  // Unused after upgrade system removal
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

// Shift a YYYY-MM-DD key by whole days, returning the new key (local calendar).
const stepDateKey = (dateKey: string, deltaDays: number): string => {
  const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() + deltaDays)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

// Compact, human label for the date stepper: Today / Yesterday / "Jun 8" (with
// the year appended only when it isn't the current one).
const formatDateLabel = (dateKey: string, todayKey: string): string => {
  if (dateKey === todayKey) return 'Today'
  if (dateKey === stepDateKey(todayKey, -1)) return 'Yesterday'
  const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const sameYear = (y ?? 0) === new Date().getFullYear()
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: '2-digit' }),
  })
}

// Legend shown in the pause menu: the special pieces/features and what each one
// does, in plain language. Each row renders the REAL in-game artwork (via the
// shared piece renderer) rather than a stand-in glyph, so it's instantly
// recognizable. Block kinds are drawn as a 2x2 footprint.
const PIECE_KEY: { kind: SwatchKind; name: string; desc: string }[] = [
  {
    kind: 'gold',
    name: 'Gold block',
    desc: 'Worth far more points and Overdrive charge.',
  },
  {
    kind: 'fast',
    name: 'Fast block',
    desc: 'Drops 2x as far every other time it drops.',
  },
  {
    kind: 'armored',
    name: 'Armored block',
    desc: 'Its mirrored bottom deflects your laser and resists damage. Hit the sides or top.',
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

// A single legend icon: draws the real piece artwork into a small canvas. Kept
// compact so the (now 6-row) pause-menu Key fits on one screen without scrolling.
const SWATCH_BOX = 36
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

// Auto-marquee: shows `text` statically when it fits, and gently scrolls it on a
// seamless loop when it would otherwise be truncated. Re-measures on text change
// and container resize (the now-playing card width is published per frame).
function Marquee({ text, className }: { text: string; className?: string }) {
  const clipRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0) // px to travel per loop; 0 = no scroll

  useLayoutEffect(() => {
    const clip = clipRef.current
    const item = itemRef.current
    if (!clip || !item) return
    const GAP = 36 // px between the repeated copies
    const measure = () => {
      const overflow = item.scrollWidth - clip.clientWidth
      setShift(overflow > 2 ? item.scrollWidth + GAP : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(clip)
    return () => ro.disconnect()
  }, [text])

  const scrolling = shift > 0
  const SPEED = 42 // px per second
  const trackStyle = scrolling
    ? ({
        '--mq-shift': `${shift}px`,
        animationDuration: `${Math.max(4, shift / SPEED)}s`,
      } as CSSProperties)
    : undefined

  return (
    <div ref={clipRef} className={`mqClip${className ? ` ${className}` : ''}`}>
      <div className={`mqTrack${scrolling ? ' scrolling' : ''}`} style={trackStyle}>
        <span ref={itemRef} className="mqItem">
          {text}
        </span>
        {scrolling && (
          <span className="mqItem" aria-hidden="true">
            {text}
          </span>
        )}
      </div>
    </div>
  )
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
      if (isTutorialDone()) {
        const saved = loadGameState()
        if (saved) return saved
        return createInitialRunState()
      }
      const fresh = createInitialRunState()
      startTutorial(fresh)
      return fresh
    })()
  )

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
    paused: false,
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
    if (stateRef.current.gameOver) return
    if (stateRef.current.levelUpActive) return
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
        e.preventDefault()
        const s = stateRef.current
        if (s.paused || s.gameOver || s.levelUpActive) return
        fireOverdrive(s)
        return
      }
      if (e.key !== 'Escape') return
      if (e.repeat) return
      e.preventDefault()
      // While the upgrade chooser is open, do not allow manual unpause.
      // The only way to resume is to pick an upgrade.
      if (stateRef.current.levelUpActive) return
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

      if (!s.paused && !s.gameOver && !audioGateRef.current) stepSim(s, dtSec)

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
    const menuOpen = (hud.paused && !stateRef.current.levelUpActive) || hud.gameOver
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

            {/* "Now playing" corner card — pops in when a new song starts, holds
                briefly, then fades. Also re-shown (pinned) for as long as the music
                panel is open. Non-interactive so taps pass to gameplay. */}
            {(() => {
              const card = musicPanelOpen ? panelTrack ?? nowPlaying : nowPlaying
              // While the panel is open the card is always present (placeholder
              // when no track is known yet); otherwise it only auto-pops.
              if (!card && !musicPanelOpen) return null
              const hasArt = !!card?.artwork && card.artwork !== brokenArtSrc
              const cls = `${musicPanelOpen ? 'nowPlaying pinned' : `nowPlaying${npLeaving ? ' leaving' : ''}`}${
                hasArt ? '' : ' noArt'
              }`
              return (
                <div className={cls} role="status" aria-live="polite">
                  {hasArt && (
                    <img
                      className="npArt"
                      src={card!.artwork}
                      alt=""
                      aria-hidden="true"
                      onError={() => setBrokenArtSrc(card!.artwork ?? null)}
                    />
                  )}
                  <div className="npText">
                    <div className="npEyebrow">Now Playing</div>
                    <Marquee className="npTitle" text={card ? card.title : 'Nothing playing'} />
                    {card && <Marquee className="npArtist" text={card.artist} />}
                    {card && (card.album || card.genre) && (
                      <Marquee className="npAlbum" text={card.album || card.genre || ''} />
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Music control: bottom-right button on the pause / game-over overlays
                (in-game the canvas dock button opens the same panel). Plus the
                shared popover (Pause / Next / Volume) and an outside-tap scrim. */}
            {(hud.paused || (hud.gameOver && gameOverReady)) && (
              <button
                type="button"
                className={`musicCornerBtn${musicOn ? ' on' : ''}`}
                aria-label="Music controls"
                aria-expanded={musicPanelOpen}
                onClick={toggleCornerMusicPanel}
              >
                <span className="musicCornerGlyph" aria-hidden="true">♪</span>
              </button>
            )}

            {musicPanelOpen && (
              <>
                <div
                  className="musicScrim"
                  onPointerDown={closeMusicPanel}
                  aria-hidden="true"
                />
                <div
                  className="musicPanel"
                  role="dialog"
                  aria-label="Music controls"
                  style={{ left: musicPanelPos.left, bottom: musicPanelPos.bottom }}
                >
                  <div className="musicPanelRow">
                    <button
                      type="button"
                      className="musicBtn"
                      aria-label={musicOn ? 'Pause music' : 'Play music'}
                      onClick={toggleMusicPlayback}
                    >
                      {musicOn ? (
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                          <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
                          <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                          <path d="M8 5.5 L8 18.5 L19 12 Z" fill="currentColor" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className="musicBtn"
                      aria-label="Next track"
                      onClick={nextTrack}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path d="M6 5.5 L6 18.5 L15 12 Z" fill="currentColor" />
                        <rect x="16" y="5" width="3" height="14" rx="1.2" fill="currentColor" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`musicBtn${volumeOpen ? ' active' : ''}`}
                      aria-label="Volume"
                      aria-expanded={volumeOpen}
                      onClick={() => setVolumeOpen((v) => !v)}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path
                          d="M4 9 L8 9 L13 5 L13 19 L8 15 L4 15 Z"
                          fill="currentColor"
                        />
                        {volume > 0.02 && (
                          <path
                            d="M16 8.5 A5 5 0 0 1 16 15.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        )}
                      </svg>
                    </button>
                  </div>
                  {volumeOpen && (
                    <div className="musicVolumeRow">
                      <input
                        className="musicVolume"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        aria-label="Volume level"
                        style={{ '--vol': `${Math.round(volume * 100)}%` } as CSSProperties}
                        onChange={(e) => changeVolume(parseFloat(e.target.value))}
                      />
                    </div>
                  )}
                </div>
              </>
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
            {hud.paused && !stateRef.current.levelUpActive && !hud.gameOver && !hud.jitKind && pauseStats && (
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

                  <button type="button" className="menuLink ftueReplayLink" onClick={replayTutorial}>
                    Replay tutorial
                  </button>
                </div>
              </div>
            )}

            {/* Game-over overlay. Appears after a short wind-down beat; the name
                save is inline and non-blocking (leaderboard + Play Again stay
                visible the whole time). */}
            {hud.gameOver && gameOverReady && (
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

                  {showReplayTip && (
                    <div className="ftueReplayNote" role="note">
                      <div className="ftueReplayHeading">Try today&apos;s level again</div>
                      <div className="ftueReplayBody">
                        Today&apos;s level is the same every time you play it. Each day has its
                        own local and global leaderboards &mdash; replay it to beat your score
                        and climb the ranks.
                      </div>
                    </div>
                  )}

                  {showNamePrompt && !savedThisRun && (
                    <div className="menuSection nameSave">
                      <div className="nameSaveBadge">
                        {isGlobalBest
                          ? `New Global High Score${runGlobalRank ? ` · #${runGlobalRank}` : ''}`
                          : `New Local High Score · #${runLocalRank}`}
                      </div>
                      <div className="nameSaveRow">
                        <input
                          className="menuInput"
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitHighScore()
                          }}
                          maxLength={16}
                          placeholder="PLAYER"
                          aria-label="Your name"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="menuBtn primary nameSaveBtn"
                          onClick={submitHighScore}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}

                  {showNamePrompt && savedThisRun && (
                    <div className="nameSaved" role="status">
                      Saved as <strong>{nameDraft.trim() || 'PLAYER'}</strong>
                    </div>
                  )}

                  {showLeaderboard && (
                    <div className="menuSection menuLeaderboard">
                      <div className="lbTabs" role="tablist">
                        {showGlobalTab && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'daily'}
                            className={`lbTab${activeTab === 'daily' ? ' active' : ''}`}
                            onClick={() => setLbTab('daily')}
                          >
                            Global
                          </button>
                        )}
                        <button
                          type="button"
                          role="tab"
                          aria-selected={activeTab === 'local'}
                          className={`lbTab${activeTab === 'local' ? ' active' : ''}`}
                          onClick={() => setLbTab('local')}
                        >
                          Local
                        </button>
                      </div>

                      <ol className="menuScoreList lbList">
                        {lbTopRows.length === 0 ? (
                          <li className="lbEmpty">No runs on this day</li>
                        ) : (
                          lbTopRows.map((e, i) => {
                            const rank = i + 1
                            // Global board: the player's own actor row. Local board:
                            // the run that just finished (matched by score+depth+day).
                            const mine =
                              activeTab === 'daily'
                                ? 'playerId' in e && e.playerId === playerIdRef.current
                                : 'ts' in e &&
                                  pendingScore != null &&
                                  e.score === pendingScore &&
                                  e.depth === pendingScoreDepth &&
                                  e.dateKey === stateRef.current.dateKey
                            const key =
                              'playerId' in e ? `${e.playerId}-${rank}` : `${e.ts}-${rank}`
                            return (
                              <li key={key} className={`menuScoreRow${mine ? ' isMe' : ''}`}>
                                <span className="rank">{rank}</span>
                                <span className="name">
                                  {e.name}
                                  {mine && activeTab === 'daily' && (
                                    <span className="youTag">(YOU)</span>
                                  )}
                                </span>
                                <span className="val">
                                  {e.score.toLocaleString()}
                                  <span className="depth">d{e.depth}</span>
                                </span>
                              </li>
                            )
                          })
                        )}
                        {lbPinnedMe && (
                          <li className="menuScoreRow isMe pinned">
                            <span className="rank">{myDailyIdx + 1}</span>
                            <span className="name">
                              {lbPinnedMe.name}
                              <span className="youTag">(YOU)</span>
                            </span>
                            <span className="val">
                              {lbPinnedMe.score.toLocaleString()}
                              <span className="depth">d{lbPinnedMe.depth}</span>
                            </span>
                          </li>
                        )}
                      </ol>

                      <div className="lbPager lbDateNav">
                        <button
                          type="button"
                          className="lbPagerBtn"
                          disabled={atFloor}
                          aria-label="Previous day"
                          onClick={() => setViewDate((d) => stepDateKey(d, -1))}
                        >
                          ‹
                        </button>
                        <span className="lbPagerLabel lbDateLabel">
                          {formatDateLabel(viewDate, todayKey)}
                        </span>
                        <button
                          type="button"
                          className="lbPagerBtn"
                          disabled={atToday}
                          aria-label="Next day"
                          onClick={() => setViewDate((d) => stepDateKey(d, 1))}
                        >
                          ›
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="menuActions">
                    <button type="button" className="menuBtn primary" onClick={playAgain}>
                      Play Again
                    </button>
                  </div>
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
