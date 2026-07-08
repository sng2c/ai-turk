/**
 * AI Turk 프로덕션 서버
 * pi --mode rpc + WebSocket + 정적 파일 서빙 (dist/)
 *
 * 개발: npm run dev (Vite 플러그인이 pi RPC 통합)
 * 프로덕션: npm start (이 파일이 dist/ + WebSocket + pi RPC)
 */

import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── .env 로더 (의존성 없음) ────────────────────────────────────────────
try {
	const content = readFileSync(join(__dirname, ".env"), "utf8");
	for (const line of content.split("\n")) {
		const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
		if (m && !(m[1] in process.env)) {
			process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
		}
	}
} catch { /* .env 없음 — 무시 */ }

// ── 설정 ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || "3000");
const PI_BIN = process.env.TURK_RPC_BIN || "pi";
const PI_MODEL = process.env.TURK_RPC_MODEL || "ollama-cloud/gemini-3-flash-preview";
const PI_EXTRA_ARGS = (process.env.TURK_RPC_ARGS || "").split(/\s+/).filter(Boolean);
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

// ── pi RPC 프로세스 ────────────────────────────────────────────────────
let piProcess: ChildProcess | null = null;
let piReady = false;
const clients = new Set<WebSocket>();

function startPi(): void {
	const args = ["--mode", "rpc", "--no-session", "--model", PI_MODEL, ...PI_EXTRA_ARGS];
	console.log(`[Turk] ${PI_BIN} ${args.join(" ")} 시작`);
	piProcess = spawn(PI_BIN, args, { stdio: ["pipe", "pipe", "pipe"], cwd: __dirname });
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
	if (!piProcess?.stdin.writable) return;
	piProcess.stdin.write(JSON.stringify(cmd) + "\n");
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
		res.end(JSON.stringify({ ok: true, pi: piProcess !== null, piReady }));
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

// ── 종료 처리 ────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
	if (piProcess) piProcess.kill("SIGTERM");
	server.close();
	wss.close();
	process.exit(0);
});

// ── 시작 ──────────────────────────────────────────────────────────────────
startPi();
server.listen(PORT, () => {
	console.log(`[Turk] AI Turk 서버 http://localhost:${PORT}`);
	console.log(`[Turk] WebSocket ws://localhost:${PORT}/ws`);
	console.log(`[Turk] 모델: ${PI_MODEL}`);
});