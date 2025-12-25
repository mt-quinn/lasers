import type { RunState } from './runState'
import { createInitialRunState } from './runState'

const GAME_STATE_KEY = 'laser_game_state_v1'

// Fields to exclude from serialization (view-dependent, input state, and transient FX)
type SavedRunState = Omit<
  RunState,
  | 'view'
  | 'input'
  | 'reticle'
  | 'laser'
  | 'xpOrbs'
  | 'meltFx'
  | 'sparks'
  | 'weldGlows'
  | 'sparkEmitAcc'
  | 'weld'
  | 'lifeLossFx'
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
    
    // If the player was in a level-up screen, keep it paused and preserve the options
    // Otherwise, resume gameplay
    if (!freshState.levelUpActive) {
      freshState.paused = false
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
