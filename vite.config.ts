import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_OLLAMA_MODEL": JSON.stringify(env.VITE_OLLAMA_MODEL || "gemini-3-flash-preview"),
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      proxy: {
        "/api": {
          target: env.VITE_OLLAMA_BASE_URL || "https://ollama.com",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, "/v1"),
          headers: {
            Authorization: `Bearer ${env.VITE_OLLAMA_API_KEY || ""}`,
          },
        },
      },
    },
  };
});