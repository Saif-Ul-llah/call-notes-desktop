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
    overlayOpacity: 0.95,
    overlayBounds: null,
    buttonPosition: null,
    launchAtLogin: false,
    threads: Math.max(2, Math.min(8, cpus().length - 2)),
    useGpu: false,
    showPartials: true,
  }
}

export class SettingsStore extends EventEmitter<{ change: [Settings, Partial<Settings>] }> {
  private path = join(app.getPath('userData'), 'settings.json')
  private value: Settings

  constructor() {
    super()
    const defaults = defaultSettings()
    try {
      this.value = existsSync(this.path) ? { ...defaults, ...JSON.parse(readFileSync(this.path, 'utf8')) } : defaults
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
