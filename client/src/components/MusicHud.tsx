import type { CSSProperties } from 'react'
import type { TrackInfo } from '../audio/music'
import { Marquee } from './Marquee'

export type MusicHudProps = {
  musicOn: boolean
  musicPanelOpen: boolean
  musicPanelPos: { left: number; bottom: number }
  panelTrack: TrackInfo | null
  nowPlaying: TrackInfo | null
  npLeaving: boolean
  brokenArtSrc: string | null
  setBrokenArtSrc: (src: string | null) => void
  showCornerBtn: boolean
  toggleCornerMusicPanel: () => void
  closeMusicPanel: () => void
  toggleMusicPlayback: () => void
  nextTrack: () => void
  volumeOpen: boolean
  setVolumeOpen: (updater: (v: boolean) => boolean) => void
  volume: number
  changeVolume: (v: number) => void
}

// Music UI cluster: the auto-popping "now playing" corner card, the corner
// trigger button (pause/game-over), and the transport popover. Extracted
// verbatim from App; the music engine stays behind App's callbacks.
export function MusicHud(props: MusicHudProps) {
  const {
    musicOn,
    musicPanelOpen,
    musicPanelPos,
    panelTrack,
    nowPlaying,
    npLeaving,
    brokenArtSrc,
    setBrokenArtSrc,
    showCornerBtn,
    toggleCornerMusicPanel,
    closeMusicPanel,
    toggleMusicPlayback,
    nextTrack,
    volumeOpen,
    setVolumeOpen,
    volume,
    changeVolume,
  } = props
  return (
    <>
            {/* "Now playing" corner card — pops in when a new song starts, holds
                briefly, then fades. Also re-shown (pinned) for as long as the music
                panel is open. Non-interactive so taps pass to gameplay. */}
            {(() => {
              const card = musicPanelOpen ? panelTrack ?? nowPlaying : nowPlaying
              // While the panel is open the card is always present (placeholder
              // when no track is known yet); otherwise it only auto-pops.
              if (!card && !musicPanelOpen) return null
              const hasArt = !!card?.artwork && card.artwork !== brokenArtSrc
              const cls = `${musicPanelOpen ? 'nowPlaying pinned' : `nowPlaying${npLeaving ? ' leaving' : ''}`}${
                hasArt ? '' : ' noArt'
              }`
              return (
                <div className={cls} role="status" aria-live="polite">
                  {hasArt && (
                    <img
                      className="npArt"
                      src={card!.artwork}
                      alt=""
                      aria-hidden="true"
                      onError={() => setBrokenArtSrc(card!.artwork ?? null)}
                    />
                  )}
                  <div className="npText">
                    <div className="npEyebrow">Now Playing</div>
                    <Marquee className="npTitle" text={card ? card.title : 'Nothing playing'} />
                    {card && <Marquee className="npArtist" text={card.artist} />}
                    {card && (card.album || card.genre) && (
                      <Marquee className="npAlbum" text={card.album || card.genre || ''} />
                    )}
                  </div>
                </div>
              )
            })()}

            {/* Music control: bottom-right button on the pause / game-over overlays
                (in-game the canvas dock button opens the same panel). Plus the
                shared popover (Pause / Next / Volume) and an outside-tap scrim. */}
            {showCornerBtn && (
              <button
                type="button"
                className={`musicCornerBtn${musicOn ? ' on' : ''}`}
                aria-label="Music controls"
                aria-expanded={musicPanelOpen}
                onClick={toggleCornerMusicPanel}
              >
                <span className="musicCornerGlyph" aria-hidden="true">♪</span>
              </button>
            )}

            {musicPanelOpen && (
              <>
                <div
                  className="musicScrim"
                  onPointerDown={closeMusicPanel}
                  aria-hidden="true"
                />
                <div
                  className="musicPanel"
                  role="dialog"
                  aria-label="Music controls"
                  style={{ left: musicPanelPos.left, bottom: musicPanelPos.bottom }}
                >
                  <div className="musicPanelRow">
                    <button
                      type="button"
                      className="musicBtn"
                      aria-label={musicOn ? 'Pause music' : 'Play music'}
                      onClick={toggleMusicPlayback}
                    >
                      {musicOn ? (
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                          <rect x="6.5" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
                          <rect x="13.9" y="5" width="3.6" height="14" rx="1.2" fill="currentColor" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                          <path d="M8 5.5 L8 18.5 L19 12 Z" fill="currentColor" />
                        </svg>
                      )}
                    </button>
                    <button
                      type="button"
                      className="musicBtn"
                      aria-label="Next track"
                      onClick={nextTrack}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path d="M6 5.5 L6 18.5 L15 12 Z" fill="currentColor" />
                        <rect x="16" y="5" width="3" height="14" rx="1.2" fill="currentColor" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      className={`musicBtn${volumeOpen ? ' active' : ''}`}
                      aria-label="Volume"
                      aria-expanded={volumeOpen}
                      onClick={() => setVolumeOpen((v) => !v)}
                    >
                      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                        <path
                          d="M4 9 L8 9 L13 5 L13 19 L8 15 L4 15 Z"
                          fill="currentColor"
                        />
                        {volume > 0.02 && (
                          <path
                            d="M16 8.5 A5 5 0 0 1 16 15.5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                          />
                        )}
                      </svg>
                    </button>
                  </div>
                  {volumeOpen && (
                    <div className="musicVolumeRow">
                      <input
                        className="musicVolume"
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={volume}
                        aria-label="Volume level"
                        style={{ '--vol': `${Math.round(volume * 100)}%` } as CSSProperties}
                        onChange={(e) => changeVolume(parseFloat(e.target.value))}
                      />
                    </div>
                  )}
                </div>
              </>
            )}
    </>
  )
}
