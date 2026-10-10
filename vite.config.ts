import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @tailwindcss/vite 제거 — @tailwindcss/postcss 전환 (CSS HMR full-reload 방지, tailwindlabs/tailwindcss#19903)
import { WebSocketServer } from "ws";
import { createSessionCore } from "./session-core.ts";

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
			const core = createSessionCore();
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