// GPU 3D pieces.
//
// The 2D renderer draws each piece as a flat billboard (uniform-scaled by depth).
// This module turns those same pieces into real extruded 3D solids that obey the
// field's perspective: the polished 2D artwork is rendered into an atlas texture
// and mapped (perspective-correct) onto a foreshortened TOP face floating at a
// height above the plane, while the piece's silhouette is extruded down to the
// plane as lit SIDE walls. A depth buffer resolves self- and inter-piece
// occlusion, so nearer pieces correctly overlap farther ones.
//
// The projection here mirrors makeProjection() exactly (a Y-separable perspective
// homography): p(y) = 1 / (1 + strength * (nearWorldY - y)). We feed the same
// constants in and reproduce screenX/screenY in the vertex shader, then add a
// height term (z lifts a point up-screen by z*p). Setting clip.w = 1/p gives the
// GPU true perspective-correct interpolation across the trapezoidal top face.
//
// Like lensGL, this renders into a private WebGL canvas (device px) and returns
// it; the caller composites it onto the 2D scene with drawImage. Returns null if
// WebGL is unavailable so the caller can fall back to the 2D billboards.

export type GLProjUniforms = {
  cx: number // horizontal vanishing center, CSS px
  strength: number
  nearWorldY: number
  horizonY: number // CSS px
  span: number // CSS px (nearScreenY - horizonY)
  pMin: number
  pMax: number
}

export type GLPiece = {
  // Silhouette outline in WORLD px (already offset by the piece's visualPos).
  loop: { x: number; y: number }[]
  // Top-face textured rectangle in WORLD px (AABB grown by the glow margin).
  qx: number
  qy: number
  qw: number
  qh: number
  // Atlas UV rect for that rectangle.
  u0: number
  v0: number
  u1: number
  v1: number
  // Identity color (0..1) for the extruded side walls.
  cr: number
  cg: number
  cb: number
  // Extrusion height in px.
  height: number
}

let gl: WebGLRenderingContext | null = null
let glCanvas: HTMLCanvasElement | null = null
let program: WebGLProgram | null = null
let tex: WebGLTexture | null = null
let vbo: WebGLBuffer | null = null
let initFailed = false
const u: Record<string, WebGLUniformLocation | null> = {}
let aLoc: Record<string, number> = {}

const FLOATS_PER_VERT = 12 // wx,wy,z, nx,ny,nz, cr,cg,cb, u,v, isTop

const VERT = `
precision highp float;
attribute vec2 aWorld;
attribute float aZ;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec2 aUV;
attribute float aIsTop;

uniform float uCx;
uniform float uStrength;
uniform float uNearWorldY;
uniform float uHorizonY;
uniform float uSpan;
uniform float uPMin;
uniform float uPMax;
uniform vec2 uView;       // CSS px (width, height)
uniform vec3 uLightDir;   // normalized

varying vec2 vUV;
varying vec3 vColor;
varying float vIsTop;
varying vec3 vN;

void main() {
  float p = 1.0 / (1.0 + uStrength * (uNearWorldY - aWorld.y));
  p = clamp(p, uPMin, uPMax);

  float sx = uCx + (aWorld.x - uCx) * p;
  float sy = uHorizonY + uSpan * p - aZ * p;

  // CSS px -> clip space (y down -> y up).
  float ndcX = sx / uView.x * 2.0 - 1.0;
  float ndcY = 1.0 - sy / uView.y * 2.0;
  // Depth: nearer (larger p) wins; small height term keeps the top face in front
  // of its own back wall.
  float ndcZ = 0.6 - (p * 0.25 + aZ * 0.0009);

  // Perspective-correct interpolation: w = 1/p (farther => larger w => minified).
  float w = 1.0 / p;
  gl_Position = vec4(ndcX * w, ndcY * w, ndcZ * w, w);

  vUV = aUV;
  vColor = aColor;
  vIsTop = aIsTop;
  vN = aNormal;
}
`

const FRAG = `
precision highp float;
varying vec2 vUV;
varying vec3 vColor;
varying float vIsTop;
varying vec3 vN;
uniform sampler2D uTex;
uniform vec3 uLightDir;

void main() {
  vec3 N = normalize(vN);
  vec3 L = uLightDir;
  // Approximate view direction: camera is below the shaft looking up/in.
  vec3 V = normalize(vec3(0.0, 0.5, 0.95));
  float dif = max(0.0, dot(N, L));
  vec3 Hh = normalize(L + V);
  // Fresnel: bright at grazing angles -> glossy silhouette rim that feeds bloom.
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);

  if (vIsTop > 0.5) {
    vec4 t = texture2D(uTex, vUV);
    if (t.a < 0.02) discard;
    // Per-pixel light keeps the baked art but ties it to the scene; a tight spec
    // sheen makes the top read as a glossy surface instead of a flat sticker.
    float light = 0.9 + 0.2 * dif;
    float spec = pow(max(0.0, dot(N, Hh)), 28.0) * 0.28;
    vec3 col = t.rgb * light + spec;
    gl_FragColor = vec4(col, t.a);
  } else {
    // Cool-shifted shadow + lit face for richer material color. A slightly
    // higher ambient floor keeps faces angled away from the low key from
    // crushing to black.
    float light = 0.55 + 0.62 * dif;
    vec3 col = vColor * light;
    // Glossy specular streak on the lit bevel.
    float spec = pow(max(0.0, dot(N, Hh)), 16.0) * 0.35;
    col += spec * (vColor * 0.5 + 0.5);
    // Fresnel rim in a brightened tint -> premium glowing edge.
    col += fres * (vColor * 0.55 + vec3(0.45)) * 1.05;
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
    }

    gl = g
    program = prog
    return true
  } catch {
    initFailed = true
    return false
  }
}

// Key light from the player/well side: low and in front of the plane (+y is
// toward the near plane where the emitter/well sit, +z toward the camera), with
// a slight left bias. This keys the player-facing faces so the slabs read as lit
// by the singularity below rather than a generic top-left studio light.
const LIGHT: [number, number, number] = (() => {
  const x = -0.22
  const y = 0.42
  const z = 0.88
  const l = Math.hypot(x, y, z)
  return [x / l, y / l, z / l]
})()

export const renderPiecesGL = (
  atlas: HTMLCanvasElement,
  pieces: GLPiece[],
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

  if (pieces.length === 0) return glCanvas

  // Build the interleaved vertex array (CPU). Each piece is a rounded slab: a
  // domed/beveled TOP (textured, the art wraps over the rounded edge), a vertical
  // wall, and a rounded FOOT — so every edge is rounded, not a hard box corner.
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
  ) => {
    arr.push(wx, wy, z, nx, ny, nz, cr, cg, cb, uu, vv, isTop)
  }

  type Ring = { inset: number; z: number; nz: number; tex: boolean }

  for (const pc of pieces) {
    const H = pc.height
    const loop = pc.loop
    const N = loop.length
    if (N < 3) continue

    // Centroid + per-point outward normal (averaged adjacent edge normals), so
    // each profile ring can be offset inward by the bevel radius.
    let cgx = 0
    let cgy = 0
    for (const p of loop) {
      cgx += p.x
      cgy += p.y
    }
    cgx /= N
    cgy /= N
    const nrm: { x: number; y: number }[] = []
    for (let i = 0; i < N; i++) {
      const prev = loop[(i - 1 + N) % N]!
      const cur = loop[i]!
      const nxt = loop[(i + 1) % N]!
      const e1x = cur.x - prev.x
      const e1y = cur.y - prev.y
      const e2x = nxt.x - cur.x
      const e2y = nxt.y - cur.y
      // Edge normals (perpendicular to each edge), averaged for a smooth corner.
      let nx = e1y + e2y
      let ny = -e1x - e2x
      const l = Math.hypot(nx, ny) || 1
      nx /= l
      ny /= l
      // Orient outward (away from centroid).
      if ((cur.x - cgx) * nx + (cur.y - cgy) * ny < 0) {
        nx = -nx
        ny = -ny
      }
      nrm.push({ x: nx, y: ny })
    }

    const rr = Math.min(H * 0.5, 10)
    const S = 3
    const rings: Ring[] = []
    // A small top chamfer rounds the upper rim, then a vertical wall, then a
    // rounded foot down to the floor. All side geometry is SOLID colored (the
    // flat top quad below carries the artwork) so nothing smears the texture.
    const topChamfer = Math.min(rr * 0.6, 5)
    rings.push({ inset: 0, z: H, nz: 0.65, tex: false })
    rings.push({ inset: topChamfer, z: H - topChamfer, nz: 0, tex: false })
    rings.push({ inset: topChamfer, z: rr, nz: 0, tex: false })
    for (let k = 1; k <= S; k++) {
      const t = (k / S) * (Math.PI / 2)
      rings.push({
        inset: topChamfer + rr * Math.sin(t),
        z: rr * Math.cos(t),
        nz: -Math.sin(t),
        tex: false,
      })
    }

    const qx = pc.qx
    const qy = pc.qy
    const qw = pc.qw
    const qh = pc.qh

    // A profile-ring vertex at loop point i.
    const ringVert = (r: Ring, i: number) => {
      const lp = loop[i]!
      const nn = nrm[i]!
      const px = lp.x - nn.x * r.inset
      const py = lp.y - nn.y * r.inset
      const nh = Math.sqrt(Math.max(0, 1 - r.nz * r.nz))
      const shade = 0.6 + 0.4 * (r.z / H)
      return {
        x: px,
        y: py,
        z: r.z,
        nx: nn.x * nh,
        ny: nn.y * nh,
        nz: r.nz,
        cr: pc.cr * shade,
        cg: pc.cg * shade,
        cb: pc.cb * shade,
      }
    }
    const emit = (vt: ReturnType<typeof ringVert>) =>
      push(vt.x, vt.y, vt.z, vt.nx, vt.ny, vt.nz, vt.cr, vt.cg, vt.cb, 0, 0, 0)

    // Flat textured top quad (AABB + margin) at the slab height. The art's alpha
    // cuts the silhouette; this is the artifact-free path that had no smearing.
    const x0 = pc.qx
    const y0 = pc.qy
    const x1 = pc.qx + pc.qw
    const y1 = pc.qy + pc.qh
    push(x0, y0, H, 0, 0, 1, 0, 0, 0, pc.u0, pc.v0, 1)
    push(x1, y0, H, 0, 0, 1, 0, 0, 0, pc.u1, pc.v0, 1)
    push(x1, y1, H, 0, 0, 1, 0, 0, 0, pc.u1, pc.v1, 1)
    push(x0, y0, H, 0, 0, 1, 0, 0, 0, pc.u0, pc.v0, 1)
    push(x1, y1, H, 0, 0, 1, 0, 0, 0, pc.u1, pc.v1, 1)
    push(x0, y1, H, 0, 0, 1, 0, 0, 0, pc.u0, pc.v1, 1)

    // Solid rounded side walls (chamfered top rim + vertical + rounded foot).
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r]!
      const B = rings[r + 1]!
      for (let i = 0; i < N; i++) {
        const j = (i + 1) % N
        const a0 = ringVert(A, i)
        const a1 = ringVert(A, j)
        const b0 = ringVert(B, i)
        const b1 = ringVert(B, j)
        emit(a0)
        emit(a1)
        emit(b1)
        emit(a0)
        emit(b1)
        emit(b0)
      }
    }
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
