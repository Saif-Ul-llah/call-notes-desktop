// Messages between the main process (EngineHost) and the whisper utility process.

import type { StreamId } from './types'

export type HostToEngine =
  | {
      type: 'init'
      modelPath: string
      vadPath: string | null
      /** optimized whisper.node build; null = use the npm prebuilt */
      nativePath: string | null
      useGpu: boolean
      threads: number
    }
  | {
      type: 'transcribe'
      id: string
      kind: 'final' | 'partial'
      stream: StreamId
      /** finals are read from disk (crash-safe), partials are sent inline */
      wavPath?: string
      pcm?: ArrayBuffer
      language: string
      prompt?: string
      /** encoder window override (partials only: fast preview, final pass uses the full window) */
      audioCtx?: number
    }
  | { type: 'bench'; threads: number }
  | { type: 'ping'; t: number }

export type EngineToHost =
  | { type: 'ready'; loadMs: number; gpu: boolean; backend: string }
  | { type: 'init-error'; error: string }
  | {
      type: 'result'
      id: string
      kind: 'final' | 'partial'
      stream: StreamId
      text: string
      /** Silero VAD found no speech in the slice; text is empty */
      noSpeech: boolean
      audioMs: number
      processMs: number
    }
  | { type: 'job-error'; id: string; kind: 'final' | 'partial'; error: string }
  | { type: 'bench'; encodeMs: number }
  | { type: 'pong'; t: number }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
