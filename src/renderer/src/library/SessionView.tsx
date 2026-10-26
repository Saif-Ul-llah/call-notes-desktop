import { useEffect, useRef, useState } from 'react'
import { api, speakerClass } from '../common'
import { CopyIcon, DownloadIcon, FolderIcon, ResumeIcon, SparkIcon, TrashIcon } from '../icons'
import type { ExportFormat, SessionDetail } from '../../../shared/api'
import { formatClock, toParagraphs } from '../../../shared/transcript-format'

const LANGUAGE_LABEL = { roman: 'Roman Urdu/Hindi', en: 'English', auto: 'Auto-detect' } as const
const EXPORTS: Array<{ format: ExportFormat; label: string; hint: string }> = [
  { format: 'md', label: 'Markdown', hint: 'Readable notes' },
  { format: 'txt', label: 'Plain text', hint: 'Paste anywhere' },
  { format: 'srt', label: 'Subtitles (.srt)', hint: 'With timings' },
  { format: 'json', label: 'JSON', hint: 'For tools and AI summaries' },
]

export function SessionView({ id, liveSessionId, onDeleted }: { id: string; liveSessionId: string | null; onDeleted: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [title, setTitle] = useState('')
  const [toast, setToast] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
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
        api.session.onSegmentRemoved((e) => setDetail((d) => (d ? { ...d, segments: d.segments.filter((s) => s.id !== e.id) } : d))),
      )
    }
    return () => offs.forEach((off) => off())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isLive])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(false)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menu])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 2400)
  }

  if (!detail) return <div className="placeholder">Opening call…</div>
  const { session, segments, audio } = detail
  const duration = session.endedAt ? formatClock(session.endedAt - session.startedAt) : null

  const seekTo = (startMs: number) => {
    let idx = 0
    for (let i = 0; i < audio.length; i++) if (audio[i].offsetMs <= startMs) idx = i
    const el = audioRef.current
    if (!el || audio.length === 0) return
    const target = Math.max(0, (startMs - audio[idx].offsetMs) / 1000 - 0.3)
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
    setMenu(false)
    const path = await api.library.exportAs(id, format)
    if (path) flash(`Saved to ${path}`)
  }

  const saveTitle = () => {
    if (title.trim() && title !== session.title) void api.library.rename(id, title)
  }

  return (
    <article className="session">
      <header className="session-head">
        <input
          className="title-input"
          value={title}
          aria-label="Call title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <dl className="facts">
          <div>
            <dt>Started</dt>
            <dd>{new Date(session.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          </div>
          <div>
            <dt>Length</dt>
            <dd>{duration ?? (isLive ? 'Recording' : 'Unfinished')}</dd>
          </div>
          <div>
            <dt>Language</dt>
            <dd>{LANGUAGE_LABEL[session.language]}</dd>
          </div>
          {session.status === 'interrupted' && (
            <div>
              <dt>Status</dt>
              <dd className="warn-text">Interrupted</dd>
            </div>
          )}
        </dl>

        <div className="toolbar">
          {session.status === 'interrupted' && !liveSessionId && (
            <button className="btn brass" onClick={() => api.session.resume(id)} title="Start a new recording that continues this call">
              <ResumeIcon size={15} />
              Continue this call
            </button>
          )}
          <div className="menu-wrap">
            <button
              className="btn"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={(e) => {
                e.stopPropagation()
                setMenu((m) => !m)
              }}
            >
              <DownloadIcon size={15} />
              Export
            </button>
            {menu && (
              <div className="menu" role="menu">
                {EXPORTS.map((x) => (
                  <button key={x.format} role="menuitem" onClick={() => exportAs(x.format)}>
                    <span>{x.label}</span>
                    <small>{x.hint}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            className="btn"
            onClick={async () => {
              await api.library.copyText(id)
              flash('Transcript copied')
            }}
          >
            <CopyIcon size={15} />
            Copy text
          </button>
          <button className="btn" onClick={() => api.library.openFolder(id)}>
            <FolderIcon size={15} />
            Show files
          </button>
          <button className="btn" disabled title="Coming next: an on-device AI writes minutes of meeting from this transcript">
            <SparkIcon size={15} />
            Write minutes
          </button>
          <span className="spacer" />
          <button
            className="btn quiet icon"
            disabled={isLive}
            title="Delete call"
            aria-label="Delete call"
            onClick={async () => {
              if (await api.library.remove(id)) onDeleted()
            }}
          >
            <TrashIcon size={16} />
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
        {segments.length === 0 && (
          <p className="none">{isLive ? 'Listening. Lines appear here a moment after each sentence.' : 'No speech was recorded in this call.'}</p>
        )}
        {toParagraphs(segments).map((p, i) => (
          <section key={i} className="para">
            <button className="para-ts" title="Play from here" onClick={() => seekTo(p.startMs)} disabled={audio.length === 0}>
              {formatClock(p.startMs)}
            </button>
            <div className="para-body">
              <div className={`para-who ${speakerClass(p.speaker)}`}>{p.speaker}</div>
              <p className={`para-text ${p.speaker === 'Notice' ? 'notice' : ''}`}>{p.text}</p>
            </div>
          </section>
        ))}
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </article>
  )
}
