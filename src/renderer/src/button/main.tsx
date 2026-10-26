import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import '../theme.css'
import './button.css'
import { api, clock, isLive, useElapsed, useLevel, useLiveStatus } from '../common'
import { MicIcon } from '../icons'

const DRAG_THRESHOLD = 4
const R = 33 // level ring radius in the 76px window

function FloatingButton() {
  const status = useLiveStatus()
  const level = useLevel()
  const live = isLive(status)
  const elapsed = useElapsed(live ? status.startedAt : null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.screenX, y: e.screenY, moved: false }
    api.win.dragButton('start', e.screenX, e.screenY)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.moved && Math.hypot(e.screenX - d.x, e.screenY - d.y) < DRAG_THRESHOLD) return
    d.moved = true
    api.win.dragButton('move', e.screenX, e.screenY)
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (d.moved) api.win.dragButton('end', e.screenX, e.screenY)
    else void api.session.toggle()
  }

  const state = status.status === 'retrying' ? 'retrying' : status.status === 'stopping' ? 'saving' : live ? 'live' : 'idle'
  // the ring follows whoever is louder: you or the call
  const voice = live ? Math.max(level.mic, level.system) : 0
  const circumference = 2 * Math.PI * R
  const title = live
    ? `Recording ${clock(elapsed)} — click to stop (Ctrl+Alt+N). Drag to move, right-click for options.`
    : 'Start transcript (Ctrl+Alt+N). Drag to move, right-click for options.'

  return (
    <div className={`wrap ${state}`}>
      {/* outer ring is a native drag handle too, so the button moves even where apps can't position windows */}
      <svg className="ring" viewBox="0 0 76 76" aria-hidden>
        <circle className="track" cx="38" cy="38" r={R} />
        <circle
          className="level"
          cx="38"
          cy="38"
          r={R}
          strokeDasharray={`${circumference * Math.max(0.04, voice)} ${circumference}`}
          transform="rotate(-90 38 38)"
        />
      </svg>
      <button
        className="disc"
        title={title}
        aria-label={live ? 'Stop transcript' : 'Start transcript'}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(e) => {
          e.preventDefault()
          api.win.buttonMenu()
        }}
        onDoubleClick={() => api.win.showOverlay()}
      >
        {live ? (
          <>
            <span className="rec-dot" />
            <span className="time">{clock(elapsed)}</span>
          </>
        ) : (
          <MicIcon size={24} />
        )}
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<FloatingButton />)
