import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.TURK_BACKEND_PORT || "3001";

  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_OLLAMA_MODEL": JSON.stringify(env.VITE_OLLAMA_MODEL || "gemini-3-flash-preview"),
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      proxy: {
        // WebSocket → 백엔드 (pi RPC 브로드캐스트)
        "/ws": {
          target: `ws://localhost:${backendPort}`,
          ws: true,
          changeOrigin: true,
        },
        // 헬스체크 API → 백엔드
        "/api": {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});