// Types shared by main, engine and renderer processes.

/** "roman" = Roman Urdu/Hindi (with English mixed in), "en" = English only, "auto" = let the model decide. */
export type LanguageMode = 'roman' | 'en' | 'auto'

/** mic = the local user ("Me"), system = everything the computer plays (the other side of the call, "Them"). */
export type StreamId = 'mic' | 'system'

export type SessionStatus = 'starting' | 'recording' | 'retrying' | 'stopping' | 'saved' | 'interrupted'

export type ModelId = 'apex' | 'swift'
export type ModelChoice = ModelId | 'auto'

export interface Segment {
  id: string
  sessionId: string
  stream: StreamId
  speaker: string
  startMs: number
  endMs: number
  text: string
  rawText?: string
}

export interface PartialLine {
  sessionId: string
  stream: StreamId
  speaker: string
  startMs: number
  text: string
}

export interface SessionInfo {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  status: SessionStatus
  language: LanguageMode
  model: string
  platform: 'desktop' | 'android' | 'ios'
  dir: string
  parentId: string | null
  segmentCount?: number
}

/** On-disk transcript.json — the format phase 2 (LLM summaries / MOM) consumes. */
export interface TranscriptDoc {
  version: 1
  session: Omit<SessionInfo, 'dir' | 'segmentCount'>
  segments: Array<Pick<Segment, 'id' | 'startMs' | 'endMs' | 'speaker' | 'stream' | 'text'>>
}

export type EngineStatus = 'loading' | 'ready' | 'busy' | 'restarting' | 'failed' | 'stopped'

export interface LiveStatus {
  sessionId: string | null
  status: SessionStatus | 'idle'
  startedAt: number | null
  engine: EngineStatus
  model: string | null
  message: string | null
  streams: Partial<Record<StreamId, 'active' | 'retrying' | 'off'>>
  pendingJobs: number
}

export interface Settings {
  language: LanguageMode
  model: ModelChoice
  /** Result of the first-run benchmark when model = auto. */
  autoModel: ModelId | null
  captureSystemAudio: boolean
  micDeviceId: string | null
  saveAudio: boolean
  storageDir: string
  overlayOpacity: number
  overlayBounds: { x: number; y: number; width: number; height: number } | null
  buttonPosition: { x: number; y: number } | null
  launchAtLogin: boolean
  threads: number
  useGpu: boolean
  showPartials: boolean
}
