import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { initMockBridge } from './mockBridge';
import './App.css';

// Initialize in-memory mock bridge for isolated renderer development
initMockBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
