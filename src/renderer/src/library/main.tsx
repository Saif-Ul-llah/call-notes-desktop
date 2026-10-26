import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useState } from 'react'
import '../theme.css'
import './library.css'
import { api, clock, isLive, StatusPill, useElapsed, useLiveStatus, useTextScale } from '../common'
import { GearIcon, Glyph, MicIcon, SearchIcon, StopIcon } from '../icons'
import type { SessionInfo } from '../../../shared/types'
import { formatClock } from '../../../shared/transcript-format'
import { SessionView } from './SessionView'
import { SettingsView } from './SettingsView'

type View = { kind: 'session'; id: string } | { kind: 'settings' } | { kind: 'empty' }

function relativeDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 86400000)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function Library() {
  const live = useLiveStatus()
  useTextScale() // applies the saved transcript text size
  const recording = isLive(live)
  const elapsed = useElapsed(recording ? live.startedAt : null)
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>({ kind: 'empty' })

  const refresh = useCallback(() => {
    void api.library.list(query).then((list) => {
      setSessions(list)
      setView((v) => (v.kind === 'empty' && list[0] ? { kind: 'session', id: list[0].id } : v))
    })
  }, [query])

  useEffect(() => {
    const t = setTimeout(refresh, 150)
    return () => clearTimeout(t)
  }, [refresh])
  useEffect(() => api.library.onChange(refresh), [refresh])
  // a new live session appears at the top and is opened
  useEffect(() => {
    if (live.sessionId) {
      refresh()
      setView({ kind: 'session', id: live.sessionId })
    }
  }, [live.sessionId, refresh])

  return (
    <div className="lib">
      <aside className="side">
        <div className="brand">
          <Glyph size={20} />
          <span>Call Notes</span>
        </div>

        <div className="record-card">
          <button className={`btn ${recording ? 'rec' : 'gold'} record-btn`} onClick={() => api.session.toggle()}>
            {recording ? <StopIcon size={12} /> : <MicIcon size={16} />}
            {recording ? `Stop  ${clock(elapsed)}` : 'Start transcript'}
          </button>
          <div className="record-meta">
            <StatusPill status={live} />
            {recording ? (
              <button className="link" onClick={() => api.win.showOverlay()}>
                Show live window
              </button>
            ) : (
              <span className="hint">
                <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd>
              </span>
            )}
          </div>
        </div>

        <label className="search">
          <SearchIcon size={15} />
          <input placeholder="Search calls and words" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search calls" />
        </label>

        <nav className="sessions" aria-label="Calls">
          {sessions.length === 0 && <p className="none">{query ? 'Nothing matches that search.' : 'Your calls will appear here.'}</p>}
          {sessions.map((s) => {
            const active = view.kind === 'session' && view.id === s.id
            const isLiveRow = s.id === live.sessionId && recording
            return (
              <button key={s.id} className={`row ${active ? 'active' : ''}`} onClick={() => setView({ kind: 'session', id: s.id })}>
                <span className="row-top">
                  <span className="row-title">{s.title}</span>
                  {isLiveRow && <span className="tag live">Live</span>}
                  {s.status === 'interrupted' && <span className="tag warn">Interrupted</span>}
                </span>
                <span className="row-snippet">{s.snippet ?? (isLiveRow ? 'Listening…' : 'No speech recorded')}</span>
                <span className="row-meta">
                  <span>{relativeDay(s.startedAt)}</span>
                  {s.endedAt && <span>{formatClock(s.endedAt - s.startedAt)}</span>}
                </span>
              </button>
            )
          })}
        </nav>

        <button className={`btn quiet settings-btn ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
          <GearIcon size={16} />
          Settings
        </button>
      </aside>

      <main className="main">
        {view.kind === 'session' && (
          <SessionView key={view.id} id={view.id} liveSessionId={recording ? live.sessionId : null} onDeleted={() => setView({ kind: 'empty' })} />
        )}
        {view.kind === 'settings' && <SettingsView />}
        {view.kind === 'empty' && (
          <div className="placeholder">
            <Glyph size={44} />
            <h1>Transcribe your next call</h1>
            <p>
              Press <b>Start transcript</b>, the floating mic on your screen, or <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd>. Call Notes writes
              English and Roman Urdu/Hindi as people speak, entirely on this computer.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Library />)
