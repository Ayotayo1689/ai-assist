// ─── State ────────────────────────────────────────────────────────────────────
let isReady        = false;
let isRecording    = false;
let isProcessing   = false;
let selectedDevices = [];
let liveTranscriptEl   = null;
let liveTranscriptText = '';
let aiStreamBubble     = null;

// Word-by-word typing effect
let wordQueue      = [];
let typingTimer    = null;
const WORD_DELAY   = 80; // ms between words

// ─── DOM ──────────────────────────────────────────────────────────────────────
const chatLog      = document.getElementById('chat-log');
const msgInput     = document.getElementById('msg-input');
const opacitySlider = document.getElementById('opacity-slider');
const opacityOut   = document.getElementById('opacity-out');
const statusPill   = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const recordBtn    = document.getElementById('record-btn');

// ─── Screen navigation ────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function goToKey()     { showScreen('screen-key'); }
function goToDevices() { showScreen('screen-devices'); loadDevices(); }

// ─── API key ──────────────────────────────────────────────────────────────────
document.getElementById('api-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') saveKey();
});
function saveKey() {
  const key = document.getElementById('api-input').value.trim();
  if (!key.startsWith('sk-ant-')) {
    const el = document.getElementById('api-input');
    el.style.borderColor = '#FF5F57';
    setTimeout(() => { el.style.borderColor = ''; }, 1200);
    return;
  }
  window.electron.setApiKey(key);
}
window.electron.onApiKeySet((ok) => {
  if (ok) { showScreen('screen-devices'); loadDevices(); }
});

// ─── Device picker ────────────────────────────────────────────────────────────
async function loadDevices() {
  const loading = document.getElementById('devices-loading');
  const errEl   = document.getElementById('devices-error');
  const listEl  = document.getElementById('device-list');
  const noteEl  = document.getElementById('none-note');

  loading.style.display = 'block';
  errEl.style.display   = 'none';
  listEl.style.display  = 'none';
  noteEl.style.display  = 'none';
  listEl.innerHTML = '';
  selectedDevices  = [];

  const result = await window.electron.listAudioDevices();
  loading.style.display = 'none';

  if (result.error) {
    errEl.textContent = result.error;
    errEl.style.display = 'block';
    if (result.error.includes('Missing dependency') || result.error.includes('Python')) {
      errEl.innerHTML = result.error + '<br><br><b>Install dependencies:</b><br>' +
        '<code style="font-size:11px;color:#FEBC2E">pip3 install openai-whisper sounddevice numpy</code>';
    }
    return;
  }

  let devices = (result.devices || []).filter(d => d.inputs > 0);
  if (devices.length === 0) {
    errEl.textContent   = 'No input devices found.';
    errEl.style.display = 'block';
    noteEl.style.display = 'block';
    return;
  }

  const apiRank = d => {
    const a = (d.hostapi || '').toLowerCase();
    if (a.includes('wasapi'))      return 0;
    if (a.includes('directsound')) return 1;
    if (a.includes('mme'))         return 2;
    return 99;
  };
  devices = devices
    .filter(d => {
      const a = (d.hostapi || '').toLowerCase();
      return !d.name.toLowerCase().includes('microsoft sound mapper')
          && !a.includes('wdm-ks') && !a.includes('wdm ks');
    })
    .sort((a, b) => apiRank(a) - apiRank(b));

  devices.forEach(d => listEl.appendChild(makeDeviceItem(d)));
  listEl.style.display = 'flex';

  const hasLoopback = devices.some(d =>
    ['blackhole','stereo mix','virtual','loopback'].some(k => d.name.toLowerCase().includes(k))
  );
  if (!hasLoopback) noteEl.style.display = 'block';
}

function makeDeviceItem(device) {
  const item = document.createElement('div');
  item.className    = 'device-item';
  item.dataset.index = device.index;

  const dot  = document.createElement('div');
  dot.className = 'di-dot';

  const info = document.createElement('div');
  info.className = 'di-info';

  const name = document.createElement('div');
  name.className = 'di-name';
  name.textContent = device.name;
  name.title = device.name;
  info.appendChild(name);

  if (device.hostapi) {
    const api = document.createElement('div');
    api.className = 'di-api';
    api.textContent = device.hostapi;
    info.appendChild(api);
  }

  item.appendChild(dot);
  item.appendChild(info);

  item.addEventListener('click', () => {
    const idx = device.index;
    if (selectedDevices.includes(idx)) {
      selectedDevices   = selectedDevices.filter(i => i !== idx);
      item.className    = 'device-item';
    } else {
      selectedDevices.push(idx);
      item.className    = 'device-item selected';
    }
  });

  return item;
}

async function startSession() {
  if (selectedDevices.length === 0) {
    showScreen('screen-main');
    addSystemMsg('No audio devices selected — use the text box to type manually.');
    setStatus('ready', 'ready');
    return;
  }
  const model = document.getElementById('model-select').value;
  showScreen('screen-main');
  addSystemMsg(`Loading Whisper (${model})… first load takes ~10–30 s.`);
  setStatus('loading', 'loading...');
  await window.electron.startTranscription({
    micDevice:    selectedDevices[0] ?? null,
    systemDevice: selectedDevices[1] ?? null,
    model
  });
}

// ─── Transcription events ─────────────────────────────────────────────────────
window.electron.onTranscriptionEvent((msg) => {
  switch (msg.type) {
    case 'ready':
      isReady = true;
      setStatus('ready', 'ready');
      addSystemMsg('Ready — press Start Listening to begin.');
      setRecordBtn(false);
      break;

    case 'loading':
      setStatus('loading', msg.message || 'loading...');
      break;

    case 'recording_started':
      isRecording = true;
      liveTranscriptText = '';
      resetTyping();
      liveTranscriptEl   = addLiveTranscript();
      setStatus('recording', 'listening...');
      setRecordBtn(true);
      break;

    case 'chunk':
      if (msg.text) {
        liveTranscriptText += (liveTranscriptText ? ' ' : '') + msg.text;
        enqueueWords(msg.text);
      }
      break;

    case 'recording_stopped':
      isRecording = false;
      setRecordBtn(false);
      flushWords();
      if (liveTranscriptEl) liveTranscriptEl.classList.remove('live'); // stop cursor
      liveTranscriptEl = null;
      if (liveTranscriptText.trim()) {
        askAI(liveTranscriptText.trim());
      } else {
        addSystemMsg('No speech detected — try again.');
        setStatus('ready', 'ready');
      }
      liveTranscriptText = '';
      break;

    case 'stopped':
      isReady = isRecording = false;
      setRecordBtn(false);
      setStatus('ready', 'stopped');
      addSystemMsg('Session ended.');
      break;

    case 'error':
      isProcessing = isRecording = false;
      setRecordBtn(false);
      setStatus('error', 'error');
      addMsg('error', msg.message || 'Error');
      break;
  }
});

// ─── AI streaming ─────────────────────────────────────────────────────────────
window.electron.onAiChunk((text) => {
  if (!aiStreamBubble) {
    const { div, bubble } = createAiMsg();
    aiStreamBubble = bubble;
    chatLog.appendChild(div);
  }
  aiStreamBubble.textContent += text;
  chatLog.scrollTop = chatLog.scrollHeight;
});

window.electron.onAiDone(() => {
  aiStreamBubble = null;
  isProcessing   = false;
  setStatus('ready', 'ready');
});

// ─── Record button ────────────────────────────────────────────────────────────
function toggleRecording() {
  if (isProcessing) return;
  if (isRecording) {
    isRecording = false;
    setRecordBtn(false);
    setStatus('thinking', 'transcribing...');
    window.electron.stopRecording();
  } else {
    window.electron.startRecording();
  }
}

function setRecordBtn(recording) {
  if (recording) {
    recordBtn.textContent = '⏹ Stop Listening';
    recordBtn.classList.add('recording');
  } else {
    recordBtn.textContent = '🎙 Start Listening';
    recordBtn.classList.remove('recording');
  }
}

// ─── Word-by-word typing effect ───────────────────────────────────────────────
function enqueueWords(text) {
  const words = text.split(/\s+/).filter(Boolean);
  wordQueue.push(...words);
  if (!typingTimer) tickTyping();
}

function tickTyping() {
  if (!wordQueue.length) { typingTimer = null; return; }
  const word   = wordQueue.shift();
  const bubble = liveTranscriptEl && liveTranscriptEl.querySelector('.msg-bubble');
  if (bubble) {
    bubble.textContent += (bubble.textContent ? ' ' : '') + word;
    chatLog.scrollTop   = chatLog.scrollHeight;
  }
  typingTimer = setTimeout(tickTyping, WORD_DELAY);
}

// Stop the timer and instantly show all remaining queued words.
function flushWords() {
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
  if (!wordQueue.length) return;
  const bubble = liveTranscriptEl && liveTranscriptEl.querySelector('.msg-bubble');
  if (bubble) {
    bubble.textContent += (bubble.textContent ? ' ' : '') + wordQueue.join(' ');
    chatLog.scrollTop   = chatLog.scrollHeight;
  }
  wordQueue = [];
}

// Hard reset — used only when starting a fresh recording.
function resetTyping() {
  if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
  wordQueue = [];
}

// ─── Chat helpers ─────────────────────────────────────────────────────────────
function addLiveTranscript() {
  const div   = document.createElement('div');
  div.className = 'msg transcript live';
  const label = document.createElement('div');
  label.className   = 'msg-label';
  label.textContent = 'Heard';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  div.appendChild(label);
  div.appendChild(bubble);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

function createAiMsg() {
  const div   = document.createElement('div');
  div.className = 'msg ai';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.innerHTML = 'AI <span class="ai-badge">say this</span>';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  div.appendChild(label);
  div.appendChild(bubble);
  return { div, bubble };
}

function addMsg(role, text) {
  const div    = document.createElement('div');
  div.className = 'msg ' + role;
  const label  = document.createElement('div');
  label.className = 'msg-label';
  if (role === 'error') label.textContent = 'Error';
  const bubble = document.createElement('div');
  bubble.className   = 'msg-bubble';
  bubble.textContent = text;
  div.appendChild(label);
  div.appendChild(bubble);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addSystemMsg(text) {
  const div    = document.createElement('div');
  div.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className   = 'msg-bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearAll() {
  chatLog.innerHTML = '';
  window.electron.clearConversation();
}

// ─── AI ───────────────────────────────────────────────────────────────────────
async function askAI(transcript) {
  isProcessing = true;
  setStatus('thinking', 'thinking...');
  aiStreamBubble = null;

  const result = await window.electron.askAI({ question: transcript });
  if (result && result.error) {
    addMsg('error', result.error);
    setStatus('error', 'error');
    isProcessing = false;
  }
  // Successful path: chunks arrive via onAiChunk → onAiDone
}

// ─── Manual input ─────────────────────────────────────────────────────────────
async function submitManual() {
  const text = msgInput.value.trim();
  if (!text || isProcessing) return;
  msgInput.value = '';
  // Show as a transcript bubble then ask AI
  const div = addLiveTranscript();
  div.querySelector('.msg-bubble').textContent = text;
  liveTranscriptEl = null;
  await askAI(text);
}
msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitManual(); }
});

// ─── Status pill ──────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusPill.className = '';
  if      (state === 'recording')                  statusPill.classList.add('recording');
  else if (state === 'loading' || state === 'thinking') statusPill.classList.add('thinking');
  else if (state === 'ready')                      statusPill.classList.add('listening');
  else if (state === 'error')                      statusPill.classList.add('error');
  statusText.textContent = text;
}

// ─── Opacity ──────────────────────────────────────────────────────────────────
opacitySlider.addEventListener('input', () => {
  const v = parseInt(opacitySlider.value);
  opacityOut.textContent = v + '%';
  window.electron.setOpacity(v / 100);
});

// ─── Drag — absolute positioning to prevent window from growing ───────────────
let isDragging     = false;
let dragMouseOrigin = null;
let dragWinOrigin   = null;

const titlebar = document.getElementById('titlebar');
titlebar.addEventListener('mousedown', e => {
  if (e.target.tagName === 'BUTTON' || e.target.classList.contains('tl')) return;
  isDragging      = true;
  dragMouseOrigin = { x: e.screenX, y: e.screenY };
  const pos       = window.electron.getWindowPosition(); // sync [x, y]
  dragWinOrigin   = { x: pos[0], y: pos[1] };
});
document.addEventListener('mousemove', e => {
  if (!isDragging || !dragWinOrigin) return;
  window.electron.setWindowPosition({
    x: dragWinOrigin.x + (e.screenX - dragMouseOrigin.x),
    y: dragWinOrigin.y + (e.screenY - dragMouseOrigin.y)
  });
});
document.addEventListener('mouseup', () => {
  isDragging = false;
  dragMouseOrigin = null;
  dragWinOrigin   = null;
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { clearAll(); e.preventDefault(); }
});

function openLink(url) { window.open(url); }
