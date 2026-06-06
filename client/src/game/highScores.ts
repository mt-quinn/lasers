export type HighScoreEntry = {
  name: string
  // Depth is kept for display (how deep the run got); score is the ranking key.
  depth: number
  score: number
  ts: number
}

const SCORES_KEY = 'laser_game_high_scores_v1'
const NAME_KEY = 'laser_game_player_name_v1'

const clampLen = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)

const sanitizeName = (raw: string) => {
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s) return 'PLAYER'
  return clampLen(s, 16)
}

const isEntry = (x: unknown): x is HighScoreEntry => {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.name === 'string' && Number.isFinite(o.depth) && Number.isFinite(o.ts)
}

const normalize = (list: HighScoreEntry[]): HighScoreEntry[] => {
  return [...list]
    .map((e) => ({
      name: sanitizeName(e.name),
      depth: Math.max(0, Math.floor(e.depth)),
      // Older saves predate `score`; default to 0 so they still load.
      score: Math.max(0, Math.floor((e as { score?: number }).score ?? 0)),
      ts: Math.max(0, Math.floor(e.ts)),
    }))
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.ts - b.ts))
    .slice(0, 5)
}

export const loadHighScores = (): HighScoreEntry[] => {
  try {
    const raw = localStorage.getItem(SCORES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const entries = parsed.filter(isEntry) as HighScoreEntry[]
    return normalize(entries)
  } catch {
    return []
  }
}

export const saveHighScores = (scores: HighScoreEntry[]) => {
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(normalize(scores)))
  } catch {
    // ignore
  }
}

export const getBestScore = (scores: HighScoreEntry[]) => (scores.length > 0 ? scores[0]!.score : 0)

export const getBestDepth = (scores: HighScoreEntry[]) =>
  scores.reduce((m, e) => Math.max(m, e.depth), 0)

export const qualifiesTop5 = (scores: HighScoreEntry[], score: number) => {
  const sc = Math.max(0, Math.floor(score))
  if (scores.length < 5) return sc > 0
  return sc >= scores[scores.length - 1]!.score
}

export const addHighScore = (
  scores: HighScoreEntry[],
  entry: { name: string; depth: number; score: number },
): HighScoreEntry[] => {
  const next: HighScoreEntry = {
    name: sanitizeName(entry.name),
    depth: Math.max(0, Math.floor(entry.depth)),
    score: Math.max(0, Math.floor(entry.score)),
    ts: Date.now(),
  }
  return normalize([...scores, next])
}

export const loadLastPlayerName = (): string => {
  try {
    const raw = localStorage.getItem(NAME_KEY)
    return raw ? sanitizeName(raw) : ''
  } catch {
    return ''
  }
}

export const saveLastPlayerName = (name: string) => {
  try {
    localStorage.setItem(NAME_KEY, sanitizeName(name))
  } catch {
    // ignore
  }
}
