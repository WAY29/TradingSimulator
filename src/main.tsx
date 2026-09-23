import { createRoot } from 'react-dom/client'
import App from './App'
import '@klinecharts/pro/dist/klinecharts-pro.css'
import './style.css'

createRoot(document.querySelector('#app')!).render(<App />)
