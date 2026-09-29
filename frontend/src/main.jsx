import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ChatHub from './components/chat/ChatHub.jsx'

// Electron opens the chat-only window with #chat (the bubble is electron/bubble.html)
const view = window.location.hash.slice(1)

function renderRoot() {
  if (view === 'chat') {
    const auth = JSON.parse(localStorage.getItem('bio_auth') || 'null')
    return auth
      ? <ChatHub user={auth} fullHeight />
      : <p style={{ padding: 24 }}>Please log in to aceHRM first.</p>
  }

  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {renderRoot()}
  </StrictMode>,
)
