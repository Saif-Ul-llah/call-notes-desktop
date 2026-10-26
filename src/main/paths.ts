import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Bundled resources (models, icons): extraResources when packaged, ./resources in dev. */
export function resourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources')
}

export function modelPath(file: string): string {
  return join(resourcesDir(), 'models', file)
}

export function modelExists(file: string): boolean {
  return existsSync(modelPath(file))
}

export function iconPath(name: string): string {
  return join(resourcesDir(), 'icons', name)
}

export function dbPath(): string {
  return join(app.getPath('userData'), 'callnotes.db')
}
