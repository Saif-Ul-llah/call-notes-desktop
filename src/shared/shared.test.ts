import { describe, expect, it } from 'vitest'
import { backoffDelay, canTransition, transition } from './session-state'
import { formatClock, toMarkdown, toParagraphs, toSrt, toTranscriptDoc } from './transcript-format'
import type { Segment, SessionInfo } from './types'

describe('session state machine', () => {
  it('follows the happy path', () => {
    let s = transition('idle', 'START')
    s = transition(s, 'STARTED')
    s = transition(s, 'STOP')
    s = transition(s, 'STOPPED')
    expect(s).toBe('saved')
  })
  it('retries and recovers', () => {
    let s = transition('recording', 'FAILURE')
    expect(s).toBe('retrying')
    s = transition(s, 'FAILURE')
    s = transition(s, 'RECOVERED')
    expect(s).toBe('recording')
  })
  it('marks crashed sessions interrupted', () => {
    expect(transition('recording', 'CRASH_DETECTED')).toBe('interrupted')
    expect(transition('interrupted', 'STOPPED')).toBe('saved')
  })
  it('rejects invalid transitions', () => {
    expect(() => transition('idle', 'STOP')).toThrow()
    expect(canTransition('saved', 'START')).toBe(false)
  })
  it('backs off exponentially with a cap', () => {
    const d = [0, 1, 2, 3, 10].map((a) => backoffDelay(a, 1000, 30000, 0))
    expect(d).toEqual([1000, 2000, 4000, 8000, 30000])
  })
})

describe('transcript formats', () => {
  const session: SessionInfo = {
    id: 's1', title: 'Weekly sync', startedAt: Date.UTC(2026, 9, 26, 10), endedAt: Date.UTC(2026, 9, 26, 10, 5),
    status: 'saved', language: 'roman', model: 'swift', platform: 'desktop', dir: '/tmp/x', parentId: null,
  }
  const segs: Segment[] = [
    { id: 'b', sessionId: 's1', stream: 'system', speaker: 'Them', startMs: 4000, endMs: 6000, text: 'theek hai, kal tak bhej dena' },
    { id: 'a', sessionId: 's1', stream: 'mic', speaker: 'Me', startMs: 0, endMs: 2000, text: 'Report ready hai' },
    { id: 'c', sessionId: 's1', stream: 'system', speaker: 'Them', startMs: 6500, endMs: 7000, text: 'shukriya' },
  ]
  it('formats clocks', () => {
    expect(formatClock(65000)).toBe('01:05')
    expect(formatClock(3725000)).toBe('1:02:05')
  })
  it('merges same-speaker runs into paragraphs', () => {
    const p = toParagraphs(segs)
    expect(p.map((x) => x.speaker)).toEqual(['Me', 'Them'])
    expect(p[1].text).toBe('theek hai, kal tak bhej dena shukriya')
  })
  it('renders markdown and srt', () => {
    expect(toMarkdown(session, segs)).toContain('**[00:04] Them:** theek hai')
    expect(toSrt(segs)).toMatch(/^1\n00:00:00,000 --> 00:00:02,000\nMe: Report ready hai/)
  })
  it('builds the phase-2 json doc sorted by time', () => {
    const doc = toTranscriptDoc(session, segs)
    expect(doc.version).toBe(1)
    expect(doc.segments.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(doc.session).not.toHaveProperty('dir')
  })
})
