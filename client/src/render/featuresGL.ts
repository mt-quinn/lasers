// GPU 3D board features (mirrors + splitters).
//
// The blocks render as extruded 3D slabs (piecesGL). Mirrors and splitters used
// to be flat 2D billboards, which read as stickers next to the lit slabs. This
// module gives them the same material language — real thickness, lit/bevelled
// faces, a glossy fresnel rim that feeds bloom — using the SAME Y-separable
// perspective homography as piecesGL so they sit in the field at the right depth.
//
//   Mirror   → a steel wedge (right-triangle prism). The two legs are lit steel
//              walls; the diagonal hypotenuse is a polished chrome panel (baked
//              2D art) set in a rounded steel bezel — clearly an angled reflector.
//   Splitter → a crystalline router: a faceted octagonal hub (glowing baked
//              core) with raised crystal prongs radiating along each exit
//              direction plus a dim intake prong pointing down. The prong
//              silhouette encodes the split directions, and facets/prongs
//              self-glow with `lit` while a beam routes through. Deliberately
//              radial + cyan so it never reads as the steel mirror wedge.
//
// Like piecesGL, this renders into a private WebGL canvas (device px) and returns
// it for the caller to composite with drawImage. Returns null if WebGL is
// unavailable so the caller can fall back to the 2D shapes.

import type { GLProjUniforms } from './piecesGL'

export type GLMirror = {
  kind: 'mirror'
  // Cell-square corners in WORLD px (already offset by the feature's visualPos).
  tl: { x: number; y: number }
  tr: { x: number; y: number }
  br: { x: number; y: number }
  bl: { x: number; y: number }
  orient: 1 | -1
  height: number
  // Steel body color (0..1).
  cr: number
  cg: number
  cb: number
  // Atlas UV rect for the chrome hypotenuse panel.
  u0: number
  v0: number
  u1: number
  v1: number
}

export type GLSplitter = {
  kind: 'splitter'
  cx: number // hub center, world px
  cy: number
  hubR: number // hub crystal radius
  prongLen: number // distance from center to prong tip
  prongW: number // prong half-width at its base
  height: number
  // Crystal body color (0..1).
  cr: number
  cg: number
  cb: number
  // Exit directions, degrees relative to a straight-up beam (0 = up, +90 right).
  exits: number[]
  // 0..1 "beam routing through me" glow (drives facet/prong emissive).
  lit: number
  // Atlas UV rect for the hub top facet (glowing core glyph).
  u0: number
  v0: number
  u1: number
  v1: number
}

export type GLFeature = GLMirror | GLSplitter

let gl: WebGLRenderingContext | null = null
let glCanvas: HTMLCanvasElement | null = null
let program: WebGLProgram | null = null
let tex: WebGLTexture | null = null
let vbo: WebGLBuffer | null = null
let initFailed = false
const u: Record<string, WebGLUniformLocation | null> = {}
let aLoc: Record<string, number> = {}

const FLOATS_PER_VERT = 13 // wx,wy,z, nx,ny,nz, cr,cg,cb, u,v, isTop, emis

const VERT = `
precision highp float;
attribute vec2 aWorld;
attribute float aZ;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec2 aUV;
attribute float aIsTop;
attribute float aEmis;

uniform float uCx;
uniform float uStrength;
uniform float uNearWorldY;
uniform float uHorizonY;
uniform float uSpan;
uniform float uPMin;
uniform float uPMax;
uniform vec2 uView;

varying vec2 vUV;
varying vec3 vColor;
varying float vIsTop;
varying vec3 vN;
varying float vEmis;

void main() {
  float p = 1.0 / (1.0 + uStrength * (uNearWorldY - aWorld.y));
  p = clamp(p, uPMin, uPMax);

  float sx = uCx + (aWorld.x - uCx) * p;
  float sy = uHorizonY + uSpan * p - aZ * p;

  float ndcX = sx / uView.x * 2.0 - 1.0;
  float ndcY = 1.0 - sy / uView.y * 2.0;
  float ndcZ = 0.6 - (p * 0.25 + aZ * 0.0009);

  float w = 1.0 / p;
  gl_Position = vec4(ndcX * w, ndcY * w, ndcZ * w, w);

  vUV = aUV;
  vColor = aColor;
  vIsTop = aIsTop;
  vN = aNormal;
  vEmis = aEmis;
}
`

const FRAG = `
precision highp float;
varying vec2 vUV;
varying vec3 vColor;
varying float vIsTop;
varying vec3 vN;
varying float vEmis;
uniform sampler2D uTex;
uniform vec3 uLightDir;

void main() {
  vec3 N = normalize(vN);
  vec3 L = uLightDir;
  vec3 V = normalize(vec3(0.0, 0.5, 0.95));
  float dif = max(0.0, dot(N, L));
  vec3 Hh = normalize(L + V);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

  if (vIsTop > 0.5) {
    // Baked art face (chrome mirror panel or gem top): keep the painted detail
    // but tie it to the scene light + a tight gloss sheen.
    vec4 t = texture2D(uTex, vUV);
    if (t.a < 0.02) discard;
    float light = 0.88 + 0.24 * dif;
    float spec = pow(max(0.0, dot(N, Hh)), 40.0) * 0.45;
    vec3 col = t.rgb * light + spec;
    col += fres * 0.10;
    gl_FragColor = vec4(col, t.a);
  } else {
    // Lit solid face (steel legs / gem facets): diffuse + glossy streak +
    // fresnel rim, plus optional emissive so crystal facets self-glow.
    float light = 0.5 + 0.72 * dif;
    vec3 col = vColor * light;
    float spec = pow(max(0.0, dot(N, Hh)), 22.0) * 0.5;
    col += spec * (vColor * 0.4 + 0.6);
    col += fres * (vColor * 0.5 + vec3(0.5)) * 1.1;
    col += vColor * vEmis;
    gl_FragColor = vec4(col, 1.0);
  }
}
`

const compile = (g: WebGLRenderingContext, type: number, src: string) => {
  const sh = g.createShader(type)
  if (!sh) return null
  g.shaderSource(sh, src)
  g.compileShader(sh)
  if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) {
    g.deleteShader(sh)
    return null
  }
  return sh
}

const init = (): boolean => {
  if (gl && program) return true
  if (initFailed) return false
  try {
    glCanvas = document.createElement('canvas')
    const g = (glCanvas.getContext('webgl', {
      premultipliedAlpha: true,
      alpha: true,
      antialias: true,
      depth: true,
      stencil: false,
    }) || glCanvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!g) {
      initFailed = true
      return false
    }
    const vs = compile(g, g.VERTEX_SHADER, VERT)
    const fs = compile(g, g.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) {
      initFailed = true
      return false
    }
    const prog = g.createProgram()
    if (!prog) {
      initFailed = true
      return false
    }
    g.attachShader(prog, vs)
    g.attachShader(prog, fs)
    g.linkProgram(prog)
    if (!g.getProgramParameter(prog, g.LINK_STATUS)) {
      initFailed = true
      return false
    }

    vbo = g.createBuffer()
    tex = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, tex)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0)
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)

    g.useProgram(prog)
    for (const name of [
      'uCx',
      'uStrength',
      'uNearWorldY',
      'uHorizonY',
      'uSpan',
      'uPMin',
      'uPMax',
      'uView',
      'uLightDir',
      'uTex',
    ]) {
      u[name] = g.getUniformLocation(prog, name)
    }
    aLoc = {
      aWorld: g.getAttribLocation(prog, 'aWorld'),
      aZ: g.getAttribLocation(prog, 'aZ'),
      aNormal: g.getAttribLocation(prog, 'aNormal'),
      aColor: g.getAttribLocation(prog, 'aColor'),
      aUV: g.getAttribLocation(prog, 'aUV'),
      aIsTop: g.getAttribLocation(prog, 'aIsTop'),
      aEmis: g.getAttribLocation(prog, 'aEmis'),
    }

    gl = g
    program = prog
    return true
  } catch {
    initFailed = true
    return false
  }
}

// Match piecesGL: light from the upper-left, in front of the plane.
const LIGHT: [number, number, number] = (() => {
  const x = -0.35
  const y = -0.5
  const z = 0.79
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
})()

export const renderFeaturesGL = (
  atlas: HTMLCanvasElement,
  features: GLFeature[],
  proj: GLProjUniforms,
  viewW: number,
  viewH: number,
  dpr: number,
): HTMLCanvasElement | null => {
  if (!init() || !gl || !glCanvas || !program) return null
  const g = gl
  const dw = Math.max(1, Math.round(viewW * dpr))
  const dh = Math.max(1, Math.round(viewH * dpr))
  if (glCanvas.width !== dw || glCanvas.height !== dh) {
    glCanvas.width = dw
    glCanvas.height = dh
  }
  g.viewport(0, 0, dw, dh)
  g.useProgram(program)

  g.enable(g.DEPTH_TEST)
  g.depthFunc(g.LEQUAL)
  g.enable(g.BLEND)
  g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA) // premultiplied
  g.clearColor(0, 0, 0, 0)
  g.clearDepth(1.0)
  g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)

  if (features.length === 0) return glCanvas

  const arr: number[] = []
  const push = (
    wx: number,
    wy: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    cr: number,
    cg: number,
    cb: number,
    uu: number,
    vv: number,
    isTop: number,
    emis: number,
  ) => {
    arr.push(wx, wy, z, nx, ny, nz, cr, cg, cb, uu, vv, isTop, emis)
  }

  type V = { x: number; y: number }
  const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y })

  for (const f of features) {
    if (f.kind === 'mirror') {
      // A thin chrome blade standing ALONG the diagonal of the cell — symmetric,
      // double-sided, so it reads as a 45° reflector that bounces a beam either
      // way (not a solid half-cell wedge). The blade's top face is the chrome
      // panel; rounded steel walls trim its edges.
      //   orient 1 ('\'): diagonal TL→BR, direction (1, 1)/√2.
      //   orient -1 ('/'): diagonal BL→TR, direction (1,-1)/√2.
      const H = f.height
      const cx = (f.tl.x + f.br.x) * 0.5
      const cy = (f.tl.y + f.br.y) * 0.5
      const sz = f.br.x - f.tl.x
      const inv = 1 / Math.SQRT2
      const dx = inv
      const dy = f.orient === 1 ? inv : -inv // diagonal unit dir
      const nx0 = -dy
      const ny0 = dx // perpendicular unit
      const Lh = sz * 0.64 // half-length along the diagonal
      const Wh = sz * 0.1 // half-width (thin blade)
      const corner = (sd: number, sn: number): V => ({
        x: cx + dx * Lh * sd + nx0 * Wh * sn,
        y: cy + dy * Lh * sd + ny0 * Wh * sn,
      })
      const loop: V[] = [corner(1, 1), corner(1, -1), corner(-1, -1), corner(-1, 1)]
      const N = loop.length

      const rr = Math.min(H * 0.5, 7)
      const S = 3
      const topChamfer = Math.min(rr * 0.6, 3)
      type Ring = { inset: number; z: number; nz: number }
      const rings: Ring[] = []
      rings.push({ inset: 0, z: H, nz: 0.65 })
      rings.push({ inset: topChamfer, z: H - topChamfer, nz: 0 })
      rings.push({ inset: topChamfer, z: rr, nz: 0 })
      for (let k = 1; k <= S; k++) {
        const t = (k / S) * (Math.PI / 2)
        rings.push({ inset: topChamfer + rr * Math.sin(t), z: rr * Math.cos(t), nz: -Math.sin(t) })
      }

      // Per-corner outward normal (averaged adjacent edges) for the inset rings.
      const nrm: V[] = []
      for (let i = 0; i < N; i++) {
        const prev = loop[(i - 1 + N) % N]
        const cur = loop[i]
        const nxt = loop[(i + 1) % N]
        const e1 = sub(cur, prev)
        const e2 = sub(nxt, cur)
        let nx = e1.y + e2.y
        let ny = -e1.x - e2.x
        const l = Math.hypot(nx, ny) || 1
        nx /= l
        ny /= l
        if ((cur.x - cx) * nx + (cur.y - cy) * ny < 0) {
          nx = -nx
          ny = -ny
        }
        nrm.push({ x: nx, y: ny })
      }

      const ringVert = (r: Ring, i: number) => {
        const lp = loop[i]
        const nn = nrm[i]
        const px = lp.x - nn.x * r.inset
        const py = lp.y - nn.y * r.inset
        const nh = Math.sqrt(Math.max(0, 1 - r.nz * r.nz))
        const shade = 0.62 + 0.38 * (r.z / H)
        return {
          x: px,
          y: py,
          z: r.z,
          nx: nn.x * nh,
          ny: nn.y * nh,
          nz: r.nz,
          cr: f.cr * shade,
          cg: f.cg * shade,
          cb: f.cb * shade,
        }
      }
      const emitS = (vt: ReturnType<typeof ringVert>) =>
        push(vt.x, vt.y, vt.z, vt.nx, vt.ny, vt.nz, vt.cr, vt.cg, vt.cb, 0, 0, 0, 0)

      // Chrome textured top: the rotated blade rectangle (u along the diagonal,
      // v across the blade width).
      const topUV = (p: V) => {
        const rel = sub(p, { x: cx, y: cy })
        const along = (rel.x * dx + rel.y * dy) / Lh // -1..1
        const across = (rel.x * nx0 + rel.y * ny0) / Wh // -1..1
        return {
          u: f.u0 + (along * 0.5 + 0.5) * (f.u1 - f.u0),
          v: f.v0 + (across * 0.5 + 0.5) * (f.v1 - f.v0),
        }
      }
      const topQuad = [loop[0], loop[1], loop[2], loop[3]]
      const uvs = topQuad.map(topUV)
      const emitTop = (i: number) =>
        push(topQuad[i].x, topQuad[i].y, H, 0, 0, 1, 0, 0, 0, uvs[i].u, uvs[i].v, 1, 0)
      emitTop(0)
      emitTop(1)
      emitTop(2)
      emitTop(0)
      emitTop(2)
      emitTop(3)

      // Steel side walls (rounded rim + vertical + rounded foot) on every edge.
      for (let r = 0; r < rings.length - 1; r++) {
        const A = rings[r]
        const B = rings[r + 1]
        for (let i = 0; i < N; i++) {
          const j = (i + 1) % N
          const a0 = ringVert(A, i)
          const a1 = ringVert(A, j)
          const b0 = ringVert(B, i)
          const b1 = ringVert(B, j)
          emitS(a0)
          emitS(a1)
          emitS(b1)
          emitS(a0)
          emitS(b1)
          emitS(b0)
        }
      }
      continue
    }

    // Splitter: a crystalline ROUTER. A central faceted hub with physical prongs
    // radiating along each exit direction (and a stubby intake prong pointing
    // down at the incoming beam). The prong silhouette literally points where the
    // beam comes out, so the split is legible from a distance and never looks like
    // the steel mirror wedge. Prongs/facets self-glow with `lit` while a beam
    // routes through.
    const litEmis = f.lit
    const hubEmis = 0.16 + 0.55 * litEmis
    const SIDES = 8
    const R = f.hubR
    const H = f.height
    const rTop = R * 0.9
    const rG = R
    const rBase = R * 0.64
    const zTop = H
    const zG = H * 0.72
    const zBase = 0
    const a0 = -Math.PI / 2
    const ringPt = (rad: number, i: number) => {
      const ang = a0 + (i / SIDES) * Math.PI * 2
      return { x: f.cx + Math.cos(ang) * rad, y: f.cy + Math.sin(ang) * rad }
    }

    // Hub top facet octagon (textured glowing core).
    const toUV = (x: number, y: number) => ({
      u: f.u0 + ((x - f.cx + rTop) / (2 * rTop)) * (f.u1 - f.u0),
      v: f.v0 + ((y - f.cy + rTop) / (2 * rTop)) * (f.v1 - f.v0),
    })
    for (let i = 0; i < SIDES; i++) {
      const p1 = ringPt(rTop, i)
      const p2 = ringPt(rTop, (i + 1) % SIDES)
      const c = toUV(f.cx, f.cy)
      const uv1 = toUV(p1.x, p1.y)
      const uv2 = toUV(p2.x, p2.y)
      push(f.cx, f.cy, zTop, 0, 0, 1, 0, 0, 0, c.u, c.v, 1, 0)
      push(p1.x, p1.y, zTop, 0, 0, 1, 0, 0, 0, uv1.u, uv1.v, 1, 0)
      push(p2.x, p2.y, zTop, 0, 0, 1, 0, 0, 0, uv2.u, uv2.v, 1, 0)
    }

    // Flat-normal quad helper (crisp facets that catch the light independently).
    const facetQuad = (
      A: V,
      za: number,
      B: V,
      zb: number,
      C: V,
      zc: number,
      D: V,
      zd: number,
      emis: number,
      shade: number,
      cxRef: number,
      cyRef: number,
    ) => {
      const ux = B.x - A.x
      const uy = B.y - A.y
      const uz = zb - za
      const vx = D.x - A.x
      const vy = D.y - A.y
      const vz = zd - za
      let nx = uy * vz - uz * vy
      let ny = uz * vx - ux * vz
      let nz = ux * vy - uy * vx
      const nl = Math.hypot(nx, ny, nz) || 1
      nx /= nl
      ny /= nl
      nz /= nl
      const mx = (A.x + B.x + C.x + D.x) / 4 - cxRef
      const my = (A.y + B.y + C.y + D.y) / 4 - cyRef
      if (mx * nx + my * ny < 0 && nz < 0.05) {
        nx = -nx
        ny = -ny
        nz = -nz
      }
      const cr = f.cr * shade
      const cg = f.cg * shade
      const cb = f.cb * shade
      push(A.x, A.y, za, nx, ny, nz, cr, cg, cb, 0, 0, 0, emis)
      push(B.x, B.y, zb, nx, ny, nz, cr, cg, cb, 0, 0, 0, emis)
      push(C.x, C.y, zc, nx, ny, nz, cr, cg, cb, 0, 0, 0, emis)
      push(A.x, A.y, za, nx, ny, nz, cr, cg, cb, 0, 0, 0, emis)
      push(C.x, C.y, zc, nx, ny, nz, cr, cg, cb, 0, 0, 0, emis)
      push(D.x, D.y, zd, nx, ny, nz, cr, cg, cb, 0, 0, 0, emis)
    }

    // Hub crystal: crown + pavilion facets.
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      const tA = ringPt(rTop, i)
      const tB = ringPt(rTop, j)
      const gA = ringPt(rG, i)
      const gB = ringPt(rG, j)
      const bA = ringPt(rBase, i)
      const bB = ringPt(rBase, j)
      facetQuad(tA, zTop, tB, zTop, gB, zG, gA, zG, hubEmis, 0.92, f.cx, f.cy)
      facetQuad(gA, zG, gB, zG, bB, zBase, bA, zBase, hubEmis * 0.6, 0.66, f.cx, f.cy)
    }

    // One prong per direction: a raised crystalline bar pointing the exit way.
    // A flat top facet (bright, emissive) + four lit side walls. Tip is narrower
    // so it reads as an arrow/shard.
    const prong = (deg: number, len: number, halfW: number, topEmis: number, sideShade: number) => {
      const rad = (deg * Math.PI) / 180
      // 0 deg = up (0,-1); +deg rotates toward +x (screen-clockwise).
      const dx = Math.sin(rad)
      const dy = -Math.cos(rad)
      const px = -dy
      const py = dx
      const r0 = R * 0.7 // start just inside the hub
      const r1 = len
      const wTip = halfW * 0.42
      const hP = H * 0.62
      const baseL: V = { x: f.cx + dx * r0 + px * halfW, y: f.cy + dy * r0 + py * halfW }
      const baseR: V = { x: f.cx + dx * r0 - px * halfW, y: f.cy + dy * r0 - py * halfW }
      const tipL: V = { x: f.cx + dx * r1 + px * wTip, y: f.cy + dy * r1 + py * wTip }
      const tipR: V = { x: f.cx + dx * r1 - px * wTip, y: f.cy + dy * r1 - py * wTip }
      // Top face (CCW: baseL, tipL, tipR, baseR), flat up-normal, emissive.
      const cr = f.cr * 1.0
      const cg = f.cg * 1.0
      const cb = f.cb * 1.0
      push(baseL.x, baseL.y, hP, 0, 0, 1, cr, cg, cb, 0, 0, 0, topEmis)
      push(tipL.x, tipL.y, hP, 0, 0, 1, cr, cg, cb, 0, 0, 0, topEmis)
      push(tipR.x, tipR.y, hP, 0, 0, 1, cr, cg, cb, 0, 0, 0, topEmis)
      push(baseL.x, baseL.y, hP, 0, 0, 1, cr, cg, cb, 0, 0, 0, topEmis)
      push(tipR.x, tipR.y, hP, 0, 0, 1, cr, cg, cb, 0, 0, 0, topEmis)
      push(baseR.x, baseR.y, hP, 0, 0, 1, cr, cg, cb, 0, 0, 0, topEmis)
      // Side walls (each top edge extruded down to z=0).
      const loop = [baseL, tipL, tipR, baseR]
      const sideEmis = topEmis * 0.55
      for (let i = 0; i < 4; i++) {
        const A = loop[i]!
        const B = loop[(i + 1) % 4]!
        facetQuad(A, hP, B, hP, B, zBase, A, zBase, sideEmis, sideShade, f.cx, f.cy)
      }
    }

    for (const deg of f.exits) {
      prong(deg, f.prongLen, f.prongW, 0.3 + 0.85 * litEmis, 0.85)
    }
    // Intake prong (points down at the incoming beam): shorter + dimmer so it
    // reads as the "in" port, distinct from the bright exits.
    prong(180, f.hubR + f.prongW * 1.6, f.prongW * 0.8, 0.1 + 0.3 * litEmis, 0.6)
  }

  const verts = new Float32Array(arr)
  const vertexCount = arr.length / FLOATS_PER_VERT
  g.bindBuffer(g.ARRAY_BUFFER, vbo)
  g.bufferData(g.ARRAY_BUFFER, verts, g.DYNAMIC_DRAW)
  const stride = FLOATS_PER_VERT * 4
  const fp = (loc: number, size: number, off: number) => {
    if (loc < 0) return
    g.enableVertexAttribArray(loc)
    g.vertexAttribPointer(loc, size, g.FLOAT, false, stride, off * 4)
  }
  fp(aLoc.aWorld, 2, 0)
  fp(aLoc.aZ, 1, 2)
  fp(aLoc.aNormal, 3, 3)
  fp(aLoc.aColor, 3, 6)
  fp(aLoc.aUV, 2, 9)
  fp(aLoc.aIsTop, 1, 11)
  fp(aLoc.aEmis, 1, 12)

  g.activeTexture(g.TEXTURE0)
  g.bindTexture(g.TEXTURE_2D, tex)
  try {
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, atlas)
  } catch {
    return null
  }
  g.uniform1i(u.uTex, 0)
  g.uniform1f(u.uCx, proj.cx)
  g.uniform1f(u.uStrength, proj.strength)
  g.uniform1f(u.uNearWorldY, proj.nearWorldY)
  g.uniform1f(u.uHorizonY, proj.horizonY)
  g.uniform1f(u.uSpan, proj.span)
  g.uniform1f(u.uPMin, proj.pMin)
  g.uniform1f(u.uPMax, proj.pMax)
  g.uniform2f(u.uView, viewW, viewH)
  g.uniform3f(u.uLightDir, LIGHT[0], LIGHT[1], LIGHT[2])

  g.drawArrays(g.TRIANGLES, 0, vertexCount)
  return glCanvas
}
