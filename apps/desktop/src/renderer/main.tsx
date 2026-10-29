import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initMockBridge } from "./mockBridge";
import "./App.css";

// Check if Electron's preload script already exposed an IPC bridge
const hasNativeBridge = "electron" in window || "api" in window;

// Only initialize mock bridge in dev mode if no native bridge is present
if (import.meta.env.DEV && !hasNativeBridge) {
  initMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
