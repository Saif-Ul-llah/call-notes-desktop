// Messages between the main process and the hidden capture window (which owns the
// microphone / loopback MediaStreams, resampling and the compressed audio archive).

import type { StreamId } from './types'

/** loopback = Chromium system-audio loopback (Windows/macOS); bridge = PCM pushed from main (Linux pw-record) */
export type SystemCaptureMode = 'loopback' | 'bridge' | 'off'

export type CaptureCommand =
  | { type: 'start'; mic: boolean; micDeviceId: string | null; system: SystemCaptureMode; archive: boolean }
  | { type: 'stop' }
  | { type: 'restart'; stream: StreamId }
  | { type: 'system-pcm'; pcm: ArrayBuffer }

export type CaptureEvent =
  | { type: 'stream-started'; stream: StreamId; label: string }
  | { type: 'stream-failed'; stream: StreamId; message: string }
  | { type: 'archive-file'; index: number }
  | { type: 'stopped' }
  | { type: 'log'; message: string }
