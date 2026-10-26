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

/** Seconds since `startedAt`, ticking every second. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!startedAt) return
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

export function StatusChip({ status }: { status: LiveStatus }) {
  if (status.status === 'recording') return <span className="chip live"><span className="dot" />Listening</span>
  if (status.status === 'starting') return <span className="chip gold"><span className="dot" />Starting…</span>
  if (status.status === 'retrying') return <span className="chip warn"><span className="dot" />Retrying</span>
  if (status.status === 'stopping') return <span className="chip gold"><span className="dot" />Saving…</span>
  if (status.engine === 'restarting') return <span className="chip warn"><span className="dot" />Engine restarting</span>
  if (status.engine === 'loading') return <span className="chip gold"><span className="dot" />Loading model</span>
  if (status.pendingJobs > 0) return <span className="chip gold"><span className="dot" />Finishing {status.pendingJobs}</span>
  return <span className="chip ok"><span className="dot" />Ready</span>
}

export function MicIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18v4" />
    </svg>
  )
}

export function StopIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
    </svg>
  )
}
