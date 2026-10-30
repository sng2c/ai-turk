import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @tailwindcss/vite 제거 — @tailwindcss/postcss 전환 (CSS HMR full-reload 방지, tailwindlabs/tailwindcss#19903)
import { WebSocketServer } from "ws";
import { createSessionCore, verifyUserKeyFormat } from "./session-core.ts";
import { ensureAnonAccount, ANON_ACCOUNT } from "./auth.ts"; // 익명 도서관 — prod와 동일 진원
import { loadAccountEnv, setAccountEnv, deleteAccountEnvKey } from "./env-store.ts"; // env 저장소 단일 진원

/**
 * AI Turk Vite 플러그인 — 멀리 세션 (유저 키 기반)
 * 각 유저(브라우저 localStorage userKey)마다 독립 세션(백엔드 + 스케줄러) 할당.
 * 같은 유저 다중 탭 = 동일 세션 broadcast. 사생활 탭 = 다른 userKey = 다른 세션.
 * npm run dev 하나로 Vite + 백엔드 + WebSocket 모두 실행.
 *
 * 세션/WS/영속화/푸시 로직은 session-core.ts (prod server.ts와 동일 진원) —
 * 이 플러그인은 Vite 서버에 WS를 얹는 배선만 담당. (vite build 시 코어는 생성되지 않음)
 */
function turkPlugin(): Plugin {
	return {
		name: "turk-rpc",
		configureServer(server) {
			// 코어는 서버 기동 시 생성 (config 평가 시점이 아님 — build에서 VAPID/파일 건드리지 않게)
			ensureAnonAccount(); // AUTH-off — 익명 도서관 계정 보증 (prod와 동일 진원)
			// 익명 저자자 주입(261012) — env 주입 계약을 dev에서도 동일하게: 백엔드 spawn이 "local" 계정 env를 탑재.
			// 소유권은 dev 기존 계약(자유) 유지 — 구조만 Authorizer 일치 (prod server.ts와 동일 표현).
			const core = createSessionCore({ authorize: {
				authorizeRequest: async () => ANON_ACCOUNT,
				checkConversation: () => "own" as const,
				claimConversation: () => true,
				listOwnedKeys: () => [] as string[],
				accountEnv: () => loadAccountEnv(ANON_ACCOUNT),
			} });
			// noServer 모드: Vite HMR 역그레이드 핸들러와 충돌 방지
			const wss = new WebSocketServer({ noServer: true, maxPayload: 100 * 1024 * 1024 }); // 첨부 base64 프레임 수용 (50MB 파일)
			core.keepAlive(wss);
			server.httpServer!.on("upgrade", (req, socket, head) => {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname === "/ws") {
					wss.handleUpgrade(req, socket as any, head, (ws) => {
						wss.emit("connection", ws, req);
					});
				}
			});

			wss.on("connection", (ws, req) => core.handleConnection(ws, req));

			// 모델 목록 — prod server.ts와 동일 단일 진원 (dev 무인증)
			server.middlewares.use("/api/models", (_req, res) => {
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Cache-Control", "no-store");
				res.end(JSON.stringify({ models: core.getModels() }));
			});

			// 히스토리 뷰어 — GET /api/conversations/<key>/history (dev 무인증 경로 — prod server.ts의 3단 검증 대응체).
			// 기존 "/api/conversations" 마운트보다 먼저 등록: connect 마운트(/api/conversations)는 서브패스도 흡수하므로
			// 여기서 history 패턴만 소비하고 나머지는 next()로 통과시킨다.
			server.middlewares.use("/api/conversations", (req, res, next) => {
				if (req.method !== "GET" || !/^\/[^/]+\/history\/?$/.test(req.url || "")) { next(); return; } // 목록 라우트 등 — 통과
				let id = "";
				try { id = decodeURIComponent((req.url || "").replace(/^\//, "").replace(/\/history\/?$/, "")); } catch { id = ""; }
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Cache-Control", "no-store");
				if (!verifyUserKeyFormat(id)) { res.statusCode = 400; res.end(JSON.stringify({ error: "대화 키 형식이 올바르지 않습니다" })); return; }
				res.end(JSON.stringify({ turns: core.readConversationHistory(id) }));
			});

			// 1c 대화 레지스트리 — prod server.ts와 동일 단일 진원 (core.listConversations())
			server.middlewares.use("/api/conversations", (_req, res) => {
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Cache-Control", "no-cache");
				res.end(JSON.stringify(core.listConversations()));
			});

			// /api/me·/api/env — AUTH-off 계약을 dev에서도 동일 진원으로 (로컬 HMR 프리뷰에서 도서관 동작)
			server.middlewares.use("/api/me", (_req, res) => {
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Cache-Control", "no-store");
				res.end(JSON.stringify({ ok: true, auth: "off", username: ANON_ACCOUNT }));
			});
			server.middlewares.use("/api/env", (req, res) => {
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Cache-Control", "no-store");
				const body = new Promise<any>((ok) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => { try { ok(JSON.parse(b)); } catch { ok({}); } }); });
				const key = decodeURIComponent((req.url || "").replace(/^\//, ""));
				if (req.method === "GET") { res.end(JSON.stringify({ env: loadAccountEnv(ANON_ACCOUNT) })); return; }
				if (req.method === "POST") {
					body.then((j) => {
						const r = setAccountEnv(ANON_ACCOUNT, String(j?.key ?? ""), String(j?.value ?? ""));
						res.end(JSON.stringify(r.ok ? { ok: true, next: "새 대화는 시작부터 적용 · 열린 대화는 리로드하면 즉시 적용" } : { error: r.error }));
					});
					return;
				}
				if (req.method === "DELETE") { res.end(JSON.stringify(deleteAccountEnvKey(ANON_ACCOUNT, key) ? { ok: true } : { error: "삭제 실패" })); return; }
				res.statusCode = 405; res.end(JSON.stringify({ error: "허용하지 않는 메서드" }));
			});

			server.httpServer!.on("close", () => {
				core.removeAllSessions();
			});
		},
	};
}

export default defineConfig(() => {
	return {
		plugins: [react(), turkPlugin()],
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