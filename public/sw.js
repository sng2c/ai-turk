// AI Turk 서비스 워커 — Web Push 알림 수신
// 서버가 응답 완료 시 web-push로 전송 → 여기서 showNotification

// ── 설치/활성화: 즉시 활성화 보장 (갱신 즉시 적용) ──────────────────────
self.addEventListener("install", (event) => { self.skipWaiting(); event.waitUntil(Promise.resolve()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

// ── Push 이벤트: 서버가 전송한 페이로드로 알림 표시 ────────────────────────
// 포그라운드(visible 클라이언트)면 알림 안 뜸 — 보고 있으니까
self.addEventListener("push", (event) => {
	let body = "응답 완료";
	try {
		const data = event.data?.json();
		if (data?.body) {
			const raw = String(data.body);
			// body가 JSON이면 message 추출 (LLM 응답) — 아니면 원문 그대로
			try {
				const parsed = JSON.parse(raw);
				body = typeof parsed.message === "string" ? parsed.message : raw;
			} catch { body = raw; }
		}
	} catch { /* 페이로드 파싱 실패 시 기본값 */ }
	// 마크다운 제거 + 50자 트림
	body = body.replace(/[#*`_~>\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 50);

	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			// 보이는(visible) 클라이언트가 있으면 포그라운드 — 알림 안 뜸
			const visible = clientList.some((c) => c.visibilityState === "visible");
			if (visible) return;
			return self.registration.showNotification("AI-Turk", { body, icon: "/favicon.svg", tag: "ai-turk", renotify: true });
		})
	);
});

// ── 알림 클릭: 탭 열기 ────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			// 이미 열린 탭이면 포커스, 없으면 새 창
			for (const client of clientList) {
				if (client.url.includes(self.location.origin) && "focus" in client) {
					return client.focus();
				}
			}
			if (self.clients.openWindow) return self.clients.openWindow("/");
		})
	);
});