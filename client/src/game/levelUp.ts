import type { Rarity, RunState, UpgradeOffer, UpgradeType } from './runState'

const rarityOrder: Rarity[] = ['common', 'rare', 'epic', 'legendary']

const rarityWeight: Record<Rarity, number> = {
  common: 80,
  rare: 15,
  epic: 4,
  legendary: 1,
}

const BOUNCE_SACRIFICE_APPEARANCE_RATE = 0.01
const BASE_CHOICES_WITH_BOUNCE_SACRIFICE = 3

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


export const rollUpgradeOptions = (s: RunState, random: () => number): UpgradeOffer[] => {
  // Universal pool: every upgrade offer lives in one weighted bag (weighted by rarity).
  // We roll upgrades from the pool, and after each roll we remove all instances of that
  // upgrade type from the pool to ensure each upgrade type appears at most once.

  const offerPool: Array<{ type: UpgradeType; rarity: Rarity; weight: number }> = []
  const push = (type: UpgradeType, rarity: Rarity) => offerPool.push({ type, rarity, weight: rarityWeight[rarity] })

  // Base upgrade types.
  for (const r of rarityOrder) push('damage', r)
  

  
  // Drop slow: only offer if below cap (3.0)
  if (s.dropIntervalSec < 3.0) {
    for (const r of rarityOrder) push('dropSlow', r)
  }

  // Bounces has no common tier (first tier is rare), only offer if below cap (5)
  if (s.stats.maxBounces < 5) {
    for (const r of ['rare', 'epic', 'legendary'] as const) push('bounces', r)
  }

  // Life is a rare-only offer, only while below max lives.
  if (s.lives < 3) push('life', 'rare')

  // Splitter chance: epic and legendary only
  // TODO: Move to new upgrade type
  // push('splitterChance', 'epic')
  // push('splitterChance', 'legendary')

  // No wall penalty: legendary only, one-time offer
  // TODO: Move to new upgrade type (Boundary Pass)
  // if (!s.stats.noWallPenalty) push('noWallPenalty', 'legendary')

  // Extra choice: epic only, one-time offer
  // if (s.stats.extraChoices === 0) push('extraChoice', 'epic')

  // Bounce trade: legendary only, repeatable (only if player has bounces to trade)
  if (s.stats.maxBounces > 0) push('bounceTrade', 'legendary')

  // Count unique upgrade types in the pool for special bounce sacrifice handling
  const uniqueTypes = new Set(offerPool.map(o => o.type))
  const poolHasExactlyThreeTypes = uniqueTypes.size === 3

  const chosen = new Map<UpgradeType, UpgradeOffer>()
  let safety = 0
  const targetChoices = BASE_CHOICES_WITH_BOUNCE_SACRIFICE + s.stats.extraChoices
  while (chosen.size < targetChoices && safety++ < 500) {
    // Stop early if all possible upgrades have been exhausted.
    // This can happen if the player has maxed out most upgrade paths.
    if (offerPool.length === 0) break
    
    const pickOfferSeed = () => pickWeighted(offerPool.map((o) => ({ item: o, weight: o.weight })), random())
    const seed = pickOfferSeed()
    const next = buildOffer(seed.type, seed.rarity, s)
    
    // Add the upgrade and remove all instances of this type from the pool
    // so it can't be rolled again at a different rarity.
    chosen.set(next.type, next)
    
    // Remove all offers of this type from the pool (more efficient than filter + spread)
    for (let i = offerPool.length - 1; i >= 0; i--) {
      if (offerPool[i]!.type === next.type) {
        offerPool.splice(i, 1)
      }
    }
  }

  // Special handling for Bounce Sacrifice when pool is limited:
  // When the pool has exactly 3 upgrade types and bounceTrade was chosen,
  // apply a 1% chance for it to actually appear. If it fails the check,
  // remove it so only 2 upgrades are shown (befitting its legendary rarity).
  if (poolHasExactlyThreeTypes && chosen.has('bounceTrade')) {
    if (random() >= BOUNCE_SACRIFICE_APPEARANCE_RATE) {
      chosen.delete('bounceTrade')
    }
  }

  return Array.from(chosen.values())
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
    // Downgrade to least rare version that still meets the cap (5)
    // Note: This upgrade is only offered when current < cap, so needed is always > 0
    const cap = 5
    const current = s.stats.maxBounces
    const needed = cap - current
    
    // Determine the appropriate rarity based on what's needed
    // rare: +1, epic: +2, legendary: +3
    let effectiveRarity = rarity
    if (needed <= 1) {
      // If we only need 1, use rare (+1)
      effectiveRarity = 'rare'
    } else if (needed <= 2) {
      // If we need 2, use at most epic (+2)
      if (rarity === 'legendary') effectiveRarity = 'epic'
    }
    // If needed >= 3, keep the original rarity
    
    const add = effectiveRarity === 'rare' ? 1 : effectiveRarity === 'epic' ? 2 : 3
    return {
      type,
      rarity: effectiveRarity,
      title: 'Bounces',
      description: `Increase maximum bounces by ${add}`,
    }
  }

  // TODO: Move to new upgrade type
  // if (type === 'splitterChance') {
  //   const add = rarity === 'epic' ? 0.01 : 0.03
  //   const nextPct = Math.round((s.stats.splitterChance + add) * 100)
  //   return {
  //     type,
  //     rarity,
  //     title: 'Splitter Spawn',
  //     description: `${nextPct}% chance destroyed pieces become splitters`,
  //   }
  // }
  // TODO: Move to new upgrade type
  // if (type === 'noWallPenalty') {
  //   return {
  //     type,
  //     rarity: 'legendary',
  //     title: 'Boundary Pass',
  //     description: 'Wall bounces no longer degrade or count as bounces',
  //   }
  // }
  // if (type === 'extraChoice') {
  //   return {
  //     type,
  //     rarity: 'epic',
  //     title: 'Extra Choice',
  //     description: 'Gain +1 upgrade choice on every level-up',
  //   }
  // }
  if (type === 'bounceTrade') {
    const dpsGain = s.stats.maxBounces * 3
    return {
      type,
      rarity: 'legendary',
      title: 'Bounce Sacrifice',
      description: `Trade all ${s.stats.maxBounces} bounces for +${dpsGain} DPS`,
    }
  }
  // dropSlow
  // Downgrade to least rare version that still meets the cap (3.0)
  // Note: This upgrade is only offered when current < cap, so needed is always > 0
  const cap = 3.0
  const current = s.dropIntervalSec
  const needed = cap - current
  
  // Determine the appropriate rarity based on what's needed
  // common: +0.1, rare: +0.2, epic: +0.3, legendary: +0.5
  let effectiveRarity = rarity
  if (needed <= 0.1) {
    // If we only need 0.1, use common (+0.1)
    effectiveRarity = 'common'
  } else if (needed <= 0.2) {
    // If we need 0.2, use at most rare (+0.2)
    if (rarity === 'epic' || rarity === 'legendary') effectiveRarity = 'rare'
  } else if (needed <= 0.3) {
    // If we need 0.3, use at most epic (+0.3)
    if (rarity === 'legendary') effectiveRarity = 'epic'
  }
  // If needed > 0.3, keep the original rarity
  
  const add = effectiveRarity === 'common' ? 0.1 : effectiveRarity === 'rare' ? 0.2 : effectiveRarity === 'epic' ? 0.3 : 0.5
  const next = Math.min(3.0, s.dropIntervalSec + add)
  return {
    type,
    rarity: effectiveRarity,
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
    s.stats.maxBounces = Math.min(5, s.stats.maxBounces + add)
    return
  }

  // TODO: Move to new upgrade type
  // if (offer.type === 'splitterChance') {
  //   const add = r === 'epic' ? 0.01 : 0.03
  //   s.stats.splitterChance = s.stats.splitterChance + add
  //   return
  // }
  // TODO: Move to new upgrade type
  // if (offer.type === 'noWallPenalty') {
  //   s.stats.noWallPenalty = true
  //   return
  // }
  // if (offer.type === 'extraChoice') {
  //   s.stats.extraChoices += 1
  //   return
  // }
  if (offer.type === 'bounceTrade') {
    const dpsGain = s.stats.maxBounces * 3
    s.stats.dps = Math.round(s.stats.dps + dpsGain)
    s.stats.maxBounces = 0
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
    const afterV = Math.min(5, beforeV + add)
    return { label: 'Bounces', before: `${beforeV}`, after: `${afterV}`, delta: `+${afterV - beforeV}` }
  }

  // TODO: Move to new upgrade type
  // if (offer.type === 'splitterChance') {
  //   const add = r === 'epic' ? 0.01 : 0.03
  //   const beforePct = Math.round(s.stats.splitterChance * 100)
  //   const afterPct = Math.round((s.stats.splitterChance + add) * 100)
  //   return {
  //     label: 'Splitter',
  //     before: `${beforePct}%`,
  //     after: `${afterPct}%`,
  //     delta: `+${afterPct - beforePct}%`,
  //   }
  // }
  // TODO: Move to new upgrade type
  // if (offer.type === 'noWallPenalty') {
  //   return {
  //     label: 'Wall',
  //     before: 'Penalty',
  //     after: 'Free',
  //     delta: undefined,
  //   }
  // }
  // if (offer.type === 'extraChoice') {
  //   const beforeV = 3 + s.stats.extraChoices
  //   const afterV = 3 + s.stats.extraChoices + 1
  //   return {
  //     label: 'Choices',
  //     before: `${beforeV}`,
  //     after: `${afterV}`,
  //     delta: '+1',
  //   }
  // }
  if (offer.type === 'bounceTrade') {
    const dpsGain = s.stats.maxBounces * 3
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


