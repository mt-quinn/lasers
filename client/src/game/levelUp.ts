import type { Rarity, RunState, UpgradeOffer, UpgradeType } from './runState'

const rarityOrder: Rarity[] = ['common', 'rare', 'epic', 'legendary']

const rarityWeight: Record<Rarity, number> = {
  common: 70,
  rare: 22,
  epic: 7,
  legendary: 1,
}

const rarityColor: Record<Rarity, string> = {
  common: '#d7d7d7',
  rare: '#6ec6ff',
  epic: '#c7a2ff',
  legendary: '#ffd36a',
}

export const getRarityColor = (r: Rarity) => rarityColor[r]

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
  const types: UpgradeType[] = ['damage', 'bounces', 'bounceFalloff', 'dropSlow']
  const picked: UpgradeOffer[] = []
  const usedTypes = new Set<UpgradeType>()

  // Ensure 3 distinct upgrade types for clarity.
  while (picked.length < 3) {
    const type = types[Math.floor(random() * types.length)]!
    if (usedTypes.has(type)) continue
    usedTypes.add(type)

    // Bounces cannot be common.
    const rarity =
      type === 'bounces'
        ? rollRarity(random, ['rare', 'epic', 'legendary'])
        : rollRarity(random)

    picked.push(buildOffer(type, rarity, s))
  }

  return picked
}

const buildOffer = (type: UpgradeType, rarity: Rarity, s: RunState): UpgradeOffer => {
  if (type === 'damage') {
    const mult = rarity === 'common' ? 1.10 : rarity === 'rare' ? 1.18 : rarity === 'epic' ? 1.30 : 1.45
    const next = Math.round(s.stats.dps * mult)
    return {
      type,
      rarity,
      title: 'Beam Damage',
      description: `Increase beam damage to ${next} DPS`,
    }
  }
  if (type === 'bounces') {
    const add = rarity === 'rare' ? 1 : rarity === 'epic' ? 1 : 2
    return {
      type,
      rarity,
      title: 'Bounces',
      description: `Increase maximum bounces by ${add}`,
    }
  }
  if (type === 'bounceFalloff') {
    const delta = rarity === 'common' ? 0.03 : rarity === 'rare' ? 0.05 : rarity === 'epic' ? 0.08 : 0.12
    const next = Math.min(0.985, s.stats.bounceFalloff + delta)
    return {
      type,
      rarity,
      title: 'Bounce Degradation',
      description: `Reduce bounce degradation to ${next.toFixed(2)} per bounce`,
    }
  }
  // dropSlow
  const mult = rarity === 'common' ? 1.10 : rarity === 'rare' ? 1.18 : rarity === 'epic' ? 1.28 : 1.40
  const next = Math.min(3.0, s.dropIntervalSec * mult)
  return {
    type,
    rarity,
    title: 'Piece Drop Speed',
    description: `Slow drop interval to ${next.toFixed(2)} seconds`,
  }
}

export const applyOffer = (s: RunState, offer: UpgradeOffer) => {
  const r = offer.rarity
  if (offer.type === 'damage') {
    const mult = r === 'common' ? 1.10 : r === 'rare' ? 1.18 : r === 'epic' ? 1.30 : 1.45
    s.stats.dps = Math.round(s.stats.dps * mult)
    return
  }
  if (offer.type === 'bounces') {
    const add = r === 'rare' ? 1 : r === 'epic' ? 1 : 2
    s.stats.maxBounces = Math.min(12, s.stats.maxBounces + add)
    return
  }
  if (offer.type === 'bounceFalloff') {
    const delta = r === 'common' ? 0.03 : r === 'rare' ? 0.05 : r === 'epic' ? 0.08 : 0.12
    s.stats.bounceFalloff = Math.min(0.985, s.stats.bounceFalloff + delta)
    return
  }
  // dropSlow
  const mult = r === 'common' ? 1.10 : r === 'rare' ? 1.18 : r === 'epic' ? 1.28 : 1.40
  s.dropIntervalSec = Math.min(3.0, s.dropIntervalSec * mult)
  // Keep timer in range so cadence doesn't "jump" badly.
  s.dropTimerSec = Math.min(s.dropTimerSec, s.dropIntervalSec)
}


