import { internalMutation, mutation, query } from './_generated/server'
import { v } from 'convex/values'

// Global leaderboard storage for laserburn.
//
// Identity & dedup: one row per actor.
//   • Endless: actor = playerId. The row holds that player's best-ever score.
//   • Daily:   actor = (dateKey, playerId). One row per player per calendar
//              day, holding their best score on that day's seeded board.
//
// Every submit is an upsert: look up the actor's existing row, keep whichever
// side has the higher score (ties broken by the earlier savedAt, like the
// local board), and patch/delete the rest. So clients can fire a submission on
// every game-over without ever flooding the table.

const MAX_NAME_LENGTH = 16
const ENDLESS_TOP_N = 100
const DAILY_TOP_N = 100

const sanitizeName = (raw: string): string => {
  const trimmed = (raw ?? '').trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'PLAYER'
  return trimmed.slice(0, MAX_NAME_LENGTH)
}

export const submitEndlessScore = mutation({
  args: {
    playerId: v.string(),
    name: v.string(),
    score: v.number(),
    depth: v.number(),
    savedAt: v.number(),
  },
  handler: async (ctx, { playerId, name, score, depth, savedAt }) => {
    if (!Number.isFinite(score) || score < 0) return null
    const flooredScore = Math.floor(score)
    const flooredDepth = Math.max(0, Math.floor(depth))
    // Pull every row for this player (legacy/races may produce >1) so we can
    // collapse to a single best row in one transaction.
    const existingRows = await ctx.db
      .query('endlessScores')
      .withIndex('by_player_saved', (q) => q.eq('playerId', playerId))
      .collect()
    const incumbentBest = existingRows.reduce<(typeof existingRows)[number] | null>(
      (best, r) =>
        best === null
          ? r
          : r.score > best.score || (r.score === best.score && r.savedAt < best.savedAt)
            ? r
            : best,
      null,
    )
    if (incumbentBest && incumbentBest.score >= flooredScore) {
      // Incumbent is at least as good — just sweep stragglers, keep the row.
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
      return null
    }
    const cleanName = sanitizeName(name)
    if (incumbentBest) {
      await ctx.db.patch(incumbentBest._id, {
        name: cleanName,
        score: flooredScore,
        depth: flooredDepth,
        savedAt,
      })
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
    } else {
      await ctx.db.insert('endlessScores', {
        playerId,
        name: cleanName,
        score: flooredScore,
        depth: flooredDepth,
        savedAt,
      })
    }
    return null
  },
})

export const submitDailyScore = mutation({
  args: {
    playerId: v.string(),
    name: v.string(),
    score: v.number(),
    depth: v.number(),
    dateKey: v.string(),
    savedAt: v.number(),
  },
  handler: async (ctx, { playerId, name, score, depth, dateKey, savedAt }) => {
    if (!Number.isFinite(score) || score < 0) return null
    const flooredScore = Math.floor(score)
    const flooredDepth = Math.max(0, Math.floor(depth))
    // Scan this player's rows and filter to the day in JS. Daily rows per
    // player are bounded (one per day), so the scan stays cheap.
    const existingRows = (
      await ctx.db
        .query('dailyScores')
        .withIndex('by_player_saved', (q) => q.eq('playerId', playerId))
        .collect()
    ).filter((r) => r.dateKey === dateKey)
    const incumbentBest = existingRows.reduce<(typeof existingRows)[number] | null>(
      (best, r) =>
        best === null
          ? r
          : r.score > best.score || (r.score === best.score && r.savedAt < best.savedAt)
            ? r
            : best,
      null,
    )
    if (incumbentBest && incumbentBest.score >= flooredScore) {
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
      return null
    }
    const cleanName = sanitizeName(name)
    if (incumbentBest) {
      await ctx.db.patch(incumbentBest._id, {
        name: cleanName,
        score: flooredScore,
        depth: flooredDepth,
        savedAt,
      })
      for (const r of existingRows) {
        if (r._id !== incumbentBest._id) await ctx.db.delete(r._id)
      }
    } else {
      await ctx.db.insert('dailyScores', {
        playerId,
        name: cleanName,
        score: flooredScore,
        depth: flooredDepth,
        dateKey,
        savedAt,
      })
    }
    return null
  },
})

export const getTopEndlessScores = query({
  args: {},
  handler: async (ctx) => {
    const entries = await ctx.db
      .query('endlessScores')
      .withIndex('by_score')
      .order('desc')
      .take(ENDLESS_TOP_N * 2)
    const seen = new Set<string>()
    const out: typeof entries = []
    for (const e of entries) {
      if (seen.has(e.playerId)) continue
      seen.add(e.playerId)
      out.push(e)
      if (out.length >= ENDLESS_TOP_N) break
    }
    return out.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      score: e.score,
      depth: e.depth,
      savedAt: e.savedAt,
    }))
  },
})

export const getTopDailyScoresForDate = query({
  args: { dateKey: v.string() },
  handler: async (ctx, { dateKey }) => {
    // Fix the dateKey on the composite index, then walk highest score first.
    const entries = await ctx.db
      .query('dailyScores')
      .withIndex('by_dateKey_score', (q) => q.eq('dateKey', dateKey))
      .order('desc')
      .take(DAILY_TOP_N * 2)
    const seen = new Set<string>()
    const out: typeof entries = []
    for (const e of entries) {
      if (seen.has(e.playerId)) continue
      seen.add(e.playerId)
      out.push(e)
      if (out.length >= DAILY_TOP_N) break
    }
    return out.map((e) => ({
      playerId: e.playerId,
      name: e.name,
      score: e.score,
      depth: e.depth,
      dateKey: e.dateKey,
      savedAt: e.savedAt,
    }))
  },
})

// Maintenance janitor (not client-exposed; invoke via `npx convex run`).
// Removes every leaderboard row for a given playerId across both boards —
// used to wipe test/verification rows.
export const adminDeletePlayer = internalMutation({
  args: { playerId: v.string() },
  handler: async (ctx, { playerId }) => {
    let deleted = 0
    const endless = await ctx.db
      .query('endlessScores')
      .withIndex('by_player_saved', (q) => q.eq('playerId', playerId))
      .collect()
    for (const r of endless) {
      await ctx.db.delete(r._id)
      deleted += 1
    }
    const daily = await ctx.db
      .query('dailyScores')
      .withIndex('by_player_saved', (q) => q.eq('playerId', playerId))
      .collect()
    for (const r of daily) {
      await ctx.db.delete(r._id)
      deleted += 1
    }
    return { deleted }
  },
})
