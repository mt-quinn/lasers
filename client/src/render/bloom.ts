// Selective HDR-ish bloom post-process.
//
// After the full frame (2D scene + GL pieces) is composited onto the main canvas,
// this pass extracts only the genuinely bright pixels (high threshold + soft
// knee, so ordinary mid-tones never smear), blurs them with a separable Gaussian
// at half resolution, and returns a glow-on-black canvas. The caller adds it back
// over the scene with an additive ('lighter') drawImage.
//
// Like piecesGL/lensGL this owns a private WebGL canvas and never touches the
// app's main GL state. Returns null when WebGL is unavailable so the caller can
// simply skip the glow.

export type BloomOpts = {
  threshold: number // luminance above which pixels start to bloom (0..1)
  knee: number // soft-knee width below the threshold
  intensity: number // glow gain on composite
  iterations: number // number of full H+V blur passes (wider = softer/larger)
}

const QUAD_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

const BRIGHT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uThreshold;
uniform float uKnee;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  // Use the max channel so saturated neon (which has a modest luma) still blooms.
  float l = max(c.r, max(c.g, c.b));
  float k = clamp((l - uThreshold) / max(uKnee, 1e-4), 0.0, 1.0);
  float contrib = k * k * (3.0 - 2.0 * k); // smoothstep knee
  gl_FragColor = vec4(c * contrib, 1.0);
}
`

const BLUR_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir; // texel step along one axis
void main() {
  // 9-tap Gaussian via 5 linearly-sampled taps.
  vec3 sum = texture2D(uTex, vUv).rgb * 0.227027;
  vec2 o1 = uDir * 1.3846153846;
  vec2 o2 = uDir * 3.2307692308;
  sum += texture2D(uTex, vUv + o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUv - o1).rgb * 0.3162162162;
  sum += texture2D(uTex, vUv + o2).rgb * 0.0702702703;
  sum += texture2D(uTex, vUv - o2).rgb * 0.0702702703;
  gl_FragColor = vec4(sum, 1.0);
}
`

const OUT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uIntensity;
void main() {
  gl_FragColor = vec4(texture2D(uTex, vUv).rgb * uIntensity, 1.0);
}
`

let glCanvas: HTMLCanvasElement | null = null
let gl: WebGLRenderingContext | null = null
let initFailed = false

let pBright: WebGLProgram | null = null
let pBlur: WebGLProgram | null = null
let pOut: WebGLProgram | null = null
let quad: WebGLBuffer | null = null

let srcTex: WebGLTexture | null = null
// Half-res scratch the scene is downsampled into before upload: a cheap GPU blit
// that quarters the texture-upload bandwidth (the bloom is blurred regardless).
let dsCanvas: HTMLCanvasElement | null = null
let dsCtx: CanvasRenderingContext2D | null = null
// Two half-res ping-pong targets.
let fboA: WebGLFramebuffer | null = null
let texA: WebGLTexture | null = null
let fboB: WebGLFramebuffer | null = null
let texB: WebGLTexture | null = null
let halfW = 0
let halfH = 0

type Locs = Record<string, WebGLUniformLocation | null>
const uBright: Locs = {}
const uBlur: Locs = {}
const uOut: Locs = {}
const aPosLoc: Record<string, number> = {}

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

const link = (g: WebGLRenderingContext, frag: string) => {
  const vs = compile(g, g.VERTEX_SHADER, QUAD_VERT)
  const fs = compile(g, g.FRAGMENT_SHADER, frag)
  if (!vs || !fs) return null
  const prog = g.createProgram()
  if (!prog) return null
  g.attachShader(prog, vs)
  g.attachShader(prog, fs)
  g.linkProgram(prog)
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) return null
  return prog
}

const makeTarget = (g: WebGLRenderingContext, w: number, h: number) => {
  const tex = g.createTexture()
  g.bindTexture(g.TEXTURE_2D, tex)
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, null)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)
  const fbo = g.createFramebuffer()
  g.bindFramebuffer(g.FRAMEBUFFER, fbo)
  g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, tex, 0)
  return { tex, fbo }
}

const init = (): boolean => {
  if (gl && pBright) return true
  if (initFailed) return false
  try {
    glCanvas = document.createElement('canvas')
    const g = (glCanvas.getContext('webgl', {
      premultipliedAlpha: false,
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: true,
    }) || glCanvas.getContext('experimental-webgl')) as WebGLRenderingContext | null
    if (!g) {
      initFailed = true
      return false
    }
    pBright = link(g, BRIGHT_FRAG)
    pBlur = link(g, BLUR_FRAG)
    pOut = link(g, OUT_FRAG)
    if (!pBright || !pBlur || !pOut) {
      initFailed = true
      return false
    }

    quad = g.createBuffer()
    g.bindBuffer(g.ARRAY_BUFFER, quad)
    g.bufferData(
      g.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      g.STATIC_DRAW,
    )

    aPosLoc.bright = g.getAttribLocation(pBright, 'aPos')
    aPosLoc.blur = g.getAttribLocation(pBlur, 'aPos')
    aPosLoc.out = g.getAttribLocation(pOut, 'aPos')
    uBright.uTex = g.getUniformLocation(pBright, 'uTex')
    uBright.uThreshold = g.getUniformLocation(pBright, 'uThreshold')
    uBright.uKnee = g.getUniformLocation(pBright, 'uKnee')
    uBlur.uTex = g.getUniformLocation(pBlur, 'uTex')
    uBlur.uDir = g.getUniformLocation(pBlur, 'uDir')
    uOut.uTex = g.getUniformLocation(pOut, 'uTex')
    uOut.uIntensity = g.getUniformLocation(pOut, 'uIntensity')

    srcTex = g.createTexture()
    g.bindTexture(g.TEXTURE_2D, srcTex)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR)
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR)

    gl = g
    return true
  } catch {
    initFailed = true
    return false
  }
}

const ensureTargets = (g: WebGLRenderingContext, w: number, h: number) => {
  if (w === halfW && h === halfH && fboA && fboB) return
  if (texA) g.deleteTexture(texA)
  if (texB) g.deleteTexture(texB)
  if (fboA) g.deleteFramebuffer(fboA)
  if (fboB) g.deleteFramebuffer(fboB)
  const a = makeTarget(g, w, h)
  const b = makeTarget(g, w, h)
  texA = a.tex
  fboA = a.fbo
  texB = b.tex
  fboB = b.fbo
  halfW = w
  halfH = h
}

const bindQuad = (g: WebGLRenderingContext, loc: number) => {
  g.bindBuffer(g.ARRAY_BUFFER, quad)
  g.enableVertexAttribArray(loc)
  g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
}

/**
 * Render a glow-on-black canvas from the bright regions of `source`.
 * Returns the device-pixel canvas to composite additively, or null.
 */
export const renderBloom = (
  source: HTMLCanvasElement,
  opts: BloomOpts,
): HTMLCanvasElement | null => {
  if (!init() || !gl || !glCanvas) return null
  const g = gl
  const W = source.width
  const H = source.height
  if (W === 0 || H === 0) return null
  if (glCanvas.width !== W || glCanvas.height !== H) {
    glCanvas.width = W
    glCanvas.height = H
  }
  // Half-res working targets keep the blur cheap and naturally wider.
  const hw = Math.max(1, W >> 1)
  const hh = Math.max(1, H >> 1)
  ensureTargets(g, hw, hh)

  g.disable(g.BLEND)
  g.disable(g.DEPTH_TEST)

  // Downsample the scene to half res (cheap GPU blit) before upload so we move a
  // quarter of the pixels across the bus; the working targets are half res too,
  // so there's no quality loss.
  if (!dsCanvas) {
    dsCanvas = document.createElement('canvas')
    dsCtx = dsCanvas.getContext('2d')
  }
  if (dsCanvas.width !== hw || dsCanvas.height !== hh) {
    dsCanvas.width = hw
    dsCanvas.height = hh
  }
  const upload: HTMLCanvasElement = dsCanvas
  if (dsCtx) {
    dsCtx.clearRect(0, 0, hw, hh)
    dsCtx.drawImage(source, 0, 0, W, H, 0, 0, hw, hh)
  }

  // Upload the (downsampled) scene. Flip Y on upload so the canvas (top-left
  // origin) lines up with GL texture space (bottom-left origin); without this the
  // glow comes back vertically mirrored and ghosts the scene.
  g.bindTexture(g.TEXTURE_2D, srcTex)
  g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, 1)
  g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, dsCtx ? upload : source)

  // Bright pass: source (full res) -> fboA (half res).
  g.bindFramebuffer(g.FRAMEBUFFER, fboA)
  g.viewport(0, 0, hw, hh)
  g.useProgram(pBright)
  bindQuad(g, aPosLoc.bright)
  g.activeTexture(g.TEXTURE0)
  g.bindTexture(g.TEXTURE_2D, srcTex)
  g.uniform1i(uBright.uTex, 0)
  g.uniform1f(uBright.uThreshold, opts.threshold)
  g.uniform1f(uBright.uKnee, opts.knee)
  g.drawArrays(g.TRIANGLES, 0, 3)

  // Separable Gaussian, ping-ponging A<->B at half res. The bright pass left its
  // result in texA, so reading starts there.
  g.useProgram(pBlur)
  bindQuad(g, aPosLoc.blur)
  g.uniform1i(uBlur.uTex, 0)
  const iters = Math.max(1, Math.floor(opts.iterations))
  let from = { tex: texA, fbo: fboA }
  let to = { tex: texB, fbo: fboB }
  const swap = () => {
    const t = from
    from = to
    to = t
  }
  const blurStep = (dx: number, dy: number) => {
    g.bindFramebuffer(g.FRAMEBUFFER, to.fbo)
    g.viewport(0, 0, hw, hh)
    g.activeTexture(g.TEXTURE0)
    g.bindTexture(g.TEXTURE_2D, from.tex)
    g.uniform2f(uBlur.uDir, dx, dy)
    g.drawArrays(g.TRIANGLES, 0, 3)
    swap()
  }
  for (let i = 0; i < iters; i++) {
    blurStep(1 / hw, 0)
    blurStep(0, 1 / hh)
  }

  // Output the blurred glow to the canvas (default framebuffer), upscaled.
  g.bindFramebuffer(g.FRAMEBUFFER, null)
  g.viewport(0, 0, W, H)
  g.clearColor(0, 0, 0, 1)
  g.clear(g.COLOR_BUFFER_BIT)
  g.useProgram(pOut)
  bindQuad(g, aPosLoc.out)
  g.activeTexture(g.TEXTURE0)
  g.bindTexture(g.TEXTURE_2D, from.tex)
  g.uniform1i(uOut.uTex, 0)
  g.uniform1f(uOut.uIntensity, opts.intensity)
  g.drawArrays(g.TRIANGLES, 0, 3)

  return glCanvas
}
