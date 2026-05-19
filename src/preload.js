const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // Window
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  getWindowPosition: () => ipcRenderer.sendSync('get-window-position'),
  setWindowPosition: (pos) => ipcRenderer.send('set-window-position', pos),
  setOpacity: (val) => ipcRenderer.send('set-opacity', val),

  // API key
  setApiKey: (key) => ipcRenderer.send('set-api-key', key),
  onApiKeySet: (cb) => ipcRenderer.on('api-key-set', (_, v) => cb(v)),

  // Resume
  uploadResume: () => ipcRenderer.invoke('upload-resume'),

  // AI
  askAI: (payload) => ipcRenderer.invoke('ask-ai', payload),
  clearConversation: () => ipcRenderer.send('clear-conversation'),
  onAiChunk: (cb) => ipcRenderer.on('ai-chunk', (_, d) => cb(d.text)),
  onAiDone: (cb) => ipcRenderer.on('ai-done', () => cb()),

  // Mic
  requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),

  // Transcription
  listAudioDevices: () => ipcRenderer.invoke('list-audio-devices'),
  startTranscription: (opts) => ipcRenderer.invoke('start-transcription', opts),
  stopTranscription: () => ipcRenderer.send('stop-transcription'),
  startRecording: () => ipcRenderer.send('start-recording'),
  stopRecording: () => ipcRenderer.send('stop-recording'),
  onTranscriptionEvent: (cb) => ipcRenderer.on('transcription-event', (_, msg) => cb(msg)),
});
