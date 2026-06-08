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
      this.ctx = ctx
      this.limiter = limiter
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
    gain.connect(limiter)

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
}

export const sfxEngine = new SfxEngine()
