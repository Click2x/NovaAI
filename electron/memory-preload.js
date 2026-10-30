// Preload of the memory window: its configuration and the text export. Nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaMemory', Object.freeze({
  config: () => ipcRenderer.invoke('memory-config'),
  exportFacts: () => ipcRenderer.invoke('memory-export'),
}))
