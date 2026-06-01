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
});

