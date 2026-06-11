// Trench board mesh (pure geometry — no DOM, no GL).
//
// Builds the "machined trench" board as real 3D geometry in world space
// (x across the shaft, y down the shaft, z height above the deck in px):
// a recessed center channel the beam fires along, flanking plated aprons
// with raised greeble blocks, stepped lips, outer parapet walls, and ring
// braces that bridge the trench every 4th row. Emissive strips carry the
// music (left lip = bass, channel current = mids, right lip = treble; brace
// edges breathe with the bass/beat).
//
// The same vertex layout is consumed by two renderers:
//   - boardGL.ts (WebGL, in-game) — reproduces the piece pipeline's
//     homography + z term in its vertex shader.
//   - the offline preview rasterizer (dev harness) — software-shades the
//     identical triangles so the board can be art-directed headlessly.
//
// Vertex layout (13 floats): wx, wy, z, nx, ny, nz, cr, cg, cb, er, eg, eb, mat
// mat 0 = standard lit steel; mat 1 = MIRROR (the parapet walls): the fragment
// stage swaps to a procedural chrome — scrolling specular streak bands keyed to
// world y/z — so the surfaces the beam bounces off read as machined mirror.
// Colors are pre-faded by distance on the CPU; the fragment stage applies
// lighting:  col = base * (0.40 + 0.66 * max(0, dot(N, L))) * ao(z) + emissive
// with ao(z) = clamp(1 + z * 0.022, 0.55, 1) so the recessed channel and lip
// faces self-shadow.

export const FLOATS_PER_BOARD_VERT = 13

// Shared light direction (matches piecesGL's key light).
export const BOARD_LIGHT: [number, number, number] = (() => {
  const x = -0.22
  const y = 0.42
  const z = 0.88
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
})()

// Trench cross-section, as fractions of the view width.
export const TRENCH_CH_L = 0.34
export const TRENCH_CH_R = 0.66
export const TRENCH_CH_DEPTH = 12 // channel recess below deck (px)
export const TRENCH_WALL_Z = 44 // parapet height above deck (px)
// Inward chamfer at the wall top: the lip leans into the shaft and catches
// light, so the raised edge reads dimensionally instead of as a flat strip.
const WALL_CHAMFER_IN = 5.5
const WALL_CHAMFER_UP = 5
const BRACE_H = 12
const BRACE_D = 12
const RING_EVERY = 4

export type TrenchMeshOpts = {
  W: number
  nearWorldY: number
  strength: number
  pMin: number
  gridRow: number
  totalRows: number
  // Scroll phase + whole-row scroll count. BOTH must be derived from the same
  // continuous scroll distance S (= depth*gridRow - dropAnimOffset):
  //   depth = floor(S / gridRow), gridShift = S - depth * gridRow.
  // Mixing sources (e.g. raw sim depth) makes the pattern teleport a row at
  // each step and slide back during the ease.
  gridShift: number
  depth: number
  // Visual signals
  structHue: number // matter hue (steel; leans music hue slightly upstream)
  emissiveHue: number // live accent hue for strips/packets
  wallHue: number
  mi: number // music intensity 0..1 (0 = idle baseline)
  bands: [number, number, number] // bass, mids, treble (already mi-scaled)
  beat: number // 0..1 beat flash (mi-scaled)
  tNow: number
}

type V3 = { x: number; y: number; z: number }
type RGB = [number, number, number]

const hsl2rgb = (h: number, s: number, l: number): RGB => {
  const hh = (((h % 360) + 360) % 360) / 360
  const ss = Math.min(1, Math.max(0, s / 100))
  const ll = Math.min(1, Math.max(0, l / 100))
  if (ss === 0) return [ll, ll, ll]
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss
  const p = 2 * ll - q
  const f = (t0: number) => {
    let t = t0
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [f(hh + 1 / 3), f(hh), f(hh - 1 / 3)]
}

const hash2 = (a: number, b: number) => {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453
  return x - Math.floor(x)
}

export const buildTrenchMesh = (o: TrenchMeshOpts): Float32Array => {
  const arr: number[] = []
  const pAt = (y: number) => {
    const p = 1 / (1 + o.strength * (o.nearWorldY - y))
    return Math.min(2, Math.max(o.pMin, p))
  }
  // Distance fade baked into vertex colors (the far shaft melts into the fog).
  const fadeAt = (y: number) => Math.min(1, Math.max(0, 0.08 + 1.05 * pAt(y)))

  const push = (pos: V3, n: V3, c: RGB, e: RGB, fade: number, mat: number) => {
    arr.push(
      pos.x,
      pos.y,
      pos.z,
      n.x,
      n.y,
      n.z,
      c[0] * fade,
      c[1] * fade,
      c[2] * fade,
      e[0] * fade,
      e[1] * fade,
      e[2] * fade,
      mat,
    )
  }
  const NOE: RGB = [0, 0, 0]
  // Quad a-b-c-d (a/b far edge, d/c near edge or any consistent winding).
  const quad = (a: V3, b: V3, c: V3, d: V3, n: V3, col: RGB, emi: RGB = NOE, mat = 0) => {
    const fa = fadeAt(a.y)
    const fb = fadeAt(b.y)
    const fc = fadeAt(c.y)
    const fd = fadeAt(d.y)
    push(a, n, col, emi, fa, mat)
    push(b, n, col, emi, fb, mat)
    push(c, n, col, emi, fc, mat)
    push(a, n, col, emi, fa, mat)
    push(c, n, col, emi, fc, mat)
    push(d, n, col, emi, fd, mat)
  }

  const W = o.W
  const chL = TRENCH_CH_L * W
  const chR = TRENCH_CH_R * W
  const CHD = TRENCH_CH_DEPTH
  const WZ = TRENCH_WALL_Z
  const g = o.gridRow

  const NUP: V3 = { x: 0, y: 0, z: 1 }
  const NPLAYER: V3 = { x: 0, y: 1, z: 0 } // faces the player (near plane)
  const NL: V3 = { x: 1, y: 0, z: 0 }
  const NR: V3 = { x: -1, y: 0, z: 0 }

  // Material palette (lightness values are pre-lighting; the floor's diffuse
  // lands near 1.0, walls/lips fall off by orientation + z-AO).
  const steel = (l: number, dh = 0): RGB => hsl2rgb(o.structHue + dh, 30, l)
  const emiAccent = (k: number): RGB => {
    const c = hsl2rgb(o.emissiveHue, 85, 58)
    return [c[0] * k, c[1] * k, c[2] * k]
  }
  const emiWall = (k: number): RGB => {
    const c = hsl2rgb(o.wallHue, 80, 60)
    return [c[0] * k, c[1] * k, c[2] * k]
  }

  const [bass, mids, treble] = o.bands
  const idle = o.mi <= 0 ? 0.3 : 0.14 // strips never go fully dead

  for (let i = 0; i < o.totalRows; i++) {
    const yBot = Math.min(o.nearWorldY, o.nearWorldY - i * g + o.gridShift)
    const yTop = o.nearWorldY - (i + 1) * g + o.gridShift
    if (yTop >= o.nearWorldY) continue
    if (pAt(yBot) <= o.pMin + 0.004) break
    const key = i + o.depth
    const hv = hash2(key, 1)

    // --- Channel floor (recessed) --------------------------------------
    quad(
      { x: chL, y: yTop, z: -CHD },
      { x: chR, y: yTop, z: -CHD },
      { x: chR, y: yBot, z: -CHD },
      { x: chL, y: yBot, z: -CHD },
      NUP,
      steel(9.5 + hv * 1.4, 4),
      emiAccent(0.05 + 0.1 * mids + (o.mi <= 0 ? 0.05 : 0)),
    )

    // --- Apron decking: 1-3 plates per row/side with distinct tints -----
    for (const side of [0, 1] as const) {
      const x0 = side === 0 ? 0 : chR
      const x1 = side === 0 ? chL : W
      const nSeg = 1 + Math.floor(hash2(key, 11 + side * 7) * 3)
      let u0 = 0
      for (let sgi = 0; sgi < nSeg; sgi++) {
        const u1 =
          sgi === nSeg - 1 ? 1 : u0 + (1 - u0) * (0.3 + 0.5 * hash2(key, side * 31 + sgi * 13 + 3))
        const sx0 = x0 + (x1 - x0) * u0
        const sx1 = x0 + (x1 - x0) * u1
        const ph = hash2(key, side * 97 + sgi * 17)
        // Plate gap: a slim dark seam between plates (skip leading edge).
        const gap = sgi > 0 ? 1.6 : 0
        quad(
          { x: sx0 + gap, y: yTop, z: 0 },
          { x: sx1, y: yTop, z: 0 },
          { x: sx1, y: yBot + (yTop < yBot ? -1.6 : 0), z: 0 },
          { x: sx0 + gap, y: yBot + (yTop < yBot ? -1.6 : 0), z: 0 },
          NUP,
          steel(17 + ph * 5, (ph - 0.5) * 8),
        )
        u0 = u1
      }
      // Service LED: occasional tiny emissive stud on the deck.
      if (hash2(key, side * 53 + 5) < 0.2) {
        const ux = x0 + (x1 - x0) * (0.12 + 0.72 * hash2(key, side * 71 + 9))
        const uy = yTop + (yBot - yTop) * (0.3 + 0.4 * hash2(key, side * 41 + 4))
        const warm = hash2(key, side * 23 + 8) < 0.3
        const c = warm ? hsl2rgb(38, 85, 56) : hsl2rgb(o.emissiveHue, 80, 60)
        quad(
          { x: ux - 2.2, y: uy - 2.2, z: 0.4 },
          { x: ux + 2.2, y: uy - 2.2, z: 0.4 },
          { x: ux + 2.2, y: uy + 2.2, z: 0.4 },
          { x: ux - 2.2, y: uy + 2.2, z: 0.4 },
          NUP,
          [0, 0, 0],
          [c[0] * 0.85, c[1] * 0.85, c[2] * 0.85],
        )
      }
      // Greeble: a raised machined block on the deck (~every other row/side).
      if (hash2(key, side * 5 + 2) < 0.45) {
        const gw = 14 + hash2(key, side * 13 + 1) * 24
        const gd = 10 + hash2(key, side * 17 + 6) * 16
        const gh = 4 + hash2(key, side * 19 + 7) * 6
        const gx = x0 + 8 + (x1 - x0 - gw - 16) * hash2(key, side * 29 + 12)
        const gy = yTop + 4 + (g - gd - 8) * hash2(key, side * 37 + 14)
        const cTop = steel(20.5 + hash2(key, side * 43 + 2) * 5)
        const c = steel(15 + hash2(key, side * 43 + 2) * 3)
        // top
        quad(
          { x: gx, y: gy, z: gh },
          { x: gx + gw, y: gy, z: gh },
          { x: gx + gw, y: gy + gd, z: gh },
          { x: gx, y: gy + gd, z: gh },
          NUP,
          cTop,
        )
        // player-facing front
        quad(
          { x: gx, y: gy + gd, z: gh },
          { x: gx + gw, y: gy + gd, z: gh },
          { x: gx + gw, y: gy + gd, z: 0 },
          { x: gx, y: gy + gd, z: 0 },
          NPLAYER,
          c,
        )
        // side faces
        quad(
          { x: gx, y: gy, z: gh },
          { x: gx, y: gy + gd, z: gh },
          { x: gx, y: gy + gd, z: 0 },
          { x: gx, y: gy, z: 0 },
          NR,
          c,
        )
        quad(
          { x: gx + gw, y: gy + gd, z: gh },
          { x: gx + gw, y: gy, z: gh },
          { x: gx + gw, y: gy, z: 0 },
          { x: gx + gw, y: gy + gd, z: 0 },
          NL,
          c,
        )
        // Rare lit vent slit on the front face.
        if (hash2(key, side * 61 + 3) < 0.18) {
          quad(
            { x: gx + 3, y: gy + gd + 0.1, z: gh * 0.55 },
            { x: gx + gw - 3, y: gy + gd + 0.1, z: gh * 0.55 },
            { x: gx + gw - 3, y: gy + gd + 0.1, z: gh * 0.25 },
            { x: gx + 3, y: gy + gd + 0.1, z: gh * 0.25 },
            NPLAYER,
            [0, 0, 0],
            emiAccent(0.4 + 0.3 * bass),
          )
        }
      }
    }

    // --- Lip step faces (the trench cut) --------------------------------
    quad(
      { x: chL, y: yTop, z: 0 },
      { x: chL, y: yBot, z: 0 },
      { x: chL, y: yBot, z: -CHD },
      { x: chL, y: yTop, z: -CHD },
      NL,
      steel(15),
    )
    quad(
      { x: chR, y: yBot, z: 0 },
      { x: chR, y: yTop, z: 0 },
      { x: chR, y: yTop, z: -CHD },
      { x: chR, y: yBot, z: -CHD },
      NR,
      steel(15),
    )
    // Lip trim lights (bass left / treble right) — thin emissive strips on
    // the deck edge, idling faintly when the music is off.
    const lipL = idle * 1.7 + 0.6 * bass
    const lipR = idle * 1.7 + 0.6 * treble
    quad(
      { x: chL - 3.2, y: yTop, z: 0.5 },
      { x: chL + 0.6, y: yTop, z: 0.5 },
      { x: chL + 0.6, y: yBot, z: 0.5 },
      { x: chL - 3.2, y: yBot, z: 0.5 },
      NUP,
      [0, 0, 0],
      emiAccent(lipL),
    )
    quad(
      { x: chR - 0.6, y: yTop, z: 0.5 },
      { x: chR + 3.2, y: yTop, z: 0.5 },
      { x: chR + 3.2, y: yBot, z: 0.5 },
      { x: chR - 0.6, y: yBot, z: 0.5 },
      NUP,
      [0, 0, 0],
      emiAccent(lipR),
    )
    // Accelerator rails: twin glowing tracks the beam rides between — the
    // channel's whole identity. Strong even at idle.
    for (const rx of [W / 2 - 13, W / 2 + 13]) {
      quad(
        { x: rx - 1.4, y: yTop, z: -CHD + 1.2 },
        { x: rx + 1.4, y: yTop, z: -CHD + 1.2 },
        { x: rx + 1.4, y: yBot, z: -CHD + 1.2 },
        { x: rx - 1.4, y: yBot, z: -CHD + 1.2 },
        NUP,
        [0, 0, 0],
        emiAccent(idle * 2.2 + 0.5 * mids),
      )
    }
    // Channel current (mids): a soft emissive spine on the channel floor.
    quad(
      { x: W / 2 - 2, y: yTop, z: -CHD + 0.5 },
      { x: W / 2 + 2, y: yTop, z: -CHD + 0.5 },
      { x: W / 2 + 2, y: yBot, z: -CHD + 0.5 },
      { x: W / 2 - 2, y: yBot, z: -CHD + 0.5 },
      NUP,
      [0, 0, 0],
      emiAccent(idle * 1.6 + 0.5 * mids),
    )

    // --- Outer parapet walls: raised MIRROR surfaces ----------------------
    // The bounce surfaces. Tall chrome faces (mat 1: the shader swaps to a
    // procedural mirror with scrolling streak bands), an inward-leaning
    // chamfer lip that catches the key light, and an emissive cap rail riding
    // the lip's crest.
    const MIRROR = 1
    quad(
      { x: 0, y: yTop, z: WZ },
      { x: 0, y: yBot, z: WZ },
      { x: 0, y: yBot, z: 0 },
      { x: 0, y: yTop, z: 0 },
      NL,
      steel(26, 2),
      NOE,
      MIRROR,
    )
    quad(
      { x: W, y: yBot, z: WZ },
      { x: W, y: yTop, z: WZ },
      { x: W, y: yTop, z: 0 },
      { x: W, y: yBot, z: 0 },
      NR,
      steel(26, 2),
      NOE,
      MIRROR,
    )
    // Chamfer lips: lean into the shaft so the raised edge reads as a bevel.
    quad(
      { x: 0, y: yTop, z: WZ },
      { x: WALL_CHAMFER_IN, y: yTop, z: WZ + WALL_CHAMFER_UP },
      { x: WALL_CHAMFER_IN, y: yBot, z: WZ + WALL_CHAMFER_UP },
      { x: 0, y: yBot, z: WZ },
      { x: 0.66, y: 0, z: 0.75 },
      steel(30, 2),
      NOE,
      MIRROR,
    )
    quad(
      { x: W - WALL_CHAMFER_IN, y: yTop, z: WZ + WALL_CHAMFER_UP },
      { x: W, y: yTop, z: WZ },
      { x: W, y: yBot, z: WZ },
      { x: W - WALL_CHAMFER_IN, y: yBot, z: WZ + WALL_CHAMFER_UP },
      { x: -0.66, y: 0, z: 0.75 },
      steel(30, 2),
      NOE,
      MIRROR,
    )
    // Cap rails (emissive) ride the chamfer crest.
    quad(
      { x: WALL_CHAMFER_IN - 1, y: yTop, z: WZ + WALL_CHAMFER_UP + 0.2 },
      { x: WALL_CHAMFER_IN + 2.4, y: yTop, z: WZ + WALL_CHAMFER_UP + 0.2 },
      { x: WALL_CHAMFER_IN + 2.4, y: yBot, z: WZ + WALL_CHAMFER_UP + 0.2 },
      { x: WALL_CHAMFER_IN - 1, y: yBot, z: WZ + WALL_CHAMFER_UP + 0.2 },
      NUP,
      [0, 0, 0],
      emiWall(0.85),
    )
    quad(
      { x: W - WALL_CHAMFER_IN - 2.4, y: yTop, z: WZ + WALL_CHAMFER_UP + 0.2 },
      { x: W - WALL_CHAMFER_IN + 1, y: yTop, z: WZ + WALL_CHAMFER_UP + 0.2 },
      { x: W - WALL_CHAMFER_IN + 1, y: yBot, z: WZ + WALL_CHAMFER_UP + 0.2 },
      { x: W - WALL_CHAMFER_IN - 2.4, y: yBot, z: WZ + WALL_CHAMFER_UP + 0.2 },
      NUP,
      [0, 0, 0],
      emiWall(0.85),
    )

    // --- Ring brace bridging the trench every 4th row --------------------
    if (((key % RING_EVERY) + RING_EVERY) % RING_EVERY === 0) {
      const y0 = yTop // boundary the brace sits on
      const yF = y0 - BRACE_D
      const cTopB = steel(24)
      const c = steel(17)
      // top
      quad(
        { x: 0, y: yF, z: BRACE_H },
        { x: W, y: yF, z: BRACE_H },
        { x: W, y: y0, z: BRACE_H },
        { x: 0, y: y0, z: BRACE_H },
        NUP,
        cTopB,
      )
      // player-facing front
      quad(
        { x: 0, y: y0, z: BRACE_H },
        { x: W, y: y0, z: BRACE_H },
        { x: W, y: y0, z: 0 },
        { x: 0, y: y0, z: 0 },
        NPLAYER,
        c,
      )
      // glow trim along the front-top edge, breathing with bass/beat
      quad(
        { x: 0, y: y0 + 0.1, z: BRACE_H },
        { x: W, y: y0 + 0.1, z: BRACE_H },
        { x: W, y: y0 + 0.1, z: BRACE_H - 3.6 },
        { x: 0, y: y0 + 0.1, z: BRACE_H - 3.6 },
        NPLAYER,
        [0, 0, 0],
        emiAccent(0.8 + 0.55 * bass + 0.6 * o.beat),
      )
      // hazard ticks: short amber dashes across the brace front
      const amber = hsl2rgb(38, 80, 55)
      for (let tk = 1; tk <= 5; tk++) {
        const tx = (W * tk) / 6
        quad(
          { x: tx - 7, y: y0 + 0.2, z: BRACE_H * 0.42 },
          { x: tx + 7, y: y0 + 0.2, z: BRACE_H * 0.42 },
          { x: tx + 7, y: y0 + 0.2, z: BRACE_H * 0.14 },
          { x: tx - 7, y: y0 + 0.2, z: BRACE_H * 0.14 },
          NPLAYER,
          [0, 0, 0],
          [amber[0] * 0.3, amber[1] * 0.3, amber[2] * 0.3],
        )
      }
      // beacon caps where the brace meets the walls
      for (const bx of [4, W - 4]) {
        quad(
          { x: bx - 4, y: y0 - 3, z: BRACE_H + 6 },
          { x: bx + 4, y: y0 - 3, z: BRACE_H + 6 },
          { x: bx + 4, y: y0 - 11, z: BRACE_H + 6 },
          { x: bx - 4, y: y0 - 11, z: BRACE_H + 6 },
          NUP,
          [0, 0, 0],
          emiWall(1.35 + 0.3 * o.beat),
        )
        // post
        quad(
          { x: bx - 1.4, y: y0 - 6, z: BRACE_H + 6 },
          { x: bx + 1.4, y: y0 - 6, z: BRACE_H + 6 },
          { x: bx + 1.4, y: y0 - 6, z: 0 },
          { x: bx - 1.4, y: y0 - 6, z: 0 },
          NPLAYER,
          steel(16),
        )
      }
    }
  }

  // --- Energy packets streaming down the channel toward the cannon -------
  const depthSpan = o.totalRows * g
  for (let j = 0; j < 4; j++) {
    const u = (o.tNow * 0.11 + j / 4) % 1
    const py = o.nearWorldY - (1 - u) * depthSpan
    if (pAt(py) <= o.pMin + 0.01) continue
    const px = W / 2 + Math.sin(j * 9.2) * 8
    const k = 0.8 + 0.5 * mids + (o.mi <= 0 ? 0.2 : 0)
    quad(
      { x: px - 3, y: py - 6, z: -CHD + 1 },
      { x: px + 3, y: py - 6, z: -CHD + 1 },
      { x: px + 3, y: py + 6, z: -CHD + 1 },
      { x: px - 3, y: py + 6, z: -CHD + 1 },
      NUP,
      [0, 0, 0],
      emiAccent(k),
    )
  }

  return new Float32Array(arr)
}
