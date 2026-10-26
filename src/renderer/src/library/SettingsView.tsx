import { useEffect, useState } from 'react'
import { api } from '../common'
import type { ModelInfo } from '../../../shared/api'
import type { Settings } from '../../../shared/types'

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
    </label>
  )
}

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
  const callAudio = api.platform === 'linux' ? 'Heard through your speakers via PipeWire/PulseAudio.' : 'Heard through Windows audio loopback.'

  return (
    <div className="settings-view">
      <h1>Settings</h1>

      <section>
        <h2>Transcription</h2>
        <div className="field">
          <label htmlFor="lang">Spoken language</label>
          <select id="lang" value={s.language} onChange={(e) => set({ language: e.target.value as Settings['language'] })}>
            <option value="roman">Roman Urdu / Hindi, mixed with English</option>
            <option value="en">English only</option>
            <option value="auto">Detect automatically</option>
          </select>
          <p className="field-hint">Text is always written in English letters, the way people type Hinglish and Roman Urdu.</p>
        </div>
        <div className="field">
          <label htmlFor="model">Speech model</label>
          <select id="model" value={s.model} onChange={(e) => set({ model: e.target.value as Settings['model'] })}>
            <option value="auto">Choose for this computer{s.autoModel ? ` (using ${s.autoModel === 'apex' ? 'Apex' : 'Swift'})` : ''}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id} disabled={!m.installed}>
                {m.label}
                {m.installed ? '' : ' (not installed)'}
              </option>
            ))}
          </select>
          <p className="field-hint">Swift keeps up in real time on most laptops. Apex is more accurate and needs a fast processor.</p>
        </div>
        <div className="field narrow">
          <label htmlFor="scale">Transcript text size</label>
          <select id="scale" value={s.textScale} onChange={(e) => set({ textScale: Number(e.target.value) })}>
            {[0.9, 1, 1.2, 1.4, 1.6].map((v) => (
              <option key={v} value={v}>
                {v === 1 ? 'Normal' : v < 1 ? 'Small' : v <= 1.2 ? 'Large' : v <= 1.4 ? 'Larger' : 'Largest'}
              </option>
            ))}
          </select>
        </div>
        <Toggle checked={s.showPartials} onChange={(v) => set({ showPartials: v })} label="Show words while someone is still talking" hint="Turn off to save processor time on slower computers." />
        <div className="field narrow">
          <label htmlFor="threads">Processor threads</label>
          <input id="threads" type="number" min={1} max={32} value={s.threads} onChange={(e) => set({ threads: Math.max(1, Number(e.target.value) || 1) })} />
        </div>
        <Toggle checked={s.useGpu} onChange={(v) => set({ useGpu: v })} label="Use the graphics card (Vulkan) when available" />
      </section>

      <section>
        <h2>Audio</h2>
        <div className="field">
          <label htmlFor="mic">Your microphone</label>
          <select id="mic" value={s.micDeviceId ?? ''} onChange={(e) => set({ micDeviceId: e.target.value || null })}>
            <option value="">System default</option>
            {mics.map((m) => (
              <option key={m.deviceId} value={m.deviceId}>
                {m.label || 'Microphone'}
              </option>
            ))}
          </select>
        </div>
        <Toggle checked={s.captureSystemAudio} onChange={(v) => set({ captureSystemAudio: v })} label="Transcribe the other people on the call" hint={callAudio} />
        <Toggle checked={s.saveAudio} onChange={(v) => set({ saveAudio: v })} label="Keep a recording with each transcript" hint="Compressed audio, about 11 MB per hour." />
      </section>

      <section>
        <h2>Files and startup</h2>
        <div className="field">
          <label>Transcripts folder</label>
          <div className="path-row">
            <code title={s.storageDir}>{s.storageDir}</code>
            <button className="btn" onClick={() => api.settings.chooseStorageDir()}>
              Change folder
            </button>
          </div>
        </div>
        <Toggle checked={s.launchAtLogin} onChange={(v) => set({ launchAtLogin: v })} label="Open Call Notes when I sign in" />
        <p className="field-hint">
          Start or stop from anywhere with <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>N</kbd>. Changes apply to the next recording.
        </p>
      </section>
    </div>
  )
}
