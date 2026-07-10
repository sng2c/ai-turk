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
const PORT = parseInt(process.env.PORT || "3000");
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
const customCommands = ["restart_pi"];

wss.on("connection", (ws) => {
	console.log("[Turk] 클라이언트 연결");
	clients.add(ws);
	ws.send(JSON.stringify({ type: backendReady ? "pi_ready" : "pi_starting" }));

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

// ── 종료 처리 ────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
	if (backend) backend.stop();
	server.close();
	wss.close();
	process.exit(0);
});

// ── 시작 ──────────────────────────────────────────────────────────────────
startBackend();
server.listen(PORT, () => {
	console.log(`[Turk] AI Turk 서버 http://localhost:${PORT}`);
	console.log(`[Turk] WebSocket ws://localhost:${PORT}/ws`);
	console.log(`[Turk] 백엔드: ${backend?.kind()} · 모델: ${process.env.TURK_RPC_MODEL || "기본"}`);
});