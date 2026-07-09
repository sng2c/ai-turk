import { useState, useCallback, useRef, useEffect, Component, type ReactNode } from "react";

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
	return `You are a UI controller. Respond with pure JSON only. No code blocks.

[Grid]
- ${rows} rows × ${cols} columns, ${nb} buttons. Keys "0"~"${nb - 1}".
- Empty button: "". Group related functions in the same row.
- Label: max 4 Korean chars or 8 English chars. Emoji allowed.
- Place primary buttons in the center.

[Message]
- Max 5 lines. Max 42 chars per line (Korean=2, English/digit=1).
- Markdown supported.

[Colors]
- colors: background (success/warning/destructive/primary/secondary)
- textColors: text (white/black)
- Contrast: success·destructive→white, warning·primary→black, secondary→white
- Hidden text: set textColors same as colors (label still sent on click)

[Examples]
Basic menu:
{"message":"What do you need?","buttons":{"0":"Weather","1":"Time","2":"News","3":"Help","4":""}}

Colored actions:
{"message":"Settings saved.","buttons":{"0":"OK","1":"Cancel","2":""},"colors":{"0":"success","1":"destructive"},"textColors":{"0":"white","1":"white"}}

Hidden text color block (clickable, label invisible):
{"message":"Select a zone.","buttons":{"0":"A","1":"B","2":"C","3":"D"},"colors":{"0":"destructive","1":"warning","2":"success","3":"primary"},"textColors":{"0":"destructive","1":"warning","2":"success","3":"primary"}}

[Format]
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

// 텍스트에서 JSON 버튼 그리드 파싱
function parseTurkJSON(text: string): TurkState | null {
	const m = text.match(/\{[\s\S]*\}/);
	if (!m) return null;
	try {
		const obj = JSON.parse(m[0]);
		if (obj.message !== undefined && obj.buttons !== undefined) return obj;
	} catch { /* 파싱 실패 */ }
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
	const [, setSessionId] = useState("");
	const [currentModel, setCurrentModel] = useState("");
	const currentModelRef = useRef("");
	currentModelRef.current = currentModel;

	// 씽킹 레벨 (기본 off) — 모델이 지원하는 레벨만 순환 (cycle_thinking_level)
	const [thinkingLevel, setThinkingLevel] = useState<string>("off");
	const thinkingLevelRef = useRef("off");
	thinkingLevelRef.current = thinkingLevel;
	// OFF 순환 감지용: 첫 켜진 레벨(firstLevel)에 다시 도달하면 OFF로
	const firstThinkingLevelRef = useRef<string | null>(null);
	const thinkingCycleHitsRef = useRef(0);
	const THINKING_LABEL: Record<string, string> = { off: "OFF", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "XHIGH" };

	// 스트리밍 상태 (내부 추적용 — UI에 직접 표시하지 않음)
	const [, setStreamingText] = useState("");
	const [, setThinkingText] = useState("");
	const [showThinking, setShowThinking] = useState(false);
	const [, setThinkingExpanded] = useState(false);
	const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);

	// 세션 초기화 추적
	const sessionInitRef = useRef(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const shouldReconnect = useRef(true);
	const showSessionDetail = useRef(false);
	const modelMode = useRef(false);
	// 모델 선택 진입 전 UI 상태(이전 메시지/버튼) 저장용
	const prevStateRef = useRef<TurkState | null>(null);
	const availableModels = useRef<any[]>([]);
	const modelPage = useRef(0);
	const MODELS_PER_PAGE = DEFAULT_ROWS * DEFAULT_COLS - 2; // 23 (나머지 2칸은 이전/다음)
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
				wsRef.current?.send(JSON.stringify({ type: "get_state" }));
				wsRef.current?.send(JSON.stringify({ type: "get_last_assistant_text" }));
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
				setThinkingText("");
				setShowThinking(false);
				setThinkingExpanded(false);
				setToolStatus(null);
				break;

			case "agent_end":
				setLoading(false);
				setInput("");
				setToolStatus(null);
				setShowThinking(false);
				setThinkingText("");
				// 마지막 assistant 메시지에서 JSON 파싱
				if (msg.messages?.length) {
					const text = extractAssistantText(msg.messages);
					if (text) {
						const parsed = parseTurkJSON(text);
						if (parsed) {
							setState(parsed);
						} else {
							setState(errState(`[파싱실패] ${text.slice(0, 200)}`, gridRef.current.rows, gridRef.current.cols));
						}
					}
				}
				break;

			case "message_update": {
				const delta = msg.assistantMessageEvent;
				if (!delta) break;
				if (delta.type === "thinking_start") {
					setShowThinking(true);
				} else if (delta.type === "thinking_delta") {
					setThinkingText((prev) => prev + (delta.delta || ""));
				} else if (delta.type === "text_delta") {
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
				}
				if (msg.command === "get_last_assistant_text" && msg.success && msg.data?.text) {
					const parsed = parseTurkJSON(msg.data.text);
					if (parsed) setState(parsed);
					sessionInitRef.current = true;
				}
				if (msg.command === "get_state" && msg.success && msg.data) {
					if (msg.data.sessionId) setSessionId(msg.data.sessionId);
					if (msg.data.model) setCurrentModel(msg.data.model.name || msg.data.model.id || "");
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

	// ── 모델 그리드 렌더 ───────────────────────────────────────────────
	const renderModelGrid = () => {
		const models = availableModels.current;
		const page = modelPage.current;
		const totalPages = Math.ceil(models.length / MODELS_PER_PAGE);
		const start = page * MODELS_PER_PAGE;
		const pageModels = models.slice(start, start + MODELS_PER_PAGE);
		const buttons: Record<string, string> = {};
		pageModels.forEach((m: any, i: number) => {
			buttons[String(i)] = `${m.provider}/${m.name || m.id}`;
		});
		for (let i = pageModels.length; i < MODELS_PER_PAGE; i++) {
			buttons[String(i)] = "";
		}
		// 이전/다음 버튼
		buttons[String(MODELS_PER_PAGE)] = page > 0 ? "←이전" : "";
		buttons[String(MODELS_PER_PAGE + 1)] = page < totalPages - 1 ? "다음→" : "";
		modelMode.current = true;
		setState({ message: `현재 모델: ${currentModelRef.current || "—"}\n페이지 ${page + 1}/${totalPages} — 모델을 선택하세요.`, buttons });
	};

	// ── 프롬프트 전송 ───────────────────────────────────────────────────
	const sendPrompt = useCallback((userText: string) => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !piReady) return;

		const { rows: r, cols: c } = gridRef.current;
		let message = userText;

		// 세션 첫 메시지에 시스템 지시 포함
		if (!sessionInitRef.current) {
			message = `${systemPrompt(r, c)}\n\n${userText}`;
			sessionInitRef.current = true;
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

	const statusIcon = !connected ? "🔴" : !piReady ? "🟡" : showThinking ? "💭" : loading ? "⏳" : "🟢";
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
				<h1>🤖 AI Turk</h1>
				<span className="turk-mode">
				<span className="turk-status">{statusIcon} {statusText}</span>
				<button className="turk-thinking-btn" onClick={cycleThinking} title={`씽킹 레벨 순환: ${thinkingLevel}`}>
					✦{THINKING_LABEL[thinkingLevel]}
				</button>
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
				}} title="모델 선택">{currentModel || "모델 선택"}</button> <button className="turk-new-btn" onClick={() => {
				if (!confirm("새 세션을 시작할까요?")) return;
				const ws = wsRef.current;
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "new_session" }));
					sessionInitRef.current = false;
					setState(emptyState(DEFAULT_ROWS, DEFAULT_COLS));
				}
			}} title="새 세션">↻</button></span>
			</header>

			<div className={`turk-message${loading ? " turk-message-loading" : ""}`}>
				{loading && toolStatus ? (
					<span className="turk-tool">🔧 {toolStatus.name}: {toolStatus.args}</span>
				) : (
					<Md text={state.message} />
				)}
			</div>

			<div className="turk-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
				{gridRows.flat().map(([idx, label]) =>
					label ? (
						<button
							key={idx}
							className={`turk-grid-btn${state.colors?.[idx] ? ` turk-bg-${state.colors[idx]}` : ""}${state.textColors?.[idx] ? ` turk-fg-${state.textColors[idx]}` : ""}`}
							disabled={loading || !piReady}
							onClick={() => handleSend(label)}
						>
							{label}
						</button>
					) : (
						<button key={idx} className="turk-grid-btn turk-grid-btn-empty" disabled />
					)
				)}
			</div>

			<form
				className="turk-input-form"
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