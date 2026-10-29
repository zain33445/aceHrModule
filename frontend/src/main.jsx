import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ChatHub from './components/chat/ChatHub.jsx'
import NotificationSoundBridge from './components/notifications/NotificationSoundBridge.jsx'
import { CallProvider } from './context/CallContext.jsx'

// Electron opens the chat-only window with #chat (the bubble is electron/bubble.html)
const view = window.location.hash.slice(1)

function renderRoot() {
  if (view === 'chat') {
    const auth = JSON.parse(localStorage.getItem('bio_auth') || 'null')
    if (!auth) return <p style={{ padding: 24 }}>Please log in to aceHRM first.</p>
    // The floating chat window is a companion surface: it deliberately does not
    // open a call socket, so a user cannot end up with two peers for the same
    // call. Incoming calls are announced by the native OS notification instead,
    // and accepting one focuses the main window.
    return (
      <CallProvider user={auth} enabled={false}>
        <NotificationSoundBridge userId={auth.user_id} />
        <ChatHub user={auth} fullHeight />
      </CallProvider>
    )
  }

  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {renderRoot()}
  </StrictMode>,
)
