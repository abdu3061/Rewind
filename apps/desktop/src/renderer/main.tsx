import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initMockBridge } from "./mockBridge";
import "./App.css";

// Only fallback to mock bridge if native IPC bridge is not provided by Electron preload
const win = window as unknown as { api?: unknown; electron?: unknown };
if (!win.api && !win.electron) {
  initMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
