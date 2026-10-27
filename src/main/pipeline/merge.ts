// Picks the next final job(s) for the engine: when lines are waiting, several of one
// stream and session go as one chunk (see engine-host.ts).

import type { FinalJob } from '../engine-host'

/** Waiting lines merged into one transcription hold at most this much audio. */
export const MERGE_MAX_MS = 15000

/** Take the next final plus, when lines are waiting, more of the same stream and session. */
export function takeFinals(queue: FinalJob[], maxMs = MERGE_MAX_MS): FinalJob[] {
  const first = queue.shift()
  if (!first) return []
  const parts = [first]
  let total = first.durationMs
  for (let i = 0; i < queue.length; ) {
    const j = queue[i]
    if (j.stream === first.stream && j.group === first.group && j.language === first.language) {
      if (total + j.durationMs > maxMs) break
      total += j.durationMs
      parts.push(j)
      queue.splice(i, 1)
    } else i++
  }
  return parts
}
