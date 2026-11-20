import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Notch } from "./Notch";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The application root is missing.");
createRoot(root).render(
  <React.StrictMode>
    {window.location.hash === "#notch" ? <Notch /> : <App />}
  </React.StrictMode>,
);
