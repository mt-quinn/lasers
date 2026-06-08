import type { RunState } from './runState'
import { createInitialRunState } from './runState'
import { getTodayDateKey } from './rng'

// v2: routing-skill rework (fixed power, piercing beam, flat HP). Old v1 saves
// use the obsolete HP/DPS model, so they are intentionally not loaded.
const GAME_STATE_KEY = 'laser_game_state_v2'

// Fields to exclude from serialization (view-dependent, input state, and transient FX)
type SavedRunState = Omit<
  RunState,
  | 'view'
  | 'input'
  | 'reticle'
  | 'laser'
  | 'music'
  | 'xpOrbs'
  | 'meltFx'
  | 'sparks'
  | 'weldGlows'
  | 'sparkEmitAcc'
  | 'weld'
  | 'heatMotes'
  | 'nextMoteId'
  | 'lifeLossFx'
  | 'levelUpNotificationFx'
  // Transient control + combo state (recomputed live each run).
  | 'well'
  | 'combo'
  | 'comboBest'
  | 'comboTimerSec'
  | 'crescendo'
  | 'heat'
  | 'heatNext'
  | 'overdriveSec'
  | 'overdriveArmed'
  | 'gaugeFx'
  | 'nextGaugeFxId'
  | 'sinceStepSec'
  | 'lastBeatToken'
>

const isValidSavedState = (x: unknown): x is SavedRunState => {
  if (!x || typeof x !== 'object') return false
  
  // Cast to any to check properties
  const obj = x as Record<string, unknown>
  
  // Check essential fields exist and have correct types
  const isValid = (
    typeof obj.paused === 'boolean' &&
    Number.isFinite(obj.timeSec) &&
    Number.isFinite(obj.blocksDestroyed) &&
    Number.isFinite(obj.depth) &&
    Number.isFinite(obj.blocksSpawned) &&
    Number.isFinite(obj.bestDepthLocal) &&
    typeof obj.gameOver === 'boolean' &&
    typeof obj.tutorialMovedEmitter === 'boolean' &&
    Number.isFinite(obj.lives) &&
    Number.isFinite(obj.respiteSec) &&
    Number.isFinite(obj.dropIntervalSec) &&
    Number.isFinite(obj.dropTimerSec) &&
    Number.isFinite(obj.dropAnimOffset) &&
    Number.isFinite(obj.dropAnimDuration) &&
    typeof obj.stats === 'object' &&
    obj.stats !== null &&
    typeof obj.emitter === 'object' &&
    obj.emitter !== null &&
    Number.isFinite(obj.xp) &&
    Number.isFinite(obj.xpCap) &&
    Number.isFinite(obj.level) &&
    Number.isFinite(obj.pendingLevelUps) &&
    typeof obj.levelUpActive === 'boolean' &&
    Array.isArray(obj.levelUpOptions) &&
    Array.isArray(obj.blocks) &&
    Number.isFinite(obj.nextBlockId) &&
    Array.isArray(obj.features) &&
    Number.isFinite(obj.nextFeatureId) &&
    Number.isFinite(obj.normalBlocksSinceFeature) &&
    Number.isFinite(obj.spawnTimer) &&
    Number.isFinite(obj.nextOrbId) &&
    Number.isFinite(obj.nextMeltId)
  )
  
  return isValid
}

export const saveGameState = (state: RunState) => {
  try {
    // Don't save if game is over - let the player start fresh
    if (state.gameOver) {
      localStorage.removeItem(GAME_STATE_KEY)
      return
    }

    // Extract only the fields we want to persist
    const toSave: SavedRunState = {
      paused: state.paused,
      timeSec: state.timeSec,
      blocksDestroyed: state.blocksDestroyed,
      depth: state.depth,
      blocksSpawned: state.blocksSpawned,
      bestDepthLocal: state.bestDepthLocal,
      gameOver: state.gameOver,
      tutorialMovedEmitter: state.tutorialMovedEmitter,
      lives: state.lives,
      failGraceDepth: state.failGraceDepth,
      respiteSec: state.respiteSec,
      dropIntervalSec: state.dropIntervalSec,
      dropTimerSec: state.dropTimerSec,
      dropAnimOffset: state.dropAnimOffset,
      dropAnimDuration: state.dropAnimDuration,
      stats: state.stats,
      emitter: state.emitter,
      xp: state.xp,
      xpCap: state.xpCap,
      level: state.level,
      pendingLevelUps: state.pendingLevelUps,
      levelUpActive: state.levelUpActive,
      levelUpOptions: state.levelUpOptions,
      blocks: state.blocks,
      nextBlockId: state.nextBlockId,
      features: state.features,
      nextFeatureId: state.nextFeatureId,
      normalBlocksSinceFeature: state.normalBlocksSinceFeature,
      spawnTimer: state.spawnTimer,
      nextOrbId: state.nextOrbId,
      nextMeltId: state.nextMeltId,
      // Score persists with the run so a refresh keeps depth and score in sync.
      score: state.score,
      bestScoreLocal: state.bestScoreLocal,
      // Daily seed state so a refresh resumes the same board mid-run.
      dailySeed: state.dailySeed,
      dateKey: state.dateKey,
      boardSpawnIndex: state.boardSpawnIndex,
    }

    localStorage.setItem(GAME_STATE_KEY, JSON.stringify(toSave))
  } catch {
    // Silently fail if localStorage is unavailable
  }
}

export const loadGameState = (): RunState | null => {
  try {
    const raw = localStorage.getItem(GAME_STATE_KEY)
    if (!raw) return null

    const parsed = JSON.parse(raw)
    if (!isValidSavedState(parsed)) {
      // Invalid state, clear it
      localStorage.removeItem(GAME_STATE_KEY)
      return null
    }

    // Create a fresh state and merge in the saved data
    const freshState = createInitialRunState()
    
    // Merge saved state into fresh state
    Object.assign(freshState, parsed)
    
    // MIGRATION: the descent interval is now driven by the deterministic
    // difficulty schedule every frame; this is just a sane pre-first-tick value.
    freshState.dropIntervalSec = 1.1
    // MIGRATION: beam power is a fixed design constant now (the upgrade system is
    // gone), so don't let an old save pin outdated values. DPS and pierce count
    // were retuned down so a single beam can no longer vaporize a whole stacked
    // column on arrival (which made stacking/quantity meaningless).
    freshState.stats.maxBounces = 10
    freshState.stats.dps = 20
    freshState.stats.maxPierces = 1
    if (!Number.isFinite(freshState.stats.pierceFalloff)) freshState.stats.pierceFalloff = 0.8
    // MIGRATION: the fail-line grace marker may be missing on older saves.
    if (!Number.isFinite(freshState.failGraceDepth)) freshState.failGraceDepth = -1
    // MIGRATION: ensure routing-kind fields exist on any merged blocks. (The old
    // per-block `vulnNormal` is gone — armored is now a fixed armored-underside,
    // so any leftover field on a saved block is simply ignored.)
    for (const b of freshState.blocks) {
      if (b.kind == null) b.kind = 'normal'
      if (!Number.isFinite(b.dropAnimExtra)) b.dropAnimExtra = 0
      if (!Number.isFinite(b.shieldFlashSec)) b.shieldFlashSec = 0
    }
    // Also ensure dropTimerSec doesn't exceed the interval
    if (freshState.dropTimerSec > freshState.dropIntervalSec) {
      freshState.dropTimerSec = freshState.dropIntervalSec
    }
    
    // If the player was in a level-up screen, keep it paused and preserve the options
    // Otherwise, resume gameplay
    if (!freshState.levelUpActive) {
      freshState.paused = false
    }

    // Daily-only: a saved run from a previous day is stale (different board).
    // Drop it so the player starts fresh on today's seeded board.
    if (freshState.dateKey !== getTodayDateKey()) {
      localStorage.removeItem(GAME_STATE_KEY)
      return null
    }

    return freshState
  } catch {
    // If anything goes wrong, clear the corrupted state and return null
    try {
      localStorage.removeItem(GAME_STATE_KEY)
    } catch {
      // Ignore
    }
    return null
  }
}

export const clearGameState = () => {
  try {
    localStorage.removeItem(GAME_STATE_KEY)
  } catch {
    // Silently fail
  }
}
