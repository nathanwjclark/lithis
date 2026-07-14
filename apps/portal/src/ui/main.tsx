import { createRoot } from "react-dom/client";
import { App } from "./App";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("portal: #root element missing from index.html");
}
createRoot(rootEl).render(<App />);
