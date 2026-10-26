import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { isEcho, similarity } from './echo'
import { Slicer } from './slicer'
import { readWavPcm, writeWav } from './wav'
import type { Segment } from '../../shared/types'

const SR = 16000

function tone(ms: number, amp = 0.3, freq = 220): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * amp * 32767)
  return out
}

function noise(ms: number, amp = 0.001): Int16Array {
  const n = Math.round((SR * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round((Math.random() * 2 - 1) * amp * 32767)
  return out
}

function feed(slicer: Slicer, parts: Int16Array[], chunkMs = 100) {
  const events = []
  for (const part of parts) {
    const step = (SR * chunkMs) / 1000
    for (let i = 0; i < part.length; i += step) events.push(...slicer.push(part.subarray(i, i + step)))
  }
  return events
}

describe('Slicer', () => {
  it('emits one final slice per utterance separated by silence', () => {
    const slicer = new Slicer()
    const events = feed(slicer, [noise(1000), tone(1500), noise(1200), tone(1000), noise(1200)])
    const finals = events.filter((e) => e.type === 'final')
    expect(finals).toHaveLength(2)
    expect(finals[0].startMs).toBeGreaterThan(600)
    expect(finals[0].startMs).toBeLessThan(1100)
    expect(finals[0].endMs).toBeGreaterThan(2400)
    expect(finals[1].startMs).toBeGreaterThan(3300)
  })

  it('emits partials during long speech and splits at maxSliceMs', () => {
    const slicer = new Slicer({ maxSliceMs: 5000, partialEveryMs: 1000 })
    const events = feed(slicer, [noise(500), tone(12000), noise(1500)])
    const finals = events.filter((e) => e.type === 'final')
    const partials = events.filter((e) => e.type === 'partial')
    expect(finals.length).toBe(3)
    expect(partials.length).toBeGreaterThanOrEqual(6)
    // slices are contiguous
    expect(finals[1].startMs).toBe(finals[0].endMs)
  })

  it('ignores clicks shorter than minSpeechMs', () => {
    const slicer = new Slicer()
    const events = feed(slicer, [noise(1000), tone(150), noise(1500)])
    expect(events.filter((e) => e.type === 'final')).toHaveLength(0)
  })

  it('adapts to a loud noise floor', () => {
    const slicer = new Slicer()
    const events = feed(slicer, [noise(3000, 0.02), noise(3000, 0.02)])
    expect(events.filter((e) => e.type === 'final')).toHaveLength(0)
  })

  it('flush closes an open slice', () => {
    const slicer = new Slicer()
    feed(slicer, [noise(500), tone(2000)])
    const out = slicer.flush()
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('final')
  })
})

describe('echo detection', () => {
  const seg = (stream: 'mic' | 'system', text: string, startMs: number, endMs: number): Segment => ({
    id: Math.random().toString(36), sessionId: 's', stream, speaker: stream === 'mic' ? 'Me' : 'Them', startMs, endMs, text,
  })
  it('flags mic segments that repeat system audio', () => {
    expect(isEcho(seg('mic', 'kal meeting kitne baje hai', 1000, 3000), seg('system', 'Kal meeting kitne baje hai?', 900, 2900))).toBe(true)
  })
  it('keeps short genuine replies that repeat words just heard', () => {
    expect(isEcho(seg('mic', 'haan theek hai', 2950, 3800), seg('system', 'report kal tak theek hai', 900, 2900))).toBe(false)
  })
  it('requires the echo to happen at the same moment', () => {
    expect(isEcho(seg('mic', 'kal meeting kitne baje hai', 3500, 5500), seg('system', 'kal meeting kitne baje hai', 900, 2900))).toBe(false)
  })
  it('keeps genuine replies', () => {
    expect(isEcho(seg('mic', 'shaam paanch baje', 3200, 4500), seg('system', 'kal meeting kitne baje hai', 900, 2900))).toBe(false)
  })
  it('requires time overlap', () => {
    expect(isEcho(seg('mic', 'theek hai', 60000, 61000), seg('system', 'theek hai', 1000, 2000))).toBe(false)
  })
  it('similarity is symmetric-ish and bounded', () => {
    expect(similarity('a b c', '')).toBe(0)
    expect(similarity('hello there friend', 'hello there friend')).toBe(1)
  })
})

describe('wav', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wav-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  it('round-trips pcm', () => {
    const pcm = tone(250)
    const p = join(dir, 'a.wav')
    writeWav(p, pcm)
    expect(Array.from(readWavPcm(p))).toEqual(Array.from(pcm))
  })
})
