import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// A stale tab (or cached index.html) can reference a hashed chunk/CSS
// filename from a previous deploy that no longer exists on the server.
// Vite's dynamic-import preload helper throws in that case — reload once
// to pick up the current build instead of leaving the user on a dead page.
window.addEventListener('vite:preloadError', () => {
  const key = 'vite-preload-reload'
  if (sessionStorage.getItem(key)) return
  sessionStorage.setItem(key, '1')
  window.location.reload()
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Only clear the guard once the app has actually rendered without hitting
// another preload error — clearing it unconditionally at parse time let a
// persistently failing chunk (e.g. a stale dev-server hash) wipe its own
// guard on every reload and loop forever.
window.setTimeout(() => sessionStorage.removeItem('vite-preload-reload'), 3000)
