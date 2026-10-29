import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initMockBridge } from "./mockBridge";
import "./App.css";

// Only initialize mock bridge during local Vite development (never during Playwright E2E tests or packaged builds)
if (import.meta.env.DEV && !(window as any).navigator?.webdriver) {
  initMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
