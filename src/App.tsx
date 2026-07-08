import { useState, useCallback, useRef } from "react";

// ── 타입 ──────────────────────────────────────────────────────────────
interface TurkState {
  message: string;
  buttons: Record<string, string>;
}

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

// ── 설정 ───────────────────────────────────────────────────────────────
const DEFAULT_ROWS = 5;
const DEFAULT_COLS = 5;
const MODEL = import.meta.env.VITE_OLLAMA_MODEL || "gemini-3-flash-preview";

function bestGrid(n: number): [number, number] {
  let c = Math.max(1, Math.min(Math.round(Math.sqrt(n)), 10));
  while (n % c && c > 1) c--;
  return [Math.ceil(n / c), c];
}

function systemPrompt(rows: number, cols: number): string {
  const nb = rows * cols;
  const ex = Array.from({ length: nb }, (_, i) => `"${i}": ""`).join(", ");
  return `[System Instruction]\nUI 컨트롤러. 반드시 순수 JSON만 응답. 코드블록 금지.\n버튼 ${nb}개, ${rows}행×${cols}열 그리드. 키 "0"~"${nb - 1}".\n빈 버튼은 "". 관련 기능은 같은 행, 주요 버튼은 가운데, 라벨은 간결하게(이모지 가능).\n{"message":"마크다운 텍스트","buttons":{${ex}}}`;
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
  const [messages, setMessages] = useState<Message[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [loading, setLoading] = useState(false);
  const [input, setInput] = useState("");
  const [totalInput, setTotalInput] = useState(DEFAULT_ROWS * DEFAULT_COLS);
  const msgsRef = useRef(messages);
  msgsRef.current = messages;
  const initRef = useRef(initialized);
  initRef.current = initialized;

  const callApi = useCallback(
    async (userInput: string) => {
      setLoading(true);
      try {
        const isFirst = !initRef.current;
        let newMsgs: Message[];
        if (isFirst) {
          newMsgs = [
            { role: "system", content: systemPrompt(rows, cols) },
            { role: "user", content: userInput },
          ];
        } else {
          newMsgs = [...msgsRef.current, { role: "user", content: userInput }];
        }

        const res = await fetch("/api/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: MODEL, messages: newMsgs, max_tokens: 4096, stream: false }),
        });

        if (!res.ok) {
          const body = await res.text();
          setState(errState(`[HTTP ${res.status}] ${body.slice(0, 200)}`, rows, cols));
          return;
        }

        const data = await res.json();
        const choice = data.choices?.[0]?.message;
        const text: string = choice?.content || choice?.reasoning || "";
        newMsgs = [...newMsgs, { role: "assistant", content: text }];
        setMessages(newMsgs);
        setInitialized(true);

        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
          try {
            setState(JSON.parse(m[0]));
          } catch {
            setState(errState(`[파싱실패] ${text.slice(0, 200)}`, rows, cols));
          }
        } else {
          setState(errState(`[파싱실패] ${text.slice(0, 200)}`, rows, cols));
        }
      } catch (e) {
        setState(errState(`[에러] ${String(e)}`, rows, cols));
      } finally {
        setLoading(false);
      }
    },
    [rows, cols]
  );

  const handleGridChange = () => {
    const [r, c] = bestGrid(totalInput);
    setRows(r);
    setCols(c);
    setState(emptyState(r, c));
    setMessages([]);
    setInitialized(false);
  };

  const handleSend = (text: string) => {
    setInput("");
    callApi(text);
  };

  const gridRows: [string, string][][] = [];
  for (let r = 0; r < rows; r++) {
    const row: [string, string][] = [];
    for (let c = 0; c < cols; c++) {
      const idx = String(r * cols + c);
      row.push([idx, state.buttons[idx] ?? ""]);
    }
    gridRows.push(row);
  }

  return (
    <div className="turk-app">
      <header className="turk-header">
        <h1>🤖 AI Turk</h1>
        <span className="turk-mode">{loading ? "⏳" : "🟢"}</span>
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
        <Md text={state.message} />
      </div>

      <div className="turk-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {gridRows.flat().map(([idx, label]) =>
          label ? (
            <button
              key={idx}
              className="turk-btn"
              disabled={loading}
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
          if (input.trim()) handleSend(input.trim());
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="명령어 입력..."
          disabled={loading}
          autoFocus
        />
        <button type="submit" disabled={loading || !input.trim()}>
          전송
        </button>
      </form>
    </div>
  );
}