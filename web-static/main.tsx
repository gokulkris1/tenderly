import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import TenderlyApp from "../components/TenderlyApp";

// Every screen is addressable, so a bid can be linked, reloaded and navigated
// back to. netlify.toml already rewrites unknown paths to index.html.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <TenderlyApp />
    </BrowserRouter>
  </React.StrictMode>,
);
