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
import { createSessionCore, verifyUserKeyFormat } from "./session-core.ts";
import { createAuthorizer, attemptLogin, clearCookie, changePassword, reconcileUsersWithDisk } from "./auth.ts"; // Phase 2 — import는 상단, 사용은 조건부 (AUTH) · changePassword는 Phase 3 비밀번호 변경 · reconcileUsersWithDisk는 Phase 4a 부팅 잔여키 대사

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

// ── Phase 2 인증 (TURK_AUTH=1 — .env 로더 뒤에서 판정; 미설정=기존 무인증 동작 그대로) ──
const AUTH = !!process.env.TURK_AUTH;
const auth = AUTH ? createAuthorizer() : null; // authorize 주입 — session-core는 구조 일치만 요구

// ── 세션 코어 (공용) — .env 로드 후 생성 ─────────────────────────────────
const core = createSessionCore(auth ? { authorize: auth } : {});
const MAX_SESSIONS = core.maxSessions;

const JSONH = { "Content-Type": "application/json" };

// ── 요청 본문 수집 (작은 JSON 한정 — 64KB 상한 초과 시 파기) ─
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > 64 * 1024) { req.destroy(); chunks.length = 0; return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(""));
	});
}

// IP 추출 — TURK_TRUST_PROXY=1이면 프록시(Caddy) 뒤 X-Forwarded-For 첫 값, 아니면 소켓 주소 (레이트리밋 키)
const clientIp = (r: IncomingMessage): string => {
	if (process.env.TURK_TRUST_PROXY === "1") {
		const xff = r.headers["x-forwarded-for"];
		const first = typeof xff === "string" ? xff : Array.isArray(xff) ? xff[0] : "";
		const ip = first?.split(",")[0]?.trim();
		if (ip) return ip;
	}
	return r.socket?.remoteAddress || "unknown";
};

// ── 로그인 페이지 (Phase 2) — 의존 0 인라인 템플릿 (픽셀폰트 CDN 링크만).
// 리다이렉트 금지 — 미인증 경로에서 그 자리 200으로 서빙해 #해시(대화 키) 보존이 계약.
const LOGIN_PAGE = `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/neodgm/neodgm-webfont@latest/neodgm/style.css" />
<title>AI Turk — 로그인</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000; color: #fff; font-family: "NeoDunggeunmo", monospace;
         min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
  .card { width: 100%; max-width: 320px; }
  h1 { font-size: 28px; font-weight: normal; text-align: center; margin-bottom: 6px; letter-spacing: 2px; }
  .sub { text-align: center; font-size: 12px; color: #666; margin-bottom: 28px; }
  input { display: block; width: 100%; padding: 12px 14px; margin-bottom: 12px;
          background: #111; color: #fff; border: 1px solid #333; border-radius: 8px;
          font-family: inherit; font-size: 14px; }
  input:focus { outline: none; border-color: #666; }
  button { display: block; width: 100%; padding: 12px; margin-top: 8px;
           background: #fff; color: #000; border: 0; border-radius: 8px;
           font-family: inherit; font-size: 15px; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: wait; }
  #msg { min-height: 18px; text-align: center; font-size: 12px; color: #ff6b6b; margin-top: 14px; white-space: pre-line; }
</style>
</head>
<body>
<div class="card">
  <h1>AI Turk</h1>
  <div class="sub">계정으로 로그인하세요</div>
  <form id="form">
    <input id="u" name="username" autocomplete="username" placeholder="아이디" />
    <input id="p" name="password" type="password" autocomplete="current-password" placeholder="비밀번호" />
    <button id="btn" type="submit">로그인</button>
  </form>
  <div id="msg" role="alert"></div>
</div>
<script>
  document.getElementById("form").addEventListener("submit", async function (e) {
    e.preventDefault();
    var msg = document.getElementById("msg");
    var btn = document.getElementById("btn");
    msg.textContent = ""; btn.disabled = true;
    try {
      var r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value }) });
      var j = await r.json();
      if (r.ok && j.ok) { location.reload(); return; } // 새로고침 — #해시 보존
      msg.textContent = j.error || "로그인 실패";
    } catch (err) { msg.textContent = "네트워크 오류 — 다시 시도해 주세요"; }
    btn.disabled = false;
  });
</script>
</body>
</html>`;

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

	// ── 인증 API (Phase 2 — AUTH시에만 활성) ───────────────────────────
	if (url.pathname === "/api/login" && req.method === "POST") {
		if (!AUTH) { res.writeHead(404, JSONH); res.end(JSON.stringify({ error: "인증 비활성" })); return; }
		let username = "", password = "";
		try {
			const body = JSON.parse(await readBody(req));
			if (typeof body?.username === "string") username = body.username;
			if (typeof body?.password === "string") password = body.password;
		} catch { /* 파싱 실패 — 빈 값으로 진행 (검증 실패 처리) */ }
		const r = await attemptLogin(username, password, clientIp(req));
		if (r.ok) {
			// 토큰은 Set-Cookie로만 전달 — 응답 JSON에 노출 금지
			res.writeHead(200, { ...JSONH, "Set-Cookie": r.setCookie, "Cache-Control": "no-store" });
			res.end(JSON.stringify({ ok: true, username: r.username }));
		} else {
			res.writeHead(r.rateLimited ? 429 : 401, { ...JSONH, "Cache-Control": "no-store" });
			res.end(JSON.stringify({ error: r.error }));
		}
		return;
	}

	if (url.pathname === "/api/logout" && req.method === "POST") {
		// 쿠키 클리어 (AUTH 미설정에도 무해 — 항상 응답)
		res.writeHead(200, { ...JSONH, "Set-Cookie": clearCookie(), "Cache-Control": "no-store" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	if (url.pathname === "/api/me") {
		if (!AUTH) { res.writeHead(200, JSONH); res.end(JSON.stringify({ ok: true, auth: "off" })); return; }
		const me = auth ? await auth.authorizeRequest(req) : null;
		if (!me) { res.writeHead(401, JSONH); res.end(JSON.stringify({ error: "인증 필요" })); return; }
		res.writeHead(200, { ...JSONH, "Cache-Control": "no-store" });
		res.end(JSON.stringify({ username: me }));
		return;
	}

	// ── 비밀번호 변경 (Phase 3 — AUTH시에만) ───────────────────────────
	if (url.pathname === "/api/passwd" && req.method === "POST") {
		if (!AUTH) { res.writeHead(404, JSONH); res.end(JSON.stringify({ error: "인증 비활성" })); return; }
		const user = auth ? await auth.authorizeRequest(req) : null;
		if (!user) { res.writeHead(401, JSONH); res.end(JSON.stringify({ error: "인증 필요" })); return; }
		let current = "", next = "";
		try {
			const body = JSON.parse(await readBody(req));
			if (typeof body?.current === "string") current = body.current;
			if (typeof body?.next === "string") next = body.next;
		} catch { /* 파싱 실패 — 빈 값으로 진행 (검증 실패 처리) */ }
		// 길이 규칙 라우트 선검사 — changePassword는 불리언 단일 반환이라 오류 원인을 라우트에서 구분:
		// 길이 위반이 남으면 나머지 실패는 현재 비번 불일치(또는 세션 도중 삭제된 계정)뿐이다.
		if (next.length < 4) { res.writeHead(400, JSONH); res.end(JSON.stringify({ error: "새 비밀번호는 4자 이상" })); return; }
		if (!changePassword(user, current, next)) { res.writeHead(400, JSONH); res.end(JSON.stringify({ error: "현재 비밀번호가 올바르지 않습니다" })); return; }
		// JWT는 username 기반 — 비번 변경 후에도 세션 유지 (재로그인 불필요)
		res.writeHead(200, { ...JSONH, "Cache-Control": "no-store" });
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	if (url.pathname === "/api/conversations") {
		// 1c 대화 레지스트리 — 목록 단일 진원 core.listConversations() (정적 파일 처리 앞에서 가로채기)
		// Phase 2 — AUTH시 미인증 401, 인증시 username의 own만 필터 (orphan·foreign 제외)
		if (AUTH) {
			const user = auth ? await auth.authorizeRequest(req) : null;
			if (!user) { res.writeHead(401, JSONH); res.end(JSON.stringify({ error: "인증 필요" })); return; }
			res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
			res.end(JSON.stringify(core.listConversations(user)));
			return;
		}
		res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
		res.end(JSON.stringify(core.listConversations()));
		return;
	}

	// ── 개별 대화 관리 (Phase 3) — rename(PATCH)·delete(DELETE). AUTH off → 404 (dev 무인증 — vite는 수정 금지,
	// dev에서 이 API가 없는 것은 의도된 계약). 순서 계약: ①형식검증 → ②쿠키 인증 → ③소유권 own만 (fs rm 경로조작 방어) ──
	const CONV_PREFIX = "/api/conversations/";
	if (url.pathname.startsWith(CONV_PREFIX) && (req.method === "PATCH" || req.method === "DELETE")) {
		if (!AUTH) { res.writeHead(404, JSONH); res.end(JSON.stringify({ error: "인증 비활성" })); return; }
		let id = "";
		try { id = decodeURIComponent(url.pathname.slice(CONV_PREFIX.length)); } // URL 파서가 남긴 %인코딩 복원 (한글 키 대응)
		catch { id = ""; } // 깨진 %시퀀스 — 빈값으로 형식 위반 처리
		if (!verifyUserKeyFormat(id)) { res.writeHead(400, JSONH); res.end(JSON.stringify({ error: "대화 키 형식이 올바르지 않습니다" })); return; } // ① ../ 등 경로조작 차단
		const user = auth ? await auth.authorizeRequest(req) : null;
		if (!user) { res.writeHead(401, JSONH); res.end(JSON.stringify({ error: "인증 필요" })); return; } // ②
		if (auth?.checkConversation(user, id) !== "own") { res.writeHead(403, JSONH); res.end(JSON.stringify({ error: "권한 없음" })); return; } // ③ orphan·foreign 배제
		if (req.method === "PATCH") {
			let title: unknown = null;
			try { title = JSON.parse(await readBody(req))?.title; } catch { /* 파싱 실패 — undefined로 진행 (아래 400) */ }
			if (typeof title !== "string") { res.writeHead(400, JSONH); res.end(JSON.stringify({ error: "title 문자열이 필요합니다" })); return; }
			if (!core.renameConversation(id, title)) { res.writeHead(404, JSONH); res.end(JSON.stringify({ error: "대화를 찾을 수 없습니다" })); return; }
			res.writeHead(200, JSONH);
			res.end(JSON.stringify({ ok: true }));
			return;
		}
		// DELETE — 셸 제거+dir 소멸 (멱등; removeSession이 session_terminated broadcast·backend stop까지 수행)
		core.deleteConversation(id);
		auth?.releaseConversation(user, id); // Phase 4a — 장부 소유 등록 해제: core가 users.json을 모르므로 이 응답 직전에 여기서 해제 (미해제 잔여키는 타 계정 foreign 오판 → 고아 자동클레임 차단 결함의 근원). 동기 소량 — 응답 지연 없음
		res.writeHead(200, JSONH);
		res.end(JSON.stringify({ ok: true }));
		return;
	}

	// ── 정적 게이트 (Phase 2, AUTH시) — 공개 예외 외 미인증: 루트=로그인 페이지 자리서빙(#해시 보존), 나머지 401 ──
	if (AUTH) {
		const path = url.pathname;
		const publicStatic = path === "/sw.js" || path === "/favicon.svg" || path.startsWith("/apple-touch-icon")
			|| path.startsWith("/icon-") || path.startsWith("/push-") || path === "/api/health";
		if (!publicStatic) {
			const user = auth ? await auth.authorizeRequest(req) : null;
			if (!user) {
				if (path === "/") {
					// 리다이렉트 금지 — 로그인 후 location.reload()로 #해시(대화 키) 보존
					res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
					res.end(LOGIN_PAGE);
					return;
				}
				res.writeHead(401, JSONH);
				res.end(JSON.stringify({ error: "인증 필요" }));
				return;
			}
		}
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
		// sw.js는 항상 재검증 — 서비스워커 업데이트가 HTTP 캐시로 늦어지면 푸시 동작 변경이 기기에 하루씩 늦게 반영됨
		const cache = url.pathname === "/sw.js" ? "no-cache" : (STATIC_CACHE[ext] || "no-cache");
		res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cache });
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

// ── 부팅 잔여키 대사 (Phase 4a) — 삭제된 대화의 소유 등록(users.json 잔여키) 소급 정리 ──
// 수동 dir 삭제 이력 커버 + 안전망 (신규 삭제분은 DELETE 라우트의 release가 실시간 처리 — 이후 재발분은 부팅마다 자정).
// dir은 건드리지 않는다 — 고아 dir은 소유 없음 유지. AUTH시에만: 장부(users.json)는 AUTH 전용 자산.
if (AUTH) {
	const dropped = reconcileUsersWithDisk();
	if (dropped > 0) console.log(`[Turk] 잔여키 대사: ${dropped}개 탈락 (삭제된 대화의 소유 등록)`);
}

// ── 시작 ──────────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
	console.log(`[Turk] AI Turk 서버 http://${HOST}:${PORT} (최대 ${MAX_SESSIONS} 세션)`);
	if (AUTH) console.log(`[Turk] 인증: 활성 (TURK_AUTH=1) — 미인증 요청은 로그인 페이지로 게이트 [시크릿·토큰 로그 미출력]`);
	console.log(`[Turk] WebSocket ws://${HOST}:${PORT}/ws?u=<userKey>`);
	const model = process.env.TURK_BACKEND === "claude"
		? (process.env.TURK_CLAUDE_MODEL || "기본")
		: (process.env.TURK_PI_MODEL || "기본");
	console.log(`[Turk] 백엔드: ${process.env.TURK_BACKEND || "pi"} · 모델: ${model}`);
});