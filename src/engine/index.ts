// Whisper engine — runs in an Electron utilityProcess so a native crash or OOM in
// whisper.cpp never takes the app down. EngineHost (main) restarts it and replays jobs.

import { readFileSync } from 'node:fs'
import type { WhisperContext, WhisperVadContext } from '@fugood/whisper.node'
import type { EngineToHost, HostToEngine } from '../shared/engine-protocol'
import { cropToSpeech } from './crop'
import { loadWhisper } from './whisper-loader'

const port = process.parentPort

let whisper: WhisperContext | null = null
let vad: WhisperVadContext | null = null
let threads = 4

const send = (msg: EngineToHost) => port.postMessage(msg)
const log = (level: 'info' | 'warn' | 'error', message: string) => send({ type: 'log', level, message })

function pcmFromWav(path: string): ArrayBuffer {
  const buf = readFileSync(path)
  // payload of our own 44-byte header WAVs; scan for "data" to be safe
  const dataAt = buf.indexOf('data', 12, 'ascii')
  const start = dataAt >= 0 ? dataAt + 8 : 44
  const end = buf.length - ((buf.length - start) % 2)
  return buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + end) as ArrayBuffer
}

async function init(msg: Extract<HostToEngine, { type: 'init' }>) {
  const started = Date.now()
  threads = msg.threads
  try {
    await whisper?.release().catch(() => undefined)
    await vad?.release().catch(() => undefined)
    const lib = await loadWhisper({ nativePath: msg.nativePath, useGpu: msg.useGpu })
    log('info', `whisper.cpp backend: ${lib.variant}`)
    whisper = await lib.initWhisper({ filePath: msg.modelPath, useGpu: msg.useGpu })
    vad = null
    if (msg.vadPath) {
      try {
        vad = await lib.initWhisperVad({ filePath: msg.vadPath, useGpu: false, nThreads: 1 })
      } catch (err) {
        log('warn', `VAD unavailable, continuing without it: ${err}`)
      }
    }
    send({ type: 'ready', loadMs: Date.now() - started, gpu: msg.useGpu, backend: lib.variant })
  } catch (err) {
    send({ type: 'init-error', error: String(err instanceof Error ? err.message : err) })
  }
}

async function transcribe(msg: Extract<HostToEngine, { type: 'transcribe' }>) {
  if (!whisper) {
    send({ type: 'job-error', id: msg.id, kind: msg.kind, error: 'engine not initialised' })
    return
  }
  const started = Date.now()
  try {
    let pcm = msg.pcm ?? pcmFromWav(msg.wavPath!)
    const audioMs = Math.round(pcm.byteLength / 32) // 16 kHz * 2 bytes = 32 bytes/ms

    // Gate finals with Silero VAD and crop them to the detected speech: whisper
    // hallucinates on silence/noise, especially at the start of a slice.
    if (msg.kind === 'final' && vad) {
      const speech = await vad.detectSpeechData(pcm, { threshold: 0.5, minSpeechDurationMs: 250, minSilenceDurationMs: 100 })
      if (speech.length === 0) {
        send({ type: 'result', id: msg.id, kind: msg.kind, stream: msg.stream, text: '', noSpeech: true, audioMs, processMs: Date.now() - started })
        return
      }
      pcm = cropToSpeech(pcm, speech)
    }

    // Finals: beam search over the full 30 s window (greedy decoding and shortened
    // windows cost the small Hinglish model ~2x WER in the golden-clip test).
    // Partials are throwaway previews, so they take the fast path.
    const final = msg.kind === 'final'
    const { promise } = whisper.transcribeData(pcm, {
      language: msg.language,
      maxThreads: threads,
      temperature: 0,
      temperatureInc: 0.2,
      beamSize: final ? 5 : 1,
      bestOf: final ? 5 : 1,
      prompt: msg.prompt,
      ...(msg.audioCtx ? { audioCtx: msg.audioCtx } : {}),
    } as Parameters<WhisperContext['transcribeData']>[1])
    const result = await promise
    send({
      type: 'result',
      id: msg.id,
      kind: msg.kind,
      stream: msg.stream,
      text: result.result.trim(),
      noSpeech: false,
      audioMs,
      processMs: Date.now() - started,
    })
  } catch (err) {
    send({ type: 'job-error', id: msg.id, kind: msg.kind, error: String(err instanceof Error ? err.message : err) })
  }
}

async function bench(nThreads: number) {
  if (!whisper) return
  try {
    const r = await whisper.bench(nThreads)
    send({ type: 'bench', encodeMs: r.encodeMs })
  } catch (err) {
    log('warn', `bench failed: ${err}`)
    send({ type: 'bench', encodeMs: Number.POSITIVE_INFINITY })
  }
}

// Messages are processed strictly one at a time: a whisper context is not re-entrant.
let chain: Promise<void> = Promise.resolve()

port.on('message', (event: { data: HostToEngine }) => {
  const msg = event.data
  if (msg.type === 'ping') {
    // answered immediately, even while a transcription runs on the native thread
    send({ type: 'pong', t: msg.t })
    return
  }
  chain = chain.then(async () => {
    if (msg.type === 'init') await init(msg)
    else if (msg.type === 'transcribe') await transcribe(msg)
    else if (msg.type === 'bench') await bench(msg.threads)
  })
})

process.on('uncaughtException', (err) => {
  log('error', `uncaught: ${err.stack ?? err}`)
  process.exit(1)
})

log('info', `engine process started (pid ${process.pid})`)
