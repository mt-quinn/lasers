// Deterministic RNG for the daily seeded board.
//
// The whole game is a daily run: the same calendar day hashes to the same seed
// for everyone, so the board everyone plays is identical. Each scheduled
// board-spawn draws an INDEPENDENT stream seeded from (seed, spawnIndex) — so
// the Nth piece of the day is the same kind/shape/feature for every player,
// regardless of how many random draws each spawn's decisions happen to make.
// (A single shared stream would desync the moment any spawn varied its draw
// count; per-index seeding sidesteps that entirely.)

export type Rng = () => number

// Numerical Recipes LCG -> [0, 1).
export const makeSeededRandom = (seed: number): Rng => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

// Hash a YYYY-MM-DD string into an unsigned 32-bit int.
export const hashDateKey = (key: string): number => {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

// Today's LOCAL calendar date as zero-padded YYYY-MM-DD. The daily board rolls
// over at the player's local midnight.
export const getTodayDateKey = (): string => {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// murmur3-style integer finalizer over (a, b) so consecutive spawn indices
// produce well-decorrelated streams (raw seed+index would yield near-identical
// first draws on an LCG).
const mix32 = (a: number, b: number): number => {
  let h = (a ^ Math.imul(b ^ (b >>> 15), 0x85ebca6b)) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  h = (h ^ (h >>> 16)) >>> 0
  return h
}

// An independent RNG for the spawn at `index` of the day's board.
export const spawnRng = (seed: number, index: number): Rng =>
  makeSeededRandom(mix32(seed >>> 0, index >>> 0))
