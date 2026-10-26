# Call Notes — Desktop

Offline, real-time transcription of calls and meetings for **Windows** and **Linux**, in **English** and **Roman Urdu/Hindi**. The output is always in English letters (A–Z), like Google voice typing's Hinglish mode. Everything runs on your computer with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio or text leaves the machine.

Mobile app: [call-notes-mobile](https://github.com/Saif-Ul-llah/call-notes-mobile)

## Download

Get the Windows installer from the [Releases page](https://github.com/Saif-Ul-llah/call-notes-desktop/releases/latest). The speech models are included, so it works fully offline after install.

## Features

- **Floating gold button:** always on top. Click to start or stop, drag to move, right-click for the menu.
- **Shortcut:** **Ctrl+Alt+N** starts or stops a transcript from anywhere.
- **Live transcript window:** resizable and always on top, with an opacity slider. "Me" is your microphone and "Them" is the computer's audio (the other side of the call).
- **Library:** search every call, play the audio synced to the transcript, export to .md/.txt/.srt/.json, and resume interrupted calls.
- **Saving:** every call is saved under `Documents/CallNotes/YYYY-MM-DD/HHMM-id/`:
  - `transcript.md`
  - `transcript.json` (input for the planned LLM minutes-of-meeting feature)
  - Opus audio, about 11 MB/hour
- **Retry and restart:**
  - The speech engine runs in its own process with a watchdog, so a crash or hang restarts it and the queued audio is replayed.
  - A lost microphone or system-audio stream is re-acquired automatically.
  - After an app crash, the next launch finishes transcribing the interrupted call.

## Git setup guide (developers)

### 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Git | any | |
| Node.js | 20.19+ or 22 | `node -v` |
| Linux only | `cmake`, `g++`, PipeWire (`pw-record`) or PulseAudio (`parec`) | `sudo apt install cmake build-essential pipewire-bin` |
| Windows only | — | |

### 2. Clone and install

```bash
git clone https://github.com/Saif-Ul-llah/call-notes-desktop.git
cd call-notes-desktop
npm install
```

### 3. Download the speech models (not stored in git)

```bash
npm run fetch-models      # ~630 MB into resources/models (resumable)
```

| Model | Size | Role |
|---|---|---|
| Hindi2Hinglish Swift (whisper-base, q5_1) | 57 MB | Default. Fast. |
| Hindi2Hinglish Apex (large-v3-turbo, q5_0) | 547 MB | More accurate. Chosen automatically on fast CPUs. |
| Silero VAD v5.1.2 | 0.9 MB | Detects speech and drops silence and noise. |

### 4. Linux only: build the fast whisper.cpp binary

```bash
npm run build-native      # AVX2/FMA build → native/linux-x64-avx2/index.node
```

The npm prebuilt Linux binary has no AVX code, which makes it 7–10× slower, so this step matters. Windows doesn't need it.

### 5. Run

```bash
npm run dev:linux         # Linux
npm run dev               # Windows
```

### 6. Test

```bash
npm test                              # unit tests
npm run golden                        # accuracy/speed on test-audio/ (GOLDEN_MODELS=swift to limit)
```

### 7. Build installers

```bash
npm run dist:win          # Windows NSIS .exe   (on Windows, or Linux with Wine)
npm run dist:linux        # AppImage + .deb     (on Linux)
```

Output goes to `dist/`.

### Day-to-day git workflow

```bash
git checkout -b feature/my-change
# ...edit...
npm test && npm run typecheck
git add -A && git commit -m "Describe the change"
git push -u origin feature/my-change
gh pr create --fill          # or open a pull request on GitHub
```

## Project layout

```
src/main/       Electron main process: sessions, engine host, SQLite, windows, tray
src/engine/     whisper.cpp utility process (crash-isolated)
src/renderer/   floating button, live overlay, library, hidden capture page
src/shared/     romanizer, transcript formats, state machine (shared with mobile)
scripts/        model download, native build
test-audio/     reference clips for the golden test (from the Oriserve model card, Apache-2.0)
```

## Credits

Speech models: [Oriserve Whisper-Hindi2Hinglish](https://huggingface.co/Oriserve) (Apache-2.0), GGML conversions by Marquestra and rohitag13, Silero VAD, whisper.cpp and [`@fugood/whisper.node`](https://github.com/mybigday/whisper.node).
