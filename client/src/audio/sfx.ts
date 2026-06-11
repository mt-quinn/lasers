// One-shot sound-effects engine (Web Audio).
//
// Plays the "pop" piece-destroyed sample with true polyphony: every trigger
// spawns its own AudioBufferSourceNode, so rapid or simultaneous kills overlap
// naturally instead of cutting each other off.
//
// Each voice plays at a fixed baseline gain, and the whole effects bus runs
// through a DynamicsCompressorNode acting as a limiter. A single hit sits below
// the limiter threshold (so it plays at exactly its baseline), while stacked/
// overlapping voices are caught by the limiter and can't sum into a volume
// spike. A small per-voice pitch + start-time jitter decorrelates identical
// samples so they don't comb-filter.
//
// This is intentionally independent of the music engine and its volume slider:
// gameplay feedback fires at a fixed level whether or not the soundtrack is on,
// and is never scaled by the music volume control. On iOS it requests the
// "ambient" audio session so the effect mixes with other app audio instead of
// interrupting it. It unlocks on the same first gesture as the music.

import { getPrefs } from '../game/settings'

const POP_URL = `${import.meta.env.BASE_URL}pop.wav`

// Fixed playback level for the pop SFX (0..1): 50%, independent of the music
// volume slider. The bus limiter only engages once overlaps would push past it.
const POP_VOLUME = 0.5

// Hard ceiling on concurrent voices so a pathological kill rate can't spawn an
// unbounded number of nodes. The limiter handles loudness; this caps node count.
const MAX_VOICES = 24

type WindowWithWebkit = typeof window & { webkitAudioContext?: typeof AudioContext }

// WebKit-only audio session API (Safari/iOS). Setting `type = 'ambient'` lets
// our web audio mix with other apps' audio rather than taking over the session.
type NavigatorWithAudioSession = Navigator & {
  audioSession?: { type?: string }
}

class SfxEngine {
  private ctx: AudioContext | null = null
  private limiter: DynamicsCompressorNode | null = null
  // SFX bus volume (settings panel). Sits between the voices and the limiter.
  private master: GainNode | null = null
  private lastAlarmAt = 0
  // Rolling schedule cursor for sweep ticks: motes swallowed in the same frame
  // play as a fast rising arpeggio instead of one chord.
  private lastTickAt = 0
  private buffer: AudioBuffer | null = null
  // Raw bytes fetched up front (no AudioContext needed) so the sample is ready
  // to decode the instant the context exists.
  private raw: ArrayBuffer | null = null
  private activeVoices = 0

  constructor() {
    if (typeof window !== 'undefined') void this.prefetch()
  }

  private async prefetch() {
    try {
      const res = await fetch(POP_URL)
      if (res.ok) this.raw = await res.arrayBuffer()
    } catch {
      // Offline / missing asset: playPop() simply no-ops.
    }
  }

  private ensureGraph() {
    if (this.ctx || typeof window === 'undefined') return
    const Ctor =
      (window as WindowWithWebkit).AudioContext ||
      (window as WindowWithWebkit).webkitAudioContext
    if (!Ctor) return
    try {
      // iOS: ask for the mixable ("ambient") audio session so the pop SFX coexists
      // with other app audio instead of interrupting it. Best-effort; ignored
      // where unsupported.
      try {
        const session = (navigator as NavigatorWithAudioSession).audioSession
        if (session) session.type = 'ambient'
      } catch {
        // audioSession not available / not settable: fall back to default.
      }
      const ctx = new Ctor()
      // Bus limiter: only ever reduces gain (no makeup), so it can tame summed
      // peaks from overlapping one-shots but never boost a single hit.
      const limiter = ctx.createDynamicsCompressor()
      limiter.threshold.value = -2
      limiter.knee.value = 0
      limiter.ratio.value = 20
      limiter.attack.value = 0.003
      limiter.release.value = 0.12
      limiter.connect(ctx.destination)
      const master = ctx.createGain()
      master.gain.value = getPrefs().sfxVolume
      master.connect(limiter)
      this.ctx = ctx
      this.limiter = limiter
      this.master = master
      void this.decode()
    } catch {
      // No Web Audio available; stay silent.
    }
  }

  private async decode() {
    if (!this.ctx || this.buffer || !this.raw) return
    try {
      // decodeAudioData detaches its input, so decode a copy and keep `raw`.
      this.buffer = await this.ctx.decodeAudioData(this.raw.slice(0))
    } catch {
      // Undecodable sample: leave null so playback no-ops.
    }
  }

  // Must be called from inside a user gesture the first time (autoplay policy).
  // Idempotent and safe to call on every gesture.
  unlock() {
    this.ensureGraph()
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') {
      void ctx.resume()
    }
    // If the context existed before the bytes finished downloading, decode now.
    void this.decode()
  }

  // Fire-and-forget a pop on each piece destroyed. No-ops until the context is
  // unlocked + the sample is decoded (both happen by the time gameplay produces
  // a kill). Polyphonic: rapid/simultaneous kills overlap freely.
  playPop() {
    const ctx = this.ctx
    const buffer = this.buffer
    const limiter = this.limiter
    if (!ctx || !buffer || !limiter) return
    if (ctx.state !== 'running') return
    if (this.activeVoices >= MAX_VOICES) return

    const src = ctx.createBufferSource()
    src.buffer = buffer
    // ±40 cents so identical samples landing together don't phase-comb.
    src.detune.value = (Math.random() * 2 - 1) * 40

    const gain = ctx.createGain()
    gain.gain.value = POP_VOLUME

    src.connect(gain)
    gain.connect(this.master ?? limiter)

    this.activeVoices += 1
    src.onended = () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1)
      try {
        src.disconnect()
        gain.disconnect()
      } catch {
        // Already torn down.
      }
    }

    // Up to ~6ms of start jitter further decorrelates same-frame multi-kills.
    src.start(ctx.currentTime + Math.random() * 0.006)
  }

  // SFX bus volume 0..1 (independent of the music slider). Driven by the
  // settings panel; persisted there via game/settings.
  setVolume(v: number) {
    if (this.master) this.master.gain.value = Math.min(1, Math.max(0, v))
  }

  // Fail-grace alarm: two short descending beeps, fully synthesized (no
  // asset). Fired when a block first crosses the fail line and the one-step
  // grace arms — the "one step from death" telegraph. Throttled so repeated
  // re-arms can't machine-gun it.
  playAlarm() {
    const ctx = this.ctx
    const out = this.master ?? this.limiter
    if (!ctx || !out || ctx.state !== 'running') return
    const now = ctx.currentTime
    if (now - this.lastAlarmAt < 1.1) return
    this.lastAlarmAt = now
    const beep = (t0: number, f0: number, f1: number) => {
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(f0, t0)
      osc.frequency.exponentialRampToValueAtTime(f1, t0 + 0.1)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t0)
      g.gain.linearRampToValueAtTime(0.24, t0 + 0.012)
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12)
      osc.connect(g)
      g.connect(out)
      osc.start(t0)
      osc.stop(t0 + 0.14)
      osc.onended = () => {
        try {
          osc.disconnect()
          g.disconnect()
        } catch {
          // Already torn down.
        }
      }
    }
    beep(now, 920, 640)
    beep(now + 0.16, 700, 470)
  }

  // One synthesized pluck, used by the sweep-chain feedback below.
  private pluck(t0: number, freq: number, vol: number, dur = 0.16, type: OscillatorType = 'sine') {
    const ctx = this.ctx
    const out = this.master ?? this.limiter
    if (!ctx || !out) return
    const osc = ctx.createOscillator()
    osc.type = type
    osc.frequency.value = freq
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t0)
    g.gain.linearRampToValueAtTime(vol, t0 + 0.008)
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur)
    osc.connect(g)
    g.connect(out)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
    osc.onended = () => {
      try {
        osc.disconnect()
        g.disconnect()
      } catch {
        // Already torn down.
      }
    }
  }

  // Rising pickup ticks for the mote sweep chain: each capture walks one step
  // up a pentatonic scale (the Peggle trick, kept polite), growing slightly
  // louder as the chain builds. `n` is the mote's position in the chain.
  playMoteTick(n: number) {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return
    const scale = [0, 3, 5, 7, 10]
    const step = Math.min(24, n - 1)
    const semis = scale[step % 5]! + 12 * Math.floor(step / 5)
    const freq = 523.25 * Math.pow(2, semis / 12)
    const t0 = Math.max(ctx.currentTime, this.lastTickAt + 0.045)
    this.lastTickAt = t0
    this.pluck(t0, freq, 0.1 + Math.min(0.1, n * 0.006))
  }

  // End-of-chain flourish: a quick ascending arpeggio that gains notes (and a
  // little sparkle) with the chain length.
  playSweepEnd(count: number) {
    const ctx = this.ctx
    if (!ctx || ctx.state !== 'running') return
    const t0 = ctx.currentTime
    const semis = count >= 16 ? [0, 7, 12, 19, 24] : count >= 10 ? [0, 7, 12, 19] : [0, 7, 12]
    semis.forEach((sm, i) => {
      const freq = 659.26 * Math.pow(2, sm / 12)
      this.pluck(t0 + i * 0.055, freq, 0.15, 0.22, i === semis.length - 1 ? 'triangle' : 'sine')
    })
  }
}

export const sfxEngine = new SfxEngine()
