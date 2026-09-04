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

sessionStorage.removeItem('vite-preload-reload')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
