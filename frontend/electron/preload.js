const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  setUserId: (userId) => ipcRenderer.send('set-user-id', String(userId))
});
