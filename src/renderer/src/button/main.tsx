import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import '../theme.css'
import './button.css'
import { api, clock, isLive, useElapsed, useLevel, useLiveStatus } from '../common'
import { MicIcon } from '../icons'

const DRAG_THRESHOLD = 4
// a click waits this long so a double-click (open live window) never also toggles recording
const CLICK_DELAY_MS = 260
const R = 33 // level ring radius in the 76px window

function FloatingButton() {
  const status = useLiveStatus()
  const level = useLevel()
  const live = isLive(status)
  const elapsed = useElapsed(live ? status.startedAt : null)
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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
    if (d.moved) {
      api.win.dragButton('end', e.screenX, e.screenY)
      return
    }
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
  // small corner dot for anything the user should know without hovering
  const health =
    status.engine === 'restarting' || status.engine === 'failed' || status.status === 'retrying' ? 'warn'
    : status.engine === 'loading' ? 'loading'
    : !live && status.pendingJobs > 0 ? 'finishing'
    : null
  const healthText =
    health === 'warn' ? status.message ?? 'Speech engine is restarting'
    : health === 'loading' ? 'Loading the speech model'
    : health === 'finishing' ? `Finishing ${status.pendingJobs} line${status.pendingJobs === 1 ? '' : 's'}`
    : null
  // the ring follows whoever is louder: you or the call
  const voice = live ? Math.max(level.mic, level.system) : 0
  const circumference = 2 * Math.PI * R
  const title =
    (healthText ? `${healthText}\n` : '') +
    (live
      ? `Recording ${clock(elapsed)}. Click to stop (Ctrl+Alt+N). Double-click for the live window.`
      : 'Click to start a transcript (Ctrl+Alt+N). Double-click for the live window.') +
    '\nDrag to move, right-click for options.'

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
        onDoubleClick={onDoubleClick}
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
      {health && <span className={`health ${health}`} aria-label={healthText ?? undefined} />}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<FloatingButton />)
