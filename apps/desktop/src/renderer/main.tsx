import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initMockBridge } from "./mockBridge";
import "./App.css";

// Only initialize mock bridge if Electron preload hasn't attached a native bridge
const hasPreloadBridge = "electron" in window || "api" in window;

if (import.meta.env.DEV && !hasPreloadBridge) {
  initMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
