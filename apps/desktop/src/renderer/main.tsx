import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initMockBridge } from "./mockBridge";
import "./App.css";

// Only initialize mock bridge in pure local browser dev, never during tests or packaged app runs
const win = window as unknown as { api?: unknown; electron?: unknown };
const isTestOrPackaged =
  window.location.protocol === "file:" || win.api || win.electron;

if (!isTestOrPackaged) {
  initMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
