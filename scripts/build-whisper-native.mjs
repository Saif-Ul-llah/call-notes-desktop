#!/usr/bin/env node
// Builds an optimized whisper.node addon (AVX2/FMA/F16C, i.e. x86-64-v3) from the
// whisper.cpp sources vendored in @fugood/whisper.node.
//
// Why: the prebuilt linux-x64 binary on npm is compiled without any AVX/FMA code,
// which makes whisper.cpp 10-20x slower on Linux. The engine loads this build when
// the CPU supports it and falls back to the prebuilt portable binary otherwise.
//
// Usage: node scripts/build-whisper-native.mjs
// Requires: cmake >= 3.15 and a C++17 compiler (Linux: build-essential, Windows: VS Build Tools).

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { cpus } from 'node:os'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const variant = 'avx2'

const pkgDir = join(ROOT, 'node_modules', '@fugood', 'whisper.node')
if (!existsSync(join(pkgDir, 'src', 'whisper.rn', 'vendor', 'whisper.cpp', 'cmake'))) {
  console.error('whisper.cpp sources not found in node_modules/@fugood/whisper.node — run npm install first')
  process.exit(1)
}

const work = join(ROOT, 'native', '.build', variant)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
for (const entry of ['CMakeLists.txt', 'package.json', 'src', 'scripts']) cpSync(join(pkgDir, entry), join(work, entry), { recursive: true })

const cmakeLists = join(work, 'CMakeLists.txt')
writeFileSync(
  cmakeLists,
  readFileSync(cmakeLists, 'utf8')
    // scripts/whisper.cpp.patch only touches the Vulkan backend, whose sources are not
    // shipped in the npm package; it is irrelevant for this CPU build.
    .replace(
      'message(FATAL_ERROR "scripts/whisper.cpp.patch does not match the current src/whisper.rn/vendor/whisper.cpp checkout")',
      'message(STATUS "skipping scripts/whisper.cpp.patch (Vulkan-only, not needed for the CPU build)")',
    )
    // Root cause of the slow prebuilt: Node's arch name "x64" is not recognised by ggml's
    // ggml_get_system_arch() on non-MSVC toolchains, so it compiles the GENERIC CPU backend.
    .replace(
      'set(CMAKE_SYSTEM_PROCESSOR ${NODE_ARCH})',
      'if (NODE_ARCH STREQUAL "x64")\n  set(CMAKE_SYSTEM_PROCESSOR x86_64)\nelse()\n  set(CMAKE_SYSTEM_PROCESSOR ${NODE_ARCH})\nendif()',
    ),
)

// expose whisper's audio_ctx (encoder window) as the `audioCtx` transcribe option: short
// live slices then encode only their real length instead of a padded 30 s window
const commonCpp = join(work, 'src', 'common.cpp')
const anchor = `params.greedy.best_of = value.As<Napi::Number>().Int32Value();\n        }`
const common = readFileSync(commonCpp, 'utf8')
if (!common.includes(anchor)) throw new Error('common.cpp layout changed; update the audioCtx patch')
writeFileSync(
  commonCpp,
  common.replace(anchor, `${anchor} else if (key == "audioCtx" && value.IsNumber()) {\n            params.audio_ctx = value.As<Napi::Number>().Int32Value();\n        }`),
)

// the npm package ships the generated ggml-version.h but not its .in template
const ggmlSrc = join(work, 'src', 'whisper.rn', 'vendor', 'whisper.cpp', 'ggml', 'src')
if (!existsSync(join(ggmlSrc, 'ggml-version.h.in'))) copyFileSync(join(ggmlSrc, 'ggml-version.h'), join(ggmlSrc, 'ggml-version.h.in'))

const flags = [
  '--CDCMAKE_BUILD_TYPE=Release',
  '--CDGGML_NATIVE=OFF',
  '--CDGGML_OPENMP=OFF',
  '--CDWHISPER_BUILD_TESTS=OFF',
  '--CDWHISPER_BUILD_EXAMPLES=OFF',
]
if (process.arch === 'x64') {
  flags.push('--CDGGML_AVX=ON', '--CDGGML_AVX2=ON', '--CDGGML_FMA=ON', '--CDGGML_F16C=ON', '--CDGGML_BMI2=ON')
}

const cmakeJs = join(ROOT, 'node_modules', 'cmake-js', 'bin', 'cmake-js')
const res = spawnSync(process.execPath, [cmakeJs, 'compile', '--directory', work, '--out', join(work, 'build'), '--parallel', String(cpus().length), ...flags], {
  stdio: 'inherit',
  env: { ...process.env, CMAKE_BUILD_PARALLEL_LEVEL: String(cpus().length) },
})
if (res.status !== 0) process.exit(res.status ?? 1)

const built = join(work, 'build', 'Release', 'index.node')
const outDir = join(ROOT, 'native', `${process.platform}-${process.arch}-${variant}`)
mkdirSync(outDir, { recursive: true })
copyFileSync(built, join(outDir, 'index.node'))
console.log(`✓ built ${join(outDir, 'index.node')}`)
