/**
 * AI Turk 백엔드 추상화 — pi RPC 와 Claude Code stream-json 를 동일 인터페이스로.
 *
 * 외부(server.ts / vite.config.ts)에는 항상 **pi 이벤트 포맷**으로 노출한다.
 * App.tsx 는 백엔드 종류를 의식하지 않고 기존 pi 이벤트 핸들러 그대로 동작.
 *
 * 선택: TURK_BACKEND=pi (기본) | claude
 *   - pi:     pi --mode rpc (기존 그대로)
 *   - claude: claude -p --input-format/output-format stream-json (Ollama Anthropic 호환 엔드포인트)
 *
 * Claude 백엔드는 Ollama 의 Anthropic Messages 호환 엔드포인트(localhost:11434)를 통해
 * 구동 — `ollama launch claude --model <m>` 와 동일한 환경을 코드로 재현.
 */

import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdirSync } from "node:fs";

// ── 외부로 노출되는 이벤트: pi 호환 포맷 ──────────────────────────────
// App.tsx 가 처리하는 이벤트 타입과 1:1. 변경 시 App.tsx 도 함께 수정.
export type TurkEvent = Record<string, unknown>;

// ── 백엔드 인터페이스 ──────────────────────────────────────────────────
export interface Backend {
	/** 백엔드 프로세스 시작. ready 신호는 onEvent 로 전달된다. */
	start(): void;
	/** 클라이언트 명령 전송 (prompt / get_state / new_session / set_model 등). */
	send(cmd: Record<string, unknown>): void;
	/** 백엔드 이벤트(pi 포맷) 구독. */
	onEvent(cb: (ev: TurkEvent) => void): void;
	/** 프로세스 종료. */
	stop(): void;
	/** 헬스체크용 — 프로세스 생존 여부. */
	alive(): boolean;
	/** 백엔드 종류 식별자 ("pi" | "claude"). */
	kind(): "pi" | "claude";
}

export interface BackendOptions {
	cwd: string;
	onLog?: (msg: string) => void;
}

// ── 공통: JSONL stdout 파서 ─────────────────────────────────────────
// (erasableSyntaxOnly 제약으로 abstract class 대신 일반 class + throws 사용)
class JsonlBackend implements Backend {
	protected proc: ChildProcess | null = null;
	protected decoder = new StringDecoder("utf8");
	protected buffer = "";
	protected cb: ((ev: TurkEvent) => void) | null = null;
	protected readonly log: (msg: string) => void;
	protected opts: BackendOptions;

	constructor(opts: BackendOptions) {
		this.opts = opts;
		this.log = opts.onLog ?? ((m: string) => console.log(m));
	}

	onEvent(cb: (ev: TurkEvent) => void): void { this.cb = cb; }
	protected emit(ev: TurkEvent): void { this.cb?.(ev); }
	alive(): boolean { return this.proc !== null; }
	kind(): "pi" | "claude" { throw new Error("kind() not implemented"); }
	start(): void { throw new Error("start() not implemented"); }
	send(_cmd: Record<string, unknown>): void { throw new Error("send() not implemented"); }

	stop(): void {
		if (this.proc) { this.proc.kill("SIGTERM"); this.proc = null; }
	}

	/** stdout 청크 → 줄 단위 JSONL → emit(변환된 이벤트). */
	protected feedStdout(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		while (true) {
			const idx = this.buffer.indexOf("\n");
			if (idx === -1) break;
			let line = this.buffer.slice(0, idx);
			this.buffer = this.buffer.slice(idx + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line.trim()) continue;
			try {
				this.handleLine(JSON.parse(line));
			} catch {
				this.log(`[Turk] JSONL 파싱 오류: ${line.slice(0, 120)}`);
			}
		}
	}

	/** 각 백엔드가 원본 이벤트를 pi 포맷으로 변환. */
	protected handleLine(_raw: unknown): void { throw new Error("handleLine() not implemented"); }

	/** 자식 프로세스 공통 핸들러 부착. */
	protected attach(proc: ChildProcess, label: string): void {
		this.proc = proc;
		proc.stdout!.on("data", (c: Buffer) => this.feedStdout(c));
		proc.stderr!.on("data", (c: Buffer) => {
			const msg = c.toString().trim();
			if (msg) this.log(`[${label}] ${msg.slice(0, 500)}`);
		});
		proc.on("exit", (code) => {
			this.log(`[Turk] ${label} 종료 (코드: ${code})`);
			this.proc = null;
			this.emit({ type: "pi_exit", code });
		});
		proc.on("error", (err) => {
			this.log(`[Turk] ${label} 시작 실패: ${err.message}`);
			this.proc = null;
			this.emit({ type: "pi_error", message: err.message });
		});
	}
}

// ── pi 백엔드 — 기존 로직 그대로, 이벤트 변환 없이 패스스루 ────────────
export class PiBackend extends JsonlBackend {
	override kind() { return "pi" as const; }

	override start(): void {
		try { mkdirSync(this.opts.cwd, { recursive: true }); } catch { /* 무시 */ }
		const bin = process.env.TURK_RPC_BIN || "pi";
		const model = process.env.TURK_RPC_MODEL || "";
		const extra = (process.env.TURK_RPC_ARGS || "").split(/\s+/).filter(Boolean);
		const args = ["--mode", "rpc", "--no-session", ...(model ? ["--model", model] : []), ...extra];
		this.log(`[Turk] ${bin} ${args.join(" ")} 시작`);
		this.attach(spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.opts.cwd }), "pi");
		this.emit({ type: "pi_ready" });
	}

	override send(cmd: Record<string, unknown>): void {
		if (!this.proc?.stdin?.writable) return;
		this.proc.stdin.write(JSON.stringify(cmd) + "\n");
	}

	protected override handleLine(raw: unknown): void {
		// pi 는 이미 App.tsx 가 기대하는 포맷이므로 그대로 전달.
		this.emit(raw as TurkEvent);
	}
}

// ── Claude Code 백엔드 — stream-json → pi 이벤트 번역 ───────────────────
// 입력: {"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}
// 출력 이벤트를 pi 포맷으로 변환하여 emit.
export class ClaudeBackend extends JsonlBackend {
	private sessionId: string | null = null;
	private agentStarted = false;
	// result 도착 전 마지막 assistant 텍스트 누적 (fallback)
	private lastAssistantText = "";

	override kind() { return "claude" as const; }

	override start(): void {
		try { mkdirSync(this.opts.cwd, { recursive: true }); } catch { /* 무시 */ }
		const bin = process.env.TURK_CLAUDE_BIN || "claude";
		const model = process.env.TURK_RPC_MODEL || process.env.TURK_CLAUDE_MODEL || "";
		// Ollama Anthropic 호환 엔드포인트 — `ollama launch claude --model` 과 동일 환경.
		const baseUrl = process.env.ANTHROPIC_BASE_URL || "http://localhost:11434";
		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			ANTHROPIC_BASE_URL: baseUrl,
			ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || "ollama",
			// 빈 API_KEY 는 "unset" 취급이므로 명시적으로 비워 subscription 우회.
			ANTHROPIC_API_KEY: "",
			ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
			...(model ? { ANTHROPIC_MODEL: model } : {}),
		};
		const args = [
			"-p",
			"--input-format", "stream-json",
			"--output-format", "stream-json",
			"--verbose",
			"--include-partial-messages",
			// root 환경에서 bypassPermissions 불가 → stdio 라우팅 + 자동 승인은 불필요
			// (Ollama 백엔드는 permission control_request 를 보내지 않고 도구가 자동 실행됨)
		];
		this.log(`[Turk] ${bin} ${args.join(" ")} 시작 (base=${baseUrl}, model=${model || "기본"})`);
		this.attach(
			spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], cwd: this.opts.cwd, env }),
			"claude",
		);
		// Claude -p stream-json 은 첫 user 입력이 도착해야 system/init 을 내보낸다.
		// App.tsx 는 pi_ready 가 와야 프롬프트를 보내므로 교착 방지를 위해 즉시 ready emit.
		this.emit({ type: "pi_ready" });
	}

	override send(cmd: Record<string, unknown>): void {
		if (!this.proc?.stdin?.writable) return;
		const out = this.translateCommand(cmd);
		if (out) this.proc.stdin.write(JSON.stringify(out) + "\n");
	}

	/** pi 커맨드 → Claude stream-json 입력 메시지. 제어 커맨드는 no-op. */
	private translateCommand(cmd: Record<string, unknown>): Record<string, unknown> | null {
		switch (cmd.type) {
			case "prompt": {
				const text = String(cmd.message ?? "");
				return {
					type: "user",
					message: { role: "user", content: [{ type: "text", text }] },
					parent_tool_use_id: null,
					session_id: this.sessionId,
				};
			}
			case "abort":
				// Claude 는 stdin 종료/SIGINT 외에 런타임 abort 가 없음 — 빈 줄은 무시.
				// 프로세스에 SIGINT 전달 시도.
				this.proc?.kill("SIGINT");
				return null;
			case "new_session":
				// Claude -p 는 세션을 프로세스 생명주기로 관리. 새 세션 = 프로세스 재시작.
				// restart 와 동일 → 상위에서 restart_pi 커맨드로 처리되므로 여기선 no-op.
				return null;
			default:
				// get_state / set_model / cycle_thinking_level / get_available_models /
				// get_session_stats / get_last_assistant_text / set_thinking_level
				// → Claude 백엔드는 런타임 제어를 지원하지 않음. 합성 응답으로 클라이언트 안정화.
				this.emitSyntheticResponse(cmd.type as string);
				return null;
		}
	}

	/** 지원 불가한 제어 커맨드에 대해 합성 response 이벤트 emit (App.tsx 오류 방지). */
	private emitSyntheticResponse(command: string): void {
		const base = { type: "response", command, success: true };
		switch (command) {
			case "get_state":
				this.emit({ ...base, data: {
					sessionId: this.sessionId ?? "",
					model: { id: process.env.TURK_RPC_MODEL || "claude", name: process.env.TURK_RPC_MODEL || "Claude", provider: "claude" },
					thinkingLevel: "off",
					isStreaming: false,
					messageCount: 0,
				}});
				break;
			case "get_available_models":
				// Claude 백엔드는 단일 모델만 — 런타임 전환 불가.
				this.emit({ ...base, data: { models: [] }});
				break;
			case "get_session_stats":
				this.emit({ ...base, data: { contextUsage: { percent: 0 } }});
				break;
			case "get_last_assistant_text":
				this.emit({ ...base, data: { text: this.lastAssistantText }});
				break;
			case "set_model":
			case "set_thinking_level":
			case "cycle_thinking_level":
			case "new_session":
				this.emit({ ...base, data: {} });
				break;
			default:
				this.emit({ ...base, data: {} });
		}
	}

	protected override handleLine(raw: unknown): void {
		const ev = raw as Record<string, any>;
		if (!ev || typeof ev !== "object") return;
		const t = ev.type;

		switch (t) {
			case "system": {
				if (ev.subtype === "init") {
					this.sessionId = ev.session_id ?? null;
					// pi_ready 는 start() 에서 이미 emit 했으므로 중복 않음.
				}
				// status: requesting → agent_start (최초 1회)
				if (ev.subtype === "status" && ev.status === "requesting" && !this.agentStarted) {
					this.agentStarted = true;
					this.emit({ type: "agent_start" });
				}
				break;
			}
			case "stream_event": {
				this.translateStreamEvent(ev.event);
				break;
			}
			case "assistant": {
				// tool_use 완료 or 텍스트 블록 누적. assistant message 에서 텍스트 추출.
				this.captureAssistantText(ev.message);
				break;
			}
			case "user": {
				// tool_result — 도구 실행 종료로 간주.
				this.emit({ type: "tool_execution_end" });
				break;
			}
			case "result": {
				this.emitResult(ev);
				break;
			}
			default:
				// 기타 system 이벤트(thinking_tokens 등)는 무시.
				break;
		}
	}

	private translateStreamEvent(event: any): void {
		if (!event) return;
		switch (event.type) {
			case "content_block_start": {
				const block = event.content_block;
				if (block?.type === "tool_use") {
					this.emit({ type: "tool_execution_start", toolName: block.name, args: block.input });
				} else if (block?.type === "thinking") {
					this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_start" }});
				}
				break;
			}
			case "content_block_delta": {
				const d = event.delta;
				if (!d) break;
				if (d.type === "text_delta") {
					this.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d.text }});
				} else if (d.type === "thinking_delta") {
					this.emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: d.thinking }});
				}
				break;
			}
			default:
				break;
		}
	}

	private captureAssistantText(message: any): void {
		if (!message?.content || !Array.isArray(message.content)) return;
		const texts = message.content
			.filter((b: any) => b.type === "text" && b.text)
			.map((b: any) => b.text);
		if (texts.length) this.lastAssistantText = texts.join("\n");
	}

	private emitResult(ev: any): void {
		const isError = ev.is_error === true || ev.subtype === "error";
		// result.result 가 최종 텍스트. agent_end.messages 를 App.tsx 가 기대하는 포맷으로 합성.
		const finalText = typeof ev.result === "string" ? ev.result : this.lastAssistantText;
		if (finalText) this.lastAssistantText = finalText;

		this.emit({
			type: "agent_end",
			willRetry: false,
			messages: [{
				role: "assistant",
				content: [{ type: "text", text: finalText }],
			}],
			...(isError ? { error: ev.result } : {}),
		});
		this.agentStarted = false;
	}
}

// ── 팩토리 ──────────────────────────────────────────────────────────────
export function createBackend(opts: BackendOptions): Backend {
	const kind = (process.env.TURK_BACKEND || "pi").toLowerCase();
	if (kind === "claude") return new ClaudeBackend(opts);
	return new PiBackend(opts);
}