import { useEffect, useState } from 'react'
import type { LiveStatus } from '../../shared/types'

export const api = window.callNotes

export const IDLE_STATUS: LiveStatus = {
  sessionId: null,
  status: 'idle',
  startedAt: null,
  engine: 'loading',
  model: null,
  message: null,
  streams: {},
  pendingJobs: 0,
}

/** Subscribes to live session status. */
export function useLiveStatus(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(IDLE_STATUS)
  useEffect(() => {
    void api.session.snapshot().then((s) => setStatus(s.status))
    return api.session.onStatus(setStatus)
  }, [])
  return status
}

/** Live input levels (0..1) of the microphone and the system audio. */
export function useLevel(): { mic: number; system: number } {
  const [level, setLevel] = useState({ mic: 0, system: 0 })
  useEffect(() => api.session.onLevel(setLevel), [])
  return level
}

/** Seconds since `startedAt`, ticking every second. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startedAt])
  return startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : 0
}

export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  return h ? `${h}:${m}:${s}` : `${m}:${s}`
}

export function isLive(s: LiveStatus): boolean {
  return s.status === 'starting' || s.status === 'recording' || s.status === 'retrying' || s.status === 'stopping'
}

export function StatusPill({ status }: { status: LiveStatus }) {
  const [cls, label] =
    status.status === 'recording' ? ['live', 'Listening']
    : status.status === 'starting' ? ['brass', 'Starting']
    : status.status === 'retrying' ? ['warn', 'Reconnecting']
    : status.status === 'stopping' ? ['brass', 'Saving']
    : status.engine === 'restarting' ? ['warn', 'Restarting engine']
    : status.engine === 'loading' ? ['brass', 'Loading model']
    : status.pendingJobs > 0 ? ['brass', `Finishing ${status.pendingJobs}`]
    : ['ok', 'Ready']
  return (
    <span className={`pill ${cls}`} role="status">
      <span className="dot" />
      {label}
    </span>
  )
}

export const speakerClass = (speaker: string) => (speaker === 'Me' ? 'who-me' : speaker === 'Notice' ? 'who-notice' : 'who-them')
