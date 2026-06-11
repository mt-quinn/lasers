import { useState } from 'react'
import { getPrefs, setPrefs, type Prefs } from '../game/settings'
import { sfxEngine } from '../audio/sfx'

// One small panel for every scattered preference: music volume (the engine's
// existing gain), SFX volume (the effects bus), haptics, and reduced motion
// (disables screenshake). Opened from the title screen and the pause menu.
export function SettingsPanel(props: {
  musicVolume: number
  onMusicVolume: (v: number) => void
  onClose: () => void
}) {
  const { musicVolume, onMusicVolume, onClose } = props
  const [prefs, setLocal] = useState<Prefs>(() => getPrefs())
  const update = (patch: Partial<Prefs>) => setLocal(setPrefs(patch))

  return (
    <div className="menuOverlay settingsOverlay" role="dialog" aria-label="Settings">
      <div className="menuPanel settingsPanel">
        <div className="menuKicker">Options</div>
        <div className="menuTitle">Settings</div>

        <div className="settingsRow">
          <span className="settingsLabel">Music volume</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={musicVolume}
            aria-label="Music volume"
            onChange={(e) => onMusicVolume(parseFloat(e.target.value))}
          />
        </div>

        <div className="settingsRow">
          <span className="settingsLabel">Sound effects</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={prefs.sfxVolume}
            aria-label="Sound effects volume"
            onChange={(e) => {
              const v = parseFloat(e.target.value)
              update({ sfxVolume: v })
              sfxEngine.setVolume(v)
            }}
          />
        </div>

        <div className="settingsRow">
          <span className="settingsLabel">Haptics</span>
          <input
            type="checkbox"
            checked={prefs.haptics}
            aria-label="Haptics"
            onChange={(e) => update({ haptics: e.target.checked })}
          />
        </div>

        <div className="settingsRow">
          <span className="settingsLabel">Reduced motion</span>
          <input
            type="checkbox"
            checked={prefs.reducedMotion}
            aria-label="Reduced motion"
            onChange={(e) => update({ reducedMotion: e.target.checked })}
          />
        </div>

        <div className="menuActions">
          <button type="button" className="menuBtn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
