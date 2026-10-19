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
  onOpenInput: (cb) => ipcRenderer.on('open-input', () => cb()),
})
