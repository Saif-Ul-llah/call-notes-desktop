import { describe, expect, it } from 'vitest'
import type { FinalJob } from '../engine-host'
import { MERGE_MAX_MS, takeFinals } from './merge'

const job = (id: string, durationMs: number, stream: FinalJob['stream'] = 'system', group = 's1'): FinalJob => ({
  id, stream, wavPath: `${id}.wav`, language: 'roman', durationMs, crashes: 0, group,
})

describe('takeFinals', () => {
  it('takes a lone job as is', () => {
    const q = [job('a', 3000)]
    expect(takeFinals(q).map((j) => j.id)).toEqual(['a'])
    expect(q).toEqual([])
  })

  it('merges waiting jobs of the same stream and session up to the chunk limit', () => {
    const q = [job('a', 4000), job('b', 2000, 'mic'), job('c', 5000), job('d', 3000, 'system', 's2'), job('e', 5000), job('f', 4000)]
    const parts = takeFinals(q)
    expect(parts.map((j) => j.id)).toEqual(['a', 'c', 'e'])
    expect(parts.reduce((n, j) => n + j.durationMs, 0)).toBeLessThanOrEqual(MERGE_MAX_MS)
    // other streams/sessions and the job that would overflow stay queued, in order
    expect(q.map((j) => j.id)).toEqual(['b', 'd', 'f'])
  })
})
