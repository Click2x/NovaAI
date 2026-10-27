// Preload of the chat window: exactly the calls the page needs, nothing else.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('novaChat', {
  getConfig: () => ipcRenderer.invoke('chat-config'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  close: () => ipcRenderer.send('chat-close'),
  toggleAvatar: () => ipcRenderer.send('radial-action', 'hide-toggle'),
  onAvatarVisible: (cb) => ipcRenderer.on('avatar-visible', (_e, v) => cb(!!v)),
})
