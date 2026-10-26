import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import '../theme.css'
import './overlay.css'
import { api, clock, isLive, MicIcon, StatusChip, StopIcon, useElapsed, useLiveStatus } from '../common'
import type { PartialLine, Segment, StreamId } from '../../../shared/types'
import { formatClock } from '../../../shared/transcript-format'

const speakerClass = (s: string) => (s === 'Me' ? 'speaker-me' : s === 'Notice' ? 'speaker-notice' : 'speaker-them')

function Overlay() {
  const status = useLiveStatus()
  const elapsed = useElapsed(isLive(status) ? status.startedAt : null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [partials, setPartials] = useState<Partial<Record<StreamId, PartialLine>>>({})
  const [opacity, setOpacity] = useState(0.95)
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | null>(null)

  useEffect(() => {
    void api.settings.get().then((s) => setOpacity(s.overlayOpacity))
    void api.session.snapshot().then((snap) => {
      sessionRef.current = snap.status.sessionId
      setSegments(snap.segments)
      setPartials(Object.fromEntries(snap.partials.map((p) => [p.stream, p])))
    })
    const offs = [
      api.session.onStatus((s) => {
        // a new session started: clear the previous transcript
        if (s.sessionId && s.sessionId !== sessionRef.current) {
          sessionRef.current = s.sessionId
          setSegments([])
          setPartials({})
          setFollow(true)
        }
      }),
      api.session.onSegment((seg) => {
        if (seg.sessionId !== sessionRef.current) return
        setSegments((prev) => [...prev.filter((s) => s.id !== seg.id), seg].sort((a, b) => a.startMs - b.startMs))
      }),
      api.session.onSegmentRemoved((e) => setSegments((prev) => prev.filter((s) => s.id !== e.id))),
      api.session.onPartial((p) =>
        setPartials((prev) => {
          const next = { ...prev }
          if (p.text) next[p.stream] = p
          else delete next[p.stream]
          return next
        }),
      ),
    ]
    return () => offs.forEach((off) => off())
  }, [])

  useLayoutEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [segments, partials, follow])

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const copyAll = async () => {
    const text = segments.map((s) => `[${formatClock(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const live = isLive(status)
  const partialLines = Object.values(partials).filter((p): p is PartialLine => !!p?.text)

  return (
    <div className="overlay">
      <header className="bar">
        <div className="title">
          <span className="logo">●</span>
          <strong>Live transcript</strong>
          <StatusChip status={status} />
          {live && <span className="timer">{clock(elapsed)}</span>}
        </div>
        <div className="actions">
          <button className={`btn icon ${live ? 'danger' : 'primary'}`} onClick={() => api.session.toggle()} title={live ? 'Stop' : 'Start'}>
            {live ? <StopIcon size={14} /> : <MicIcon size={14} />}
            {live ? 'Stop' : 'Start'}
          </button>
          <button className="btn icon" onClick={copyAll} title="Copy transcript" disabled={segments.length === 0}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn icon" onClick={() => api.win.openLibrary()} title="Open library">
            ☰
          </button>
          <button className="btn icon" onClick={() => api.win.hideOverlay()} title="Hide">
            ✕
          </button>
        </div>
      </header>

      {status.message && <div className="banner">{status.message}</div>}

      <div className="list" ref={listRef} onScroll={onScroll}>
        {segments.length === 0 && partialLines.length === 0 && (
          <div className="empty">
            {live ? (
              <>Listening… speak or play the call audio.</>
            ) : (
              <>
                Press the gold button or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> to start transcribing.
              </>
            )}
          </div>
        )}
        {segments.map((s) => (
          <p key={s.id} className="line">
            <span className="ts">{formatClock(s.startMs)}</span>
            <span className={`who ${speakerClass(s.speaker)}`}>{s.speaker}</span>
            <span className="text">{s.text}</span>
          </p>
        ))}
        {partialLines.map((p) => (
          <p key={`partial-${p.stream}`} className="line partial">
            <span className="ts">…</span>
            <span className={`who ${speakerClass(p.speaker)}`}>{p.speaker}</span>
            <span className="text">{p.text}</span>
          </p>
        ))}
      </div>

      {!follow && (
        <button className="btn primary jump" onClick={() => setFollow(true)}>
          ↓ Jump to live
        </button>
      )}

      <footer className="foot">
        <span>{status.model ? `Model: ${status.model}` : ''}</span>
        <label title="Window opacity">
          <span>Opacity</span>
          <input
            type="range"
            min={0.3}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => {
              const v = Number(e.target.value)
              setOpacity(v)
              api.win.setOverlayOpacity(v)
            }}
          />
        </label>
      </footer>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Overlay />)
