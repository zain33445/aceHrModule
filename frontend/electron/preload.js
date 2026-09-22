const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Existing: send authenticated userId to main process
  setUserId: (userId) => ipcRenderer.send('set-user-id', String(userId)),

  // Recording API — exposes read-only state to React UI (transparency layer)
  recording: {
    /** Returns current recording state: 'idle' | 'recording' | 'starting' | 'stopping' | 'error' */
    getState: () => ipcRenderer.invoke('recording:get-state'),
    /** Listen for state changes pushed from the main process */
    onStateChange: (callback) => {
      ipcRenderer.on('recording:state-update', (_event, state) => callback(state));
    },
    removeStateListeners: () => {
      ipcRenderer.removeAllListeners('recording:state-update');
    },
  },

  // Push notifications — show native OS notification from renderer
  showNotification: (title, body, link) => ipcRenderer.send('notification:show', title, body, link || null),
  // Notification click → main opens window and tells renderer where to navigate
  onNotificationNavigate: (callback) => {
    const handler = (_event, link) => callback(link);
    ipcRenderer.on('notification:navigate', handler);
    return () => ipcRenderer.removeListener('notification:navigate', handler);
  },
});

