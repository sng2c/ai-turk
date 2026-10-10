// AI Turk 순수 자산 — App.tsx에서 분리된 타입/상수/순수 함수/컴포넌트.
// 의존: ReactMarkdown, remarkGfm (Md 컴포넌트), 브라우저 API (localStorage/SW/Push).
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { validateTurkResponse } from "./response-schema";
import { userTitle } from "./ukey";

// ── 응답 검증 — zod 스키마 제거, 공용 JSON Schema(response-schema.ts)로 이원화.
// 스키마가 1차 게이트(법) — 프롬프트(AGENTS.md)는 보조 교육. 위반 시 오류 문구가
// self-correction 재시도 안내문에 그대로 실려 모델이 교정하게 된다.

// ── 타입 ──────────────────────────────────────────────────────────────
export interface TurkState {
	message: string;
	buttons: Record<string, string>;
	colors?: Record<string, string>;
	textColors?: Record<string, string>;
	schedules?: any[]; // LLM 응답의 schedules 배열 (일회성 명령 — state에 저장하지 않고 즉시 서버로 전송)
	silent?: boolean; // true면 사용자에게 미표시 + 캐싱 안 함 (schedules는 처리)
	repeat?: boolean; // 스케줄 반복 여부 — false면 자동 제거, true/생략 시 유지
	answerTo?: string; // UI 주입 — 이 응답이 대답하는 입력(모델 출력 아님). 응답 상단 짝표시
}

export interface ToolStatus {
	name: string;
	args: string;
}

// ── 설정 ───────────────────────────────────────────────────────────────
// 그리드 차원(DEFAULT_ROWS/COLS)·AGENTS.md/systemPrompt 본문은
// src/lib/agents-md.ts(단일 진원)로 이전됨. 이 파일에서는 제거.
// App.tsx의 systemPrompt 주입도 AGENTS.md가 표준이므로 제거됨.


export function emptyState(rows: number, cols: number): TurkState {
	return {
		// 제목(🤖 AI Turk)은 짝박스 위치 — message에는 본문부터
		message: `**LLM 기반 동적 버튼 그리드 컨트롨러**

- ⌨️ **명령/클릭** — 원하는 기능 요청 또는 옵션 선택
- ⏰ **스케줄/알림** — 매일 정해진 시각·반복 주기로 작업 예약
- 🎨 **맞춤 UI** — 대화하며 최적의 인터페이스 생성

> 지금 바로 시작해보세요!`,
		answerTo: "🤖 AI Turk",
		buttons: Object.fromEntries(
			Array.from({ length: rows * cols }, (_, i) => [String(i), ""])
		),
	};
}

export function errState(msg: string, rows: number, cols: number): TurkState {
	const s = emptyState(rows, cols);
	s.buttons["0"] = "다시 시도";
	s.message = msg;
	return s;
}

// agent_end의 messages에서 마지막 assistant 텍스트 추출
export function extractAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant" && Array.isArray(m.content)) {
			const texts = m.content
				.filter((b: any) => b.type === "text" && b.text)
				.map((b: any) => b.text);
			if (texts.length) return texts.join("\n");
		}
	}
	return "";
}

// 텍스트에서 JSON 버튼 그리드 파싱.
// 후보(코드펜스 / 전체 블록 / 첫 '{' 부터)를 뽑아 JSON.parse 시도.
// 파싱 실패 시 모델에게 원문을 돌려주며 재시도하는 전략(self-correction)이
// 구문 보정 라이브러리보다 근본적이므로, 여기서는 가볍게만 시도한다.
// 결과: { parsed } 성공 시 | { error } 실패 시(JSON.parse 에러 메시지 보존)
export function parseTurkJSON(text: string): { parsed: TurkState } | { error: string } | null {
	// JSON 후보 추출: 코드펜스 → 전체 블록 → 첫 '{' 부터 끝까지(잘린 응답)
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates: string[] = [];
	if (fence) candidates.push(fence[1]);
	const greedy = text.match(/\{[\s\S]*\}/);
	if (greedy) candidates.push(greedy[0]);
	const firstBrace = text.indexOf("{");
	if (firstBrace !== -1) candidates.push(text.slice(firstBrace));

	let lastError = "";
	for (const raw of candidates) {
		const s = raw.trim();
		if (!s) continue;
		try {
			const obj = JSON.parse(s);
			const result = validateTurkResponse(obj);
			if (result.ok) {
				return { parsed: obj as TurkState };
			}
			lastError = result.errors ?? "schema violation"; // JSON Schema 1차 게이트 — Visible/Silent 이분법·형태 위반
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	return candidates.length ? { error: lastError } : null;
}

// ── 마크다운 간이 렌더 ────────────────────────────────────────────────
export function Md({ text }: { text: string }) {
	return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
}

// ── 알림용 텍스트 정제 (마크다운 제거 + 50자) ───────────────────────────
// ── VAPID 공개키 변환 (Base64URL → Uint8Array) ────────────────────────────
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
	const padding = "=".repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// ── 서비스 워커 등록 + Push 구독 → 서버에 전송 ──────────────────────────────
// 반환 true = push_subscribe가 소켓으로 실제 전송됨.
// 성공 즉시 localStorage 캐시("turk-push-sub")에 저장 — 이후 pi_ready에서
// 비동기 SW 대기 없이 동기 재전송할 수 있어, 앱을 1초만 켜도 등록이 유지된다.
let pushInFlight = false;
export async function ensurePush(publicKey: string, ws: WebSocket | null): Promise<boolean> {
	if (pushInFlight || !ws) return false;
	const sock = ws; // await 이후에도 non-null
	pushInFlight = true;
	try {
		if (!("serviceWorker" in navigator)) return false;
		const reg = await navigator.serviceWorker.register("/sw.js");
		const keyBytes = urlBase64ToUint8Array(publicKey);
		let sub = await reg.pushManager.getSubscription();
		// 키가 다른 옛 구독만 교체 — 같은 키면 재사용 (무조건 unsubscribe/subscribe 금지 → 등록-파기 레이스 원천 제거)
		if (sub && sub.options.applicationServerKey &&
			new Uint8Array(sub.options.applicationServerKey as ArrayBuffer).toString() !== new Uint8Array(keyBytes).toString()) {
			await sub.unsubscribe();
			sub = null;
		}
		if (!sub) {
			sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes as BufferSource });
		}
		if (sock.readyState !== WebSocket.OPEN) return false; // 산 구독은 브라우저가 보유 — 다음 pi_ready에서 재전송
		sock.send(JSON.stringify({ type: "push_subscribe", subscription: sub.toJSON() }));
		return true;
	} catch (e) { console.debug("[Push] 구독 실패:", e); return false; }
	finally { pushInFlight = false; }
}

// push_invalid (구독 무효) — 브라우저 산 구독도 이미 죽은 것이니 폐기 → 다음 pi_ready에서 신규 등록
export async function discardPush(): Promise<void> {
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		const sub = await reg?.pushManager.getSubscription();
		if (sub) await sub.unsubscribe();
	} catch { /* 무시 */ }
}

// ── non-secure context(LAN IP 등) 대응 — crypto.randomUUID가 없으면 Math.random 폴백
function uuidv4Fallback(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// ── 유저 구분키 — #뒤 값이 있으면 그 키로 세션 오버라이드(링크 공유), 없으면 발급(localStorage) userKey.
//    저장된 userKey(localStorage) = 기본값. 해시 없음 → 기본키(없으면 발급)로 초기화 + reflectUserKey로 주소창 반영.
//    런타임 hashchange → resolveUserKey() 재호출로 갱신, App.tsx가 WS 재접속하여 세션 전환.
function hashUserKey(): string | null {
	const h = location.hash.replace(/^#/, "").trim();
	if (!h) return null;
	try { return decodeURIComponent(h); } catch { return h; } // 한글 등 인코딩된 해시 → 디코드
}
function ensureLocalKey(): string {
	let k = localStorage.getItem("turk-user-key");
	if (!k) { k = crypto.randomUUID?.() ?? uuidv4Fallback(); localStorage.setItem("turk-user-key", k); }
	return k;
}
// 현재 유효 userKey 계산 — 해시(#뒤 값) 우선: 있으면 그 키, 없으면 기본키(발급/조회 localStorage).
// 해시 진입은 마지막 대화로 localStorage 기본값을 갱신 (261010) — 루트 즐겨찾기 = 최근 대화 재개.
export function resolveUserKey(): string {
	const h = hashUserKey();
	if (h) {
		try { localStorage.setItem("turk-user-key", h); } catch { /* 무시 */ } // 마지막 대화 갱신 — 부트 스크립트(index.html)와 동일 규칙
		return h; // 해시 → 그 키로 초기화
	}
	return ensureLocalKey(); // 없으면 기본키 — 발급(첫 방문) 또는 조회(=마지막 대화)
}
// 현재 userKey를 URL hash에 반영 — 멀티 userKey(탭별 #<이름> 병렬 운영)·공유(주소 복사=세션 진입).
// pushState — 진짜 히스토리 엔트리 생성. replaceState는 현재 엔트리를 몰래 고치기만 해서 브라우저가
// 즐겨찾기에 변경 전 주소를 저장하는 문제가 있었음. pushState는 hashchange를 유발하지 않으므로
// 자기 키 반영 시 재접속 루프 없음. 뒤로가기로 이전 hash 복귀는 hashchange → onHashChange가 처리(의도된 동작).
export function reflectUserKey(key: string): void {
	if (hashUserKey() === key) return;
	try { history.pushState(null, "", `#${encodeURIComponent(key)}`); } catch { /* 무시 */ }
}

// 초기값 (모듈 로드 1회) — 정적 표시/하위호환. 런타임 전환은 userKey state + resolveUserKey().
export const TURK_USER_KEY: string = resolveUserKey();

// ── 유저 식별 타이틀 반영 — 탭 제목(document.title)·iOS 북마크 타이틀 meta.
//    즐겨찾기·공유는 Chrome이 당존 탭 주소(#<userKey> 해시선반영 참조)·타이틀을 사용 —
//    manifest(A2HS) 오버라이드 기계장치는 제거됨 (설치 기능 미사용).
export function applyUserTitle(key: string): void {
	const t = userTitle(key);
	document.title = t;
	const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]') as HTMLMetaElement | null;
	if (apple) apple.content = t;
}
