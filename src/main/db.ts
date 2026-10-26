// Local index of sessions, segments and the pending transcription queue.
// Uses Node's built-in SQLite (no native module to rebuild); WAL keeps every
// committed segment durable across crashes.

import { DatabaseSync } from 'node:sqlite'
import type { Segment, SessionInfo, SessionStatus, StreamId } from '../shared/types'

export interface JobRow {
  id: string
  sessionId: string
  stream: StreamId
  wavPath: string
  startMs: number
  endMs: number
  language: string
  attempts: number
}

type Row = Record<string, unknown>

const toSession = (r: Row): SessionInfo => ({
  id: r.id as string,
  title: r.title as string,
  startedAt: r.started_at as number,
  endedAt: (r.ended_at as number | null) ?? null,
  status: r.status as SessionStatus,
  language: r.language as SessionInfo['language'],
  model: r.model as string,
  platform: r.platform as SessionInfo['platform'],
  dir: r.dir as string,
  parentId: (r.parent_id as string | null) ?? null,
  segmentCount: (r.segment_count as number | undefined) ?? undefined,
})

const toSegment = (r: Row): Segment => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  stream: r.stream as StreamId,
  speaker: r.speaker as string,
  startMs: r.start_ms as number,
  endMs: r.end_ms as number,
  text: r.text as string,
  rawText: (r.raw_text as string | null) ?? undefined,
})

export class Store {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL,
        language TEXT NOT NULL,
        model TEXT NOT NULL,
        platform TEXT NOT NULL,
        dir TEXT NOT NULL,
        parent_id TEXT
      );
      CREATE TABLE IF NOT EXISTS segments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        speaker TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        raw_text TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS segments_session ON segments(session_id, start_ms);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        stream TEXT NOT NULL,
        wav_path TEXT NOT NULL,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        language TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS audio_files (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        offset_ms INTEGER NOT NULL
      );
    `)
  }

  close(): void {
    this.db.close()
  }

  // ---- sessions

  createSession(s: SessionInfo): void {
    this.db
      .prepare(`INSERT INTO sessions (id, title, started_at, ended_at, status, language, model, platform, dir, parent_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(s.id, s.title, s.startedAt, s.endedAt, s.status, s.language, s.model, s.platform, s.dir, s.parentId)
  }

  updateSession(id: string, patch: Partial<Pick<SessionInfo, 'title' | 'status' | 'endedAt' | 'model'>>): void {
    const cols: string[] = []
    const vals: Array<string | number | null> = []
    if (patch.title !== undefined) { cols.push('title = ?'); vals.push(patch.title) }
    if (patch.status !== undefined) { cols.push('status = ?'); vals.push(patch.status) }
    if (patch.endedAt !== undefined) { cols.push('ended_at = ?'); vals.push(patch.endedAt) }
    if (patch.model !== undefined) { cols.push('model = ?'); vals.push(patch.model) }
    if (cols.length === 0) return
    this.db.prepare(`UPDATE sessions SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  getSession(id: string): SessionInfo | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined
    return r ? toSession(r) : null
  }

  listSessions(query = '', limit = 200): SessionInfo[] {
    const q = query.trim()
    const sql = `
      SELECT s.*, (SELECT COUNT(*) FROM segments g WHERE g.session_id = s.id) AS segment_count
      FROM sessions s
      ${q ? `WHERE s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM segments g WHERE g.session_id = s.id AND g.text LIKE ? ESCAPE '\\')` : ''}
      ORDER BY s.started_at DESC LIMIT ?`
    const like = `%${q.replace(/[%_]/g, (m) => '\\' + m)}%`
    const rows = (q ? this.db.prepare(sql).all(like, like, limit) : this.db.prepare(sql).all(limit)) as Row[]
    return rows.map(toSession)
  }

  sessionsWithStatus(statuses: readonly SessionStatus[]): SessionInfo[] {
    const marks = statuses.map(() => '?').join(',')
    return (this.db.prepare(`SELECT * FROM sessions WHERE status IN (${marks})`).all(...statuses) as Row[]).map(toSession)
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  // ---- segments

  addSegment(seg: Segment): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO segments (id, session_id, stream, speaker, start_ms, end_ms, text, raw_text, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(seg.id, seg.sessionId, seg.stream, seg.speaker, seg.startMs, seg.endMs, seg.text, seg.rawText ?? null, Date.now())
  }

  deleteSegment(id: string): void {
    this.db.prepare('DELETE FROM segments WHERE id = ?').run(id)
  }

  segments(sessionId: string): Segment[] {
    return (this.db.prepare('SELECT * FROM segments WHERE session_id = ? ORDER BY start_ms, end_ms').all(sessionId) as Row[]).map(toSegment)
  }

  recentSegments(sessionId: string, stream: StreamId, sinceMs: number): Segment[] {
    return (this.db
      .prepare('SELECT * FROM segments WHERE session_id = ? AND stream = ? AND end_ms >= ? ORDER BY start_ms')
      .all(sessionId, stream, sinceMs) as Row[]).map(toSegment)
  }

  lastSegmentEnd(sessionId: string): number | null {
    const r = this.db.prepare('SELECT MAX(end_ms) AS m FROM segments WHERE session_id = ?').get(sessionId) as Row
    return (r?.m as number | null) ?? null
  }

  // ---- transcription queue

  addJob(job: Omit<JobRow, 'attempts'>): void {
    this.db
      .prepare(`INSERT INTO jobs (id, session_id, stream, wav_path, start_ms, end_ms, language, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(job.id, job.sessionId, job.stream, job.wavPath, job.startMs, job.endMs, job.language, Date.now())
  }

  getJob(id: string): JobRow | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined
    return r ? this.toJob(r) : null
  }

  pendingJobs(sessionId?: string): JobRow[] {
    const rows = (sessionId
      ? this.db.prepare(`SELECT * FROM jobs WHERE status = 'pending' AND session_id = ? ORDER BY created_at`).all(sessionId)
      : this.db.prepare(`SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at`).all()) as Row[]
    return rows.map((r) => this.toJob(r))
  }

  completeJob(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }

  /** Returns the new attempt count. */
  failJob(id: string, error: string, maxAttempts: number): number {
    this.db.prepare('UPDATE jobs SET attempts = attempts + 1, last_error = ? WHERE id = ?').run(error, id)
    const job = this.getJob(id)
    if (job && job.attempts >= maxAttempts) this.db.prepare(`UPDATE jobs SET status = 'failed' WHERE id = ?`).run(id)
    return job?.attempts ?? maxAttempts
  }

  private toJob(r: Row): JobRow {
    return {
      id: r.id as string,
      sessionId: r.session_id as string,
      stream: r.stream as StreamId,
      wavPath: r.wav_path as string,
      startMs: r.start_ms as number,
      endMs: r.end_ms as number,
      language: r.language as string,
      attempts: r.attempts as number,
    }
  }

  // ---- audio archive

  addAudioFile(sessionId: string, path: string, offsetMs: number): void {
    this.db.prepare('INSERT INTO audio_files (session_id, path, offset_ms) VALUES (?, ?, ?)').run(sessionId, path, offsetMs)
  }

  audioFiles(sessionId: string): Array<{ path: string; offsetMs: number }> {
    return (this.db.prepare('SELECT path, offset_ms FROM audio_files WHERE session_id = ? ORDER BY offset_ms').all(sessionId) as Row[]).map(
      (r) => ({ path: r.path as string, offsetMs: r.offset_ms as number }),
    )
  }
}
