import { useState, useCallback, useRef, useEffect } from "react";
import { Bot, ChevronUp, ChevronDown, Sparkles, Wrench, AlarmClock, Copy, Settings, Paperclip, Menu } from "lucide-react";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./lib/agents-md";
import {
	TURK_USER_KEY, resolveUserKey, reflectUserKey, uuidv4Fallback,
	emptyState, errState, extractAssistantText, parseTurkJSON,
	ensurePush, discardPush, Md,
} from "./lib/turk";
import type { TurkState, ToolStatus } from "./lib/turk";
import { kvSet, kvGet } from "./lib/storage";
import ConversationDrawer from "./components/ConversationDrawer";

// 모바일(터치) 감지 — 모바일에서는 자동 포커스로 가상 키보드 자동 노출 방지
const IS_FINE_POINTER = typeof window !== "undefined" && window.matchMedia?.("(hover: hover) and (pointer: fine)")?.matches === true;

// ── 앱 ─────────────────────────────────────────────────────────────────
export default function App() {
	const rows = DEFAULT_ROWS;
	const cols = DEFAULT_COLS;
	const [state, setRawState] = useState<TurkState>({ message: "", buttons: Object.fromEntries(Array.from({ length: DEFAULT_ROWS * DEFAULT_COLS }, (_, i) => [String(i), ""])) });
	const gridVerRef = useRef(0);
	const msgVerRef = useRef(0);
	const setState = useCallback((next: TurkState | ((prev: TurkState) => TurkState)) => {
		setRawState((prev: TurkState) => {
			const newState = typeof next === "function" ? next(prev) : next;
			if (newState.message !== prev.message) msgVerRef.current = msgVerRef.current ? 0 : 1;
			return newState;
		});
		gridVerRef.current = gridVerRef.current ? 0 : 1;
	}, []);

	// 최종 화면 커밋 — 과도 뷰(모델 선택/세션 상세)는 이것을 쓰지 않음 (히스토리 기능 제거 — setState 별칭)
	const commit = useCallback((next: TurkState) => setState(next), [setState]);
	const [loading, setLoading] = useState(false);
	const clearInput = () => { draftEchoRef.current = false; setInput(""); };
	const [input, setInput] = useState(() => {
		// 초기값은 빈 문자열 — 마운트 직후 kvGet(draft:<userKey>)으로 저장 초안 복원 (아래 초안 지속성 블록)
		return "";
	});

	// ── 파일 첨부 — 서버가 워크스페이스 uploads/에 저장, 프롬프트에 경로 주입 (에이전트 read 도구로 읽음) ──
	const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
	const attachRef = useRef(attachments);
	attachRef.current = attachments;
	const fileInputRef = useRef<HTMLInputElement | null>(null);
	const pendingFilesRef = useRef<{ name: string; data: string; mimeType: string }[]>([]); // 연결 대기 첨부 큐 — 준비되면 자동 전송
	const flushPendingFiles = () => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !pendingFilesRef.current.length) return;
		for (const f of pendingFilesRef.current) ws.send(JSON.stringify({ type: "attach", name: f.name, data: f.data, mimeType: f.mimeType }));
		pendingFilesRef.current = [];
	};
	const handleFiles = (files: FileList | null) => {
		if (!files?.length) return;
		for (const f of [...files].slice(0, 5)) {
			if (f.size > 50 * 1024 * 1024) { alert(`파일이 너무 큽니다: ${f.name} (최대 50MB)`); continue; }
			const reader = new FileReader();
			reader.onload = () => {
				const data = String(reader.result).split(",")[1] ?? "";
				const ws = wsRef.current;
				if (ws && ws.readyState === WebSocket.OPEN && piReady) {
					ws.send(JSON.stringify({ type: "attach", name: f.name, data, mimeType: f.type }));
				} else {
					pendingFilesRef.current.push({ name: f.name, data, mimeType: f.type }); // 재연결 후 자동 첨부
				}
			};
			reader.readAsDataURL(f);
		}
	};

	// ── 대화 드로어 (Phase 3) — 열림 상태만 소유. 목록·폴링·비번 모달은 ConversationDrawer 내부 ──
	const [drawerOpen, setDrawerOpen] = useState(false);

	// WebSocket 상태
	const [connected, setConnected] = useState(false);
	const [piReady, setPiReady] = useState(false);
	const [restored, setRestored] = useState(false); // 초기화 상태 복원 완료 여부
	const [modelChanging, setModelChanging] = useState(false); // 모델 변경 중 (지원 레벨/컨텍스트 갱신)
	const pendingModelUpdateRef = useRef(false); // set_model → get_state 응답 매칭
	const userSentRef = useRef(false); // 사용자 전송 → agent_end 시 입력창 클리어 (스케줄러 응답은 유지)
	const [logoMode, setLogoMode] = useState<"robot" | "alarm" | "tool">("robot");
	const baseLogoModeRef = useRef<"robot" | "alarm" | "tool">("robot"); // 톨 종료 후 복귀용

	const [sessionId, setSessionId] = useState("");
	// 드래프트(#new) 모델 시딩 — 1순위: 시작시 지정 계약(서버 TURK_PI_MODEL — pi_ready.defaultModel로 캐시).
	// 새 대화의 실제 시작 모델이 이 값이므로 표시=진실. 미수집(최초 방문 등)은 2순위 마지막 사용 모델 → 빈값.
	// 대화 진입은 합성/라이브 get_state.model이 우선 덮고, 드래프트 직접 선택(pendingModel)도 setCurrentModel로 덮음.
	const [currentModel, setCurrentModel] = useState<string>(() => {
		try { return localStorage.getItem("turk-default-model") ?? localStorage.getItem("turk-last-model") ?? ""; } catch { return ""; }
	});
	// 마지막 씽킹 레벨 — 동일 시딩 관례: 드래프트 부팅 표시. 대화 진입은 합성/라이브 get_state.thinkingLevel이 우선 덮음.
	const seedThinking = (() => { try { return localStorage.getItem("turk-last-thinking") ?? ""; } catch { return ""; } })();
	const currentModelRef = useRef("");
	currentModelRef.current = currentModel;

	// 씽킹 레벨 (부팅은 localStorage 시딩 — 드래프트 표시·모델 미지원이면 토글이 정정) — 모델이 지원하는 레벨만 순환 (cycle_thinking_level)
	const [thinkingLevel, setThinkingLevel] = useState<string>(seedThinking || "off");
	const [contextPct, setContextPct] = useState<number | null>(null);
	// ── 현재 대화 스케줄 개수 — 헤더 시계 녹색·sub 표시 원료 ──
	// 갱신점: pi_ready(복원)·agent_end(스케줄 등록/삭제 턴 직후)·scheduler_trigger(발화 소진) — /api/conversations 1회 판독.
	const [schedCount, setSchedCount] = useState(0);
	const refreshSchedCount = () => {
		if (!userKeyRef.current) { setSchedCount(0); return; } // 드래프트 — 스케줄 없음
		fetch("/api/conversations").then((r) => r.ok ? r.json() : null).then((j: unknown) => {
			if (Array.isArray(j)) { const c = (j as any[]).find((x: any) => x?.id === userKeyRef.current); setSchedCount(c?.scheduleCount ?? 0); }
		}).catch(() => { /* 무시 — 다음 갱신점이 재시도 */ });
	};
	const thinkingLevelRef = useRef("off");
	const supportedThinkingLevelsRef = useRef<string[]>(["off"]); // model.thinkingLevelMap 기반 지원 레벨
	thinkingLevelRef.current = thinkingLevel;
	// OFF 순환 감지용: 첫 켜진 레벨(firstLevel)에 다시 도달하면 OFF로
	const firstThinkingLevelRef = useRef<string | null>(null);
	const thinkingCycleHitsRef = useRef(0);
	const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

	// 스트리밍 상태 (내부 추적용 — UI에 직접 표시하지 않음)
	const [, setStreamingText] = useState("");
	const [thinkingText, setThinkingText] = useState(""); // 상태 레이어 — 씽킹/컴팩트 등 트랜지언트 출력 (메인 출력과 분리)
	const [showThinking, setShowThinking] = useState(false);
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const stripRef = useRef<HTMLDivElement>(null);
	useEffect(() => { if (stripRef.current) stripRef.current.scrollTop = stripRef.current.scrollHeight; }, [thinkingText]);
	const [toolStatus, setToolStatus] = useState<ToolStatus | null>(null);
	const [keyboardUp, setKeyboardUp] = useState(false);
	const [kbHeight, setKbHeight] = useState(0);


	// 스트리밍 텍스트 누적 (agent_end의 messages가 비었거나 잘렸을 때 fallback용)
	const streamingTextRef = useRef("");
	// 파싱 실패 자가수정은 서버 전담 (WS 유무 무관 — 위반 원문+에러 되돌려 재시도 주입) — 클라 카운터 제거
	const answerToRef = useRef<string | null>(null); // 현재 턴의 질문 — 응답 상단 짝표시용
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
	// userKey — 가변 상태, null(드래프트) 허용. 첫 메시지가 키를 발급·승격한다 (ChatGPT 모델 — 새 대화=첫 페이지).
	// 해시 전환은 풀리로드(onHashChange) 계약이라 런타임 재설정은 드래프트→대화 승격(setUserKey)뿐.
	const [userKey, setUserKey] = useState<string | null>(TURK_USER_KEY);
	const userKeyRef = useRef<string | null>(userKey);
	userKeyRef.current = userKey; // 매 렌더링 동기화 (handleSend 드래프트 분기는 렌더 대기 없이 직접 갱신도 병행)
	const wsRef = useRef<WebSocket | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const isDraft = userKey === null; // 드래프트 — 첫 메시지 전까지 대화(userKey·WS) 없음
	// ── 드래프트 첫 메시지 파이프라인 ──
	// 초안 슬롯 이름 — userKey null(드래프트)은 "new" 슬롯 공유 (draft:null 금지)
	const draftSlot = (k: string | null) => `draft:${k ?? "new"}`;
	const pendingFirstMessageRef = useRef<string | null>(null); // 드래프트 원래 입력 — 첫 pi_ready(셸 합성)에서 플러시
	const pendingFirstAttachRef = useRef(0); // 첫 메시지에 갈 보류 첨부의 미도착 응답 수 — 0이 되면 전송 (경로 주입 성립)
	const pendingModelRef = useRef<any>(null); // 드래프트 모델 선택 보류 — 첫 pi_ready 체인에서 set_model
	const pendingThinkingLevelRef = useRef<string | null>(null); // 드래프트 씽킹 보류 — 첫 pi_ready 체인에서 set_thinking_level

	// ── 입력 초안 지속성 — 백그라운드 탭 폐기/새로고침에도 미전송 초안 보존 ──
	// 복귀 시 WS 재연결(get_state)은 초안을 보호하지만(userSentRef 가드), 안드로이드가 백그라운드
	// 탭을 폐기해 페이지가 재로드되면 React 상태가 통째로 사라진다 → 초안을 IndexedDB에 저장·복원.
	const inputValRef = useRef(input);
	inputValRef.current = input;
	const draftEchoRef = useRef(true); // 필드 내용이 유저 초안이 아니라 전송 프롬프트 에코(lastPrompt 복원·버튼 fill+send)면 true — 초안 저장 금지
	const draftLoadedRef = useRef(false); // 초기 로드 완료 전 저장 금지 (빈 값이 저장본을 덮어쓰는 레이스 방지)
	const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// 복원 — userKey 확정 시점(마운트/hash 전환)에 저장 초안 로드. 필드가 이미 채워져 있으면 현 입력 보호.
	useEffect(() => {
		draftLoadedRef.current = false;
		kvGet(draftSlot(userKey)).then((d) => {
			if (d && !inputRef.current?.value) { draftEchoRef.current = false; setInput(d); }
		}).catch(() => { /* 무시 */ }).finally(() => { draftLoadedRef.current = true; });
	}, [userKey]);
	// 저장 — input 변경(타이핑·프로그램matic set·clearInput 모두)을 250ms 디바운스 저장.
	// 전송 완료 후 클리어("")도 저장되어 낡은 초안이 남지 않음.
	useEffect(() => {
		if (!draftLoadedRef.current || draftEchoRef.current) return; // 에코(전송 프롬프트)는 저장 안 함 — 유저 초안만 유지
		clearTimeout(draftTimerRef.current);
		draftTimerRef.current = setTimeout(() => { kvSet(draftSlot(userKey), input).catch(() => { /* 무시 */ }); }, 250);
		return () => clearTimeout(draftTimerRef.current);
	}, [input, userKey]);
	// 즉시 flush — 백그라운드 진입(pagehide/visibilitychange hidden) 순간 타이머를 기다리지 않고 확정 저장
	// (폐기 직전 마지막 키 입력까지 보존 — 디바운스 대기 중 폐기되는 케이스 차단)
	useEffect(() => {
		const flush = () => {
			if (!draftLoadedRef.current || draftEchoRef.current) return;
			clearTimeout(draftTimerRef.current);
			kvSet(draftSlot(userKeyRef.current), inputValRef.current).catch(() => { /* 무시 */ });
		};
		const onVis = () => { if (document.hidden) flush(); };
		window.addEventListener("pagehide", flush);
		document.addEventListener("visibilitychange", onVis);
		return () => { window.removeEventListener("pagehide", flush); document.removeEventListener("visibilitychange", onVis); };
	}, []);
	const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const shouldReconnect = useRef(true);
	const lastMsgAtRef = useRef(Date.now()); // 마지막 서버 수신 시각 — 워치독 좀비 판정 기준
	const pendingReconnectRef = useRef(false); // 재연결 예약 플래그 — 이중 예약/워치독 충돌 방지
	const showSessionDetail = useRef(false);
	// 배타적 메뉴 모드 — 한 번에 하나의 메뉴만 열림 (none | model | ctx).
	// prevStateRef는 최초 진입 시 1회 저장, 메뉴 간 전환 시 유지 → 취소는 항상 원래 화면 복원
	const menuMode = useRef<"none" | "model" | "ctx">("none");
	// 모델 선택 진입 전 UI 상태(이전 메시지/버튼) 저장용
	const prevStateRef = useRef<TurkState | null>(null);
	const availableModels = useRef<any[]>([]);
	const modelsFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); // get_available_models 무응답 캐시 폴백 타이머 (응답 도착 시 해제)
	const modelPage = useRef(0);
	const recentModelsRef = useRef<string[]>([]); // 최근 선택 모델 (provider/name 최신순 최대 3개)
	const MODELS_PER_PAGE = DEFAULT_ROWS * DEFAULT_COLS - 3; // 나머지 3칸은 이전/다음/취소
	const reconnectDelay = useRef(1000);
	const gridRef = useRef({ rows: DEFAULT_ROWS, cols: DEFAULT_COLS });
	gridRef.current = { rows, cols };

	// handleEvent stale closure 방지: 항상 최신 콜백 참조
	const handleEventRef = useRef<(msg: any) => void>(() => {});

	// ── WebSocket 연결 ──────────────────────────────────────────────────
	const connect = useCallback(() => {
		// 드래프트 게이트 — 연결 시도 없음 (워치독·onVisible이 호출해도 조용히 no-op).
		// 단 UI 게이트(입력·버튼·디밍)는 통과해야 첫 메시지를 받을 수 있다 — piReady·restored를 '준비'로 유지.
		if (!userKeyRef.current) { setConnected(false); setPiReady(true); setRestored(true); return; }
		// 스테일 소켓 정리 — CONNECTING/OPEN인 이전 소켓 핸들러 분리 후 close (중복 소켓 방지)
		const stale = wsRef.current;
		if (stale && stale.readyState !== WebSocket.CLOSED) {
			stale.onopen = null; stale.onclose = null; stale.onmessage = null; stale.onerror = null;
			try { stale.close(); } catch { /* 무시 */ }
		}
		const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws?u=${userKeyRef.current}`;
		const ws = new WebSocket(wsUrl);
		wsRef.current = ws;
		shouldReconnect.current = true;
		pendingReconnectRef.current = false;
		lastMsgAtRef.current = Date.now();

		// 재시도 콜백 — visible 상태에서만. 백그라운드에서는 어떤 시도도 하지 않는다:
		// 복귀(visibilitychange visible) 시 onVisible이 항상 신규 연결을 만들므로 백그라운드 보류 루프는 불필요.
		const retry = () => {
			if (document.hidden) return; // 백그라운드 — 시도 없음, 복귀 시 onVisible이 재수립
			pendingReconnectRef.current = false;
			connect();
		};

		ws.onopen = () => { setConnected(true); reconnectDelay.current = 1000; lastMsgAtRef.current = Date.now(); };

		ws.onclose = (ev) => {
			setConnected(false);
			setPiReady(false);
			if (pendingFirstMessageRef.current != null) pendingFirstAttachRef.current = 0; // 첫 메시지 대기 중 접속 끊김 — 첨부 대기 중단 (다음 연결에서 경로 없이도 전송 — 유실 방지)
			if (!shouldReconnect.current || pendingReconnectRef.current) return;
			if (document.hidden) return; // 백그라운드 종료 — 예약 없음. 복귀 시 onVisible이 즉시 신규 연결
			console.debug(`[WS] 종료 code=${ev.code} — ${reconnectDelay.current}ms 후 재연결`);
			pendingReconnectRef.current = true;
			reconnectTimer.current = setTimeout(retry, reconnectDelay.current);
			reconnectDelay.current = Math.min(reconnectDelay.current * 2, 10000);
		};

		ws.onerror = () => ws.close();

		ws.onmessage = (ev) => {
			lastMsgAtRef.current = Date.now();
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
			pendingReconnectRef.current = false;
			clearTimeout(reconnectTimer.current);
			clearTimeout(modelsFallbackTimerRef.current); // 폴백 타이머 정리
			wsRef.current?.close();
		};
	}, [connect]);

	// ── WS 워치독 — 좀비 소켓/타이머 소실 자가 치유 (최후 방어선) ──
	// 서버 WS ping은 JS에 보이지 않아 앱레벨 ping/pong으로 무응답을 판정한다.
	// 40s 무응답 = 좀비 → 강제 재연결. CLOSED인데 예약 없음 → 즉시 연결.
	// (백그라운드 응답 완료 후 복귀 시 빨간대기 고정 → 새로고침만 답이던 버그의 근본 차단)
	useEffect(() => {
		const iv = setInterval(() => {
			if (document.hidden) return;
			const ws = wsRef.current;
			if (!ws || ws.readyState === WebSocket.CLOSED) {
				if (!pendingReconnectRef.current) connect();
				return;
			}
			if (ws.readyState !== WebSocket.OPEN) return; // CONNECTING — 핸드셰이크 진행 중
			const silent = Date.now() - lastMsgAtRef.current;
			if (silent > 40000) {
				console.debug("[WS] 워치독: 40s 무응답 — 좀비 소켓 강제 재연결");
				ws.onopen = null; ws.onclose = null; ws.onmessage = null; ws.onerror = null;
				try { ws.close(); } catch { /* 무시 */ }
				wsRef.current = null;
				connect();
			} else if (silent > 15000) {
				try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* 무시 */ }
			}
		}, 5000);
		return () => clearInterval(iv);
	}, [connect]);

	// 백그라운드 진입 시 WS를 능동 종료, 포그라운드 복귀 시 항상 신규 연결 + 상태 동기화.
	// (좀비 소켓 — readyState OPEN이지만 TCP 사실상 단절 — 오판을 근본 제거. 복귀 = 새로고침과 동일 경로)
	useEffect(() => {
		const onVisible = () => {
			if (document.hidden) {
				clearTimeout(reconnectTimer.current);
				pendingReconnectRef.current = false;
				const old = wsRef.current;
				// 핸들러 분리 후 close — freeze로 지연된 onclose가 복귀 후(visible) 발화해
				// 유령 재연결 타이머를 만드는 레이스 제거 (visible 분기와 대칭)
				if (old) { old.onopen = null; old.onclose = null; old.onmessage = null; old.onerror = null; old.close(); }
				return;
			}
			clearTimeout(reconnectTimer.current);
			reconnectDelay.current = 1000;
			const old = wsRef.current;
			if (old) { old.onclose = null; old.onmessage = null; old.onerror = null; old.close(); }
			connect(); // pi_ready → get_state(작동중 동기화)
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [connect]);

	// ── URL hash 런타임 변경 → 세션 전환 (링크 공유/복귀) ─────────────────
	// 해시 편집·뒤로가기 시 풀리로드 — Chrome same-document 전환은 document.title 갱신이
	// 히스토리 엔트리·즐겨찾기 다이얼로그에 새로 커밋이 아니라고 반영 안 되는 동작이 있어서(이전 타이틀로 즐겨찾기 저장),
	// 재로드로 새 커밋을 만들어 부트 스크립트(index.html)가 주소·타이틀을 즉시 확정한다.
	// 재로드 부트가 해시에서 다시 읽으므로 재귀 루프 없음.
	useEffect(() => {
		const onHashChange = () => {
			const next = resolveUserKey();
			if (next === userKeyRef.current) return; // 동일 키 → 무시
			location.reload();
		};
		window.addEventListener("hashchange", onHashChange);
		return () => window.removeEventListener("hashchange", onHashChange);
	}, []);

	// 최초 진입 userKey를 URL hash에 반영 — 드래프트(null)는 미반영 (#new·루트 그대로, 개인 키 유출 없음)
	useEffect(() => { reflectUserKey(userKeyRef.current); }, []);

	// 드래프트 — get_state 복원 경로가 없다(WS 없음) → 환영 화면을 직접 주입 (빈 메시지 화면 방지)
	useEffect(() => {
		if (!userKeyRef.current) setState(emptyState(rows, cols));
	}, []);

	// 탭 타이틀은 부트 스크립트(index.html)가 "Turk"로 고정 (261010 — 루트 즐겨찾기·채널명 타이틀 제거)

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
				flushPendingFiles(); // 연결 대기 중 선택된 파일 자동 첨부
				sendFirstMessage(); // 드래프트 첫 메시지 플러시 — 셸 합성 pi_ready에서 즉시 원래 입력을 첫 프롬프트로 (보류 첨부 응답 대기 중이면 attach 응답에서 전송)
				// 웹 푸시 등록 — 캐시가 단일 진원:
				// ① 캐시가 현재 VAPID 키와 일치 → 동기 즉시 재전송 (SW를 건드리지 않음 — unsubscribe 레이스 없음)
				// ② 캐시 없음/키 불일치 → 전체 재구독 (in-flight 가드; 성공 시 캐시 갱신 → 이후는 ① 경로)
				if (typeof msg.vapidPublicKey === "string") ensurePush(msg.vapidPublicKey, wsRef.current);
				if (typeof (msg as any).defaultModel === "string" && (msg as any).defaultModel) { try { localStorage.setItem("turk-default-model", (msg as any).defaultModel); } catch { /* 무시 */ } } // 시작시 지정 계약(TURK_PI_MODEL) 캐시 — 드래프트 시딩 1순위
				// 상태 복원: get_state 응답 대기 — 복원 전까지 dim (last-assistant-text는 브라우저 localStorage)
				setRestored(false);
				wsRef.current?.send(JSON.stringify({ type: "get_state" }));
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				refreshSchedCount();
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
			case "push_invalid":
				// 서버 푸시 전송이 410/404 (구독 무효) — 브라우저 구독도 폐기 → 다음 pi_ready에서 신규 등록
				discardPush();
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
				refreshSchedCount(); // 스케줄 등록/삭제 턴 직후 반영
				// willRetry가 true면 곧 재시도할 예정 — 아직 최종 응답이 아님. 로딩 유지.
				if (msg.willRetry) {
					break;
				}
				// 응답 실패 명시 정의 — agent_end.error: 실패 화면 + 입력 유지(재시도 대상)
				if (msg.error) {
					setLoading(false);
					setLogoMode("robot");
					setToolStatus(null);
					setShowThinking(false);
					setThinkingText(""); // dim 해제 = 클리어 (통일)
					userSentRef.current = false; // 실패 턴 — clearInput 생략 (입력 유지)
					schedulerPrefixRef.current = null;
					wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
					setState({ ...errState(`⚠️ 응답 실패: ${String(msg.error).slice(0, 200)}`, gridRef.current.rows, gridRef.current.cols), answerTo: answerToRef.current ?? undefined });
					break;
				}
				// 취소로 종료된 턴(stopReason "aborted") — 자가수정 재요청 금지 + 부분 출력 커밋 금지.
				// 취소 의도 우선: dim 해제, 이전 화면 유지, 입력(에코)은 남겨 수정·재전송 가능하게
				if (Array.isArray(msg.messages) && msg.messages.some((m: any) => m.role === "assistant" && m.stopReason === "aborted")) {
					setLoading(false);
					setLogoMode("robot");
					setToolStatus(null);
					setShowThinking(false);
					setThinkingText(""); // dim 해제 = 클리어 (통일)
					userSentRef.current = false; // 취소 턴 — 입력 클리어 생략(에코 유지), 이후 agent_end 오염 방지
					schedulerPrefixRef.current = null;
					wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
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
					answerToRef.current = `⏰ 예약 실행 (${trig.ids.join(",")})`; // 짝표시
				}
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				setToolStatus(null);
				setShowThinking(false);
				setThinkingText(""); // 턴 종료 — 씽킹 스트립 클리어
				// 1차: agent_end의 messages에서 텍스트 추출
				let text = msg.messages?.length ? extractAssistantText(msg.messages) : "";
				// 2차(fallback): messages가 비었거나 파싱 실패 시 스트리밍 누적본 사용
				if (!text) text = streamingTextRef.current;
				if (text) {
					const result = parseTurkJSON(text);
					if (result && "parsed" in result) {
						const parsed = result.parsed;
						parsed.answerTo = answerToRef.current ?? undefined; // 짝표시 부착
						// schedules는 서버가 agent_end에서 직접 스케줄러에 적용 (릴레이 제거 — 백그라운드 트리거 체이닝 보존)
						// silent: 사용자에게 미표시
						if (parsed.silent === true) {
							if (schedulerPrefixRef.current) schedulerPrefixRef.current = null;
							return;
						}
						// 화면 표시
						if (Array.isArray(parsed.schedules)) {
							const { schedules, ...stateWithoutSchedules } = parsed;
							if (schedulerPrefixRef.current) {
								stateWithoutSchedules.message = schedulerPrefixRef.current + (stateWithoutSchedules.message || "");
								schedulerPrefixRef.current = null;
							}
							commit(stateWithoutSchedules);
						} else {
							if (schedulerPrefixRef.current) {
								parsed.message = schedulerPrefixRef.current + (parsed.message || "");
								schedulerPrefixRef.current = null;
							}
							commit(parsed);
						}
					} else {
						// 스트리밍본으로 한 번 더 시도 (messages가 잘렸을 수 있음)
						const fallback = streamingTextRef.current && streamingTextRef.current !== text
							? parseTurkJSON(streamingTextRef.current)
							: null;
						if (fallback && "parsed" in fallback) {
							const parsed = fallback.parsed;
							parsed.answerTo = answerToRef.current ?? undefined; // 짝표시 부착
							// schedules는 서버가 agent_end에서 직접 스케줄러에 적용 (릴레이 제거 — 백그라운드 트리거 체이닝 보존)
							// silent: 사용자에게 미표시
							if (parsed.silent === true) {
								if (schedulerPrefixRef.current) schedulerPrefixRef.current = null;
								return;
							}
							if (Array.isArray(parsed.schedules)) {
								const { schedules, ...stateWithoutSchedules } = parsed;
								if (schedulerPrefixRef.current) {
									stateWithoutSchedules.message = schedulerPrefixRef.current + (stateWithoutSchedules.message || "");
									schedulerPrefixRef.current = null;
								}
								commit(stateWithoutSchedules);
							} else {
								if (schedulerPrefixRef.current) {
									parsed.message = schedulerPrefixRef.current + (parsed.message || "");
									schedulerPrefixRef.current = null;
								}
								commit(parsed);
							}
						} else {
							// 자가수정은 서버 전담 (261008 — 클라 전담 시절 백그라운드 WS 끊김 턴의 위반 응답이
							// 무보정·무기록으로 유실됨). willRetry=true agent_end에서 서버가 위반 원문+에러를
							// 되돌려 route tool 재시도 주입 → agent_start가 이어 받아 dim 유지. 소진 시 agent_end.error로 마감.
						}
					}
				} else if (!loading) {
					// 응답 텍스트 자체가 없는 경우 (도구만 사용 등)
					schedulerPrefixRef.current = null; // prefix 클리어
					// (빈 텍스트 응답도 서버 자가수정(그리드 정리 재시도)이 이어 처리)
				}
				break;
			}

			case "message_update": {
				const delta = msg.assistantMessageEvent;
				if (!delta) break;
				if (delta.type === "thinking_start") {
					setShowThinking(true);
				} else if (delta.type === "thinking_delta") {
					setThinkingText((prev) => prev + (delta.delta || "")); // 상태 스트립에 스트리밍
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
				if (msg.command === "compact" && !msg.success) {
					setLoading(false); // 안전 해제 — compaction_end 누락 대비
					setThinkingText(""); // dim 해제 = 클리어 (통일)
				}
				if (msg.command === "attach") {
					// 업로드 완료 → 칩 추가 (경로는 서버가 부여)
					if (msg.success && msg.data?.path) setAttachments((prev) => [...prev, { name: msg.data.name, path: msg.data.path }].slice(-5));
					else console.warn("[Attach] 업로드 실패:", msg.error);
					// 드래프트 첫 메시지 대기 중 — 보류 첨부 응답이 하나 도착할 때마다 감쇠 → 전수 도착 시 전송 (경로 주입 성립)
					if (pendingFirstMessageRef.current != null && pendingFirstAttachRef.current > 0) {
						pendingFirstAttachRef.current--;
						sendFirstMessage();
					}
				}
				if (msg.command === "new_session" && msg.success) {
					wsRef.current?.send(JSON.stringify({ type: "get_state" }));
					wsRef.current?.send(JSON.stringify({ type: "get_session_stats" }));
				}
				if (msg.command === "get_state" && msg.success && msg.data) {
					if (pendingModelUpdateRef.current) { pendingModelUpdateRef.current = false; setModelChanging(false); } // 모델 변경 완료 — 지원 레벨/컨텍스트 갱신됨
					if (msg.data.sessionId) {
						setSessionId(msg.data.sessionId);
						// 응답 실패 명시 — 마지막 턴 실패 시 실패 화면 (입력 유지).
						// 단 서버가 이미 다음 턴을 스트리밍 중이면 실패 화면 생략 (이전 턴의 실패 — dim 우선)
						if ((msg.data as any).lastTurnFailed === true && msg.data.isStreaming !== true) {
							// 실패 복원 — 서버 버퍼에 남은 이전 입력(lastPrompt)을 짝 캡션으로
							const lp = (msg.data as any).lastPrompt;
							setState({ ...errState("⚠️ 응답이 실패했습니다. 입력을 다시 전송해주세요.", gridRef.current.rows, gridRef.current.cols), answerTo: typeof lp === "string" && lp ? lp : undefined });
						} else {
							// 복원은 서버 lastResponse 단일 채널 (클라 IndexedDB 캐시 제거됨)
							const lr = (msg.data as any).lastResponse;
							const lrText = lr && Array.isArray(lr.messages) ? extractAssistantText(lr.messages) : "";
							const lrRes = lrText ? parseTurkJSON(lrText) : null;
							if (lrRes && "parsed" in lrRes && lrRes.parsed.silent !== true) {
								commit({ ...lrRes.parsed, answerTo: (msg.data as any).lastResponsePrompt ?? undefined }); // 서버 짝 정보
								// setLoading(false) 금지 — loading은 동기 isStreaming 분기가 소유.
								// 재연결 시 서버가 스트리밍/씽킹중면 dim이 유지되어야 함 (이전 커밋화면은 dim 아래)
							} else {
								// lastResponse 없음(실패/빈 응답/서버 재시작) — 이전 입력(lastPrompt) 있으면 짝 캡션으로, 없으면 웰컴 제목(🤖 Turk) 유지
								const lp = (msg.data as any).lastPrompt;
								setState({ ...emptyState(gridRef.current.rows, gridRef.current.cols), ...(typeof lp === "string" && lp ? { answerTo: lp } : {}) });
							}
						}
					}
					setRestored(true); // 상태 복원 완료 → dim 해제
					if (msg.data.isStreaming) { setLoading(true); const base = msg.data.route === "scheduler" ? "alarm" : msg.data.route === "tool" ? "tool" : "robot"; baseLogoModeRef.current = base; setLogoMode(base); } // 응답 기다리는 중 상태 복원 (재연결 시)
					else setLoading(false); // 놓친 agent_end(백그라운드 유실)로 인한 로딩 스틱 해제
					setThinkingText(""); // fetch 복원 — 백그라운드 전 stale 씽킹 제거, 짝 캡션이 그 자리를 받음
					if ((msg.data as any).isCompacting === true) { setLoading(true); setThinkingText("🧹 컴팩트 진행 중..."); } // 복원 — dim+스트립 (compaction_end까지)
					// 처리중 프롬프트 표시 — 재연결/새로고침 후에도 "뭘 기다리는지"를 입력창에 (서버 제공, streaming 중만)
					if (msg.data.isStreaming && typeof msg.data.lastPrompt === "string" && msg.data.lastPrompt) { draftEchoRef.current = true; setInput(msg.data.lastPrompt); userSentRef.current = true; }
					// 실패 재시도 에코 — lastTurnFailed 시 마지막 프롬프트 복원. 유저가 이미 새로 타이핑 중이면 보호
					if (!msg.data.isStreaming && (msg.data as any).lastTurnFailed === true && typeof msg.data.lastPrompt === "string" && msg.data.lastPrompt && !inputRef.current?.value) { draftEchoRef.current = true; setInput(msg.data.lastPrompt); }
					// 놓친 성공 정리 — 서버 idle+성공 = 이전 턴 완료. 필드에 낡은 프롬프트가 남으면 중복 전송을 유도하므로 클리어.
					// userSentRef가 true일 때만(=전송된 프롬프트) — 미전송 신규 초안은 보호 (재연결 블립 시 날아가지 않게)
					if (!msg.data.isStreaming && (msg.data as any).lastTurnFailed !== true && userSentRef.current) { clearInput(); userSentRef.current = false; }
					if (msg.data.model) {
						const m = msg.data.model;
						const mKey = m.provider ? `${m.provider}/${m.name || m.id}` : (m.name || m.id || "");
						setCurrentModel(mKey);
						try { localStorage.setItem("turk-last-model", mKey); } catch { /* 무시 */ } // 드래프트·재시작 시딩 원료 — 마지막 표시 모델 보존
						supportedThinkingLevelsRef.current = m.thinkingLevelMap ? THINKING_ORDER.filter(k => (m.thinkingLevelMap as any)[k] != null) : (m.reasoning ? ["off", "high"] : ["off"]);
					}
					if (msg.data.thinkingLevel !== undefined) {
					setThinkingLevel(msg.data.thinkingLevel);
					try { localStorage.setItem("turk-last-thinking", msg.data.thinkingLevel); } catch { /* 무시 */ } // 드래프트 시딩 원료 — 마지막 실측 보존
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
				if (msg.command === "reload" && msg.success) {
					// 백엔드 재기동 완료 — ack 화면으로 마감. prevState는 sendReload 캡처분 유지:
					// ctx 메뉴 모드로 두어 모든 선택(✅ 확인)이 "어떤 선택이든 메뉴 종료" 흐름으로 닫히게 한다
					// (✅ 확인 = 취소와 동일 — prevState 복원 후 프롬프트 통과 없음).
					menuMode.current = "ctx";
					setState({ message: "🔄 **재로드 완료** — AGENTS.md·스킬·설정이 즉시 반영됐습니다 (다음 메시지부터 새 지시사항).", buttons: { 0: "✅ 확인" }, answerTo: "컨텍스트" });
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
					clearTimeout(modelsFallbackTimerRef.current); // 폴백 타이머 해제 — 응답 도착 (modelsCache 합성 재전달 포함)
					availableModels.current = [...msg.data.models].sort((a, b) => {
						const ka = `${a.provider}/${a.name || a.id}`;
						const kb = `${b.provider}/${b.name || b.id}`;
						return ka < kb ? -1 : ka > kb ? 1 : 0;
					});
					try { localStorage.setItem("turk-models-cache", JSON.stringify(availableModels.current)); } catch { /* 무시 */ } // 드래프트 메뉴용 — WS 없는 첫 페이지가 캐시로 렌더 (서버 왕복 없음)
					openModelMenu(); // 최근 선택 모델 로드 후 렌더 (비동기)
				}
				break;

			case "auto_retry_start": {
				// API 한도/과부하 등 일시 오류 자동 재시도 — dim 중 인디케이터에 표시 (agent_end에서 통일 클리어)
				const em = String((msg as any).errorMessage ?? "");
				const brief = em.match(/"message":"([^"]*)"/)?.[1] ?? em.replace(/\s+/g, " ").slice(0, 80);
				setThinkingText(`⚠️ 재시도 ${(msg as any).attempt}/${(msg as any).maxAttempts} — ${brief} (${Math.round(((msg as any).delayMs ?? 0) / 1000)}초 후)`);
				break;
			}
			case "auto_retry_end":
				setThinkingText(""); // 재시도 후 새 응답 시작 — 인디케이터 리셋
				break;
			case "compaction_start":
				// 수동 컴팩트만 표시 (threshold/overflow 자동 컴팩트는 조용히)
				if ((msg as any).reason === "manual") {
					setThinkingText("🧹 컴팩트 진행 중..."); // 상태 스트립 — 메인 출력 불변
					if (!loading) setLoading(true); // dim — 컴팩트 동안 동시 전송 차단
				}
				break;
			case "compaction_end": {
				setContextPct(null); // 컴팩트 직후 percent=null — 다음 턴까지 "—" 표시
				wsRef.current?.send(JSON.stringify({ type: "get_session_stats" })); // 갱신 폴링
				if ((msg as any).reason !== "manual") break; // 자동 컴팩트 — 화면 변경 없음
				setLoading(false);
				setThinkingText(""); // dim 해제 = 클리어 (통일)
				break;
			}
			case "scheduler_trigger":
				refreshSchedCount(); // 발화 소진(once 제거) 즉시 반영
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
		// deps에서 loading 제외 — 전송 시점(agent_start)엔 스크롤 유지, 실제 출력 변화(커밋)에만 맨 위로
	}, [state.message, state.buttons, updateScrollArrows]);

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
			// .turk-drawer 예외 — 드로어 영역 터치는 전역 스크롤 하이재크 제외 (Phase 3; 메시지박스 로직은 불변)
			if (t.closest("input, textarea, .turk-message, .turk-drawer")) return;
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
			if (t.closest("input, textarea, .turk-drawer")) return; // 입력창·드로어는 자체 스크롤 유지
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
			const key = `${m.provider}/${m.name || m.id}`;
			buttons[String(i)] = key;
			// 현재 모델은 primary 강조, 최근 선택 모델은 secondary 강조
			if (key === currentModelRef.current) {
				colors[String(i)] = "success";
				textColors[String(i)] = "black";
			} else if (recentModelsRef.current.includes(key)) {
				colors[String(i)] = "primary";
				textColors[String(i)] = "black";
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
		menuMode.current = "model";
		const recent = recentModelsRef.current.length > 0
			? `\n\n**최근 선택**\n${recentModelsRef.current.map((m, i) => `${i + 1}. \`${m}\``).join("\n")}`
			: "";
		setState({ message: `**현재 모델:** \`${currentModelRef.current || "—"}\`\n\n페이지 ${page + 1}/${totalPages} — 모델을 선택하세요.${recent}`, buttons, colors, textColors, answerTo: "모델 선택" }); // 제목은 짝박스 위치
	};

	// 모델 메뉴 공통 마무리 — 최근 선택 로드 → 현재 모델의 페이지 정렬 → 그리드 렌더 (서버 응답·드래프트 캐시 경로 공용)
	const openModelMenu = () => {
		kvGet("recentModels").then((s) => {
			try { recentModelsRef.current = s ? JSON.parse(s) : []; } catch { recentModelsRef.current = []; }
			// 현재 모델이 위치한 페이지로 이동
			const curIdx = availableModels.current.findIndex((m: any) =>
				`${m.provider}/${m.name || m.id}` === currentModelRef.current);
			modelPage.current = curIdx >= 0 ? Math.floor(curIdx / MODELS_PER_PAGE) : 0;
			renderModelGrid();
		});
	};

	// 드래프트 모델 메뉴 — WS 없음: localStorage 캐시(turk-models-cache — 마지막 get_available_models 응답)로 즉시 렌더.
	// 캐시 없으면(신규 브라우저·서버 재시작 후 목록을 한 번도 받지 못한 상태) 안내 화면 — 드래프트는 서버에 아무 요청도 날리지 않는다.
	const openModelMenuFromCache = () => {
		let cached: any[] | null = null;
		try {
			const raw = localStorage.getItem("turk-models-cache");
			const p = raw ? JSON.parse(raw) : null;
			if (Array.isArray(p) && p.length) cached = p;
		} catch { /* 파손 캐시 = 없음 취급 */ }
		if (!cached) {
			menuMode.current = "none";
			setState({ message: "**모델 목록 없음**\n\n대화를 시작한 후 모델 메뉴를 열면 서버에서 목록을 받아 옵니다.", buttons: {}, answerTo: "모델 선택" });
			return;
		}
		availableModels.current = cached;
		openModelMenu();
	};

	// ── 대화 모델 메뉴 — 서버 요청 + 캐시 폴백 (서버 재시작 직후 get_available_models 무응답 → 빈 메뉴 해소) ──
	// 800ms 내 응답(modelsCache 합성 재전달 포함)이 오면 응답 핸들러가 타이머를 해제하고 메뉴를 연다.
	// 무응답(modelsCache 소실 — 서버 재시작 직후 라이브 목록 수신 전)이면 localStorage 캐시로 즉시 렌더 —
	// 드래프트 경로(openModelMenuFromCache) 재사용. 폴백 발동 시점에도 '오픈 여부' 기준 이중 오픈 방지.
	const requestModelsWithFallback = () => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) { openModelMenuFromCache(); return; } // WS 없음 — 드래프트 캐시 경로
		ws.send(JSON.stringify({ type: "get_available_models" }));
		clearTimeout(modelsFallbackTimerRef.current);
		modelsFallbackTimerRef.current = setTimeout(() => {
			modelsFallbackTimerRef.current = undefined;
			if (menuMode.current === "model") return; // 응답이 이미 메뉴를 열었다 — 이중 오픈 금지
			openModelMenuFromCache();
		}, 800);
	};

	// ── 프롬프트 본문 구성 (공용) — 첨부 경로 주입 + 스케줄러 피드백 + 현재 일시 prefix ──
	// sendPrompt(대화 전송)·sendFirstMessage(드래프트 첫 프롬프트)가 같은 구성을 받도록 단일화.
	// 시스템 지시(그리드/프로토콜)는 AGENTS.md(워크스페이스 CWD에 자동생성)로 백엔드가 자동 읽음.
	// 따라서 메시지에 systemPrompt를 부착하지 않는다 — 중복 제거 + 복원 회귀 방지.
	const composePrompt = (userText: string) => {
		let message = userText;
		// 첨부 파일 경로 주입 — 에이전트가 자기 read 도구로 읽음 (user 경로 프롬프트만)
		const files = attachRef.current;
		if (files.length) {
			message = `[첨부 파일 — 아래 경로를 read 도구로 읽어 확인하세요]\n${files.map((f) => `- ${f.path}`).join("\n")}\n\n${message}`;
		}
		// 스케줄러 피드백(에러/목록)이 대기 중이면 프롬프트 앞에 주입
		if (schedulerFeedbackRef.current) {
			message = `${schedulerFeedbackRef.current}\n\n${message}`;
			schedulerFeedbackRef.current = null;
		}
		// 현재 일시 주입 — LLM은 현재 시각을 모르며, 스케줄 when 계산 등에 필요. 매 턴마다 갱신.
		const now = new Date();
		const dt = new Intl.DateTimeFormat("ko-KR", {
			timeZone: "Asia/Seoul",
			year: "numeric", month: "long", day: "numeric", weekday: "long",
			hour: "2-digit", minute: "2-digit", hour12: false,
		}).format(now);
		return `[현재 일시: ${dt} KST]\n\n${message}`;
	};

	// ── 드래프트 첫 메시지 플러시 — 셸 pi_ready(합성)에서 즉시 원래 입력을 실제 첫 프롬프트로 ──
	// 전송 순서 계약: set_model(스폰 수요) → set_thinking_level(dormant 큐잉/직송) → prompt — 같은 핸들러에서
	// 직렬 전송, stdin 순서로 첫 턴에 반영된다. 보류 첨부(pendingFilesRef)가 있으면 응답(칩=경로)이 전수
	// 도착한 뒤에 전송해야 sendPrompt와 동일한 [첨부 파일] 경로 주입이 성립한다.
	const sendFirstMessage = () => {
		const pfm = pendingFirstMessageRef.current;
		if (pfm == null || pendingFirstAttachRef.current > 0) return;
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		pendingFirstMessageRef.current = null;
		userSentRef.current = true; // 사용자 전송 — agent_end 시 클리어
		answerToRef.current = pfm; // 짝표시
		// 보내는 즉시 초안 소멸 — 전송된 프롬프트는 초안이 아님 (sendPrompt와 동일 관례)
		draftEchoRef.current = true;
		clearTimeout(draftTimerRef.current);
		kvSet("draft:new", "").catch(() => { /* 무시 */ }); // 전송 확정 — 드래프트 슬롯 소멸
		// 보류 모델 — set_model은 서버 백엔드 수요(스폰) 계약. 이후 get_state(모델 갱신) 응답까지 dim(modelChanging)
		const pm = pendingModelRef.current;
		if (pm) {
			pendingModelRef.current = null;
			setModelChanging(true);
			ws.send(JSON.stringify({ type: "set_model", provider: pm.provider, modelId: pm.id }));
		}
		// 보류 씽킹 — dormant면 서버 큐잉(pi_ready 재생)·직송이면 그대로 — 어느 쪽이든 prompt에 선행
		const pt = pendingThinkingLevelRef.current;
		if (pt != null) {
			pendingThinkingLevelRef.current = null;
			ws.send(JSON.stringify({ type: "set_thinking_level", level: pt }));
		}
		ws.send(JSON.stringify({ type: "prompt", message: composePrompt(pfm), userInput: pfm, route: "user" })); // userInput: 서버 처리중 표시·타이틀 근거
	};

	// ── 드래프트 해소 (첫 메시지 → 대화 승격) — 키 발급·주소 승격·첫 메시지 보류·연결 ──
	const startFromDraft = (text: string) => {
		const k = crypto.randomUUID?.() ?? uuidv4Fallback();
		try { localStorage.setItem("turk-user-key", k); } catch { /* 무시 */ } // 드래프트 해소 — 이 시점부터 재개 기준점
		setUserKey(k);
		userKeyRef.current = k; // re-render 대기 없이 직접 갱신 — 직후 connect의 WS URL이 이 키로 나간다
		try { history.pushState(null, "", "#" + encodeURIComponent(k)); } catch { /* 무시 */ } // pushState는 hashchange를 유발하지 않음 — 풀리로드 없음
		pendingFirstMessageRef.current = text; // 첫 메시지 — 셸 pi_ready(합성)에서 플러시
		pendingFirstAttachRef.current = pendingFilesRef.current.length; // 보류 첨부 — 응답(칩=경로) 전수 도착 후 전송
		draftEchoRef.current = true; // 전송 예정 텍스트는 초안이 아님 (에코)
		setInput(text);
		connect();
	};

	// ── 프롬프트 전송 ───────────────────────────────────────────────────
	const sendPrompt = useCallback((userText: string, route: "user" | "tool" = "user") => {
		const ws = wsRef.current;
		if (!ws || ws.readyState !== WebSocket.OPEN || !piReady) return;
		userSentRef.current = true; // 사용자 전송 — agent_end 시 클리어
		// 보내는 즉시 초안 소멸 — 전송된 프롬프트는 초안이 아님. 스트리밍 중 폐기→재로드 시 낡은 초안이 부활하는 것 방지.
		draftEchoRef.current = true;
		clearTimeout(draftTimerRef.current);
		kvSet(draftSlot(userKeyRef.current), "").catch(() => { /* 무시 */ });
		// 응답 짝표시 — 이 턴의 응답이 "무엇에 대한 대답"인지 (user: 순수 입력 / tool: 원 질문 승계)
		if (route === "user") answerToRef.current = userText;

		const files = attachRef.current;
		if (files.length) setAttachments([]); // 첨부 소비 — 전송 후 클리어
		ws.send(JSON.stringify({ type: "prompt", message: composePrompt(userText), userInput: userText, route })); // userInput: 서버 처리중 표시용 — 본문 구성은 composePrompt 공용
	}, [piReady]);

	// ── 리로드 — 백엔드만 재기동 (세션 유지): pi 부팅 시 AGENTS.md·스킬·설정 재독 + --session-id 재부착 ──
	// 타이핑·ctx 버튼 공용. 복원 원료(prevState)는 "최초 진입 화면" — 비었을 때만 현재 화면 캡처
	// (ctx·모델 메뉴 진입분 보호 — 메뉴 화면이 복원 원료 되는 것 방지).
	const sendReload = () => {
		const ws = wsRef.current;
		if (ws?.readyState === WebSocket.OPEN) {
			prevStateRef.current ??= state;
			ws.send(JSON.stringify({ type: "reload" }));
		}
	};

	const handleSend = (text: string) => {
		// ── 드래프트 분기 (맨 앞) — userKey 없음: 첫 메시지가 대화를 생성한다 (ChatGPT 모델) ──
		// 메뉴가 열려 있으면 클릭·입력은 해당 메뉴 분기로 통과 (모델 선택·메뉴 조작은 대화 생성이 아님)
		if (isDraft && menuMode.current === "none") {
			if (text === "/model") { // WS 없는 첫 페이지 — 캐시 메뉴 (서버 왕복 없음)
				prevStateRef.current = state;
				openModelMenuFromCache();
				return;
			}
			if (text.startsWith("/")) return; // /session·/compact 등 제어 명령 — WS 없는 첫 페이지에서 무의미 (대화 생성도 않음)
			if (!text) return; // 첨부만 있는 전송 — 첫 대화 생성은 텍스트 기반
			startFromDraft(text);
			return;
		}
		if (text === "/session") {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				showSessionDetail.current = true;
				ws.send(JSON.stringify({ type: "get_state" }));
			}
			return;
		}
		if (text === "/compact") {
			const ws = wsRef.current;
			if (loading) { setState({ message: "⚠️ 응답 대기 중 — 완료 후 다시 시도하세요", buttons: {} }); return; }
			if (ws?.readyState === WebSocket.OPEN) {
				ws.send(JSON.stringify({ type: "compact" }));
				setThinkingText("🧹 컴팩트 진행 중..."); // 상태 레이어
				setLoading(true); // dim 즉시 — compaction_start 이벤트 전 구간 커버
			}
			return;
		}
		if (text === "/reload") {
			// /reload — 백엔드만 재기동(세션 유지) — /compact 관례: 스트리밍 중 kill 방지 로딩 게이트 + WS 열림 확인.
			// WS 없음(드래프트·끊김)은 무시 — 드래프트는 앞 분기에서 "/" 명령 차단, /session·/compact 무응답 관례 동일.
			if (loading) { setState({ message: "⚠️ 응답 대기 중 — 완료 후 다시 시도하세요", buttons: {} }); return; }
			sendReload();
			return;
		}
		if (text === "/model") {
			const ws = wsRef.current;
			if (ws?.readyState === WebSocket.OPEN) {
				prevStateRef.current = state;
				requestModelsWithFallback(); // 서버 응답 우선 — 800ms 무응답 시 localStorage 캐시 폴백
			} else if (isDraft) {
				// 드래프트 — WS 없음: 캐시 메뉴 재렌더 (메뉴 중이면 prevState 보존)
				openModelMenuFromCache();
			}
			return;
		}
		if (menuMode.current === "ctx") {
			// 컨텍스트 메뉴 — 어떤 선택이든 메뉴 종료 후 처리
			menuMode.current = "none";
			if (text === "취소" || text === "✅ 확인") {
				// 취소 — 원래 화면 복원. "✅ 확인"은 리로드 완료 ack 닫기 — 동일 복원(프롬프트 통과 금지)
				setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols));
				prevStateRef.current = null;
				return;
			}
			if (text === "🔄 리로드") {
				// 리로드 — 지시사항·스킬을 다시 읽습니다(대화 유지). prevState는 ctx 진입 시 저장한 메인 출력 그대로 —
				// 완료 ack 화면(✅ 확인) 닫힘 시 복원. loading 게이트(/compact 관례) — 스트리밍 중 kill 방지.
				if (loading) { prevStateRef.current = null; setState({ message: "⚠️ 응답 대기 중 — 완료 후 다시 시도하세요", buttons: {} }); return; }
				sendReload();
				return;
			}
			prevStateRef.current = null;
			if (text === "🧹 컴팩트") {
				const ws = wsRef.current;
				if (loading) { setState({ message: "⚠️ 응답 대기 중 — 완료 후 다시 시도하세요", buttons: {} }); return; }
				if (ws?.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify({ type: "compact" }));
					setThinkingText("🧹 컴팩트 진행 중..."); // 상태 레이어
					setLoading(true); // dim 즉시 — compaction_start 이벤트 전 구간 커버
					setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols)); // 메인 = 출력 즉시 복원
					prevStateRef.current = null;
				}
				return;
			}
			// 그 외 텍스트 — 메뉴 닫히고 일반 프롬프트로 통과
		}
		if (menuMode.current === "model") {
			if (text === "취소") {
				menuMode.current = "none";
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
			if (model && isDraft) {
				// 드래프트 모델 선택 — WS 없음: pendingModelRef로 보류 → 첫 pi_ready 체인에서 set_model (스폰 계약)
				const key = `${model.provider}/${model.name || model.id}`;
				pendingModelRef.current = model;
				// 씽킹 지원 레벨 즉시 반영 (get_state 복원 경로와 동일 식) — 드래프트 토글이 가능해진다
				supportedThinkingLevelsRef.current = model.thinkingLevelMap ? THINKING_ORDER.filter((k) => (model.thinkingLevelMap as any)[k] != null) : (model.reasoning ? ["off", "high"] : ["off"]);
				setCurrentModel(key); // 헤더 표시 — 실제 적용은 첫 set_model 이후 get_state가 확정
				try { localStorage.setItem("turk-last-model", key); } catch { /* 무시 */ } // 시딩 원료 갱신 — 다음 부팅까지 보존
				// 최근 선택 모델 목록 갱신 (최신순 최대 3개, 중복 제거)
				recentModelsRef.current = [key, ...recentModelsRef.current.filter(k => k !== key)].slice(0, 3);
				kvSet("recentModels", JSON.stringify(recentModelsRef.current));
				menuMode.current = "none";
				setState(prevStateRef.current ?? emptyState(DEFAULT_ROWS, DEFAULT_COLS));
				prevStateRef.current = null;
			} else if (model && ws?.readyState === WebSocket.OPEN) {
				setModelChanging(true);
				ws.send(JSON.stringify({
					type: "set_model",
					provider: model.provider,
					modelId: model.id,
				}));
				// 최근 선택 모델 목록 갱신 (최신순 최대 3개, 중복 제거)
				const key = `${model.provider}/${model.name || model.id}`;
				recentModelsRef.current = [key, ...recentModelsRef.current.filter(k => k !== key)].slice(0, 3);
				kvSet("recentModels", JSON.stringify(recentModelsRef.current));
				menuMode.current = "none";
				setState(prevStateRef.current ?? emptyState(DEFAULT_ROWS, DEFAULT_COLS));
				prevStateRef.current = null;
			}
			return;
		}
		// 드래프트로 통과된 입력(컨텍스트 메뉴 닫힘 등) — sendPrompt는 WS가 필요하므로 드래프트 생성으로 승계
		if (isDraft) { startFromDraft(text); return; }
		draftEchoRef.current = true;
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

	const statusText = isDraft ? "새 대화" : !connected ? "연결 끊김" : !piReady ? "세션 초기화 중" : showThinking ? "사고중" : loading ? "생성중" : "준비";

	const cycleThinking = () => {
		// 드래프트 토글 — WS 없음: 로컬 표시 갱신 + pendingThinkingLevel 보류 → 첫 pi_ready에서 set_thinking_level로 승계
		if (isDraft) {
			const dOrder = supportedThinkingLevelsRef.current;
			if (dOrder.filter((k) => k !== "off").length === 0) return; // 모델 미선택 — 지원 레벨 미확정 (헤더 NONE)
			const dIdx = dOrder.indexOf(thinkingLevelRef.current);
			const dNext = dOrder[(dIdx + 1) % dOrder.length] ?? "off";
			setThinkingLevel(dNext);
			pendingThinkingLevelRef.current = dNext;
			return;
		}
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
				{/* ☰ 드로어 버튼은 내비게이션(뷰어 행위)이라 대기 중 헤더 잠금(pointerEvents:none)에서 제외 — 자식 auto가 부모 none을 덮는다. 모델·씽킹·스케줄 버튼은 진행 턴에 상태변경을 끼워넣지 않도록 잠금 유지. */}
				<button className="turk-drawer-btn" style={{ pointerEvents: "auto" }} onClick={() => setDrawerOpen((v) => !v)} title="대화 목록"><Menu className="turk-ico" style={{ width: "1.3em", height: "1.3em" }} /></button>
				<h1 title={statusText}>{logoMode === "tool" || logoMode === "alarm" ? <Settings className="turk-ico turk-ico-green turk-logo-gear-spin" style={{ width: "1.5em", height: "1.5em" }} /> : <Bot className={"turk-ico " + (isDraft ? "turk-ico-green" : !connected ? "turk-ico-red" : !piReady ? "turk-ico-amber" : "turk-ico-green") + (!isDraft && (!restored || modelChanging || loading || !piReady) ? " turk-logo-bot-spin" : "")} />} Turk</h1>
				<span className="turk-mode">
				<button className="turk-schedule-btn" onClick={() => handleSend("현재 스케줄 목록을 보여줘")} title={schedCount > 0 ? `스케줄 관리 — 활성 ${schedCount}개` : "스케줄 관리"} style={{ color: schedCount > 0 ? "var(--success)" : undefined }}><AlarmClock className="turk-ico" style={{ width: "1.3em", height: "1.3em" }} /></button>
				<button className="turk-model-btn" onClick={() => {
					if (menuMode.current === "model") {
						// 토글 닫기
						menuMode.current = "none";
						setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols));
						prevStateRef.current = null;
						return;
					}
					// 배타적 전환 — 다른 메뉴(ctx)가 열려 있어도 prevState는 이미 원래 화면(유지), 직접 교체
					if (menuMode.current === "none") prevStateRef.current = state;
					menuMode.current = "model";
					const ws = wsRef.current;
					if (ws?.readyState === WebSocket.OPEN) {
						requestModelsWithFallback(); // 서버 응답 우선 — 800ms 무응답 시 localStorage 캐시 폴백
					} else if (isDraft) {
						openModelMenuFromCache(); // 드래프트 — WS 없음: 캐시 메뉴 (서버 왕복 없음)
					}
				}} title={currentModel || "모델 선택"}>{(currentModel.split("/").pop() || currentModel) || "모델 선택"}</button> <button className="turk-thinking-btn" onClick={cycleThinking} style={{ color: (supportedThinkingLevelsRef.current.filter(k => k !== "off").length === 0 || thinkingLevel === "off") ? "var(--muted-foreground)" : "var(--success)" }} title={`씽킹 레벨 순환: ${thinkingLevel}`}><Sparkles className="turk-ico" />{supportedThinkingLevelsRef.current.filter(k => k !== "off").length === 0 ? "NONE" : thinkingLevel.toUpperCase()}</button> <button className="turk-new-btn" onClick={() => {
				if (menuMode.current === "ctx") {
					// 토글 닫기
					menuMode.current = "none";
					setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols));
					prevStateRef.current = null;
					return;
				}
				// 배타적 전환 — 모델 메뉴가 열려 있어도 prevState는 이미 원래 화면(유지)
				if (menuMode.current === "none") prevStateRef.current = state;
				menuMode.current = "ctx";
				const pct = contextPct != null ? `${Math.round(contextPct)}%` : "—";
				// 모델 선택 메뉴와 동일 레이아웃: 액션 칸 + 마지막 칸 취소(destructive)
				const btns: Record<string, string> = Object.fromEntries(Array.from({ length: DEFAULT_ROWS * DEFAULT_COLS }, (_, i) => [String(i), ""]));
				btns["0"] = "🧹 컴팩트"; btns["1"] = "🔄 리로드"; btns[String(DEFAULT_ROWS * DEFAULT_COLS - 1)] = "취소";
				const last = String(DEFAULT_ROWS * DEFAULT_COLS - 1);
				setState({ message: `**사용률:** \`${pct}\`\n\n컴팩트 — 대화를 유지한 채 오래된 내용을 요약합니다 (컨텍스트 축소·되돌릴 수 없음).\n\n리로드 — 지시사항·스킬을 다시 읽습니다(대화 유지).`, buttons: btns, colors: { [last]: "destructive" }, textColors: { [last]: "white" }, answerTo: "컨텍스트" }); // 제목은 짝박스 위치
			}} title={`컨텍스트 ${contextPct ?? "—"}% — 컴팩트`}>
					{contextPct != null ? (
						<span className="turk-ctx"><span className="turk-ctx-bar"><span className="turk-ctx-fill" style={{ width: `${Math.min(100, Math.max(0, contextPct))}%`, background: contextPct < 50 ? "var(--success)" : contextPct < 80 ? "#eab308" : contextPct < 95 ? "var(--warning)" : "var(--destructive)" }} /><span className="turk-ctx-pct">{Math.round(contextPct)}%</span></span></span>
						) : <span className="turk-ctx"><span className="turk-ctx-bar"><span className="turk-ctx-fill" style={{ width: "0%" }} /><span className="turk-ctx-pct">—</span></span></span>}
				</button></span>
			</header>

			<div className={"turk-strip-slot" + (loading ? "" : " turk-strip-collapsed")}>
				{/* 인디케이터(씽킹/툴) — 딤(로딩) 중에만 표시·정상 높이. 딤이 아니면 텍스트 숨김+영역 축소(예전 동작).
					짝(answerTo)은 출력창 top border 레전드로 이동 — 대기 중 이전 입력이 인디케이터 기본값으로 보여 혼동되던 문제 해소 */}
				{loading && (thinkingText || toolStatus) ? (
					<div className={"turk-thinking-area" + (thinkingExpanded ? " expanded" : "")} onClick={() => setThinkingExpanded((v) => !v)}>
						{toolStatus ? (
							<div className="turk-strip-tool"><Wrench className="turk-ico" /> {toolStatus.name}: {toolStatus.args}</div>
						) : (
							<div className="turk-thinking-text" ref={stripRef}>{thinkingExpanded ? thinkingText : (thinkingText.split("\n").filter((l) => l.trim()).pop() ?? "")}</div>
						)}
					</div>
				) : null}
			</div>

			<div className={"turk-message-wrap" + (loading ? " turk-loading" : "")}>
				<div className="turk-session-debug" onClick={() => navigator.clipboard?.writeText(`userKey: ${userKey} | agentSessionId: ${sessionId}`)} style={{ position: "absolute", top: "0.25rem", right: "0.4rem", fontSize: "10px", opacity: 0.4, fontFamily: "\"NeoDunggeunmo\", monospace", lineHeight: 1, cursor: "pointer", userSelect: "none", zIndex: 5 }}>
					{userKey?.slice(-6) ?? "—"}|{sessionId ? sessionId.slice(-6) : "—"}
				</div>
				<button className="turk-copy-btn" onClick={() => { navigator.clipboard?.writeText(state.message).then(() => { const b = document.querySelector(".turk-copy-btn"); if (b) { b.classList.add("turk-copy-done"); setTimeout(() => b.classList.remove("turk-copy-done"), 800); } }); }} title="마크다운 복사"><Copy className="turk-ico" /></button>
				{canScrollUp && (
					<button className="turk-scroll-arrow turk-scroll-up" onClick={() => messageRef.current?.scrollTo({ top: 0, behavior: "smooth" })} title="맨 위로"><ChevronUp className="turk-ico" /></button>
				)}
				{canScrollDown && (
					<button className="turk-scroll-arrow turk-scroll-down" onClick={() => messageRef.current?.scrollTo({ top: messageRef.current.scrollHeight, behavior: "smooth" })} title="맨 아래로"><ChevronDown className="turk-ico" /></button>
				)}
				{/* 애니메이션 단위 박스 — 짝 레전드를 출력창 구조에 포함해 pop을 함께 받음.
					key 리마운트로 매 턴 재생. 짝을 .turk-message(스크롤 컨테이너) 안에 직접 넣으면
					overflow-y:auto에 잘리고 내용과 같이 스크롤되므로, 스크롤 밖 동기 박스에 배치 */}
				<div key={msgVerRef.current} className="turk-msg-anim">
					{state.answerTo && (
						/* 항상 표시 — 딤 중에도 유지: 스트립 높이 확보(min-height 3rem)로 인디케이터 텍스트와 간격 확보 */
						<div className="turk-answer-chip" title={state.answerTo}><span>{state.answerTo}</span></div>
					)}
					<div
						ref={messageRef}
						className={`turk-message${loading ? " turk-message-loading" : ""}`}
						onScroll={updateScrollArrows}
					>
						{/* 메인 출력 — 짝(answerTo)은 top border 레전드 (인디케이터 혼동 해소) */}
						<Md text={state.message} />
					</div>
				</div>
			</div>

			<div className={`turk-grid${loading ? " turk-grid-loading" : ""}${keyboardUp ? " turk-grid-hidden" : ""}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
				{gridRows.flat().map(([idx, label]) =>
					label ? (
						<button
							key={`${idx}:${gridVerRef.current}`}
							className={`turk-grid-btn${state.colors?.[idx] ? ` turk-bg-${state.colors[idx]}` : ""}${state.textColors?.[idx] ? ` turk-fg-${state.textColors[idx]}` : state.colors?.[idx] ? ` turk-fg-${["secondary", "muted", "accent", "destructive"].includes(state.colors[idx]) ? "white" : "black"}` : ""}`}
							disabled={loading || !piReady}
							onClick={() => handleSend(label)}
							style={menuMode.current === "model" ? (() => {
								// 모델 선택 화면: 모델명이 길면 폰트 자동 축소 (기준 8칸, 최소 0.8em)
								const w = [...label].reduce((a, c) => a + (/[^\x00-\x7F]/.test(c) ? 2 : 1), 0);
								const delay = `${Math.floor(Number(idx) / cols) * 60}ms`;
								if (w <= 8) return { animationDelay: delay };
								return { fontSize: `max(0.7em, ${(8 / w).toFixed(3)}em)`, animationDelay: delay };
							})() : { animationDelay: `${Math.floor(Number(idx) / cols) * 60}ms` }}
						>
							{label}
						</button>
					) : (
						<button key={`${idx}:e:${gridVerRef.current}`} className="turk-grid-btn turk-grid-btn-empty" tabIndex={-1} aria-hidden="true" style={{ animationDelay: `${Math.floor(Number(idx) / cols) * 60}ms` }} />
					)
				)}
			</div>

			<form
				className="turk-input-form" style={{ bottom: kbHeight }}
				onSubmit={(e) => {
					e.preventDefault();
					if ((input.trim() || attachments.length > 0) && !loading && piReady) handleSend(input.trim());
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape" && loading) {
						wsRef.current?.send(JSON.stringify({ type: "abort" }));
					}
				}}
			>
				{attachments.length > 0 && (
					<div style={{ position: "absolute", bottom: "100%", left: "0.4rem", display: "flex", gap: "0.286rem", flexWrap: "wrap", zIndex: 60 }}>
						{attachments.map((a, i) => (
							<span key={a.path} style={{ display: "flex", alignItems: "center", gap: "0.2rem", background: "var(--muted)", color: "var(--muted-foreground)", borderRadius: "0.3rem", padding: "0.15rem 0.4rem", fontSize: "10px", fontFamily: '"NeoDunggeunmo", monospace' }}>
								{a.name}
								<button type="button" title="첨부 제거" onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: "11px" }}>✕</button>
							</span>
						))}
					</div>
				)}
				<input ref={fileInputRef} type="file" multiple style={{ display: "none" }} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
				<button type="button" className="turk-submit-btn" style={{ flex: "0 0 auto", padding: "0 0.6rem" }} title="파일 첨부 (최대 50MB)" disabled={loading || !piReady} onClick={() => fileInputRef.current?.click()}>
					<Paperclip style={{ width: "1em", height: "1em" }} />
				</button>
				<input
					ref={inputRef}
					className="turk-input-field"
					title="메시지 입력"
					enterKeyHint="send"
					inputMode="text"
					value={input}
					onChange={(e) => { draftEchoRef.current = false; setInput(e.target.value); }}
					placeholder={piReady ? "명령어 입력..." : "세션 초기화 중..."}
					disabled={loading || !piReady}
					autoFocus={false}
				/>
				<button
					type={loading ? "button" : "submit"}
					className="turk-submit-btn"
					disabled={!loading && ((!input.trim() && attachments.length === 0) || !piReady)}
					onClick={loading ? () => {
						wsRef.current?.send(JSON.stringify({ type: "abort" }));
					} : undefined}
				>
					{loading ? "취소" : "전송"}
				</button>
			</form>
			{(!restored || modelChanging || loading || !piReady) && <div className="turk-dim-overlay" />}
			{/* 대화 드로어 (Phase 3) — 조건부 마운트: 폴링·계정 fetch는 close(unmount)와 함께 해제 */}
			{drawerOpen && <ConversationDrawer userKey={userKey} onClose={() => setDrawerOpen(false)} />}
		</div>
	);
}