const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // Window
  closeWindow: () => ipcRenderer.send('window-close'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  moveWindow: (delta) => ipcRenderer.send('window-move', delta),
  setOpacity: (val) => ipcRenderer.send('set-opacity', val),

  // API key
  setApiKey: (key) => ipcRenderer.send('set-api-key', key),
  onApiKeySet: (cb) => ipcRenderer.on('api-key-set', (_, v) => cb(v)),

  // AI
  askAI: (payload) => ipcRenderer.invoke('ask-ai', payload),
  clearConversation: () => ipcRenderer.send('clear-conversation'),

  // Mic
  requestMicPermission: () => ipcRenderer.invoke('request-mic-permission'),

  // Transcription
  listAudioDevices: () => ipcRenderer.invoke('list-audio-devices'),
  startTranscription: (opts) => ipcRenderer.invoke('start-transcription', opts),
  stopTranscription: () => ipcRenderer.send('stop-transcription'),
  onTranscriptionEvent: (cb) => ipcRenderer.on('transcription-event', (_, msg) => cb(msg)),
});
