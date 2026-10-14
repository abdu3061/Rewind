import React from 'react'
import { createRoot } from 'react-dom/client'
import Dashboard from './pages/Dashboard'
import './styles/theme.css'

const App = () => {
  return <Dashboard />
}

const container = document.getElementById('root')
if (container) createRoot(container).render(<App />)
