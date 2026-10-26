import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024

let file: string | null = null

function target(): string {
  if (!file) {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    file = join(dir, 'main.log')
  }
  return file
}

/** Append to userData/logs/main.log (rotated at 5 MB) and mirror to the console. */
export function log(level: string, message: string): void {
  if (level === 'debug' && !process.env.CALLNOTES_DEBUG) return
  const line = `${new Date().toISOString()} [${level}] ${message}\n`
  if (level === 'error') console.error(line.trimEnd())
  else console.log(line.trimEnd())
  try {
    const path = target()
    if (existsSync(path) && statSync(path).size > MAX_BYTES) renameSync(path, `${path}.1`)
    appendFileSync(path, line)
  } catch {
    /* logging must never crash the app */
  }
}
