// Linux system-audio capture ("Them" side of a call): records the default output
// device's monitor as raw 16 kHz mono s16le. PipeWire (pw-record) first, PulseAudio
// (parec) as fallback. Restarting on exit is the caller's job (SessionManager).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'

interface Recorder {
  cmd: string
  args: string[]
}

const RECORDERS: Recorder[] = [
  {
    cmd: 'pw-record',
    // stream.capture.sink=true records the sink monitor (what the speakers play)
    args: ['-P', '{ stream.capture.sink=true node.name=call-notes-system-audio }', '--rate', '16000', '--channels', '1', '--format', 's16', '-'],
  },
  {
    cmd: 'parec',
    args: ['-d', '@DEFAULT_MONITOR@', '--format=s16le', '--rate=16000', '--channels=1', '--latency-msec=100'],
  },
]

function available(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0
}

export function linuxRecorderAvailable(): boolean {
  return RECORDERS.some((r) => available(r.cmd))
}

export class LinuxSystemAudio extends EventEmitter<{ data: [Int16Array]; exit: [string] }> {
  private proc: ChildProcessWithoutNullStreams | null = null
  private carry: Buffer = Buffer.alloc(0)
  private stopped = false

  start(): void {
    this.stopped = false
    const rec = RECORDERS.find((r) => available(r.cmd))
    if (!rec) {
      this.emit('exit', 'neither pw-record (PipeWire) nor parec (PulseAudio) is installed')
      return
    }
    const proc = spawn(rec.cmd, rec.args)
    this.proc = proc
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      const buf = this.carry.length ? Buffer.concat([this.carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      this.carry = buf.subarray(usable)
      if (usable === 0) return
      const copy = new Int16Array(usable / 2)
      for (let i = 0; i < copy.length; i++) copy[i] = buf.readInt16LE(i * 2)
      this.emit('data', copy)
    })
    proc.stderr.on('data', (d) => {
      stderr = (stderr + String(d)).slice(-500)
    })
    proc.on('error', (err) => this.emit('exit', `${rec.cmd} failed: ${err.message}`))
    proc.on('close', (code) => {
      if (this.proc === proc) this.proc = null
      if (!this.stopped) this.emit('exit', `${rec.cmd} exited with code ${code}: ${stderr.trim()}`)
    })
  }

  stop(): void {
    this.stopped = true
    this.proc?.kill('SIGTERM')
    this.proc = null
    this.carry = Buffer.alloc(0)
  }
}
