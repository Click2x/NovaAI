// Preload for the Code window. The page gets exactly three calls: its configuration, a native folder picker, and "use this folder as the
// workspace" (the main process asks the backend to validate and save it). Nothing else crosses.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaCode', Object.freeze({
  config: () => ipcRenderer.invoke('code-config'),
  pickFolder: () => ipcRenderer.invoke('code-pick-folder'),
  setWorkspace: (folder) => ipcRenderer.invoke('code-set-workspace', String(folder)),
}))
