import { useEffect, useRef } from 'react'
import { drawPieceSwatch, type SwatchKind } from '../render/swatch'

// Legend shown in the pause menu: the special pieces/features and what each one
// does, in plain language. Each row renders the REAL in-game artwork (via the
// shared piece renderer) rather than a stand-in glyph, so it's instantly
// recognizable. Block kinds are drawn as a 2x2 footprint.
export const PIECE_KEY: { kind: SwatchKind; name: string; desc: string }[] = [
  {
    kind: 'gold',
    name: 'Gold block',
    desc: 'Worth far more points and Overdrive charge.',
  },
  {
    kind: 'fast',
    name: 'Fast block',
    desc: 'Drops 2x as far every other time it drops.',
  },
  {
    kind: 'armored',
    name: 'Armored block',
    desc: 'Its mirrored bottom deflects your laser and resists damage. Hit the sides or top.',
  },
  {
    kind: 'shatter',
    name: 'Shatter block',
    desc: 'Spawns a cluster of normal blocks when destroyed.',
  },
  {
    kind: 'mirror',
    name: 'Mirror',
    desc: 'Reflects the beam off its diagonal. Burns away under sustained fire.',
  },
  {
    kind: 'splitter',
    name: 'Splitter',
    desc: 'Splits the beam into two at the angles indicated by the arrows. Both beams maintain full power.',
  },
]

// A single legend icon: draws the real piece artwork into a small canvas. Kept
// compact so the (now 6-row) pause-menu Key fits on one screen without scrolling.
const SWATCH_BOX = 36
export const PieceSwatch = ({ kind }: { kind: SwatchKind }) => {
  const ref = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    const canvas = ref.current
    if (canvas) drawPieceSwatch(canvas, kind, SWATCH_BOX)
  }, [kind])
  return <canvas ref={ref} className="menuKeyIcon" aria-hidden="true" />
}
