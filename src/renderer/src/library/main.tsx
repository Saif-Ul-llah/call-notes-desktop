import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useState } from 'react'
import '../theme.css'
import './library.css'
import { api, isLive, MicIcon, StatusChip, StopIcon, useLiveStatus } from '../common'
import type { SessionInfo } from '../../../shared/types'
import { formatClock } from '../../../shared/transcript-format'
import { SessionView } from './SessionView'
import { SettingsView } from './SettingsView'

type View = { kind: 'session'; id: string } | { kind: 'settings' } | { kind: 'empty' }

function statusLabel(s: SessionInfo): string | null {
  if (s.status === 'interrupted') return 'Interrupted'
  if (s.status !== 'saved') return 'Live'
  return null
}

function Library() {
  const live = useLiveStatus()
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

  const recording = isLive(live)

  return (
    <div className="lib">
      <aside className="side">
        <div className="brand">
          <span className="mark">●</span> Call Notes
        </div>
        <button className={`btn ${recording ? 'danger' : 'primary'} big`} onClick={() => api.session.toggle()}>
          {recording ? <StopIcon size={16} /> : <MicIcon size={16} />}
          {recording ? 'Stop transcript' : 'Start transcript'}
        </button>
        <div className="live-row">
          <StatusChip status={live} />
          {recording && (
            <button className="link" onClick={() => api.win.showOverlay()}>
              Show live window
            </button>
          )}
        </div>
        <input className="search" placeholder="Search calls and transcripts…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="sessions">
          {sessions.length === 0 && <div className="none">{query ? 'No matches.' : 'No calls yet.'}</div>}
          {sessions.map((s) => {
            const badge = statusLabel(s)
            const active = view.kind === 'session' && view.id === s.id
            return (
              <button key={s.id} className={`row ${active ? 'active' : ''}`} onClick={() => setView({ kind: 'session', id: s.id })}>
                <div className="row-title">{s.title}</div>
                <div className="row-meta">
                  <span>{new Date(s.startedAt).toLocaleDateString()}</span>
                  <span>{s.endedAt ? formatClock(s.endedAt - s.startedAt) : '—'}</span>
                  <span>{s.segmentCount ?? 0} lines</span>
                  {badge && <span className={`badge ${badge === 'Live' ? 'live' : 'warn'}`}>{badge}</span>}
                </div>
              </button>
            )
          })}
        </div>
        <button className={`btn settings ${view.kind === 'settings' ? 'active' : ''}`} onClick={() => setView({ kind: 'settings' })}>
          ⚙ Settings
        </button>
      </aside>
      <main className="main">
        {view.kind === 'session' && (
          <SessionView key={view.id} id={view.id} liveSessionId={live.sessionId} onDeleted={() => setView({ kind: 'empty' })} />
        )}
        {view.kind === 'settings' && <SettingsView />}
        {view.kind === 'empty' && (
          <div className="placeholder">
            <MicIcon size={40} />
            <h2>Offline call & meeting transcription</h2>
            <p>
              Press <b>Start transcript</b>, the floating gold button, or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd>. Everything is
              transcribed on this device in English and Roman Urdu/Hindi, and saved locally.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Library />)
