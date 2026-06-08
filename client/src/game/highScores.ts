export type HighScoreEntry = {
  name: string
  // Depth is kept for display (how deep the run got); score is the ranking key.
  depth: number
  score: number
  ts: number
  // Calendar day (local YYYY-MM-DD) the run belongs to. The board is keyed and
  // navigable by this. Legacy entries (pre-dateKey) derive it from `ts` on load.
  dateKey: string
}

const SCORES_KEY = 'laser_game_high_scores_v1'
const NAME_KEY = 'laser_game_player_name_v1'

// Local board is now grouped by day. We keep up to MAX_PER_DAY runs for each
// calendar day so the per-date view is meaningful, bounded overall by
// MAX_LOCAL_SCORES so storage can't grow without limit. The game-over UI only
// ever shows the top few of the *selected* day, so neither cap affects layout.
export const MAX_PER_DAY = 30
export const MAX_LOCAL_SCORES = 300

const clampLen = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)

const sanitizeName = (raw: string) => {
  const s = raw.trim().replace(/\s+/g, ' ')
  if (!s) return 'PLAYER'
  return clampLen(s, 16)
}

// Local calendar day (YYYY-MM-DD) for a timestamp — used to backfill dateKey on
// entries saved before the field existed.
const dateKeyFromTs = (ts: number): string => {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const isEntry = (x: unknown): x is HighScoreEntry => {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return typeof o.name === 'string' && Number.isFinite(o.depth) && Number.isFinite(o.ts)
}

const byScore = (a: HighScoreEntry, b: HighScoreEntry) =>
  b.score !== a.score ? b.score - a.score : a.ts - b.ts

const normalize = (list: HighScoreEntry[]): HighScoreEntry[] => {
  const cleaned = list.map((e) => {
    const ts = Math.max(0, Math.floor(e.ts))
    const rawKey = (e as { dateKey?: unknown }).dateKey
    return {
      name: sanitizeName(e.name),
      depth: Math.max(0, Math.floor(e.depth)),
      // Older saves predate `score`; default to 0 so they still load.
      score: Math.max(0, Math.floor((e as { score?: number }).score ?? 0)),
      ts,
      dateKey: typeof rawKey === 'string' && rawKey ? rawKey : dateKeyFromTs(ts),
    }
  })

  // Cap per day so a single heavy day can't crowd out older history.
  const byDay = new Map<string, HighScoreEntry[]>()
  for (const e of cleaned) {
    const arr = byDay.get(e.dateKey)
    if (arr) arr.push(e)
    else byDay.set(e.dateKey, [e])
  }
  const kept: HighScoreEntry[] = []
  for (const arr of byDay.values()) {
    arr.sort(byScore)
    kept.push(...arr.slice(0, MAX_PER_DAY))
  }
  // Newest day first, best score first within a day; bound total storage.
  kept.sort((a, b) => (a.dateKey !== b.dateKey ? (a.dateKey < b.dateKey ? 1 : -1) : byScore(a, b)))
  return kept.slice(0, MAX_LOCAL_SCORES)
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

// All-time device best (max over every stored day). Kept all-time on purpose so
// the in-game "BEST" HUD label reflects the player's lifetime peak.
export const getBestScore = (scores: HighScoreEntry[]) =>
  scores.reduce((m, e) => Math.max(m, e.score), 0)

export const getBestDepth = (scores: HighScoreEntry[]) =>
  scores.reduce((m, e) => Math.max(m, e.depth), 0)

// Best stored score for a single calendar day — the HUD "BEST" target, which is
// the score to beat *today*, not the lifetime peak.
export const getBestScoreForDate = (scores: HighScoreEntry[], dateKey: string) =>
  scores.reduce((m, e) => (e.dateKey === dateKey ? Math.max(m, e.score) : m), 0)

// The local runs for one calendar day, ranked best-first.
export const entriesForDate = (scores: HighScoreEntry[], dateKey: string): HighScoreEntry[] =>
  scores.filter((e) => e.dateKey === dateKey).sort(byScore)

// Unique local days that have runs, newest first.
export const localDates = (scores: HighScoreEntry[]): string[] =>
  Array.from(new Set(scores.map((e) => e.dateKey))).sort((a, b) => (a < b ? 1 : -1))

// Does `score` earn a spot on the local board for `dateKey`? (Per-day board, so
// it qualifies until that day is full, then must beat the day's lowest.)
export const qualifiesForDate = (
  scores: HighScoreEntry[],
  dateKey: string,
  score: number,
): boolean => {
  const sc = Math.max(0, Math.floor(score))
  if (sc <= 0) return false
  const day = entriesForDate(scores, dateKey)
  if (day.length < MAX_PER_DAY) return true
  return sc >= day[day.length - 1]!.score
}

export const addHighScore = (
  scores: HighScoreEntry[],
  entry: { name: string; depth: number; score: number; dateKey?: string },
): HighScoreEntry[] => {
  const next: HighScoreEntry = {
    name: sanitizeName(entry.name),
    depth: Math.max(0, Math.floor(entry.depth)),
    score: Math.max(0, Math.floor(entry.score)),
    ts: Date.now(),
    dateKey: entry.dateKey && entry.dateKey.trim() ? entry.dateKey : dateKeyFromTs(Date.now()),
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
