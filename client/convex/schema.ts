import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

// Global leaderboards for laserburn. Both boards are keyed on an anonymous
// per-device `playerId` (a localStorage UUID) — there is no auth. Every submit
// is an upsert that keeps the player's BEST row, so a player can fire
// submissions on every game-over without flooding the table.
//
//   • endless: one row per playerId — their best score ever.
//   • daily:   one row per (dateKey, playerId) — their best score on that
//              calendar day's seeded board.
//
// Unlike the reference (cubic-cleanup) daily board, which ranks by fewest
// moves, laserburn ranks by HIGHEST score on both boards. `depth` rides along
// purely for display ("score · d{depth}"), matching the local board.
export default defineSchema({
  endlessScores: defineTable({
    playerId: v.string(),
    name: v.string(),
    score: v.number(),
    depth: v.number(),
    savedAt: v.number(),
  })
    // Rank: highest score first (queried with .order('desc')).
    .index('by_score', ['score'])
    // Upsert/dedupe: find this player's existing row(s).
    .index('by_player_saved', ['playerId', 'savedAt']),

  dailyScores: defineTable({
    playerId: v.string(),
    name: v.string(),
    score: v.number(),
    depth: v.number(),
    // Calendar-day key (`YYYY-MM-DD`, local day) the seeded run belongs to.
    dateKey: v.string(),
    savedAt: v.number(),
  })
    // Rank within a day: fix dateKey, then highest score first.
    .index('by_dateKey_score', ['dateKey', 'score'])
    // Upsert/dedupe: find this player's row(s) (filtered to dateKey in JS).
    .index('by_player_saved', ['playerId', 'savedAt']),
})
