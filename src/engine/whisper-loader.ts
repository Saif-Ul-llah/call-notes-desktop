// Picks the whisper.cpp native module: our AVX2/FMA build (scripts/build-whisper-native.mjs)
// when present and supported by the CPU, otherwise the portable prebuilt from npm.

import { existsSync, readFileSync } from 'node:fs'
import { loadWhisperModule } from '@fugood/whisper.node'
import type { NativeContextOptions, NativeVadContextOptions, WhisperContext, WhisperVadContext } from '@fugood/whisper.node'

type WhisperModule = Awaited<ReturnType<typeof loadWhisperModule>>

export function cpuSupportsAvx2(): boolean {
  if (process.arch !== 'x64') return false
  if (process.platform !== 'linux') return true // the optimized build is only produced on Linux
  try {
    const flags = readFileSync('/proc/cpuinfo', 'utf8').match(/^flags\s*:(.*)$/m)?.[1].split(/\s+/) ?? []
    return ['avx', 'avx2', 'fma', 'f16c'].every((f) => flags.includes(f))
  } catch {
    return false
  }
}

export interface LoadedWhisper {
  variant: 'avx2' | 'prebuilt' | 'vulkan'
  initWhisper(opts: NativeContextOptions): Promise<WhisperContext>
  initWhisperVad(opts: NativeVadContextOptions): Promise<WhisperVadContext>
}

function wrap(mod: WhisperModule, variant: LoadedWhisper['variant']): LoadedWhisper {
  return {
    variant,
    // the native constructors may return the context or a promise of it
    initWhisper: async (opts) => await (new mod.WhisperContext(opts) as WhisperContext | Promise<WhisperContext>),
    initWhisperVad: async (opts) => await (new mod.WhisperVadContext(opts) as WhisperVadContext | Promise<WhisperVadContext>),
  }
}

export async function loadWhisper(opts: { nativePath: string | null; useGpu: boolean }): Promise<LoadedWhisper> {
  if (!opts.useGpu && opts.nativePath && existsSync(opts.nativePath) && cpuSupportsAvx2()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(opts.nativePath) as WhisperModule
    return wrap(mod, 'avx2')
  }
  const variant = opts.useGpu ? 'vulkan' : 'default'
  return wrap(await loadWhisperModule(variant), opts.useGpu ? 'vulkan' : 'prebuilt')
}
