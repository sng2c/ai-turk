// AI Turk 순수 자산 — App.tsx에서 분리된 타입/상수/순수 함수/컴포넌트.
// 의존: ReactMarkdown, remarkGfm (Md 컴포넌트), 브라우저 API (localStorage/SW/Push).
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";

// ── zod 스키마 (LLM 응답 검증) ─────────────────────────────────────
const ScheduleSchema = z.object({
	action: z.enum(["add", "remove", "clear", "list"]),
	id: z.string().optional(),
	when: z.string().optional(),
	prompt: z.string().optional(),
	condition: z.string().optional(),
}).superRefine((data, ctx) => {
	if (data.action === "add") {
		if (!data.id) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "add requires id", path: ["id"] });
		if (!data.when) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "add requires when", path: ["when"] });
		if (!data.prompt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "add requires prompt", path: ["prompt"] });
	}
	if (data.action === "remove" && !data.id) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: "remove requires id", path: ["id"] });
	}
});

export const TurkStateSchema = z.object({
	message: z.string(),
	buttons: z.record(z.string(), z.string()),
	colors: z.record(z.string(), z.string()).optional(),
	textColors: z.record(z.string(), z.string()).optional(),
	schedules: z.array(ScheduleSchema).optional(),
	silent: z.boolean().optional(),
	repeat: z.boolean().optional(),
});

// ── 타입 ──────────────────────────────────────────────────────────────
export interface TurkState {
	message: string;
	buttons: Record<string, string>;
	colors?: Record<string, string>;
	textColors?: Record<string, string>;
	schedules?: any[]; // LLM 응답의 schedules 배열 (일회성 명령 — state에 저장하지 않고 즉시 서버로 전송)
	silent?: boolean; // true면 사용자에게 미표시 + 캐싱 안 함 (schedules는 처리)
	repeat?: boolean; // 스케줄 반복 여부 — false면 자동 제거, true/생략 시 유지
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
		message: `# 🤖 AI Turk

**LLM 기반 동적 버튼 그리드 컨트롤러**

- ⌨️ **명령/클릭** — 원하는 기능 요청 또는 옵션 선택
- ⏰ **스케줄/알림** — 매일 정해진 시각·반복 주기로 작업 예약
- 🎨 **맞춤 UI** — 대화하며 최적의 인터페이스 생성

> 지금 바로 시작해보세요!`,
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
			const result = TurkStateSchema.safeParse(obj);
			if (result.success) {
				return { parsed: result.data as TurkState };
			}
			lastError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
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
export async function subscribePush(publicKey: string, ws: WebSocket | null): Promise<void> {
	if (!("serviceWorker" in navigator) || !ws || ws.readyState !== WebSocket.OPEN) return;
	try {
		const reg = await navigator.serviceWorker.register("/sw.js");
		// 기존 구독이 있으면 해제 (서버 재시작으로 VAPID 키 변경 대응)
		const existing = await reg.pushManager.getSubscription();
		if (existing) await existing.unsubscribe();
		const subscription = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
		});
		ws.send(JSON.stringify({ type: "push_subscribe", subscription: subscription.toJSON() }));
	} catch (e) { console.debug("[Push] 구독 실패:", e); }
}

// ── non-secure context(LAN IP 등) 대응 — crypto.randomUUID가 없으면 Math.random 폴백
function uuidv4Fallback(): string {
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

// ── 유저 구분키 — 브라우저(localStorage) 고유 ID. 사생활 탭 = 다른 키 = 다른 세션.
export const TURK_USER_KEY: string = (() => {
	let k = localStorage.getItem("turk-user-key");
	if (!k) { k = crypto.randomUUID?.() ?? uuidv4Fallback(); localStorage.setItem("turk-user-key", k); }
	return k;
})();