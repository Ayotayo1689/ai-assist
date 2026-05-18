// ─── State ────────────────────────────────────────────────────────────────────
let currentSource = 'interviewer';
let isAiLoading = false;
let autoMode = true;
let isDragging = false;
let dragStart = null;
let selectedMicDevice = null;
let selectedSystemDevice = null;
let isTranscribing = false;
let livePreviewEl = null;  // The live "hearing..." bubble

// ─── DOM ──────────────────────────────────────────────────────────────────────
const chatLog = document.getElementById('chat-log');
const msgInput = document.getElementById('msg-input');
const opacitySlider = document.getElementById('opacity-slider');
const opacityOut = document.getElementById('opacity-out');
const statusPill = document.getElementById('status-pill');
const statusText = document.getElementById('status-text');
const autoToggle = document.getElementById('auto-toggle');

// ─── Screen navigation ────────────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function goToKey() { showScreen('screen-key'); }
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
  if (ok) {
    showScreen('screen-devices');
    loadDevices();
  }
});

// ─── Device picker ────────────────────────────────────────────────────────────
async function loadDevices() {
  const loading = document.getElementById('devices-loading');
  const errEl = document.getElementById('devices-error');
  const colsEl = document.getElementById('device-cols');
  const noteEl = document.getElementById('none-note');

  loading.style.display = 'block';
  errEl.style.display = 'none';
  colsEl.style.display = 'none';
  noteEl.style.display = 'none';
  document.getElementById('mic-list').innerHTML = '';
  document.getElementById('system-list').innerHTML = '';
  selectedMicDevice = null;
  selectedSystemDevice = null;

  const result = await window.electron.listAudioDevices();
  loading.style.display = 'none';

  if (result.error) {
    errEl.textContent = result.error;
    errEl.style.display = 'block';
    if (result.error.includes('Missing dependency') || result.error.includes('Python')) {
      errEl.innerHTML = result.error + '<br><br>' +
        '<b>Install dependencies:</b><br>' +
        '<code style="font-size:11px;color:#FEBC2E">pip3 install openai-whisper sounddevice numpy</code>';
    }
    return;
  }

  let devices = (result.devices || []).filter(d => d.inputs > 0);

  if (devices.length === 0) {
    errEl.textContent = 'No input devices found.';
    errEl.style.display = 'block';
    noteEl.style.display = 'block';
    return;
  }

  // Sort: WASAPI first, then DirectSound; hide generic mapper and low-level WDM-KS entries
  const apiRank = (d) => {
    const api = (d.hostapi || '').toLowerCase();
    if (api.includes('wasapi')) return 0;
    if (api.includes('directsound') || api.includes('direct sound')) return 1;
    if (api.includes('mme')) return 2;
    return 99;
  };
  devices = devices
    .filter(d => {
      const api = (d.hostapi || '').toLowerCase();
      const name = d.name.toLowerCase();
      return !name.includes('microsoft sound mapper') && !api.includes('wdm-ks') && !api.includes('wdm ks');
    })
    .sort((a, b) => apiRank(a) - apiRank(b));

  const micList = document.getElementById('mic-list');
  const systemList = document.getElementById('system-list');

  devices.forEach(d => {
    micList.appendChild(makeDeviceItem(d, 'mic'));
    systemList.appendChild(makeDeviceItem(d, 'system'));
  });

  colsEl.style.display = 'flex';

  const hasVirtualDevice = devices.some(d =>
    d.name.toLowerCase().includes('blackhole') ||
    d.name.toLowerCase().includes('stereo mix') ||
    d.name.toLowerCase().includes('virtual') ||
    d.name.toLowerCase().includes('loopback')
  );
  if (!hasVirtualDevice) noteEl.style.display = 'block';
}

function makeDeviceItem(device, role) {
  const item = document.createElement('div');
  item.className = 'device-item';
  item.dataset.index = device.index;

  const dot = document.createElement('div');
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
    if (role === 'mic') {
      selectedMicDevice = selectedMicDevice === device.index ? null : device.index;
      // If this device was already selected as interviewer, clear it
      if (selectedMicDevice !== null && selectedSystemDevice === selectedMicDevice) {
        selectedSystemDevice = null;
        refreshColSelection('system-list', selectedSystemDevice, 'sel-i');
      }
      refreshColSelection('mic-list', selectedMicDevice, 'sel-y');
    } else {
      selectedSystemDevice = selectedSystemDevice === device.index ? null : device.index;
      // If this device was already selected as mic, clear it
      if (selectedSystemDevice !== null && selectedMicDevice === selectedSystemDevice) {
        selectedMicDevice = null;
        refreshColSelection('mic-list', selectedMicDevice, 'sel-y');
      }
      refreshColSelection('system-list', selectedSystemDevice, 'sel-i');
    }
  });

  return item;
}

function refreshColSelection(listId, selectedIndex, cls) {
  document.querySelectorAll(`#${listId} .device-item`).forEach(el => {
    const idx = parseInt(el.dataset.index);
    el.className = idx === selectedIndex ? `device-item ${cls}` : 'device-item';
  });
}

async function startSession() {
  if (selectedMicDevice === null && selectedSystemDevice === null) {
    // Allow starting without devices — manual mode
    showScreen('screen-main');
    addSystemMsg('No audio devices selected — running in manual mode. Type what is said and press Enter.');
    return;
  }

  const model = document.getElementById('model-select').value;
  showScreen('screen-main');
  addSystemMsg(`Loading Whisper (${model})... this takes ~10–30 seconds the first time.`);
  setStatus('loading', 'loading whisper...');

  await window.electron.startTranscription({
    micDevice: selectedMicDevice,
    systemDevice: selectedSystemDevice,
    model
  });
}

// ─── Transcription events ─────────────────────────────────────────────────────
window.electron.onTranscriptionEvent((msg) => {
  switch (msg.type) {
    case 'ready':
      isTranscribing = true;
      setStatus('listening', 'listening');
      addSystemMsg('Whisper ready. Listening to both audio streams automatically.');
      break;

    case 'stream_started':
      addSystemMsg(`Audio stream active — ${msg.role === 'interviewer' ? 'system audio (interviewer)' : 'microphone (you)'}`);
      break;

    case 'loading':
      setStatus('loading', msg.message || 'loading...');
      break;

    case 'transcribing':
      setStatus('listening', `transcribing ${msg.role}...`);
      break;

    case 'transcript':
      handleTranscript(msg.role, msg.text);
      setStatus('listening', 'listening');
      break;

    case 'stopped':
      isTranscribing = false;
      setStatus('ready', 'stopped');
      addSystemMsg('Audio stopped.');
      break;

    case 'error':
      setStatus('error', 'error');
      addMsg('error', msg.message || 'Audio error');
      break;
  }
});

async function handleTranscript(role, text) {
  // Add the spoken text to chat
  addMsg(role, text);

  // If it was the interviewer and auto mode is on, ask AI
  if (role === 'interviewer' && autoMode) {
    await askAI(text);
  }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + role;

  const label = document.createElement('div');
  label.className = 'msg-label';

  if (role === 'interviewer') label.textContent = 'Interviewer';
  else if (role === 'you') label.textContent = 'You';
  else if (role === 'ai') {
    label.innerHTML = 'AI <span class="ai-badge">read this</span>';
  } else label.textContent = role === 'error' ? 'Error' : '';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;

  div.appendChild(label);
  div.appendChild(bubble);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'msg system';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = text;
  div.appendChild(bubble);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function addTyping() {
  const div = document.createElement('div');
  div.className = 'msg ai';
  div.id = 'typing';
  const label = document.createElement('div');
  label.className = 'msg-label';
  label.innerHTML = 'AI <span class="ai-badge">thinking</span>';
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  div.appendChild(label);
  div.appendChild(bubble);
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeTyping() {
  const el = document.getElementById('typing');
  if (el) el.remove();
}

function clearAll() {
  chatLog.innerHTML = '';
  window.electron.clearConversation();
}

// ─── AI ───────────────────────────────────────────────────────────────────────
async function askAI(question) {
  if (isAiLoading) return;
  isAiLoading = true;
  setStatus('thinking', 'thinking...');
  addTyping();

  const result = await window.electron.askAI({ question });
  removeTyping();

  if (result.error) {
    addMsg('error', result.error);
    setStatus('error', 'error');
  } else {
    addMsg('ai', result.reply);
    setStatus('listening', isTranscribing ? 'listening' : 'ready');
  }

  isAiLoading = false;
}

// ─── Manual input ─────────────────────────────────────────────────────────────
function setSrc(src) {
  currentSource = src;
  document.getElementById('btn-i').className = 'src-btn' + (src === 'interviewer' ? ' active-i' : '');
  document.getElementById('btn-y').className = 'src-btn' + (src === 'you' ? ' active-y' : '');
  msgInput.placeholder = src === 'interviewer'
    ? 'Type what the interviewer said...'
    : 'Type what you said...';
  msgInput.focus();
}

async function submitManual() {
  const text = msgInput.value.trim();
  if (!text || isAiLoading) return;
  msgInput.value = '';
  await handleTranscript(currentSource, text);
}

msgInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitManual(); }
});

// ─── Auto mode ────────────────────────────────────────────────────────────────
function toggleAutoMode() {
  autoMode = !autoMode;
  autoToggle.className = autoMode ? 'on' : '';
  autoToggle.textContent = autoMode ? 'auto on' : 'auto off';
  document.getElementById('btn-auto').style.opacity = autoMode ? '1' : '0.5';
}
// Init state
autoToggle.className = 'on';
autoToggle.textContent = 'auto on';

// ─── Status pill ──────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusPill.className = '';
  if (state === 'listening') statusPill.classList.add('listening');
  else if (state === 'thinking') statusPill.classList.add('thinking');
  else if (state === 'error') statusPill.classList.add('error');
  statusText.textContent = text;
}

// ─── Opacity ──────────────────────────────────────────────────────────────────
opacitySlider.addEventListener('input', () => {
  const v = parseInt(opacitySlider.value);
  opacityOut.textContent = v + '%';
  window.electron.setOpacity(v / 100);
});

// ─── Drag ─────────────────────────────────────────────────────────────────────
const titlebar = document.getElementById('titlebar');
titlebar.addEventListener('mousedown', e => {
  if (e.target.tagName === 'BUTTON' || e.target.classList.contains('tl')) return;
  isDragging = true;
  dragStart = { x: e.screenX, y: e.screenY };
});
document.addEventListener('mousemove', e => {
  if (!isDragging || !dragStart) return;
  window.electron.moveWindow({ deltaX: e.screenX - dragStart.x, deltaY: e.screenY - dragStart.y });
  dragStart = { x: e.screenX, y: e.screenY };
});
document.addEventListener('mouseup', () => { isDragging = false; dragStart = null; });

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === '1') { setSrc('interviewer'); e.preventDefault(); }
  if ((e.metaKey || e.ctrlKey) && e.key === '2') { setSrc('you'); e.preventDefault(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { clearAll(); e.preventDefault(); }
});

// ─── Link helper ──────────────────────────────────────────────────────────────
function openLink(url) {
  // Electron will handle this via the default browser
  window.open(url);
}
