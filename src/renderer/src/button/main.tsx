import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import '../theme.css'
import './button.css'
import { api, clock, isLive, useElapsed, useLevel, useLiveStatus } from '../common'
import { MicIcon, StopIcon } from '../icons'

// a click waits this long so a double-click (open live window) never also toggles recording
const CLICK_DELAY_MS = 260
// relative heights of the level bars, so they read as a voice and not a progress bar
const BAR_SHAPE = [0.55, 1, 0.7, 0.9, 0.45]

/** Six-dot drag grip. The element carrying it is a native drag region. */
function Grip() {
  return (
    <svg width="8" height="16" viewBox="0 0 8 16" aria-hidden>
      {[2, 8, 14].map((y) => [2, 6].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}
    </svg>
  )
}

function MiniPlayer() {
  const status = useLiveStatus()
  const level = useLevel()
  const live = isLive(status)
  const elapsed = useElapsed(live ? status.startedAt : null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragging = useRef(false)

  // grip and readout move the window; pointer capture keeps the drag smooth off-window
  const drag = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      dragging.current = true
      api.win.dragButton('start', e.screenX, e.screenY)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (dragging.current) api.win.dragButton('move', e.screenX, e.screenY)
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      api.win.dragButton('end', e.screenX, e.screenY)
    },
  }

  const onClick = () => {
    if (clickTimer.current) return // second click of a double-click
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      void api.session.toggle()
    }, CLICK_DELAY_MS)
  }
  const onDoubleClick = () => {
    if (clickTimer.current) clearTimeout(clickTimer.current)
    clickTimer.current = null
    api.win.showOverlay()
  }

  const state = status.status === 'retrying' ? 'retrying' : status.status === 'stopping' ? 'saving' : live ? 'live' : 'idle'
  const problem = status.engine === 'restarting' || status.engine === 'failed'
  const voice = live ? Math.max(level.mic, level.system) : 0

  const label =
    state === 'retrying' ? 'Reconnecting'
    : state === 'saving' ? 'Saving'
    : live ? null
    : status.engine === 'loading' ? 'Loading'
    : problem ? 'Restarting'
    : status.pendingJobs > 0 ? `Finishing ${status.pendingJobs}`
    : 'Start'

  return (
    <div
      className={`pill ${state} ${problem ? 'problem' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        api.win.buttonMenu()
      }}
    >
      <div className="grip" title="Drag to move" aria-label="Drag to move" {...drag}>
        <Grip />
      </div>

      <button
        className="disc"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        aria-label={live ? 'Stop transcript' : 'Start transcript'}
        title={live ? 'Stop transcript (Ctrl+Alt+N). Double-click for the live window.' : 'Start transcript (Ctrl+Alt+N). Double-click for the live window.'}
      >
        {live ? <StopIcon size={13} /> : <MicIcon size={19} />}
      </button>

      {/* the readout is part of the drag area too: a bigger target to grab */}
      <div className="readout" title="Drag to move. Right-click for options." {...drag}>
        {label ? (
          <span className="label">{label}</span>
        ) : (
          <>
            <span className="time">{clock(elapsed)}</span>
            <span className="bars" aria-hidden>
              {BAR_SHAPE.map((k, i) => (
                <span key={i} style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, voice * 1.3 * k + 0.1))})` }} />
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<MiniPlayer />)
