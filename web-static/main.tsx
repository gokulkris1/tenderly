import React from "react";
import { createRoot } from "react-dom/client";
import TenderlyApp from "../components/TenderlyApp";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <TenderlyApp />
  </React.StrictMode>,
);
