// Preload of the chat window: exactly the calls the page needs, nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaChat', {
  getConfig: () => ipcRenderer.invoke('chat-config'),
  drag: (phase, dx, dy) => ipcRenderer.send('chat-drag', String(phase), Number(dx) || 0, Number(dy) || 0),
  onLocked: (cb) => ipcRenderer.on('layout-locked', (_e, v) => cb(!!v)),
  close: () => ipcRenderer.send('chat-close'),
  toggleAvatar: () => ipcRenderer.send('radial-action', 'hide-toggle'),
  onAvatarVisible: (cb) => ipcRenderer.on('avatar-visible', (_e, v) => cb(!!v)),
})
