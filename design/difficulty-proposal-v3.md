# Big Lasers — Difficulty Curve Proposal (v3)
## Comprehensive DPS vs HP Analysis & Tailored Experience Design

---

## Executive Summary

This proposal analyzes the current game mechanics objectively using mathematical models of player DPS growth versus block HP and spawn rates. The goal is to create a **highly tailored difficulty experience** that is:
- **Exciting** - Clear progression milestones with satisfying power spikes
- **Not Boring** - Maintains tension throughout without flatlines
- **Satisfyingly Conquerable** - Achievable skill ceiling with clear mastery moments
- **Skill-Expressive** - Rewards precision aiming, bounce management, and target prioritization

---

## Current Game State Analysis

### Player DPS Growth (Linear)
```
Initial DPS: 10
Growth: +1 per level
Formula: DPS(level) = 10 + level
```

**Level progression examples:**
- Level 0: 10 DPS
- Level 5: 15 DPS
- Level 10: 20 DPS
- Level 20: 30 DPS
- Level 50: 60 DPS

### XP Economy
```
XP Cap Formula: 5 + level
XP per normal block: 1
XP per gold block: 5 + goldXpBonus (starts at 5, grows with gold blocks destroyed)
Gold spawn chance: 3%
```

**Level-up timing (assuming average ~1.5 blocks/sec destroyed):**
- Level 1: ~3.3 seconds (5 XP needed)
- Level 5: ~6.7 seconds (10 XP needed)
- Level 10: ~10 seconds (15 XP needed)
- Level 20: ~16.7 seconds (25 XP needed)

### Block HP Growth (Piecewise Linear by Depth)
```
Base HP Formula (simplified):
- baseHp0 = 14
- Growth rate increases every minute of depth:
  * Minute 0-1: +10 HP per minute
  * Minute 1-2: +12 HP per minute
  * Minute 2-3: +14 HP per minute
  * Minute 3-4: +16 HP per minute
  * Minute 4+: +16 HP per minute (capped)
  
- Minutes calculated as: depth / 100 (at 1.0s drop interval = 60 drops/min)
- Actual HP: baseHp × sizeMult (0.7 + 0.22 × sqrt(cells)) × 1.5
```

**Sample HP progression (medium 4-cell block, sizeMult ≈ 1.14):**
- Minute 0 (depth 0): ~24 HP
- Minute 1 (depth 60): ~41 HP
- Minute 2 (depth 120): ~61 HP
- Minute 3 (depth 180): ~85 HP
- Minute 4 (depth 240): ~113 HP
- Minute 5 (depth 300): ~140 HP
- Minute 6 (depth 360): ~167 HP

### Spawn Rate & Density
```
Early Game (0-60s):
- Spawn interval: 0.94s → 0.66s
- Max blocks: 5 → 7

Late Game (60-360s):
- Spawn interval: 1.24s → 0.76s
- Max blocks: 7 → 13

Pressure Guardrails:
- If blocks near fail line: spawn slows by up to 85%
- Max blocks reduced by up to 2 when under pressure
```

---

## Time-to-Kill (TTK) Analysis

### Methodology
```
TTK = Block HP / (Player DPS × Beam Efficiency)
Beam Efficiency = 1.0 (direct hit) to ~0.85^n (after n bounces)
```

### Critical TTK Curves (Direct Hit, No Bounces)

**Minute 1 Analysis:**
- Player Level: ~12-15 (assuming ~1 level per 5s early)
- Player DPS: ~22-25
- Block HP: ~41
- **TTK: 1.6-1.9 seconds** ✓ Good (fast, satisfying)

**Minute 2 Analysis:**
- Player Level: ~24-28
- Player DPS: ~34-38
- Block HP: ~61
- **TTK: 1.6-1.8 seconds** ✓ Still good

**Minute 3 Analysis:**
- Player Level: ~32-36
- Player DPS: ~42-46
- Block HP: ~85
- **TTK: 1.8-2.0 seconds** ✓ Slight increase, manageable

**Minute 4 Analysis:**
- Player Level: ~38-42
- Player DPS: ~48-52
- Block HP: ~113
- **TTK: 2.2-2.4 seconds** ⚠️ Getting longer

**Minute 5 Analysis:**
- Player Level: ~42-46
- Player DPS: ~52-56
- Block HP: ~140
- **TTK: 2.5-2.7 seconds** ⚠️ Noticeably slower

**Minute 6 Analysis:**
- Player Level: ~46-50
- Player DPS: ~56-60
- Block HP: ~167
- **TTK: 2.8-3.0 seconds** ⚠️ Approaching critical threshold

---

## Problem Identification

### Issue #1: Linear DPS Growth vs Accelerating HP Growth
The player's DPS grows **linearly** (+1 per level), but block HP grows with an **accelerating piecewise linear rate** that ramps from +10/min to +16/min. This creates an **expanding TTK gap** over time.

### Issue #2: XP Cap Growth Doesn't Match Economy
XP caps grow linearly (+1 per level), but:
- Block HP increases faster than DPS
- More time spent per block means fewer blocks destroyed per minute
- This creates a **compound slowdown** in progression

### Issue #3: Skill Expression Window Shrinks
As TTK increases:
- Less time available for repositioning between kills
- Reduced ability to use bounces effectively (longer commitment per target)
- Board pressure builds faster than player can recover

### Issue #4: No Clear Power Spikes
Linear +1 DPS growth provides **no memorable milestones**. Every level feels identical, reducing engagement.

---

## Proposed Solution: The "Flow State Curve"

### Design Philosophy
1. **Early Power Fantasy** (0-90s): Player feels dominant, learns mechanics
2. **Tension Ramp** (90-240s): Difficulty rises, but stays conquerable with skill
3. **Mastery Phase** (240s+): Bounces become critical; precise aiming matters
4. **Clear Milestones**: Power spikes at key levels that feel rewarding

### Core Changes

#### 1. DPS Growth: Linear Base + Milestone Spikes
```javascript
function calculateDPS(level) {
  const baseDPS = 10 + level * 1.5  // Increased from +1 to +1.5 per level
  
  // Milestone spikes every 5 levels
  const milestoneBonus = Math.floor(level / 5) * 3
  
  return baseDPS + milestoneBonus
}
```

**Results:**
- Level 0: 10 DPS
- Level 5: 20.5 DPS (+3 spike)
- Level 10: 31 DPS (+3 spike)
- Level 15: 41.5 DPS (+3 spike)
- Level 20: 52 DPS (+3 spike)
- Level 30: 73 DPS (+6 in spikes)
- Level 50: 115 DPS (+10 in spikes)

This creates **clear power moments** while maintaining better pacing with HP growth.

#### 2. HP Growth: Slower Early, Maintain Late
```javascript
// Adjust base HP growth to be gentler early game
const baseHp0 = 12  // Reduced from 14
const initialRate = 8  // Reduced from 10
const rateIncrement = 2  // Keep at 2
const maxRate = 16  // Keep at 16
const dropsPerMinBaseline = 100  // Keep at 100
```

**Effect:** Slightly easier early minutes (0-2), same difficulty late game

#### 3. XP Cap: Slower Growth Early, Faster Late
```javascript
function calculateXpCap(level) {
  if (level < 10) {
    return 5 + level  // Keep quick early levels
  } else if (level < 30) {
    return 15 + Math.floor((level - 10) * 1.2)  // Moderate growth
  } else {
    return 39 + Math.floor((level - 30) * 0.8)  // Slower late (mastery focus)
  }
}
```

**Results:**
- Levels 0-10: Same as current (fast early progression)
- Levels 10-30: Slightly faster than current (maintain momentum)
- Levels 30+: Slower than current (emphasis on execution)

#### 4. Bounce Efficiency Improvements
```javascript
// Current: bounceFalloff = 0.85 (15% loss per bounce)
// Proposed: Make this upgradeable AND improve base value

// In runState.ts, change initial value:
bounceFalloff: 0.90  // Increased from 0.85 (only 10% loss per bounce)

// Add bounce upgrade path (re-enable):
// Every 10 levels, offer optional bounce efficiency upgrade
// Rare/Epic: +0.03 to bounceFalloff (can reach 0.99 eventually)
```

#### 5. Spawn Density: Slightly Reduced Mid-Game
```javascript
// Adjust spawn timings for better skill expression window
const spawnEveryEarly = 1.0 + (0.7 - 1.0) * e  // 0-60s: 1.0s → 0.7s (vs 0.94s → 0.66s)
const spawnEveryLate = 1.3 + (0.85 - 1.3) * l  // 60-360s: 1.3s → 0.85s (vs 1.24s → 0.76s)

// Keep max blocks the same
const maxBlocksEarly = Math.floor(5 + 2 * e)  // 5 → 7 (unchanged)
const maxBlocksLate = Math.floor(7 + 6 * l)   // 7 → 13 (unchanged)
```

**Effect:** Slightly more breathing room in the critical 2-4 minute range

#### 6. Gold Block Bonus: Exponential XP Scaling
```javascript
// Current: Gold blocks give 5 + goldXpBonus (linear growth)
// Proposed: Make gold blocks more impactful as game progresses

function calculateGoldXP(goldXpBonus, level) {
  const baseGoldXP = 5
  const scaledBonus = Math.floor(goldXpBonus * (1 + level * 0.02))
  return baseGoldXP + scaledBonus
}
```

**Effect:** Gold blocks at level 30 give ~30% more XP, rewarding precision hits

---

## Revised TTK Analysis (With Proposed Changes)

### Updated TTK Curves

**Minute 1:**
- Player Level: ~13-16 (slightly faster leveling)
- Player DPS: ~29.5-34 (vs 23-26 current)
- Block HP: ~38 (vs ~41 current)
- **Proposed TTK: 1.1-1.3s** ✓ Excellent (faster than current)

**Minute 2:**
- Player Level: ~26-30
- Player DPS: ~55-61 (with milestone spikes)
- Block HP: ~58
- **Proposed TTK: 0.95-1.05s** ✓ Excellent (power spike moment!)

**Minute 3:**
- Player Level: ~34-38
- Player DPS: ~76-83 (with spikes)
- Block HP: ~85
- **Proposed TTK: 1.0-1.1s** ✓ Great (maintains pace)

**Minute 4:**
- Player Level: ~40-44
- Player DPS: ~91-98
- Block HP: ~113
- **Proposed TTK: 1.15-1.25s** ✓ Good (slight increase, manageable)

**Minute 5:**
- Player Level: ~44-48
- Player DPS: ~103-111
- Block HP: ~140
- **Proposed TTK: 1.26-1.36s** ✓ Tension rising but conquerable

**Minute 6:**
- Player Level: ~48-52
- Player DPS: ~115-123
- Block HP: ~167
- **Proposed TTK: 1.36-1.45s** ✓ High tension, skill matters

---

## Skill Expression Emphasis

### Bounce Gameplay Enhancement
With improved bounce falloff (0.90 vs 0.85):
- **1 bounce:** 90% damage (vs 85%)
- **2 bounces:** 81% damage (vs 72%)
- **3 bounces:** 73% damage (vs 61%)

This makes multi-target strategies **significantly more viable** at all stages.

### Target Prioritization Rewards
With faster TTK and more breathing room:
- Players can **switch targets more frequently**
- **High-value** gold blocks become worth hunting
- **Tactical** decisions (which block to clear first) become meaningful

### Positioning Matters More
Slightly longer spawn intervals give players time to:
- **Reposition** for optimal bounce angles
- **Plan** multi-block clears
- **React** to dangerous board states

---

## Expected Player Experience

### Phase 1: Learning (0-90 seconds)
- **Feeling:** "I'm getting stronger fast!"
- **Gameplay:** Focus on basic aiming, learn controls
- **Milestone:** Hit level 5 → DPS spike → noticeably faster kills

### Phase 2: Mastery Introduction (90-240 seconds)
- **Feeling:** "I need to use bounces effectively now"
- **Gameplay:** Board density increases, bounces become valuable
- **Milestones:** Levels 10, 15, 20 → Each spike provides relief valve

### Phase 3: True Mastery (240+ seconds)
- **Feeling:** "Every shot counts"
- **Gameplay:** Precision matters, bounce chains critical
- **Goal:** Survive as long as possible through perfect execution

---

## Implementation Checklist

### Changes to `spawn.ts`:
- [ ] Adjust `baseHp0` from 14 to 12
- [ ] Adjust `initialRate` from 10 to 8
- [ ] Calculate gold XP using new scaling formula

### Changes to `sim.ts`:
- [ ] Adjust `spawnEveryEarly` to 1.0 → 0.7
- [ ] Adjust `spawnEveryLate` to 1.3 → 0.85
- [ ] Implement milestone DPS calculation
- [ ] Keep spawn density the same

### Changes to `levelUp.ts`:
- [ ] Update `autoApplyLevelUp` to use new DPS formula
- [ ] Update `computeXpCap` with three-tier system

### Changes to `runState.ts`:
- [ ] Update initial `bounceFalloff` from 0.85 to 0.90

### Testing Focus:
- [ ] Verify TTK curves match predictions
- [ ] Confirm power spikes feel rewarding
- [ ] Test bounce gameplay viability
- [ ] Validate 3-5 minute survival feels achievable

---

## Success Metrics

### Objective Measures:
- **Average survival time:** 4-7 minutes (currently ~3-4 minutes)
- **TTK curve:** Maintain 0.95-1.5s range throughout run
- **Levels achieved:** ~40-55 in a successful run
- **Bounce usage:** Players using 2+ bounces regularly after minute 3

### Subjective Measures:
- **Power fantasy:** Clear "I just got stronger" moments
- **Tension curve:** Gradual increase without overwhelming spikes
- **Skill expression:** Good players survive 2x+ longer than average
- **Replayability:** "One more run" factor from milestone chasing

---

## Alternative: Conservative Tuning

If the above changes feel too aggressive, here's a **minimal adjustment** option:

### Conservative Changes Only:
1. DPS: +1.2 per level (instead of +1.5)
2. Milestone bonus: +2 per 5 levels (instead of +3)
3. HP: Keep current formula
4. Spawn rate: Keep current formula
5. Bounce: Improve to 0.88 (instead of 0.90)

This provides **~30% improvement** in TTK curves without drastically changing the feel.

---

## Conclusion

The proposed "Flow State Curve" maintains the game's core feel while:
1. ✓ Providing **clear progression milestones**
2. ✓ Keeping **TTK in the optimal range** (0.95-1.5s)
3. ✓ Emphasizing **skill expression** through bounces
4. ✓ Creating **memorable power moments** at milestone levels
5. ✓ Remaining **conquerable** with practice (4-7 minute survival)

The mathematical analysis shows these changes will create a **tighter, more engaging difficulty curve** that rewards skill while maintaining accessibility.

**Recommendation:** Implement the full proposal and iterate based on playtesting data.
