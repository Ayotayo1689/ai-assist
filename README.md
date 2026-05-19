# Interview Assistant

Real-time AI interview coach. Floats over your screen, hidden from screen sharing, listens to the interviewer's audio, and suggests answers you can say out loud — word by word as they stream in.

---

## Requirements

- **Node.js** v18 or later
- **Python** 3.8 or later
- **VB-Cable** (free virtual audio device — needed to capture the interviewer's voice)

---

## Installation

### 1. Install VB-Cable (one-time, Windows)

Download and install from **vb-audio.com/Cable** — free, takes under a minute. Restart when prompted.

After installing, open your video call app (Zoom, Teams, Google Meet) and go to its audio settings. Set the **Speaker output** to **CABLE Input (VB-Audio Virtual Cable)**. This routes the interviewer's voice into a device the app can record from.

> If you don't change the speaker output in your call app, the app won't hear the interviewer.

### 2. Install Node dependencies

```bash
npm install
```

### 3. Install Python dependencies

```bash
pip install faster-whisper sounddevice numpy
```

> The first run downloads the Whisper model (~32MB for `tiny.en`). This happens once and is cached locally.

### 4. Run

```bash
npm start
```

---

## App setup flow

### Step 1 — API key

Paste your Anthropic API key (`sk-ant-...`). Get one free at [console.anthropic.com](https://console.anthropic.com).

### Step 2 — Resume (optional)

Upload your resume as a PDF or TXT file. The AI uses it to tailor answers to your actual experience — job titles, skills, past companies. Hit **Skip** if you'd rather skip this.

### Step 3 — Audio device

Select **CABLE Output (VB-Audio Virtual Cable)** from the list — this is the device that captures what the interviewer says through your call app.

Pick a Whisper model (see table below), then hit **Start**.

### Step 4 — Interview

Press **Start Listening** when the interviewer speaks. Press **Stop Listening** when they're done. The app transcribes the audio and sends it to the AI. The suggested answer streams back word by word — just read it out loud.

You can also type manually in the text box and press **Enter** if you don't want to use audio.

---

## Whisper models

| Model | Size | Speed | Best for |
|---|---|---|---|
| tiny.en | 32 MB | Fastest (~0.5s) | Most interviews |
| base.en | 74 MB | Fast (~1–2s) | Better accuracy |
| small.en | 244 MB | Slower (~3–5s) | Heavy accents |

`tiny.en` is the default and works well for clear English speech.

---

## Controls

| Action | How |
|---|---|
| Start / stop recording | **Start Listening** button |
| Send text manually | Type in the box + **Enter** |
| Clear chat | **Cmd/Ctrl + K** |
| Adjust transparency | Opacity slider (bottom) |
| Audio setup | 🎙 button (top right) |
| Change API key | ⚿ button (top right) |

---

## Screen share invisibility

The window uses `setContentProtection(true)` — it is excluded from all screen captures at the OS level. Interviewers cannot see it on Zoom, Teams, Google Meet, or any other screen sharing tool.

- **Windows 10 (build 2004+) / Windows 11** — excluded via `WDA_EXCLUDEFROMCAPTURE`
- **macOS** — excluded system-wide

To verify: start a screen share and check the shared view. The overlay will not appear.

---

## How it works

```
VB-Cable captures interviewer audio
        ↓
faster-whisper transcribes locally (no audio sent to cloud)
        ↓
Claude Haiku generates a suggested answer
        ↓
Answer streams word by word into the overlay
```

All audio processing happens on your machine. Only the transcript text is sent to Anthropic's API to generate the reply.

---

## Troubleshooting

**"No speech detected" after stopping**
- Make sure you selected **CABLE Output** (not your microphone) in the device list
- Make sure your call app's speaker is set to **CABLE Input** in its audio settings
- Speak clearly for at least 1 second before stopping

**Devices screen shows only microphone devices**
- VB-Cable is not installed, or you need to hit **Refresh** after installing it

**"Missing dependency" error on startup**
- Run `pip install faster-whisper sounddevice numpy` and restart the app

**Window not hiding in screen share**
- Requires Windows 10 build 2004 or later / Windows 11
