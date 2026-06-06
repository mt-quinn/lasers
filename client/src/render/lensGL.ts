// GPU gravitational-lens warp.
//
// The black hole bends the board behind it. Doing this on the 2D canvas with
// concentric scaled rings is inherently aliased (each band has one scale, so
// continuous lines stair-step across the seams). Instead we sample the snapshot
// PER PIXEL in a fragment shader using the thin-lens equation, with bilinear
// filtering — a single GPU draw that is both perfectly smooth and far cheaper
// than dozens of clipped drawImage calls.
//
// Usage: renderLens(snapshotCanvas, params) draws the warped disc into a private
// WebGL canvas (device px) and returns it; the caller composites it onto the
// scene. Returns null if WebGL is unavailable, so the caller can degrade.

type LensParams = {
  // All lengths in DEVICE pixels, in the snapshot's box-local space (the box's
  // top-left is (0,0)).
  cx: number
  cy: number
  rCore: number
  rEin: number
  rLensIn: number
  rLens: number
  // Device-pixel size of the box region actually used inside the snapshot.
  boxDevW: number
  boxDevH: number
  // Full snapshot canvas size (the box sits in its top-left corner).
  snapW: number
  snapH: number
}

let gl: WebGLRenderingContext | null = null
let glCanvas: HTMLCanvasElement | null = null
let program: WebGLProgram | null = null
let tex: WebGLTexture | null = null
let quad: WebGLBuffer | null = null
let initFailed = false
const u: Record<string, WebGLUniformLocation | null> = {}

const VERT = `
attribute vec2 aPos;
varying vec2 vUV;
void main() {
  // aPos in clip space [-1,1]. vUV is OUTPUT position, (0,0) = TOP-left. Clip
  // y=+1 is the top of the drawn canvas, so flip y here. Everything downstream
  // (centre, radii, sampling) is then in a single y-down, top-left space — which
  // keeps the lens centred on the core even when the box is clamped at an edge.
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const FRAG = `
precision highp float;
varying vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uBox;       // box size, device px
uniform vec2 uTexScale;  // box / snapshot (maps box uv into the used sub-rect)
uniform vec2 uCenter;    // hole centre, device px (box space)
uniform float uREin;
uniform float uRLensIn;
uniform float uRLens;
void main() {
  vec2 p = vUV * uBox;            // this fragment, device px (box space)
  vec2 d = p - uCenter;
  float r = length(d);
  float ri = max(r, 0.0001);
  // Thin-lens deflection, tapered smoothly to 0 at the lens edge.
  float taper = clamp((uRLens - r) / (uRLens - uRLensIn), 0.0, 1.0);
  taper = taper * taper * (3.0 - 2.0 * taper);
  float defl = (uREin * uREin / ri) * taper;
  float beta = max(r * 0.12, r - defl);
  // Outside the lens, beta == r exactly (taper -> 0), so this samples the source
  // 1:1. With a pixel-aligned snapshot that reproduces the originals exactly, so
  // the warped box can replace the scene with no visible boundary.
  vec2 sp = uCenter + d * (beta / ri);
  // Top-left, y-down throughout. The snapshot is uploaded WITHOUT FLIP_Y, so its
  // texel (0,0) is the canvas top-left and uv maps straight in.
  vec2 uv = (sp / uBox) * uTexScale;
  gl_FragColor = texture2D(uTex, uv);
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
      antialias: false,
      depth: false,
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

    quad = g.createBuffer()
    g.bindBuffer(g.ARRAY_BUFFER, quad)
    g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW)

    tex = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, tex)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 0)
    g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)

    g.useProgram(prog)
    u.uTex = g.getUniformLocation(prog, 'uTex')
    u.uBox = g.getUniformLocation(prog, 'uBox')
    u.uTexScale = g.getUniformLocation(prog, 'uTexScale')
    u.uCenter = g.getUniformLocation(prog, 'uCenter')
    u.uREin = g.getUniformLocation(prog, 'uREin')
    u.uRLensIn = g.getUniformLocation(prog, 'uRLensIn')
    u.uRLens = g.getUniformLocation(prog, 'uRLens')

    const loc = g.getAttribLocation(prog, 'aPos')
    g.enableVertexAttribArray(loc)
    g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)

    gl = g
    program = prog
    return true
  } catch {
    initFailed = true
    return false
  }
}

export const renderLens = (snap: HTMLCanvasElement, p: LensParams): HTMLCanvasElement | null => {
  if (!init() || !gl || !glCanvas || !program) return null
  const g = gl
  const w = Math.max(1, Math.round(p.boxDevW))
  const h = Math.max(1, Math.round(p.boxDevH))
  if (glCanvas.width !== w || glCanvas.height !== h) {
    glCanvas.width = w
    glCanvas.height = h
  }
  g.viewport(0, 0, w, h)
  g.useProgram(program)

  g.activeTexture(g.TEXTURE0)
  g.bindTexture(g.TEXTURE_2D, tex)
  // Upload the current snapshot (FLIP_Y so texel row 0 is the canvas top row).
  try {
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, snap)
  } catch {
    return null
  }
  g.uniform1i(u.uTex, 0)
  g.uniform2f(u.uBox, w, h)
  g.uniform2f(u.uTexScale, p.boxDevW / p.snapW, p.boxDevH / p.snapH)
  g.uniform2f(u.uCenter, p.cx, p.cy)
  g.uniform1f(u.uREin, p.rEin)
  g.uniform1f(u.uRLensIn, p.rLensIn)
  g.uniform1f(u.uRLens, p.rLens)

  g.clearColor(0, 0, 0, 0)
  g.clear(g.COLOR_BUFFER_BIT)
  g.drawArrays(g.TRIANGLE_STRIP, 0, 4)
  return glCanvas
}
