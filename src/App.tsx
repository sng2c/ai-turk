import { useState, useCallback, useRef, useEffect, Component, type ReactNode } from "react";
import { Bot, ChevronUp, ChevronDown, Sparkles, Wrench } from "lucide-react";

// ── 에러 바운더리 (하얀 화면 방지) ──────────────────────────────────────
export class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
	state = { hasError: false };
	static getDerivedStateFromError() { return { hasError: true }; }
	render() {
		if (this.state.hasError) {
			return (
				<div style={{ padding: 20, color: "#e6edf3", background: "#0e1117", minHeight: "100dvh", fontFamily: "sans-serif" }}>
					<p>⚠️ 렌더링 오류 발생</p>
					<button onClick={() => location.reload()} style={{ marginTop: 8, padding: "6px 16px", cursor: "pointer" }}>새로고침</button>
				</div>
			);
		}
		return this.props.children;
	}
}

// ── 타입 ──────────────────────────────────────────────────────────────
interface TurkState {
	message: string;
	buttons: Record<string, string>;
	colors?: Record<string, string>;
	textColors?: Record<string, string>;
}

interface ToolStatus {
	name: string;
	args: string;
}

// ── 설정 ───────────────────────────────────────────────────────────────
const DEFAULT_ROWS = 5;
const DEFAULT_COLS = 5;


function systemPrompt(rows: number, cols: number): string {
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
- Up to 10 lines fit on screen; prefer fewer for clarity.
- Max 42 chars per line (Korean=2, English/digit=1).
- Markdown supported.

[Colors]
- colors: button background — success(녹)/warning(주)/destructive(빨)/primary(진한 강조)/accent(강조)/secondary(기본)/muted(회)
- textColors: text color — white/black. OMIT to auto-contrast by background.
- Auto contrast: dark bg (secondary/muted/accent/destructive)→white; light bg (primary/success/warning)→black.
- Hidden text: set textColors same as colors (label invisible, still clickable).

[Examples]
{"message":"What do you need?","buttons":{"0":"Weather","1":"Time","2":"News","3":"Help","4":""}}
{"message":"Settings saved.","buttons":{"0":"OK","1":"Cancel","2":""},"colors":{"0":"success","1":"destructive"}}
{"message":"Select a zone.","buttons":{"0":"A","1":"B","2":"C","3":"D"},"colors":{"0":"destructive","1":"warning","2":"success","3":"primary"},"textColors":{"0":"destructive","1":"warning","2":"success","3":"primary"}}

[CRITICAL FORMAT]
Respond with ONLY this JSON (fill values, do not include comments). First character must be "{" and last must be "}":
{"message":"text","buttons":{${ex}},"colors":{},"textColors":{}}`;
}

function emptyState(rows: number, cols: number): TurkState {
	return {
		message: `기계 튀르크에 오신 것을 환영합니다.\n저는 LLM으로 버튼 그리드를 생성합니다.\n명령을 입력하거나 버튼을 눌러주세요.\n대화하며 원하는 기능을 찾아드립니다.\n지금 바로 시작해보세요!`,
		buttons: Object.fromEntries(
			Array.from({ length: rows * cols }, (_, i) => [String(i), ""])
		),
	};
}

function errState(msg: string, rows: number, cols: number): TurkState {
	const s = emptyState(rows, cols);
	s.buttons["0"] = "다시 시도";
	s.message = msg;
	return s;
}

// agent_end의 messages에서 마지막 assistant 텍스트 추출
function extractAssistantText(messages: any[]): string {
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
function parseTurkJSON(text: string): TurkState | null {
	// JSON 후보 추출: 코드펜스 → 전체 블록 → 첫 '{' 부터 끝까지(잘린 응답)
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const candidates: string[] = [];
	if (fence) candidates.push(fence[1]);
	const greedy = text.match(/\{[\s\S]*\}/);
	if (greedy) candidates.push(greedy[0]);
	const firstBrace = text.indexOf("{");
	if (firstBrace !== -1) candidates.push(text.slice(firstBrace));

	for (const raw of candidates) {
		const s = raw.trim();
		if (!s) continue;
		try {
			const obj = JSON.parse(s);
			if (obj && typeof obj === "object" && obj.message !== undefined && obj.buttons !== undefined) {
				return obj as TurkState;
			}
		} catch { /* 다음 후보 시도 */ }
	}
	return null;
}

// ── 마크다운 간이 렌더 ────────────────────────────────────────────────
function Md({ text }: { text: string }) {
	const html = text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/`(.+?)`/g, "<code>$1</code>")
		.replace(/\n/g, "<br/>");
	return <span dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── 앱 ─────────────────────────────────────────────────────────────────
export default function App() {
	const rows = DEFAULT_ROWS;
	const cols = DEFAULT_COLS;
	const [state, setState] = useState<TurkState>(emptyState(DEFAULT_ROWS, DEFAULT_COLS));
	const [loading, setLoading] = useState(false);
	const [input, setInput] = useState("");

	// WebSocket 상태
	const [connected, setConnected] = useState(false);
	const [piReady, setPiReady] = useState(false);
	const [backendKind, setBackendKind] = useState<string>("pi");
	const [, setSessionId] = useState("");
	const [currentModel, setCurrentModel] = useState("");
	const currentModelRef = useRef("");
	currentModelRef.current = currentModel;

	// 씽킹 레벨 (기본 off) — 모델이 지원하는 레벨만 순환 (cycle_thinking_level)
	const [thinkingLevel, setThinkingLevel] = useState<string>("off");
	const [contextPct, setContextPct] = useState<number | null>(null);
	const thinkingLevelRef = useRef("off");
	thinkingLevelRef.current = thinkingLevel;
	// OFF 순환 감지용: 첫 켜진 레벨(firstLevel)에 다시 도달하면 OFF로
	const firstThinkingLevelRef = useRef<string | null>(null);
	const thinkingCycleHitsRef = useRef(0);
	const THINKING_LABEL: Record<string, string> = { off: "OFF", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" };
	const THINKING_COLOR: Record<string, string> = { off: "var(--muted-foreground)", low: "var(--success)", medium: "#06b6d4", high: "var(--warning)", xhigh: "var(--destructive)" };

	// 스트리밍 상태 (내부 추적용 — UI에 직접 표시하지 않음)
	const [, setStreamingText] = useState("");
	const [, setThinkingText] = useState("");
	const [showThinking, setShowThinking] = useState(false);
	const [, setThinkingExpanded] = useState(false);
	const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
	const [keyboardUp, setKeyboardUp] = useState(false);
	const [kbHeight, setKbHeight] = useState(0);


	// 세션 초기화 추적
	const sessionInitRef = useRef(false);
	// 스트리밍 텍스트 누적 (agent_end의 messages가 비었거나 잘렸을 때 fallback용)
	const streamingTextRef = useRef("");
	// 파싱 실패 시 자가 수정 재시도 카운터 (무한 루프 방지)
	const retryCountRef = useRef(0);
	const MAX_PARSE_RETRIES = 2;

	// 메시지 박스 스크롤 — 출력 업데이트 시 맨 위로, 스크롤 포지션에 따라 화살표 표시
	const messageRef = useRef<HTMLDivElement | null>(null);
	const dragState = useRef<{ active: boolean; moved: boolean; lastY: number; velocity: number; lastTime: number }>({ active: false, moved: false, lastY: 0, velocity: 0, lastTime: 0 });
	const inertiaRef = useRef<number | null>(null);
	const [canScrollUp, setCanScrollUp] = useState(false);
	const [canScrollDown, setCanScrollDown] = useState(false);

	const updateScrollArrows = useCallback(() => {
		const el = messageRef.current;
		if (!el) return;
		setCanScrollUp(el.scrollTop > 2);
		setCanScrollDown(el.scrollTop + el.clientHeight < el.scrollHeight - 2);
	}, []);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const shouldReconnect = useRef(true);
	const showSessionDetail = useRef(false);
	const modelMode = useRef(false);
	// 모델 선택 진입 전 UI 상태(이전 메시지/버튼) 저장용
	const prevStateRef = useRef<TurkState | null>(null);
	const availableModels = useRef<any[]>([]);
	const modelPage = useRef(0);
	const MODELS_PER_PAGE = DEFAULT_ROWS * DEFAULT_COLS - 3; // 22 (나머지 3칸은 이전/다음/취소)
	const reconnectDelay = useRef(1000);
	const gridRef = useRef({ rows: DEFAULT_ROWS, cols: DEFAULT_COLS });
	gridRef.current = { rows, cols };

	// handleEvent stale closure 방지: 항상 최신 콜백 참조
	const handleEventRef = useRef<(msg: any) => void>(() => {});

	// ── WebSocket 연결 ──────────────────────────────────────────────────
	const connect = useCallback(() => {
		const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;
		shouldReconnect.current = true;

		ws.onopen = () => { setConnected(true); reconnectDelay.current = 1000; };

		ws.onclose = (ev) => {
			setConnected(false);
			setPiReady(false);
			if (shouldReconnect.current) {
				console.debug(`[WS] 종료 code=${ev.code} — ${reconnectDelay.current}ms 후 재연결`);
				reconnectTimer.current = setTimeout(connect, reconnectDelay.current);
				reconnectDelay.current = Math.min(reconnectDelay.current * 2, 10000);
			}
		};

		ws.onerror = () => ws.close();

		ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(ev.data);
				handleEventRef.current(msg);
			} catch (e) {
				console.error("메시지 파싱 오류:", e);
			}
		};
	}, []);

	useEffect(() => {
		connect();
		return () => {
			shouldReconnect.current = false;
			clearTimeout(reconnectTimer.current);
			wsRef.current?.close();
		};
	}, [connect]);

	// ── pi 이벤트 처리 ──────────────────────────────────────────────────
	const handleEvent = useCallback((msg: any) => {
		switch (msg.type) {
			case "pi_ready":
				setPiReady(true);
				if (typeof msg.backend === "string") setBackendKind(msg.backend);
				wsRef.current?.send(JSON.stringify({ type: "get_state" }));
				wsRef.current?.send(JSON.stringify({ type: "get_last_assistant_text" }));
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				break;
			case "pi_starting":
				setPiReady(false);
				break;
			case "pi_exit":
				setPiReady(false);
				if (loading) {
					setState(errState("pi 프로세스 종료됨", gridRef.current.rows, gridRef.current.cols));
					setLoading(false);
				}
				break;
			case "pi_error":
				setState(errState(`pi 오류: ${msg.message}`, gridRef.current.rows, gridRef.current.cols));
				break;

			case "agent_start":
				setLoading(true);
				setStreamingText("");
				streamingTextRef.current = "";
				setThinkingText("");
				setShowThinking(false);
				setThinkingExpanded(false);
				setToolStatus(null);
				break;

			case "agent_end": {
				// willRetry가 true면 곧 재시도할 예정 — 아직 최종 응답이 아님. 로딩 유지.
				if (msg.willRetry) {
					break;
				}
				setLoading(false);
				setInput("");
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				setToolStatus(null);
				setShowThinking(false);
				setThinkingText("");
				// 1차: agent_end의 messages에서 텍스트 추출
				let text = msg.messages?.length ? extractAssistantText(msg.messages) : "";
				// 2차(fallback): messages가 비었거나 파싱 실패 시 스트리밍 누적본 사용
				if (!text) text = streamingTextRef.current;
				if (text) {
					const parsed = parseTurkJSON(text);
					if (parsed) {
						retryCountRef.current = 0; // 성공 시 카운터 리셋
						setState(parsed);
					} else {
						// 스트리밍본으로 한 번 더 시도 (messages가 잘렸을 수 있음)
						const fallback = streamingTextRef.current && streamingTextRef.current !== text
							? parseTurkJSON(streamingTextRef.current)
							: null;
						if (fallback) {
							retryCountRef.current = 0;
							setState(fallback);
						} else if (retryCountRef.current < MAX_PARSE_RETRIES) {
							// 자가 수정 재시도: 원문을 모델에게 돌려주며 JSON 형식 재요청
							retryCountRef.current++;
							setLoading(true);
							const retry = `지난 응답이 올바른 JSON 형식이 아니에습니다. 다음 원문을 참고하여, 동일한 내용으로 올바른 JSON 버튼 그리드 하나만 다시 출력하세요. 원문 외 설명/코드펜스 금지.\n\n[잘못된 응답]\n${text.slice(0, 800)}`;
							wsRef.current?.send(JSON.stringify({ type: "prompt", message: retry }));
						} else {
							retryCountRef.current = 0;
							setState(errState(`[파싱실패] ${text.slice(0, 200)}`, gridRef.current.rows, gridRef.current.cols));
						}
					}
				} else if (!loading) {
					// 응답 텍스트 자체가 없는 경우 (도구만 사용 등)
					setState(errState("응답이 비어 있습니다. 다시 시도해주세요.", gridRef.current.rows, gridRef.current.cols));
				}
				break;
			}

			case "message_update": {
				const delta = msg.assistantMessageEvent;
				if (!delta) break;
				if (delta.type === "thinking_start") {
					setShowThinking(true);
				} else if (delta.type === "thinking_delta") {
					setThinkingText((prev) => prev + (delta.delta || ""));
				} else if (delta.type === "text_delta") {
					streamingTextRef.current += (delta.delta || "");
					setStreamingText((prev) => prev + (delta.delta || ""));
				}
				break;
			}

			case "tool_execution_start":
				setToolStatus({
					name: msg.toolName || "도구",
					args: typeof msg.args === "string" ? msg.args : JSON.stringify(msg.args || {}).slice(0, 80),
				});
				break;

			case "tool_execution_end":
				setToolStatus(null);
				break;

			case "response":
				if (msg.command === "new_session" && msg.success) {
					wsRef.current?.send(JSON.stringify({ type: "get_state" }));
					wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				}
				if (msg.command === "get_last_assistant_text" && msg.success && msg.data?.text) {
					const parsed = parseTurkJSON(msg.data.text);
					if (parsed) setState(parsed);
					// 주의: 여기서 sessionInitRef를 true로 하지 않음.
					// 기존 대화 복원 시에도 다음 사용자 프롬프트에 시스템 지시가
					// 다시 붙도록 두어야 JSON 형식이 유지됨.
				}
				if (msg.command === "get_state" && msg.success && msg.data) {
					if (msg.data.sessionId) setSessionId(msg.data.sessionId);
					if (msg.data.model) { const m = msg.data.model; setCurrentModel(m.provider ? `${m.provider}/${m.name || m.id}` : (m.name || m.id || "")); }
					if (msg.data.thinkingLevel !== undefined) {
					setThinkingLevel(msg.data.thinkingLevel);
					if (msg.data.thinkingLevel === "off") {
						firstThinkingLevelRef.current = null;
						thinkingCycleHitsRef.current = 0;
					}
				}
					if (showSessionDetail.current) {
						const d = msg.data;
						const info = [
							`**세션 ID**: ${d.sessionId ?? "—"}`,
							`**세션명**: ${d.sessionName ?? "—"}`,
							`**모델**: ${d.model?.name ?? d.model?.id ?? "—"}`,
							`**메시지 수**: ${d.messageCount ?? 0}`,
							`**사고 레벨**: ${d.thinkingLevel ?? "—"}`,
							`**스트리밍**: ${d.isStreaming ? "예" : "아니오"}`,
						].join("\n");
						setState((s) => ({ message: info, buttons: s.buttons }));
						showSessionDetail.current = false;
					}
				}
				if (msg.command === "set_model" && msg.success) {
					// 모델 변경 후 헤더 모델명 갱신
					wsRef.current?.send(JSON.stringify({ type: "get_state" }));
				}
				if (msg.command === "set_thinking_level" && msg.success) {
					wsRef.current?.send(JSON.stringify({ type: "get_state" }));
				}
				if (msg.command === "cycle_thinking_level" && msg.success) {
					const level = msg.data?.level ?? "off";
					if (level === "off") {
						setThinkingLevel("off");
						firstThinkingLevelRef.current = null;
						thinkingCycleHitsRef.current = 0;
					} else {
						if (firstThinkingLevelRef.current === null) {
							firstThinkingLevelRef.current = level;
							thinkingCycleHitsRef.current = 1;
						} else if (firstThinkingLevelRef.current === level) {
							thinkingCycleHitsRef.current++;
						}
						setThinkingLevel(level);
					}
				}
				if (msg.command === "get_session_stats" && msg.success && msg.data?.contextUsage?.percent != null) {
					setContextPct(msg.data.contextUsage.percent);
				}
				if (msg.command === "get_available_models" && msg.success && msg.data?.models) {
						availableModels.current = msg.data.models;
					modelPage.current = 0;
					renderModelGrid();
				}
				break;

			case "extension_ui_request":
				// 간단 처리: confirm/confirm은 기본값, input/select는 취소
				if (wsRef.current?.readyState === WebSocket.OPEN) {
					const resp: any = { type: "extension_ui_response", id: msg.id };
					if (msg.method === "confirm") resp.confirmed = false;
					else resp.cancelled = true;
					wsRef.current.send(JSON.stringify(resp));
				}
				break;
		}
	}, [loading]);

	// ref 동기화 — 항상 최신 handleEvent 유지
	handleEventRef.current = handleEvent;

	// 출력 업데이트 시 스크롤 맨 위로 초기화 + 화살표 갱신
	useEffect(() => {
		const el = messageRef.current;
		if (el) {
			el.scrollTop = 0;
			// DOM 갱신 후 화살표 여부 계산
			requestAnimationFrame(updateScrollArrows);
		}
	}, [state.message, loading, updateScrollArrows]);

	// 가상 키보드 감지 → 버튼 영역 숨김
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const onResize = () => { const kb = Math.max(0, window.innerHeight - vv.height); setKbHeight(kb); setKeyboardUp(kb > 100); };
		onResize();
		vv.addEventListener("resize", onResize);
		vv.addEventListener("scroll", onResize);
		return () => { vv.removeEventListener("resize", onResize); vv.removeEventListener("scroll", onResize); };
	}, []);

	// 화면 아무데나 위/아래 드래그 → 출력창 스크롤 + 플릭 시 관성 (입력창/메시지박스 내부는 제외)
	useEffect(() => {
		const startInertia = () => {
			const decay = () => {
				const el = messageRef.current;
				if (!el) { inertiaRef.current = null; return; }
				// velocity 단위: px/ms, 16ms 프레임당 이동
				el.scrollTop += dragState.current.velocity * 16;
				dragState.current.velocity *= 0.92; // 프레임당 감쇠
				updateScrollArrows();
				if (Math.abs(dragState.current.velocity) < 0.02) { inertiaRef.current = null; return; }
				inertiaRef.current = requestAnimationFrame(decay);
			};
			inertiaRef.current = requestAnimationFrame(decay);
		};
		const onTouchStart = (e: TouchEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("input, textarea, .turk-message")) return;
			// 새 터치 시 기존 관성 취소
			if (inertiaRef.current !== null) { cancelAnimationFrame(inertiaRef.current); inertiaRef.current = null; }
			const now = performance.now();
			dragState.current = { active: true, moved: false, lastY: e.touches[0]?.clientY ?? 0, velocity: 0, lastTime: now };
		};
		const onTouchMove = (e: TouchEvent) => {
			if (!dragState.current.active) return;
			const y = e.touches[0]?.clientY ?? 0;
			const dy = dragState.current.lastY - y;
			// 드래그 시작 감지: 일정 거리 이상 이동 시 스크롤 모드 진입 (짧은 탭은 클릭 유지)
			if (!dragState.current.moved && Math.abs(dy) < 8) return;
			dragState.current.moved = true;
			const el = messageRef.current;
			if (el) {
				el.scrollTop += dy;
				const now = performance.now();
				const dt = now - dragState.current.lastTime;
				if (dt > 0) {
					// 순간 속도(px/ms) — 이동평균으로 부드럽게
					const inst = dy / dt;
					dragState.current.velocity = dragState.current.velocity * 0.6 + inst * 0.4;
				}
				dragState.current.lastY = y;
				dragState.current.lastTime = now;
				updateScrollArrows();
			}
			e.preventDefault();
		};
		const onTouchEnd = (e: TouchEvent) => {
			if (dragState.current.moved) {
				e.preventDefault(); // 클릭 차단
				// 충분한 속도면 관성 스크롤 시작
				if (Math.abs(dragState.current.velocity) > 0.05) startInertia();
			}
			dragState.current.active = false;
			dragState.current.moved = false;
		};
		window.addEventListener("touchstart", onTouchStart, { passive: true });
		window.addEventListener("touchmove", onTouchMove, { passive: false });
		window.addEventListener("touchend", onTouchEnd, { passive: false });
		// 마우스 휠/트랙패드 스크롤도 화면 어디서나 출력창에 연동
		const onWheel = (e: WheelEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("input, textarea")) return; // 입력창은 자체 스크롤 유지
			const el = messageRef.current;
			if (!el) return;
			el.scrollTop += e.deltaY;
			updateScrollArrows();
			e.preventDefault();
		};
		window.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			window.removeEventListener("touchstart", onTouchStart);
			window.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("touchend", onTouchEnd);
			window.removeEventListener("touchcancel", onTouchEnd);
			window.removeEventListener("wheel", onWheel);
			if (inertiaRef.current !== null) cancelAnimationFrame(inertiaRef.current);
		};
	}, [updateScrollArrows]);

	// ── 모델 그리드 렌더 ───────────────────────────────────────────────
	const renderModelGrid = () => {
		const models = availableModels.current;
		const page = modelPage.current;
		const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
		const start = page * MODELS_PER_PAGE;
		const pageModels = models.slice(start, start + MODELS_PER_PAGE);
		const buttons: Record<string, string> = {};
		const colors: Record<string, string> = {};
		const textColors: Record<string, string> = {};
		pageModels.forEach((m: any, i: number) => {
			buttons[String(i)] = `${m.provider}/${m.name || m.id}`;
			// 현재 모델은 배경 강조
			if (`${m.provider}/${m.name || m.id}` === currentModelRef.current) {
				colors[String(i)] = "primary";
			}
		});
		for (let i = pageModels.length; i < MODELS_PER_PAGE; i++) {
			buttons[String(i)] = "";
		}
		// 이전/다음/취소 버튼
		buttons[String(MODELS_PER_PAGE)] = page > 0 ? "←이전" : "";
		buttons[String(MODELS_PER_PAGE + 1)] = page < totalPages - 1 ? "다음→" : "";
		buttons[String(MODELS_PER_PAGE + 2)] = "취소";
		colors[String(MODELS_PER_PAGE + 2)] = "destructive";
		textColors[String(MODELS_PER_PAGE + 2)] = "white";
		modelMode.current = true;
		setState({ message: `현재 모델: ${currentModelRef.current || "—"}\n페이지 ${page + 1}/${totalPages} — 모델을 선택하세요.`, buttons, colors, textColors });
	};

	// ── 프롬프트 전송 ───────────────────────────────────────────────────
	const sendPrompt = useCallback((userText: string) => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !piReady) return;

		const { rows: r, cols: c } = gridRef.current;
		let message = userText;

		// 항상 시스템 지시를 사용자 메시지에 포함하여 JSON 형식 강제.
		// 대화가 길어져도 매 턴마다 형식을 상기시켜 파싱 실패 방지.
		if (!modelMode.current) {
			message = `${systemPrompt(r, c)}\n\n${userText}`;
		}

		ws.send(JSON.stringify({ type: "prompt", message }));
	}, [piReady]);

	const handleSend = (text: string) => {
		if (text === "/session") {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				showSessionDetail.current = true;
				ws.send(JSON.stringify({ type: "get_state" }));
			}
			return;
		}
		if (text === "/new") {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "new_session" }));
				sessionInitRef.current = false;
				setState(emptyState(gridRef.current.rows, gridRef.current.cols));
				setThinkingText("");
				setShowThinking(false);
			}
			return;
		}
		if (text === "/model") {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				prevStateRef.current = state;
				ws.send(JSON.stringify({ type: "get_available_models" }));
			}
			return;
		}
		if (modelMode.current) {
			if (text === "취소") {
				modelMode.current = false;
				setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols));
				prevStateRef.current = null;
				return;
			}
			// 페이지 이동
			if (text === "←이전") {
				modelPage.current = Math.max(0, modelPage.current - 1);
				renderModelGrid();
				return;
			}
			if (text === "다음→") {
				modelPage.current++;
				renderModelGrid();
				return;
			}
			// 모델 선택
			const ws = wsRef.current;
			const model = availableModels.current.find((m: any) =>
				`${m.provider}/${m.name || m.id}` === text);
			if (model && ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({
					type: "set_model",
					provider: model.provider,
					modelId: model.id,
				}));
				modelMode.current = false;
				setState(prevStateRef.current ?? emptyState(DEFAULT_ROWS, DEFAULT_COLS));
				prevStateRef.current = null;
			}
			return;
		}
		setInput(text);
		sendPrompt(text);
	};

	// ── 렌더 ─────────────────────────────────────────────────────────────
	const gridRows: [string, string][][] = [];
	for (let r = 0; r < rows; r++) {
		const row: [string, string][] = [];
		for (let c = 0; c < cols; c++) {
			const idx = String(r * cols + c);
			row.push([idx, state.buttons[idx] ?? ""]);
		}
		gridRows.push(row);
	}

	const statusText = !connected ? "연결 끊김" : !piReady ? "pi 시작중" : showThinking ? "사고중" : loading ? "생성중" : "준비";

	const cycleThinking = () => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !piReady) return;
		const cur = thinkingLevelRef.current;
		// 켜져 있고 시작 레벨에 다시 도달(한 바퀴)했으면 OFF로
		if (cur !== "off" && firstThinkingLevelRef.current === cur && thinkingCycleHitsRef.current >= 2) {
			ws.send(JSON.stringify({ type: "set_thinking_level", level: "off" }));
			setThinkingLevel("off");
			firstThinkingLevelRef.current = null;
			thinkingCycleHitsRef.current = 0;
			return;
		}
		ws.send(JSON.stringify({ type: "cycle_thinking_level" }));
	};

	return (
		<div className="turk-app">
			<header className="turk-header">
				<h1 title={statusText}><Bot className={"turk-ico " + (!connected ? "turk-ico-red" : !piReady ? "turk-ico-amber" : "turk-ico-green") + (loading || showThinking ? " turk-bot-spin" : "")} /> AI-Turk<sub className="turk-backend">{backendKind}</sub></h1>
				<span className="turk-mode">
				<button className="turk-model-btn" onClick={() => {
					if (modelMode.current) {
						modelMode.current = false;
						setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols));
						prevStateRef.current = null;
						return;
					}
					const ws = wsRef.current;
					if (ws?.readyState === WebSocket.OPEN) {
						prevStateRef.current = state;
						ws.send(JSON.stringify({ type: "get_available_models" }));
					}
				}} title={currentModel || "모델 선택"}>{(currentModel.split("/").pop() || currentModel) || "모델 선택"}</button> <button className="turk-thinking-btn" onClick={cycleThinking} style={{ color: THINKING_COLOR[thinkingLevel] }} title={`씽킹 레벨 순환: ${thinkingLevel}`}><Sparkles className="turk-ico" />{THINKING_LABEL[thinkingLevel]}</button> <button className="turk-new-btn" onClick={() => {
				if (!confirm("새 세션을 시작할까요?")) return;
				const ws = wsRef.current;
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "new_session" }));
					sessionInitRef.current = false;
					setState(emptyState(DEFAULT_ROWS, DEFAULT_COLS));
				}
			}} title={`컨텍스트 ${contextPct ?? "—"}% — 새 세션 시작`}>
					{contextPct != null ? (
						<span className="turk-ctx"><span className="turk-ctx-bar"><span className="turk-ctx-fill" style={{ width: `${Math.min(100, Math.max(0, contextPct))}%`, background: contextPct < 50 ? "var(--success)" : contextPct < 80 ? "#eab308" : contextPct < 95 ? "var(--warning)" : "var(--destructive)" }} /><span className="turk-ctx-pct">{Math.round(contextPct)}%</span></span></span>
						) : <span className="turk-ctx"><span className="turk-ctx-bar"><span className="turk-ctx-fill" style={{ width: "0%" }} /><span className="turk-ctx-pct">—</span></span></span>}
				</button></span>
			</header>

			<div className={"turk-message-wrap" + (loading ? " turk-loading" : "")}>
				{canScrollUp && (
					<button className="turk-scroll-arrow turk-scroll-up" onClick={() => messageRef.current?.scrollTo({ top: 0, behavior: "smooth" })} title="맨 위로"><ChevronUp className="turk-ico" /></button>
				)}
				{canScrollDown && (
					<button className="turk-scroll-arrow turk-scroll-down" onClick={() => messageRef.current?.scrollTo({ top: messageRef.current.scrollHeight, behavior: "smooth" })} title="맨 아래로"><ChevronDown className="turk-ico" /></button>
				)}
				<div
					ref={messageRef}
					className={`turk-message${loading ? " turk-message-loading" : ""}`}
					onScroll={updateScrollArrows}
				>
					{loading && toolStatus ? (
						<span className="turk-tool"><Wrench className="turk-ico" /> {toolStatus.name}: {toolStatus.args}</span>
					) : (
						<Md text={state.message} />
					)}
				</div>
			</div>

			<div className={`turk-grid${loading ? " turk-grid-loading" : ""}${keyboardUp ? " turk-grid-hidden" : ""}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
				{gridRows.flat().map(([idx, label]) =>
					label ? (
						<button
							key={idx}
							className={`turk-grid-btn${state.colors?.[idx] ? ` turk-bg-${state.colors[idx]}` : ""}${state.textColors?.[idx] ? ` turk-fg-${state.textColors[idx]}` : state.colors?.[idx] ? ` turk-fg-${["secondary", "muted", "accent", "destructive"].includes(state.colors[idx]) ? "white" : "black"}` : ""}`}
							disabled={loading || !piReady}
							onClick={() => handleSend(label)}
							style={modelMode.current ? (() => {
								// 모델 선택 화면: 모델명이 길면 폰트 자동 축소 (기준 8칸, 최소 0.8em)
								const w = [...label].reduce((a, c) => a + (/[^\x00-\x7F]/.test(c) ? 2 : 1), 0);
								if (w <= 8) return undefined;
								return { fontSize: `max(0.7em, ${(8 / w).toFixed(3)}em)` };
							})() : undefined}
						>
							{label}
						</button>
					) : (
						<button key={idx} className="turk-grid-btn turk-grid-btn-empty" tabIndex={-1} aria-hidden="true" />
					)
				)}
			</div>

			<form
				className="turk-input-form" style={{ bottom: kbHeight }}
				onSubmit={(e) => {
					e.preventDefault();
					if (input.trim() && !loading && piReady) handleSend(input.trim());
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape" && loading) {
						wsRef.current?.send(JSON.stringify({ type: "abort" }));
					}
				}}
			>
				<input
					className="turk-input-field"
					title="메시지 입력"
					enterKeyHint="send"
					inputMode="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder={piReady ? "명령어 입력..." : "pi 대기중..."}
					disabled={loading || !piReady}
					autoFocus
				/>
				<button
					type={loading ? "button" : "submit"}
					className="turk-submit-btn"
					disabled={!loading && (!input.trim() || !piReady)}
					onClick={loading ? () => {
						wsRef.current?.send(JSON.stringify({ type: "abort" }));
					} : undefined}
				>
					{loading ? "취소" : "전송"}
				</button>
			</form>
		</div>
	);
}