import type { Dispatch, SetStateAction } from 'react'
import type { HighScoreEntry } from '../game/highScores'

// Shift a YYYY-MM-DD key by whole days, returning the new key (local calendar).
export const stepDateKey = (dateKey: string, deltaDays: number): string => {
  const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  dt.setDate(dt.getDate() + deltaDays)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

// Compact, human label for the date stepper: Today / Yesterday / "Jun 8" (with
// the year appended only when it isn't the current one).
const formatDateLabel = (dateKey: string, todayKey: string): string => {
  if (dateKey === todayKey) return 'Today'
  if (dateKey === stepDateKey(todayKey, -1)) return 'Yesterday'
  const [y, m, d] = dateKey.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
  const sameYear = (y ?? 0) === new Date().getFullYear()
  return dt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: '2-digit' }),
  })
}

export type GlobalRow = {
  playerId: string
  name: string
  score: number
  depth: number
  dateKey: string
  savedAt: number
}

export type GameOverProps = {
  score: number
  depth: number
  pauseStats: { depth: number; piecesDestroyed: number; runTime: string } | null
  showReplayTip: boolean
  showNamePrompt: boolean
  savedThisRun: boolean
  nameDraft: string
  setNameDraft: (v: string) => void
  submitHighScore: () => void
  isGlobalBest: boolean
  runGlobalRank: number | null
  runLocalRank: number | null
  showLeaderboard: boolean
  showGlobalTab: boolean
  activeTab: 'daily' | 'local'
  setLbTab: (t: 'daily' | 'local') => void
  lbTopRows: Array<GlobalRow | HighScoreEntry>
  lbPinnedMe: GlobalRow | null
  myDailyIdx: number
  playerId: string
  pendingScore: number | null
  pendingScoreDepth: number | null
  runDateKey: string
  viewDate: string
  setViewDate: Dispatch<SetStateAction<string>>
  todayKey: string
  atToday: boolean
  atFloor: boolean
  playAgain: () => void
}

// Game-over overlay: final score, inline name save, the tabbed daily/local
// leaderboard with date stepping, and Play Again. Extracted verbatim from App;
// all state stays in App and arrives as props.
export function GameOverScreen(props: GameOverProps) {
  const {
    score,
    depth,
    pauseStats,
    showReplayTip,
    showNamePrompt,
    savedThisRun,
    nameDraft,
    setNameDraft,
    submitHighScore,
    isGlobalBest,
    runGlobalRank,
    runLocalRank,
    showLeaderboard,
    showGlobalTab,
    activeTab,
    setLbTab,
    lbTopRows,
    lbPinnedMe,
    myDailyIdx,
    playerId,
    pendingScore,
    pendingScoreDepth,
    runDateKey,
    viewDate,
    setViewDate,
    todayKey,
    atToday,
    atFloor,
    playAgain,
  } = props
  return (
              <div className="menuOverlay" role="dialog" aria-label="Game over">
                <div className="menuPanel">
                  <div className="menuKicker">Run ended</div>
                  <div className="menuTitle">Game Over</div>

                  <div className="menuHero">
                    <span className="menuHeroLabel">Final Score</span>
                    <span className="menuHeroValue">{score.toLocaleString()}</span>
                  </div>

                  {pauseStats && (
                    <div className="menuChips">
                      <div className="menuChip">
                        <span className="v">{depth}</span>
                        <span className="k">Depth</span>
                      </div>
                      <div className="menuChip">
                        <span className="v">{pauseStats.piecesDestroyed}</span>
                        <span className="k">Pieces</span>
                      </div>
                      <div className="menuChip">
                        <span className="v">{pauseStats.runTime}</span>
                        <span className="k">Time</span>
                      </div>
                    </div>
                  )}

                  {showReplayTip && (
                    <div className="ftueReplayNote" role="note">
                      <div className="ftueReplayHeading">Try today&apos;s level again</div>
                      <div className="ftueReplayBody">
                        Today&apos;s level is the same every time you play it. Each day has its
                        own local and global leaderboards &mdash; replay it to beat your score
                        and climb the ranks.
                      </div>
                    </div>
                  )}

                  {showNamePrompt && !savedThisRun && (
                    <div className="menuSection nameSave">
                      <div className="nameSaveBadge">
                        {isGlobalBest
                          ? `New Global High Score${runGlobalRank ? ` · #${runGlobalRank}` : ''}`
                          : `New Local High Score · #${runLocalRank}`}
                      </div>
                      <div className="nameSaveRow">
                        <input
                          className="menuInput"
                          value={nameDraft}
                          onChange={(e) => setNameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') submitHighScore()
                          }}
                          maxLength={16}
                          placeholder="PLAYER"
                          aria-label="Your name"
                          autoFocus
                        />
                        <button
                          type="button"
                          className="menuBtn primary nameSaveBtn"
                          onClick={submitHighScore}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}

                  {showNamePrompt && savedThisRun && (
                    <div className="nameSaved" role="status">
                      Saved as <strong>{nameDraft.trim() || 'PLAYER'}</strong>
                    </div>
                  )}

                  {showLeaderboard && (
                    <div className="menuSection menuLeaderboard">
                      <div className="lbTabs" role="tablist">
                        {showGlobalTab && (
                          <button
                            type="button"
                            role="tab"
                            aria-selected={activeTab === 'daily'}
                            className={`lbTab${activeTab === 'daily' ? ' active' : ''}`}
                            onClick={() => setLbTab('daily')}
                          >
                            Global
                          </button>
                        )}
                        <button
                          type="button"
                          role="tab"
                          aria-selected={activeTab === 'local'}
                          className={`lbTab${activeTab === 'local' ? ' active' : ''}`}
                          onClick={() => setLbTab('local')}
                        >
                          Local
                        </button>
                      </div>

                      <ol className="menuScoreList lbList">
                        {lbTopRows.length === 0 ? (
                          <li className="lbEmpty">No runs on this day</li>
                        ) : (
                          lbTopRows.map((e, i) => {
                            const rank = i + 1
                            // Global board: the player's own actor row. Local board:
                            // the run that just finished (matched by score+depth+day).
                            const mine =
                              activeTab === 'daily'
                                ? 'playerId' in e && e.playerId === playerId
                                : 'ts' in e &&
                                  pendingScore != null &&
                                  e.score === pendingScore &&
                                  e.depth === pendingScoreDepth &&
                                  e.dateKey === runDateKey
                            const key =
                              'playerId' in e ? `${e.playerId}-${rank}` : `${e.ts}-${rank}`
                            return (
                              <li key={key} className={`menuScoreRow${mine ? ' isMe' : ''}`}>
                                <span className="rank">{rank}</span>
                                <span className="name">
                                  {e.name}
                                  {mine && activeTab === 'daily' && (
                                    <span className="youTag">(YOU)</span>
                                  )}
                                </span>
                                <span className="val">
                                  {e.score.toLocaleString()}
                                  <span className="depth">d{e.depth}</span>
                                </span>
                              </li>
                            )
                          })
                        )}
                        {lbPinnedMe && (
                          <li className="menuScoreRow isMe pinned">
                            <span className="rank">{myDailyIdx + 1}</span>
                            <span className="name">
                              {lbPinnedMe.name}
                              <span className="youTag">(YOU)</span>
                            </span>
                            <span className="val">
                              {lbPinnedMe.score.toLocaleString()}
                              <span className="depth">d{lbPinnedMe.depth}</span>
                            </span>
                          </li>
                        )}
                      </ol>

                      <div className="lbPager lbDateNav">
                        <button
                          type="button"
                          className="lbPagerBtn"
                          disabled={atFloor}
                          aria-label="Previous day"
                          onClick={() => setViewDate((d) => stepDateKey(d, -1))}
                        >
                          ‹
                        </button>
                        <span className="lbPagerLabel lbDateLabel">
                          {formatDateLabel(viewDate, todayKey)}
                        </span>
                        <button
                          type="button"
                          className="lbPagerBtn"
                          disabled={atToday}
                          aria-label="Next day"
                          onClick={() => setViewDate((d) => stepDateKey(d, 1))}
                        >
                          ›
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="menuActions">
                    <button type="button" className="menuBtn primary" onClick={playAgain}>
                      Play Again
                    </button>
                  </div>
                </div>
              </div>
  )
}
