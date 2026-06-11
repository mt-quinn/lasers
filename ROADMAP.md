# laserburn — Audit & Roadmap to World-Class

*June 2026. Based on a full read of the codebase (sim, renderer, audio, FTUE, Convex backend). Weighted toward game feel and retention, per Quinn.*

## Where the game stands

The hard part is done. The core design is unusually coherent for a vibe-coded project: one control surface (the gravity-well puck), fixed player power with flat per-cell HP so difficulty is always answerable by skill, a daily-seeded deterministic board that makes scores comparable, and an Overdrive economy where the core verb (vacuuming motes) always pays. The renderer is genuinely impressive — correct perspective homography shared across 2D and WebGL paths, extruded 3D pieces, a real thin-lens gravitational lens, adaptive resolution. The FTUE (action-gated warmup plus just-in-time coachmarks) is better than most shipped mobile games. Autosave, score-commit guards, and the upsert-only leaderboard are all thoughtfully defended against refresh exploits.

What separates it from world-class is not the design — it's the surrounding 20%: audio is one sound effect, there is zero shareability or installability, nothing measures whether players return, the leaderboard trusts the client completely, and the codebase has no tests guarding its most load-bearing property (daily determinism).

## P0 — Game feel (the biggest play-experience gap)

**Audio is the single largest feel deficit.** The entire SFX palette is one file: `pop.wav` on piece death (`sfx.ts` plays nothing else; `public/quench.wav` is shipped but never referenced). Meanwhile the game has at least a dozen moments begging for distinct sound: overdrive becoming armed (currently only "TAP TO FIRE" text), firing overdrive, the surge ending, mote capture ticks (a rising-pitch series as a batch streams in would make vacuuming delicious), combo milestones and combo loss, armored deflection (currently cold sparks only), mirror burn-through, chrome reflect, shatter fragmenting, gold kill, fail-line danger warning, the descent step itself (a soft metronome tick would make the grace-step rule legible), and game over. The existing engine (polyphonic, limited, pitch-jittered) is good — it just needs a palette. Recommendation: design ~12 sounds as a coherent family, route them through the existing bus, and pitch mote-capture ticks up with the current combo.

**No screenshake or hit-stop.** The Vlambeer screenshake talk is literally in the reference docs, but `draw.ts` contains no camera impulse of any kind. Kills, overdrive firing, and game over all deserve a small, decaying camera offset (projection makes this cheap: offset the canvas transform pre-frame). A 30–60 ms hit-stop on multi-kills would let big plays land. Keep it subtle — the game's readability is a strength.

**Combo legibility.** The combo window is 4 s, but the HUD only shows the `×N` multiplier with a fade in the final 0.5 s (`draw.ts` ~2372). Players can't manage what they can't see: add a draining ring or underline on the multiplier showing the full window, so keeping a chain alive becomes a conscious skill.

**Tension communication near the fail line.** The grace-step rule (one extra descent step to clear a block past the line) is generous but invisible — a player who survives it doesn't know they almost died, and one who dies may feel robbed. When `failGraceDepth` is armed, the offending block and fail line should flash a clear countdown state, with audio.

**Balance notes worth a tuning pass** (play-test, don't trust me blindly): the idle heat bleed (`HEAT_IDLE_BLEED = 0.08` only when combo = 0) is so mild it may as well not exist — either make it meaningful or delete it. Chrome blocks are deliberately untaught (`tutorial.ts` comment) yet they reflect the beam confusingly; either teach them or make their first reflection visually unmistakable. `xpValue` still multiplies both heat and score for gold (×5+) — fine, but `goldXpBonus` ratchets up per gold killed within a run with no cap, which quietly inflates late-run gold value; verify that's intended.

**Performance follow-ups.** The adaptive-resolution governor is good. The known hot spots are `buildPrimsForBlock` rebuilding collision primitives per raycast per frame (memoize per block per frame — positions only translate), and the thick-beam 3-ray cast multiplying that cost. Worth profiling on a low-end Android before adding any more FX.

## P0 — Retention & distribution

**The HTML shell is bare.** `index.html` has no favicon, no meta description, no Open Graph/Twitter tags, no theme-color, no manifest. Anyone pasting laserburn.fun into a chat gets a blank unfurl. This is an afternoon of work with outsized payoff: title/description/OG image, favicon + apple-touch-icon, `theme-color` matching the void palette.

**PWA installability.** Add a manifest and a minimal service worker (cache the app shell; the game already works offline except music/leaderboard, which degrade gracefully). "Add to Home Screen" is the closest thing a web game has to an app-store install, and the daily-run structure is exactly the loop home-screen icons feed.

**Share your score.** After game over, render a share card on canvas (score, depth, date, a beam-and-blocks motif riding the day's palette) and wire `navigator.share` with file support, falling back to clipboard. Daily games live or die on this loop — it's the single highest-leverage retention/acquisition feature available. A Wordle-style emoji grid is also possible: e.g. score, depth, and best combo as compact glyph rows.

**Close the daily loop on the game-over screen.** The replay tip explains the daily concept once, but the screen never tells you when the next board arrives. Add a "next board in HH:MM" countdown and a local streak counter (consecutive days played — trivially derivable from the existing `dateKey`-stamped local scores). Streaks plus countdown turn "play again" into "come back tomorrow."

**Leaderboard trust.** Scores are client-computed and submitted raw; a curl one-liner tops the global daily board. Full server validation is overkill, but cheap sanity goes far: server-side caps on score-per-depth and score-per-elapsed-time (the deterministic schedule makes plausible bounds computable), reject obviously impossible rows, and rate-limit per playerId. Longer term, submitting a compact input replay (well positions over time) would allow spot re-simulation — the sim is already deterministic per day, which is most of the work.

**Measurement.** There is no analytics and no error tracking. Add a privacy-light event pipeline (a tiny Convex table or PostHog): run started/ended, depth/score/duration, tutorial completion and skip beat, overdrive fires per run, music on/off, share taps, D1/D7 return (playerId already exists). Add Sentry (or even a Convex-logged `window.onerror`) so broken phones stop being invisible. Every later tuning decision should be informed by this.

## P1 — Product polish

A proper landing/start moment: currently the game boots straight into play (or the warmup). A minimal title beat — logo, "today's board," streak, play button — would frame the daily ritual and give the music a gesture to start from, fixing the iOS tap-to-resume prompt appearing mid-game. Desktop deserves first-class input (the well following the mouse without click-hold, or WASD nudges) since itch/web portals are a real discovery channel for this genre. The name prompt should be asked once up front (or default to the saved name) rather than only after a qualifying run, so the global board isn't full of "PLAYER". Settings are scattered (music in a popover, no SFX volume, no haptics toggle, no reduced-motion option) and deserve one small panel.

## P1 — Engineering hardening (the items that protect the above)

**Test the determinism contract.** The product promise is "same board for everyone, every day." One Vitest suite locking `spawnRng`/`hashDateKey`/`spawnBoardThing` output for a fixed seed, plus a headless `stepSim` smoke run (fixed dt, scripted well positions, assert no NaNs and stable score), would catch the exact class of regression most likely to slip in during feel-tuning. CI is just `tsc && eslint && vitest` on push.

**Split `draw.ts` (3,877 lines) into render passes** — background/grid, pieces+FX, beam+emitter, HUD, lens — behind a stable per-frame context object. Do this *before* the feel work above, or every juice change makes the monolith worse. Similarly `App.tsx` (1,830 lines) wants its input handling, music UI, and game-over screen extracted.

**Delete dead weight:** the commented-out upgrade overlay in App.tsx, the stubbed upgrade system in `levelUp.ts` (and vestigial `xp/level/pendingLevelUps/levelUpOptions` fields in RunState and the save schema), the `meltFx`/XP-orb path the mote system superseded (nothing pushes to `meltFx` anymore, so the orb spawn inside it — the only `xpOrbs.push` in the codebase — is unreachable), the never-spawned `blackHole` feature type, the unused `quench.wav`, and the stale `client/dist` build output sitting untracked in the working tree. Less code makes every later change safer.

## Suggested sequencing

First (1–2 weeks): meta tags + favicon + OG + share card, analytics + error tracking, determinism tests + CI, dead-code purge. These are independent, low-risk, and everything later benefits.
Second (2–3 weeks): SFX palette + screenshake/hit-stop + combo timer + fail-grace telegraphing, with the draw.ts pass-split done as the opening move.
Third: PWA + streak/countdown + landing moment + leaderboard sanity caps.
Then: tune from the analytics — pace knob (`GAME_PACE_SCALE`), tutorial drop-off, overdrive usage — and revisit desktop input and accessibility (reduced motion, color-independent piece signaling).

## Things deliberately *not* recommended

Don't add meta-progression/upgrades back — fixed power is the design's spine and the daily board depends on it. Don't move rendering to a framework; the bespoke renderer is a differentiator. Don't gate music behind accounts or replace Audius until licensing actually becomes a problem.
