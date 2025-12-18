# Balance & Difficulty Analysis (v1)

This document analyzes the current prototype’s numbers (player DPS, upgrade economy, spawn rate, block HP) and proposes a baseline difficulty curve intended for real humans to play.

## Summary of key issues found (before tuning)

### 1) Spawn rate ramp was far too aggressive
The previous formula:
- `spawnEvery = clamp(0.9 - timeSec * 0.004, 0.22, 0.9)`

This reaches the minimum cap in ~170s, which implies ~4.5 spawns/second. In a single-target laser game, that overwhelms the screen long before a typical player can scale their DPS.

### 2) HP ramp was far too aggressive
The previous formula:
- `baseHp = 60 + timeSec * 6`

At 60s, `baseHp ≈ 420`. With shape multipliers, many blocks are 450–550 HP, while the default DPS was 60. That pushes time-to-kill (TTK) into ~8–10s per block even before density ramps — which is not survivable with falling hazards.

### 3) DPS upgrade had a “dead first level”
The previous DPS apply used:
- `dps = 60 + (newLevel - 1) * 14`

Meaning the first DPS purchase kept you at 60 DPS (no gain). This breaks the early economy/feel and makes the curve hard to reason about.

### 4) “Never overlap” requires consistent fall speeds (or collisions)
The old system set per-block velocity at spawn time and increased it with time. Newer blocks could fall faster than older blocks and literally catch them, creating overlaps even if spawn placement was clean.

---

## What we want (design targets)

These targets are tunable, but they’re the right “shape” for a human-playable curve:

### Player-facing pacing targets
- **Early game** (0–60s): player gets upgrades quickly and feels strong.
  - Target: 1 upgrade every ~8–15 seconds.
- **Mid game** (60–240s): upgrades still arrive, but require focus.
  - Target: 1 upgrade every ~15–30 seconds.
- **Late game** (240s+): upgrades slow, survival depends on execution (especially once bounces exist).
  - Target: 1 upgrade every ~30–60 seconds.

### Combat targets (TTK and density)
- Target per-block **TTK** (single-target beam):
  - Early: ~1.2–2.5s
  - Mid: ~2–5s (unless you’re buying DPS steadily)
  - Late: ~3–8s (reflections can reduce “effective TTK” via multi-hits)
- Keep on-screen density bounded:
  - Use a **max concurrent blocks** cap so the screen never becomes mathematically impossible.

---

## How money + DPS interact (important insight)

In this game, the player’s money generation is fundamentally:

**money/sec ≈ (blocks destroyed/sec) × (value per block)**

And blocks destroyed/sec depends on:

**blocks destroyed/sec ≈ DPS / averageHP** (in a single-target scenario)

If you set `value ≈ k × HP`, then:

**money/sec ≈ (DPS / HP) × (k × HP) = k × DPS**

That’s a powerful property: if value scales with HP, then money rate becomes roughly proportional to DPS, and the economy becomes much more stable and “self-consistent” across difficulty ramps.

That’s why v1 keeps value proportional to HP.

---

## Implemented baseline tuning (now in code)

### Difficulty ramp window
- Use a smooth ramp over the first **~6 minutes** (360s) so the game stays readable while the player learns to aim + upgrade.
- After that, difficulty stays at “max curve” (we can extend this later with waves or additional phases).

### Spawn cadence
- Smoothly lerp from **~1.1s** per block to **~0.55s** per block across the 6-minute ramp.
- Add a **maxBlocks cap** that ramps from **6 → 12** over the same window.

### Fall speed
- Smoothly lerp from **~52 px/s** to **~140 px/s** over the ramp.
- Apply it as a **global fall speed for all blocks each frame** so blocks never catch and overlap.

### HP + value
- HP now uses a gentler curve:
  - `baseHp = 110 + 1100 * difficulty^1.35`
  - then multiplied by a shape-size multiplier.
- Value remains proportional to HP:
  - `value ≈ 0.07 × hpMax`

### DPS upgrade
- Switched to a multiplicative DPS curve:
  - `dps(level) = 60 × 1.18^level`
- Costs grow with level:
  - `cost(level) = 28 × 1.28^level`

This gives the “linear power fantasy” feel in moment-to-moment play (DPS increases every purchase) while still allowing enough headroom to keep up with HP ramps.

---

## “No overlap” guarantee (spawn + runtime)

We enforce “never overlap” two ways:

1) **Spawn placement**: new blocks compute a candidate AABB and choose a spawn Y above any horizontally-overlapping blocks (plus a gap), and verify no AABB intersection before spawning.
2) **Runtime**: all blocks share the same fall speed, so nothing can catch anything else.

This avoids doing full physics/stacking while still meeting the “never overlap” requirement.

---

## Next steps for serious tuning (recommended)

The current numbers are a baseline. To tune for humans, we should instrument:
- Average blocks on screen over time
- Average per-block TTK over time
- Currency earned per minute over time
- Upgrade purchases per minute over time
- Time-to-fail distribution across players (once you test)

Implementation suggestion:
- Add a hidden “debug stats overlay” and optionally export JSON snapshots every N seconds.
- Run a few scripted play patterns (always aim at nearest, always aim center, etc.) to bound difficulty.


