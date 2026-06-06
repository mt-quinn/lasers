// Music-reactive engine.
//
// Streams a track from the Audius API and analyses it in real time, producing
// smoothed 0..1 signals (bass / mid / treble / energy / pulse / onset / beat)
// that the renderer and visual-only sim FX read each frame to make the whole
// game react to the music.
//
// Architecture:
//   <audio crossOrigin="anonymous">  (streams the Audius mp3)
//        -> AudioContext.createMediaElementSource
//        -> AnalyserNode (fftSize 256 -> 128 bins)
//        -> destination (so we still hear it)
//
// `getByteFrequencyData` reads 128 bytes/frame (no allocation), which is
// essentially free. We bin into bands, adaptively normalize against a rolling
// energy floor/peak so any track lands in a full dynamic range, run envelope
// followers with independent attack/release for punch without jitter, and do a
// simple onset/beat detector.
//
// The signals are intentionally numeric (not CSS variables) because Lasers is
// canvas-rendered: the existing draw loop just reads numbers off RunState.
//
// CORS note: the Audius stream redirect chain serves
// `access-control-allow-origin: *` at every hop (verified), so a crossOrigin
// "anonymous" media element yields real analyser data instead of zeros.

import { MUSIC_SPECTRUM_BINS } from '../game/runState'
import type { MusicSignals } from '../game/runState'

const AUDIUS_APP_NAME = 'lasers'
const AUDIUS_API_BASE = 'https://discoveryprovider.audius.co/v1'

// Soundtrack: the "All Things Bass" editorial playlist, played shuffled — a
// random track on fresh load, then a new random track after each one finishes.
// https://audius.co/Audius/playlist/all-things-bass  (encoded id below)
const AUDIUS_PLAYLIST_ID = 'ozkbOY2'

// Fallback if the playlist can't be fetched: "Andrea Bedoya - To Release".
// Resolved from https://audius.co/yabedoyag/andrea-bedoya-to-release-
export const DEFAULT_TRACK_ID = 'NlE37'

const streamUrl = (trackId: string) =>
  `${AUDIUS_API_BASE}/tracks/${trackId}/stream?app_name=${AUDIUS_APP_NAME}`

const playlistTracksUrl = (playlistId: string) =>
  `${AUDIUS_API_BASE}/playlists/${playlistId}/tracks?app_name=${AUDIUS_APP_NAME}`

type EngineSignals = Omit<MusicSignals, 'intensity'>

const ZERO_SIGNALS: EngineSignals = {
  playing: false,
  bass: 0,
  mid: 0,
  treble: 0,
  energy: 0,
  pulse: 0,
  onset: 0,
  beat: 0,
  beatToken: 0,
  hue: 0,
  spectrum: new Array(MUSIC_SPECTRUM_BINS).fill(0),
}

const MIN_DYNAMIC_RANGE = 14
const SILENCE_EPSILON = 1

class MusicEngine {
  private audio: HTMLAudioElement | null = null
  private ctx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: MediaElementAudioSourceNode | null = null
  private freq: Uint8Array<ArrayBuffer> | null = null

  private trackId = DEFAULT_TRACK_ID

  // Shuffled-playlist state. The track ids are fetched once; `shuffleOrder` is a
  // shuffled permutation we walk with `shuffleIdx`. When we run off the end we
  // reshuffle and start over, so the whole playlist loops with a fresh shuffle.
  // `pickedInitial` guards so we only choose the starting track on first play.
  private playlistIds: string[] = []
  private shuffleOrder: string[] = []
  private shuffleIdx = 0
  private pickedInitial = false

  // Stream failover state. The Audius discovery provider load-balances the
  // /stream endpoint across community content nodes, some of which are
  // intermittently unhealthy (bad CORS / SSL / 5xx). We resolve the concrete
  // content-node URL ourselves and, on any media error, re-resolve (which
  // routes to a different node) and retry with backoff so playback is reliable.
  private loadAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private loadToken = 0
  private listenersBound = false

  // Adaptive normalization + envelope state.
  private floor = 0
  private peak = 64
  private bassEnv = 0
  private midEnv = 0
  private trebleEnv = 0
  private onsetEnv = 0
  private pulseEnv = 0
  private lastBeatAt = 0
  private lastSampleAt = 0

  // Continuous rainbow hue accumulator (0..360) and smoothed spectrum bins.
  private hue = 0
  private readonly spectrum = new Array(MUSIC_SPECTRUM_BINS).fill(0)

  private readonly signals: EngineSignals = {
    ...ZERO_SIGNALS,
    spectrum: new Array(MUSIC_SPECTRUM_BINS).fill(0),
  }

  // Whether the user wants music on. Defaults ON (cubekill's tap-to-resume
  // model): the soundtrack is "wanted" from load, but browser autoplay policy
  // keeps the AudioContext suspended until a gesture. The global gesture
  // listener in App.tsx resumes/starts it on the player's first interaction
  // (the same drag that steers the beam), so audio begins without a dedicated
  // "press play" step. The toggle button still mutes/unmutes from there.
  private wantPlaying = true

  // Attach the DOM <audio> element (rendered by React). Matching CubeKill, the
  // element lives in the document — detached `new Audio()` elements can fail to
  // load cross-origin media in some Chromium builds.
  attach(el: HTMLAudioElement) {
    if (this.audio === el) return
    this.audio = el
    el.crossOrigin = 'anonymous'
    // No single-track loop: we advance to a new random playlist track when one
    // finishes (see onAudioEnded).
    el.loop = false
    if (!this.listenersBound) {
      this.listenersBound = true
      // A healthy load: clear the failover counter so a later glitch starts
      // its own fresh backoff.
      el.addEventListener('playing', this.onAudioHealthy)
      el.addEventListener('canplay', this.onAudioHealthy)
      // A node served a bad/blocked stream: route around it.
      el.addEventListener('error', this.onAudioError)
      // Mid-playback drop: the connection stalled. Re-resolve to a new node.
      el.addEventListener('stalled', this.onAudioStalled)
      // Track finished: shuffle onward to a new random track.
      el.addEventListener('ended', this.onAudioEnded)
    }
  }

  private onAudioHealthy = () => {
    this.loadAttempt = 0
  }

  private onAudioError = () => {
    if (!this.wantPlaying) return
    this.scheduleRetry()
  }

  private onAudioStalled = () => {
    const audio = this.audio
    // Only treat as a failure if we genuinely have nothing buffered to play.
    if (!this.wantPlaying || !audio) return
    if (audio.readyState >= 3) return
    this.scheduleRetry()
  }

  private onAudioEnded = () => {
    if (!this.wantPlaying) return
    void this.advanceTrack()
  }

  // Fetch the playlist's track ids once. On first success, also choose the
  // random starting track. Safe to call repeatedly; it no-ops once loaded and
  // retries (on a later play/track-end) if a previous fetch failed.
  private async ensurePlaylist(): Promise<void> {
    if (this.playlistIds.length === 0) {
      try {
        const bust = Date.now().toString(36)
        const res = await fetch(`${playlistTracksUrl(AUDIUS_PLAYLIST_ID)}&_=${bust}`, { mode: 'cors' })
        if (res.ok) {
          const json = (await res.json()) as { data?: Array<{ id?: unknown }> }
          const ids = Array.isArray(json.data)
            ? json.data
                .map((t) => (typeof t?.id === 'string' ? t.id : null))
                .filter((x): x is string => !!x)
            : []
          if (ids.length > 0) this.playlistIds = ids
        }
      } catch {
        // Keep the DEFAULT_TRACK_ID fallback; we'll retry later.
      }
    }
    if (!this.pickedInitial && this.playlistIds.length > 0) {
      this.reshuffle()
      this.shuffleIdx = 0
      this.trackId = this.shuffleOrder[0]!
      this.pickedInitial = true
    }
  }

  // Build a fresh shuffled order (Fisher–Yates). When there's a current track,
  // avoid putting it first so a reshuffle never plays the same song twice in a
  // row across the loop boundary.
  private reshuffle(): void {
    const order = [...this.playlistIds]
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    if (order.length > 1 && order[0] === this.trackId) {
      ;[order[0], order[1]] = [order[1]!, order[0]!]
    }
    this.shuffleOrder = order
  }

  private async advanceTrack(): Promise<void> {
    await this.ensurePlaylist()
    if (this.shuffleOrder.length > 0) {
      this.shuffleIdx += 1
      // Off the end of the shuffle → loop the playlist with a new shuffle.
      if (this.shuffleIdx >= this.shuffleOrder.length) {
        this.reshuffle()
        this.shuffleIdx = 0
      }
      this.trackId = this.shuffleOrder[this.shuffleIdx]!
    }
    // With an empty playlist this simply replays the current fallback track.
    void this.loadAndPlay()
  }

  private scheduleRetry() {
    if (this.retryTimer != null) return
    // Backoff grows with consecutive failures but is capped so a node that dies
    // mid-session reconnects quickly.
    const delay = Math.min(2500, 250 * (this.loadAttempt + 1))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.wantPlaying) return
      void this.loadAndPlay()
    }, delay)
  }

  setTrack(id: string) {
    if (id === this.trackId) return
    this.trackId = id
    if (this.audio && this.wantPlaying) {
      this.loadAndPlay()
    }
  }

  setWantPlaying(on: boolean) {
    this.wantPlaying = on
    if (!on) {
      if (this.retryTimer != null) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      this.audio?.pause()
      return
    }
    // Resume / (re)start inside whatever gesture toggled this on.
    void this.start()
  }

  isWantPlaying() {
    return this.wantPlaying
  }

  // Must be called from inside a user gesture the first time (autoplay).
  // Idempotent: safe to call on every gesture.
  async start() {
    if (typeof window === 'undefined') return
    if (!this.wantPlaying) return
    this.ensureGraph()
    const ctx = this.ctx
    if (ctx && ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        // Ignore; next gesture retries.
      }
    }
    const audio = this.audio
    if (!audio) return
    // No source yet, or the current source errored out: pick the (random)
    // playlist track and resolve a node. ensurePlaylist sets the starting track
    // on first play; on later resumes it's a no-op so we keep the same song.
    if (!audio.src || audio.error) {
      await this.ensurePlaylist()
      // Bail if music was turned off or the element changed while we fetched.
      if (this.audio !== audio || !this.wantPlaying) return
      void this.loadAndPlay()
      return
    }
    if (audio.paused) {
      try {
        await audio.play()
      } catch {
        // Blocked outside a gesture; retried on the next one.
      }
    }
  }

  private ensureGraph() {
    const audio = this.audio
    if (!audio) return
    if (this.ctx) return

    const Ctor =
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext
    if (!Ctor) return
    try {
      const ctx = new Ctor()
      const source = ctx.createMediaElementSource(audio)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      analyser.minDecibels = -85
      analyser.maxDecibels = -8
      analyser.smoothingTimeConstant = 0.58
      source.connect(analyser)
      analyser.connect(ctx.destination)
      this.ctx = ctx
      this.source = source
      this.analyser = analyser
      this.freq = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    } catch {
      // Analyser unavailable; audio (if any) still plays, signals stay zero.
    }
  }

  // Ask the discovery provider for the concrete content-node URL instead of
  // following its 302 blindly. `no_redirect=true` returns JSON `{ data: url }`,
  // and each call load-balances to a (usually different) node — so re-resolving
  // after a failure is what routes us around an unhealthy one.
  private async resolveStreamUrl(): Promise<string> {
    const bust = Date.now().toString(36)
    const url = `${streamUrl(this.trackId)}&no_redirect=true&_=${bust}`
    const res = await fetch(url, { method: 'GET', mode: 'cors' })
    if (!res.ok) throw new Error(`resolve ${res.status}`)
    const json = (await res.json()) as { data?: unknown }
    const resolved = typeof json.data === 'string' ? json.data : null
    if (!resolved) throw new Error('no stream url in response')
    return resolved
  }

  private async loadAndPlay() {
    const audio = this.audio
    if (!audio) return
    this.loadAttempt += 1
    const token = ++this.loadToken
    this.resetAnalysisState()

    let url: string
    try {
      url = await this.resolveStreamUrl()
    } catch {
      // Fall back to the redirecting endpoint (works on healthy nodes); add a
      // cache-buster so the balancer can hand us a fresh node next time.
      url = `${streamUrl(this.trackId)}&_=${Date.now().toString(36)}`
    }

    // Bail if a newer load started, the element changed, or music was turned off
    // while we were resolving.
    if (token !== this.loadToken || this.audio !== audio || !this.wantPlaying) {
      return
    }

    audio.src = url
    audio.load()
    try {
      await audio.play()
    } catch {
      // Autoplay blocked or the node errored: the 'error' handler reschedules,
      // and the next user gesture will also retry.
    }
  }

  private resetAnalysisState() {
    this.floor = 0
    this.peak = 64
    this.bassEnv = 0
    this.midEnv = 0
    this.trebleEnv = 0
    this.onsetEnv = 0
    this.pulseEnv = 0
    this.lastBeatAt = 0
  }

  private smoothBand(
    prev: number,
    target: number,
    attack: number,
    release: number,
  ): number {
    const rate = target > prev ? attack : release
    const next = prev + (target - prev) * rate
    return next < 0 ? 0 : next > 1 ? 1 : next
  }

  // Read the analyser and advance all envelopes. Call once per rendered frame
  // (even while the sim is paused, so visuals keep breathing). `nowMs` is a
  // performance.now()-style timestamp.
  sample(nowMs: number) {
    const dt =
      this.lastSampleAt > 0
        ? Math.min(0.1, (nowMs - this.lastSampleAt) / 1000)
        : 0.016
    this.lastSampleAt = nowMs

    const audio = this.audio
    const analyser = this.analyser
    const data = this.freq
    const playing = !!audio && !audio.paused && !audio.ended

    const s = this.signals
    s.playing = playing

    // Decay the beat flash regardless of playback so it never sticks on.
    s.beat = Math.max(0, s.beat - dt / 0.16)

    // Continuous rainbow drift — glides while the track plays (never flashes),
    // and freezes when music is paused/inactive. Mids/treble nudge the speed.
    if (playing) {
      const hueSpeed = 7 + this.midEnv * 26 + this.trebleEnv * 12 // deg/sec
      this.hue = (this.hue + hueSpeed * dt) % 360
    }
    s.hue = this.hue

    if (!playing || !analyser || !data) {
      // Ease everything toward rest so a pause/stop doesn't snap to black.
      const k = Math.min(1, dt * 6)
      this.pulseEnv += (0 - this.pulseEnv) * k
      this.onsetEnv += (0 - this.onsetEnv) * k
      this.bassEnv += (0 - this.bassEnv) * k
      this.midEnv += (0 - this.midEnv) * k
      this.trebleEnv += (0 - this.trebleEnv) * k
      s.bass = this.bassEnv
      s.mid = this.midEnv
      s.treble = this.trebleEnv
      s.pulse = this.pulseEnv
      s.onset = this.onsetEnv
      s.energy = 0
      for (let b = 0; b < this.spectrum.length; b++) {
        this.spectrum[b] += (0 - this.spectrum[b]) * k
        s.spectrum[b] = this.spectrum[b]
      }
      return
    }

    analyser.getByteFrequencyData(data)

    // Downsample the useful musical range into N smoothed bins for the depth
    // grid. Cheap: a handful of averages per frame.
    {
      const bins = this.spectrum.length
      const loFft = 1
      const hiFft = Math.min(data.length, 88)
      const span = hiFft - loFft
      for (let b = 0; b < bins; b++) {
        const a0 = loFft + Math.floor((b / bins) * span)
        const a1 = Math.max(a0 + 1, loFft + Math.floor(((b + 1) / bins) * span))
        let acc = 0
        for (let i = a0; i < a1; i++) acc += data[i]!
        const target = Math.min(1, acc / (a1 - a0) / 255)
        const prev = this.spectrum[b]!
        const rate = target > prev ? 0.5 : 0.2
        this.spectrum[b] = prev + (target - prev) * rate
        s.spectrum[b] = this.spectrum[b]!
      }
    }

    let sum = 0
    let bassSum = 0
    let bassCount = 0
    let midSum = 0
    let midCount = 0
    let trebleSum = 0
    let trebleCount = 0
    let weightedCount = 0
    const sampleCount = Math.min(96, data.length)
    for (let i = 1; i < sampleCount; i++) {
      const value = data[i]!
      // Bass/low-mid carry the kick/snare movement most useful for a beat-led
      // visualizer, so weight them up in the overall energy figure.
      const weight = i < 8 ? 1.6 : i < 24 ? 1.15 : 0.65
      if (i < 10) {
        bassSum += value * value
        bassCount += 1
      } else if (i < 42) {
        midSum += value
        midCount += 1
      } else {
        trebleSum += value * value
        trebleCount += 1
      }
      if (i < 48) {
        sum += value * weight
        weightedCount += weight
      }
    }

    const weightedEnergy = sum / Math.max(1, weightedCount)
    const bassEnergy = Math.sqrt(bassSum / Math.max(1, bassCount))
    const midEnergy = midSum / Math.max(1, midCount)
    const trebleEnergy = Math.sqrt(trebleSum / Math.max(1, trebleCount))

    this.bassEnv = this.smoothBand(this.bassEnv, Math.min(1, bassEnergy / 255), 0.34, 0.09)
    this.midEnv = this.smoothBand(this.midEnv, Math.min(1, midEnergy / 205), 0.22, 0.055)
    this.trebleEnv = this.smoothBand(this.trebleEnv, Math.min(1, trebleEnergy / 190), 0.42, 0.18)
    s.bass = this.bassEnv
    s.mid = this.midEnv
    s.treble = this.trebleEnv

    const energy = weightedEnergy * 0.55 + bassEnergy * 0.45
    s.energy = Math.min(1, energy / 255)

    if (energy > SILENCE_EPSILON) {
      if (this.floor === 0 && this.peak === 64) {
        this.floor = Math.max(0, energy * 0.84)
        this.peak = Math.max(energy * 1.28, this.floor + MIN_DYNAMIC_RANGE)
      } else {
        const floorRate = energy < this.floor ? 0.14 : 0.018
        const peakRate = energy > this.peak ? 0.12 : 0.012
        this.floor += (energy - this.floor) * floorRate
        this.peak += (energy - this.peak) * peakRate
      }
      if (this.peak - this.floor < MIN_DYNAMIC_RANGE) {
        this.peak = this.floor + MIN_DYNAMIC_RANGE
      }
      const range = this.peak - this.floor
      const normalized = Math.max(0, Math.min(1, (energy - this.floor) / range))

      const prevPulse = this.pulseEnv
      const motion = Math.max(0, (normalized - 0.24) / 0.76)
      const curvedMotion = Math.pow(motion, 1.8)
      const onsetRaw = Math.max(0, motion - prevPulse)
      this.onsetEnv = this.smoothBand(this.onsetEnv, Math.min(1, onsetRaw * 2.4), 0.65, 0.12)
      s.onset = this.onsetEnv

      const targetPulse = Math.min(1, curvedMotion * 0.58 + onsetRaw * 1.2)
      const envelopeRate = targetPulse > prevPulse ? 0.46 : 0.16
      this.pulseEnv += (targetPulse - prevPulse) * envelopeRate
      s.pulse = Math.max(0, Math.min(1, this.pulseEnv))

      // Beat: onset spike past a threshold with a refractory window.
      if (this.onsetEnv > 0.42 && nowMs - this.lastBeatAt > 220) {
        this.lastBeatAt = nowMs
        s.beat = 1
        s.beatToken = (s.beatToken + 1) % 1_000_000
      }
    } else {
      this.pulseEnv *= 0.9
      this.onsetEnv *= 0.86
      s.pulse = this.pulseEnv
      s.onset = this.onsetEnv
    }
  }

  debug() {
    const a = this.audio
    let maxBin = 0
    if (this.analyser && this.freq) {
      this.analyser.getByteFrequencyData(this.freq)
      for (let i = 0; i < this.freq.length; i++) if (this.freq[i]! > maxBin) maxBin = this.freq[i]!
    }
    return {
      ctxState: this.ctx?.state ?? 'none',
      hasAnalyser: !!this.analyser,
      audioPaused: a?.paused ?? null,
      audioEnded: a?.ended ?? null,
      readyState: a?.readyState ?? null,
      networkState: a?.networkState ?? null,
      currentTime: a ? +a.currentTime.toFixed(2) : null,
      src: a?.src?.slice(0, 60) ?? null,
      maxBin,
    }
  }

  // Copy live signals onto the RunState's music object, preserving the
  // user-controlled `intensity` field.
  applyTo(target: MusicSignals) {
    target.playing = this.signals.playing
    target.bass = this.signals.bass
    target.mid = this.signals.mid
    target.treble = this.signals.treble
    target.energy = this.signals.energy
    target.pulse = this.signals.pulse
    target.onset = this.signals.onset
    target.beat = this.signals.beat
    target.beatToken = this.signals.beatToken
    target.hue = this.signals.hue
    const src = this.signals.spectrum
    const dst = target.spectrum
    for (let i = 0; i < dst.length && i < src.length; i++) dst[i] = src[i]!
  }
}

export const musicEngine = new MusicEngine()

if (import.meta.env.DEV && typeof window !== 'undefined') {
  ;(window as unknown as { __musicEngine?: MusicEngine }).__musicEngine = musicEngine
}
