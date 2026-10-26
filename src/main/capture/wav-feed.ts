// Dev/test-only audio source: plays a 16 kHz mono WAV in real time as if it were the
// system-audio stream (CALLNOTES_TEST_FEED). Lets the full pipeline run end-to-end
// without speakers or a real call. After the file ends it keeps sending silence.

import { EventEmitter } from 'node:events'
import { readWavPcm } from '../pipeline/wav'

const CHUNK = 1600 // 100 ms

export class WavFeed extends EventEmitter<{ data: [Int16Array]; exit: [string] }> {
  private timer: NodeJS.Timeout | null = null

  constructor(private path: string) {
    super()
  }

  start(): void {
    let pcm: Int16Array
    try {
      pcm = readWavPcm(this.path)
    } catch (err) {
      this.emit('exit', `test feed unreadable: ${err}`)
      return
    }
    let pos = 0
    this.timer = setInterval(() => {
      const chunk = new Int16Array(CHUNK)
      if (pos < pcm.length) chunk.set(pcm.subarray(pos, pos + CHUNK))
      pos += CHUNK
      this.emit('data', chunk)
    }, 100)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
