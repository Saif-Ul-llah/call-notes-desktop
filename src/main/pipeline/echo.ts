// When the user is on speakers (no headset), the microphone also hears the other side
// of the call, so the same words show up as both "Me" and "Them". A mic segment that
// overlaps a system segment in time and has mostly the same words is an echo.

import type { Segment } from '../../shared/types'

const tokens = (text: string): Set<string> =>
  new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1))

export function similarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  // overlap coefficient: a short echo fully contained in a longer line still counts
  return shared / Math.min(ta.size, tb.size)
}

export function overlaps(a: Pick<Segment, 'startMs' | 'endMs'>, b: Pick<Segment, 'startMs' | 'endMs'>, slackMs = 1500): boolean {
  return a.startMs <= b.endMs + slackMs && b.startMs <= a.endMs + slackMs
}

/** True when `mic` looks like the microphone picking up `system` audio from the speakers. */
export function isEcho(mic: Segment, system: Segment, threshold = 0.6): boolean {
  return mic.stream === 'mic' && system.stream === 'system' && overlaps(mic, system) && similarity(mic.text, system.text) >= threshold
}
