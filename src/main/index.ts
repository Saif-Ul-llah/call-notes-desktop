import {
  app, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, protocol, shell, Tray,
} from 'electron'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MODELS, MODEL_FALLBACK, VAD_MODEL_FILE } from '../shared/models'
import { toMarkdown, toSrt, toText, toTranscriptDoc } from '../shared/transcript-format'
import type { ExportFormat, LiveSnapshot, ModelInfo, SessionDetail } from '../shared/api'
import type { CaptureEvent } from '../shared/capture-protocol'
import type { ModelId, PartialLine, Segment, Settings, StreamId } from '../shared/types'
import { Store } from './db'
import { EngineHost, probeModelSpeed, type EngineModel } from './engine-host'
import { log } from './logger'
import { dbPath, iconPath, modelExists, modelPath } from './paths'
import { SessionManager } from './session-manager'
import { SettingsStore } from './settings'
import { WindowManager } from './windows'

// Apex is only chosen automatically when the CPU encodes a 30 s window this fast.
const APEX_MAX_ENCODE_MS = 1500
const PROBE_TIMEOUT_MS = 25000
// Ctrl+Shift+T would hijack browsers' "reopen closed tab"; Ctrl+Alt+T opens a terminal on Ubuntu
const SHORTCUT = 'CommandOrControl+Alt+N'

// Wayland doesn't let apps position their own windows or reliably keep them on top,
// which the floating button needs, so run through XWayland. The platform must be
// chosen on the real command line (appendSwitch is too late and crashes the GPU
// process), hence a relaunch. Installed builds already pass it; opt out: CALLNOTES_WAYLAND=1
if (
  process.platform === 'linux' &&
  process.env.XDG_SESSION_TYPE === 'wayland' &&
  !process.env.CALLNOTES_WAYLAND &&
  // Electron itself sets ozone-platform=wayland, so look for our flag on the real argv
  !process.argv.includes('--ozone-platform=x11')
) {
  // an AppImage's files vanish when this process exits (unmount / temp extraction is
  // removed), so relaunch the .AppImage file itself rather than the binary inside it
  const appImage = process.env.APPIMAGE
  app.relaunch(
    appImage
      ? { execPath: appImage, args: [...process.argv.slice(1), '--ozone-platform=x11'] }
      : { args: [...process.argv.slice(1), '--ozone-platform=x11'] },
  )
  app.exit(0)
}

// Dev/test: keep all data (settings, db, transcripts) in a separate folder
if (process.env.CALLNOTES_DATA_DIR) app.setPath('userData', process.env.CALLNOTES_DATA_DIR)

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

// capture runs in a hidden window: allow audio without a user gesture, never throttle it
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
protocol.registerSchemesAsPrivileged([
  { scheme: 'callnotes', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

process.on('uncaughtException', (err) => log('error', `uncaught exception: ${err.stack ?? err}`))
process.on('unhandledRejection', (err) => log('error', `unhandled rejection: ${err}`))

let tray: Tray | null = null

app.whenReady().then(() => {
  const settings = new SettingsStore()
  const store = new Store(dbPath())
  const failedModels = new Set<ModelId>()

  // ---------------------------------------------------------------- model choice
  const resolveModel = (): EngineModel => {
    const s = settings.get()
    // "auto" starts on the fast model until the background probe proves Apex keeps up
    let id: ModelId = s.model !== 'auto' ? s.model : s.autoModel ?? 'swift'
    // walk the fallback chain past models that are missing or keep failing to load
    while (failedModels.has(id) || !modelExists(MODELS[id].file)) {
      const next = MODEL_FALLBACK[id]
      if (!next) break
      id = next
    }
    return { id, path: modelPath(MODELS[id].file) }
  }

  // optimized AVX2 build (scripts/build-whisper-native.mjs), shipped via extraResources
  const nativePath = join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'native', `${process.platform}-${process.arch}-avx2`, 'index.node')
  const engine = new EngineHost({
    resolveModel,
    vadPath: modelExists(VAD_MODEL_FILE) ? modelPath(VAD_MODEL_FILE) : null,
    nativePath,
    threads: () => settings.get().threads,
    useGpu: () => settings.get().useGpu,
    log,
  })

  engine.on('model-failed', ({ model, error }) => {
    log('error', `model ${model} failed to load repeatedly (${error}); falling back`)
    failedModels.add(model)
    void engine.reload()
  })

  /** One-time background benchmark deciding whether "auto" can use Apex on this machine. */
  let probing = false
  const probeAutoModel = async () => {
    const s = settings.get()
    if (probing || s.model !== 'auto' || s.autoModel || !modelExists(MODELS.apex.file)) return
    probing = true
    const encodeMs = await probeModelSpeed({ modelPath: modelPath(MODELS.apex.file), nativePath, threads: s.threads, timeoutMs: PROBE_TIMEOUT_MS })
    probing = false
    const choice: ModelId = encodeMs <= APEX_MAX_ENCODE_MS ? 'apex' : 'swift'
    log('info', `apex benchmark: ${Number.isFinite(encodeMs) ? `${Math.round(encodeMs)} ms` : 'too slow / failed'} -> auto model = ${choice}`)
    settings.set({ autoModel: choice })
    if (choice === 'apex' && !mgr.active) void engine.reload()
  }

  // ---------------------------------------------------------------- windows & sessions
  let sessions: SessionManager | null = null
  const windows = new WindowManager(settings, log, () => sessions?.onCaptureRestarted())
  sessions = new SessionManager(store, settings, engine, { send: (cmd) => windows.sendCapture(cmd) }, log)
  const mgr = sessions

  // live state kept for windows that open mid-session (overlay snapshot)
  let liveSegments: Segment[] = []
  const livePartials = new Map<StreamId, PartialLine>()

  mgr.on('status', (status) => {
    windows.broadcast('live:status', status)
    updateTray()
  })
  mgr.on('segment', (seg) => {
    if (seg.sessionId === mgr.activeSessionId) liveSegments.push(seg)
    windows.broadcast('live:segment', seg)
  })
  mgr.on('segment-removed', (e) => {
    liveSegments = liveSegments.filter((s) => s.id !== e.id)
    windows.broadcast('live:segment-removed', e)
  })
  mgr.on('partial', (p) => {
    if (p.text) livePartials.set(p.stream, p)
    else livePartials.delete(p.stream)
    windows.broadcast('live:partial', p)
  })
  mgr.on('level', (l) => {
    for (const w of [windows.button, windows.overlay]) if (w && !w.isDestroyed()) w.webContents.send('live:level', l)
  })
  mgr.on('saved', () => {
    // a call that ended mid-sentence must not leave a "speaking" preview behind
    for (const p of livePartials.values()) windows.broadcast('live:partial', { ...p, text: '' })
    livePartials.clear()
    windows.broadcast('library:changed')
  })

  const toggleSession = () => {
    if (!mgr.active) {
      liveSegments = []
      livePartials.clear()
      mgr.start()
      windows.showOverlay()
      windows.broadcast('library:changed')
    } else {
      void mgr.stop()
    }
  }

  // ---------------------------------------------------------------- audio playback protocol
  protocol.handle('callnotes', (req) => {
    // callnotes://audio/<sessionId>/<index>
    const url = new URL(req.url)
    const [sessionId, index] = url.pathname.split('/').filter(Boolean)
    const files = store.audioFiles(sessionId)
    const file = files[Number(index)]
    if (url.host !== 'audio' || !file || !existsSync(file.path)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file.path).toString())
  })

  // ---------------------------------------------------------------- IPC: capture window
  ipcMain.on('capture:ready', () => windows.markCaptureReady())
  ipcMain.on('capture:pcm', (_e, stream: StreamId, data: ArrayBuffer) => mgr.onPcm(stream, new Int16Array(data)))
  ipcMain.on('capture:archive', (_e, index: number, data: ArrayBuffer) => mgr.onArchiveChunk(index, data))
  ipcMain.on('capture:event', (_e, ev: CaptureEvent) => mgr.onCaptureEvent(ev))

  // ---------------------------------------------------------------- IPC: session
  ipcMain.handle('session:toggle', () => toggleSession())
  ipcMain.handle('session:stop', () => mgr.stop())
  ipcMain.handle('session:resume', (_e, id: string) => {
    if (mgr.active) return
    liveSegments = []
    livePartials.clear()
    mgr.resume(id)
    windows.showOverlay()
    windows.broadcast('library:changed')
  })
  ipcMain.handle('session:snapshot', (): LiveSnapshot => ({
    status: mgr.status(),
    segments: liveSegments,
    partials: [...livePartials.values()],
  }))

  // ---------------------------------------------------------------- IPC: settings
  ipcMain.handle('settings:get', () => settings.get())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const next = settings.set(patch)
    if (patch.launchAtLogin !== undefined) app.setLoginItemSettings({ openAtLogin: patch.launchAtLogin })
    if (patch.model !== undefined || patch.useGpu !== undefined || patch.threads !== undefined) {
      failedModels.clear()
      void engine.reload()
      // benchmark only while idle: the probe competes with live transcription for CPU
      if (patch.model === 'auto' && !next.autoModel && !mgr.active) void probeAutoModel()
    }
    return next
  })
  ipcMain.handle('settings:models', (): ModelInfo[] =>
    (Object.keys(MODELS) as ModelId[]).map((id) => ({ id, label: MODELS[id].label, installed: modelExists(MODELS[id].file) })),
  )
  ipcMain.handle('settings:choose-storage-dir', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], defaultPath: settings.get().storageDir })
    if (res.canceled || !res.filePaths[0]) return null
    settings.set({ storageDir: res.filePaths[0] })
    return res.filePaths[0]
  })
  settings.on('change', (s) => windows.broadcast('settings:changed', s))

  // ---------------------------------------------------------------- IPC: library
  ipcMain.handle('library:list', (_e, query: string) => store.listSessions(query))
  ipcMain.handle('library:get', (_e, id: string): SessionDetail | null => {
    const session = store.getSession(id)
    if (!session) return null
    return {
      session,
      segments: store.segments(id),
      audio: store.audioFiles(id).filter((f) => existsSync(f.path)).map((f, i) => ({ url: `callnotes://audio/${id}/${i}`, offsetMs: f.offsetMs })),
    }
  })
  const render = (id: string, format: ExportFormat): string | null => {
    const session = store.getSession(id)
    if (!session) return null
    const segs = store.segments(id)
    if (format === 'md') return toMarkdown(session, segs)
    if (format === 'txt') return toText(session, segs)
    if (format === 'srt') return toSrt(segs)
    return JSON.stringify(toTranscriptDoc(session, segs), null, 2)
  }
  ipcMain.handle('library:export', async (_e, id: string, format: ExportFormat) => {
    const session = store.getSession(id)
    const content = render(id, format)
    if (!session || content === null) return null
    const safe = session.title.replace(/[^\w\- ,()]+/g, '').trim() || 'transcript'
    const res = await dialog.showSaveDialog({ defaultPath: join(app.getPath('documents'), `${safe}.${format}`) })
    if (res.canceled || !res.filePath) return null
    writeFileSync(res.filePath, content)
    return res.filePath
  })
  ipcMain.handle('library:copy-text', (_e, id: string) => {
    const content = render(id, 'txt')
    if (content) clipboard.writeText(content)
  })
  ipcMain.handle('library:open-folder', (_e, id: string) => {
    const s = store.getSession(id)
    if (s && existsSync(s.dir)) void shell.openPath(s.dir)
  })
  ipcMain.handle('library:rename', (_e, id: string, title: string) => {
    store.updateSession(id, { title: title.trim().slice(0, 200) || 'Untitled call' })
    mgr.scheduleTranscriptWrite(id, 0)
    windows.broadcast('library:changed')
  })
  ipcMain.handle('library:delete', async (_e, id: string) => {
    if (id === mgr.activeSessionId) return false
    const s = store.getSession(id)
    if (!s) return false
    const res = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Delete', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete "${s.title}"?`,
      detail: 'The transcript and audio recording will be permanently removed from this device.',
    })
    if (res.response !== 0) return false
    store.deleteSession(id)
    rmSync(s.dir, { recursive: true, force: true })
    windows.broadcast('library:changed')
    return true
  })

  // ---------------------------------------------------------------- IPC: windows
  ipcMain.on('win:show-overlay', () => windows.showOverlay())
  ipcMain.on('win:hide-overlay', () => windows.hideOverlay())
  ipcMain.on('win:open-library', () => windows.openLibrary())
  ipcMain.on('win:overlay-opacity', (_e, v: number) => windows.setOverlayOpacity(v))
  ipcMain.on('win:drag-button', (_e, phase: 'start' | 'move' | 'end', x: number, y: number) => windows.dragButton(phase, x, y))
  ipcMain.on('win:button-menu', () => buttonMenu().popup({ window: windows.button ?? undefined }))

  // ---------------------------------------------------------------- menus & tray
  const languageMenu = (): Electron.MenuItemConstructorOptions[] =>
    ([['roman', 'Roman Urdu / Hindi'], ['en', 'English'], ['auto', 'Auto detect']] as const).map(([value, label]) => ({
      label,
      type: 'radio' as const,
      checked: settings.get().language === value,
      click: () => settings.set({ language: value }),
    }))

  const buttonMenu = () =>
    Menu.buildFromTemplate([
      { label: mgr.active ? 'Stop transcript' : 'Start transcript', click: toggleSession },
      { label: 'Show live transcript', click: () => windows.showOverlay() },
      { label: 'Open library', click: () => windows.openLibrary() },
      { type: 'separator' },
      { label: 'Language', submenu: languageMenu() },
      { type: 'separator' },
      { label: 'Hide floating button', click: () => windows.button?.hide() },
      { label: 'Quit Call Notes', click: () => app.quit() },
    ])

  const trayIcon = () => {
    const img = nativeImage.createFromPath(iconPath(mgr.active ? 'tray-recording.png' : 'tray.png'))
    return img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 18, height: 18 })
  }
  function updateTray() {
    if (!tray) return
    tray.setImage(trayIcon())
    tray.setToolTip(mgr.active ? 'Call Notes — transcribing' : 'Call Notes')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: mgr.active ? 'Stop transcript' : 'Start transcript', click: toggleSession, accelerator: SHORTCUT },
        { label: 'Show floating button', click: () => windows.createButton().show() },
        { label: 'Show live transcript', click: () => windows.showOverlay() },
        { label: 'Open library', click: () => windows.openLibrary() },
        { type: 'separator' },
        { label: 'Language', submenu: languageMenu() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
      ]),
    )
  }
  tray = new Tray(trayIcon())
  tray.on('click', () => windows.openLibrary())
  updateTray()
  settings.on('change', () => updateTray())

  if (!globalShortcut.register(SHORTCUT, toggleSession)) log('warn', `could not register shortcut ${SHORTCUT}`)

  // ---------------------------------------------------------------- start up
  windows.installLoopbackHandler()
  windows.createCapture()
  windows.createButton()
  engine.start()
  // give the engine a head start, then benchmark Apex once (skipped while recording)
  setTimeout(() => {
    if (!mgr.active) void probeAutoModel()
  }, 15000)

  const interrupted = mgr.recover()
  // show the library so the user sees the interrupted call(s) and can resume them
  if (interrupted.length > 0) windows.openLibrary()
  log('info', `Call Notes ready (models: ${(Object.keys(MODELS) as ModelId[]).filter((m) => modelExists(MODELS[m].file)).join(', ') || 'none'})`)

  // Dev/test hooks: start a session after N ms, stop and quit after M ms
  const autoStart = Number(process.env.CALLNOTES_AUTOSTART_MS || 0)
  const autoStop = Number(process.env.CALLNOTES_AUTOSTOP_MS || 0)
  if (autoStart) setTimeout(toggleSession, autoStart)
  const shotsDir = process.env.CALLNOTES_SCREENSHOTS
  if (shotsDir && autoStart) {
    setTimeout(async () => {
      const lib = windows.openLibrary()
      await new Promise((r) => setTimeout(r, 2500))
      for (const [name, win] of [['button', windows.button], ['overlay', windows.overlay], ['library', lib]] as const) {
        if (win && !win.isDestroyed()) writeFileSync(join(shotsDir, `${name}.png`), (await win.webContents.capturePage()).toPNG())
      }
      log('info', `screenshots written to ${shotsDir}`)
    }, autoStart + 30000)
  }
  if (autoStart && autoStop) setTimeout(() => void mgr.stop().then(() => setTimeout(() => app.quit(), 5000)), autoStart + autoStop)

  app.on('second-instance', () => windows.openLibrary())
  app.on('activate', () => windows.openLibrary())

  let quitting = false
  app.on('before-quit', (e) => {
    windows.quitting = true
    if (quitting) return
    quitting = true
    e.preventDefault()
    const finish = async () => {
      try {
        if (mgr.active) await mgr.stop()
      } catch (err) {
        log('error', `stop on quit failed: ${err}`)
      }
      mgr.flushWrites()
      await engine.stop()
      store.close()
      globalShortcut.unregisterAll()
      app.exit(0)
    }
    void finish()
  })
})

// keep running in the tray when every window is closed
app.on('window-all-closed', () => undefined)
