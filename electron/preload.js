const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nova', {
  setInteractive: (interactive) => ipcRenderer.send('set-interactive', !!interactive),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, p) => cb(p)),
  onDebug: (cb) => ipcRenderer.on('debug', (_e, on) => cb(on)),
})
