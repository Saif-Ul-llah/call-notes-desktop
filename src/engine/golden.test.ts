// Golden-clip accuracy/speed test: runs real audio through the bundled whisper models
// and the romanizer, and reports WER/CER against reference transcripts.
// Run with: npm run golden   (skipped in the normal unit test run)

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cleanTranscript } from '../shared/romanizer'
import { MODELS, VAD_MODEL_FILE, audioCtxFor } from '../shared/models'
import type { ModelId } from '../shared/types'
import { cropToSpeech } from './crop'
import { loadWhisper } from './whisper-loader'

const ROOT = join(__dirname, '..', '..')
const AUDIO_DIR = process.env.GOLDEN_AUDIO_DIR ?? join(ROOT, 'test-audio')
const MODELS_DIR = join(ROOT, 'resources', 'models')
const NATIVE = join(ROOT, 'native', `${process.platform}-${process.arch}-avx2`, 'index.node')
const enabled = process.env.GOLDEN === '1'
// knobs for comparing decode settings: GOLDEN_MODELS=swift GOLDEN_AUDIO_CTX=1 GOLDEN_FA=1 GOLDEN_BEAM=1
const onlyModels = process.env.GOLDEN_MODELS?.split(',')
const useAudioCtx = process.env.GOLDEN_AUDIO_CTX === '1'
const flashAttn = process.env.GOLDEN_FA === '1'
const beam = Number(process.env.GOLDEN_BEAM ?? 5)

/** Decode PCM16 / float32 WAV (any rate, any channels) to 16 kHz mono PCM16. */
export function decodeWavTo16k(buf: Buffer): Int16Array {
  let off = 12
  let fmt = { format: 1, channels: 1, rate: 16000, bits: 16 }
  let data: Buffer | null = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
      if (fmt.format === 0xfffe) fmt.format = buf.readUInt16LE(off + 32) // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      data = buf.subarray(off + 8, off + 8 + size)
    }
    off += 8 + size + (size % 2)
  }
  if (!data) throw new Error('no data chunk')
  const bytes = fmt.bits / 8
  const frames = Math.floor(data.length / (bytes * fmt.channels))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c++) {
      const p = (i * fmt.channels + c) * bytes
      sum += fmt.format === 3 ? data.readFloatLE(p) : fmt.bits === 16 ? data.readInt16LE(p) / 32768 : data.readInt32LE(p) / 2147483648
    }
    mono[i] = sum / fmt.channels
  }
  const ratio = fmt.rate / 16000
  const out = new Int16Array(Math.floor(frames / ratio))
  for (let i = 0; i < out.length; i++) {
    // box-filter decimation (cheap anti-aliasing)
    const from = Math.floor(i * ratio)
    const to = Math.max(from + 1, Math.floor((i + 1) * ratio))
    let s = 0
    for (let j = from; j < to && j < frames; j++) s += mono[j]
    out[i] = Math.max(-32768, Math.min(32767, Math.round((s / (to - from)) * 32767)))
  }
  return out
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)

function editDistance<T>(a: T[], b: T[]): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return dp[a.length][b.length]
}

export const wer = (ref: string, hyp: string) => editDistance(norm(ref), norm(hyp)) / Math.max(1, norm(ref).length)
export const cer = (ref: string, hyp: string) => {
  const r = norm(ref).join(' ').split('')
  return editDistance(r, norm(hyp).join(' ').split('')) / Math.max(1, r.length)
}

describe.skipIf(!enabled)('golden clips', () => {
  const refs: Record<string, string> = existsSync(join(AUDIO_DIR, 'references.json'))
    ? JSON.parse(readFileSync(join(AUDIO_DIR, 'references.json'), 'utf8')).clips
    : {}
  const clips = readdirSync(AUDIO_DIR).filter((f) => f.endsWith('.wav'))
  const report: string[] = []
  afterAll(() => console.log('\n' + report.join('\n')))

  for (const id of Object.keys(MODELS) as ModelId[]) {
    const modelFile = join(MODELS_DIR, MODELS[id].file)
    it.skipIf(!existsSync(modelFile) || (onlyModels && !onlyModels.includes(id)))(`${id}: transcribes to Latin-only text`, async () => {
      const lib = await loadWhisper({ nativePath: process.env.GOLDEN_PREBUILT === '1' ? null : NATIVE, useGpu: false })
      report.push(`[${id}] backend: ${lib.variant}, audioCtx=${useAudioCtx}, flashAttn=${flashAttn}, beam=${beam}`)
      const ctx = await lib.initWhisper({ filePath: modelFile, useGpu: false, useFlashAttn: flashAttn })
      const vad = await lib.initWhisperVad({ filePath: join(MODELS_DIR, VAD_MODEL_FILE), useGpu: false, nThreads: 1 })
      let totalAudio = 0
      let totalProc = 0
      let werSum = 0
      let cerSum = 0
      let scored = 0
      for (const clip of clips) {
        const pcm = decodeWavTo16k(readFileSync(join(AUDIO_DIR, clip)))
        const full = pcm.buffer as ArrayBuffer
        // same gating/cropping as the engine applies to final slices
        const speech = await vad.detectSpeechData(full, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100 })
        const [padBefore, padAfter] = (process.env.GOLDEN_PAD ?? '450,750').split(',').map(Number)
        const audio = process.env.GOLDEN_NO_CROP === '1' ? full : cropToSpeech(full, speech, padBefore, padAfter)
        const t = Date.now()
        const { promise } = ctx.transcribeData(audio, {
          language: MODELS[id].language.roman, temperature: 0, beamSize: beam, bestOf: beam, maxThreads: 4,
          ...(useAudioCtx ? { audioCtx: audioCtxFor(pcm.length / 16) } : {}),
        } as Parameters<typeof ctx.transcribeData>[1])
        const raw = (await promise).result
        const ms = Date.now() - t
        const text = cleanTranscript(raw)
        totalAudio += pcm.length / 16
        totalProc += ms
        expect(text).toMatch(/^[\x20-\x7E]*$/)
        const ref = refs[clip]
        let score = ''
        if (ref) {
          const w = wer(ref, text)
          const c = cer(ref, text)
          werSum += w
          cerSum += c
          scored++
          score = ` WER ${(w * 100).toFixed(0)}% CER ${(c * 100).toFixed(0)}%`
        }
        report.push(`[${id}] ${clip.slice(0, 8)} ${(pcm.length / 16000).toFixed(1)}s -> ${ms}ms vad=${speech.length}${score}\n    hyp: ${text}\n    ref: ${ref ?? '-'}`)
      }
      report.push(
        `[${id}] real-time factor ${(totalProc / totalAudio).toFixed(2)}` +
          (scored ? `, mean WER ${((werSum / scored) * 100).toFixed(1)}%, mean CER ${((cerSum / scored) * 100).toFixed(1)}%` : ''),
      )
      await ctx.release()
      await vad.release()
    }, 3_600_000)
  }
})
