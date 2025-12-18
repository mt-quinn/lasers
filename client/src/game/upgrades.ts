import type { RunState } from './runState'

export type UpgradeId =
  | 'dps'
  | 'beamWidth'
  | 'ricochetUnlock'
  | 'maxBounces'
  | 'bounceEfficiency'

export type UpgradeDef = {
  id: UpgradeId
  name: string
  cost: (level: number) => number
  desc: (level: number) => string
  apply: (s: RunState, newLevel: number) => void
}

const upgrades: UpgradeDef[] = [
  {
    id: 'dps',
    name: 'DPS',
    cost: (level) => Math.round(24 * Math.pow(1.32, level)),
    desc: (level) => {
      const base = 90
      const mult = 1.16
      const cur = Math.round(base * Math.pow(mult, level))
      const next = Math.round(base * Math.pow(mult, level + 1))
      return `DPS ${cur} → ${next} (+${next - cur})`
    },
    apply: (s, newLevel) => {
      const base = 90
      const mult = 1.16
      s.stats.dps = Math.round(base * Math.pow(mult, newLevel))
    },
  },
  {
    id: 'beamWidth',
    name: 'Beam Width',
    cost: (level) => Math.round(35 * Math.pow(1.25, level)),
    desc: (level) => {
      const base = 4.0
      const step = 1.2
      const cur = base + level * step
      const next = base + (level + 1) * step
      return `Width ${cur.toFixed(1)} → ${next.toFixed(1)}`
    },
    apply: (s, newLevel) => {
      const base = 4.0
      const step = 1.2
      s.stats.beamWidth = base + newLevel * step
    },
  },
  {
    id: 'ricochetUnlock',
    name: 'Ricochet Module',
    cost: () => 160,
    desc: (level) => (level >= 1 ? 'Unlocked' : 'Unlock 1 bounce'),
    apply: (s, newLevel) => {
      if (newLevel >= 1) {
        s.stats.maxBounces = Math.max(s.stats.maxBounces, 1)
      }
    },
  },
  {
    id: 'maxBounces',
    name: 'More Bounces',
    cost: (level) => Math.round(180 * Math.pow(1.35, level)),
    desc: (level) => `+1 bounce (to ${Math.min(8, 1 + (level + 1))})`,
    apply: (s, newLevel) => {
      // Cap for v1.
      s.stats.maxBounces = Math.min(8, Math.max(s.stats.maxBounces, 1 + newLevel))
    },
  },
  {
    id: 'bounceEfficiency',
    name: 'Bounce Efficiency',
    cost: (level) => Math.round(150 * Math.pow(1.32, level)),
    desc: (level) => `Less falloff (x${(0.82 + 0.03 * (level + 1)).toFixed(2)} per bounce)`,
    apply: (s, newLevel) => {
      s.stats.bounceFalloff = Math.min(0.97, 0.82 + 0.03 * newLevel)
    },
  },
]

const upgradeById = new Map<UpgradeId, UpgradeDef>(upgrades.map((u) => [u.id, u]))

export const listUpgradesInOrder = (): UpgradeId[] => upgrades.map((u) => u.id)

export const getUpgradeDef = (id: UpgradeId): UpgradeDef => {
  const def = upgradeById.get(id)
  if (!def) throw new Error(`Unknown upgrade: ${id}`)
  return def
}


