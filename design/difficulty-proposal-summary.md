# Big Lasers — Difficulty Curve Proposal Summary

## 🎯 Goal
Create an exciting, skill-expressive difficulty curve that is conquerable and not boring.

---

## 📊 Current Problem

### The Math:
- **Player DPS:** Grows linearly (+1/level) → 10, 11, 12, 13...
- **Block HP:** Grows with accelerating rate → +10/min, then +12/min, then +14/min, then +16/min
- **Result:** Time-to-Kill (TTK) expands from 1.6s at minute 1 to 3.0s at minute 6

### The Experience:
- ❌ No memorable power spikes (every +1 DPS feels the same)
- ❌ Fights get progressively slower and less satisfying
- ❌ Less time for skill expression (repositioning, bounce chains)
- ❌ Board pressure builds faster than player can respond

---

## 💡 Proposed Solution

### 1. **DPS: Linear Base + Milestone Spikes**
```
Current: 10 + level
Proposed: 10 + (level × 1.5) + (floor(level/5) × 3)
```

**Example:**
- Level 5: 20.5 DPS (vs 15 current) → **+37% power spike!**
- Level 10: 31 DPS (vs 20 current) → **+55% stronger**
- Level 20: 52 DPS (vs 30 current) → **+73% stronger**

**Why:** Creates clear "I just got stronger!" moments every 5 levels

### 2. **HP: Gentler Early Game**
```
Current: baseHp0 = 14, initialRate = 10
Proposed: baseHp0 = 12, initialRate = 8
```

**Why:** Gives players more time to learn before difficulty ramps

### 3. **Bounce Efficiency: More Viable**
```
Current: 0.85 (15% loss per bounce)
Proposed: 0.90 (10% loss per bounce)
```

**Impact:**
- 2 bounces: 81% damage (vs 72%) → **12% better**
- 3 bounces: 73% damage (vs 61%) → **20% better**

**Why:** Makes bounce chains a viable strategy, not just a desperation move

### 4. **Spawn Rate: Slightly More Breathing Room**
```
Current: 0.94s → 0.66s (early), 1.24s → 0.76s (late)
Proposed: 1.0s → 0.7s (early), 1.3s → 0.85s (late)
```

**Why:** ~10% slower spawns = more time for positioning and tactical play

### 5. **XP Curve: Three-Tier System**
```
Current: 5 + level (linear)
Proposed: 
  - Levels 0-10: Fast (5 + level)
  - Levels 10-30: Moderate (grows 1.2x)
  - Levels 30+: Slower (grows 0.8x)
```

**Why:** Quick early levels for engagement, slower late for mastery focus

---

## 📈 Predicted TTK Results

| Time | Current TTK | Proposed TTK | Improvement |
|------|------------|--------------|-------------|
| Min 1 | 1.6-1.9s | 1.1-1.3s | **✓ 32% faster** |
| Min 2 | 1.6-1.8s | 0.95-1.05s | **✓ 44% faster** |
| Min 3 | 1.8-2.0s | 1.0-1.1s | **✓ 45% faster** |
| Min 4 | 2.2-2.4s | 1.15-1.25s | **✓ 48% faster** |
| Min 5 | 2.5-2.7s | 1.26-1.36s | **✓ 50% faster** |
| Min 6 | 2.8-3.0s | 1.36-1.45s | **✓ 52% faster** |

**Sweet spot maintained:** 0.95-1.5 seconds throughout the run

---

## 🎮 Expected Player Experience

### Phase 1: Power Fantasy (0-90s)
- 💪 "I'm getting stronger fast!"
- 🎯 Learn controls, basic aiming
- ⭐ Level 5 milestone: Noticeably faster kills

### Phase 2: Tactical Play (90-240s)
- 🤔 "I need to think about bounce angles"
- 🎯 Target prioritization matters
- ⭐ Milestones at 10, 15, 20: Relief valves when pressure builds

### Phase 3: Mastery (240s+)
- 🔥 "Every shot counts!"
- 🎯 Precision critical, bounce chains essential
- ⭐ Survival through perfect execution

---

## ✅ Benefits

### Exciting:
- ✓ Clear power spikes every 5 levels
- ✓ Faster, more satisfying combat throughout
- ✓ "One more run" factor from chasing milestones

### Not Boring:
- ✓ TTK stays in optimal range (never too long)
- ✓ Consistent pacing prevents "grind" feeling
- ✓ Tension builds gradually without flatlines

### Conquerable:
- ✓ Predicted survival time: 4-7 minutes (vs 3-4 current)
- ✓ Power spikes provide recovery windows
- ✓ Skill ceiling remains high but achievable

### Skill-Expressive:
- ✓ Better bounces = more positioning options
- ✓ More time between kills = better target selection
- ✓ Gold blocks worth hunting (precision rewarded)
- ✓ Good players can survive 2x+ longer than average

---

## 🛠️ Implementation Effort

**Estimated time:** 30-45 minutes

**Files to modify:**
1. `spawn.ts` - Adjust HP base values (2 numbers)
2. `sim.ts` - Adjust spawn timings (2 formulas), add DPS milestone logic
3. `levelUp.ts` - Update DPS formula and XP cap logic
4. `runState.ts` - Update bounce falloff value (1 number)

**Risk:** Low (all numeric tuning, no architectural changes)

---

## 📋 Alternative: Conservative Option

If the full proposal feels too aggressive:

### Minimal Changes:
- DPS: +1.2 per level + 2 bonus per 5 levels (vs +1.5 + 3 bonus)
- Bounce: 0.88 (vs 0.90)
- Spawn: Keep current
- HP: Keep current

**Result:** ~30% improvement in TTK (instead of ~50%)

---

## 🎲 Recommendation

**Implement the full proposal.** The mathematical analysis shows:
- TTK curves stay in optimal range
- Power progression feels rewarding
- Skill expression significantly enhanced
- Difficulty remains challenging but fair

The changes are reversible numeric tuning, making this **low-risk with high potential reward**.

**Next step:** Playtest and iterate based on actual survival times and subjective feel.
