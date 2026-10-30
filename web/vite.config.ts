import { defineConfig } from "vite";

// `npm run dev` serves on :5173 and forwards the API and pet WebSocket to the neko server on :8081.
// `npm run build` writes dist/, which the neko server serves at "/".
export default defineConfig({
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8081",
      "/ws": { target: "ws://127.0.0.1:8081", ws: true },
    },
    fs: { allow: [".."] },
  },
});
