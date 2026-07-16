// AI Turk 서비스 워커 — Web Push 알림 수신 + IndexedDB 응답 저장
// 서버가 응답 완료 시 web-push로 전송 → 여기서 showNotification + DB 저장

// ── IndexedDB 헬퍼 (App.tsx와 동일한 DB/스토어) ──────────────────────────
const DB_NAME = "ai-turk";
const DB_VERSION = 1;
const STORE = "kv";

function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function kvSet(key: string, value: string): Promise<void> {
	const db = await openDB();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put(value, key);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

// ── 설치/활성화: 즉시 활성화 보장 (갱신 즉시 적용) ──────────────────────
self.addEventListener("install", (event) => { self.skipWaiting(); event.waitUntil(Promise.resolve()); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });

// ── Push 이벤트: 서버가 전송한 페이로드로 알림 표시 + IndexedDB 저장 ────
// 포그라운드(visible 클라이언트)면 알림 안 뜸 — 보고 있으니까
self.addEventListener("push", (event) => {
	let body = "응답 완료";
	let rawBody = ""; // 전체 응답 (DB 저장용)
	let sessionId = "";
	try {
		const data = event.data?.json();
		if (data?.body) {
			rawBody = String(data.body);
			// body가 JSON이면 message + sessionId 추출 — 아니면 원문 그대로
			try {
				const parsed = JSON.parse(rawBody);
				body = typeof parsed.message === "string" ? parsed.message : rawBody;
				if (parsed.sessionId) sessionId = parsed.sessionId;
			} catch { body = rawBody; }
		}
	} catch { /* 페이로드 파싱 실패 시 기본값 */ }
	// 마크다운 제거 + 50자 트림 (알림용)
	const notificationBody = body.replace(/[#*`_~>\-]/g, "").replace(/\s+/g, " ").trim().slice(0, 50);

	// IndexedDB에 응답 저장 — 백그라운드에서도 즉시 저장됨
	const savePromise = (async () => {
		if (rawBody && sessionId) {
			try { await kvSet(`${sessionId}:last-response`, rawBody); } catch (e) { console.error("[sw] IndexedDB 저장 실패:", e); }
		}
	})();

	event.waitUntil(
		Promise.all([
			savePromise,
			self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
				// 보이는(visible) 클라이언트가 있으면 포그라운드 — 알림 안 뜸
				const visible = clientList.some((c) => c.visibilityState === "visible");
				if (visible) return;
				return self.registration.showNotification("AI-Turk", { body: notificationBody, icon: "/favicon.svg", tag: "ai-turk", renotify: true });
			}),
		])
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