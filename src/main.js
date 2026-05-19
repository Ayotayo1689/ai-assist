const { app, BrowserWindow, ipcMain, systemPreferences, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const Anthropic = require('@anthropic-ai/sdk');

let mainWindow;
let apiKey = '';
let client = null;
let conversationHistory = [];
let transcribeProcess = null;
let resumeText = '';

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

// Sync: renderer calls this on mousedown to snapshot the starting position
ipcMain.on('get-window-position', (event) => {
  event.returnValue = mainWindow.getPosition(); // [x, y]
});

// Absolute positioning — prevents size drift on DPI-scaled displays
ipcMain.on('set-window-position', (event, { x, y }) => {
  const { width, height } = mainWindow.getBounds();
  mainWindow.setBounds({ x: Math.round(x), y: Math.round(y), width, height });
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

ipcMain.handle('upload-resume', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your resume',
    properties: ['openFile'],
    filters: [{ name: 'Documents', extensions: ['pdf', 'txt'] }]
  });

  if (canceled || !filePaths.length) return { canceled: true };

  const filePath = filePaths[0];
  const filename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  try {
    let text = '';
    if (ext === '.pdf') {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      text = data.text;
    } else {
      text = fs.readFileSync(filePath, 'utf8');
    }
    resumeText = text.trim();
    const preview = resumeText.substring(0, 300) + (resumeText.length > 300 ? '…' : '');
    return { ok: true, filename, preview };
  } catch (err) {
    return { error: `Could not read file: ${err.message}` };
  }
});

ipcMain.handle('ask-ai', async (event, { question }) => {
  if (!client) return { error: 'No API key set. Click ⚿ to add your Anthropic API key.' };

  const resumeSection = resumeText
    ? `\n\nCANDIDATE RESUME:\n${resumeText}\n\nUse the resume above to give personalized, specific answers that reference the candidate's actual experience, skills, and background.`
    : '';

  const systemPrompt = `You are a real-time interview coach. The user is in a live job interview. They will send you a transcript of what was just said — it may include both their words and the interviewer's words mixed together. Your job is to generate the ideal reply the user should say out loud next.

Rules:
- Write entirely in first person as if YOU are the candidate speaking
- Respond with 2-4 natural sentences unless the question clearly demands more detail
- Sound like a confident, articulate professional — not robotic or over-rehearsed
- Never add preamble like "Here's what you should say" — write the answer directly
- If the transcript contains both sides of a conversation, focus on what the interviewer asked or said last
- If it's small talk or a greeting, give a brief warm human response
- Draw on the conversation history to stay consistent${resumeSection}`;

  conversationHistory.push({ role: 'user', content: question });
  const trimmedHistory = conversationHistory.slice(-20);

  try {
    let fullReply = '';
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: trimmedHistory
    });

    stream.on('text', (text) => {
      fullReply += text;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ai-chunk', { text });
      }
    });

    await stream.finalMessage();
    conversationHistory.push({ role: 'assistant', content: fullReply });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ai-done');
    }
    return { ok: true };
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

ipcMain.on('start-recording', () => {
  if (transcribeProcess) transcribeProcess.stdin.write('start\n');
});

ipcMain.on('stop-recording', () => {
  if (transcribeProcess) transcribeProcess.stdin.write('stop\n');
});

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
