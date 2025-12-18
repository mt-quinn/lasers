# Laser Game (Working Title) — Design Doc

## Goals
- **Portrait web mobile game** with high polish (UI + feedback + responsiveness).
- **One-touch control**: player drags **anywhere on screen** to control both **emitter position (slider)** and **aim direction**.
- **Always-on run**: the game is continuously “live” until failure; upgrades happen **within the run** only.
- **Power fantasy + skill**: early game feels strong; later game rewards **real-time ricochet aiming** between shapes.

## Non-goals (v1)
- No monetization.
- No between-run progression, meta unlocks, or “builds.”
- No block lateral movement or rotation (blocks fall straight down).

---

## Core Fantasy & Elevator Pitch
You control an ever-firing laser emitter mounted on a slider at the bottom of the screen. Blocks with rounded outer corners fall from the top. You melt their HP with the beam; later, you purchase ricochet upgrades and thread reflections between pieces under pressure.

---

## Primary Game Loop
### Runtime loop (continuous)
- Spawn blocks at top → blocks descend straight down.
- Player aims a continuous laser:
  - Laser raycasts into the scene.
  - The first surface hit takes damage over time.
  - If ricochets are unlocked, the beam reflects and can hit additional blocks.
- Destroy blocks → earn currency immediately.
- Spend currency in an **Upgrade Menu** (pauses the game).
- If any block crosses the **Fail Line** near the bottom → run ends and the game resets to base state.

### Run reset
On failure:
- Run stats reset (score/time/currency/in-run upgrades).
- Game immediately restarts into a fresh run.

---

## Controls (Touch Anywhere)
### Input mapping (single pointer)
The player can touch/drag **anywhere** on the screen.

On each pointer update:
- **Emitter X** tracks the pointer’s X position projected onto the slider track:
  - `emitterX = clamp(pointerX, sliderLeft, sliderRight)`
- **Aim direction** is from emitter to pointer position:
  - `aimDir = normalize(pointerPos - emitterPos)`
  - Clamp so the player cannot aim below the horizon:
    - if `aimDir.y > -minUp`, clamp to `-minUp` (design-tunable).

### Smoothing (important for mobile feel)
- Apply light temporal smoothing to aim to reduce jitter during fine ricochet shots:
  - `aimDir = normalize(lerp(prevAimDir, rawAimDir, aimSmoothing))`
- Consider separate smoothing for emitter motion vs aim:
  - Emitter smoothing small (feels responsive).
  - Aim smoothing slightly larger (feels stable).

### UI feedback for control
- Slider rail at bottom with a visible handle and emitter mount.
- Aim indicator: subtle “laser origin glow” + optional small directional chevron.

---

## Playfield Layout (Portrait)
- **Top spawn band**: off-screen or partially visible for anticipation.
- **Main arena**: majority of screen.
- **Fail Line**: a subtle horizontal line above the slider. Crossing triggers failure.
- **Bottom control rail**: emitter slider and minimal HUD.

---

## Laser System
### Beam behavior
- Beam is always firing while the run is active.
- Beam is drawn as:
  - Core line (bright) + outer glow (soft) + impact spark at hit points.
  - Optional faint “afterimage” trail for motion clarity.

### Damage model
- Blocks have numeric HP.
- When the beam intersects a block surface:
  - `hp -= DPS * dt * intensity`
- A block is destroyed when `hp <= 0`.

### Beam parameters (upgradable)
- **DPS**
- **Beam width** (visual + gameplay forgiveness)
- **Max total path length** (especially relevant once bounces exist)
- **Max bounces** (starts at 0)
- **Bounce efficiency** (damage/intensity falloff per bounce)

---

## Ricochet / Reflection Model (Skill Core)
### Starting state
- The laser starts with **0 reflections**: it stops on the first hit.

### Reflection rule
When ricochets are available:
- Raycast finds nearest hit along the current segment.
- Compute surface normal at hit point.
- Reflect direction:
  - `r = d - 2 * dot(d, n) * n`
- Continue ray from hit point with a small epsilon offset to avoid re-hitting the same surface.

### Rounded corners (design requirement)
Blocks must have rounded exterior corners so players can make skillful bank shots.
- Collision outline should support **line segments + circular arcs** (or equivalent).
- Arc collisions must return stable normals so reflections feel consistent.

### Safety constraints (avoid weird edge cases)
- **Max bounces** cap.
- **Per-bounce falloff** to prevent infinite path dominance.
- **Max total path length** per frame.
- Optional: reject extremely shallow grazing hits if they produce degenerate behavior.

### Aim preview (UX)
Optional but recommended once bounces exist:
- Draw a faint preview of the beam path up to current bounce limit.
- Preview should be subtle (not solving the game) and fade with each bounce.

---

## Blocks
### Shape language
- “Tetris-like” silhouettes as **single rounded pieces** (not grid squares).
- Curated library of shapes:
  - Simple early shapes (I, L, T-like).
  - Later shapes with concavities and longer edges to create channels.

### Movement
- Straight-down fall only (no lateral drift in v1).

### Stats
Each block:
- `hpMax`, `hp`
- `value` (currency awarded on destruction)
- `spawnTier` (for pacing)

### HP + value scaling (initial formula)
Design-tunable, but keep it simple:
- `hpMax = baseHP(tier) * sizeMultiplier(shape)`
- `value = round(hpMax * valuePerHP)`

### Readability
- HP rendered as a large number on the block.
- Add a secondary indicator: a draining rim highlight or fill bar embedded into the block.

---

## Spawning & Difficulty (Natural Puzzles)
There is no explicit “puzzle generator.” The board “forms puzzles” naturally via:
- A curated set of silhouettes,
- Spawn spacing rules that preserve readable gaps,
- Increasing density that creates real-time routing decisions.

### Spawn model (v1)
- Spawn blocks in discrete “lanes” across the width (e.g., 4–6 lanes), but allow varied widths so pieces can span multiple lanes.
- Maintain minimum horizontal spacing between spawned shapes (tunable).
- Maintain minimum vertical spacing on spawn to prevent unavoidable failures.

### Difficulty knobs
Over time:
- Increase **spawn rate**.
- Increase **fall speed**.
- Increase **average HP**.
- Introduce larger silhouettes more frequently.

### Pressure fairness rules
- Always ensure there is at least one viable response window:
  - Don’t spawn a wall that fully blocks the beam path unless fall speed/HP makes it survivable.
  - Avoid “perfect coverage” patterns too early; reserve those for late difficulty.

---

## Currency & Upgrades (In-Run Only)
### Currency
- Earned by destroying blocks.
- Displayed as a single number in HUD.
- Currency resets on run end.

### Upgrade menu behavior
- Upgrade menu can be opened any time (button in HUD).
- Opening the menu **pauses** the simulation and stops damage ticks.
- Player buys upgrades, closes menu, run resumes.

### Upgrade philosophy
- **Linear power progression** (no branching builds).
- Player should feel increasingly unstoppable:
  - Clear jumps in capability at milestone purchases.
  - Visual upgrades to match power increases (bigger glow, richer impact).

### Upgrade track (example v1 list)
Costs increase gradually; exact tuning later.

1. DPS + (repeatable)
2. Beam Width + (repeatable, small cap)
3. Max Path Length + (repeatable)
4. **Ricochet Module** (milestone): unlock 1 bounce
5. Max Bounces +1 (repeatable, cap)
6. Bounce Efficiency + (repeatable): less intensity loss per bounce
7. Impact Burst + (repeatable): bonus DPS for first 0.2s on a new target (helps target switching feel “snappy”)
8. Overdrive (milestone): temporary short “laser surge” when destroying a block (pure feel-good; keep balanced)

### Purchase UX
- Each upgrade card shows: name, current level, effect summary, cost.
- Buying triggers: sound, haptic, tiny screen shake, HUD number “pop.”

---

## Fail State & Run End
- If any block crosses the Fail Line: run ends immediately.
- Show end overlay:
  - Time survived
  - Blocks destroyed
  - Peak bounces (if any)
  - “Restarting…” (auto-restart after a short beat) and/or a Restart button

---

## Visual / Audio / Haptics (Polish Targets)
Inspired by the reference project’s approach: strong CSS/2D polish, snappy feedback, readable UI.

- **Laser**: additive glow, impact sparks, slight camera shake on big kills.
- **Blocks**: satisfying shatter pop (scale + particle burst).
- **Numbers**: HP ticks down smoothly; on big hits, number briefly “punches.”
- **Currency**: on destroy, a floating `+X` flies to the currency counter (like the reference’s score particles).
- **Haptics**: short vibrate on hit; stronger on destroy (where supported).
- **Pause/upgrade overlay**: rich gradient card, blur/dim background.

Accessibility:
- Respect `prefers-reduced-motion` by reducing shake/particles and slowing flashes.

---

## Tech Notes (Aligning With Reference Stack)
Based on the reference project:
- **Vite + React + TypeScript** for structure and UI polish.
- Use **Pointer Events** and `touch-action: none` for consistent mobile dragging.
- Rendering approach recommendation for this game:
  - **Canvas** for arena (blocks + laser + particles), React/CSS for HUD/menus.
  - Keep simulation in a single `requestAnimationFrame` loop with fixed timestep.
  - Maintain simple, data-driven modules in `src/game/*` for testability.

Collision/ricochet notes:
- Implement raycasting against block outlines (segments + arcs) to support rounded corners and stable normals.
- Add bounding boxes for early rejection to keep ray tests fast on mobile.


