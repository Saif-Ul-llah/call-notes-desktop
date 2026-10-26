// Bundled whisper.cpp models and how to decode each one for the chosen language mode.

import type { LanguageMode, ModelId } from './types'

export interface ModelSpec {
  id: ModelId
  label: string
  file: string
  /** whisper `language` to use per mode. */
  language: Record<LanguageMode, string>
  /** Fine-tunes that break with English-style prompts get no initial prompt. */
  usePrompt: boolean
}

export const MODELS: Record<ModelId, ModelSpec> = {
  // Oriserve Whisper-Hindi2Hinglish-Apex (large-v3-turbo fine-tune): accurate, needs a decent CPU/GPU.
  apex: {
    id: 'apex',
    label: 'Hinglish Apex (accurate)',
    file: 'ggml-hinglish-apex-q5_0.bin',
    language: { roman: 'auto', en: 'en', auto: 'auto' },
    usePrompt: true,
  },
  // Oriserve Whisper-Hindi2Hinglish-Swift (whisper-base fine-tune): fast, runs on phones.
  // Must decode with "en": forcing "hi" makes it fall back to Devanagari.
  swift: {
    id: 'swift',
    label: 'Hinglish Swift (fast)',
    file: 'ggml-hinglish-swift-q5_1.bin',
    language: { roman: 'en', en: 'en', auto: 'en' },
    usePrompt: false,
  },
}

/** Fallback order when a model fails to load repeatedly. */
export const MODEL_FALLBACK: Record<ModelId, ModelId | null> = { apex: 'swift', swift: null }

export const VAD_MODEL_FILE = 'ggml-silero-v5.1.2.bin'

/** Roman-style prompt that nudges multilingual decoders to Latin-script Hinglish spelling. */
export const ROMAN_STYLE_PROMPT = 'Haan theek hai, meeting start karte hain. Aap ka kya khayal hai?'

/**
 * Encoder window for a slice (whisper's audio_ctx; 1500 = 30 s, 50 per second).
 * Encoding only the real slice length is the biggest CPU saving for short live slices.
 * Only honoured by our optimized native build; the npm prebuilt ignores it.
 */
export function audioCtxFor(audioMs: number): number {
  return Math.min(1500, Math.max(384, Math.ceil(((audioMs + 1000) / 1000) * 50 / 64) * 64))
}
