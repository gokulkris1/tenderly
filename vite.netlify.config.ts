import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(process.cwd(), "web-static"),
  plugins: [react()],
  define: {
    "process.env.VITE_API_URL": JSON.stringify(process.env.VITE_API_URL ?? ""),
  },
  build: {
    outDir: path.resolve(process.cwd(), "dist-netlify"),
    emptyOutDir: true,
  },
});
