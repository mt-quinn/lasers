// Stable per-browser anonymous identifier for the global leaderboards. The
// global board dedupes on this id (one best-score row per player), so it must
// persist across refreshes. Regenerated only if it ever goes missing (cleared
// storage / private window).
const PLAYER_ID_KEY = 'laserburn.playerId.v1'

const generateId = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `p-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export const getOrCreatePlayerId = (): string => {
  if (typeof window === 'undefined') return generateId()
  try {
    const existing = window.localStorage.getItem(PLAYER_ID_KEY)
    if (existing && existing.length > 0) return existing
    const fresh = generateId()
    window.localStorage.setItem(PLAYER_ID_KEY, fresh)
    return fresh
  } catch {
    return generateId()
  }
}

// True when a real Convex deployment is configured. When false, the client
// runs fully offline and all leaderboard queries are skipped.
export const isConvexConfigured = (): boolean => {
  const raw = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim()
  return !!raw && raw.length > 0
}
