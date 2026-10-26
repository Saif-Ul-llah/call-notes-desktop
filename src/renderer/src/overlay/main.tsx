import { createRoot } from 'react-dom/client'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import '../theme.css'
import './overlay.css'
import { api, clock, isLive, speakerClass, StatusPill, TEXT_SCALE_MAX, TEXT_SCALE_MIN, useElapsed, useLevel, useLiveStatus, useTextScale } from '../common'
import { CheckIcon, CloseIcon, CopyIcon, Glyph, LibraryIcon, MicIcon, StopIcon } from '../icons'
import type { PartialLine, Segment, StreamId } from '../../../shared/types'
import { formatClock } from '../../../shared/transcript-format'

interface Turn {
  speaker: string
  startMs: number
  lines: Segment[]
}

/** Consecutive lines from the same speaker read as one turn. */
function toTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = []
  for (const seg of segments) {
    const last = turns[turns.length - 1]
    if (last && last.speaker === seg.speaker && seg.startMs - last.lines[last.lines.length - 1].endMs < 6000) last.lines.push(seg)
    else turns.push({ speaker: seg.speaker, startMs: seg.startMs, lines: [seg] })
  }
  return turns
}

function Meter({ label, value, tone }: { label: string; value: number; tone: 'me' | 'them' }) {
  return (
    <span className="meter" title={`${label} input level`}>
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        <span className={`meter-fill ${tone}`} style={{ transform: `scaleX(${Math.max(0.02, value)})` }} />
      </span>
    </span>
  )
}

function Overlay() {
  const status = useLiveStatus()
  const level = useLevel()
  const live = isLive(status)
  const elapsed = useElapsed(live ? status.startedAt : null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [partials, setPartials] = useState<Partial<Record<StreamId, PartialLine>>>({})
  const [opacity, setOpacity] = useState(0.95)
  const [follow, setFollow] = useState(true)
  const [copied, setCopied] = useState(false)
  const [scale, setScale] = useTextScale()
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
        if (s.status === 'idle') setPartials({})
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

  const turns = useMemo(() => toTurns(segments), [segments])
  const previews = Object.values(partials).filter((p): p is PartialLine => !!p?.text)

  useLayoutEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [turns, previews.length, partials, follow])

  const onScroll = () => {
    const el = listRef.current
    if (el) setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
  }

  const copyAll = async () => {
    const text = segments.map((s) => `[${formatClock(s.startMs)}] ${s.speaker}: ${s.text}`).join('\n')
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="overlay">
      <header className="bar">
        <div className="bar-left">
          <Glyph />
          <StatusPill status={status} />
          {live && <span className="timer">{clock(elapsed)}</span>}
        </div>
        <div className="bar-actions">
          <button className={`btn small ${live ? 'rec' : 'gold'}`} onClick={() => api.session.toggle()}>
            {live ? <StopIcon size={11} /> : <MicIcon size={14} />}
            {live ? 'Stop' : 'Start'}
          </button>
          <button className="btn small icon quiet" onClick={copyAll} title="Copy transcript" aria-label="Copy transcript" disabled={segments.length === 0}>
            {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          </button>
          <button className="btn small icon quiet" onClick={() => api.win.openLibrary()} title="Open library" aria-label="Open library">
            <LibraryIcon size={15} />
          </button>
          <button className="btn small icon quiet" onClick={() => api.win.hideOverlay()} title="Hide window" aria-label="Hide window">
            <CloseIcon size={15} />
          </button>
        </div>
      </header>

      {status.message && <div className="banner">{status.message}</div>}

      <div className="list" ref={listRef} onScroll={onScroll}>
        {turns.length === 0 && previews.length === 0 && (
          <div className="empty">
            {live ? (
              <p>Listening. Speak, or play the call — words appear here as they're said.</p>
            ) : (
              <p>
                Press the floating mic or <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd> to start.
                <br />
                Your call is transcribed on this computer as it happens.
              </p>
            )}
          </div>
        )}
        {turns.map((t) => (
          <section key={t.lines[0].id} className="turn">
            <div className="turn-head">
              <span className={`who ${speakerClass(t.speaker)}`}>{t.speaker}</span>
              <span className="ts">{formatClock(t.startMs)}</span>
            </div>
            {/* one line per sentence: easier to follow live than a growing paragraph */}
            {t.lines.map((l) => (
              <p key={l.id} className={`text ${t.speaker === 'Notice' ? 'notice' : ''}`}>
                {l.text}
              </p>
            ))}
          </section>
        ))}
        {previews.map((p) => (
          <section key={`preview-${p.stream}`} className="turn preview" aria-live="polite">
            <div className="turn-head">
              <span className={`who ${speakerClass(p.speaker)}`}>{p.speaker}</span>
              <span className="ts">speaking</span>
            </div>
            <p className="text">
              {p.text}
              <span className="caret" />
            </p>
          </section>
        ))}
      </div>

      {!follow && (
        <button className="btn small gold jump" onClick={() => setFollow(true)}>
          Back to live
        </button>
      )}

      <footer className="foot">
        <div className="meters">
          <Meter label="You" value={live ? level.mic : 0} tone="me" />
          <Meter label="Call" value={live ? level.system : 0} tone="them" />
        </div>
        <div className="text-size" role="group" aria-label="Text size">
          <button className="btn small icon quiet" onClick={() => setScale(scale - 0.1)} disabled={scale <= TEXT_SCALE_MIN} title="Smaller text" aria-label="Smaller text">
            A−
          </button>
          <button className="btn small icon quiet" onClick={() => setScale(scale + 0.1)} disabled={scale >= TEXT_SCALE_MAX} title="Larger text" aria-label="Larger text">
            A+
          </button>
        </div>
        <label className="opacity" title="Window opacity">
          <span>Opacity</span>
          <input
            type="range"
            min={0.6}
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
