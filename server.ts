/**
 * AI Turk 프로덕션 서버 — 멀티 세션 (유저 키 기반)
 *
 * 백엔드(pi | claude) + WebSocket + 정적 파일 서빙 (dist/)
 * 각 유저(브라우저 localStorage userKey)마다 독립 세션(백엔드 + 스케줄러) 할당.
 * 같은 유저 다중 탭 = 동일 세션 broadcast. 사생활 탭 = 다른 userKey = 다른 세션.
 *
 * 개발: npm run dev (Vite 플러그인이 백엔드 통합)
 * 프로덕션: npm start (이 파일이 dist/ + WebSocket + 백엔드)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { createBackend, type Backend, type TurkEvent } from "./backend.ts";
import { Scheduler, formatTriggerMessage } from "./scheduler.ts";
import webpush from "web-push";
import removeMarkdown from "remove-markdown";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env 로더 (의존성 없음) ────────────────────────────────────────────
try {
	const envFile = process.env.TURK_ENV_FILE || ".env";
	const content = readFileSync(join(__dirname, envFile), "utf8");
	for (const line of content.split("\n")) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m && !(m[1] in process.env)) {
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
} catch { /* .env 없음 — 무시 */ }

// ── 설정 ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.TURK_PORT || "3000");
const HOST = process.env.TURK_HOST || "127.0.0.1";
const AGENT_CWD = process.env.TURK_AGENT_CWD || join(__dirname, "workspace");
const DIST_DIR = join(__dirname, "dist");
const MAX_SESSIONS = parseInt(process.env.TURK_MAX_SESSIONS || "5");

// ── Web Push (VAPID 키 자동 발급, 메모리만) — 서버 전역 1개 (모든 세션 공유) ──
const vapidKeys = webpush.generateVAPIDKeys();
const VAPID_PUBLIC_KEY: string = vapidKeys.publicKey;
const VAPID_PRIVATE_KEY: string = vapidKeys.privateKey;
webpush.setVapidDetails("mailto:ai-turk@local", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
};

// ── 세션 구조 — 유저(브라우저)별 독립 백엔드 + 스케줄러 ───────────────────
interface Session {
	userKey: string;
	backend: Backend | null;
	backendReady: boolean;
	scheduler: Scheduler;
	pushSubscription: any; // 마지막 구독 (1인 — 세션당 1개)
	ws: Set<WebSocket>; // 같은 유저 다중 탭 — 동일 세션 broadcast
	lastPrompt: string | null; // 마지막 프롬프트 (새로고침 복원용)
	isStreaming: boolean; // 백엔드 응답 생성 중 여부
	lastActivity: number; // 마지막 활동 타임스탬프 (LRU 정리용)
}

const sessions = new Map<string, Session>();

// ── 백엔드 시작 (세션별) ────────────────────────────────────────────────
function startBackend(session: Session): void {
	try { mkdirSync(AGENT_CWD, { recursive: true }); } catch { /* 무시 */ }
	session.backend = createBackend({
		cwd: AGENT_CWD,
		userKey: session.userKey, // pi --session-id 영속 세션 (claude는 무시)
		onLog: (m: string) => console.log(`[${session.userKey.slice(0, 8)}] ${m}`),
	});
	session.backend.onEvent((ev: TurkEvent) => {
		if (ev.type === "pi_ready") {
			session.backendReady = true;
			(ev as any).vapidPublicKey = VAPID_PUBLIC_KEY;
		}
		if (ev.type === "pi_exit" || ev.type === "pi_error") session.backendReady = false;
		// agent_start: 스트리밍 시작
		if (ev.type === "agent_start") session.isStreaming = true;
		// agent_end: 스트리밍 종료 + 큐 드레인 + lastPrompt 초기화 + 웹 푸시
		if (ev.type === "agent_end") {
			session.isStreaming = false;
			session.lastPrompt = null;
			session.scheduler.drainQueue();
			if (session.pushSubscription) sendPushNotification(session, ev);
		}
		// get_state 응답 보강: lastPrompt + isStreaming 주입
		if (ev.type === "response" && ev.command === "get_state") {
			(ev as any).data = { ...(ev as any).data, lastPrompt: session.lastPrompt, isStreaming: session.isStreaming };
		}
		broadcast(session, ev);
	});
	session.backend.start();
}

// 같은 세션(유저) WS 전체에 broadcast — 다중 탭 동기화
function broadcast(session: Session, data: Record<string, unknown>): void {
	const msg = JSON.stringify(data);
	for (const ws of session.ws) {
		if (ws.readyState === WebSocket.OPEN) ws.send(msg);
	}
}

// backend.send 가로채서 lastPrompt 저장. fromScheduler 시 생략 (서버 자체 프롬프트는 복원 제외)
function sendToBackend(session: Session, cmd: Record<string, unknown>, opts?: { fromScheduler?: boolean }): void {
	if (cmd.type === "prompt" && typeof cmd.message === "string" && !opts?.fromScheduler) {
		session.lastPrompt = cmd.message;
	}
	session.backend?.send(cmd);
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

// ── 세션 관리 ────────────────────────────────────────────────────────────
function createSession(userKey: string): Session {
	const session: Session = {
		userKey,
		backend: null,
		backendReady: false,
		scheduler: new Scheduler({
			onTrigger: (entry) => {
				const msg = formatTriggerMessage(entry, new Date());
				sendToBackend(session, { type: "prompt", message: msg }, { fromScheduler: true });
				broadcast(session, { type: "scheduler_trigger", id: entry.id, cron: entry.cron });
			},
			isBusy: () => session.isStreaming,
		}),
		pushSubscription: null,
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
	// WS들에게 세션 종료 알림
	broadcast(session, { type: "session_terminated", reason: "유휴 세션 정리" });
	for (const ws of session.ws) ws.close();
	session.scheduler.destroy();
	session.backend?.stop();
	sessions.delete(userKey);
}

// 유저 키로 세션 조회/생성. 최대 도달 시 WS 없는 유휴 세션 LRU 강제 종료 → 수용.
function getOrCreateSession(userKey: string): Session | { error: string } {
	const existing = sessions.get(userKey);
	if (existing) {
		existing.lastActivity = Date.now();
		return existing;
	}
	if (sessions.size >= MAX_SESSIONS) {
		// WS 없는 유휴 세션 중 가장 오래된 것(LRU) 강제 종료
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

// ── HTTP 서버 (정적 파일 + 헬스체크) ───────────────────────────────────
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	if (url.pathname === "/api/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, sessions: sessions.size, maxSessions: MAX_SESSIONS }));
		return;
	}

	let filePath = join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
	try {
		const s = await stat(filePath);
		if (s.isDirectory()) filePath = join(filePath, "index.html");
		const data = await readFile(filePath);
		res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
		res.end(data);
	} catch {
		try {
			const data = await readFile(join(DIST_DIR, "index.html"));
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(data);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("404 Not Found");
		}
	}
});

// ── WebSocket 서버 ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
const customCommands = ["restart_pi", "schedule", "push_subscribe"];

wss.on("connection", (ws, req) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);
	const userKey = url.searchParams.get("u");
	if (!userKey) {
		ws.send(JSON.stringify({ type: "session_error", error: "userKey 누락 — 클라이언트 설정 확인 필요" }));
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

	// 백엔드 상태 즉시 통지 (새 탭/재연결 동기화)
	ws.send(JSON.stringify({
		type: session.backendReady ? "pi_ready" : "pi_starting",
		...(session.backendReady ? { backend: session.backend?.kind(), vapidPublicKey: VAPID_PUBLIC_KEY } : {}),
	}));

	ws.on("message", (raw) => {
		try {
			const msg = JSON.parse(raw.toString());
			if (customCommands.includes(msg.type)) {
				if (msg.type === "restart_pi") {
					if (session.backend) { session.backend.stop(); session.backend = null; }
					session.backendReady = false;
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
					console.log(`[${userKey.slice(0, 8)}] [Push] 구독 수신: ${msg.subscription?.endpoint?.slice(0, 60)}`);
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

// ── 종료 처리 ────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
	for (const userKey of sessions.keys()) removeSession(userKey);
	server.close();
	wss.close();
	process.exit(0);
});

// ── 시작 ──────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
	console.log(`[Turk] AI Turk 서버 http://${HOST}:${PORT} (최대 ${MAX_SESSIONS} 세션)`);
	console.log(`[Turk] WebSocket ws://${HOST}:${PORT}/ws?u=<userKey>`);
	const model = process.env.TURK_BACKEND === "claude"
		? (process.env.TURK_CLAUDE_MODEL || "기본")
		: (process.env.TURK_PI_MODEL || "기본");
	console.log(`[Turk] 백엔드: ${process.env.TURK_BACKEND || "pi"} · 모델: ${model}`);
});