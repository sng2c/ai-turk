import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @tailwindcss/vite 제거 — @tailwindcss/postcss 전환 (CSS HMR full-reload 방지, tailwindlabs/tailwindcss#19903)
import { WebSocketServer, WebSocket } from "ws";
import { createBackend, type Backend, type TurkEvent } from "./backend.ts";

// 진단 로그 토글: TURK_DEBUG=1
const DEBUG = !!process.env.TURK_DEBUG;
import { Scheduler, formatTriggerMessage } from "./scheduler.ts";
import envPaths from "env-paths";
import webpush from "web-push";
import removeMarkdown from "remove-markdown";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * AI Turk Vite 플러그인 — 멀티 세션 (유저 키 기반)
 * 각 유저(브라우저 localStorage userKey)마다 독립 세션(백엔드 + 스케줄러) 할당.
 * 같은 유저 다중 탭 = 동일 세션 broadcast. 사생활 탭 = 다른 userKey = 다른 세션.
 * npm run dev 하나로 Vite + 백엔드 + WebSocket 모두 실행
 */
function turkPlugin(env: Record<string, string>): Plugin {
	// ── Web Push (VAPID 키 자동 발급, 메모리만) — 서버 전역 1개 (모든 세션 공유) ──
	const vapidKeys = webpush.generateVAPIDKeys();
	const VAPID_PUBLIC_KEY: string = vapidKeys.publicKey;
	const VAPID_PRIVATE_KEY: string = vapidKeys.privateKey;
	webpush.setVapidDetails("mailto:ai-turk@local", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

	const MAX_SESSIONS = parseInt(env.TURK_MAX_SESSIONS || "5");
	const AGENT_CWD = env.TURK_AGENT_CWD || join(__dirname, "workspace");

	// ── 세션 구조 — 유저(브라우저)별 독립 백엔드 + 스케줄러 ───────────────────
	interface Session {
		userKey: string;
		agentSessionId: string | null; // 백엔드 세션 ID (config.json 영속, ready 시 get_state로 갱신). null = 새 세션
		backend: Backend | null;
		backendReady: boolean;
		scheduler: Scheduler;
		pushSubscription: any;
		ws: Set<WebSocket>;
		lastPrompt: string | null;
		isStreaming: boolean;
		lastActivity: number;
	}

	const sessions = new Map<string, Session>();

	// 같은 세션(유저) WS 전체에 broadcast — 다중 탭 동기화
	function broadcast(session: Session, data: Record<string, unknown>): void {
		if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [WS] 송신: type=${data.type}${data.command ? " command=" + data.command : ""}`);
		const msg = JSON.stringify(data);
		for (const ws of session.ws) {
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
		return removeMarkdown(text)
			.replace(/\n/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}

	function sendPushNotification(session: Session, ev: TurkEvent): void {
		const messages = (ev as any).messages;
		if (!Array.isArray(messages)) return;
		const text = extractTextFromMessages(messages);
		if (!text) return;
		console.log(`[${session.userKey.slice(0, 8)}] [Push] text=${text.slice(0, 120)}`);
		let bodyText = text;
		try {
			const parsed = JSON.parse(text);
			if (parsed && parsed.noResponse) return; // no-response 응답 — push 폐기
			if (parsed && typeof parsed.message === "string") bodyText = parsed.message;
		} catch { /* JSON 아니면 text 그대로 */ }
		const body = stripMarkdownServer(bodyText).slice(0, 50);
		if (!body) return;
		const payload = JSON.stringify({ body: body.length === 50 ? body + "..." : body });
		webpush.sendNotification(session.pushSubscription, payload)
			.then(() => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 성공`))
			.catch((err) => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 실패: ${err.message}`));
	}

	// backend.send 가로채서 lastPrompt 저장. fromScheduler 시 생략
	function sendToBackend(session: Session, cmd: Record<string, unknown>, opts?: { fromScheduler?: boolean }): void {
		if (cmd.type === "prompt" && typeof cmd.message === "string" && !opts?.fromScheduler) {
			session.lastPrompt = typeof cmd.userInput === "string" ? cmd.userInput : cmd.message;
		}
		if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [백엔드] 전송: type=${cmd.type}${opts?.fromScheduler ? " (scheduler)" : ""}` + (cmd.type === "prompt" && typeof cmd.message === "string" ? ` msg=${cmd.message.slice(0, 200)}` : ""));
		session.backend?.send(cmd);
	}

	// ── 백엔드 시작 (세션별) ────────────────────────────────────────────────
	function startBackend(session: Session): void {
		try { mkdirSync(AGENT_CWD, { recursive: true }); } catch { /* 무시 */ }
		session.backend = createBackend({
			cwd: AGENT_CWD,
			userKey: session.agentSessionId ?? undefined, // 저장된 agentSessionId 있으면 지정(같은 세션 복원), 없으면 undefined(새 세션). claude는 무시
			onLog: (m: string) => console.log(`[${session.userKey.slice(0, 8)}] ${m}`),
		});
		session.backend.onEvent((ev: TurkEvent) => {
			if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [백엔드] 이벤트: type=${ev.type}`);
			if (ev.type === "pi_ready") {
				session.backendReady = true;
				(ev as any).vapidPublicKey = VAPID_PUBLIC_KEY;
			}
			// get_state 응답에서 실제 agentSessionId 확인 → config 영속 (ready 후 갱신)
			if (ev.type === "response" && (ev as any).command === "get_state") {
				const sid = (ev as any).data?.sessionId;
				if (typeof sid === "string" && sid && sid !== session.agentSessionId) {
					session.agentSessionId = sid;
					saveAgentSessionId(session.userKey, sid);
					console.log(`[${session.userKey.slice(0, 8)}] [config] agentSessionId 갱신: ${sid.slice(0, 8)}`);
				}
			}
			if (ev.type === "pi_exit" || ev.type === "pi_error") session.backendReady = false;
			if (ev.type === "agent_start") session.isStreaming = true;
			if (ev.type === "agent_end") {
				session.isStreaming = false;
				session.lastPrompt = null;
				// LLM 응답 전체 로깅 (디버그) — push 파싱 원인 확정용
				if (DEBUG) {
					const msgs = (ev as any).messages;
					if (Array.isArray(msgs)) console.log(`[${session.userKey.slice(0, 8)}] [agent_end] messages=${JSON.stringify(msgs).slice(0, 1000)}`);
				}
				session.scheduler.drainQueue();
				if (session.pushSubscription) sendPushNotification(session, ev);
			}
			if (ev.type === "response" && ev.command === "get_state") {
				(ev as any).data = { ...(ev as any).data, lastPrompt: session.lastPrompt, isStreaming: session.isStreaming };
			}
			broadcast(session, ev);
		});
		session.backend.start();
	}

	// ── agentSessionId 영속화 (config.json) ────────────────────────────────────
	function configPath(userKey: string): string {
		return `${envPaths("ai-turk").data}/${userKey}/agent-session-id`;
	}
	function loadAgentSessionId(userKey: string): string | null {
		try {
			const f = configPath(userKey);
			if (!existsSync(f)) return null;
			const id = readFileSync(f, "utf-8").trim();
			return id || null;
		} catch { return null; }
	}
	function saveAgentSessionId(userKey: string, agentSessionId: string): void {
		try {
			const dir = `${envPaths("ai-turk").data}/${userKey}`;
			mkdirSync(dir, { recursive: true });
			writeFileSync(configPath(userKey), agentSessionId); // 평문 UUID
		} catch (err) { console.log(`[${userKey.slice(0, 8)}] [config] 저장 실패: ${err instanceof Error ? err.message : err}`); }
	}
	function pushPath(userKey: string): string {
		return `${envPaths("ai-turk").data}/${userKey}/push.json`;
	}
	function loadPushSubscription(userKey: string): any | null {
		try {
			const f = pushPath(userKey);
			if (!existsSync(f)) return null;
			return JSON.parse(readFileSync(f, "utf-8"));
		} catch { return null; }
	}
	function savePushSubscription(userKey: string, sub: any): void {
		try {
			const dir = `${envPaths("ai-turk").data}/${userKey}`;
			mkdirSync(dir, { recursive: true });
			writeFileSync(pushPath(userKey), JSON.stringify(sub));
		} catch (err) { console.log(`[${userKey.slice(0, 8)}] [push] 저장 실패: ${err instanceof Error ? err.message : err}`); }
	}

	// ── 세션 관리 ────────────────────────────────────────────────────────────
	function createSession(userKey: string): Session {
		const session: Session = {
			userKey,
			agentSessionId: loadAgentSessionId(userKey), // 저장된 ID 있으면 복원, 없으면 null(새 세션)
			backend: null,
			backendReady: false,
			scheduler: new Scheduler({
				onTrigger: (entries) => {
					const msg = formatTriggerMessage(entries, new Date());
					sendToBackend(session, { type: "prompt", message: msg }, { fromScheduler: true });
					broadcast(session, { type: "scheduler_trigger", ids: entries.map((e) => e.id), whens: entries.map((e) => e.when) });
				},
				isBusy: () => session.isStreaming,
				storageDir: `${envPaths("ai-turk").data}/${userKey}`,
			}),
			pushSubscription: loadPushSubscription(userKey), // 영속화된 구독 복원
			ws: new Set(),
			lastPrompt: null,
			isStreaming: false,
			lastActivity: Date.now(),
		};
		sessions.set(userKey, session);
		startBackend(session);
		return session;
	}

	function removeSession(userKey: string): void {
		const session = sessions.get(userKey);
		if (!session) return;
		broadcast(session, { type: "session_terminated", reason: "유휴 세션 정리" });
		for (const ws of session.ws) ws.close();
		session.scheduler.destroy();
		session.backend?.stop();
		sessions.delete(userKey);
	}

	// 최대 도달 시 WS 없는 유휴 세션 LRU 강제 종료 → 수용
	function getOrCreateSession(userKey: string): Session | { error: string } {
		const existing = sessions.get(userKey);
		if (existing) {
			existing.lastActivity = Date.now();
			return existing;
		}
		if (sessions.size >= MAX_SESSIONS) {
			let oldest: Session | null = null;
			for (const s of sessions.values()) {
				if (s.ws.size === 0 && (!oldest || s.lastActivity < oldest.lastActivity)) oldest = s;
			}
			if (oldest) {
				console.log(`[Turk] LRU 정리: ${oldest.userKey.slice(0, 8)}`);
				removeSession(oldest.userKey);
			} else {
				return { error: `최대 세션 수(${MAX_SESSIONS}) 초과 — 모든 세션 활성 중` };
			}
		}
		return createSession(userKey);
	}

	const customCommands = ["restart_pi", "schedule", "push_subscribe"];

	return {
		name: "turk-rpc",
		configureServer(server) {
			// noServer 모드: Vite HMR 역그레이드 핸들러와 충돌 방지
			const wss = new WebSocketServer({ noServer: true });
			server.httpServer!.on("upgrade", (req, socket, head) => {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname === "/ws") {
					wss.handleUpgrade(req, socket as any, head, (ws) => {
						wss.emit("connection", ws, req);
					});
				}
			});

			wss.on("connection", (ws, req) => {
				const url = new URL(req.url || "", "http://localhost");
				const userKey = url.searchParams.get("u");
				if (!userKey) {
					ws.send(JSON.stringify({ type: "session_error", error: "userKey 누락" }));
					ws.close();
					return;
				}
				const result = getOrCreateSession(userKey);
				if ("error" in result) {
					ws.send(JSON.stringify({ type: "session_error", error: result.error }));
					ws.close();
					return;
				}
				const session = result;
				session.ws.add(ws);
				session.lastActivity = Date.now();
				console.log(`[Turk] 연결: ${userKey.slice(0, 8)} (세션 ${sessions.size}/${MAX_SESSIONS})`);

				ws.send(JSON.stringify({
					type: session.backendReady ? "pi_ready" : "pi_starting",
					...(session.backendReady ? { backend: session.backend?.kind(), vapidPublicKey: VAPID_PUBLIC_KEY } : {}),
				}));

				ws.on("message", (raw) => {
					try {
						const msg = JSON.parse(raw.toString());
						if (DEBUG) console.log(`[${userKey.slice(0, 8)}] [WS] 수신: type=${msg.type}`);
						if (customCommands.includes(msg.type)) {
							if (msg.type === "restart_pi") {
								if (session.backend) { session.backend.stop(); session.backend = null; }
								session.backendReady = false;
								session.agentSessionId = null; // 새 세션 — 클리어 → 백엔드 새 세션 → ready 후 get_state로 새 ID 갱신
								console.log(`[${userKey.slice(0, 8)}] [restart_pi] 새 세션 시작 (agentSessionId 클리어)`);
								setTimeout(() => startBackend(session), 500);
							} else if (msg.type === "schedule") {
								const r = session.scheduler.handle(msg);
								broadcast(session, {
									type: "response",
									command: "schedule",
									success: r.success,
									...(r.success ? { data: r.data } : { error: r.error }),
								});
							} else if (msg.type === "push_subscribe") {
								session.pushSubscription = msg.subscription;
								savePushSubscription(userKey, msg.subscription); // 영속화
								if (DEBUG) console.log(`[${userKey.slice(0, 8)}] [Push] 구독 수신: ${msg.subscription?.endpoint?.slice(0, 60)}`);
							}
						} else {
							sendToBackend(session, msg);
						}
					} catch (e) {
						console.error("[Turk] 메시지 파싱 오류:", e);
					}
				});

				ws.on("close", () => {
					session.ws.delete(ws);
					session.lastActivity = Date.now();
					console.log(`[Turk] 종료: ${userKey.slice(0, 8)} (남은 WS ${session.ws.size})`);
				});
			});

			server.httpServer!.on("close", () => {
				for (const userKey of sessions.keys()) removeSession(userKey);
			});
		},
	};
}

export default defineConfig(() => {
	return {
		plugins: [react(), turkPlugin(process.env as Record<string, string>)],
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