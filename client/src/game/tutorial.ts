// First-time onboarding (FTUE).
//
// Two layers, plus a one-time game-over note (the note's persistence lives here
// too so there is one home for first-run flags):
//   1. Directed warmup — a short, action-gated piloted segment that teaches the
//      core loop (steer -> combo -> charge -> overdrive) on a slow, no-death
//      board, then morphs seamlessly into the live daily run on the SAME run
//      object (no remount, no reset flash).
//   2. Just-in-time piece coachmarks — the first time a never-seen piece kind is
//      FULLY on-screen, the game pauses and App shows an OK card. Each kind is
//      recorded permanently so it never triggers again.
//
// Piece-type copy is NOT duplicated here: the JIT card reads it from the
// pause-menu Key (single source of truth in App). This module only owns the
// warmup script, the warmup callout strings, and the first-run persistence.

import type { RunState, TeachKind, TutorialBeat, BlockEntity } from './runState'
import { createInitialRunState } from './runState'
import { getArenaLayout } from './layout'
import { makeProjection } from '../render/projection'
import { spawnTutorialBlock } from './spawn'

// ---- persistence -----------------------------------------------------------

const DONE_KEY = 'laserburn.tutorialDone.v1'
const SEEN_KEY = 'laserburn.seenKinds.v1'
const REPLAY_TIP_KEY = 'laserburn.seenReplayTip.v1'

const lsGet = (k: string): string | null => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* storage unavailable */
  }
}
const lsRemove = (k: string) => {
  try {
    localStorage.removeItem(k)
  } catch {
    /* storage unavailable */
  }
}

let seenCache: Set<TeachKind> | null = null
const loadSeen = (): Set<TeachKind> => {
  if (seenCache) return seenCache
  let arr: unknown = []
  try {
    const raw = lsGet(SEEN_KEY)
    arr = raw ? JSON.parse(raw) : []
  } catch {
    arr = []
  }
  seenCache = new Set(Array.isArray(arr) ? (arr as TeachKind[]) : [])
  return seenCache
}

export const isTutorialDone = (): boolean => lsGet(DONE_KEY) === '1'
const markTutorialDone = () => lsSet(DONE_KEY, '1')

export const markKindSeen = (k: TeachKind) => {
  const set = loadSeen()
  set.add(k)
  lsSet(SEEN_KEY, JSON.stringify([...set]))
}

// Every piece kind the JIT coachmarks teach (used to mark them all seen at once).
const ALL_TEACH_KINDS: TeachKind[] = ['fast', 'armored', 'shatter', 'gold', 'mirror', 'splitter']
const markAllKindsSeen = () => {
  seenCache = new Set(ALL_TEACH_KINDS)
  lsSet(SEEN_KEY, JSON.stringify(ALL_TEACH_KINDS))
}

export const isReplayTipSeen = (): boolean => lsGet(REPLAY_TIP_KEY) === '1'
export const markReplayTipSeen = () => lsSet(REPLAY_TIP_KEY, '1')

// Full re-onboard (used by the pause-menu "Replay tutorial" entry): forget all
// first-run progress so the warmup and every JIT coachmark fire again.
export const resetTutorialProgress = () => {
  lsRemove(DONE_KEY)
  lsRemove(SEEN_KEY)
  lsRemove(REPLAY_TIP_KEY)
  seenCache = null
}

// URL override (works on dev and prod): `?tutorial=1` forces the FULL onboarding
// on (warmup + every JIT coachmark + the game-over tip), `?tutorial=0` forces it
// all off. Call once at boot, before the run state is created. Accepts
// 1/true/on and 0/false/off. Absent param leaves persisted progress untouched.
export const applyTutorialUrlFlag = () => {
  if (typeof window === 'undefined') return
  let v: string | null = null
  try {
    v = new URLSearchParams(window.location.search).get('tutorial')
  } catch {
    return
  }
  if (v == null) return
  const on = v === '1' || v === 'true' || v === 'on'
  const off = v === '0' || v === 'false' || v === 'off'
  if (on) {
    resetTutorialProgress()
  } else if (off) {
    markTutorialDone()
    markAllKindsSeen()
    markReplayTipSeen()
  }
}

// ---- warmup callout copy (plain, exact, in-game terms) ---------------------

export const WARMUP_COPY: Record<TutorialBeat, string> = {
  steer: 'Drag the black hole to bend your laser into the block.',
  combo: 'Chained kills build a combo that multiplies your score.',
  charge: 'Collect sparks with the black hole to charge your Overdrive meter.',
  overdrive: 'Tap to OVERDRIVE your laser.',
  handoff: "Don't let blocks reach the bottom.",
}

// Per-kill charge during the warmup CHARGE beat is boosted so the Overdrive
// meter fills in a few kills instead of a dozen — the tutorial teaches the verb,
// it isn't a grind. (Live play uses the normal economy.)
export const WARMUP_HEAT_PER_KILL = 0.34

// ---- lifecycle -------------------------------------------------------------

export const startTutorial = (s: RunState) => {
  s.tutorial = {
    phase: 'warmup',
    beat: 'steer',
    beatT: 0,
    spawnedThisBeat: false,
    targetBlockId: -1,
  }
  s.jit = null
  s.paused = false
}

// Morph the warmup into the live daily run on the SAME object: rebuild a clean
// first-spawn state but keep the view, input, the placed black hole (so steering
// is continuous), the live music signals, and any local bests. No remount.
const finishWarmup = (s: RunState) => {
  const fresh = createInitialRunState()
  fresh.view = s.view
  fresh.input = s.input
  fresh.well = s.well
  fresh.music = s.music
  fresh.bestDepthLocal = s.bestDepthLocal
  fresh.bestScoreLocal = s.bestScoreLocal
  fresh.tutorial = null
  fresh.jit = null
  // Brief beat before the first live piece so the handoff reads as a breath, not
  // a jump-cut.
  fresh.spawnTimer = 1.1
  Object.assign(s, fresh)
  markTutorialDone()
}

// Skip from the warmup band — same clean handoff, just immediate.
export const skipTutorial = (s: RunState) => finishWarmup(s)

// ---- warmup stepper (action-gated beats) -----------------------------------

export const stepTutorial = (s: RunState, dt: number) => {
  const t = s.tutorial
  if (!t || t.phase !== 'warmup') return
  t.beatT += dt

  const advance = (next: TutorialBeat) => {
    t.beat = next
    t.beatT = 0
    t.spawnedThisBeat = false
    t.targetBlockId = -1
  }

  switch (t.beat) {
    case 'steer': {
      // One block in an off-center lane so the straight beam misses it: the
      // player must place + drag the black hole to bend the beam onto it. NOTE:
      // check the live block count AFTER spawning so the beat can't self-advance
      // on the same tick it spawns its piece.
      if (!t.spawnedThisBeat) {
        t.targetBlockId = spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.26, rowsAbove: 1 })
        t.spawnedThisBeat = true
      }
      if (t.spawnedThisBeat && s.blocks.length === 0) advance('combo')
      break
    }
    case 'combo': {
      // A short staggered sequence so chaining is natural.
      if (!t.spawnedThisBeat) {
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.3, rowsAbove: 1 })
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.62, rowsAbove: 3 })
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.44, rowsAbove: 5 })
        t.spawnedThisBeat = true
      }
      if (s.combo >= 3 || (t.beatT > 0.6 && s.blocks.length === 0)) advance('charge')
      break
    }
    case 'charge': {
      // Kills drop sparks; sweeping them with the well fills the meter. Keep
      // feeding GOLD clusters (huge charge) until the surge is actually armed, so
      // a first-timer is guaranteed to fill it without grinding.
      if (!t.spawnedThisBeat) {
        spawnTutorialBlock(s, { shapeId: 'O4', isGold: true, laneFrac: 0.3, rowsAbove: 1 })
        spawnTutorialBlock(s, { shapeId: 'O4', isGold: true, laneFrac: 0.62, rowsAbove: 3 })
        t.spawnedThisBeat = true
      }
      if (s.overdriveArmed) {
        advance('overdrive')
      } else if (s.blocks.length === 0 && s.heatMotes.length === 0) {
        // Cleared the cluster but still not charged: send another gold pair.
        spawnTutorialBlock(s, { shapeId: 'O4', isGold: true, laneFrac: 0.34, rowsAbove: 1 })
        spawnTutorialBlock(s, { shapeId: 'O4', isGold: true, laneFrac: 0.66, rowsAbove: 3 })
      }
      break
    }
    case 'overdrive': {
      // A dense cluster so spending the surge feels powerful.
      if (!t.spawnedThisBeat) {
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.24, rowsAbove: 1 })
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.5, rowsAbove: 2 })
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.76, rowsAbove: 1 })
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.38, rowsAbove: 4 })
        spawnTutorialBlock(s, { shapeId: 'O4', laneFrac: 0.64, rowsAbove: 5 })
        t.spawnedThisBeat = true
      }
      if (s.overdriveSec > 0) advance('handoff')
      break
    }
    case 'handoff': {
      // Sell the one fail rule, briefly, then hand off to the live run.
      if (t.beatT > 1.8) finishWarmup(s)
      break
    }
  }
}

// ---- just-in-time coachmark detection --------------------------------------

const teachKindForBlock = (b: BlockEntity): TeachKind | null => {
  if (b.isGold) return 'gold'
  // Note: `chrome` is intentionally not taught (it isn't surfaced as a distinct
  // piece in the product), so it never triggers a coachmark.
  if (b.kind === 'fast' || b.kind === 'armored' || b.kind === 'shatter') {
    return b.kind
  }
  return null
}

// A never-seen piece only triggers its coachmark once it is comfortably on
// screen: its TOP edge, projected to the screen, must sit at least this many CSS
// px below the top edge. Using the real projection (not raw world Y) accounts
// for the perspective compression near the top, and the generous margin makes
// sure the whole piece is clearly visible (not still poking in from the top).
const JIT_TOP_MARGIN_PX = 130

// Each live tick (outside the warmup), look for any never-seen piece kind that is
// fully on screen. The first one found pauses the game and arms the OK card; App
// renders it and dismisses on OK.
export const scanJitTrigger = (s: RunState) => {
  if (s.jit || s.paused || s.gameOver) return
  if (s.tutorial && s.tutorial.phase === 'warmup') return

  const seen = loadSeen()
  const layout = getArenaLayout(s.view)
  const proj = makeProjection(s.view, layout)

  // Project the top-center of the piece; require it well below the screen top.
  const fullyOnScreen = (cx: number, topY: number): boolean =>
    proj.project(cx, topY).y >= JIT_TOP_MARGIN_PX

  for (const b of s.blocks) {
    const kind = teachKindForBlock(b)
    if (!kind || seen.has(kind)) continue
    const cx = b.pos.x + (b.localAabb.minX + b.localAabb.maxX) * 0.5
    const top = b.pos.y + b.localAabb.minY
    if (fullyOnScreen(cx, top)) {
      s.jit = { kind, entityId: b.id, isFeature: false }
      s.paused = true
      return
    }
  }

  for (const f of s.features) {
    const kind: TeachKind | null = f.kind === 'mirror' ? 'mirror' : f.kind === 'prism' ? 'splitter' : null
    if (!kind || seen.has(kind)) continue
    const cx = f.pos.x + (f.localAabb.minX + f.localAabb.maxX) * 0.5
    const top = f.pos.y + f.localAabb.minY
    if (fullyOnScreen(cx, top)) {
      s.jit = { kind, entityId: f.id, isFeature: true }
      s.paused = true
      return
    }
  }
}

// Dismiss the active JIT coachmark (the OK button): remember the kind so it never
// fires again, then resume play.
export const dismissJit = (s: RunState) => {
  if (!s.jit) return
  markKindSeen(s.jit.kind)
  s.jit = null
  s.paused = false
}
