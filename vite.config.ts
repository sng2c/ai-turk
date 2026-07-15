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
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";


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
		lastAssistantText: string | null; // 마지막 assistant 응답 (WS 끊김 시 재연결 복원용)
		isStreaming: boolean;
		lastActivity: number;
		currentRoute: "user" | "scheduler" | "tool"; // 현재 프롬프트 경로 — agent_start에 주입
	}

	// AGENTS.md 기본 템플릿 — 코딩 에이전트가 CWD에서 자동으로 읽음
	const AGENTS_MD_TEMPLATE = (rows = 5, cols = 5) => {
		const nb = rows * cols;
		const ex = Array.from({ length: nb }, (_, i) => `"${i}": ""`).join(", ");
		return `# AI-Turk UI Controller

You are a UI controller. Your ENTIRE response must be a single JSON object — no prose, no markdown, no code fences, no explanation before or after.

## Communication Targets
- silent: true -> The response is delivered but NOT shown to the user (no screen update, no cache, no push). Use for repeating schedules where the condition is false (skip silently, try again next cycle). Schedules in the response are still processed.
- silent: false (or omitted) -> Normal: cache + show to user. Use for one-time schedules where condition is false (user needs to know) or condition check failure (user needs to fix).

[Grid]
- ${rows} rows × ${cols} columns, ${nb} buttons. Keys "0"~"${nb - 1}".
- Empty button: "". Group related functions in the same row.
- Label: keep within 8 display-width units (Korean/fullwidth=2, ASCII=1). Emoji allowed.
  Longer labels are accepted but auto-shrink (min 0.8em), so prefer concise ones.
- Place primary buttons in the center.

[Message]
- Markdown supported: headings, lists, tables, code, links, bold/italic. Use it to structure content.
- Display area fits ~10 plain lines; longer content scrolls — use scroll when detail helps, but prefer concise.
- Tables and lists need a blank line before them (GFM rule).
- Max 42 chars per line (Korean=2, English/digit=1).

[Colors]
- colors: button background — success(녹)/warning(주)/destructive(빨)/primary(진한 강조)/accent(강조)/secondary(기본)/muted(회)
- textColors: text color — white/black. OMIT to auto-contrast by background.
- Auto contrast: dark bg (secondary/muted/accent/destructive)→white; light bg (primary/success/warning)→black.
- Hidden text: set textColors same as colors (label invisible, still clickable).

[Examples]
{"message":"What do you need?","buttons":{"0":"Weather","1":"Time","2":"News","3":"Help","4":""}}
{"message":"Settings saved.","buttons":{"0":"OK","1":"Cancel","2":""},"colors":{"0":"success","1":"destructive"}}
{"silent":true,"message":"","buttons":{},"schedules":[{"action":"add","id":"test","when":"1m","prompt":"Hello"}]}

[Schedules]
- Include a "schedules" array in your response to set/remove schedules.
- Schedules are once by default (executed once, then auto-removed). To repeat, re-register with the same id in the execution response's schedules array (chaining).
- Element forms:
  {"action":"add","id":"manse","when":"1m","prompt":"Shout hurrah 🥳 grid"}
  {"action":"remove","id":"manse"}
  {"action":"clear"}
  {"action":"list"}
- when formats (LLM chooses):
  - relative (from registration time): "1m"(in 1 min), "30m", "2h", "1d"
  - absolute (next occurrence, 24h): "21:00"(HH:MM), "2026-07-12T21:00"(ISO, local if no offset)
  - cron NOT supported — use relative/absolute + re-register for recurring (chaining enforced)
- Same id add → overwrite (update)
- Max 5 schedules, minimum interval 1 minute
- Example: {"message":"I'll shout hurrah in 1 minute! 🥳","buttons":{"0":"cancel","1":"","2":""},"schedules":[{"action":"add","id":"manse","when":"1m","prompt":"Shout hurrah 🥳 grid"}]}
- Conditional schedule: optional "condition" field to gate execution. Separate condition (when to run) from prompt (what to do).
  - condition: the predicate to evaluate (true/false). e.g. "if it's raining"
  - prompt: the instruction to run when the condition holds. e.g. "Remind to bring an umbrella grid"
  - example: {"message":"Check if it's raining...","buttons":{},"schedules":[{"action":"add","id":"rain","when":"09:00","condition":"if it's raining","prompt":"Remind to bring an umbrella grid"}]}
- On conditional trigger: evaluate the condition first — verify obvious facts (objective) via web_search etc. No guessing.
  - clearly true: respond normally per the prompt instruction.
  - clearly false + REPEATING schedule: return {"silent":true,"message":"","buttons":{}} — skip silently, try again next cycle.
  - clearly false + ONE-TIME schedule: return {"silent":false,"message":"Condition not met: <reason>","buttons":{}} — user needs to know (no retry).
  - check FAILED (tool error, cannot verify): return {"message":"Cannot verify condition: <reason>. Please fix the schedule.","buttons":{}} — user needs to fix.
  - uncertain: respond normally telling the user the situation (prompt for clarification).

[CRITICAL FORMAT]
Respond with ONLY this JSON (fill values, do not include comments). First character must be "{" and last must be "}":
{"message":"text","buttons":{${ex}},"colors":{},"textColors":{}}`;
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
			if (parsed && parsed.silent === true) return; // silent 응답 — push 폐기
			if (parsed && typeof parsed.message === "string") bodyText = parsed.message;
		} catch { /* JSON 아니면 text 그대로 */ }
		const body = stripMarkdownServer(bodyText).slice(0, 50);
		if (!body) return;
		const payload = JSON.stringify({ body: body.length === 50 ? body + "..." : body });
		webpush.sendNotification(session.pushSubscription, payload)
			.then(() => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 성공`))
			.catch((err) => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 실패: ${err.message}`));
	}

	// backend.send 가로채서 lastPrompt 저장 + route 추적
	function sendToBackend(session: Session, cmd: Record<string, unknown>, opts?: { route?: "user" | "scheduler" | "tool" }): void {
		const route = (opts?.route ?? cmd.route ?? "user") as "user" | "scheduler" | "tool";
		session.currentRoute = route;
		if (cmd.type === "prompt" && typeof cmd.message === "string" && route !== "scheduler") {
			session.lastPrompt = typeof cmd.userInput === "string" ? cmd.userInput : cmd.message;
		}
		if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [백엔드] 전송: type=${cmd.type}${route !== "user" ? ` (${route})` : ""}` + (cmd.type === "prompt" && typeof cmd.message === "string" ? ` msg=${cmd.message.slice(0, 200)}` : ""));
		// prompt 전송 전에 합성 agent_start broadcast — 즉시 로고 전환 + dim
		if (cmd.type === "prompt") {
			session.isStreaming = true;
			broadcast(session, { type: "agent_start", route });
		}
		session.backend?.send(cmd);
	}

	// ── 백엔드 시작 (세션별) ────────────────────────────────────────────────
	function startBackend(session: Session): void {
		try { 
			const agentCwd = join(envPaths("ai-turk").data, session.userKey, "workspace");
			mkdirSync(agentCwd, { recursive: true }); 
			const agentsMdPath = join(agentCwd, "AGENTS.md");
			if (!existsSync(agentsMdPath)) {
				writeFileSync(agentsMdPath, AGENTS_MD_TEMPLATE(), "utf8");
				console.log(`[Turk] AGENTS.md 생성됨: ${agentsMdPath}`);
			}
		} catch (e) { console.error(`[Turk] AGENTS.md 생성 실패: ${e}`); }
		session.backend = createBackend({
			cwd: join(envPaths("ai-turk").data, session.userKey, "workspace"),
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
			if (ev.type === "agent_start") { session.isStreaming = true; return; } // pi 것 스킵 — 서버가 이미 합성 전송
			if (ev.type === "agent_end") {
				session.isStreaming = false;
				session.lastPrompt = null;
				// LLM 응답 전체 로깅 (디버그) — push 파싱 원인 확정용
				if (DEBUG) {
					const msgs = (ev as any).messages;
					if (Array.isArray(msgs)) console.log(`[${session.userKey.slice(0, 8)}] [agent_end] messages=${JSON.stringify(msgs).slice(0, 1000)}`);
				}
				session.scheduler.drainQueue();
				const messages = (ev as any).messages;
				if (Array.isArray(messages)) {
					const _text = extractTextFromMessages(messages);
					// silent 응답은 캐시하지 않음 — 재연결 시 복원 제외
					try { const _p = JSON.parse(_text.match(/\{[\s\S]*\}/)?.[0] ?? _text); if (!(_p && _p.silent === true)) { session.lastAssistantText = _text; saveLastAssistantText(session.userKey, session.agentSessionId ?? "", _text); } } catch { session.lastAssistantText = _text; saveLastAssistantText(session.userKey, session.agentSessionId ?? "", _text); }
				}
				if (session.pushSubscription) sendPushNotification(session, ev);
			}
			if (ev.type === "response" && ev.command === "get_state") {
				(ev as any).data = { ...(ev as any).data, lastPrompt: session.lastPrompt, isStreaming: session.isStreaming, route: session.currentRoute };
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
	function lastAssistantTextPath(userKey: string): string {
	return `${envPaths("ai-turk").data}/${userKey}/last-assistant-text`;
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
	function loadLastAssistantText(userKey: string): { sessionId: string; text: string } | null {
	try {
		const f = lastAssistantTextPath(userKey);
		if (!existsSync(f)) return null;
		return JSON.parse(readFileSync(f, "utf-8"));
	} catch { return null; }
}
function saveLastAssistantText(userKey: string, sessionId: string, text: string): void {
	try {
		const dir = `${envPaths("ai-turk").data}/${userKey}`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(lastAssistantTextPath(userKey), JSON.stringify({ sessionId, text }));
	} catch (err) { console.log(`[${userKey.slice(0, 8)}] [lastText] 저장 실패: ${err instanceof Error ? err.message : err}`); }
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
					sendToBackend(session, { type: "prompt", message: msg }, { route: "scheduler" });
					broadcast(session, { type: "scheduler_trigger", ids: entries.map((e) => e.id), whens: entries.map((e) => e.when) });
				},
				isBusy: () => session.isStreaming,
				storageDir: `${envPaths("ai-turk").data}/${userKey}`,
			}),
			pushSubscription: loadPushSubscription(userKey), // 영속화된 구독 복원
			ws: new Set(),
			lastPrompt: null,
			lastAssistantText: loadLastAssistantText(userKey)?.text ?? null,
			isStreaming: false,
			lastActivity: Date.now(),
			currentRoute: "user",
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

	const customCommands = ["restart_pi", "schedule", "push_subscribe", "get_last_assistant_text"];

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
								session.agentSessionId = null;
				session.lastAssistantText = null;
				session.lastPrompt = null; // 새 세션 — 클리어 → 백엔드 새 세션 → ready 후 get_state로 새 ID 갱신
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
							} else if (msg.type === "get_last_assistant_text") {
								broadcast(session, {
									type: "response",
									command: "get_last_assistant_text",
									success: true,
									data: { text: (() => { const s = loadLastAssistantText(userKey); return (s && s.sessionId === session.agentSessionId) ? s.text : ""; })() },
								});
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