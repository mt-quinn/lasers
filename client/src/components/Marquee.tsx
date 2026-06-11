import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'

// Auto-marquee: shows `text` statically when it fits, and gently scrolls it on a
// seamless loop when it would otherwise be truncated. Re-measures on text change
// and container resize (the now-playing card width is published per frame).
export function Marquee({ text, className }: { text: string; className?: string }) {
  const clipRef = useRef<HTMLDivElement>(null)
  const itemRef = useRef<HTMLSpanElement>(null)
  const [shift, setShift] = useState(0) // px to travel per loop; 0 = no scroll

  useLayoutEffect(() => {
    const clip = clipRef.current
    const item = itemRef.current
    if (!clip || !item) return
    const GAP = 36 // px between the repeated copies
    const measure = () => {
      const overflow = item.scrollWidth - clip.clientWidth
      setShift(overflow > 2 ? item.scrollWidth + GAP : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(clip)
    return () => ro.disconnect()
  }, [text])

  const scrolling = shift > 0
  const SPEED = 42 // px per second
  const trackStyle = scrolling
    ? ({
        '--mq-shift': `${shift}px`,
        animationDuration: `${Math.max(4, shift / SPEED)}s`,
      } as CSSProperties)
    : undefined

  return (
    <div ref={clipRef} className={`mqClip${className ? ` ${className}` : ''}`}>
      <div className={`mqTrack${scrolling ? ' scrolling' : ''}`} style={trackStyle}>
        <span ref={itemRef} className="mqItem">
          {text}
        </span>
        {scrolling && (
          <span className="mqItem" aria-hidden="true">
            {text}
          </span>
        )}
      </div>
    </div>
  )
}
