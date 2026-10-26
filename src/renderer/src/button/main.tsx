import { createRoot } from 'react-dom/client'
import { useRef } from 'react'
import '../theme.css'
import './button.css'
import { api, clock, isLive, MicIcon, StopIcon, useElapsed, useLiveStatus } from '../common'

const DRAG_THRESHOLD = 4

function FloatingButton() {
  const status = useLiveStatus()
  const elapsed = useElapsed(isLive(status) ? status.startedAt : null)
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

  const live = isLive(status)
  const state = status.status === 'retrying' ? 'retrying' : live ? 'recording' : 'idle'
  const title = live ? 'Stop transcript (Ctrl+Alt+N) — drag to move, right-click for menu' : 'Start transcript (Ctrl+Alt+N) — drag to move, right-click for menu'

  return (
    <div className="wrap">
      <button
        className={`fab ${state}`}
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
        {live ? <StopIcon /> : <MicIcon size={26} />}
        {live && <span className="time">{clock(elapsed)}</span>}
      </button>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<FloatingButton />)
