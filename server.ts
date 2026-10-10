/**
 * AI Turk 프로덕션 서버 — 멀리 세션 (유저 키 기반)
 *
 * 백엔드(pi | claude) + WebSocket + 정적 파일 서빙 (dist/)
 * 세션/WS/영속화/푸시 로직은 session-core.ts (공용 코어, dev turkPlugin과 동일 진원).
 * 이 파일은 HTTP 서빙 + 생명주기 배선만 담당.
 *
 * 개발: npm run dev (Vite 플러그인이 백엔드 통합)
 * 프로덕션: npm start (이 파일이 dist/ + WebSocket + 백엔드)
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createSessionCore } from "./session-core.ts";

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

// ── 세션 코어 (공용) — .env 로드 후 생성 ─────────────────────────────────
const core = createSessionCore();
const MAX_SESSIONS = core.maxSessions;

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

// ── HTTP 서버 (정적 파일 + 헬스체크) ───────────────────────────────────
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	if (url.pathname === "/api/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, sessions: core.sessions.size, maxSessions: MAX_SESSIONS }));
		return;
	}

	let filePath = join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
	// 캐시 정책: 진입점·manifest·파비콘은 항상 재검증(아이콘/manifest 갱신 즉시 반영 — Firefox A2HS가 옛 manifest 캐시로 기본 타일 생성하던 문제),
	// 해시명 번들·폰트는 1일, PNG 아이콘은 1시간
	const STATIC_CACHE: Record<string, string> = {
		".html": "no-cache", ".webmanifest": "no-cache", ".svg": "no-cache", ".ico": "no-cache",
		".png": "public, max-age=3600",
		".js": "public, max-age=86400", ".css": "public, max-age=86400", ".woff2": "public, max-age=86400",
	};
	try {
		const s = await stat(filePath);
		if (s.isDirectory()) filePath = join(filePath, "index.html");
		const data = await readFile(filePath);
		const ext = extname(filePath);
		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": STATIC_CACHE[ext] || "no-cache" });
		res.end(data);
	} catch {
		try {
			const data = await readFile(join(DIST_DIR, "index.html"));
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
			res.end(data);
		} catch {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("404 Not Found");
		}
	}
});

// ── WebSocket 서버 ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 100 * 1024 * 1024 }); // 첨부 base64 프레임 수용 (50MB 파일)
core.keepAlive(wss);
wss.on("connection", (ws, req) => core.handleConnection(ws, req));

// ── 종료 처리 ────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
	core.removeAllSessions();
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