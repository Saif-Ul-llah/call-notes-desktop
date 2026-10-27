// Owns the whisper utility process: starts it, feeds it one job at a time, and restarts
// it with exponential backoff when it crashes, hangs or fails to load. Final jobs are
// persisted by the caller (DB + WAV on disk), so after a restart they are simply resent.
//
// Keeping up on a slow CPU: when lines are waiting, several of one stream are sent as
// one chunk (one encoder pass and more context; on a real 16-min lecture ~15 s chunks
// were ~1.7x cheaper and more accurate than single lines), and far behind, beam search
// is dropped.

import { EventEmitter } from 'node:events'
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { backoffDelay } from '../shared/session-state'
import type { EngineToHost, HostToEngine } from '../shared/engine-protocol'
import { MODELS, audioCtxFor } from '../shared/models'
import { takeFinals } from './pipeline/merge'
import type { EngineStatus, LanguageMode, ModelId, StreamId } from '../shared/types'

export interface FinalJob {
  id: string
  stream: StreamId
  wavPath: string
  /** resolved to a whisper language code for the loaded model when sent */
  language: LanguageMode
  prompt?: string
  durationMs: number
  /** times this job was in flight when the engine died */
  crashes: number
  /** jobs are only merged within one group (the session) */
  group?: string
}

interface PartialJob {
  id: string
  stream: StreamId
  pcm: ArrayBuffer
  language: LanguageMode
  prompt?: string
}

export interface EngineModel {
  id: ModelId
  path: string
}

export interface EngineHostOptions {
  /** Called on every (re)start so model fallback / settings changes take effect. */
  resolveModel: () => EngineModel
  vadPath: string | null
  /** optimized native build (AVX2); disabled automatically if it crashes while loading */
  nativePath: string | null
  threads: () => number
  useGpu: () => boolean
  log: (level: string, message: string) => void
}

export interface EngineHostEvents {
  status: [EngineStatus, string | null]
  /** `ids`: every job the text covers (several when waiting lines were merged), in time order */
  final: [{ id: string; ids: string[]; stream: StreamId; text: string; noSpeech: boolean; processMs: number; audioMs: number }]
  partial: [{ stream: StreamId; text: string }]
  'job-failed': [{ id: string; error: string }]
  'model-failed': [{ model: ModelId; error: string }]
}

/** With more lines than this still waiting, decode greedily. */
const FAR_BEHIND = 3

const PING_EVERY_MS = 2000
const PONG_TIMEOUT_MS = 20000
const MAX_INIT_FAILURES = 3
const MAX_JOB_CRASHES = 3

export class EngineHost extends EventEmitter<EngineHostEvents> {
  private proc: UtilityProcess | null = null
  private status: EngineStatus = 'stopped'
  private model: EngineModel | null = null
  private finals: FinalJob[] = []
  private partials = new Map<StreamId, PartialJob>()
  private inflight: { kind: 'final'; job: FinalJob; parts: FinalJob[] } | { kind: 'partial'; job: PartialJob } | null = null
  private inflightTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private lastPong = 0
  private restartAttempt = 0
  private initFailures = 0
  private stopping = false
  private nativeOk = true
  /** processing speed of finals (process ms per audio ms); previews only run while finals keep up easily */
  private finalSpeed = 0.3

  constructor(private opts: EngineHostOptions) {
    super()
  }

  get currentStatus(): EngineStatus {
    return this.status
  }

  get currentModel(): ModelId | null {
    return this.model?.id ?? null
  }

  get pendingCount(): number {
    return this.finals.length + (this.inflight?.kind === 'final' ? this.inflight.parts.length : 0)
  }

  start(): void {
    this.stopping = false
    if (this.proc) return
    this.spawn()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearTimers()
    const proc = this.proc
    this.proc = null
    if (proc) {
      const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()))
      proc.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))])
    }
    this.setStatus('stopped', null)
  }

  /** Restart with a freshly resolved model (settings change or fallback). */
  async reload(): Promise<void> {
    this.requeueInflight(false)
    await this.stop()
    this.restartAttempt = 0
    this.initFailures = 0
    this.start()
  }

  enqueueFinal(job: FinalJob): void {
    if (this.finals.some((j) => j.id === job.id) || (this.inflight?.kind === 'final' && this.inflight.parts.some((j) => j.id === job.id))) return
    this.finals.push(job)
    // a final supersedes the partial preview of the same stream
    this.partials.delete(job.stream)
    this.pump()
  }

  /** Partials are best-effort: dropped when the engine is behind or slow. */
  offerPartial(job: PartialJob): void {
    if (this.status !== 'ready' && this.status !== 'busy') return
    if (this.finals.length > 0) return
    // previews are a luxury: skip them when finals are slower than half real time
    // (busy CPU, big model), so committed text never falls behind
    if (this.finalSpeed > 0.5) return
    const audioMs = job.pcm.byteLength / 32
    if (audioMs * this.finalSpeed > 2500) return
    this.partials.set(job.stream, job)
    this.pump()
  }

  private send(msg: HostToEngine): void {
    this.proc?.postMessage(msg)
  }

  private setStatus(status: EngineStatus, message: string | null): void {
    this.status = status
    this.emit('status', status, message)
  }

  private spawn(): void {
    this.model = this.opts.resolveModel()
    this.setStatus('loading', `Loading ${this.model.id} model`)
    const proc = utilityProcess.fork(join(__dirname, 'engine.js'), [], {
      serviceName: 'Call Notes Whisper Engine',
      stdio: 'pipe',
    })
    this.proc = proc
    proc.stdout?.on('data', (d) => this.opts.log('info', `[engine] ${String(d).trim()}`))
    // whisper.cpp writes its progress chatter to stderr
    proc.stderr?.on('data', (d) => this.opts.log('debug', `[engine] ${String(d).trim()}`))
    proc.on('message', (msg: EngineToHost) => this.onMessage(msg))
    proc.once('exit', (code) => this.onExit(proc, code))
    this.send({
      type: 'init',
      modelPath: this.model.path,
      vadPath: this.opts.vadPath,
      nativePath: this.nativeOk ? this.opts.nativePath : null,
      useGpu: this.opts.useGpu(),
      threads: this.opts.threads(),
    })
    this.lastPong = Date.now()
    this.pingTimer = setInterval(() => this.heartbeat(), PING_EVERY_MS)
  }

  private heartbeat(): void {
    if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
      this.opts.log('error', 'engine stopped answering pings, restarting')
      this.proc?.kill()
      return
    }
    this.send({ type: 'ping', t: Date.now() })
  }

  private onMessage(msg: EngineToHost): void {
    switch (msg.type) {
      case 'pong':
        this.lastPong = Date.now()
        break
      case 'log':
        this.opts.log(msg.level, `[engine] ${msg.message}`)
        break
      case 'ready':
        this.restartAttempt = 0
        this.initFailures = 0
        this.opts.log('info', `engine ready (${this.model?.id}, ${msg.backend}, ${msg.loadMs} ms, gpu=${msg.gpu})`)
        this.setStatus('ready', null)
        this.pump()
        break
      case 'init-error':
        this.initFailures++
        this.opts.log('error', `model load failed (${this.initFailures}/${MAX_INIT_FAILURES}): ${msg.error}`)
        if (this.initFailures >= MAX_INIT_FAILURES && this.model) {
          // let the owner pick a fallback model; resolveModel() is called again on restart
          this.emit('model-failed', { model: this.model.id, error: msg.error })
          this.initFailures = 0
        }
        this.proc?.kill()
        break
      case 'bench':
        break
      case 'result': {
        const parts = this.inflight?.kind === 'final' && this.inflight.job.id === msg.id ? this.inflight.parts : null
        this.finishInflight(msg.id)
        if (msg.kind === 'final' && msg.audioMs > 0 && !msg.noSpeech) {
          this.finalSpeed = this.finalSpeed * 0.6 + (msg.processMs / msg.audioMs) * 0.4
        }
        if (msg.kind === 'final') {
          const ids = parts?.map((j) => j.id) ?? [msg.id]
          this.emit('final', { id: msg.id, ids, stream: msg.stream, text: msg.text, noSpeech: msg.noSpeech, processMs: msg.processMs, audioMs: msg.audioMs })
        } else {
          this.emit('partial', { stream: msg.stream, text: msg.text })
        }
        this.pump()
        break
      }
      case 'job-error': {
        const parts = this.inflight?.kind === 'final' && this.inflight.job.id === msg.id ? this.inflight.parts : null
        this.finishInflight(msg.id)
        if (msg.kind === 'final') for (const id of parts?.map((j) => j.id) ?? [msg.id]) this.emit('job-failed', { id, error: msg.error })
        this.pump()
        break
      }
    }
  }

  private onExit(proc: UtilityProcess, code: number): void {
    if (proc !== this.proc) return // an old process we already replaced
    this.proc = null
    this.clearTimers()
    if (this.stopping) return
    if (this.status === 'loading' && this.nativeOk && this.opts.nativePath) {
      // died while loading: possibly the optimized build is unsupported here (SIGILL)
      this.nativeOk = false
      this.opts.log('warn', 'engine crashed while loading; falling back to the portable whisper build')
    }
    this.requeueInflight(true)
    const delay = backoffDelay(this.restartAttempt++)
    this.opts.log('warn', `engine exited (code ${code}); restarting in ${delay} ms`)
    this.setStatus('restarting', `Speech engine restarting (attempt ${this.restartAttempt})`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) this.spawn()
    }, delay)
  }

  /** Put the in-flight job back at the head of the queue after a crash/stop. */
  private requeueInflight(countCrash: boolean): void {
    const cur = this.inflight
    this.inflight = null
    if (this.inflightTimer) clearTimeout(this.inflightTimer)
    this.inflightTimer = null
    if (!cur || cur.kind !== 'final') return
    const back: FinalJob[] = []
    for (const job of cur.parts) {
      if (countCrash) job.crashes++
      // poison job: it keeps killing the engine; give up on it (audio is still archived)
      if (job.crashes >= MAX_JOB_CRASHES) this.emit('job-failed', { id: job.id, error: 'engine crashed repeatedly on this audio slice' })
      else back.push(job)
    }
    this.finals.unshift(...back)
  }

  private finishInflight(id: string): void {
    if (this.inflight?.job.id !== id) return
    this.inflight = null
    if (this.inflightTimer) clearTimeout(this.inflightTimer)
    this.inflightTimer = null
    if (this.status === 'busy') this.setStatus('ready', null)
  }

  /** Language code and prompt depend on the model actually loaded (it may have fallen back). */
  private decodeOptions(language: LanguageMode, prompt?: string): { language: string; prompt?: string } {
    const spec = MODELS[this.model!.id]
    return { language: spec.language[language], prompt: spec.usePrompt ? prompt : undefined }
  }

  private pump(): void {
    if (!this.proc || !this.model || this.inflight || (this.status !== 'ready' && this.status !== 'busy')) return
    const parts = takeFinals(this.finals)
    if (parts.length > 0) {
      const final = parts[0]
      this.inflight = { kind: 'final', job: final, parts }
      if (parts.length > 1) this.opts.log('debug', `merging ${parts.length} waiting lines into one chunk`)
      this.send({
        type: 'transcribe', id: final.id, kind: 'final', stream: final.stream, wavPath: final.wavPath,
        wavPaths: parts.length > 1 ? parts.map((j) => j.wavPath) : undefined, fast: this.finals.length > FAR_BEHIND,
        ...this.decodeOptions(final.language, final.prompt),
      })
      // a hung native call is detected here (pings still answer while native code runs)
      this.armTimeout(Math.max(30000, parts.reduce((n, j) => n + j.durationMs, 0) * 10))
    } else {
      const [stream, partial] = this.partials.entries().next().value ?? []
      if (!stream || !partial) return
      this.partials.delete(stream)
      this.inflight = { kind: 'partial', job: partial }
      this.send({
        type: 'transcribe', id: partial.id, kind: 'partial', stream: partial.stream, pcm: partial.pcm,
        audioCtx: audioCtxFor(partial.pcm.byteLength / 32), ...this.decodeOptions(partial.language, partial.prompt),
      })
      this.armTimeout(20000)
    }
    this.setStatus('busy', null)
  }

  private armTimeout(ms: number): void {
    this.inflightTimer = setTimeout(() => {
      this.opts.log('error', `transcription exceeded ${ms} ms, restarting engine`)
      this.proc?.kill()
    }, ms)
  }

  private clearTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.inflightTimer) clearTimeout(this.inflightTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.pingTimer = this.inflightTimer = this.restartTimer = null
  }
}

/**
 * Benchmark a model in a separate, throwaway engine process: a slow model blocks its
 * process for a long time, which must never happen to the engine serving transcriptions.
 * Resolves with the encoder time for a 30 s window, or Infinity on timeout/failure.
 */
export function probeModelSpeed(opts: {
  modelPath: string
  nativePath: string | null
  threads: number
  timeoutMs: number
}): Promise<number> {
  return new Promise((resolve) => {
    const proc = utilityProcess.fork(join(__dirname, 'engine.js'), [], { serviceName: 'Call Notes Model Benchmark', stdio: 'ignore' })
    let done = false
    const finish = (ms: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      proc.kill()
      resolve(ms)
    }
    const timer = setTimeout(() => finish(Number.POSITIVE_INFINITY), opts.timeoutMs)
    proc.on('message', (msg: EngineToHost) => {
      if (msg.type === 'ready') proc.postMessage({ type: 'bench', threads: opts.threads } satisfies HostToEngine)
      else if (msg.type === 'init-error') finish(Number.POSITIVE_INFINITY)
      else if (msg.type === 'bench') finish(msg.encodeMs)
    })
    proc.once('exit', () => finish(Number.POSITIVE_INFINITY))
    proc.postMessage({
      type: 'init', modelPath: opts.modelPath, vadPath: null, nativePath: opts.nativePath, useGpu: false, threads: opts.threads,
    } satisfies HostToEngine)
  })
}
