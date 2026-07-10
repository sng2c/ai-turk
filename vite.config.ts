import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { WebSocketServer, WebSocket } from "ws";
import { createBackend, type Backend, type TurkEvent } from "./backend.ts";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * AI Turk Vite 플러그인 — 백엔드(pi | claude)를 개발 서버에 통합
 * npm run dev 하나로 Vite + 백엔드 + WebSocket 모두 실행
 */
function turkPlugin(env: Record<string, string>): Plugin {
	let backend: Backend | null = null;
	let backendReady = false;
	const clients = new Set<WebSocket>();

	function broadcast(data: Record<string, unknown>): void {
		const msg = JSON.stringify(data);
		for (const ws of clients) {
			if (ws.readyState === WebSocket.OPEN) ws.send(msg);
		}
	}

	function startBackend(): void {
		const cwd = env.TURK_AGENT_CWD || join(__dirname, "workspace");
		try { mkdirSync(cwd, { recursive: true }); } catch { /* 무시 */ }
		backend = createBackend({
			cwd,
			onLog: (m: string) => console.log(m),
		});
		backend.onEvent((ev: TurkEvent) => {
			if (ev.type === "pi_ready") backendReady = true;
			if (ev.type === "pi_exit" || ev.type === "pi_error") backendReady = false;
			broadcast(ev);
		});
		backend.start();
	}

	// restart_pi만 제외하고 모든 명령을 백엔드에 전달
	const customCommands = ["restart_pi"];

	return {
		name: "turk-rpc",
		configureServer(server) {
			startBackend();

			// noServer 모드: Vite HMR 업그레이드 핸들러와 충돌 방지
			const wss = new WebSocketServer({ noServer: true });
			server.httpServer!.on("upgrade", (req, socket, head) => {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname === "/ws") {
					wss.handleUpgrade(req, socket as any, head, (ws) => {
						wss.emit("connection", ws, req);
					});
				}
			});
			wss.on("connection", (ws) => {
				console.log("[Turk] 클라이언트 연결");
				clients.add(ws);
				ws.send(JSON.stringify({ type: backendReady ? "pi_ready" : "pi_starting", ...(backendReady ? { backend: backend?.kind() } : {}) }));

				ws.on("message", (raw) => {
					try {
						const msg = JSON.parse(raw.toString());
						if (customCommands.includes(msg.type)) {
							if (msg.type === "restart_pi") {
								if (backend) { backend.stop(); backend = null; }
								setTimeout(() => startBackend(), 500);
							}
						} else {
							backend?.send(msg);
						}
					} catch (e) {
						console.error("[Turk] 메시지 파싱 오류:", e);
					}
				});

				ws.on("close", () => clients.delete(ws));
			});

			server.httpServer!.on("close", () => {
				if (backend) backend.stop();
			});
		},
	};
}

export default defineConfig(() => {
	return {
		plugins: [react(), tailwindcss(), turkPlugin(process.env as Record<string, string>)],
		resolve: {
			alias: {
				"@": "/root/ai-turk/src",
			},
		},
		server: {
			host: "127.0.0.1",
			port: Number(process.env.PORT) || 3000,
			allowedHosts: true as const,
		},
	};
});