import { useEffect, useRef, useState } from 'react'
import { api } from '../common'
import type { ExportFormat, SessionDetail } from '../../../shared/api'
import type { Segment } from '../../../shared/types'
import { formatClock, toParagraphs } from '../../../shared/transcript-format'

const speakerClass = (s: string) => (s === 'Me' ? 'speaker-me' : s === 'Notice' ? 'speaker-notice' : 'speaker-them')

export function SessionView({ id, liveSessionId, onDeleted }: { id: string; liveSessionId: string | null; onDeleted: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [title, setTitle] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [audioIndex, setAudioIndex] = useState(0)
  const audioRef = useRef<HTMLAudioElement>(null)
  const isLive = liveSessionId === id

  const load = () =>
    api.library.get(id).then((d) => {
      setDetail(d)
      if (d) setTitle(d.session.title)
    })

  useEffect(() => {
    void load()
    const offs = [api.library.onChange(() => void load())]
    if (isLive) {
      offs.push(
        api.session.onSegment((seg) => {
          if (seg.sessionId !== id) return
          setDetail((d) => (d ? { ...d, segments: [...d.segments.filter((s) => s.id !== seg.id), seg].sort((a, b) => a.startMs - b.startMs) } : d))
        }),
        api.session.onSegmentRemoved((e) =>
          setDetail((d) => (d ? { ...d, segments: d.segments.filter((s) => s.id !== e.id) } : d)),
        ),
      )
    }
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLive])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2200)
  }

  if (!detail) return <div className="placeholder">Loading…</div>
  const { session, segments, audio } = detail
  const duration = session.endedAt ? formatClock(session.endedAt - session.startedAt) : 'in progress'

  const seekTo = (seg: Segment) => {
    // find the recording file covering this moment
    let idx = 0
    for (let i = 0; i < audio.length; i++) if (audio[i].offsetMs <= seg.startMs) idx = i
    const el = audioRef.current
    if (!el || audio.length === 0) return
    const target = Math.max(0, (seg.startMs - audio[idx].offsetMs) / 1000 - 0.3)
    if (idx !== audioIndex) {
      setAudioIndex(idx)
      el.onloadedmetadata = () => {
        el.currentTime = target
        void el.play()
        el.onloadedmetadata = null
      }
    } else {
      el.currentTime = target
      void el.play()
    }
  }

  const exportAs = async (format: ExportFormat) => {
    const path = await api.library.exportAs(id, format)
    if (path) flash(`Saved ${path}`)
  }

  const saveTitle = () => {
    if (title.trim() && title !== session.title) void api.library.rename(id, title)
  }

  return (
    <div className="session">
      <header className="session-head">
        <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <div className="meta">
          <span>{new Date(session.startedAt).toLocaleString()}</span>
          <span>Duration {duration}</span>
          <span>Language: {session.language === 'roman' ? 'Roman Urdu/Hindi' : session.language === 'en' ? 'English' : 'Auto'}</span>
          <span>Model: {session.model}</span>
          {isLive && <span className="badge live">Live</span>}
          {session.status === 'interrupted' && <span className="badge warn">Interrupted</span>}
        </div>
        <div className="toolbar">
          {session.status === 'interrupted' && !liveSessionId && (
            <button className="btn primary" onClick={() => api.session.resume(id)} title="Start a new recording linked to this call">
              ↻ Resume call
            </button>
          )}
          <button className="btn" onClick={() => exportAs('md')}>Export .md</button>
          <button className="btn" onClick={() => exportAs('txt')}>.txt</button>
          <button className="btn" onClick={() => exportAs('srt')}>.srt</button>
          <button className="btn" onClick={() => exportAs('json')}>.json</button>
          <button className="btn" onClick={async () => { await api.library.copyText(id); flash('Transcript copied') }}>Copy</button>
          <button className="btn" onClick={() => api.library.openFolder(id)}>Open folder</button>
          <button
            className="btn"
            disabled
            title="Phase 2: an on-device LLM will summarise the call into minutes of meeting (MOM)"
          >
            ✦ Generate MOM (soon)
          </button>
          <button
            className="btn danger"
            disabled={isLive}
            onClick={async () => {
              if (await api.library.remove(id)) onDeleted()
            }}
          >
            Delete
          </button>
        </div>
        {audio.length > 0 && (
          <div className="player">
            <audio ref={audioRef} controls src={audio[audioIndex]?.url} preload="metadata" />
            {audio.length > 1 && <span className="hint">Part {audioIndex + 1} of {audio.length}</span>}
          </div>
        )}
      </header>

      <div className="transcript">
        {segments.length === 0 && <div className="none">{isLive ? 'Waiting for speech…' : 'No speech was transcribed in this call.'}</div>}
        {toParagraphs(segments).map((p, i) => (
          <div key={i} className="para">
            <button className="para-ts" title="Play from here" onClick={() => seekTo({ startMs: p.startMs } as Segment)}>
              {formatClock(p.startMs)}
            </button>
            <div>
              <div className={`para-who ${speakerClass(p.speaker)}`}>{p.speaker}</div>
              <div className="para-text">{p.text}</div>
            </div>
          </div>
        ))}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
