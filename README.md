# Interview Assistant

Real-time AI interview coach. Floats over your screen, hidden from screen sharing, listens to both audio streams, and suggests full answers automatically.

---

## Quick start

### 1. Install Node dependencies

```bash
cd interview-assistant
npm install
```

### 2. Install Python dependencies (for audio transcription)

```bash
pip3 install openai-whisper sounddevice numpy
```

> First run downloads the Whisper model (~74MB for `base.en`). Happens once.

### 3. Run

```bash
npm start
```

---

## Setup flow inside the app

**Step 1 — API key**
Paste your Anthropic API key (`sk-ant-...`). Get one at [console.anthropic.com](https://console.anthropic.com).

**Step 2 — Audio devices**
- Click a device once → assigned to **You** (microphone)
- Click it again → assigned to **Interviewer** (system audio)
- Click a third time → deselected
- Pick a Whisper model (base.en is the sweet spot)
- Hit **Start listening**

**Step 3 — Interview**
The app listens automatically. When the interviewer speaks, it transcribes and fires the AI. The suggested answer appears instantly — just read it out.

---

## Mac: capturing system audio (interviewer's voice)

macOS blocks apps from recording system audio by default. You need a free virtual audio driver:

1. Download **BlackHole 2ch** from [existingSound.github.io/BlackHole](https://existingSound.github.io/BlackHole/)
2. Install it (takes ~2 minutes, no restart needed)
3. Go to **System Settings → Sound → Output** and select **BlackHole 2ch**
4. In the app, BlackHole will appear as an input device — assign it to **Interviewer**

> Your speakers will go silent when BlackHole is the output. To hear audio AND capture it, create a **Multi-Output Device** in Audio MIDI Setup (built into Mac) combining BlackHole + your speakers.

## Windows: system audio

Works natively — look for **Stereo Mix** or **What U Hear** in the device list and assign it to Interviewer. If you don't see it, right-click the speaker icon → Sound settings → Recording tab → right-click in empty space → "Show disabled devices".

---

## Controls

| Action | How |
|---|---|
| Switch to interviewer mode | `Cmd/Ctrl + 1` |
| Switch to "you said" mode | `Cmd/Ctrl + 2` |
| Clear chat | `Cmd/Ctrl + K` |
| Manual input | Type in the box + Enter |
| Toggle auto AI responses | ⚡ auto button |
| Adjust transparency | Opacity slider (bottom) |
| Audio setup | 🎙 button (top right) |
| Change API key | ⚿ button (top right) |

---

## Whisper models

| Model | Size | Speed | Accuracy |
|---|---|---|---|
| tiny.en | 32MB | Fastest | Good |
| base.en | 74MB | Fast | Better (recommended) |
| small.en | 244MB | Slower | Best |

---

## Screen share invisibility

Uses `setContentProtection(true)` — the window is excluded from all screen captures at the OS level.

- **macOS**: Works with all apps (Teams, Meet, Zoom, Loom, screenshots)
- **Windows 10 (2004+) / Windows 11**: Same via `WDA_EXCLUDEFROMCAPTURE`

Test it: start a screen share, look at the shared view — the overlay won't appear.

---

## Tech

- **Electron** — cross-platform desktop shell, always-on-top window
- **Python + Whisper** — local offline speech transcription (no audio sent to cloud)
- **sounddevice** — dual audio stream capture (mic + system audio simultaneously)
- **Anthropic Claude Sonnet** — generates interview answers in real time
