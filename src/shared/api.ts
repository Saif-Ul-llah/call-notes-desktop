// The API the preload script exposes to every renderer as `window.callNotes`.

import type { CaptureCommand, CaptureEvent } from './capture-protocol'
import type { LiveStatus, ModelId, PartialLine, Segment, SessionInfo, Settings, StreamId } from './types'

export type ExportFormat = 'md' | 'txt' | 'srt' | 'json'

export interface SessionDetail {
  session: SessionInfo
  segments: Segment[]
  audio: Array<{ url: string; offsetMs: number }>
}

export interface LiveSnapshot {
  status: LiveStatus
  segments: Segment[]
  partials: PartialLine[]
}

export interface ModelInfo {
  id: ModelId
  label: string
  installed: boolean
}

type Unsubscribe = () => void

export interface CallNotesApi {
  platform: NodeJS.Platform
  session: {
    toggle(): Promise<void>
    stop(): Promise<void>
    resume(sessionId: string): Promise<void>
    snapshot(): Promise<LiveSnapshot>
    onStatus(cb: (s: LiveStatus) => void): Unsubscribe
    onSegment(cb: (s: Segment) => void): Unsubscribe
    onSegmentRemoved(cb: (e: { sessionId: string; id: string }) => void): Unsubscribe
    onPartial(cb: (p: PartialLine) => void): Unsubscribe
    onLevel(cb: (l: { mic: number; system: number }) => void): Unsubscribe
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    models(): Promise<ModelInfo[]>
    chooseStorageDir(): Promise<string | null>
    onChange(cb: (s: Settings) => void): Unsubscribe
  }
  library: {
    list(query?: string): Promise<SessionInfo[]>
    get(id: string): Promise<SessionDetail | null>
    exportAs(id: string, format: ExportFormat): Promise<string | null>
    copyText(id: string): Promise<void>
    openFolder(id: string): Promise<void>
    rename(id: string, title: string): Promise<void>
    remove(id: string): Promise<boolean>
    onChange(cb: () => void): Unsubscribe
  }
  win: {
    showOverlay(): void
    hideOverlay(): void
    openLibrary(): void
    buttonMenu(): void
    dragButton(phase: 'start' | 'move' | 'end', screenX: number, screenY: number): void
    setOverlayOpacity(value: number): void
  }
  capture: {
    onCommand(cb: (cmd: CaptureCommand) => void): Unsubscribe
    pcm(stream: StreamId, data: ArrayBuffer): void
    archive(index: number, data: ArrayBuffer): void
    event(ev: CaptureEvent): void
    ready(): void
  }
}
