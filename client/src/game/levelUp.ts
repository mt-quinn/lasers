import type { Rarity, RunState, UpgradeOffer, UpgradeType } from './runState'

const rarityOrder: Rarity[] = ['common', 'rare', 'epic', 'legendary']

const rarityWeight: Record<Rarity, number> = {
  common: 80,
  rare: 15,
  epic: 4,
  legendary: 1,
}

const rarityColor: Record<Rarity, string> = {
  common: '#d7d7d7',
  rare: '#6ec6ff',
  epic: '#c7a2ff',
  legendary: '#ffd36a',
}

export const getRarityColor = (r: Rarity) => rarityColor[r]

export const computeXpCap = (level: number) => {
  // XP needed to go from `level` -> `level + 1`.
  //
  // Design:
  // - Level 1 costs 5 XP.
  // - Then +1 XP per level-up through reaching level 15.
  // - Then +2 XP per level-up until a hard cap of 50 XP.
  //
  // Note: `level` is the *current* level; this returns the requirement for the *next* level.
  const l = Math.max(0, Math.floor(level))

  // Levels 0..14 (reaching levels 1..15): 5, 6, 7, ..., 19
  const cap = l <= 14 ? 5 + l : 19 + 2 * (l - 14)
  return Math.min(50, Math.max(5, cap))
}

const fmt = (v: number, maxDecimals = 2) => {
  // Trim trailing zeros: 1.20 -> 1.2, 0.10 -> 0.1, 2.00 -> 2
  const s0 = v.toFixed(maxDecimals).replace(/(?:\.0+|(\.\d+?)0+)$/, '$1')
  // Trim leading zero for fractional values: 0.1 -> .1, -0.25 -> -.25
  if (s0.startsWith('0.')) return s0.slice(1)
  if (s0.startsWith('-0.')) return `-${s0.slice(2)}`
  return s0
}

const pickWeighted = <T,>(items: Array<{ item: T; weight: number }>, r: number): T => {
  const total = items.reduce((s, x) => s + x.weight, 0)
  let t = r * total
  for (const it of items) {
    t -= it.weight
    if (t <= 0) return it.item
  }
  return items[items.length - 1]!.item
}

const rollRarity = (random: () => number, allowed?: Rarity[]): Rarity => {
  const pool = (allowed ?? rarityOrder).map((r) => ({ item: r, weight: rarityWeight[r] }))
  return pickWeighted(pool, random())
}

export const rollUpgradeOptions = (s: RunState, random: () => number): UpgradeOffer[] => {
  // Universal pool: every upgrade offer lives in one weighted bag (weighted by rarity).
  // We dedupe by upgrade type by keeping the rarest roll for that type, then keep rolling
  // until we have 3 distinct types.

  const rarityRank = (r: Rarity) => rarityOrder.indexOf(r) // common=0 .. legendary=3
  const isRarer = (a: Rarity, b: Rarity) => rarityRank(a) > rarityRank(b)

  const offerPool: Array<{ type: UpgradeType; rarity: Rarity; weight: number }> = []
  const push = (type: UpgradeType, rarity: Rarity) => offerPool.push({ type, rarity, weight: rarityWeight[rarity] })

  // Base upgrade types.
  for (const r of rarityOrder) push('damage', r)
  for (const r of rarityOrder) push('bounceFalloff', r)
  for (const r of rarityOrder) push('dropSlow', r)

  // Bounces has no common tier (first tier is rare).
  for (const r of ['rare', 'epic', 'legendary'] as const) push('bounces', r)

  // Life is a rare-only offer, only while below max lives.
  if (s.lives < 3) push('life', 'rare')

  const pickOfferSeed = () => pickWeighted(offerPool.map((o) => ({ item: o, weight: o.weight })), random())

  const chosen = new Map<UpgradeType, UpgradeOffer>()
  let safety = 0
  while (chosen.size < 3 && safety++ < 500) {
    const seed = pickOfferSeed()
    const next = buildOffer(seed.type, seed.rarity, s)
    const cur = chosen.get(next.type)
    if (!cur) {
      chosen.set(next.type, next)
      continue
    }
    if (isRarer(next.rarity, cur.rarity)) chosen.set(next.type, next)
  }

  return Array.from(chosen.values()).slice(0, 3)
}

const buildOffer = (type: UpgradeType, rarity: Rarity, s: RunState): UpgradeOffer => {
  if (type === 'life') {
    const next = Math.min(3, s.lives + 1)
    return {
      type,
      rarity: 'rare',
      title: 'Life',
      description: `Gain +1 life (${next}/3)`,
    }
  }
  if (type === 'damage') {
    const add = rarity === 'common' ? 1 : rarity === 'rare' ? 2 : rarity === 'epic' ? 4 : 6
    const next = Math.round(s.stats.dps + add)
    return {
      type,
      rarity,
      title: 'Beam Damage',
      description: `Increase beam damage to ${next} DPS`,
    }
  }
  if (type === 'bounces') {
    const add = rarity === 'rare' ? 1 : rarity === 'epic' ? 2 : 3
    return {
      type,
      rarity,
      title: 'Bounces',
      description: `Increase maximum bounces by ${add}`,
    }
  }
  if (type === 'bounceFalloff') {
    const delta = rarity === 'common' ? 0.02 : rarity === 'rare' ? 0.04 : rarity === 'epic' ? 0.06 : 0.1
    const next = s.stats.bounceFalloff + delta
    return {
      type,
      rarity,
      title: 'Bounce Degradation',
      description: `Increase bounce multiplier to ${fmt(next, 2)} per bounce`,
    }
  }
  // dropSlow
  const add = rarity === 'common' ? 0.1 : rarity === 'rare' ? 0.2 : rarity === 'epic' ? 0.3 : 0.5
  const next = Math.min(3.0, s.dropIntervalSec + add)
  return {
    type,
    rarity,
    title: 'Piece Drop Speed',
    description: `Slow drop interval to ${fmt(next, 2)} seconds`,
  }
}

export const applyOffer = (s: RunState, offer: UpgradeOffer) => {
  const r = offer.rarity
  if (offer.type === 'life') {
    s.lives = Math.min(3, s.lives + 1)
    return
  }
  if (offer.type === 'damage') {
    const add = r === 'common' ? 1 : r === 'rare' ? 2 : r === 'epic' ? 4 : 6
    s.stats.dps = Math.round(s.stats.dps + add)
    return
  }
  if (offer.type === 'bounces') {
    const add = r === 'rare' ? 1 : r === 'epic' ? 2 : 3
    s.stats.maxBounces = Math.min(12, s.stats.maxBounces + add)
    return
  }
  if (offer.type === 'bounceFalloff') {
    const delta = r === 'common' ? 0.02 : r === 'rare' ? 0.04 : r === 'epic' ? 0.06 : 0.1
    s.stats.bounceFalloff = s.stats.bounceFalloff + delta
    return
  }
  // dropSlow
  const add = r === 'common' ? 0.1 : r === 'rare' ? 0.2 : r === 'epic' ? 0.3 : 0.5
  s.dropIntervalSec = Math.min(3.0, s.dropIntervalSec + add)
  // Keep timer in range so cadence doesn't "jump" badly.
  s.dropTimerSec = Math.min(s.dropTimerSec, s.dropIntervalSec)
}

export type OfferPreview = {
  label: string
  before: string
  after: string
  delta?: string
}

export const getOfferPreview = (s: RunState, offer: UpgradeOffer): OfferPreview => {
  const r = offer.rarity
  if (offer.type === 'life') {
    const before = `${s.lives}/3`
    const after = `${Math.min(3, s.lives + 1)}/3`
    return { label: 'Lives', before, after, delta: '+1' }
  }
  if (offer.type === 'damage') {
    const add = r === 'common' ? 1 : r === 'rare' ? 2 : r === 'epic' ? 4 : 6
    const beforeV = Math.round(s.stats.dps)
    const afterV = Math.round(s.stats.dps + add)
    return { label: 'DPS', before: `${beforeV}`, after: `${afterV}`, delta: `+${afterV - beforeV}` }
  }
  if (offer.type === 'bounces') {
    const add = r === 'rare' ? 1 : r === 'epic' ? 2 : 3
    const beforeV = s.stats.maxBounces
    const afterV = Math.min(12, beforeV + add)
    return { label: 'Bounces', before: `${beforeV}`, after: `${afterV}`, delta: `+${afterV - beforeV}` }
  }
  if (offer.type === 'bounceFalloff') {
    const delta = r === 'common' ? 0.02 : r === 'rare' ? 0.04 : r === 'epic' ? 0.06 : 0.1
    const beforeV = s.stats.bounceFalloff
    const afterV = beforeV + delta
    return {
      label: 'Mult',
      before: fmt(beforeV, 2),
      after: fmt(afterV, 2),
      delta: `+${fmt(afterV - beforeV, 2)}`,
    }
  }
  // dropSlow
  const add = r === 'common' ? 0.1 : r === 'rare' ? 0.2 : r === 'epic' ? 0.3 : 0.5
  const beforeV = s.dropIntervalSec
  const afterV = Math.min(3.0, s.dropIntervalSec + add)
  return {
    label: 'Drop',
    before: `${fmt(beforeV, 2)}s`,
    after: `${fmt(afterV, 2)}s`,
    delta: `+${fmt(afterV - beforeV, 2)}s`,
  }
}


