// =============================================================================
// "Singularity" art direction — single source of truth for color.
//
// One physical logic unifies the whole look: a COLD void, COLD infalling matter,
// and the only WARM thing on screen is ENERGY (your beam, the well, weld heat,
// overdrive). RED is reserved exclusively for imminent danger/death.
//
// Three jobs + one reserved danger color:
//   - VOID      deep blue-black environment that recedes completely
//   - STRUCTURE cool steel-cyan spacetime lattice (grid / walls / floor)
//   - MATTER    cold pale mineral (the pieces at full health)
//   - ENERGY    warm amber→white-gold (beam, well, heat, overdrive, reward)
//   - DANGER    saturated red, reserved for the fail line + critical HP
//
// The DOM mirrors a subset of these as CSS variables in index.css / app.css;
// when you change a value here, update the matching `--lb-*` variable there.
// =============================================================================

export const PALETTE = {
  // Void / environment (canvas background gradient stops).
  voidTop: '#06070F',
  voidMid: '#080A16',
  voidNear: '#0B0E1E',

  // Structure / spacetime — base HUES used when music is off. When music plays
  // these blend toward the live music hue, so the scene commits to the song.
  latticeHue: 200, // grid rails + rungs
  wallHue: 200, // shaft bounce walls
  floorHue: 202, // ground-plane fill
  horizonHue: 205, // birth aperture at the vanishing point (cold matter source)

  // Matter — cold mineral. `matterFull` is the dormant (music-off) piece body.
  matterFull: '#BFE6F2',
  matterRim: 'rgba(200,235,250,0.20)', // player-facing rim light (music off)
  matterGlow: 'rgba(120,200,235,0.16)', // soft body bloom (music off)

  // Energy — warm. The only warm family. Beam / well / emitter / heat.
  energyHue: 38, // amber
  energyGoldHue: 45, // overdrive / armed white-gold

  // Danger — reserved red. Fail line + critical HP wash only.
  dangerHue: 4,

  // Reward — the one warm PIECE (valuable). Distinct from cold matter by
  // temperature; distinct from the beam by being a solid gem with moving sheen.
  valuableBody: '#F5C24A',
  valuableHi: '#FFE29A',
} as const

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

const hslToRgb = (h: number, sPct: number, lPct: number) => {
  const hh = (((h % 360) + 360) % 360) / 360
  const s = clamp01(sPct / 100)
  const l = clamp01(lPct / 100)
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const f = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(f(hh + 1 / 3) * 255),
    g: Math.round(f(hh) * 255),
    b: Math.round(f(hh - 1 / 3) * 255),
  }
}

// Designed saturation/lightness ramp keyed by hue. This is what turns the raw
// music rainbow into a color-GRADED rainbow: yellow-greens are pulled down so
// they stop reading "garish default HSL", while cyans, blues and magentas are
// kept rich. The journey is still the full 360°, just spent where the palette
// wants it. Stops are (hue, saturation%, lightness%); we interpolate between
// the two nearest.
const RAMP: Array<[number, number, number]> = [
  [0, 90, 62], // red
  [30, 92, 61], // orange
  [50, 86, 61], // amber/yellow
  [80, 58, 65], // yellow-green — tamed
  [130, 60, 59], // green — tamed
  [170, 80, 57], // teal
  [200, 92, 60], // cyan (on-brand)
  [240, 90, 64], // blue
  [280, 92, 62], // violet
  [320, 95, 62], // magenta
  [360, 90, 62], // wrap = red
]

const sampleRamp = (hue: number): { s: number; l: number } => {
  const h = (((hue % 360) + 360) % 360)
  for (let i = 0; i < RAMP.length - 1; i++) {
    const [h0, s0, l0] = RAMP[i]!
    const [h1, s1, l1] = RAMP[i + 1]!
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0 || 1)
      return { s: s0 + (s1 - s0) * t, l: l0 + (l1 - l0) * t }
    }
  }
  return { s: 90, l: 62 }
}

// Graded reactive color: the music-on identity color for pieces and other
// rainbow elements. Drop-in replacement for `hslToRgb(hue, 96, 62)`.
export const gradeHue = (hue: number): { r: number; g: number; b: number } => {
  const { s, l } = sampleRamp(hue)
  return hslToRgb(hue, s, l)
}

// Same grade, as a CSS rgb() string.
export const gradeHueCss = (hue: number, alpha = 1): string => {
  const c = gradeHue(hue)
  return alpha >= 1 ? `rgb(${c.r} ${c.g} ${c.b})` : `rgba(${c.r},${c.g},${c.b},${alpha})`
}
