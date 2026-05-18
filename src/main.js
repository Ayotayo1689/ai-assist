const { app, BrowserWindow, ipcMain, systemPreferences } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');

let mainWindow;
let apiKey = '';
let client = null;
let conversationHistory = [];
let transcribeProcess = null;

// ─── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 640,
    minWidth: 340,
    minHeight: 480,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.setContentProtection(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('closed', () => {
    stopTranscription();
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  stopTranscription();
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Window controls ──────────────────────────────────────────────────────────

ipcMain.on('window-close', () => {
  stopTranscription();
  mainWindow.close();
});

ipcMain.on('window-minimize', () => mainWindow.minimize());

ipcMain.on('window-move', (event, { deltaX, deltaY }) => {
  const [x, y] = mainWindow.getPosition();
  mainWindow.setPosition(x + deltaX, y + deltaY);
});

ipcMain.on('set-opacity', (event, value) => {
  mainWindow.setOpacity(value);
});

// ─── API key ──────────────────────────────────────────────────────────────────

ipcMain.on('set-api-key', (event, key) => {
  apiKey = key.trim();
  client = new Anthropic({ apiKey });
  event.reply('api-key-set', true);
});

// ─── AI ───────────────────────────────────────────────────────────────────────

ipcMain.on('clear-conversation', () => {
  conversationHistory = [];
});

ipcMain.handle('ask-ai', async (event, { question }) => {
  if (!client) return { error: 'No API key set. Click ⚿ to add your Anthropic API key.' };

  const systemPrompt = `You are a real-time interview coach. The user is in a live job interview right now and needs you to generate the ideal answer they should say out loud — immediately, naturally, and confidently.

Rules:
- Write entirely in first person as if YOU are the candidate speaking
- Respond with 2-4 natural sentences unless the question clearly demands more detail
- Sound like a confident, articulate professional — not robotic or over-rehearsed
- Never add preamble like "Here's what you should say" — write the answer directly
- If it's small talk or a greeting, give a brief warm human response
- Draw on the conversation history to stay consistent with previous answers`;

  conversationHistory.push({ role: 'user', content: question });
  const trimmedHistory = conversationHistory.slice(-20);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      messages: trimmedHistory
    });

    const reply = response.content.map(b => b.text || '').join('');
    conversationHistory.push({ role: 'assistant', content: reply });
    return { reply };
  } catch (err) {
    return { error: err.message || 'API error. Check your key and try again.' };
  }
});

// ─── Mic permission ───────────────────────────────────────────────────────────

ipcMain.handle('request-mic-permission', async () => {
  if (process.platform === 'darwin') {
    const status = await systemPreferences.askForMediaAccess('microphone');
    return status;
  }
  return true;
});

// ─── Python transcription process ─────────────────────────────────────────────

function getPythonCmd() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

function getScriptPath() {
  return path.join(__dirname, 'transcribe.py');
}

ipcMain.handle('list-audio-devices', async () => {
  return new Promise((resolve) => {
    const py = spawn(getPythonCmd(), [getScriptPath(), '--list-devices']);
    let output = '';
    let error = '';

    py.stdout.on('data', (data) => { output += data.toString(); });
    py.stderr.on('data', (data) => { error += data.toString(); });

    py.on('close', () => {
      try {
        const lines = output.trim().split('\n').filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.type === 'devices') { resolve({ devices: msg.devices }); return; }
          if (msg.type === 'error') { resolve({ error: msg.message }); return; }
        }
        resolve({ error: error || 'Could not list devices. Is Python + sounddevice installed?' });
      } catch (e) {
        resolve({ error: `Python error: ${error || output || e.message}` });
      }
    });

    setTimeout(() => { py.kill(); resolve({ error: 'Timeout. Check Python is installed.' }); }, 30000);
  });
});

ipcMain.handle('start-transcription', async (event, { micDevice, systemDevice, model }) => {
  stopTranscription();

  const args = [getScriptPath(), '--model', model || 'base.en'];
  if (micDevice !== null && micDevice !== undefined) args.push('--mic-device', String(micDevice));
  if (systemDevice !== null && systemDevice !== undefined) args.push('--system-device', String(systemDevice));

  transcribeProcess = spawn(getPythonCmd(), args);

  const rl = readline.createInterface({ input: transcribeProcess.stdout });
  rl.on('line', (line) => {
    try {
      const msg = JSON.parse(line.trim());
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcription-event', msg);
      }
    } catch (e) {}
  });

  transcribeProcess.stderr.on('data', (data) => {
    const text = data.toString().trim();
    // Filter out benign Whisper/torch warnings
    if (text && !text.includes('UserWarning') && !text.includes('FutureWarning')) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcription-event', { type: 'stderr', message: text });
      }
    }
  });

  transcribeProcess.on('close', () => {
    transcribeProcess = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcription-event', { type: 'stopped' });
    }
  });

  return { ok: true };
});

ipcMain.on('stop-transcription', () => stopTranscription());

function stopTranscription() {
  if (transcribeProcess) {
    try {
      transcribeProcess.stdin.write('quit\n');
      setTimeout(() => { if (transcribeProcess) { transcribeProcess.kill(); transcribeProcess = null; } }, 1500);
    } catch (e) {
      try { transcribeProcess.kill(); } catch (_) {}
      transcribeProcess = null;
    }
  }
}
