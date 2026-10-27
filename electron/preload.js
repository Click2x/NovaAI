const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nova', {
  setInteractive: (interactive) => ipcRenderer.send('set-interactive', !!interactive),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  idleSeconds: () => ipcRenderer.invoke('idle-seconds'),
  inputClosed: () => ipcRenderer.send('input-closed'),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onDebug: (cb) => ipcRenderer.on('debug', (_e, on) => cb(on)),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getWindow: () => ipcRenderer.invoke('get-window'),
  onWindow: (cb) => ipcRenderer.on('window', (_e, w) => cb(w)),
  smokeWav: (i) => ipcRenderer.invoke('smoke-wav', i),
  smokeLog: (line) => ipcRenderer.send('smoke-log', line),
  onInterrupt: (cb) => ipcRenderer.on('interrupt', () => cb()),
  // settings panel + live changes (main owns the file; see electron/settings.js)
  settingsGet: () => ipcRenderer.invoke('settings-get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings-set', patch),
  settingsReset: () => ipcRenderer.invoke('settings-reset'),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', () => cb()),
  openSettings: () => ipcRenderer.send('open-settings'),
  netStatus: (info) => ipcRenderer.send('net-status', info),
  backendVersion: (v) => ipcRenderer.send('backend-version', v),
  onRetry: (cb) => ipcRenderer.on('retry-connect', () => cb()),
  onOpenInput: (cb) => ipcRenderer.on('open-input', () => cb()),
  // notification centre (P8)
  notesState: (list) => ipcRenderer.send('notes-state', list),
  onNotesClear: (cb) => ipcRenderer.on('notes-clear', () => cb()),
  foregroundState: () => ipcRenderer.invoke('foreground-state'),
  // radial menu (display/chat window, main.js handles the ids)
  radial: (id) => ipcRenderer.send('radial-action', String(id)),
})
