// Orchestrates a recording session:
//   capture (mic + system audio) -> slicer -> WAV on disk + job row -> EngineHost
//   -> romanizer -> segment row -> UI + transcript.md/json
// Everything is written to disk before it is transcribed, so a crash anywhere
// loses nothing: on next launch interrupted sessions are closed and their queued
// slices are transcribed.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanTranscript } from '../shared/romanizer'
import { LIVE_STATES, backoffDelay, canTransition, transition, type SessionEvent, type SessionState } from '../shared/session-state'
import { sessionTitle, toMarkdown, toTranscriptDoc } from '../shared/transcript-format'
import { MODELS, ROMAN_STYLE_PROMPT } from '../shared/models'
import type { CaptureCommand, CaptureEvent, SystemCaptureMode } from '../shared/capture-protocol'
import type { LanguageMode, LiveStatus, PartialLine, Segment, SessionInfo, StreamId } from '../shared/types'
import type { Store } from './db'
import type { EngineHost } from './engine-host'
import type { SettingsStore } from './settings'
import { LinuxSystemAudio } from './capture/linux-system-audio'
import { WavFeed } from './capture/wav-feed'
import { isEcho } from './pipeline/echo'
import { Slicer } from './pipeline/slicer'
import { writeWav } from './pipeline/wav'

const SPEAKER: Record<StreamId, string> = { mic: 'Me', system: 'Them' }
const STALL_MS = 10000
const START_TIMEOUT_MS = 15000
const MAX_JOB_ATTEMPTS = 3

interface StreamState {
  slicer: Slicer | null
  /** session-relative ms of the first sample since the stream (re)started */
  offsetMs: number
  status: 'active' | 'retrying' | 'off'
  attempt: number
  lastDataAt: number
  failedAt: number | null
  retryTimer: NodeJS.Timeout | null
  context: string
}

interface ActiveSession {
  info: SessionInfo
  t0: number
  language: LanguageMode
  streams: Map<StreamId, StreamState>
  systemMode: SystemCaptureMode
  linux: LinuxSystemAudio | WavFeed | null
  archive: boolean
  archiveFiles: Map<number, string>
  stallTimer: NodeJS.Timeout
  startTimer: NodeJS.Timeout | null
}

export interface CaptureChannel {
  send(cmd: CaptureCommand): void
}

export interface SessionManagerEvents {
  status: [LiveStatus]
  segment: [Segment]
  'segment-removed': [{ sessionId: string; id: string }]
  partial: [PartialLine]
  saved: [SessionInfo]
}

export function systemCaptureMode(enabled: boolean): SystemCaptureMode {
  if (!enabled) return 'off'
  if (process.platform === 'linux') return 'bridge'
  return 'loopback'
}

/** Dev/test only: a WAV file played as the "Them" stream instead of real capture; the mic is off. */
const TEST_FEED = process.env.CALLNOTES_TEST_FEED || null

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  private state: SessionState = 'idle'
  private cur: ActiveSession | null = null
  private message: string | null = null
  private writeTimers = new Map<string, NodeJS.Timeout>()
  private stopWaiter: (() => void) | null = null

  constructor(
    private store: Store,
    private settings: SettingsStore,
    private engine: EngineHost,
    private capture: CaptureChannel,
    private log: (level: string, msg: string) => void,
  ) {
    super()
    engine.on('final', (r) => this.onFinal(r))
    engine.on('partial', (r) => this.onPartial(r))
    engine.on('job-failed', (r) => this.onJobFailed(r.id, r.error))
    engine.on('status', () => this.emitStatus())
  }

  get active(): boolean {
    return this.cur !== null
  }

  get activeSessionId(): string | null {
    return this.cur?.info.id ?? null
  }

  status(): LiveStatus {
    const streams: LiveStatus['streams'] = {}
    this.cur?.streams.forEach((s, id) => (streams[id] = s.status))
    return {
      sessionId: this.cur?.info.id ?? null,
      status: this.state,
      startedAt: this.cur?.t0 ?? null,
      engine: this.engine.currentStatus,
      model: this.engine.currentModel,
      message: this.message,
      streams,
      pendingJobs: this.engine.pendingCount,
    }
  }

  private emitStatus(): void {
    this.emit('status', this.status())
  }

  private fire(event: SessionEvent): void {
    if (!canTransition(this.state, event)) return
    this.state = transition(this.state, event)
    if (this.cur && this.state !== 'idle') {
      this.cur.info.status = this.state as SessionInfo['status']
      this.store.updateSession(this.cur.info.id, { status: this.cur.info.status })
    }
    this.emitStatus()
  }

  // ------------------------------------------------------------------ lifecycle

  /** Close sessions left open by a crash and requeue their untranscribed slices. */
  recover(): SessionInfo[] {
    const crashed = this.store.sessionsWithStatus(LIVE_STATES)
    for (const s of crashed) {
      const end = this.store.lastSegmentEnd(s.id)
      this.store.updateSession(s.id, { status: 'interrupted', endedAt: s.startedAt + (end ?? 0) })
      this.log('warn', `session ${s.id} was interrupted by a crash; marked interrupted`)
    }
    for (const job of this.store.pendingJobs()) {
      if (!existsSync(job.wavPath)) {
        this.store.completeJob(job.id)
        continue
      }
      this.engine.enqueueFinal({
        id: job.id, stream: job.stream, wavPath: job.wavPath, language: job.language as LanguageMode,
        durationMs: job.endMs - job.startMs, crashes: 0,
      })
    }
    for (const s of crashed) this.scheduleTranscriptWrite(s.id, 0)
    return crashed.map((s) => this.store.getSession(s.id)!).filter(Boolean)
  }

  toggle(): void {
    if (this.cur) void this.stop()
    else this.start()
  }

  start(opts: { parentId?: string; title?: string } = {}): SessionInfo | null {
    if (this.cur) return this.cur.info
    if (this.state === 'saved' || this.state === 'interrupted') this.fire('RESET')
    const settings = this.settings.get()
    const now = new Date()
    const id = randomUUID()
    const pad = (n: number) => String(n).padStart(2, '0')
    const dir = join(
      settings.storageDir,
      `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
      `${pad(now.getHours())}${pad(now.getMinutes())}-${id.slice(0, 8)}`,
    )
    mkdirSync(join(dir, 'pending'), { recursive: true })
    if (settings.saveAudio) mkdirSync(join(dir, 'audio'), { recursive: true })

    const info: SessionInfo = {
      id,
      title: opts.title ?? sessionTitle(now),
      startedAt: now.getTime(),
      endedAt: null,
      status: 'starting',
      language: settings.language,
      model: this.engine.currentModel ?? settings.model,
      platform: 'desktop',
      dir,
      parentId: opts.parentId ?? null,
    }
    this.store.createSession(info)

    const systemMode = TEST_FEED ? 'bridge' : systemCaptureMode(settings.captureSystemAudio)
    const streams = new Map<StreamId, StreamState>()
    const mkStream = (): StreamState => ({
      slicer: null, offsetMs: 0, status: 'retrying', attempt: 0, lastDataAt: Date.now(), failedAt: null, retryTimer: null, context: '',
    })
    if (!TEST_FEED) streams.set('mic', mkStream())
    if (systemMode !== 'off') streams.set('system', mkStream())

    this.cur = {
      info,
      t0: now.getTime(),
      language: settings.language,
      streams,
      systemMode,
      linux: null,
      archive: settings.saveAudio,
      archiveFiles: new Map(),
      stallTimer: setInterval(() => this.checkStalls(), 3000),
      startTimer: setTimeout(() => this.onStartTimeout(), START_TIMEOUT_MS),
    }
    this.message = null
    this.fire('START')

    this.engine.start()
    this.capture.send({ type: 'start', mic: !TEST_FEED, micDeviceId: settings.micDeviceId, system: systemMode, archive: settings.saveAudio })
    if (systemMode === 'bridge') this.startLinuxSystemAudio()
    this.log('info', `session ${id} started (system audio: ${systemMode})`)
    return info
  }

  async stop(): Promise<void> {
    const cur = this.cur
    if (!cur || this.state === 'stopping') return
    this.fire('STOP')
    this.message = 'Saving…'
    this.emitStatus()

    cur.linux?.stop()
    const stopped = new Promise<void>((resolve) => (this.stopWaiter = resolve))
    this.capture.send({ type: 'stop' })
    // wait for the capture window to flush the last audio archive chunk
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 4000))])
    this.stopWaiter = null

    for (const [stream, st] of cur.streams) {
      if (st.retryTimer) clearTimeout(st.retryTimer)
      for (const ev of st.slicer?.flush() ?? []) this.handleFinalSlice(cur, stream, st, ev.audio, ev.startMs, ev.endMs)
    }
    clearInterval(cur.stallTimer)
    if (cur.startTimer) clearTimeout(cur.startTimer)

    cur.info.endedAt = Date.now()
    this.store.updateSession(cur.info.id, { endedAt: cur.info.endedAt })
    this.cur = null
    this.fire('STOPPED')
    this.message = null
    // remaining queued slices keep transcribing in the background; transcript files
    // are rewritten as each one lands
    this.scheduleTranscriptWrite(cur.info.id, 0)
    this.emit('saved', this.store.getSession(cur.info.id)!)
    this.fire('RESET')
    this.log('info', `session ${cur.info.id} saved`)
  }

  resume(sessionId: string): SessionInfo | null {
    const prev = this.store.getSession(sessionId)
    if (!prev || this.cur) return null
    return this.start({ parentId: prev.id, title: `${prev.title.replace(/ \(continued\)$/, '')} (continued)` })
  }

  // ------------------------------------------------------------------ capture input

  onCaptureEvent(ev: CaptureEvent): void {
    const cur = this.cur
    switch (ev.type) {
      case 'stream-started':
        this.log('info', `capture ${ev.stream} started: ${ev.label}`)
        break
      case 'stream-failed':
        if (cur) this.onStreamFailure(cur, ev.stream, ev.message)
        break
      case 'archive-file':
        if (cur?.archive) {
          // index is a timestamp from the capture window, unique across capture restarts
          const path = join(cur.info.dir, 'audio', `recording-${ev.index}.webm`)
          cur.archiveFiles.set(ev.index, path)
          this.store.addAudioFile(cur.info.id, path, Date.now() - cur.t0)
        }
        break
      case 'stopped':
        this.stopWaiter?.()
        break
      case 'log':
        this.log('info', `[capture] ${ev.message}`)
        break
    }
  }

  /** The capture window crashed and was recreated: restart capture for the live session. */
  onCaptureRestarted(): void {
    const cur = this.cur
    if (!cur || this.state === 'stopping') return
    for (const [stream, st] of cur.streams) {
      if (stream === 'system' && cur.systemMode === 'bridge') continue // owned by main, unaffected
      for (const ev of st.slicer?.flush() ?? []) this.handleFinalSlice(cur, stream, st, ev.audio, ev.startMs, ev.endMs)
      st.slicer = null
      st.status = 'retrying'
      st.failedAt ??= Date.now()
      st.lastDataAt = Date.now()
    }
    this.message = 'Audio capture restarted'
    this.fire('FAILURE')
    const s = this.settings.get()
    this.capture.send({ type: 'start', mic: !TEST_FEED, micDeviceId: s.micDeviceId, system: cur.systemMode, archive: cur.archive })
  }

  onArchiveChunk(index: number, chunk: ArrayBuffer): void {
    const path = this.cur?.archiveFiles.get(index)
    if (!path) return
    try {
      appendFileSync(path, Buffer.from(chunk))
    } catch (err) {
      this.log('error', `audio archive write failed: ${err}`)
    }
  }

  onPcm(stream: StreamId, pcm: Int16Array): void {
    const cur = this.cur
    if (!cur || this.state === 'stopping') return
    const st = cur.streams.get(stream)
    if (!st) return
    const now = Date.now()
    if (!st.slicer) {
      // first audio since (re)start: anchor this stream's timeline to the session clock
      st.slicer = new Slicer()
      st.offsetMs = now - cur.t0 - Math.round(pcm.length / 16)
    }
    st.lastDataAt = now
    if (st.status !== 'active') this.onStreamRecovered(cur, stream, st)

    for (const ev of st.slicer.push(pcm)) {
      if (ev.type === 'final') this.handleFinalSlice(cur, stream, st, ev.audio, ev.startMs, ev.endMs)
      else if (this.settings.get().showPartials) {
        this.engine.offerPartial({
          id: `partial-${stream}-${now}`,
          stream,
          pcm: ev.audio.slice().buffer,
          language: cur.language,
          prompt: this.promptFor(cur, st),
        })
      }
    }
  }

  private handleFinalSlice(cur: ActiveSession, stream: StreamId, st: StreamState, audio: Int16Array, startMs: number, endMs: number): void {
    const id = randomUUID()
    const wavPath = join(cur.info.dir, 'pending', `${id}.wav`)
    try {
      writeWav(wavPath, audio)
    } catch (err) {
      this.log('error', `could not persist slice: ${err}`)
      return
    }
    const job = {
      id, sessionId: cur.info.id, stream, wavPath,
      startMs: st.offsetMs + startMs, endMs: st.offsetMs + endMs, language: cur.language,
    }
    this.store.addJob(job)
    this.engine.enqueueFinal({ id, stream, wavPath, language: cur.language, prompt: this.promptFor(cur, st), durationMs: endMs - startMs, crashes: 0 })
    this.emitStatus()
  }

  private promptFor(cur: ActiveSession, st: StreamState): string | undefined {
    if (st.context) return st.context
    return cur.language === 'roman' ? ROMAN_STYLE_PROMPT : undefined
  }

  // ------------------------------------------------------------------ failures & retries

  private startLinuxSystemAudio(): void {
    const cur = this.cur
    if (!cur) return
    cur.linux?.removeAllListeners()
    cur.linux?.stop()
    const rec = TEST_FEED ? new WavFeed(TEST_FEED) : new LinuxSystemAudio()
    cur.linux = rec
    rec.on('data', (pcm) => {
      this.onPcm('system', pcm)
      if (this.cur?.archive) this.capture.send({ type: 'system-pcm', pcm: pcm.buffer as ArrayBuffer })
    })
    rec.on('exit', (reason) => {
      if (this.cur && this.cur.linux === rec) this.onStreamFailure(this.cur, 'system', reason)
    })
    rec.start()
  }

  private onStartTimeout(): void {
    const cur = this.cur
    if (!cur) return
    cur.startTimer = null
    for (const [stream, st] of cur.streams) {
      if (!st.slicer && st.status !== 'active') this.onStreamFailure(cur, stream, 'no audio received after start')
    }
  }

  private checkStalls(): void {
    const cur = this.cur
    if (!cur || this.state === 'stopping') return
    const now = Date.now()
    for (const [stream, st] of cur.streams) {
      if (st.status === 'active' && now - st.lastDataAt > STALL_MS) {
        this.onStreamFailure(cur, stream, `no audio for ${Math.round((now - st.lastDataAt) / 1000)} s`)
      }
    }
  }

  private onStreamFailure(cur: ActiveSession, stream: StreamId, reason: string): void {
    const st = cur.streams.get(stream)
    if (!st || this.state === 'stopping') return
    if (st.retryTimer) return // retry already scheduled
    this.log('warn', `${stream} capture failed: ${reason}`)
    for (const ev of st.slicer?.flush() ?? []) this.handleFinalSlice(cur, stream, st, ev.audio, ev.startMs, ev.endMs)
    st.slicer = null
    st.status = 'retrying'
    st.failedAt ??= Date.now()
    this.message = `${stream === 'mic' ? 'Microphone' : 'System audio'}: ${reason} — retrying`
    this.fire('FAILURE')

    const delay = backoffDelay(st.attempt++)
    st.retryTimer = setTimeout(() => {
      st.retryTimer = null
      if (this.cur !== cur || this.state === 'stopping') return
      st.lastDataAt = Date.now()
      if (stream === 'system' && cur.systemMode === 'bridge') this.startLinuxSystemAudio()
      else this.capture.send({ type: 'restart', stream })
      // if nothing arrives the stall check / start timeout will fire again with a longer delay
      setTimeout(() => {
        if (this.cur === cur && !st.slicer && !st.retryTimer) this.onStreamFailure(cur, stream, 'still no audio')
      }, STALL_MS)
    }, delay)
    this.emitStatus()
  }

  private onStreamRecovered(cur: ActiveSession, stream: StreamId, st: StreamState): void {
    const gapFrom = st.failedAt
    st.status = 'active'
    st.attempt = 0
    st.failedAt = null
    if (st.retryTimer) clearTimeout(st.retryTimer)
    st.retryTimer = null
    if (gapFrom && Date.now() - gapFrom > 2000) {
      const seg: Segment = {
        id: randomUUID(), sessionId: cur.info.id, stream, speaker: 'Notice',
        startMs: gapFrom - cur.t0, endMs: Date.now() - cur.t0,
        text: `[${stream === 'mic' ? 'Microphone' : 'System audio'} was unavailable for ${Math.round((Date.now() - gapFrom) / 1000)} s]`,
      }
      this.store.addSegment(seg)
      this.emit('segment', seg)
    }
    const allActive = [...cur.streams.values()].every((s) => s.status === 'active')
    if (allActive || (stream === 'system' && TEST_FEED)) {
      this.message = null
      if (cur.startTimer && this.state === 'starting') {
        clearTimeout(cur.startTimer)
        cur.startTimer = null
      }
      this.fire(this.state === 'starting' ? 'STARTED' : 'RECOVERED')
    } else if (this.state === 'starting') {
      // mic is enough to be "recording"; system audio keeps retrying in the background
      if (stream === 'mic') this.fire('STARTED')
    }
    this.emitStatus()
  }

  // ------------------------------------------------------------------ engine results

  private onFinal(r: { id: string; stream: StreamId; text: string; noSpeech: boolean }): void {
    const job = this.store.getJob(r.id)
    if (!job) return
    const text = r.noSpeech ? '' : cleanTranscript(r.text)
    if (text) {
      const seg: Segment = {
        id: job.id, sessionId: job.sessionId, stream: job.stream, speaker: SPEAKER[job.stream],
        startMs: job.startMs, endMs: job.endMs, text, rawText: r.text,
      }
      if (!this.dropIfEcho(seg)) {
        this.store.addSegment(seg)
        this.emit('segment', seg)
      }
      const st = this.cur?.info.id === job.sessionId ? this.cur.streams.get(job.stream) : undefined
      if (st) st.context = text.slice(-200)
    }
    this.store.completeJob(job.id)
    try {
      unlinkSync(job.wavPath)
    } catch {
      /* already gone */
    }
    if (this.cur?.info.id === job.sessionId) {
      this.emit('partial', { sessionId: job.sessionId, stream: job.stream, speaker: SPEAKER[job.stream], startMs: job.endMs, text: '' })
    }
    this.scheduleTranscriptWrite(job.sessionId)
    this.emitStatus()
  }

  /** Echo suppression between "Me" (mic) and "Them" (system audio). Returns true if `seg` was dropped. */
  private dropIfEcho(seg: Segment): boolean {
    if (seg.stream === 'mic') {
      const others = this.store.recentSegments(seg.sessionId, 'system', seg.startMs - 5000)
      return others.some((o) => isEcho(seg, o))
    }
    for (const mic of this.store.recentSegments(seg.sessionId, 'mic', seg.startMs - 5000)) {
      if (mic.speaker !== 'Notice' && isEcho(mic, seg)) {
        this.store.deleteSegment(mic.id)
        this.emit('segment-removed', { sessionId: seg.sessionId, id: mic.id })
      }
    }
    return false
  }

  private onPartial(r: { stream: StreamId; text: string }): void {
    const cur = this.cur
    if (!cur || this.state === 'stopping') return
    this.emit('partial', { sessionId: cur.info.id, stream: r.stream, speaker: SPEAKER[r.stream], startMs: 0, text: cleanTranscript(r.text) })
  }

  private onJobFailed(id: string, error: string): void {
    const job = this.store.getJob(id)
    if (!job) return
    const attempts = this.store.failJob(id, error, MAX_JOB_ATTEMPTS)
    this.log('error', `transcription job ${id} failed (${attempts}/${MAX_JOB_ATTEMPTS}): ${error}`)
    if (attempts < MAX_JOB_ATTEMPTS) {
      setTimeout(() => {
        this.engine.enqueueFinal({
          id: job.id, stream: job.stream, wavPath: job.wavPath, language: job.language as LanguageMode,
          durationMs: job.endMs - job.startMs, crashes: 0,
        })
      }, backoffDelay(attempts))
    }
    this.emitStatus()
  }

  // ------------------------------------------------------------------ transcript files

  scheduleTranscriptWrite(sessionId: string, delayMs = 1500): void {
    const existing = this.writeTimers.get(sessionId)
    if (existing) clearTimeout(existing)
    this.writeTimers.set(
      sessionId,
      setTimeout(() => {
        this.writeTimers.delete(sessionId)
        this.writeTranscriptFiles(sessionId)
      }, delayMs),
    )
  }

  writeTranscriptFiles(sessionId: string): void {
    const session = this.store.getSession(sessionId)
    if (!session || !existsSync(session.dir)) return
    const segments = this.store.segments(sessionId)
    const write = (name: string, content: string) => {
      const target = join(session.dir, name)
      writeFileSync(`${target}.tmp`, content)
      renameSync(`${target}.tmp`, target)
    }
    try {
      write('transcript.md', toMarkdown(session, segments))
      write('transcript.json', JSON.stringify(toTranscriptDoc(session, segments), null, 2))
    } catch (err) {
      this.log('error', `writing transcript for ${sessionId} failed: ${err}`)
    }
  }

  /** Flush pending transcript writes (app quitting). */
  flushWrites(): void {
    for (const [id, timer] of this.writeTimers) {
      clearTimeout(timer)
      this.writeTranscriptFiles(id)
    }
    this.writeTimers.clear()
  }

  modelLabel(): string {
    const id = this.engine.currentModel
    return id ? MODELS[id].label : 'loading'
  }
}
