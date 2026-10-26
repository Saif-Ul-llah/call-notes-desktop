// Hidden capture window: owns the microphone and system-audio MediaStreams,
// converts them to 16 kHz mono PCM for transcription and records a compressed
// Opus archive of the mixed call. Main restarts individual streams on failure.

import type { CaptureCommand, SystemCaptureMode } from '../../../shared/capture-protocol'
import type { StreamId } from '../../../shared/types'

const api = window.callNotes

// AudioWorklets as a blob so they ship inside this bundle.
const WORKLETS = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.ratio = sampleRate / 16000
    this.buf = new Int16Array(1600) // 100 ms
    this.n = 0; this.pos = 0; this.acc = 0; this.cnt = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const len = input[0].length
    for (let i = 0; i < len; i++) {
      let v = 0
      for (let c = 0; c < input.length; c++) v += input[c][i]
      this.acc += v / input.length; this.cnt++; this.pos += 1
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio
        const s = this.acc / this.cnt
        this.acc = 0; this.cnt = 0
        this.buf[this.n++] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf.buffer, [this.buf.buffer])
          this.buf = new Int16Array(1600); this.n = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)

// Plays 16 kHz PCM pushed from main (Linux system audio) so it lands in the archive mix.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super()
    this.queue = []; this.cur = null; this.idx = 0; this.frac = 0
    this.step = 16000 / sampleRate
    this.port.onmessage = (e) => {
      this.queue.push(new Int16Array(e.data))
      if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50)
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.idx >= this.cur.length) {
        this.cur = this.queue.shift() || null; this.idx = 0
        if (!this.cur) { out[i] = 0; continue }
      }
      out[i] = this.cur[this.idx] / 32768
      this.frac += this.step
      while (this.frac >= 1) { this.frac -= 1; this.idx++ }
    }
    return true
  }
}
registerProcessor('pcm-player', PcmPlayer)
`

interface Capture {
  media: MediaStream
  source: MediaStreamAudioSourceNode
  tap: AudioWorkletNode
}

let ctx: AudioContext | null = null
let mix: MediaStreamAudioDestinationNode | null = null
let sink: GainNode | null = null
let recorder: MediaRecorder | null = null
let player: AudioWorkletNode | null = null
const streams = new Map<StreamId, Capture>()
let config: { mic: boolean; micDeviceId: string | null; system: SystemCaptureMode; archive: boolean } | null = null

const log = (message: string) => api.capture.event({ type: 'log', message })
const fail = (stream: StreamId, message: string) => api.capture.event({ type: 'stream-failed', stream, message })

async function ensureContext(): Promise<AudioContext> {
  if (ctx && ctx.state !== 'closed') return ctx
  // 16 kHz context: Chromium resamples the device audio with proper filtering
  ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'playback' })
  const url = URL.createObjectURL(new Blob([WORKLETS], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  mix = ctx.createMediaStreamDestination()
  // taps must be pulled by the graph; route them into a muted sink
  sink = ctx.createGain()
  sink.gain.value = 0
  sink.connect(ctx.destination)
  return ctx
}

async function acquire(stream: StreamId): Promise<MediaStream> {
  if (stream === 'mic') {
    const constraints = (deviceId?: string): MediaStreamConstraints => ({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(config?.micDeviceId ?? undefined))
    } catch (err) {
      if (!config?.micDeviceId) throw err
      // chosen microphone unplugged: fall back to the default one
      log(`selected microphone unavailable (${err}); using default`)
      return navigator.mediaDevices.getUserMedia(constraints())
    }
  }
  // system audio via loopback (main's setDisplayMediaRequestHandler supplies it)
  const media = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  media.getVideoTracks().forEach((t) => {
    t.stop()
    media.removeTrack(t)
  })
  if (media.getAudioTracks().length === 0) throw new Error('no loopback audio track')
  return media
}

function teardown(stream: StreamId): void {
  const cap = streams.get(stream)
  if (!cap) return
  streams.delete(stream)
  cap.tap.port.onmessage = null
  cap.source.disconnect()
  cap.tap.disconnect()
  cap.media.getTracks().forEach((t) => {
    t.onended = null
    t.stop()
  })
}

async function startStream(stream: StreamId): Promise<void> {
  teardown(stream)
  const audio = await ensureContext()
  let media: MediaStream
  try {
    media = await acquire(stream)
  } catch (err) {
    fail(stream, err instanceof Error ? err.message : String(err))
    return
  }
  const source = audio.createMediaStreamSource(media)
  const tap = new AudioWorkletNode(audio, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
  tap.port.onmessage = (e: MessageEvent<ArrayBuffer>) => api.capture.pcm(stream, e.data)
  source.connect(tap)
  tap.connect(sink!)
  if (mix) source.connect(mix)
  for (const track of media.getAudioTracks()) {
    track.onended = () => {
      if (streams.get(stream)?.media === media) {
        teardown(stream)
        fail(stream, 'audio device disconnected')
      }
    }
  }
  streams.set(stream, { media, source, tap })
  const label = media.getAudioTracks()[0]?.label ?? stream
  api.capture.event({ type: 'stream-started', stream, label })
}

function startArchive(): void {
  if (!mix || recorder) return
  const index = Date.now()
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  const rec = new MediaRecorder(mix.stream, { mimeType, audioBitsPerSecond: 24000 })
  api.capture.event({ type: 'archive-file', index })
  rec.ondataavailable = (e) => {
    if (e.data.size > 0) void e.data.arrayBuffer().then((buf) => api.capture.archive(index, buf))
  }
  rec.onerror = () => log('archive recorder error')
  rec.start(5000)
  recorder = rec
}

async function stopAll(): Promise<void> {
  for (const id of [...streams.keys()]) teardown(id)
  player?.disconnect()
  player = null
  const rec = recorder
  recorder = null
  if (rec && rec.state !== 'inactive') {
    // wait for the final chunk to be delivered before reporting "stopped"
    await new Promise<void>((resolve) => {
      rec.onstop = () => setTimeout(resolve, 200)
      rec.stop()
    })
  }
  await ctx?.close().catch(() => undefined)
  ctx = null
  mix = null
  sink = null
}

async function handle(cmd: CaptureCommand): Promise<void> {
  switch (cmd.type) {
    case 'start': {
      await stopAll()
      config = { mic: cmd.mic, micDeviceId: cmd.micDeviceId, system: cmd.system, archive: cmd.archive }
      const audio = await ensureContext()
      if (cmd.system === 'bridge') {
        player = new AudioWorkletNode(audio, 'pcm-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
        player.connect(mix!)
      }
      if (cmd.mic) await startStream('mic')
      if (cmd.system === 'loopback') await startStream('system')
      if (cmd.archive) startArchive()
      break
    }
    case 'restart':
      if (!config) return
      if (cmd.stream === 'system' && config.system !== 'loopback') return
      if (cmd.stream === 'mic' && !config.mic) return
      await startStream(cmd.stream)
      break
    case 'system-pcm':
      player?.port.postMessage(cmd.pcm, [cmd.pcm])
      break
    case 'stop':
      await stopAll()
      config = null
      api.capture.event({ type: 'stopped' })
      break
  }
}

// commands are handled strictly in order (start must finish before restart/stop)
let chain = Promise.resolve()
api.capture.onCommand((cmd) => {
  if (cmd.type === 'system-pcm') {
    player?.port.postMessage(cmd.pcm, [cmd.pcm])
    return
  }
  chain = chain.then(() => handle(cmd)).catch((err) => log(`command ${cmd.type} failed: ${err}`))
})

navigator.mediaDevices.addEventListener('devicechange', () => {
  // a newly plugged-in preferred microphone: switch to it
  const mic = streams.get('mic')
  if (config?.micDeviceId && mic && mic.media.getAudioTracks()[0]?.getSettings().deviceId !== config.micDeviceId) {
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (devices.some((d) => d.deviceId === config?.micDeviceId)) chain = chain.then(() => startStream('mic'))
    })
  }
})

api.capture.ready()
