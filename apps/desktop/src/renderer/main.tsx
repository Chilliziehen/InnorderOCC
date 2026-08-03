import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Renderer root is missing");
}

createRoot(root).render(
  <StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </StrictMode>,
);
