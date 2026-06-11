// GPU trench board.
//
// Renders the mesh built by boardMesh.ts (the machined trench: recessed
// channel, accelerator rails, plated aprons, greebles, ring braces, parapet
// walls) with the same Y-separable homography + z-height term the piece pass
// uses, so the board and the pieces live in one perspective. The fragment
// lighting reproduces the offline preview rasterizer exactly:
//   col = base * (0.40 + 0.66 * max(0, dot(N, L))) * ao(z) + emissive
// with ao(z) = clamp(1 + z * 0.022, 0.55, 1) self-shadowing the recess.
//
// Like piecesGL, this draws into a private WebGL canvas and returns it for
// the caller to composite with drawImage; null means "no WebGL — use the 2D
// fallback board".

import type { GLProjUniforms } from './piecesGL'
import { BOARD_LIGHT, FLOATS_PER_BOARD_VERT } from './boardMesh'

let gl: WebGLRenderingContext | null = null
let glCanvas: HTMLCanvasElement | null = null
let program: WebGLProgram | null = null
let vbo: WebGLBuffer | null = null
let initFailed = false
const u: Record<string, WebGLUniformLocation | null> = {}
let aLoc: Record<string, number> = {}

const VERT = `
precision highp float;
attribute vec2 aWorld;
attribute float aZ;
attribute vec3 aNormal;
attribute vec3 aColor;
attribute vec3 aEmissive;
attribute float aMat;

uniform float uCx;
uniform float uStrength;
uniform float uNearWorldY;
uniform float uHorizonY;
uniform float uSpan;
uniform float uPMin;
uniform float uPMax;
uniform vec2 uView;

varying vec3 vColor;
varying vec3 vEmissive;
varying vec3 vN;
varying float vZ;
varying float vWy;
varying float vMat;

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
  vColor = aColor;
  vEmissive = aEmissive;
  vN = aNormal;
  vZ = aZ;
  vWy = aWorld.y;
  vMat = aMat;
}
`

const FRAG = `
precision highp float;
varying vec3 vColor;
varying vec3 vEmissive;
varying vec3 vN;
varying float vZ;
varying float vWy;
varying float vMat;
uniform vec3 uLightDir;

void main() {
  vec3 N = normalize(vN);
  float dif = max(0.0, dot(N, uLightDir));
  if (vMat > 0.5) {
    // MIRROR (parapet walls): procedural chrome. Specular streak bands keyed
    // to world y (so they scroll with the board) and height, over the steel
    // base — a fake reflection that reads as machined mirror without an env
    // map. Brightness is modulated by the CPU-baked distance fade carried in
    // vColor, so the chrome melts into the fog like everything else.
    float band = pow(0.5 + 0.5 * sin(vWy * 0.05 + vZ * 0.30), 3.0);
    float band2 = 0.5 + 0.5 * sin(vWy * 0.011 + vZ * 0.07 + 4.7);
    float refl = 0.22 + 0.55 * band + 0.30 * band2 * band2;
    float fadeK = clamp(length(vColor) * 3.0, 0.0, 1.0);
    vec3 col = vColor * (0.45 + 1.7 * refl);
    col += vec3(0.50, 0.58, 0.66) * refl * 0.35 * fadeK;
    col += vEmissive;
    gl_FragColor = vec4(col, 1.0);
    return;
  }
  float ao = clamp(1.0 + vZ * 0.022, 0.55, 1.0);
  vec3 col = vColor * (0.40 + 0.66 * dif) * ao + vEmissive;
  gl_FragColor = vec4(col, 1.0);
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
    ]) {
      u[name] = g.getUniformLocation(prog, name)
    }
    aLoc = {
      aWorld: g.getAttribLocation(prog, 'aWorld'),
      aZ: g.getAttribLocation(prog, 'aZ'),
      aNormal: g.getAttribLocation(prog, 'aNormal'),
      aColor: g.getAttribLocation(prog, 'aColor'),
      aEmissive: g.getAttribLocation(prog, 'aEmissive'),
      aMat: g.getAttribLocation(prog, 'aMat'),
    }
    gl = g
    program = prog
    return true
  } catch {
    initFailed = true
    return false
  }
}

export const renderBoardGL = (
  verts: Float32Array,
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
  g.disable(g.BLEND)
  g.clearColor(0, 0, 0, 0)
  g.clearDepth(1.0)
  g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT)

  const vertexCount = verts.length / FLOATS_PER_BOARD_VERT
  if (vertexCount === 0) return glCanvas

  g.bindBuffer(g.ARRAY_BUFFER, vbo)
  g.bufferData(g.ARRAY_BUFFER, verts, g.DYNAMIC_DRAW)
  const stride = FLOATS_PER_BOARD_VERT * 4
  const fp = (loc: number, size: number, off: number) => {
    if (loc < 0) return
    g.enableVertexAttribArray(loc)
    g.vertexAttribPointer(loc, size, g.FLOAT, false, stride, off * 4)
  }
  fp(aLoc.aWorld!, 2, 0)
  fp(aLoc.aZ!, 1, 2)
  fp(aLoc.aNormal!, 3, 3)
  fp(aLoc.aColor!, 3, 6)
  fp(aLoc.aEmissive!, 3, 9)
  fp(aLoc.aMat!, 1, 12)

  g.uniform1f(u.uCx, proj.cx)
  g.uniform1f(u.uStrength, proj.strength)
  g.uniform1f(u.uNearWorldY, proj.nearWorldY)
  g.uniform1f(u.uHorizonY, proj.horizonY)
  g.uniform1f(u.uSpan, proj.span)
  g.uniform1f(u.uPMin, proj.pMin)
  g.uniform1f(u.uPMax, proj.pMax)
  g.uniform2f(u.uView, viewW, viewH)
  g.uniform3f(u.uLightDir, BOARD_LIGHT[0], BOARD_LIGHT[1], BOARD_LIGHT[2])

  g.drawArrays(g.TRIANGLES, 0, vertexCount)
  return glCanvas
}
