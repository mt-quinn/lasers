export type HighScoreEntry = {
  name: string
  depth: number
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

const isEntry = (x: any): x is HighScoreEntry =>
  x &&
  typeof x === 'object' &&
  typeof x.name === 'string' &&
  Number.isFinite(x.depth) &&
  Number.isFinite(x.ts)

const normalize = (list: HighScoreEntry[]): HighScoreEntry[] => {
  return [...list]
    .map((e) => ({
      name: sanitizeName(e.name),
      depth: Math.max(0, Math.floor(e.depth)),
      ts: Math.max(0, Math.floor(e.ts)),
    }))
    .sort((a, b) => (b.depth !== a.depth ? b.depth - a.depth : a.ts - b.ts))
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

export const getBestDepth = (scores: HighScoreEntry[]) => (scores.length > 0 ? scores[0]!.depth : 0)

export const qualifiesTop5 = (scores: HighScoreEntry[], depth: number) => {
  const d = Math.max(0, Math.floor(depth))
  if (scores.length < 5) return d > 0
  return d >= scores[scores.length - 1]!.depth
}

export const addHighScore = (scores: HighScoreEntry[], entry: { name: string; depth: number }): HighScoreEntry[] => {
  const next: HighScoreEntry = {
    name: sanitizeName(entry.name),
    depth: Math.max(0, Math.floor(entry.depth)),
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


