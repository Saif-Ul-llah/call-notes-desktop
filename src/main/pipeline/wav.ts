// Minimal 16-bit PCM WAV helpers (slices waiting for transcription are stored as WAV
// so they survive crashes and can be replayed).

import { readFileSync, writeFileSync } from 'node:fs'

export function wavHeader(dataBytes: number, sampleRate = 16000, channels = 1): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20) // PCM
  h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(sampleRate, 24)
  h.writeUInt32LE(sampleRate * channels * 2, 28)
  h.writeUInt16LE(channels * 2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

export function writeWav(path: string, pcm: Int16Array, sampleRate = 16000): void {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  writeFileSync(path, Buffer.concat([wavHeader(data.length, sampleRate), data]))
}

/** Read the PCM payload of a 16-bit WAV (tolerates a header with wrong sizes, e.g. after a crash). */
export function readWavPcm(path: string): Int16Array {
  const buf = readFileSync(path)
  let offset = 12
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'data') {
      const start = offset + 8
      const end = Math.min(buf.length, size > 0 ? start + size : buf.length)
      const bytes = buf.subarray(start, end - ((end - start) % 2))
      return new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk in ${path}`)
}
