/**
 * AI Turk 백엔드 서버
 * pi --mode rpc를 영구 백엔드로 사용, WebSocket으로 프론트엔드와 통신
 *
 * 구조: React ←WebSocket→ 서버 ←stdin/stdout→ pi --mode rpc
 */

import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ── 설정 ────────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3001");
const PI_BIN = process.env.TURK_RPC_BIN || "pi";
const PI_MODEL = process.env.TURK_RPC_MODEL || "ollama-cloud/gemini-3-flash-preview";
const PI_EXTRA_ARGS = (process.env.TURK_RPC_ARGS || "").split(/\s+/).filter(Boolean);
const DIST_DIR = join(__dirname, "dist");

// ── MIME 타입 ──────────────────────────────────────────────────────────
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
	console.log(`[백엔드] ${PI_BIN} ${args.join(" ")} 시작`);

	piProcess = spawn(PI_BIN, args, {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: __dirname,
	});
	piReady = false;

	// JSONL 리더 (readline 사용 금지 — U+2028/U+2029 분할 이슈)
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
				handlePiEvent(JSON.parse(line));
			} catch {
				console.error("[백엔드] JSONL 파싱 오류:", line.slice(0, 120));
			}
		}
	});

	piProcess.stdout!.on("end", () => {
		buffer += decoder.end();
		if (buffer.trim()) {
			try {
				handlePiEvent(JSON.parse(buffer));
			} catch { /* 무시 */ }
		}
		buffer = "";
	});

	piProcess.stderr!.on("data", (chunk: Buffer) => {
		const msg = chunk.toString().trim();
		if (msg) console.error("[pi]", msg.slice(0, 500));
	});

	piProcess.on("exit", (code) => {
		console.log(`[백엔드] pi 종료 (코드: ${code})`);
		piProcess = null;
		piReady = false;
		broadcast({ type: "pi_exit", code });
	});

	piProcess.on("error", (err) => {
		console.error("[백엔드] pi 시작 실패:", err.message);
		piProcess = null;
		broadcast({ type: "pi_error", message: err.message });
	});

	// pi 프로세스 시작 직후 ready 상태로 전환
	// (pi는 stdin 명령을 즉시 수신 가능)
	piReady = true;
	broadcast({ type: "pi_ready" });
}

function sendPi(cmd: Record<string, unknown>): void {
	if (!piProcess || !piProcess.stdin.writable) {
		console.error("[백엔드] pi 없음 — 명령 무시:", cmd.type);
		return;
	}
	piProcess.stdin.write(JSON.stringify(cmd) + "\n");
}

// ── 브로드캐스트 ──────────────────────────────────────────────────────
function broadcast(data: Record<string, unknown>): void {
	const msg = JSON.stringify(data);
	for (const ws of clients) {
		if (ws.readyState === WebSocket.OPEN) ws.send(msg);
	}
}

// ── pi 이벤트 처리 ──────────────────────────────────────────────────────
function handlePiEvent(event: Record<string, any>): void {
	// 모든 pi 이벤트를 클라이언트에 전달
	broadcast(event);


}

// ── HTTP 서버 (정적 파일 + 헬스체크) ───────────────────────────────────
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
	const url = new URL(req.url || "/", `http://${req.headers.host}`);

	// 헬스체크
	if (url.pathname === "/api/health") {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true, pi: piProcess !== null, piReady }));
		return;
	}

	// 정적 파일 서빙 (프로덕션 빌드)
	let filePath = join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
	try {
		const s = await stat(filePath);
		if (s.isDirectory()) filePath = join(filePath, "index.html");
		const data = await readFile(filePath);
		const ext = extname(filePath);
		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
		res.end(data);
	} catch {
		// SPA 폴백
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

wss.on("connection", (ws) => {
	console.log("[백엔드] 클라이언트 연결");
	clients.add(ws);

	// 현재 pi 상태 전송
	ws.send(JSON.stringify({ type: piReady ? "pi_ready" : "pi_starting" }));
	if (!piProcess) ws.send(JSON.stringify({ type: "pi_exit", code: null }));

	ws.on("message", (raw) => {
		try {
			const msg = JSON.parse(raw.toString());

			// pi에 전달할 명령
			const passthrough = [
				"prompt", "steer", "follow_up", "abort", "new_session",
				"set_model", "set_thinking_level", "bash",
				"extension_ui_response",
			];
			if (passthrough.includes(msg.type)) {
				sendPi(msg);
				return;
			}

			// pi 재시작
			if (msg.type === "restart_pi") {
				console.log("[백엔드] pi 재시작 요청");
				if (piProcess) {
					piProcess.kill("SIGTERM");
					piProcess = null;
				}
				setTimeout(() => startPi(), 500);
				return;
			}

			console.warn("[백엔드] 알 수 없는 메시지:", msg.type);
		} catch (e) {
			console.error("[백엔드] 메시지 파싱 오류:", e);
		}
	});

	ws.on("close", () => {
		clients.delete(ws);
		console.log("[백엔드] 클라이언트 연결 해제 (총", clients.size, "명)");
	});
});

// ── 종료 처리 ────────────────────────────────────────────────────────────
process.on("SIGINT", () => {
	console.log("\n[백엔드] 종료 중...");
	if (piProcess) piProcess.kill("SIGTERM");
	server.close();
	wss.close();
	process.exit(0);
});

process.on("SIGTERM", () => {
	if (piProcess) piProcess.kill("SIGTERM");
	process.exit(0);
});

// ── 시작 ──────────────────────────────────────────────────────────────────
startPi();
server.listen(PORT, () => {
	console.log(`[백엔드] AI Turk 서버 http://localhost:${PORT}`);
	console.log(`[백엔드] WebSocket ws://localhost:${PORT}/ws`);
	console.log(`[백엔드] 모델: ${PI_MODEL}`);
});