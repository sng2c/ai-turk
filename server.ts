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
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { WebSocket, WebSocketServer } from "ws";
import { createBackend, type Backend, type TurkEvent } from "./backend.ts";
import { Scheduler, formatTriggerMessage } from "./scheduler.ts";
import { ensureAgentsMd } from "./src/lib/agents-md-server.ts";
import envPaths from "env-paths";
import webpush from "web-push";

const __dirname = dirname(fileURLToPath(import.meta.url));
console.log(`[Turk] __dirname: ${__dirname}`);

// ── .env 로더 (의존성 없음) ────────────────────────────────────────────
try {
	const envFile = process.env.TURK_ENV_FILE || ".env";
	// 절대경로는 그대로, 상대경로는 서버 파일 기준 해결 (join이 절대경로를 깨먹는 것 방지 — TURK_ENV_FILE=/abs/.env 사용 가능)
	const envPath = envFile.startsWith("/") ? envFile : join(__dirname, envFile);
	const content = readFileSync(envPath, "utf8");
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
const DIST_DIR = join(__dirname, "dist");
const MAX_SESSIONS = parseInt(process.env.TURK_MAX_SESSIONS || "5");

// ── Web Push (VAPID 키 자동 발급, 메모리만) — 서버 전역 1개 (모든 세션 공유) ──
const vapidKeys = webpush.generateVAPIDKeys();
const VAPID_PUBLIC_KEY: string = vapidKeys.publicKey;
const VAPID_PRIVATE_KEY: string = vapidKeys.privateKey;

// 진단 로그 토글: TURK_DEBUG=1
const DEBUG = !!process.env.TURK_DEBUG;
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
	".webmanifest": "application/manifest+json",
};

// ── 세션 구조 — 유저(브라우저)별 독립 백엔드 + 스케줄러 ───────────────────
interface Session {
	userKey: string;
	agentSessionId: string | null; // 백엔드 세션 ID (config.json 영속, ready 시 get_state로 갱신). null = 새 세션
	backend: Backend | null;
	backendReady: boolean;
	scheduler: Scheduler;
	pushSubscription: any; // 마지막 구독 (1인 — 세션당 1개)
	ws: Set<WebSocket>; // 같은 유저 다중 탭 — 동일 세션 broadcast
	lastResponse: any | null; // 마지막 agent_end 이벤트 캐시 — WS 미연결(백그라운드) 유실분 복원용 (마지막 1건)
	lastTurnFailed: boolean; // 응답 실패 명시 정의 — 마지막 agent_end.error 여부. get_state로 UI 전달
	lastPrompt: string | null; // 처리중 사용자 프롬프트 — 재연결 시 "뭘 기다리는지" 입력창 표시용 (isStreaming과 짝)
	lastResponsePrompt: string | null; // lastResponse가 대답하는 프롬프트 — 응답 상단 짝표시용
	isStreaming: boolean; // 백엔드 응답 생성 중 여부
	lastActivity: number; // 마지막 활동 타임스탬프 (LRU 정리용)
	currentRoute: "user" | "scheduler" | "tool"; // 현재 프롬프트 경로 — agent_start에 주입
}


const sessions = new Map<string, Session>();

// ── 백엔드 시작 (세션별) ────────────────────────────────────────────────
function startBackend(session: Session): void {
	try { 
		const agentCwd = join(envPaths("ai-turk").data, session.userKey, "workspace");
		mkdirSync(agentCwd, { recursive: true }); 
		const agentsMdPath = join(agentCwd, "AGENTS.md");
		ensureAgentsMd(agentsMdPath);
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
		// agent_start: 스트리밍 시작
		if (ev.type === "agent_start") { session.isStreaming = true; return; } // pi 것 스킵 — 서버가 이미 합성 전송
		// agent_end: 스트리밍 종료 + 큐 드레인 + 웹 푸시
		if (ev.type === "agent_end") {
			session.isStreaming = false;
			if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] agent_end 도착 — drainQueue 호출`);
			// 응답 실패 명시 정의 — agent_end.error → 실패 플래그. lastResponse는 성공분만 캐시
			const aborted = Array.isArray((ev as any).messages) && (ev as any).messages.some((m: any) => m.role === "assistant" && m.stopReason === "aborted");
			session.lastTurnFailed = !!(ev as any).error;
			// 응답 파싱 — silent 캐시 판정 + schedules 서버 적용에 공용
			const { parsed: respParsed } = parseTurkResponse(ev);
			// 취소(aborted)·silent는 lastResponse 캐시에서 제외 (AGENTS.md 약속: silent = no cache) —
			// 백그라운드 조건 스킵 턴이 이전 가시 화면 복원본(lastResponse)을 덮어써 재오픈 시 빈 화면이 되던 버그 수정
			if (!session.lastTurnFailed && !aborted && respParsed?.silent !== true) { session.lastResponse = ev; session.lastResponsePrompt = session.lastPrompt; } // 응답↔프롬프트 짝
			if (!session.lastTurnFailed) session.lastPrompt = null;
			// 실패: lastPrompt 유지 — get_state가 재시도 에코로 전달 (실패 화면과 짝)
			// schedules 배열을 서버가 응답에서 직접 스케줄러에 적용 — 클라이언트 릴레이 제거.
			// 백그라운드(WS 끊김) 트리거에서도 체이닝 재등록이 유실되지 않게 (silent 스킵의 schedules 재등록이 사라지던 버그 수정)
			// 결과 broadcast는 기존 클라이언트 로직이 소비 — list 자동 재주입(data.text)·오류 피드백(error)
			if (!session.lastTurnFailed && !aborted && Array.isArray(respParsed?.schedules)) {
				for (const sch of respParsed.schedules) {
					if (!sch || typeof sch !== "object") continue;
					const r = session.scheduler.handle(sch);
					console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] 응답 적용: action=${sch.action} id=${sch.id ?? "-"} when=${sch.when ?? "-"} → ${r.success ? "ok" : `오류: ${r.error}`}`);
					broadcast(session, {
						type: "response",
						command: "schedule",
						success: r.success,
						...(r.success ? { data: r.data } : { error: r.error }),
					});
				}
			}
			session.scheduler.drainQueue();
			if (session.pushSubscription) sendPushNotification(session, ev);
		}
		// get_state 응답 보강: isStreaming 등 주입
		if (ev.type === "response" && ev.command === "get_state") {
			(ev as any).data = { ...(ev as any).data, lastPrompt: session.lastPrompt, isStreaming: session.isStreaming, route: session.currentRoute, lastResponse: session.lastResponse, lastResponsePrompt: session.lastResponsePrompt, lastTurnFailed: session.lastTurnFailed };
		}
		broadcast(session, ev);
	});
	session.backend.start();
}

// 같은 세션(유저) WS 전체에 broadcast — 다중 탭 동기화
function broadcast(session: Session, data: Record<string, unknown>): void {
	if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [WS] 송신: type=${data.type}${data.command ? " command=" + data.command : ""}`);
	const msg = JSON.stringify(data);
	for (const ws of session.ws) {
		if (ws.readyState === WebSocket.OPEN) ws.send(msg);
	}
}

// backend.send 가로채서 route 추적
function sendToBackend(session: Session, cmd: Record<string, unknown>, opts?: { route?: "user" | "scheduler" | "tool" }): void {
	const route = (opts?.route ?? cmd.route ?? "user") as "user" | "scheduler" | "tool";
	session.currentRoute = route;
	// 처리중 프롬프트 기록 — 재연결/새로고침 후 get_state로 표시 (user 라우트 순수 입력만)
	if (cmd.type === "prompt" && route === "user" && typeof cmd.userInput === "string") {
		session.lastPrompt = cmd.userInput;
		saveLastPrompt(session.userKey, cmd.userInput); // 출력버퍼 영속화
	}
	// prompt 전송 전에 합성 agent_start broadcast — 즉시 로고 전환 + dim
	if (cmd.type === "prompt") {
		session.isStreaming = true;
		broadcast(session, { type: "agent_start", route });
	}
	// 취소 완결 — abort만으론 pi 자동재시도 '지연'을 못 끊음. abort_retry 병행으로 사용자 의도(완전 취소) 보장
	if (cmd.type === "abort") session.backend?.send({ type: "abort_retry" });
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

// 응답 텍스트에서 터크 JSON 추출 — 후보: 코드펜스 → greedy {…} → 첫 '{'부터 끝까지 (클라이언트 parseTurkJSON과 동일 전략, 검증은 소비부가 담당)
// silent 캐시 판정·push 선별·schedules 적용의 공용 파서. 파싱 실패 시 parsed=null (원문 text는 보존).
function parseTurkResponse(ev: TurkEvent): { text: string; parsed: any | null } {
	const messages = (ev as any).messages;
	const text = Array.isArray(messages) ? extractTextFromMessages(messages) : "";
	if (!text) return { text: "", parsed: null };
	const candidates: string[] = [];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) candidates.push(fence[1]);
	const greedy = text.match(/\{[\s\S]*\}/);
	if (greedy) candidates.push(greedy[0]);
	const firstBrace = text.indexOf("{");
	if (firstBrace !== -1) candidates.push(text.slice(firstBrace));
	for (const raw of candidates) {
		const s = raw.trim();
		if (!s) continue;
		try { return { text, parsed: JSON.parse(s) }; } catch { /* 다음 후보 */ }
	}
	return { text, parsed: null };
}

function sendPushNotification(session: Session, ev: TurkEvent): void {
	const { text, parsed } = parseTurkResponse(ev);
	if (!text) return;
	// silent 응답은 push 폐기 — sw.js 파싱 중복 방지 목적 서버에서 선별
	if (parsed && parsed.silent === true) return;
	// 전체 text 전송 + sessionId → sw.js가 IndexedDB 저장에 사용
	const payload = JSON.stringify({ body: text, sessionId: session.agentSessionId || "" });
	webpush.sendNotification(session.pushSubscription, payload)
		.then(() => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 성공`))
		.catch((err) => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 실패: ${err.message}`));
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
// ── lastPrompt 영속화 (서버 출력버퍼) — 재시작·세션 재생성·다른 브라우저와 무관하게 이전 입력 제공 ──
function loadLastPrompt(userKey: string): string | null {
	try {
		const f = `${envPaths("ai-turk").data}/${userKey}/last-prompt`;
		if (!existsSync(f)) return null;
		return readFileSync(f, "utf-8") || null;
	} catch { return null; }
}
function saveLastPrompt(userKey: string, v: string): void {
	try { writeFileSync(`${envPaths("ai-turk").data}/${userKey}/last-prompt`, v); } catch { /* 디스크 실패 무시 */ }
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
				console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] onTrigger → 백엔드 주입: ids=${entries.map((e) => e.id).join(",")}`);
				const msg = formatTriggerMessage(entries, new Date());
				sendToBackend(session, { type: "prompt", message: msg }, { route: "scheduler" });
				broadcast(session, { type: "scheduler_trigger", ids: entries.map((e) => e.id), whens: entries.map((e) => e.when) });
			},
			isBusy: () => session.isStreaming,
			storageDir: `${envPaths("ai-turk").data}/${userKey}`,
		}),
		pushSubscription: loadPushSubscription(userKey), // 영속화된 구독 복원 (재시작 후 재구독 불필요)
		ws: new Set(),
		lastResponse: null,
		lastTurnFailed: false,
		lastPrompt: loadLastPrompt(userKey), // 영속 버퍼에서 복원 — 이전 입력 짝 캡션
		lastResponsePrompt: null,
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
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 100 * 1024 * 1024 }); // 첨부 base64 프레임 수용 (50MB 파일)
// WS keepalive — 모바일 NAT의 유휴 컷(1005 churn) 방지: 주기 ping에 브라우저가 자동 pong
setInterval(() => { for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.ping(); }, 25000);
const customCommands = ["restart_pi", "schedule", "push_subscribe", "attach"];

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
			if (DEBUG) console.log(`[${userKey.slice(0, 8)}] [WS] 수신: type=${msg.type}`);
			if (customCommands.includes(msg.type)) {
				if (msg.type === "restart_pi") {
					if (session.backend) { session.backend.stop(); session.backend = null; }
					session.backendReady = false;
					session.agentSessionId = null;
				session.lastResponse = null; // 새 세션 — 응답 캐시 클리어
				session.lastTurnFailed = false; // 새 세션 — 실패 플래그 클리어
				session.lastPrompt = null; // 새 세션 — 처리중 표시 클리어
				saveLastPrompt(session.userKey, ""); // 새 세션 — 영속 버퍼도 클리어
				session.lastResponsePrompt = null; // 새 세션 — 짝 정보 클리어
					console.log(`[${userKey.slice(0, 8)}] [restart_pi] 새 세션 시작 (agentSessionId 클리어)`);
					setTimeout(() => startBackend(session), 500);
				} else if (msg.type === "schedule") {
					console.log(`[${userKey.slice(0, 8)}] [Scheduler] 명령 수신: action=${msg.action} id=${msg.id ?? "-"} when=${msg.when ?? "-"}`);
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
					if (DEBUG) console.log(`[${userKey.slice(0, 8)}] [Push] 구독 수신+저장: ${msg.subscription?.endpoint?.slice(0, 60)}`);
				} else if (msg.type === "attach") {
					// 파일 업로드 → OS 임시디렉토리 저장 (휘발 — OS가 정리) — 에이전트가 자기 read 도구로 읽음
					const MAX_ATTACH = 50 * 1024 * 1024;
					const data = typeof msg.data === "string" ? msg.data : "";
					const name = String(msg.name ?? "file").split(/[\\/]/).pop()!.replace(/[\x00-\x1f]/g, "").trim().slice(0, 100) || "file";
					if (!data || data.length > MAX_ATTACH * 1.4) {
						ws.send(JSON.stringify({ type: "response", command: "attach", success: false, error: "파일 크기 초과 — 최대 50MB" }));
					} else {
						try {
							const dir = join(tmpdir(), "ai-turk-attach", userKey);
							mkdirSync(dir, { recursive: true });
							const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
							const abs = join(dir, `${ts}-${name}`);
							writeFileSync(abs, Buffer.from(data, "base64"));
							console.log(`[${userKey.slice(0, 8)}] [Attach] 저장: ${abs}`);
							ws.send(JSON.stringify({ type: "response", command: "attach", success: true, data: { path: abs, name } }));
						} catch (err) {
							ws.send(JSON.stringify({ type: "response", command: "attach", success: false, error: err instanceof Error ? err.message : String(err) }));
						}
					}
				}
			} else {
				sendToBackend(session, msg);
			}
		} catch (e) {
			console.error("[Turk] 메시지 파싱 오류:", e);
		}
	});

	ws.on("close", (code, reason) => {
		session.ws.delete(ws);
		session.lastActivity = Date.now();
		console.log(`[Turk] 종료: ${userKey.slice(0, 8)} code=${code} reason=${reason.toString() || "-"} (남은 WS ${session.ws.size})`);
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