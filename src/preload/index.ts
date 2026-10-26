import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { CallNotesApi } from '../shared/api'

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: CallNotesApi = {
  platform: process.platform,
  session: {
    toggle: () => ipcRenderer.invoke('session:toggle'),
    stop: () => ipcRenderer.invoke('session:stop'),
    resume: (id) => ipcRenderer.invoke('session:resume', id),
    snapshot: () => ipcRenderer.invoke('session:snapshot'),
    onStatus: (cb) => on('live:status', cb),
    onSegment: (cb) => on('live:segment', cb),
    onSegmentRemoved: (cb) => on('live:segment-removed', cb),
    onPartial: (cb) => on('live:partial', cb),
    onLevel: (cb) => on('live:level', cb),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    models: () => ipcRenderer.invoke('settings:models'),
    chooseStorageDir: () => ipcRenderer.invoke('settings:choose-storage-dir'),
    onChange: (cb) => on('settings:changed', cb),
  },
  library: {
    list: (query) => ipcRenderer.invoke('library:list', query ?? ''),
    get: (id) => ipcRenderer.invoke('library:get', id),
    exportAs: (id, format) => ipcRenderer.invoke('library:export', id, format),
    copyText: (id) => ipcRenderer.invoke('library:copy-text', id),
    openFolder: (id) => ipcRenderer.invoke('library:open-folder', id),
    rename: (id, title) => ipcRenderer.invoke('library:rename', id, title),
    remove: (id) => ipcRenderer.invoke('library:delete', id),
    onChange: (cb) => on('library:changed', () => cb()),
  },
  win: {
    showOverlay: () => ipcRenderer.send('win:show-overlay'),
    hideOverlay: () => ipcRenderer.send('win:hide-overlay'),
    openLibrary: () => ipcRenderer.send('win:open-library'),
    buttonMenu: () => ipcRenderer.send('win:button-menu'),
    dragButton: (phase, x, y) => ipcRenderer.send('win:drag-button', phase, x, y),
    setOverlayOpacity: (value) => ipcRenderer.send('win:overlay-opacity', value),
  },
  capture: {
    onCommand: (cb) => on('capture:command', cb),
    pcm: (stream, data) => ipcRenderer.send('capture:pcm', stream, data),
    archive: (index, data) => ipcRenderer.send('capture:archive', index, data),
    event: (ev) => ipcRenderer.send('capture:event', ev),
    ready: () => ipcRenderer.send('capture:ready'),
  },
}

contextBridge.exposeInMainWorld('callNotes', api)
