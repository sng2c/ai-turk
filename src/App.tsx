import { useState, useCallback, useRef, useEffect } from "react";

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

function bestGrid(n: number): [number, number] {
	let c = Math.max(1, Math.min(Math.round(Math.sqrt(n)), 10));
	while (n % c && c > 1) c--;
	return [Math.ceil(n / c), c];
}

function systemPrompt(rows: number, cols: number): string {
	const nb = rows * cols;
	const ex = Array.from({ length: nb }, (_, i) => `"${i}": ""`).join(", ");
	return `[중요 지시] 당신은 UI 컨트롤러입니다. 반드시 순수 JSON만 응답. 코드블록(\`\`\`) 금지.\n버튼 ${nb}개, ${rows}행×${cols}열 그리드. 키 "0"~"${nb - 1}".\n빈 버튼은 "". 관련 기능은 같은 행, 주요 버튼은 가운데, 라벨은 간결(이모지 가능).\n형식: {"message":"마크다운 텍스트","buttons":{${ex}}}`;
}

function emptyState(rows: number, cols: number): TurkState {
	return {
		message: `그리드 ${rows}×${cols} (${rows * cols}버튼) 준비됨`,
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
	const [rows, setRows] = useState(DEFAULT_ROWS);
	const [cols, setCols] = useState(DEFAULT_COLS);
	const [state, setState] = useState<TurkState>(emptyState(DEFAULT_ROWS, DEFAULT_COLS));
	const [loading, setLoading] = useState(false);
	const [input, setInput] = useState("");
	const [totalInput, setTotalInput] = useState(DEFAULT_ROWS * DEFAULT_COLS);

	// WebSocket 상태
	const [connected, setConnected] = useState(false);
	const [piReady, setPiReady] = useState(false);

	// 스트리밍 상태
	const [streamingText, setStreamingText] = useState("");
	const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);

	// 세션 초기화 추적
	const sessionInitRef = useRef(false);
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const gridRef = useRef({ rows: DEFAULT_ROWS, cols: DEFAULT_COLS });
	gridRef.current = { rows, cols };

	// ── WebSocket 연결 ──────────────────────────────────────────────────
	const connect = useCallback(() => {
		const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;

		ws.onopen = () => setConnected(true);

		ws.onclose = () => {
			setConnected(false);
			setPiReady(false);
			// 자동 재연결 (3초 후)
			reconnectTimer.current = setTimeout(connect, 3000);
		};

		ws.onerror = () => ws.close();

		ws.onmessage = (ev) => {
			try {
				const msg = JSON.parse(ev.data);
				handleEvent(msg);
			} catch (e) {
				console.error("메시지 파싱 오류:", e);
			}
		};
	}, []);

	useEffect(() => {
		connect();
		return () => {
			clearTimeout(reconnectTimer.current);
			wsRef.current?.close();
		};
	}, [connect]);

	// ── pi 이벤트 처리 ──────────────────────────────────────────────────
	const handleEvent = useCallback((msg: any) => {
		switch (msg.type) {
			case "pi_ready":
				setPiReady(true);
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
				setToolStatus(null);
				break;

			case "agent_end":
				setLoading(false);
				setToolStatus(null);
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
				if (delta.type === "text_delta") {
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

	// ── 그리드 변경 (새 세션) ──────────────────────────────────────────
	const handleGridChange = () => {
		const [r, c] = bestGrid(totalInput);
		setRows(r);
		setCols(c);
		setState(emptyState(r, c));
		setStreamingText("");
		setToolStatus(null);

		// pi에 새 세션 요청
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "new_session" }));
		}
		sessionInitRef.current = false;
	};

	const handleSend = (text: string) => {
		setInput("");
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
				<span className="turk-mode">{statusIcon} {statusText}</span>
			</header>

			<div className="turk-grid-setup">
				<label>
					N:
					<input
						type="number"
						min={1}
						max={100}
						value={totalInput}
						onChange={(e) => setTotalInput(Number(e.target.value))}
					/>
				</label>
				<button onClick={handleGridChange}>변경</button>
			</div>

			<div className="turk-message">
				{loading && streamingText ? (
					<Md text={streamingText} />
				) : loading && toolStatus ? (
					<span className="turk-tool">🔧 {toolStatus.name}: {toolStatus.args}</span>
				) : loading ? (
					<span className="turk-thinking">💭 생각 중...</span>
				) : (
					<Md text={state.message} />
				)}
			</div>

			<div className="turk-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
				{gridRows.flat().map(([idx, label]) =>
					label ? (
						<button
							key={idx}
							className="turk-btn"
							disabled={loading || !piReady}
							onClick={() => handleSend(label)}
						>
							{label}
						</button>
					) : (
						<button key={idx} className="turk-btn turk-btn-empty" disabled />
					)
				)}
			</div>

			<form
				className="turk-input"
				onSubmit={(e) => {
					e.preventDefault();
					if (input.trim() && !loading && piReady) handleSend(input.trim());
				}}
			>
				<input
					value={input}
					onChange={(e) => setInput(e.target.value)}
					placeholder={piReady ? "명령어 입력..." : "pi 대기중..."}
					disabled={loading || !piReady}
					autoFocus
				/>
				<button type="submit" disabled={loading || !input.trim() || !piReady}>
					전송
				</button>
			</form>
		</div>
	);
}