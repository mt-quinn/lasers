// Persisted player preferences (device-local). Read by the sim/renderer via
// the cheap getters below; written by the settings panel in App. Kept tiny and
// dependency-free so any module can consult it without ceremony.

const KEY = 'laserburn.prefs.v1'

export type Prefs = {
  // Disables screenshake and other non-essential motion (accessibility).
  reducedMotion: boolean
  // Vibration on kills / overdrive / game over (mobile).
  haptics: boolean
  // SFX bus volume 0..1 (independent of the music volume).
  sfxVolume: number
}

const DEFAULTS: Prefs = { reducedMotion: false, haptics: true, sfxVolume: 1 }

let cache: Prefs | null = null

export const getPrefs = (): Prefs => {
  if (cache) return cache
  let stored: Partial<Prefs> = {}
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>
  } catch {
    stored = {}
  }
  cache = {
    reducedMotion: typeof stored.reducedMotion === 'boolean' ? stored.reducedMotion : DEFAULTS.reducedMotion,
    haptics: typeof stored.haptics === 'boolean' ? stored.haptics : DEFAULTS.haptics,
    sfxVolume:
      typeof stored.sfxVolume === 'number' && Number.isFinite(stored.sfxVolume)
        ? Math.min(1, Math.max(0, stored.sfxVolume))
        : DEFAULTS.sfxVolume,
  }
  return cache
}

export const setPrefs = (patch: Partial<Prefs>): Prefs => {
  cache = { ...getPrefs(), ...patch }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    // Storage unavailable; prefs stay in-memory for the session.
  }
  return cache
}

export const reducedMotion = () => getPrefs().reducedMotion
export const hapticsEnabled = () => getPrefs().haptics

// Gate every navigator.vibrate call through this so the haptics pref is a
// single switch.
export const vibrate = (pattern: number | number[]) => {
  if (!hapticsEnabled()) return
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
      : undefined
  if (nav && typeof nav.vibrate === 'function') nav.vibrate(pattern)
}
