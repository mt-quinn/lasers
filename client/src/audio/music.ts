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
// The signals are intentionally numeric (not CSS variables) because laserburn is
// canvas-rendered: the existing draw loop just reads numbers off RunState.
//
// CORS note: the Audius stream redirect chain serves
// `access-control-allow-origin: *` at every hop (verified), so a crossOrigin
// "anonymous" media element yields real analyser data instead of zeros.

import { MUSIC_SPECTRUM_BINS } from '../game/runState'
import type { MusicSignals } from '../game/runState'

const AUDIUS_APP_NAME = 'laserburn'
const AUDIUS_API_BASE = 'https://discoveryprovider.audius.co/v1'

// Persisted music on/off preference. Survives refreshes so the player's last
// choice sticks; a fresh browser (no key yet) defaults to "wanted".
const MUSIC_WANT_KEY = 'laserburn.music.wantPlaying'

const readWantPlaying = (): boolean => {
  try {
    const v = localStorage.getItem(MUSIC_WANT_KEY)
    return v === null ? true : v === '1'
  } catch {
    return true
  }
}

const writeWantPlaying = (on: boolean): void => {
  try {
    localStorage.setItem(MUSIC_WANT_KEY, on ? '1' : '0')
  } catch {
    // Ignore storage failures (private mode, quota); state stays in-memory.
  }
}

// Tempo-matched soundtrack. Instead of a fixed playlist, each track is chosen to
// match the board's current drop rate: the field steps on a deterministic
// metronome (the sim's dropIntervalSec) and we pick a song whose BPM is a clean
// power-of-two multiple of that step rate. The music is therefore *tied to* the
// board's movement without ever *driving* difficulty — the descent schedule is
// fixed and identical every run. See targetBpmFromTempo() for the octave-folding
// that keeps the BPM rhythmically locked to the board.
const AUDIUS_GENRE = 'Electronic'

// One-octave search window. Folding the board's steps-per-minute into [LO, HI]
// (a 2x span) by halving/doubling guarantees the picked BPM is always an exact
// power-of-two relation to the steps, and lands in a range the catalog actually
// has tracks for across the entire difficulty ramp.
const BPM_WINDOW_LO = 85
const BPM_WINDOW_HI = 170

// Resilient fallback when a tempo search yields nothing playable (offline, etc.)
// so music never goes silent: "Andrea Bedoya - To Release".
// Resolved from https://audius.co/yabedoyag/andrea-bedoya-to-release-
export const DEFAULT_TRACK_ID = 'NlE37'

const streamUrl = (trackId: string) =>
  `${AUDIUS_API_BASE}/tracks/${trackId}/stream?app_name=${AUDIUS_APP_NAME}`

// Full search exposes the BPM/genre filters plus each track's bpm and
// streamability flags. We omit `query` (filter-only) and sort by popularity so
// the soundtrack skews toward recognizable, well-produced tracks.
const trackSearchUrl = (bpmMin: number, bpmMax: number) =>
  `${AUDIUS_API_BASE}/full/tracks/search?app_name=${AUDIUS_APP_NAME}` +
  `&genre=${encodeURIComponent(AUDIUS_GENRE)}` +
  `&bpm_min=${bpmMin}&bpm_max=${bpmMax}` +
  `&sort_method=popular&limit=50`

// Minimal shape of an Audius track object from the full search endpoint.
interface AudiusTrack {
  id?: string
  bpm?: number
  duration?: number
  genre?: string
  is_streamable?: boolean
  is_available?: boolean
  is_delete?: boolean
  is_stream_gated?: boolean
  title?: string
}

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

  // Tempo-matched selection state. `boardDropIntervalSec` is fed every frame
  // from the sim (App.tsx) so each pick reflects the *current* drop rate.
  // `recentTrackIds` prevents repeating songs back-to-back, `picking` guards
  // against overlapping async picks, and `currentBpm` is the BPM of the playing
  // track (debug / telemetry).
  private boardDropIntervalSec = 0.9
  private recentTrackIds: string[] = []
  private picking = false
  private currentBpm = 0

  // Stream failover state. The Audius discovery provider load-balances the
  // /stream endpoint across community content nodes, some of which are
  // intermittently unhealthy (bad CORS / SSL / 5xx). We resolve the concrete
  // content-node URL ourselves and, on any media error, re-resolve (which
  // routes to a different node) and retry with backoff so playback is reliable.
  private loadAttempt = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private loadToken = 0
  private listenersBound = false
  // True while a track is being (re)loaded — including the gap between one track
  // ending and the next starting. The element is transiently paused/ended then,
  // but it resolves itself without a gesture, so the "tap to resume" prompt must
  // stay hidden during this window.
  private loadPending = false

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
  // Persisted across refreshes: once the player has chosen on/off it sticks.
  // Defaults to "wanted" on a fresh browser (no stored preference yet).
  private wantPlaying = readWantPlaying()

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
    this.loadPending = false
    this.notifyNeedsUnlock()
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
    // Mark the transition immediately so the per-frame unlock check doesn't catch
    // the element in its brief ended/paused state and pop the resume prompt.
    this.loadPending = true
    this.notifyNeedsUnlock()
    void this.pickAndPlayNext()
  }

  // Tell the engine the board's current step interval (seconds/row). Cheap —
  // called every frame from the game loop — and read at the next track pick to
  // choose a BPM that matches how fast the field is descending right now.
  setBoardTempo(dropIntervalSec: number) {
    if (Number.isFinite(dropIntervalSec) && dropIntervalSec > 0) {
      this.boardDropIntervalSec = dropIntervalSec
    }
  }

  getCurrentBpm() {
    return this.currentBpm
  }

  // Fold the board's steps-per-minute into the one-octave window by halving /
  // doubling. The result is always a clean power-of-two relation to the step
  // rate (the beat lands on every step, every other step, two steps per beat,
  // …) so the track stays locked to the board anywhere on the ramp.
  private targetBpmFromTempo(): number {
    const interval = Math.min(3, Math.max(0.15, this.boardDropIntervalSec))
    let bpm = 60 / interval
    while (bpm >= BPM_WINDOW_HI) bpm /= 2
    while (bpm < BPM_WINDOW_LO) bpm *= 2
    return bpm
  }

  private static isPlayable(t: AudiusTrack): boolean {
    return (
      typeof t.id === 'string' &&
      t.is_streamable !== false &&
      t.is_available !== false &&
      t.is_delete !== true &&
      t.is_stream_gated !== true &&
      typeof t.duration === 'number' &&
      t.duration >= 45 &&
      t.duration <= 900
    )
  }

  private async searchTracks(bpmMin: number, bpmMax: number): Promise<AudiusTrack[]> {
    const bust = Date.now().toString(36)
    const res = await fetch(`${trackSearchUrl(bpmMin, bpmMax)}&_=${bust}`, { mode: 'cors' })
    if (!res.ok) return []
    const json = (await res.json()) as { data?: AudiusTrack[] }
    return Array.isArray(json.data) ? json.data : []
  }

  // Find playable tracks near `centerBpm`, widening the ± band until we have a
  // healthy pool (the "ranges to make sure we find something"). Keeps the
  // largest pool found across the attempted widths.
  private async poolForBpm(centerBpm: number): Promise<AudiusTrack[]> {
    let best: AudiusTrack[] = []
    for (const band of [6, 14, 28]) {
      const lo = Math.max(40, Math.round(centerBpm - band))
      const hi = Math.round(centerBpm + band)
      let playable: AudiusTrack[]
      try {
        playable = (await this.searchTracks(lo, hi)).filter(MusicEngine.isPlayable)
      } catch {
        playable = []
      }
      if (playable.length > best.length) best = playable
      if (best.length >= 6) break
    }
    return best
  }

  // Choose the next track to match the board's current tempo. Leaves trackId
  // unchanged (keeping the resilient fallback) if the network or catalog yields
  // nothing playable, so music never goes silent.
  private async pickTrackForTempo(): Promise<void> {
    if (this.picking) return
    this.picking = true
    try {
      const pool = await this.poolForBpm(this.targetBpmFromTempo())
      if (pool.length === 0) return
      const fresh = pool.filter((t) => !this.recentTrackIds.includes(t.id!))
      const choices = fresh.length > 0 ? fresh : pool
      const pick = choices[Math.floor(Math.random() * choices.length)]!
      this.trackId = pick.id!
      this.currentBpm = typeof pick.bpm === 'number' ? pick.bpm : 0
      this.recentTrackIds.push(pick.id!)
      if (this.recentTrackIds.length > 8) this.recentTrackIds.shift()
    } finally {
      this.picking = false
    }
  }

  private async pickAndPlayNext(): Promise<void> {
    await this.pickTrackForTempo()
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
    writeWantPlaying(on)
    if (!on) {
      if (this.retryTimer != null) {
        clearTimeout(this.retryTimer)
        this.retryTimer = null
      }
      // Invalidate any in-flight load/resume so their async continuations can't
      // call play() *after* this pause and silently restart the track.
      this.loadToken++
      this.audio?.pause()
      this.notifyNeedsUnlock()
      return
    }
    // Resume / (re)start inside whatever gesture toggled this on.
    void this.start()
    this.notifyNeedsUnlock()
  }

  isWantPlaying() {
    return this.wantPlaying
  }

  // ---- "Audio needs unlock" subscription --------------------------------
  //
  // On mobile (iOS Safari especially) the player's first interaction is a
  // tap-and-drag to steer the beam, and WebKit refuses to resume an
  // AudioContext from inside a drag gesture. So even though we *want* music
  // playing, it can stay silent until the player does a plain tap somewhere.
  // The UI subscribes to this and shows a "Tap to resume" prompt (whose click
  // IS a valid activation gesture) whenever audio is wanted but not running.
  private needsUnlockListeners = new Set<(v: boolean) => void>()
  private lastNeedsUnlock: boolean | null = null

  private computeNeedsUnlock(): boolean {
    if (!this.wantPlaying) return false
    const ctx = this.ctx
    // No graph yet, or the context isn't actually running → needs a gesture.
    if (!ctx || ctx.state !== 'running') return true
    const audio = this.audio
    if (!audio) return true
    // Mid-transition (track change / (re)load): the element is transiently
    // paused/ended but will resume on its own, so don't surface the prompt.
    if (this.loadPending) return false
    return audio.paused || audio.ended || !!audio.error
  }

  private notifyNeedsUnlock() {
    const v = this.computeNeedsUnlock()
    if (v === this.lastNeedsUnlock) return
    this.lastNeedsUnlock = v
    for (const l of this.needsUnlockListeners) {
      try {
        l(v)
      } catch {
        // A bad subscriber must not break the others.
      }
    }
  }

  getAudioNeedsUnlock(): boolean {
    return this.computeNeedsUnlock()
  }

  subscribeAudioNeedsUnlock(listener: (v: boolean) => void): () => void {
    this.needsUnlockListeners.add(listener)
    try {
      listener(this.computeNeedsUnlock())
    } catch {
      // Same guarantee as notifyNeedsUnlock().
    }
    return () => {
      this.needsUnlockListeners.delete(listener)
    }
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
    // The await above yields the event loop; the player may have toggled music
    // off (and paused) in the meantime, so re-check before doing anything.
    if (!this.wantPlaying) return
    const audio = this.audio
    if (!audio) return
    // No source yet, or the current source errored out: pick a tempo-matched
    // track and resolve a node. This only runs when we actually need a new song
    // (first play / after an error), so a plain resume keeps the current track.
    if (!audio.src || audio.error) {
      await this.pickTrackForTempo()
      // Bail if music was turned off or the element changed while we fetched.
      if (this.audio !== audio || !this.wantPlaying) return
      void this.loadAndPlay()
      return
    }
    if (audio.paused) {
      if (!this.wantPlaying) return
      try {
        await audio.play()
        // play() resolves asynchronously; if music was turned off while it
        // started, undo it so the toggle wins the race.
        if (!this.wantPlaying) audio.pause()
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
      // Surface suspended↔running transitions so the "tap to resume" prompt
      // can show/hide itself as the OS moves the context around.
      ctx.addEventListener('statechange', () => this.notifyNeedsUnlock())
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
    this.loadPending = true
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
      // If this load was superseded or music was turned off while play()
      // started, undo it so a stale load can't override a pause.
      if (token !== this.loadToken || !this.wantPlaying) audio.pause()
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

    // Cheap per-frame check so the "tap to resume" prompt tracks async audio
    // state transitions (autoplay block, iOS session loss) without wiring every
    // possible event; broadcasts only when the boolean actually flips.
    this.notifyNeedsUnlock()

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
