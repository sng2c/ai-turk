// AI Turk 서비스 워커 — Web Push 알림 수신
// 서버가 WS 끊김 시 web-push로 전송 → 여기서 showNotification

// ── Push 이벤트: 서버가 전송한 페이로드로 알림 표시 ────────────────────────
self.addEventListener("push", (event) => {
	let body = "응답 완료";
	try {
		const data = event.data?.json();
		if (data?.body) body = String(data.body);
	} catch { /* 페이로드 파싱 실패 시 기본값 */ }

	event.waitUntil(
		self.registration.showNotification("AI-Turk", { body, icon: "/favicon.svg" })
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