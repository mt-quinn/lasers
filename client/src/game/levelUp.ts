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
  // - Then +1 XP per level-up forever (no cap).
  //
  // Note: `level` is the *current* level; this returns the requirement for the *next* level.
  const l = Math.max(0, Math.floor(level))

  // All levels: 5, 6, 7, ..., increasing by 1 per level
  const cap = 5 + l
  return Math.max(5, cap)
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

  // Splitter chance: epic and legendary only
  push('splitterChance', 'epic')
  push('splitterChance', 'legendary')

  // No wall penalty: legendary only, one-time offer
  if (!s.stats.noWallPenalty) push('noWallPenalty', 'legendary')

  // Extra choice: epic only, one-time offer
  if (s.stats.extraChoices === 0) push('extraChoice', 'epic')

  // Bounce trade: legendary only, repeatable (only if player has bounces to trade)
  if (s.stats.maxBounces > 1) push('bounceTrade', 'legendary')

  const pickOfferSeed = () => pickWeighted(offerPool.map((o) => ({ item: o, weight: o.weight })), random())

  const chosen = new Map<UpgradeType, UpgradeOffer>()
  let safety = 0
  const targetChoices = 3 + s.stats.extraChoices
  while (chosen.size < targetChoices && safety++ < 500) {
    const seed = pickOfferSeed()
    const next = buildOffer(seed.type, seed.rarity, s)
    const cur = chosen.get(next.type)
    if (!cur) {
      chosen.set(next.type, next)
      continue
    }
    if (isRarer(next.rarity, cur.rarity)) chosen.set(next.type, next)
  }

  return Array.from(chosen.values()).slice(0, targetChoices)
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
  if (type === 'splitterChance') {
    const add = rarity === 'epic' ? 0.01 : 0.03
    const nextPct = Math.round((s.stats.splitterChance + add) * 100)
    return {
      type,
      rarity,
      title: 'Splitter Spawn',
      description: `${nextPct}% chance destroyed pieces become splitters`,
    }
  }
  if (type === 'noWallPenalty') {
    return {
      type,
      rarity: 'legendary',
      title: 'Boundary Pass',
      description: 'Wall bounces no longer degrade or count as bounces',
    }
  }
  if (type === 'extraChoice') {
    return {
      type,
      rarity: 'epic',
      title: 'Extra Choice',
      description: 'Gain +1 upgrade choice on every level-up',
    }
  }
  if (type === 'bounceTrade') {
    const dpsGain = s.stats.maxBounces * 10
    return {
      type,
      rarity: 'legendary',
      title: 'Bounce Sacrifice',
      description: `Trade all ${s.stats.maxBounces} bounces for +${dpsGain} DPS`,
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
  if (offer.type === 'splitterChance') {
    const add = r === 'epic' ? 0.01 : 0.03
    s.stats.splitterChance = s.stats.splitterChance + add
    return
  }
  if (offer.type === 'noWallPenalty') {
    s.stats.noWallPenalty = true
    return
  }
  if (offer.type === 'extraChoice') {
    s.stats.extraChoices += 1
    return
  }
  if (offer.type === 'bounceTrade') {
    const dpsGain = s.stats.maxBounces * 10
    s.stats.dps = Math.round(s.stats.dps + dpsGain)
    s.stats.maxBounces = 1
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
  if (offer.type === 'splitterChance') {
    const add = r === 'epic' ? 0.01 : 0.03
    const beforePct = Math.round(s.stats.splitterChance * 100)
    const afterPct = Math.round((s.stats.splitterChance + add) * 100)
    return {
      label: 'Splitter',
      before: `${beforePct}%`,
      after: `${afterPct}%`,
      delta: `+${afterPct - beforePct}%`,
    }
  }
  if (offer.type === 'noWallPenalty') {
    return {
      label: 'Wall',
      before: 'Penalty',
      after: 'Free',
      delta: undefined,
    }
  }
  if (offer.type === 'extraChoice') {
    const beforeV = 3 + s.stats.extraChoices
    const afterV = 3 + s.stats.extraChoices + 1
    return {
      label: 'Choices',
      before: `${beforeV}`,
      after: `${afterV}`,
      delta: '+1',
    }
  }
  if (offer.type === 'bounceTrade') {
    const dpsGain = s.stats.maxBounces * 10
    const beforeDps = Math.round(s.stats.dps)
    const afterDps = Math.round(s.stats.dps + dpsGain)
    return {
      label: 'DPS',
      before: `${beforeDps}`,
      after: `${afterDps}`,
      delta: `+${dpsGain}`,
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


