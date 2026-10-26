// Window management: floating record button, resizable transcript overlay,
// library window and the hidden capture window.

import { BrowserWindow, desktopCapturer, screen, session, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { CaptureCommand } from '../shared/capture-protocol'
import type { SettingsStore } from './settings'

const BUTTON_SIZE = 76

let rendererLog: ((level: string, msg: string) => void) | null = null

function pageUrl(win: BrowserWindow, page: 'button' | 'overlay' | 'library' | 'capture'): void {
  // surface renderer warnings/errors in the main log file
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') rendererLog?.(e.level === 'error' ? 'error' : 'warn', `[${page}] ${e.message} (${e.sourceId}:${e.lineNumber})`)
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}.html`)
  else void win.loadFile(join(__dirname, '../renderer', `${page}.html`))
}

const preload = () => join(__dirname, '../preload/index.js')

/** Keep a rectangle on some display (monitors can be unplugged between runs). */
function onScreen(bounds: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  const width = Math.min(bounds.width, area.width)
  const height = Math.min(bounds.height, area.height)
  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
  }
}

export class WindowManager {
  button: BrowserWindow | null = null
  overlay: BrowserWindow | null = null
  library: BrowserWindow | null = null
  capture: BrowserWindow | null = null
  private captureReady = false
  private captureQueue: CaptureCommand[] = []
  private dragOrigin: { mouseX: number; mouseY: number; winX: number; winY: number } | null = null
  private saveTimer: NodeJS.Timeout | null = null
  quitting = false

  constructor(
    private settings: SettingsStore,
    private log: (level: string, msg: string) => void,
    private onCaptureRestarted: () => void,
  ) {
    rendererLog = log
  }

  /** Windows/macOS system audio: answer getDisplayMedia with a screen source + loopback audio. */
  installLoopbackHandler(): void {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ['screen'] })
          .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
          .catch((err) => {
            this.log('error', `loopback source lookup failed: ${err}`)
            callback({})
          })
      },
      { useSystemPicker: false },
    )
  }

  // ---------------------------------------------------------------- capture (hidden)

  createCapture(): void {
    this.captureReady = false
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: { preload: preload(), backgroundThrottling: false, sandbox: false },
    })
    this.capture = win
    win.webContents.on('render-process-gone', (_e, details) => {
      this.log('error', `capture renderer gone (${details.reason}); recreating`)
      if (this.capture === win) this.capture = null
      if (!win.isDestroyed()) win.destroy()
      if (!this.quitting) setTimeout(() => {
        this.createCapture()
        this.onCaptureRestarted()
      }, 1000)
    })
    pageUrl(win, 'capture')
  }

  markCaptureReady(): void {
    this.captureReady = true
    const queued = this.captureQueue.splice(0)
    for (const cmd of queued) this.capture?.webContents.send('capture:command', cmd)
  }

  sendCapture(cmd: CaptureCommand): void {
    if (!this.capture || !this.captureReady) {
      if (cmd.type !== 'system-pcm') this.captureQueue.push(cmd)
      return
    }
    this.capture.webContents.send('capture:command', cmd)
  }

  // ---------------------------------------------------------------- floating button

  createButton(): BrowserWindow {
    if (this.button && !this.button.isDestroyed()) return this.button
    const area = screen.getPrimaryDisplay().workArea
    const saved = this.settings.get().buttonPosition
    const pos = onScreen({
      x: saved?.x ?? area.x + area.width - BUTTON_SIZE - 24,
      y: saved?.y ?? area.y + Math.round(area.height * 0.6),
      width: BUTTON_SIZE,
      height: BUTTON_SIZE,
    })
    const win = new BrowserWindow({
      ...pos,
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Call Notes',
      webPreferences: { preload: preload() },
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.webContents.on('render-process-gone', () => {
      if (!this.quitting) setTimeout(() => this.createButton(), 500)
    })
    win.on('closed', () => (this.button = null))
    pageUrl(win, 'button')
    this.button = win
    return win
  }

  dragButton(phase: 'start' | 'move' | 'end', x: number, y: number): void {
    const win = this.button
    if (!win) return
    if (phase === 'start') {
      const [winX, winY] = win.getPosition()
      this.dragOrigin = { mouseX: x, mouseY: y, winX, winY }
      return
    }
    if (!this.dragOrigin) return
    const nx = Math.round(this.dragOrigin.winX + x - this.dragOrigin.mouseX)
    const ny = Math.round(this.dragOrigin.winY + y - this.dragOrigin.mouseY)
    win.setBounds({ x: nx, y: ny, width: BUTTON_SIZE, height: BUTTON_SIZE })
    if (phase === 'end') {
      this.dragOrigin = null
      const b = onScreen(win.getBounds())
      win.setBounds(b)
      this.settings.set({ buttonPosition: { x: b.x, y: b.y } })
    }
  }

  // ---------------------------------------------------------------- transcript overlay

  showOverlay(): BrowserWindow {
    if (this.overlay && !this.overlay.isDestroyed()) {
      this.overlay.showInactive()
      return this.overlay
    }
    const s = this.settings.get()
    const area = screen.getPrimaryDisplay().workArea
    const bounds = onScreen(
      s.overlayBounds ?? { width: 420, height: 320, x: area.x + area.width - 420 - 24, y: area.y + 24 },
    )
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 280,
      minHeight: 160,
      frame: false,
      resizable: true,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      backgroundColor: '#121212',
      title: 'Call Notes — Live transcript',
      webPreferences: { preload: preload() },
    })
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setOpacity(s.overlayOpacity)
    const persist = () => {
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(() => {
        if (!win.isDestroyed()) this.settings.set({ overlayBounds: win.getBounds() })
      }, 400)
    }
    win.on('moved', persist)
    win.on('resized', persist)
    win.on('closed', () => (this.overlay = null))
    win.once('ready-to-show', () => win.showInactive())
    win.webContents.on('render-process-gone', () => {
      if (!win.isDestroyed()) win.destroy()
    })
    pageUrl(win, 'overlay')
    this.overlay = win
    return win
  }

  hideOverlay(): void {
    this.overlay?.close()
  }

  setOverlayOpacity(value: number): void {
    const v = Math.min(1, Math.max(0.3, value))
    this.overlay?.setOpacity(v)
    this.settings.set({ overlayOpacity: v })
  }

  // ---------------------------------------------------------------- library

  openLibrary(): BrowserWindow {
    if (this.library && !this.library.isDestroyed()) {
      if (this.library.isMinimized()) this.library.restore()
      this.library.show()
      this.library.focus()
      return this.library
    }
    const win = new BrowserWindow({
      width: 1120,
      height: 740,
      minWidth: 760,
      minHeight: 480,
      show: false,
      title: 'Call Notes',
      backgroundColor: '#121212',
      autoHideMenuBar: true,
      webPreferences: { preload: preload() },
    })
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => (this.library = null))
    pageUrl(win, 'library')
    this.library = win
    return win
  }

  /** Send to every visible UI window (not the capture window). */
  broadcast(channel: string, payload?: unknown): void {
    for (const w of [this.button, this.overlay, this.library]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload)
    }
  }
}
