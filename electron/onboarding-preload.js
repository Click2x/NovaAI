// Preload of the setup window: its configuration, the avatar picker, one allow-listed external link, and the two ways to leave. Nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaSetup', Object.freeze({
  config: () => ipcRenderer.invoke('onboarding-config'),
  pickAvatar: () => ipcRenderer.invoke('onboarding-pick-avatar'),
  openExternal: (url) => ipcRenderer.invoke('onboarding-open-external', String(url)),
  finish: () => ipcRenderer.send('onboarding-finish'),
  later: () => ipcRenderer.send('onboarding-later'),
}))
