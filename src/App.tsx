import { useState, useCallback, useRef, useEffect } from "react";
import { Bot, ChevronUp, ChevronDown, Sparkles, Wrench, AlarmClock, Copy, Settings } from "lucide-react";
import {
	DEFAULT_COLS, DEFAULT_ROWS, TURK_USER_KEY,
	emptyState, errState, extractAssistantText, parseTurkJSON,
	subscribePush, systemPrompt, Md,
} from "./lib/turk";
import type { TurkState, ToolStatus } from "./lib/turk";

// 모바일(터치) 감지 — 모바일에서는 자동 포커스로 가상 키보드 자동 노출 방지
const IS_FINE_POINTER = typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches === true;

// ── 앱 ─────────────────────────────────────────────────────────────────
export default function App() {
	const rows = DEFAULT_ROWS;
	const cols = DEFAULT_COLS;
	const [state, setState] = useState<TurkState>(emptyState(DEFAULT_ROWS, DEFAULT_COLS));
	const [loading, setLoading] = useState(false);
	const clearInput = () => { setInput(""); localStorage.removeItem("turk-input"); };
	const [input, setInput] = useState(() => localStorage.getItem("turk-input") || "");

	// WebSocket 상태
	const [connected, setConnected] = useState(false);
	const [piReady, setPiReady] = useState(false);
	const [restored, setRestored] = useState(false); // 초기화 상태 복원 완료 여부
	const [modelChanging, setModelChanging] = useState(false); // 모델 변경 중 (지원 레벨/컨텍스트 갱신)
	const pendingModelUpdateRef = useRef(false); // set_model → get_state 응답 매칭
	const userSentRef = useRef(false); // 사용자 전송 → agent_end 시 입력창 클리어 (스케줄러 응답은 유지)
	const [logoMode, setLogoMode] = useState<"robot" | "alarm" | "tool">("robot");
	const baseLogoModeRef = useRef<"robot" | "alarm" | "tool">("robot"); // 톨 종료 후 복귀용

	const [backendKind, setBackendKind] = useState<string>("pi");
	const [sessionId, setSessionId] = useState("");
	const [currentModel, setCurrentModel] = useState("");
	const currentModelRef = useRef("");
	currentModelRef.current = currentModel;

	// 씽킹 레벨 (기본 off) — 모델이 지원하는 레벨만 순환 (cycle_thinking_level)
	const [thinkingLevel, setThinkingLevel] = useState<string>("off");
	const [contextPct, setContextPct] = useState<number | null>(null);
	const thinkingLevelRef = useRef("off");
	const supportedThinkingLevelsRef = useRef<string[]>(["off"]); // model.thinkingLevelMap 기반 지원 레벨
	thinkingLevelRef.current = thinkingLevel;
	// OFF 순환 감지용: 첫 켜진 레벨(firstLevel)에 다시 도달하면 OFF로
	const firstThinkingLevelRef = useRef<string | null>(null);
	const thinkingCycleHitsRef = useRef(0);
	const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

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
	// ── 스케줄러 관련 ref ──
	// schedulerTriggerRef: scheduler_trigger 이벤트 수신 시 설정 → 다음 agent_end 응답 message 앞에 prefix 부착
	const schedulerTriggerRef = useRef<{ ids: string[]; whens: string[] } | null>(null);
	// schedulerFeedbackRef: schedule response 결과 → 다음 프롬프트에 주입 (가드 에러 등 안내)
	const schedulerFeedbackRef = useRef<string | null>(null);
	// schedulerPrefixRef: scheduler_trigger로부터 생성된 prefix → setState 시 message 앞에 부착
	const schedulerPrefixRef = useRef<string | null>(null);

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
	const inputRef = useRef<HTMLInputElement>(null);
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
		const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?u=${TURK_USER_KEY}`;
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

	// ── 웹 알림 권한 요청 (페이지 진입 시 1회) ──────────────────────────────
	useEffect(() => {
		if (!("Notification" in window) || Notification.permission !== "default") return;
		// Firefox Android 등은 사용자 제스처 내에서만 권한 요청 허용 → 첫 클릭 시 요청
		const onClick = () => {
			Notification.requestPermission().catch(() => { /* 무시 */ });
			window.removeEventListener("click", onClick);
		};
		window.addEventListener("click", onClick, { once: true });
		return () => window.removeEventListener("click", onClick);
	}, []);

	// 상태 복원 완료 후 입력창 포커스 (dim 해제 시점 — 데스크톱만)
	useEffect(() => {
		if (restored && IS_FINE_POINTER) inputRef.current?.focus();
	}, [restored]);

	// ── pi 이벤트 처리 ──────────────────────────────────────────────────
	const handleEvent = useCallback((msg: any) => {
		switch (msg.type) {
			case "pi_ready":
				setPiReady(true);
				if (typeof msg.backend === "string") setBackendKind(msg.backend);
				// 웹 푸시 구독: VAPID 공개키로 서비스 워커 등록 + 구독 → 서버 전송
				if (typeof msg.vapidPublicKey === "string") subscribePush(msg.vapidPublicKey, wsRef.current);
				// 상태 복원: get_state 응답 대기 — 복원 전까지 dim (last-assistant-text는 브라우저 localStorage)
				setRestored(false);
				wsRef.current?.send(JSON.stringify({ type: "get_state" }));
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				break;
			case "pi_starting":
				setPiReady(false);
				break;
			case "session_error":
				// 최대 세션 초과 등 — 재연결 중지 (무한 재시도 방지)
				shouldReconnect.current = false;
				setState({ message: `⚠️ ${msg.error || "세션 연결 거부됨"}`, buttons: {} });
				setPiReady(false);
				break;
			case "session_terminated":
				// LRU 정리로 강제 종료 — 재연결 시 새 세션 할당됨
				shouldReconnect.current = true;
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
				// route 기반 로고 결정 — scheduler=알람, tool=톱니, 그 외=로봇
				const base = msg.route === "scheduler" ? "alarm" : msg.route === "tool" ? "tool" : "robot";
				baseLogoModeRef.current = base;
				setLogoMode(base);
				break;

			case "agent_end": {
				// willRetry가 true면 곧 재시도할 예정 — 아직 최종 응답이 아님. 로딩 유지.
				if (msg.willRetry) {
					break;
				}
				setLoading(false);
				setLogoMode("robot");
				// 사용자 전송 응답 종료 시 입력창 클리어 (스케줄러 응답은 유지)
				if (userSentRef.current) { clearInput(); userSentRef.current = false; }
				// 데스크톱만 응답 완료 시 입력창 포커스 — 모바일은 가상 키보드 자동 노출 방지
				if (IS_FINE_POINTER) inputRef.current?.focus();
				// scheduler_trigger가 대기 중이면 응답 message 앞에 prefix 부착
				if (schedulerTriggerRef.current) {
					const trig = schedulerTriggerRef.current;
					schedulerTriggerRef.current = null; // 1회용
					schedulerPrefixRef.current = `⏰ [예약 실행: ${trig.ids.join(", ")}]\n`;
				}
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				setToolStatus(null);
				setShowThinking(false);
				setThinkingText("");
				// 1차: agent_end의 messages에서 텍스트 추출
				let text = msg.messages?.length ? extractAssistantText(msg.messages) : "";
				// 2차(fallback): messages가 비었거나 파싱 실패 시 스트리밍 누적본 사용
				if (!text) text = streamingTextRef.current;
				if (text) {
					const result = parseTurkJSON(text);
					if (result && "parsed" in result) {
						retryCountRef.current = 0; // 성공 시 카운터 리셋
						const parsed = result.parsed;
						// schedules는 silent 여부와 무관하게 항상 처리
						if (Array.isArray(parsed.schedules)) {
							for (const sch of parsed.schedules) {
								wsRef.current?.send(JSON.stringify({ type: "schedule", ...sch }));
							}
						}
						// silent: 사용자에게 미표시 — schedules는 이미 처리됨
						if (parsed.silent === true) {
							if (schedulerPrefixRef.current) schedulerPrefixRef.current = null;
							return;
						}
						// 브라우저 localStorage에 마지막 응답 저장 (sessionId 기준)
						if (sessionId) localStorage.setItem("ai-turk:last-response:" + TURK_USER_KEY, JSON.stringify({ sessionId, text }));
						// 화면 표시
						if (Array.isArray(parsed.schedules)) {
							const { schedules, ...stateWithoutSchedules } = parsed;
							if (schedulerPrefixRef.current) {
								stateWithoutSchedules.message = schedulerPrefixRef.current + (stateWithoutSchedules.message || "");
								schedulerPrefixRef.current = null;
							}
							setState(stateWithoutSchedules);
						} else {
							if (schedulerPrefixRef.current) {
								parsed.message = schedulerPrefixRef.current + (parsed.message || "");
								schedulerPrefixRef.current = null;
							}
							setState(parsed);
						}
					} else {
						// 스트리밍본으로 한 번 더 시도 (messages가 잘렸을 수 있음)
						const fallback = streamingTextRef.current && streamingTextRef.current !== text
							? parseTurkJSON(streamingTextRef.current)
							: null;
						if (fallback && "parsed" in fallback) {
							retryCountRef.current = 0;
							const parsed = fallback.parsed;
							// schedules는 silent 여부와 무관하게 항상 처리
							if (Array.isArray(parsed.schedules)) {
								for (const sch of parsed.schedules) {
									wsRef.current?.send(JSON.stringify({ type: "schedule", ...sch }));
								}
							}
							// silent: 사용자에게 미표시
							if (parsed.silent === true) {
								if (schedulerPrefixRef.current) schedulerPrefixRef.current = null;
								return;
							}
							// 브라우저 localStorage에 마지막 응답 저장 (sessionId 기준)
							if (sessionId) localStorage.setItem("ai-turk:last-response:" + TURK_USER_KEY, JSON.stringify({ sessionId, text }));
							if (Array.isArray(parsed.schedules)) {
								const { schedules, ...stateWithoutSchedules } = parsed;
								if (schedulerPrefixRef.current) {
									stateWithoutSchedules.message = schedulerPrefixRef.current + (stateWithoutSchedules.message || "");
									schedulerPrefixRef.current = null;
								}
								setState(stateWithoutSchedules);
							} else {
								if (schedulerPrefixRef.current) {
									parsed.message = schedulerPrefixRef.current + (parsed.message || "");
									schedulerPrefixRef.current = null;
								}
								setState(parsed);
							}
						} else if (retryCountRef.current < MAX_PARSE_RETRIES) {
							// 자가 수정 재시도: 원문 + JSON.parse 에러를 모델에게 돌려주며 형식 재요청
							retryCountRef.current++;
							sessionInitRef.current = false; // 시스템 프롬프트 재부착 트리거
							schedulerFeedbackRef.current = null; // 피드백 캐시 클리어
							setLoading(true);
							const errInfo = (result && "error" in result) ? result.error
								: (fallback && "error" in fallback) ? fallback.error : "";
							const retry = `지난 응답이 올바른 JSON 형식이 아닙니다. JSON.parse 에러: ${errInfo}\n다음 원문을 참고하여, 동일한 내용으로 올바른 JSON 버튼 그리드 하나만 다시 출력하세요. 원문 외 설명/코드펜스 금지.\n\n[잘못된 응답]\n${text.slice(0, 800)}`;
							sendPrompt(retry, "tool"); // sendPrompt가 sessionInitRef=false 확인 → systemPrompt 재부착
						} else {
							retryCountRef.current = 0;
							schedulerPrefixRef.current = null; // prefix 클리어
							const errInfo = (result && "error" in result) ? result.error
								: (fallback && "error" in fallback) ? fallback.error : "알 수 없는 오류";
							setState(errState(`[파싱실패] ${errInfo}\n${text.slice(0, 150)}`, gridRef.current.rows, gridRef.current.cols));
						}
					}
				} else if (!loading) {
					// 응답 텍스트 자체가 없는 경우 (도구만 사용 등)
					schedulerPrefixRef.current = null; // prefix 클리어
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
				if (msg.command === "get_state" && msg.success && msg.data) {
					if (pendingModelUpdateRef.current) { pendingModelUpdateRef.current = false; setModelChanging(false); } // 모델 변경 완료 — 지원 레벨/컨텍스트 갱신됨
					if (msg.data.sessionId) {
						setSessionId(msg.data.sessionId);
						// localStorage에서 마지막 응답 복원 — sessionId 일치 시만
						try {
							const saved = localStorage.getItem("ai-turk:last-response:" + TURK_USER_KEY);
							if (saved) {
									const { sessionId: sid, text } = JSON.parse(saved);
								if (sid === msg.data.sessionId && text) {
									const result = parseTurkJSON(text);
									if (result && "parsed" in result && result.parsed.silent !== true) setState(result.parsed);
								} else {
									localStorage.removeItem("ai-turk:last-response:" + TURK_USER_KEY);
								}
							}
						} catch {
							localStorage.removeItem("ai-turk:last-response:" + TURK_USER_KEY);
						}
					}
					setRestored(true); // 상태 복원 완료 → dim 해제
					if (msg.data.isStreaming) { setLoading(true); const base = msg.data.route === "scheduler" ? "alarm" : msg.data.route === "tool" ? "tool" : "robot"; baseLogoModeRef.current = base; setLogoMode(base); } // 응답 기다리는 중 상태 복원 (재연결 시)
					if (msg.data.model) { const m = msg.data.model; setCurrentModel(m.provider ? `${m.provider}/${m.name || m.id}` : (m.name || m.id || "")); supportedThinkingLevelsRef.current = m.thinkingLevelMap ? THINKING_ORDER.filter(k => (m.thinkingLevelMap as any)[k] != null) : (m.reasoning ? ["off", "high"] : ["off"]); }
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
					// 새로고침 복원: 스트리밍 중이면 lastPrompt로 입력창 복원
					if (msg.data.isStreaming === true && msg.data.lastPrompt) {
						// systemPrompt가 앞에 붙어있으면 제거 — userInput 분리 미반영 시에도 순수 사용자 입력만 복원
						const { rows: r, cols: c } = gridRef.current;
						const sp = systemPrompt(r, c);
						const lp = msg.data.lastPrompt;
						setInput(lp.startsWith(sp) ? lp.slice(sp.length).replace(/^\n+/, "") : lp);
					}
				}
				if (msg.command === "schedule") {
						// schedule 명령 결과 → list 결과는 즉시 자동 재주입, 그 외는 다음 프롬프트에 주입
						if (msg.success) {
							const feedback = msg.data?.text ?? null;
							if (feedback) {
								// list 결과를 자동으로 LLM에 재주입 → 즉시 렌더링 (사용자 재요청 불필요)
								schedulerFeedbackRef.current = null;
								sendPrompt(feedback, "tool");
							} else {
								schedulerFeedbackRef.current = null;
								}
						} else {
							schedulerFeedbackRef.current = `[스케줄 오류] ${msg.error}`;
						}
					}
				if (msg.command === "set_model" && msg.success) {
					// 모델 변경 후 헤더 갱신 — get_state 응답(갱신 완료)까지 dim 유지
					pendingModelUpdateRef.current = true;
					wsRef.current?.send(JSON.stringify({ type: "get_state" }));
					wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
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
					availableModels.current = [...msg.data.models].sort((a, b) => {
						const ka = `${a.provider}/${a.name || a.id}`;
						const kb = `${b.provider}/${b.name || b.id}`;
						return ka < kb ? -1 : ka > kb ? 1 : 0;
					});
					modelPage.current = 0;
					renderModelGrid();
				}
				break;

			case "scheduler_trigger":
				// 백엔드 주입 직전 서버가 전송 → 다음 agent_end 응답에 prefix 부착
				schedulerTriggerRef.current = { ids: msg.ids, whens: msg.whens };
				console.log("[debug] scheduler_trigger 수신", msg.ids);
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
	const sendPrompt = useCallback((userText: string, route: "user" | "tool" = "user") => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !piReady) return;
		userSentRef.current = true; // 사용자 전송 — agent_end 시 클리어

		const { rows: r, cols: c } = gridRef.current;
		let message = userText;

		// 스케줄러 피드백(에러/목록)이 대기 중이면 프롬프트 앞에 주입
		if (schedulerFeedbackRef.current) {
			message = `${schedulerFeedbackRef.current}\n\n${message}`;
			schedulerFeedbackRef.current = null;
		}

		// 시스템 지시: 세션 최초 1회만 부착 (RPC 세션은 컨텍스트 유지, 매 턴 부착은 중복)
		if (!modelMode.current && !sessionInitRef.current) {
			message = `${systemPrompt(r, c)}\n\n${message}`;
			sessionInitRef.current = true;
		}

		ws.send(JSON.stringify({ type: "prompt", message, userInput: userText, route }));
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
				ws.send(JSON.stringify({ type: "restart_pi" }));
				sessionInitRef.current = false;
				setState(emptyState(gridRef.current.rows, gridRef.current.cols));
				clearInput();
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
				setModelChanging(true);
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

	const statusText = !connected ? "연결 끊김" : !piReady ? "세션 초기화 중" : showThinking ? "사고중" : loading ? "생성중" : "준비";

	const cycleThinking = () => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !piReady) return;
		// 클라이언트 사이클: model.thinkingLevelMap 기반 지원 레벨 순환
		const order = supportedThinkingLevelsRef.current;
		const idx = order.indexOf(thinkingLevelRef.current);
		const next = order[(idx + 1) % order.length] ?? "off";
		ws.send(JSON.stringify({ type: "set_thinking_level", level: next }));
	};

	return (
		<div className="turk-app" style={!restored || modelChanging ? { pointerEvents: "none" } : undefined}>
			<header className="turk-header" style={!restored || modelChanging || loading || !piReady ? { pointerEvents: "none" } : undefined}>
				<h1 title={statusText}>{logoMode === "tool" ? <Settings className="turk-ico turk-ico-green turk-bot-spin-slow" style={{ width: "1.1em", height: "1.1em" }} /> : logoMode === "alarm" ? <AlarmClock className="turk-ico turk-ico-green turk-bot-tick" style={{ width: "1.3em", height: "1.3em" }} /> : <Bot className={"turk-ico " + (!connected ? "turk-ico-red" : !piReady ? "turk-ico-amber" : "turk-ico-green") + (!restored || modelChanging || loading || !piReady ? " turk-bot-spin" : "")} />} AI-Turk<sub className="turk-backend">{backendKind}</sub></h1>
				<span className="turk-mode">
				<button className="turk-schedule-btn" onClick={() => handleSend("현재 스케줄 목록을 보여줘")} title="스케줄 관리"><AlarmClock className="turk-ico" /></button>
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
				}} title={currentModel || "모델 선택"}>{(currentModel.split("/").pop() || currentModel) || "모델 선택"}</button> <button className="turk-thinking-btn" onClick={cycleThinking} style={{ color: (supportedThinkingLevelsRef.current.filter(k => k !== "off").length === 0 || thinkingLevel === "off") ? "var(--muted-foreground)" : "var(--success)" }} title={`씽킹 레벨 순환: ${thinkingLevel}`}><Sparkles className="turk-ico" />{supportedThinkingLevelsRef.current.filter(k => k !== "off").length === 0 ? "NONE" : thinkingLevel.toUpperCase()}</button> <button className="turk-new-btn" onClick={() => {
				if (!confirm("새 세션을 시작할까요?")) return;
				const ws = wsRef.current;
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "restart_pi" }));
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
				<div className="turk-session-debug" onClick={() => navigator.clipboard?.writeText(`userKey: ${TURK_USER_KEY} | agentSessionId: ${sessionId}`)} style={{ position: "absolute", top: "0.25rem", right: "0.4rem", fontSize: "10px", opacity: 0.4, fontFamily: "\"NeoDunggeunmo\", monospace", lineHeight: 1, cursor: "pointer", userSelect: "none", zIndex: 5 }}>
					{TURK_USER_KEY.slice(-6)}|{sessionId ? sessionId.slice(-6) : "—"}
				</div>
				<button className="turk-copy-btn" onClick={() => { navigator.clipboard?.writeText(state.message).then(() => { const b = document.querySelector(".turk-copy-btn"); if (b) { b.classList.add("turk-copy-done"); setTimeout(() => b.classList.remove("turk-copy-done"), 800); } }); }} title="마크다운 복사"><Copy className="turk-ico" /></button>
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
					ref={inputRef}
					className="turk-input-field"
					title="메시지 입력"
					enterKeyHint="send"
					inputMode="text"
					value={input}
					onChange={(e) => { setInput(e.target.value); localStorage.setItem("turk-input", e.target.value); }}
					placeholder={piReady ? "명령어 입력..." : "세션 초기화 중..."}
					disabled={loading || !piReady}
					autoFocus={false}
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
			{(!restored || modelChanging || loading || !piReady) && <div className="turk-dim-overlay" />}
		</div>
	);
}