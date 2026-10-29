const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Existing: send authenticated userId to main process
  setUserId: (userId) => ipcRenderer.send('set-user-id', String(userId)),

  // Recording API — exposes read-only state to React UI (transparency layer)
  recording: {
    /** Returns current recording state: 'idle' | 'recording' | 'starting' | 'stopping' | 'error' | 'permission_denied' */
    getState: () => ipcRenderer.invoke('recording:get-state'),
    /** Listen for state changes pushed from the main process */
    onStateChange: (callback) => {
      ipcRenderer.on('recording:state-update', (_event, state) => callback(state));
    },
    removeStateListeners: () => {
      ipcRenderer.removeAllListeners('recording:state-update');
    },
  },

  // Floating chat bubble (shown while main window is minimized)
  openChatBubble: () => ipcRenderer.send('chat-bubble:click'),
  moveChatBubble: (dx, dy) => ipcRenderer.send('chat-bubble:move', dx, dy),

  // Push notifications — show native OS notification from renderer
  showNotification: (title, body, link) => ipcRenderer.send('notification:show', title, body, link || null),
  // Notification click → main opens window and tells renderer where to navigate
  onNotificationNavigate: (callback) => {
    const handler = (_event, link) => callback(link);
    ipcRenderer.on('notification:navigate', handler);
    return () => ipcRenderer.removeListener('notification:navigate', handler);
  },

  // Notification sounds. The main process raises notifications for the
  // notification WS and the attendance monitor; it asks the renderer to play
  // the chime so every notification sounds the same.
  notifications: {
    onSound: (callback) => {
      const handler = () => callback();
      ipcRenderer.on('notification:sound', handler);
      return () => ipcRenderer.removeListener('notification:sound', handler);
    },
  },

  // Voice & video calls.
  // The renderer owns the call state; the main process only raises the native
  // OS notification (with Accept / Decline actions) and relays the choice back.
  call: {
    /** Report an incoming call so the main process can ring natively. */
    notifyIncoming: (payload) => ipcRenderer.send('call:incoming', payload),
    /** Report that a call finished, so the main process can clear the notification. */
    notifyEnded: (payload) => ipcRenderer.send('call:ended', payload),
    /** Listen for the user's Accept / Decline choice from the native notification. */
    onAction: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('call:action', handler);
      return () => ipcRenderer.removeListener('call:action', handler);
    },
    /**
     * Test hook: asks the main process to deliver a call action to the
     * renderer. The main process only honours this when its own test hooks
     * are enabled, so this is inert in normal builds.
     */
    simulateAction: (payload) => ipcRenderer.send('call:simulate-action', payload),

    /**
     * Ask the main window to place a call on this window's behalf. The floating
     * chat window does not own a call socket, so the main process focuses the
     * main window and hands the request to its CallProvider.
     * Payload: { userIds: string[], conversationId?: string }
     */
    start: (payload) => ipcRenderer.send('call:start', payload),

    /** Receive a start request delegated by the floating chat window. */
    onStart: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('call:start', handler);
      return () => ipcRenderer.removeListener('call:start', handler);
    },
    /** Tell the main process a delegated start request has been handled. */
    consumed: () => ipcRenderer.send('call:start-consumed'),
    /** Claim a delegated start request that arrived before the listener existed. */
    consumePending: () => ipcRenderer.invoke('call:consume-pending-start'),
  },
});


