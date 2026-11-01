import React from 'react'
import ReactDOM from 'react-dom/client'
// uiStore applies <html data-theme/data-density> at module load, before the first render.
import './stores/uiStore'
import App from './App'
import './styles/globals.css'
import { installKeyNormalization } from './components/ui/shortcuts'

// WebKitGTK reports Shift+Tab as key "Unidentified": give such events their key first.
installKeyNormalization()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
