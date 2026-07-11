import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { WebSocketServer, WebSocket } from "ws";
import { createBackend, type Backend, type TurkEvent } from "./backend.ts";
import { Scheduler, formatTriggerMessage } from "./scheduler.ts";
import webpush from "web-push";
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

	// ── Web Push (VAPID 키 자동 발급, 메모리만) ────────────────────────────
	const vapidKeys = webpush.generateVAPIDKeys();
	const VAPID_PUBLIC_KEY: string = vapidKeys.publicKey;
	const VAPID_PRIVATE_KEY: string = vapidKeys.privateKey;
	webpush.setVapidDetails("mailto:ai-turk@local", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
	let lastPushSubscription: any = null; // 마지막 구독 (1인 인스턴스 — 1개만 유지)
	let wsConnected = false; // WS 연결 여부 (끊김 시 서버 푸시)

	function broadcast(data: Record<string, unknown>): void {
		const msg = JSON.stringify(data);
		for (const ws of clients) {
			if (ws.readyState === WebSocket.OPEN) ws.send(msg);
		}
	}

	// ── 웹 푸시 헬퍼 ────────────────────────────────────────────────────────
	function extractTextFromMessages(messages: any[]): string {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant" && Array.isArray(m.content)) {
				const texts = m.content
					.filter((b: any) => b.type === "text" && b.text)
					.map((b: any) => b.text);
				if (texts.length) return texts.join("\n");
			}
		}
		return "";
	}

	function stripMarkdownServer(text: string): string {
		return text
			.replace(/\*\*(.+?)\*\*/g, "$1")
			.replace(/`(.+?)`/g, "$1")
			.replace(/[*_`~>#]/g, "")
			.replace(/\n/g, " ")
			.trim();
	}

	function sendPushNotification(ev: TurkEvent): void {
		const messages = (ev as any).messages;
		if (!Array.isArray(messages)) return;
		const text = extractTextFromMessages(messages);
		if (!text) return;
		// JSON 그리드 응답이면 message 필드만 추출 (전체 JSON 노출 방지)
		const msgMatch = text.match(/"message"\s*:\s*"([^"]*)"/);
		const bodyText = msgMatch ? msgMatch[1] : text;
		const body = stripMarkdownServer(bodyText).slice(0, 50);
		if (!body) return;
		const payload = JSON.stringify({ body: body.length === 50 ? body + "..." : body });
		webpush.sendNotification(lastPushSubscription, payload)
			.then(() => console.log("[Push] 전송 성공"))
			.catch((err) => console.log("[Push] 전송 실패:", err.message));
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
			// agent_start: 스트리밍 시작
			if (ev.type === "agent_start") isStreaming = true;
			// agent_end: 스트리밍 종료 + 큐 드레인 + lastPrompt 초기화 + 웹 푸시
			if (ev.type === "agent_end") {
				isStreaming = false;
				lastPrompt = null;
				scheduler.drainQueue();
				// WS 끊김 시 웹 푸시 전송 (백그라운드 알림)
				if (!wsConnected && lastPushSubscription) sendPushNotification(ev);
			}
			// get_state 응답 보강: lastPrompt + isStreaming 주입
			if (ev.type === "response" && ev.command === "get_state") {
				(ev as any).data = { ...(ev as any).data, lastPrompt, isStreaming };
			}
			broadcast(ev);
		});
		backend.start();
	}

	// restart_pi, schedule 제외하고 모든 명령을 백엔드에 전달
	const customCommands = ["restart_pi", "schedule", "push_subscribe"];
	let lastPrompt: string | null = null; // 마지막 백엔드 전송 프롬프트 (새로고침 복원용)
	let isStreaming = false; // 백엔드 응답 생성 중 여부

	// backend.send를 가로채서 lastPrompt 저장. Backend 인터페이스 불변.
	// opts.fromScheduler=true 시 lastPrompt 저장 생략 — 서버 자체 프롬프트는 채팅창에 복원되지 않음.
	function sendToBackend(cmd: Record<string, unknown>, opts?: { fromScheduler?: boolean }): void {
		if (cmd.type === "prompt" && typeof cmd.message === "string" && !opts?.fromScheduler) {
			lastPrompt = cmd.message;
		}
		backend?.send(cmd);
	}

	// ── 스케줄러 인스턴스 ──────────────────────────────────────────────────
	const scheduler = new Scheduler({
		onTrigger: (entry) => {
			const msg = formatTriggerMessage(entry, new Date());
			sendToBackend({ type: "prompt", message: msg }, { fromScheduler: true });
			broadcast({ type: "scheduler_trigger", id: entry.id, mode: entry.mode, at: entry.at });
		},
		isBusy: () => isStreaming,
	});

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
				wsConnected = true;
				ws.send(JSON.stringify({ type: backendReady ? "pi_ready" : "pi_starting", ...(backendReady ? { backend: backend?.kind(), vapidPublicKey: VAPID_PUBLIC_KEY } : {}) }));

				ws.on("message", (raw) => {
					try {
						const msg = JSON.parse(raw.toString());
						if (customCommands.includes(msg.type)) {
							if (msg.type === "restart_pi") {
								if (backend) { backend.stop(); backend = null; }
								setTimeout(() => startBackend(), 500);
							} else if (msg.type === "schedule") {
								// schedule 명령: scheduler.handle() → 결과를 response 이벤트로 반환
								const result = scheduler.handle(msg);
								broadcast({
									type: "response",
									command: "schedule",
									success: result.success,
									...(result.success ? { data: result.data } : { error: result.error }),
								});
							} else if (msg.type === "push_subscribe") {
								// push 구독 저장 (1인 인스턴스 — 마지막 1개만 유지)
								lastPushSubscription = msg.subscription;
								console.log("[Push] 구독 수신:", msg.subscription?.endpoint?.slice(0, 60));
							}
						} else {
							sendToBackend(msg);
						}
					} catch (e) {
						console.error("[Turk] 메시지 파싱 오류:", e);
					}
				});

				ws.on("close", () => { console.log("[Push] WS close — wsConnected: false"); clients.delete(ws); wsConnected = false; });
			});

			server.httpServer!.on("close", () => {
				scheduler.destroy();
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
			host: process.env.TURK_HOST || "127.0.0.1",
			port: Number(process.env.TURK_PORT) || 3000,
			allowedHosts: true as const,
		},
	};
});