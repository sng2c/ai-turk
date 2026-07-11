/**
 * AI Turk 프로덕션 서버
 * 백엔드(pi | claude) + WebSocket + 정적 파일 서빙 (dist/)
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
// 에이전트 실행 위치 — 기본 ./workspace
const AGENT_CWD = process.env.TURK_AGENT_CWD || join(__dirname, "workspace");
const DIST_DIR = join(__dirname, "dist");

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

// ── 백엔드(pi | claude) ────────────────────────────────────────────────
let backend: Backend | null = null;
let backendReady = false;
const clients = new Set<WebSocket>();

function startBackend(): void {
	try { mkdirSync(AGENT_CWD, { recursive: true }); } catch { /* 무시 */ }
	backend = createBackend({
		cwd: AGENT_CWD,
		onLog: (m: string) => console.log(m),
	});
	backend.onEvent((ev: TurkEvent) => {
		if (ev.type === "pi_ready") backendReady = true;
		if (ev.type === "pi_exit" || ev.type === "pi_error") backendReady = false;
		// agent_start: 스트리밍 시작
		if (ev.type === "agent_start") isStreaming = true;
		// agent_end: 스트리밍 종료 + 큐 드레인 + lastPrompt 초기화
		if (ev.type === "agent_end") {
			isStreaming = false;
			lastPrompt = null;
			scheduler.drainQueue();
		}
		// get_state 응답 보강: lastPrompt + isStreaming 주입
		if (ev.type === "response" && ev.command === "get_state") {
			(ev as any).data = { ...(ev as any).data, lastPrompt, isStreaming };
		}
		broadcast(ev);
	});
	backend.start();
}

function broadcast(data: Record<string, unknown>): void {
	const msg = JSON.stringify(data);
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) ws.send(msg);
	}
}

// ── HTTP 서버 (정적 파일 + 헬스체크) ───────────────────────────────────
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	if (url.pathname === "/api/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, pi: backend?.alive() ?? false, piReady: backendReady }));
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
const customCommands = ["restart_pi", "schedule"];
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

// ── 스케줄러 인스턴스 ────────────────────────────────────────────────────
const scheduler = new Scheduler({
	onTrigger: (entry) => {
		const msg = formatTriggerMessage(entry, new Date());
		sendToBackend({ type: "prompt", message: msg }, { fromScheduler: true });
		broadcast({ type: "scheduler_trigger", id: entry.id, mode: entry.mode, at: entry.at });
	},
	isBusy: () => isStreaming,
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
				} else if (msg.type === "schedule") {
					// schedule 명령: scheduler.handle() → 결과를 response 이벤트로 반환
					const result = scheduler.handle(msg);
					broadcast({
						type: "response",
						command: "schedule",
						success: result.success,
						...(result.success ? { data: result.data } : { error: result.error }),
					});
				}
			} else {
				sendToBackend(msg);
			}
		} catch (e) {
			console.error("[Turk] 메시지 파싱 오류:", e);
		}
	});

	ws.on("close", () => clients.delete(ws));
});

// ── 종료 처리 ────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
	scheduler.destroy();
	if (backend) backend.stop();
	server.close();
	wss.close();
	process.exit(0);
});

// ── 시작 ──────────────────────────────────────────────────────────────────
startBackend();
server.listen(PORT, HOST, () => {
	console.log(`[Turk] AI Turk 서버 http://${HOST}:${PORT}`);
	console.log(`[Turk] WebSocket ws://${HOST}:${PORT}/ws`);
	const model = process.env.TURK_BACKEND === "claude"
		? (process.env.TURK_CLAUDE_MODEL || "기본")
		: (process.env.TURK_PI_MODEL || "기본");
	console.log(`[Turk] 백엔드: ${backend?.kind()} · 모델: ${model}`);
});