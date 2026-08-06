import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { useThemeStore } from "./store";
import "./styles/tokens.css";

useThemeStore.getState().setTheme("dark");

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);