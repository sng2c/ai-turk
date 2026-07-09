import { createRoot } from "react-dom/client";
import "./tailwind.css";
import "./App.css";
import App, { ErrorBoundary } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);