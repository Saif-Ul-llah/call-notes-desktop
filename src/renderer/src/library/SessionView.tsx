import { useEffect, useMemo, useRef, useState } from 'react'
import { api, clock, speakerClass } from '../common'
import { CopyIcon, DownloadIcon, FolderIcon, PauseIcon, PlayIcon, ResumeIcon, SparkIcon, TrashIcon } from '../icons'
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
  const [playing, setPlaying] = useState(false)
  const [pos, setPos] = useState(0)
  const [dur, setDur] = useState(0)
  const [rate, setRate] = useState(1)
  const pendingSeek = useRef<number | null>(null)
  const activeRef = useRef<HTMLElement | null>(null)
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

  const paragraphs = useMemo(() => toParagraphs(detail?.segments ?? []), [detail?.segments])
  const audio = detail?.audio ?? []
  // session time (ms) of the playhead, used to highlight the line being played
  const playheadMs = audio.length && (playing || pos > 0) ? audio[audioIndex].offsetMs + pos * 1000 : -1
  let activePara = -1
  for (let i = 0; i < paragraphs.length; i++) if (paragraphs[i].startMs <= playheadMs + 250) activePara = i

  useEffect(() => {
    if (playing) activeRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [activePara, playing])

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [rate, audioIndex])

  if (!detail) return <div className="placeholder">Opening call…</div>
  const { session, segments } = detail
  const duration = session.endedAt ? formatClock(session.endedAt - session.startedAt) : null

  const onLoadedMetadata = () => {
    const el = audioRef.current
    if (!el) return
    if (Number.isFinite(el.duration)) {
      setDur(el.duration)
    } else {
      // recorder-made WebM has no duration header: seek far ahead once to learn it
      el.addEventListener(
        'durationchange',
        () => {
          setDur(Number.isFinite(el.duration) ? el.duration : 0)
          el.currentTime = pendingSeek.current ?? 0
        },
        { once: true },
      )
      el.currentTime = 1e9
    }
    el.playbackRate = rate
    if (pendingSeek.current !== null && Number.isFinite(el.duration)) {
      el.currentTime = pendingSeek.current
    }
    if (pendingSeek.current !== null) {
      pendingSeek.current = null
      void el.play()
    }
  }

  const seekTo = (startMs: number) => {
    if (audio.length === 0) return
    let idx = 0
    for (let i = 0; i < audio.length; i++) if (audio[i].offsetMs <= startMs) idx = i
    const target = Math.max(0, (startMs - audio[idx].offsetMs) / 1000 - 0.3)
    const el = audioRef.current
    if (idx !== audioIndex || !el) {
      pendingSeek.current = target
      setAudioIndex(idx)
      return
    }
    el.currentTime = target
    void el.play()
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
            <button className="btn gold" onClick={() => api.session.resume(id)} title="Start a new recording that continues this call">
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
            <audio
              ref={audioRef}
              src={audio[audioIndex]?.url}
              preload="metadata"
              onLoadedMetadata={onLoadedMetadata}
              onTimeUpdate={(e) => setPos(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onEnded={() => {
                setPlaying(false)
                if (audioIndex < audio.length - 1) {
                  pendingSeek.current = 0
                  setAudioIndex(audioIndex + 1)
                }
              }}
            />
            <button
              className="play"
              onClick={() => (playing ? audioRef.current?.pause() : void audioRef.current?.play())}
              aria-label={playing ? 'Pause recording' : 'Play recording'}
            >
              {playing ? <PauseIcon size={16} /> : <PlayIcon size={16} />}
            </button>
            <span className="player-time">{clock(Math.floor(pos))}</span>
            <input
              className="scrub"
              type="range"
              min={0}
              max={dur || 0}
              step={0.1}
              value={Math.min(pos, dur || 0)}
              onChange={(e) => {
                const el = audioRef.current
                if (el) el.currentTime = Number(e.target.value)
              }}
              aria-label="Playback position"
              disabled={!dur}
            />
            <span className="player-time">{clock(Math.floor(dur))}</span>
            <select className="speed" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="Playback speed">
              {[1, 1.25, 1.5, 2].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
            {audio.length > 1 && <span className="hint">Part {audioIndex + 1} of {audio.length}</span>}
          </div>
        )}
      </header>

      <div className="transcript">
        {segments.length === 0 && (
          <p className="none">{isLive ? 'Listening. Lines appear here a moment after each sentence.' : 'No speech was recorded in this call.'}</p>
        )}
        {paragraphs.map((p, i) => (
          <section key={i} className={`para ${i === activePara ? 'active' : ''}`} ref={i === activePara ? (el) => { activeRef.current = el } : undefined}>
            <button className="para-ts" title="Play from here" aria-label={`Play from ${formatClock(p.startMs)}`} onClick={() => seekTo(p.startMs)} disabled={audio.length === 0}>
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
