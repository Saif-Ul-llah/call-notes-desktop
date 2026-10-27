// Long-recording evaluation: chunk a real call/lecture by VAD and transcribe it with a
// chosen model and decode settings, writing timed text to JSON for comparison.
// Run with: LECTURE=<wav> LECTURE_OUT=<json> LECTURE_MODEL=apex npx vitest run src/engine/lecture-eval.test.ts

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { cleanTranscript } from '../shared/romanizer'
import { MODELS, VAD_MODEL_FILE, audioCtxFor } from '../shared/models'
import type { ModelId } from '../shared/types'
import { decodeWavTo16k } from './golden.test'
import { loadWhisper } from './whisper-loader'

const ROOT = join(__dirname, '..', '..')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const NATIVE = join(ROOT, 'native', `${process.platform}-${process.arch}-avx2`, 'index.node')
const file = process.env.LECTURE
const model = (process.env.LECTURE_MODEL ?? 'apex') as ModelId
const beam = Number(process.env.LECTURE_BEAM ?? 5)
const maxChunkMs = Number(process.env.LECTURE_MAX_MS ?? 25000)
const threads = Number(process.env.LECTURE_THREADS ?? 8)
const useCtx = process.env.LECTURE_AUDIO_CTX === '1'
const limitMs = Number(process.env.LECTURE_LIMIT_MS ?? Infinity)

describe.skipIf(!file)('lecture eval', () => {
  it('transcribes', async () => {
    const pcm = decodeWavTo16k(readFileSync(file!))
    const lib = await loadWhisper({ nativePath: NATIVE, useGpu: false })
    const vad = await lib.initWhisperVad({ filePath: join(MODELS_DIR, VAD_MODEL_FILE), useGpu: false, nThreads: 4 })
    const ctx = await lib.initWhisper({ filePath: join(MODELS_DIR, MODELS[model].file), useGpu: false })
    const speech = await vad.detectSpeechData(pcm.buffer as ArrayBuffer, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 300 })
    // merge VAD spans into chunks of at most maxChunkMs, splitting at the gaps
    const chunks: { start: number; end: number }[] = []
    for (const s of speech) {
      const t0 = s.t0 * 10
      const t1 = s.t1 * 10
      const last = chunks[chunks.length - 1]
      if (last && t1 - last.start <= maxChunkMs && t0 - last.end < 1500) last.end = t1
      else chunks.push({ start: t0, end: t1 })
    }
    const out: { start: number; end: number; ms: number; text: string }[] = []
    let proc = 0
    for (const c of chunks) {
      if (c.start > limitMs) break
      const a = Math.max(0, c.start - 300) * 16
      const b = Math.min(pcm.length, (c.end + 500) * 16)
      const audio = pcm.slice(a, b).buffer as ArrayBuffer
      const t = Date.now()
      const { promise } = ctx.transcribeData(audio, {
        language: MODELS[model].language.roman, temperature: 0, temperatureInc: Number(process.env.LECTURE_TEMP_INC ?? 0.2),
        beamSize: beam, bestOf: beam, maxThreads: threads,
        ...(useCtx ? { audioCtx: audioCtxFor((b - a) / 16 + 2000) } : {}),
      } as Parameters<typeof ctx.transcribeData>[1])
      const text = cleanTranscript((await promise).result)
      const ms = Date.now() - t
      proc += ms
      out.push({ start: c.start, end: c.end, ms, text })
      console.log(`[${(c.start / 1000).toFixed(1)}-${(c.end / 1000).toFixed(1)}] ${ms}ms ${text}`)
    }
    const audioMs = Math.min(limitMs, pcm.length / 16)
    console.log(`chunks=${out.length} proc=${proc}ms audio=${audioMs}ms rtf=${(proc / audioMs).toFixed(3)}`)
    writeFileSync(process.env.LECTURE_OUT ?? 'lecture.json', JSON.stringify({ model, beam, maxChunkMs, useCtx, proc, chunks: out }, null, 1))
    await ctx.release()
    await vad.release()
  }, 7_200_000)
})
