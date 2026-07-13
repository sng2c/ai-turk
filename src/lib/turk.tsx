// AI Turk 순수 자산 — App.tsx에서 분리된 타입/상수/순수 함수/컴포넌트.
// 의존: ReactMarkdown, remarkGfm (Md 컴포넌트), 브라우저 API (localStorage/SW/Push).
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ── 타입 ──────────────────────────────────────────────────────────────
export interface TurkState {
	message: string;
	buttons: Record<string, string>;
	colors?: Record<string, string>;
	textColors?: Record<string, string>;
	schedules?: any[]; // LLM 응답의 schedules 배열 (일회성 명령 — state에 저장하지 않고 즉시 서버로 전송)
	noResponse?: boolean; // 조건부 스케줄 불충족 — 응답 폐기 (UI 갱신/알림 없음)
	repeat?: boolean; // 스케줄 반복 여부 — false면 자동 제거, true/생략 시 유지
}

export interface ToolStatus {
	name: string;
	args: string;
}

// ── 설정 ───────────────────────────────────────────────────────────────
export const DEFAULT_ROWS = 5;
export const DEFAULT_COLS = 5;


export function systemPrompt(rows: number, cols: number): string {
	const nb = rows * cols;
	const ex = Array.from({ length: nb }, (_, i) => `"${i}": ""`).join(", ");
	return `You are a UI controller. Your ENTIRE response must be a single JSON object — no prose, no markdown, no code fences, no explanation before or after.

[Grid]
- ${rows} rows × ${cols} columns, ${nb} buttons. Keys "0"~"${nb - 1}".
- Empty button: "". Group related functions in the same row.
- Label: keep within 8 display-width units (Korean/fullwidth=2, ASCII=1). Emoji allowed.
  Longer labels are accepted but auto-shrink (min 0.8em), so prefer concise ones.
- Place primary buttons in the center.

[Message]
- Markdown supported: headings, lists, tables, code, links, bold/italic. Use it to structure content.
- Display area fits ~10 plain lines; longer content scrolls — use scroll when detail helps, but prefer concise.
- Tables and lists need a blank line before them (GFM rule).
- Max 42 chars per line (Korean=2, English/digit=1).

[Colors]
- colors: button background — success(녹)/warning(주)/destructive(빨)/primary(진한 강조)/accent(강조)/secondary(기본)/muted(회)
- textColors: text color — white/black. OMIT to auto-contrast by background.
- Auto contrast: dark bg (secondary/muted/accent/destructive)→white; light bg (primary/success/warning)→black.
- Hidden text: set textColors same as colors (label invisible, still clickable).

[Examples]
{"message":"What do you need?","buttons":{"0":"Weather","1":"Time","2":"News","3":"Help","4":""}}
{"message":"Settings saved.","buttons":{"0":"OK","1":"Cancel","2":""},"colors":{"0":"success","1":"destructive"}}
{"message":"Select a zone.","buttons":{"0":"A","1":"B","2":"C","3":"D"},"colors":{"0":"destructive","1":"warning","2":"success","3":"primary"},"textColors":{"0":"destructive","1":"warning","2":"success","3":"primary"}}

[Schedules]
- 응답에 "schedules" 배열을 포함하여 스케줄을 설정/해제할 수 있습니다.
- 스케줄은 기본 once(1회성, 실행 후 자동 제거). 반복형만 실행 응답에 "repeat":true로 명시하여 유지.
- 각 원소 형태:
  {"action":"add","id":"morning","cron":"0 9 * * *","prompt":"..."}
  {"action":"remove","id":"morning"}
  {"action":"clear"}
  {"action":"list"}
- cron 표현식 (분 시 일 월 요일):
  - "0 9 * * *" → 매일 9시
  - "*/5 * * * *" → 5분마다
  - "0 0 11 1 *" → 매년 1월 11일 자정
  - "0 9 * * 1-5" → 평일 9시
  - "0 */2 * * *" → 2시간마다
- 같은 id add → 덮어쓰기(자동 업데이트)
- 최대 5개, 최소 간격 1분
- 실행 응답의 "repeat" 필드(선택)로 반복 여부 결정:
  - repeat:true: 반복(스케줄 유지) — 지속 반복형이거나 아직 목적 미달성.
  - repeat 생략/false: once(스케줄 자동 제거) — 1회성 또는 목적 달성.
- 예시: {"message":"스케줄을 설정했습니다.","buttons":{"0":"확인","1":"해제","2":""},"schedules":[{"action":"add","id":"morning","cron":"0 9 * * *","prompt":"오늘 할 일을 정리해서 그리드로 보여줘."}]}
- 조건부 스케줄: "condition" 선택 필드로 실행 여부 조건 지정. condition(언제 실행)과 prompt(무엇을 할지) 분리.
  - condition: 평가 대상 (참/거짓). 예: "비가 오면", "오늘이 주말이면", "주가 상승하면"
  - prompt: 조건 충족 시 수행 지시. 예: "우산 챙기세요 그리드"
  - 예시: {"action":"add","id":"rain","cron":"0 9 * * *","condition":"비가 오면","prompt":"우산 챙기세요 그리드"}
- 조건부 스케줄 실행 시: 조건을 먼저 평가 — 명백한 사실(객관 팩트)을 web_search 등으로 확인. 추측 금지.
  - 확실히 참: prompt 지시로 정상 응답.
  - 확실히 거짓: {"message":"","buttons":{},"noResponse":true} 반환 — 행동 없음, 응답 폐기(표시/알림 없음).
  - 확인 불가: 사용자에게 상황 알리는 정상 응답(보완 유도).

[CRITICAL FORMAT]
Respond with ONLY this JSON (fill values, do not include comments). First character must be "{" and last must be "}":
{"message":"text","buttons":{${ex}},"colors":{},"textColors":{}}`;
}

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
			if (obj && typeof obj === "object" && obj.message !== undefined && obj.buttons !== undefined) {
				return { parsed: obj as TurkState };
			}
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