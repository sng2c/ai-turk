import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { WebSocketServer, WebSocket } from "ws";

/**
 * AI Turk Vite 플러그인 — pi --mode rpc를 개발 서버에 통합
 * npm run dev 하나로 Vite + pi RPC + WebSocket 모두 실행
 */
function turkPlugin(env: Record<string, string>): Plugin {
	const model = env.TURK_RPC_MODEL || "";
	const bin = env.TURK_RPC_BIN || "pi";
	const extraArgs = (env.TURK_RPC_ARGS || "").split(/\s+/).filter(Boolean);

	let piProcess: ChildProcess | null = null;
	let piReady = false;
	const clients = new Set<WebSocket>();

	function broadcast(data: Record<string, unknown>): void {
		const msg = JSON.stringify(data);
		for (const ws of clients) {
			if (ws.readyState === WebSocket.OPEN) ws.send(msg);
		}
	}

	function startPi(): void {
		const args = ["--mode", "rpc", "--no-session", ...(model ? ["--model", model] : []), ...extraArgs];
		console.log(`[Turk] ${bin} ${args.join(" ")} 시작`);
		piProcess = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
		piReady = true;

		const decoder = new StringDecoder("utf8");
		let buffer = "";

		piProcess.stdout!.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			while (true) {
				const idx = buffer.indexOf("\n");
				if (idx === -1) break;
				let line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				try {
					broadcast(JSON.parse(line));
				} catch {
					console.error("[Turk] JSONL 파싱 오류:", line.slice(0, 120));
				}
			}
		});

		piProcess.stderr!.on("data", (chunk: Buffer) => {
			const msg = chunk.toString().trim();
			if (msg) console.error("[pi]", msg.slice(0, 500));
		});

		piProcess.on("exit", (code) => {
			console.log(`[Turk] pi 종료 (코드: ${code})`);
			piProcess = null;
			piReady = false;
			broadcast({ type: "pi_exit", code });
		});

		piProcess.on("error", (err) => {
			console.error("[Turk] pi 시작 실패:", err.message);
			piProcess = null;
			broadcast({ type: "pi_error", message: err.message });
		});

		broadcast({ type: "pi_ready" });
	}

	function sendPi(cmd: Record<string, unknown>): void {
		if (!piProcess?.stdin?.writable) return;
		piProcess.stdin.write(JSON.stringify(cmd) + "\n");
	}

	// restart_pi만 제외하고 모든 명령을 pi에 전달
	const customCommands = ["restart_pi"];

	return {
		name: "turk-rpc",
		configureServer(server) {
			startPi();

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
				ws.send(JSON.stringify({ type: piReady ? "pi_ready" : "pi_starting" }));

				ws.on("message", (raw) => {
					try {
						const msg = JSON.parse(raw.toString());
						if (customCommands.includes(msg.type)) {
							if (msg.type === "restart_pi") {
								if (piProcess) { piProcess.kill("SIGTERM"); piProcess = null; }
								setTimeout(() => startPi(), 500);
							}
						} else {
							sendPi(msg);
						}
					} catch (e) {
						console.error("[Turk] 메시지 파싱 오류:", e);
					}
				});

				ws.on("close", () => clients.delete(ws));
			});

			server.httpServer!.on("close", () => {
				if (piProcess) piProcess.kill("SIGTERM");
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