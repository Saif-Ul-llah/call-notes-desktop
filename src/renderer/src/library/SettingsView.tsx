import { useEffect, useState } from 'react'
import { api } from '../common'
import type { ModelInfo } from '../../../shared/api'
import type { Settings } from '../../../shared/types'

export function SettingsView() {
  const [s, setS] = useState<Settings | null>(null)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])

  useEffect(() => {
    void api.settings.get().then(setS)
    void api.settings.models().then(setModels)
    const loadMics = () =>
      navigator.mediaDevices.enumerateDevices().then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default')))
    void loadMics()
    navigator.mediaDevices.addEventListener('devicechange', loadMics)
    const off = api.settings.onChange(setS)
    return () => {
      off()
      navigator.mediaDevices.removeEventListener('devicechange', loadMics)
    }
  }, [])

  if (!s) return null
  const set = (patch: Partial<Settings>) => void api.settings.set(patch).then(setS)
  const systemLabel =
    api.platform === 'linux' ? 'Captured from the PipeWire/PulseAudio monitor of your speakers.' : 'Captured with Windows audio loopback.'

  return (
    <div className="settings-view">
      <h2>Settings</h2>

      <section>
        <h3>Transcription</h3>
        <label className="field">
          <span>Language</span>
          <select value={s.language} onChange={(e) => set({ language: e.target.value as Settings['language'] })}>
            <option value="roman">Roman Urdu / Hindi (with English)</option>
            <option value="en">English only</option>
            <option value="auto">Auto detect</option>
          </select>
          <small>Output is always written in English letters (A–Z), like Google voice typing.</small>
        </label>
        <label className="field">
          <span>Speech model</span>
          <select value={s.model} onChange={(e) => set({ model: e.target.value as Settings['model'] })}>
            <option value="auto">Automatic {s.autoModel ? `(using ${s.autoModel})` : '(benchmark on first run)'}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.installed}>
                {m.label}
                {m.installed ? '' : ' — not installed'}
              </option>
            ))}
          </select>
          <small>Apex is more accurate but needs a fast CPU or GPU; Swift runs in real time on most laptops.</small>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.showPartials} onChange={(e) => set({ showPartials: e.target.checked })} />
          <span>Show live preview while someone is still speaking</span>
        </label>
        <label className="field narrow">
          <span>CPU threads</span>
          <input type="number" min={1} max={32} value={s.threads} onChange={(e) => set({ threads: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={s.useGpu} onChange={(e) => set({ useGpu: e.target.checked })} />
          <span>Use GPU (Vulkan) when available</span>
        </label>
      </section>

      <section>
        <h3>Audio</h3>
        <label className="field">
          <span>Microphone ("Me")</span>
          <select value={s.micDeviceId ?? ''} onChange={(e) => set({ micDeviceId: e.target.value || null })}>
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || 'Microphone'}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.captureSystemAudio} onChange={(e) => set({ captureSystemAudio: e.target.checked })} />
          <span>Transcribe the other side of the call ("Them") — {systemLabel}</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.saveAudio} onChange={(e) => set({ saveAudio: e.target.checked })} />
          <span>Save a compressed audio recording with each transcript</span>
        </label>
      </section>

      <section>
        <h3>Storage & startup</h3>
        <div className="field">
          <span>Save transcripts in</span>
          <div className="path-row">
            <code>{s.storageDir}</code>
            <button className="btn" onClick={() => api.settings.chooseStorageDir()}>
              Change…
            </button>
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.launchAtLogin} onChange={(e) => set({ launchAtLogin: e.target.checked })} />
          <span>Start Call Notes when I log in</span>
        </label>
        <p className="hint">
          Shortcut: <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>N</kbd> starts/stops a transcript from anywhere. Changes apply to the next
          recording.
        </p>
      </section>
    </div>
  )
}
