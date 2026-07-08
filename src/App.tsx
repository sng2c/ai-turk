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
	return `[중요 지시] 당신은 UI 컨트롤러입니다. 반드시 순수 JSON만 응답. 코드블록(\`\`\`) 금지.\n버튼 ${nb}개, ${rows}행×${cols}열 그리드. 키 "0"~"${nb - 1}".\n빈 버튼은 "". 관련 기능은 같은 행, 주요 버튼은 가운데, 라벨은 간결(이모지 가능).\nmessage는 최대 5줄 이내로 간결하게 작성.
형식: {"message":"마크다운 텍스트","buttons":{${ex}}}`;
}

function emptyState(rows: number, cols: number): TurkState {
	return {
		message: `기계 튀르크 — LLM이 버튼 그리드를 생성하는 인터페이스입니다.\n명령을 입력하세요.\n\n**/session** — 세션 정보\n**/new** — 새 세션`,
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
	const [sessionId, setSessionId] = useState("");

	// 스트리밍 상태 (내부 추적용 — UI에 직접 표시하지 않음)
	const [, setStreamingText] = useState("");
	const [thinkingText, setThinkingText] = useState("");
	const [showThinking, setShowThinking] = useState(false);
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);

	// 세션 초기화 추적
	const sessionInitRef = useRef(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const shouldReconnect = useRef(true);
	const showSessionDetail = useRef(false);
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
				if (msg.command === "get_state" && msg.success && msg.data) {
					if (msg.data.sessionId) setSessionId(msg.data.sessionId);
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
					if (msg.command === "new_session" && msg.success) {
						wsRef.current?.send(JSON.stringify({ type: "get_state" }));
					}
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
		setInput("");
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

	const statusIcon = !connected ? "🔴" : !piReady ? "🟡" : loading ? "⏳" : "🟢";
	const statusText = !connected ? "연결 끊김" : !piReady ? "pi 시작중" : loading ? "생성중" : "준비";

	return (
		<div className="turk-app">
			<header className="turk-header">
				<h1>🤖 AI Turk</h1>
				<span className="turk-mode">{statusIcon} {statusText}{sessionId ? ` #${sessionId.slice(-8)}` : ""}</span>
			</header>

			{(showThinking || thinkingText) && (
				<div className={`turk-thinking-area${thinkingExpanded ? " expanded" : ""}`} onClick={() => setThinkingExpanded(e => !e)}>
					<span className="turk-thinking-label">💭 {showThinking ? "사고 중" : "사고 완료"}</span>
					<div className="turk-thinking-text">
						{thinkingText || "..."}
					</div>
				</div>
			)}

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
							className="turk-grid-btn"
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
			>
				<input
					className="turk-input-field"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder={piReady ? "명령어 입력..." : "pi 대기중..."}
					disabled={loading || !piReady}
					autoFocus
				/>
				<button type="submit" className="turk-submit-btn" disabled={loading || !input.trim() || !piReady}>
					전송
				</button>
			</form>
		</div>
	);
}