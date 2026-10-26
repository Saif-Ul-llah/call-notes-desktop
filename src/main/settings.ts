// User settings persisted as JSON in the app's userData folder.

import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '../shared/types'

export function defaultSettings(): Settings {
  return {
    language: 'roman',
    model: 'auto',
    autoModel: null,
    captureSystemAudio: true,
    micDeviceId: null,
    saveAudio: true,
    storageDir: process.env.CALLNOTES_DATA_DIR ? join(process.env.CALLNOTES_DATA_DIR, 'CallNotes') : join(app.getPath('documents'), 'CallNotes'),
    overlayOpacity: 1,
    overlayBounds: null,
    buttonPosition: null,
    launchAtLogin: false,
    // ~physical cores, capped at 4: whisper.cpp threads busy-wait, so oversubscribing a
    // laptop that also runs the call app makes transcription several times slower
    threads: Math.max(2, Math.min(4, Math.floor(cpus().length / 2))),
    useGpu: false,
    showPartials: true,
    textScale: 1,
    settingsVersion: SETTINGS_VERSION,
  }
}

const SETTINGS_VERSION = 3

/** One-time fixes for settings saved by older versions. */
function migrate(stored: Partial<Settings>, defaults: Settings): Partial<Settings> {
  const out = { ...stored }
  if ((stored.settingsVersion ?? 1) < 2) {
    // v0.1 defaulted to (cores - 2) threads, which oversubscribes laptops; adopt the new cap
    if ((stored.threads ?? 0) > defaults.threads) out.threads = defaults.threads
  }
  if ((stored.settingsVersion ?? 1) < 3) {
    // the live window used to default to 95% opacity, which lets busy apps show through
    if (stored.overlayOpacity === 0.95) out.overlayOpacity = 1
  }
  out.settingsVersion = SETTINGS_VERSION
  return out
}

export class SettingsStore extends EventEmitter<{ change: [Settings, Partial<Settings>] }> {
  private path = join(app.getPath('userData'), 'settings.json')
  private value: Settings

  constructor() {
    super()
    const defaults = defaultSettings()
    try {
      if (existsSync(this.path)) {
        const stored = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<Settings>
        this.value = { ...defaults, ...migrate(stored, defaults) }
        if (stored.settingsVersion !== SETTINGS_VERSION) this.set({})
      } else {
        this.value = defaults
      }
    } catch {
      // corrupt settings file: start over rather than refusing to launch
      this.value = defaults
    }
  }

  get(): Settings {
    return this.value
  }

  set(patch: Partial<Settings>): Settings {
    this.value = { ...this.value, ...patch }
    // write-then-rename so a crash never leaves a half-written file
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.value, null, 2))
    renameSync(tmp, this.path)
    this.emit('change', this.value, patch)
    return this.value
  }
}
