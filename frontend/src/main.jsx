import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
// fonts served from KubeEZ itself (hashed, cached for a year) — no render-blocking call to Google
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource/instrument-serif/latin-400.css'
import '@fontsource/instrument-serif/latin-400-italic.css'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
