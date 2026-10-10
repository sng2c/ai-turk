// AI Turk 서비스 워커 — Web Push 알림 수신
// 서버가 응답 완료 시 web-push로 전송 → showNotification만 수행 (데이터 저장 없음 — 복원은 서버 lastResponse 담당)
// 페이로드에 userKey 명시 (server.ts sendPushNotification) — tag·제목·포그라운드 억제·클릭 포커스를
// userKey별로 구분 (탭별 멀티 userKey 병렬 운영에서 키 간 알림 치환·삼킴 방지).
// 폴백: userKey 없는 구형 페이로드는 url 해시에서 역추출.

// ── 공용 유틸 ──────────────────────────────────────────────────────────────
// url 해시("/#<userKey>")에서 userKey 추출 — 해시 없으면 ""
function keyFromUrl(u) {
	if (!u) return "";
	try {
		const h = new URL(u, self.location.origin).hash.replace(/^#/, "");
		return h ? decodeURIComponent(h) : "";
	} catch { return ""; }
}
// src/lib/ukey.ts shortUserKey 복제 — UUID형은 첫 8자, 사용자 지정 해시명("mom" 등)은 그대로
function shortUserKey(key) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key) ? key.slice(0, 8) : key;
}

// ── 설치/활성화: 즉시 활성화 보장 (갱신 즉시 적용) ──────────────────────
self.addEventListener("install", (event) => { self.skipWaiting(); event.waitUntil(Promise.resolve()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

// ── Push 이벤트: 서버가 전송한 페이로드로 알림 표시 ────
// "같은 userKey"를 보이는(visible) 클라이언트가 볼 때만 억제 — 내가 보고 있는 세션 알림은 조용히,
// 다른 userKey의 푸시는 별도 창으로 뜸 (키 간 억제 삼킴 방지)
self.addEventListener("push", (event) => {
	const data = event.data?.json() ?? {};
	let body = "응답 완료";
	if (data?.body) {
		const rawBody = String(data.body);
		// body가 JSON이면 message 추출 — 아니면 원문 그대로 (알림 문구용)
		try {
			const parsed = JSON.parse(rawBody);
			body = typeof parsed.message === "string" ? parsed.message : rawBody;
		} catch { body = rawBody; }
	}
	// 마크다운 제거 + 50자 트림 (알림용)
	const notificationBody = body.replace(/[#*`_~>\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 50);
	// 딥링크 — 서버가 userKey 해시 경로(/#<userKey>)를 담아 보냄 → 알림 클릭 시 해당 세션으로 복귀
	const url = data.url || "/";
	// userKey — 서버 명시 필드 우선, 없으면 url 해시 역추출 (구형 페이로드 호환)
	const userKey = typeof data.userKey === "string" && data.userKey ? data.userKey : keyFromUrl(data.url);
	// userKey 구분 — tag는 키별 독립 슬롯(치환 방식 — 이름변경에도 슬롯 지속성).
	// 제목: 대화 별명(title) 우선 (261010 — 첫 프롬프트 30자·드로어 이름변경), 없으면 키 표기로 폴백 (구형 페이로드 호환)
	const title = data.title ? `AI Turk · ${data.title}` : userKey ? `AI Turk #${shortUserKey(userKey)}` : "AI-Turk";
	const tag = userKey ? `ai-turk-${userKey}` : "ai-turk";

	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			// 보이는(visible) 클라이언트 중 "같은 userKey" 탭이 있을 때만 억제
			const visibleSameKey = clientList.some((c) => c.visibilityState === "visible" && keyFromUrl(c.url) === userKey);
			if (visibleSameKey) return;
			return self.registration.showNotification(title, { body: notificationBody, icon: "/push-icon.png", badge: "/push-badge.png", tag, renotify: true, data: { url, userKey } });
		})
	);
});

// ── 알림 클릭: 탭 열기 ────────────────────────────────────────────────────
// 해시 정확 비교 — 같은 userKey 탭만 포커스 (includes("/#mom")가 /#mom2 탭을 잘못 잡던 문제 수정)
self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const url = event.notification.data?.url || "/";
	const target = keyFromUrl(url);
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
			for (const client of clientList) {
				if (keyFromUrl(client.url) === target && "focus" in client) {
					return client.focus();
				}
			}
			if (self.clients.openWindow) return self.clients.openWindow(url);
		})
	);
});