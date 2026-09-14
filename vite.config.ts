import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
const config = JSON.parse(
  readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // Production browser preview exercises the same resource policy as the desktop app.
  preview: { headers: { "Content-Security-Policy": config.app.security.csp } },
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: { target: "es2021" },
});
