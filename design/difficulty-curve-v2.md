# Big Lasers — Difficulty Curve (v2, XP + Step Drop)

This document defines an **implementable, “human-playable” difficulty curve** for *Big Lasers* (Breakout-ish aim skill + Tetris-like step drop). It’s designed to:

- Keep the player in a **flow** state: challenged, rarely overwhelmed.
- **Force engagement with upgrades**: base stats will not keep up indefinitely.
- Avoid unwinnable states via **pressure guardrails** (a light “director”).

## Core tuning philosophy

### 1) Difficulty is *pressure*, not raw numbers
In this game, the player loses when **unmanaged board pressure** reaches the fail line. Pressure increases through:
- More blocks on screen (target density)
- Faster spawning (arrival rate)
- Higher HP (work per block)
- Faster drop cadence (time budget)

We tune difficulty by controlling **arrival rate** and **work per block**, while keeping drop cadence mostly stable (and only changed through upgrades).

### 2) The board must not enter “runaway” states
Step-drop systems can snowball: if blocks accumulate, they reduce aim options, which reduces kill rate, which increases accumulation.

So we add **guardrails**:
- If blocks are within ~2 steps of failing, **spawns pause/slow** until the player recovers.
- Max concurrent blocks ramps, but remains bounded.

This is similar in spirit to “director” pacing systems: we preserve tension without forcing unwinnable spirals.

### 3) Upgrades: quick early, slower later (but still meaningful)
XP caps must grow with player power and density, or upgrades arrive at a flat cadence that can feel disconnected from difficulty.

**Targets**
- 0–60s: upgrade every **~10–18s**
- 60–240s: upgrade every **~18–35s**
- 240s+: upgrade every **~30–60s** (execution matters; bounces matter)

## Current implementable levers (in code)

- **Spawn cadence**: `spawnEvery(time)` with pressure multiplier.
- **Concurrent cap**: `maxBlocks(time)` with pressure reduction.
- **HP curve**: in `spawnBlock()`.
- **Drop cadence**: `dropIntervalSec` (base constant; “Drop Speed” upgrade slows).
- **XP cap**: `xpCap(level)` grows with level.

## The v2 curve (what we’re implementing)

### A) Spawn cadence (time curve)
Two-phase smooth ramp:

- 0–60s: `spawnEvery` from **2.35s → 1.65s**
- 60–360s: `spawnEvery` from **1.55s → 0.95s**

### B) Concurrent cap (time curve)
- 0–60s: **4 → 6**
- 60–360s: **6 → 11**

### C) Pressure guardrails (“director”)
Define a danger band:
- `dangerY = failY - 2 * cellSize`

Compute:
- `dangerCount = number of blocks with bottom >= dangerY`
- `pressure01 = clamp(dangerCount / 3, 0..1)`

Effects:
- `spawnEvery *= (1 + 0.85 * pressure01)`
- `maxBlocks -= floor(2 * pressure01)`
- If `dangerCount > 0`, **pause spawning** (but keep checking so spawns resume quickly once recovered).

Intent: the player can fall behind briefly, but the game gives a recoverable window rather than snowballing.

### D) XP cap growth (level curve)
Use exponential growth with a gentle slope:

`xpCap(level) = round(10 * 1.18^level)`, clamped to `[10, 220]`.

This makes upgrades frequent at the start, and naturally slower later without hard-coded time gates.

### E) “Breather” after level-up
After picking an upgrade (game unpauses), enforce:
- `spawnTimer = max(spawnTimer, 0.75)`

This prevents immediate re-spawns into a newly-paused pressure state and makes the level-up moment feel like a relief valve.

## What we will measure next (to polish it)

Once you’ve played a few runs, the curve can be dialed in fast by checking:
- Average **time-to-first-fail** for new players (target: 2–5 minutes)
- Upgrades per minute over time
- Average blocks on screen
- Time spent with blocks in the danger band

If needed, we can add a tiny adaptive term (“help the player recover”) by slightly reducing `xpCap` when pressure is high, but v2 starts without that.


