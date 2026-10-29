import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initMockBridge } from "./mockBridge";
import "./App.css";

// Only initialize mock bridge strictly during Vite dev mode
if (import.meta.env.DEV) {
  initMockBridge();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
