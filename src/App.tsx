import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { Bot, Sparkles, Wrench, AlarmClock, Copy, Settings, Paperclip, Menu, RefreshCw } from "lucide-react";
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

// ── 출력 히스토리 페이저 — 서버 대화 로그(pi 세션)를 1턴 1페이지로 넘겨보기 ──
// PageTurn: 서버 /history 턴을 클라 소비형으로 구운 것 (parsed = turk JSON 해석본, 실패시 null→원문 표시)
type PageTurn = { id: string; qId: string; q: string; a: string; parsed: TurkState | null; model?: string; ts?: string; compact?: { summary?: string; ts?: string } };
// PageView: 페이저 페이지 — 과거 턴 or live(현행 state). 최신이 아래(마지막 페이지 = live)
type PageView = { kind: "past"; turn: PageTurn } | { kind: "live" };
// 첨부 경로 주입 헤더 제거 — 히스토리 질문 표시는 순수 유저 입력만 (composePrompt 원문 중 display용 박리)
const stripAttachHeader = (q: string) => q.replace(/^\[첨부 파일 — 아래 경로를 read 도구로 읽어 확인하세요\]\n(?:- .*\n)+\n?/, "").trim();

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
			// 그리드 리마운트(스태거드 btn-enter)는 실제 버튼·색 변화시에만 — 복원 setState마다
			// 그리드 전체가 "재등장"하는 것을 차단 (생각중 재접속·answerTo만 바뀐 복원 등)
			if (JSON.stringify(newState.buttons) !== JSON.stringify(prev.buttons)
				|| JSON.stringify(newState.colors) !== JSON.stringify(prev.colors)
				|| JSON.stringify(newState.textColors) !== JSON.stringify(prev.textColors)) gridVerRef.current = gridVerRef.current ? 0 : 1;
			return newState;
		});
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
	const supportedThinkingLevelsRef = useRef<string[]>(["off", "low", "medium", "high", "xhigh"]); // 초기 = 표준 전체 가정 — 첫 get_state 실측에서 확정 (명시거부만 숨김 계약 — 존재하지 않는 키 접속 셸도 버튼 유지)
	thinkingLevelRef.current = thinkingLevel;
	// OFF 순환 감지용: 첫 켜진 레벨(firstLevel)에 다시 도달하면 OFF로
	const firstThinkingLevelRef = useRef<string | null>(null);
	const thinkingCycleHitsRef = useRef(0);
	const THINKING_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const SPIN_FRAMES = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"; // 브레일 슬라이스 — 브라일 도트는 폰트 기준 0.375em (line-height 보정으로 세로 센터)

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

	// ── 출력 히스토리 페이저 — 1턴 1페이지 책넘기기. pages = [과거 턴…] + [live(현행 state)] ──
	// 새 출력 커밋·복원·메뉴는 live(마지막)로 점프(현행 “출력 시 맨 위” 계약의 페이저판).
	// 드래그/휠: 화면(출력창 밖) 제스처는 페이지 플립(과거 이동) 전용.
	// 출력창(.turk-message) 내부 — 그 방향으로 스크롤 여지가 있으면 네이티브 스크롤, 경계(맨 위↔맨 아래)에서
	// 같은 제스처로 페이지 플립 연동: 맨 위에서 아래로 당김 = 과거, 맨 아래에서 위로 밀기 = 최신.
	const [histTurns, setHistory] = useState<PageTurn[]>([]); // 서버 히스토리 턴(시간순) — fetchHistory 원료 (history≠window.history)
	const [pageIdx, setPageIdx] = useState(0); // 현재 페이지 인덱스 — pages[pageIdx]
	const pageIdxRef = useRef(0);
	pageIdxRef.current = pageIdx; // 매 렌더링 동기화 — 핸들러·타이머가 최신값 참조
	const pagesLenRef = useRef(1);
	const wasAtLastRef = useRef(true); // history 교체 시점의 “마지막 페이지 보던 여부” — fetch 완료 후 점프/클램프 결정
	const pagerRef = useRef<HTMLDivElement | null>(null); // 페이저 뷰포트 — 슬롯 높이 원천
	const trackRef = useRef<HTMLDivElement | null>(null); // 3슬롯 트랙 — translateY 직접 구동(드래그·플립 애니메이션)
	const curScrollRef = useRef<HTMLDivElement | null>(null); // 현재 페이지 스크롤러(.turk-message) — 터치·휠·당김 대상
	const animFlipRef = useRef(false); // 플립 애니메이션 진행중 — 중복 플립·드래그 경합 가드
	const flipTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); // 플립 마감 타이머 — 인디케이터 점프 등이 선점 취소
	const liveRawRef = useRef<string>(""); // live 페이지 원문(assistant 텍스트) — history 꼬리 중복 판별(서버 최신턴 == 현재 화면)
	const histTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); // 턴 완결 후 재동기 디바운스
	const histFetchingRef = useRef(false); // 히스토리 fetch 중 — 중복 요청 가드
	const dragState = useRef<{ active: boolean; mode: "idle" | "native" | "page" | "ptr"; moved: boolean; lastY: number; velocity: number; lastTime: number; shift: number }>({ active: false, mode: "idle", moved: false, lastY: 0, velocity: 0, lastTime: 0, shift: 0 });
	// 페이지 어셈블리 — history에서 live와 같은 꼬리(서버 최신턴 == 현재 화면)는 덜어내고 live(state)를 마지막 페이지로.
	// silent 턴은 미표시 계약(서버 캐시와 동일). history가 비면(신규·claude·fetch 실패) 단일 live 페이지 = 현행 동작.
	const pastPages = useMemo(() => {
		const list = histTurns.filter((t) => t.parsed?.silent !== true);
		if (list.length && list[list.length - 1].a === liveRawRef.current) return list.slice(0, -1); // 꼬리 = live 중복 제거
		return list;
	}, [histTurns]);
	const pages: PageView[] = useMemo(() => [...pastPages.map((turn) => ({ kind: "past" as const, turn })), { kind: "live" as const }], [pastPages]);
	pagesLenRef.current = pages.length; // 매 렌더링 동기화 — 점프·클램프 계산 원료

	// ── 페이저 트랙 구동 — 3슬롯(prev·cur·next) 가상화, translateY 직접 조작 ──
	// 인자는 shift(드래그·플립 진행 px) → 트랙px = -슬롯높이+shift. 플립: 애니메이션 → 페이지 전환 → useLayoutEffect 재기준.
	// 그리드(버튼) 영역은 플립에 슬라이드하지 않는다 — 페이지 전환 시 즉시 교체(별로라는 평가로 원상복구).
	const slotH = () => pagerRef.current?.clientHeight ?? 0;
	const applyTrack = useCallback((shift: number, animate: boolean) => {
		const t = trackRef.current;
		if (!t) return;
		t.style.transition = animate ? "transform 0.18s ease-out" : "none";
		t.style.transform = `translateY(${-slotH() + shift}px)`;
	}, []);
	const flipTo = useCallback((dir: 1 | -1) => {
		if (animFlipRef.current) return; // 진행중 플립 — 제스처 무시 (스냅백 불필요: 기존 애니메이션이 마감 수행)
		const next = pageIdxRef.current + dir;
		if (next < 0 || next >= pagesLenRef.current) { applyTrack(0, true); return; } // 경계 — 고무밴드 제자리 스냅
		animFlipRef.current = true;
		applyTrack(-dir * slotH(), true); // dir=-1(이전/과거) → shift +slotH(위에서 내려옴) · dir=+1(다음/최신) → 아래에서 올라옴
		clearTimeout(flipTimerRef.current);
		flipTimerRef.current = setTimeout(() => { animFlipRef.current = false; setPageIdx(next); }, 190); // 애니메이션 마감 = 윈도 시프트 → useLayoutEffect 재기준
	}, [applyTrack]);

	// 경계 저항(resistance) — 키/휘이 경계에서 페이지 전환 직전 한 번 저항: 첫 푸시는 이웃 페이지
	// 가장자리를 고무밴드로 엿보고 제자리 스냅백(끝 신호), 창(~1.2s) 내 같은 방향 두 번째 푸시에만 플립 확정.
	// 반대 방향 푸시는 즉시 리셋(저항 방향 갱신). 터치 드래그의 ¼슬롯 임계와 대칭인 키/휴 계약.
	const resistRef = useRef<{ dir: 0 | 1 | -1; count: number; at: number }>({ dir: 0, count: 0, at: 0 });
	const resistPush = useCallback((dir: 1 | -1): boolean => {
		const r = resistRef.current;
		const now = performance.now();
		if (r.dir !== dir || now - r.at > 1200) { r.dir = dir; r.count = 0; }
		r.count += 1;
		r.at = now;
		if (r.count >= 2) { r.count = 0; return true; } // 저항 관통 — 플립 확정
		if (!animFlipRef.current) { // 첫 푸시 — 엿보기+스냅백 (시각 저항)
			applyTrack(-dir * slotH() * 0.12, true);
			setTimeout(() => { if (!animFlipRef.current && !dragState.current.active) applyTrack(0, true); }, 150);
		}
		return false;
	}, [applyTrack]);

	// ── 히스토리 fetch — 서버가 pi 세션 JSONL을 스폰 없이 판독(GET /api/conversations/<key>/history) ──
	// 실패(라우트 부재·오류)는 history []로 마감 — 단일 live 페이지 현행 동작 유지 (claude 백엔드 등).
	const fetchHistory = useCallback(() => {
		wasAtLastRef.current = pageIdxRef.current >= pagesLenRef.current - 1; // 교체 후 점프 여부 기준 — fetch 시점 스냅샷
		const k = userKeyRef.current;
		if (!k || histFetchingRef.current) { if (!k) setHistory([]); return; } // 드래프트 — 히스토리 없음
		histFetchingRef.current = true;
		fetch(`/api/conversations/${encodeURIComponent(k)}/history`)
			.then((r) => (r.ok ? r.json() : null))
			.then((j: any) => {
				histFetchingRef.current = false;
				if (userKeyRef.current !== k) return; // 대화 전환 경합 — 폐기
				if (!Array.isArray(j?.turns)) { setHistory([]); return; } // 라우트 부재·오류 — 단일 페이지 동작
				setHistory(j.turns.map((t: any): PageTurn => {
					const res = typeof t?.a === "string" ? parseTurkJSON(t.a) : null;
					return { id: String(t?.id ?? ""), qId: String(t?.qId ?? ""), q: stripAttachHeader(String(t?.q ?? "")), a: String(t?.a ?? ""), parsed: res && "parsed" in res ? res.parsed : null, model: typeof t?.model === "string" ? t.model : undefined, ts: typeof t?.ts === "string" ? t.ts : undefined, compact: t?.compact && typeof t.compact === "object" ? { summary: typeof t.compact.summary === "string" ? t.compact.summary : undefined, ts: typeof t.compact.ts === "string" ? t.compact.ts : undefined } : undefined };
				}));
			})
			.catch(() => { histFetchingRef.current = false; });
	}, []);
	// 턴 완결 직후 재동기 — pi는 엔트리마다 appendFileSync 동기 플러시(agent_end 시점 기록완료)라 300ms 디바운스로 충분
	const scheduleHistorySync = useCallback(() => { clearTimeout(histTimerRef.current); histTimerRef.current = setTimeout(fetchHistory, 300); }, [fetchHistory]);

	// userKey — 가변 상태, null(드래프트) 허용. 첫 메시지가 키를 발급·승격한다 (ChatGPT 모델 — 새 대화=첫 페이지).
	// 해시 전환은 풀리로드(onHashChange) 계약이라 런타임 재설정은 드래프트→대화 승격(setUserKey)뿐.
	const [userKey, setUserKey] = useState<string | null>(TURK_USER_KEY);
	const userKeyRef = useRef<string | null>(userKey);
	userKeyRef.current = userKey; // 매 렌더링 동기화 (handleSend 드래프트 분기는 렌더 대기 없이 직접 갱신도 병행)
	const wsRef = useRef<WebSocket | null>(null);
	// 취소 — 소켓이 살아있으면 abort 명령(서버가 agent_end로 완결), 죽었으면 서버 도달 불가라 즉시 dim 해제 +
	// close로 재연결 유도 (onclose → 재연결 타이머 → pi_ready → get_state → 서버 치유/복원). 유령 턴 취소 불가 방지.
	const cancelTurn = () => {
		const ws = wsRef.current;
		if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "abort" }));
		else { setLoading(false); wsRef.current?.close(); }
	};
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

	// 세로 당김 새로고침 — 스탠드얼론(주소창 무) 환경에서의 리로드 수단. 메시지 스크롤이 최상단일 때
	// 아래로 당겨 고무밴드 유리 → 임계(당김 ~200px) 초과 릴리스 = 리로드. 가로 제스처·중간 스크롤은 무시.
	// 드로어·입력창·그리드에서의 당김은 제외(.turk-message 내부 시작만).
	useEffect(() => {
		let startY = 0, startX = 0, pull = 0, armed = false, dragging = false;
		const wrap = () => document.querySelector(".turk-message-wrap") as HTMLElement | null;
		const onTS = (e: TouchEvent) => {
			const t = e.touches[0];
			startX = t.clientX; startY = t.clientY;
			const m = curScrollRef.current; // 현재 페이지 스크롤러 — 페이저 이후 복수 .turk-message 중 진본
			const inMsg = !!(e.target as Element | null)?.closest?.(".turk-message");
			// 첫 페이지(가장 오래된 턴)에서만 당김 리로드 — 중간 페이지의 최상단 당김은 페이지 플립이 받는다
			armed = inMsg && !!m && m.scrollTop <= 0 && pageIdxRef.current === 0;
			dragging = false; pull = 0;
		};
		const onTM = (e: TouchEvent) => {
			if (!armed) return;
			const t = e.touches[0];
			const dy = t.clientY - startY, dx = t.clientX - startX;
			if (!dragging) {
				if (Math.abs(dx) > Math.abs(dy)) { armed = false; return; } // 가로 제스처 — 회수
				if (dy > 12) dragging = true;
				else return;
			}
			e.preventDefault();
			pull = dy;
			const gap = Math.min(Math.round(dy * 0.45), 72); // 드러나는 빈공간 높이 (px)
			const w = wrap();
			if (w) w.style.transform = `translateY(${gap}px)`;
			// 당김 공간 중앙의 회전 아이콘 — 불투명도는 당김량 팬딩, 위치는 공간 중앙 추적
			const pi = document.querySelector(".turk-ptr") as HTMLElement | null;
			if (pi) {
				pi.style.opacity = String(Math.min(pull / 110, 1));
				pi.style.transform = `translateY(${18 - gap / 2}px)`; // 갭 중앙 추적 — 인디케이터가 랩 translate에 타고 내려가므로 그분만큼 역보정
			}
			// 위치 — 실측 기반: 스트립 하단~랩 현재 상단의 중앙 (getRect는 transform 포함이라 마진·이동량 전부 흡수)
			const slot = document.querySelector(".turk-strip-slot") as HTMLElement | null;
			const wLive = wrap();
			if (slot && wLive) {
				const slotBottom = slot.getBoundingClientRect().bottom;
				const wrapTop = wLive.getBoundingClientRect().top;
				if (pi) pi.style.transform = `translateY(${(slotBottom + wrapTop) / 2 - (wrapTop - 18)}px)`; // 인디케이터 중심(자연상태=랩상단-18)을 노출공간 중앙으로
			}
			// 회전각 = 당김량 비례 — 임계(200px)에서 정확히 1바퀴 (끝났다 신호가 각도로 읽힘)
			const ico = document.querySelector(".turk-ptr-ico") as HTMLElement | null;
			if (ico) ico.style.transform = `rotate(${Math.round((Math.min(pull, 200) / 200) * 360)}deg)`;
		};
		const onTE = () => {
			const fadeOut = () => {
				const pi = document.querySelector(".turk-ptr") as HTMLElement | null;
				if (pi) { pi.style.opacity = "0"; pi.style.transform = ""; }
			};
			if (dragging) {
				const w = wrap();
				if (pull > 200) location.reload(); // 당김 확정
				else if (w) {
					w.style.transition = "transform 0.18s ease-out";
					w.style.transform = "";
					setTimeout(() => { if (w) w.style.transition = ""; }, 220);
					const ico = document.querySelector(".turk-ptr-ico") as HTMLElement | null;
					if (ico) {
						ico.style.transition = "transform 0.25s ease-out"; // 역회전 복귀 — 당긴 각도에서 0°로 되감기
						ico.style.transform = "rotate(0deg)";
						setTimeout(() => { if (ico) ico.style.transition = ""; }, 260);
					}
				}
				fadeOut();
			}
			armed = false; dragging = false; pull = 0;
		};
		document.addEventListener("touchstart", onTS, { passive: true });
		document.addEventListener("touchmove", onTM, { passive: false });
		document.addEventListener("touchend", onTE);
		document.addEventListener("touchcancel", onTE);
		return () => {
			document.removeEventListener("touchstart", onTS);
			document.removeEventListener("touchmove", onTM);
			document.removeEventListener("touchend", onTE);
			document.removeEventListener("touchcancel", onTE);
		};
	}, []);


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

	// localStorage 자동 재개(마르마크) 후 서버 대장 교정 — localStorage 키는 '마지막 해시 진입'뿐이라
	// 낡거나(마지막 푸시 클릭) 기기 관점에 갇힌다. AUTH 환경에서 목록 1위(lastActiveAt 내림)와 비교해
	// 다르면 location.replace(#1위 → 풀리오드: 부트가 해시·로컬스토리지 재반영). 명확 사용자 진입(푸시·
	// 북마크·드로어)은 마르마크 없으므로 절대 교정 안함. 401·AUTH-off·빈 목록: 마르마크 해제 후 로컬 유지.
	useEffect(() => {
		if (!sessionStorage.getItem("turk-ls-resume") || !TURK_USER_KEY) return;
		let cancelled = false;
		(async () => {
			try {
				const r = await fetch("/api/conversations");
				if (!r.ok) throw new Error("registry unavailable");
				const j: unknown = await r.json();
				const top = Array.isArray(j) && (j as { id: string }[])[0]?.id;
				if (cancelled) return;
				sessionStorage.removeItem("turk-ls-resume");
				if (top && top !== TURK_USER_KEY) {
					try { localStorage.setItem("turk-user-key", top); } catch { /* 무시 */ }
					location.replace("#" + encodeURIComponent(top)); // 풀리오드 — 낡은 로컬키(트레이너 스틱) 해소
				}
			} catch { /* 무시 — 로컬 재개 유지 */ }
		})();
		return () => { cancelled = true; };
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
				// 상태 복원: get_state 응답 대기 — 복원 전까지 dim (last-assistant-text는 브라우저 localStorage).
				// 단 스트리밍(생각중) 재접속은 dim 섬광 생략 — WS 블립이 화면 점멸 반복으로 읽히는 것 방지
				if (!loading) setRestored(false);
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
					// 커밋 공용 마무리 — 짝 부착 → silent/schedules 정리 → live 페이지 확정(commit) → 히스토리 재동기 예약.
					// 반환: "silent"(미표시 마감) | "committed"(live 확정) — silent는 재시도 폴백도 생략(기존 return 계약).
					const commitParsed = (parsed: TurkState, raw: string): "silent" | "committed" => {
						parsed.answerTo = answerToRef.current ?? undefined; // 짝표시 부착
						// schedules는 서버가 agent_end에서 직접 스케줄러에 적용 (릴레이 제거 — 백그라운드 트리거 체이닝 보존)
						// silent: 사용자에게 미표시
						if (parsed.silent === true) {
							if (schedulerPrefixRef.current) schedulerPrefixRef.current = null;
							return "silent";
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
						liveRawRef.current = raw; // live 페이지 원문 확정 — 히스토리 꼬리 중복 판별용
						scheduleHistorySync(); // 턴 완결 — 서버 세션 로그 재판독 (pi는 엔트리마다 동기 플러시)
						return "committed";
					};
					const result = parseTurkJSON(text);
					const outcome = result && "parsed" in result ? commitParsed(result.parsed, text) : null;
					// 스트리밍본으로 한 번 더 시도 (messages가 잘렸을 수 있음) — silent 커밋은 폴백 생략
					if (outcome !== "silent" && outcome !== "committed" && streamingTextRef.current && streamingTextRef.current !== text) {
						const fallback = parseTurkJSON(streamingTextRef.current);
						if (fallback && "parsed" in fallback) commitParsed(fallback.parsed, streamingTextRef.current);
						// 자가수정은 서버 전담 (261008 — 클라 전담 시절 백그라운드 WS 끊김 턴의 위반 응답이
						// 무보정·무기록으로 유실됨). willRetry=true agent_end에서 서버가 위반 원문+에러를
						// 되돌려 route tool 재시도 주입 → agent_start가 이어 받아 dim 유지. 소진 시 agent_end.error로 마감.
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
								// WS 연결 복원 — 렌더된 내용이 서버 출력버퍼(lastResponse)와 같을 때 갱신 금지:
								// 동일 커밋의 pop 재생(key 리마운트)·그리드 리레이아웃 플리커 차단 (연결 블립·백그라운드 복귀 무관 무커밋)
								const p = lrRes.parsed;
								const ans = ((msg.data as any).lastResponsePrompt ?? (answerToRef.current ?? undefined)) as string | undefined;
								const sameJson = (x: unknown, y: unknown) => (x === y ? true : JSON.stringify(x ?? null) === JSON.stringify(y ?? null));
								setState((prev) => (prev.message === p.message && sameJson(prev.buttons, p.buttons) && sameJson(prev.colors, p.colors) && sameJson(prev.textColors, p.textColors) && (prev.answerTo ?? undefined) === ans ? prev : { ...p, answerTo: ans }));
								liveRawRef.current = lrText; // 복원본 원문 — 히스토리 꼬리 중복 판별용
								// setLoading(false) 금지 — loading은 동기 isStreaming 분기가 소유.
								// 재연결 시 서버가 스트리밍/씽킹중면 dim이 유지되어야 함 (이전 커밋화면은 dim 아래)
							} else {
								// lastResponse 없음(실패/빈 응답/서버 재시작) — 이전 입력(lastPrompt) 있으면 짝 캡션으로, 없으면 웰컴 제목(🤖 Turk) 유지
								const lp = (msg.data as any).lastPrompt;
								setState({ ...emptyState(gridRef.current.rows, gridRef.current.cols), ...(typeof lp === "string" && lp ? { answerTo: lp } : {}) });
								liveRawRef.current = ""; // 빈 복원 — 히스토리 꼬리 전부 과거 페이지로
							}
						}
						fetchHistory(); // 복원 완료 — 서버 세션 로그 전체 판독(페이지 어셈블리 원료). 스폰 0 무동작
					} else {
						// 세션 없음(restart_pi·삭제 후 새 셸·첫 발화 전) — 낡은 히스토리 잔류 차단 (신규 대화 = 단일 live 페이지)
						setHistory([]);
						liveRawRef.current = "";
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
						supportedThinkingLevelsRef.current = m.thinkingLevelMap ? THINKING_ORDER.filter(k => (m.thinkingLevelMap as any)[k] != null) : (m.reasoning !== false ? ["off", "high"] : ["off"]); // 부분 기록 모델(과거 실측분)도 미옵션으로 숨기지 않음 — 명시적 거부(false)만 숨김
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

	// 출력 갱신(커밋·복원·메뉴) — live(마지막) 페이지로 점프 (현행 "출력 시 맨 위" 계약의 페이저판).
	// deps에서 loading 제외 — 전송 시점(agent_start)엔 유지, 실제 출력 변화에만 점프 (기존 계약 승계)
	useEffect(() => {
		setPageIdx(() => pagesLenRef.current - 1);
	}, [state.message, state.buttons]);

	// history 교체(pages 변동) — 마지막 페이지 보던 중이면 새 마지막으로, 아니면 현재 위치 클램프
	useEffect(() => {
		const last = pagesLenRef.current - 1;
		setPageIdx((i) => (wasAtLastRef.current ? last : Math.min(i, last)));
	}, [pages]);

	// 페이지 윈도 시프트 후 트랙 재기준 — 플립 애니메이션 마감·history 교체 공용 (무애니 스냅: 연속 프레임 무빙)
	useLayoutEffect(() => {
		applyTrack(0, false); // 윈도 시프트 후 재기준 — shift 0(중앙 슬롯)
	}, [pageIdx, pages, applyTrack]);

	// 가상 키보드 감지 → 버튼 영역 숨김 + 페이저 재기준 (뷰포트 변동 = 슬롯 높이 변동)
	useEffect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const onResize = () => { const kb = Math.max(0, window.innerHeight - vv.height); setKbHeight(kb); setKeyboardUp(kb > 100); };
		onResize();
		vv.addEventListener("resize", onResize);
		vv.addEventListener("scroll", onResize);
		return () => { vv.removeEventListener("resize", onResize); vv.removeEventListener("scroll", onResize); };
	}, [applyTrack]);

	// 페이저 높이 변동 재기준 — 상태별 레이아웃 변동 전부 커버: 스트립 확장(로딩)·그리드 행 수·빈 그리드·
	// 창 리사이즈·회전. px 기준 translateY는 뷰포트 크기가 변하는 순간 낡는다(전 페이지 끝이 새어 보이는 버그의
	// 근원) → ResizeObserver로 즉시 재기준. 드래그·플립 진행 중엔 제스처가 마감 시 재기준하므로 간섭 금지.
	useEffect(() => {
		const el = pagerRef.current;
		if (!el) return;
		const rebase = () => { if (!dragState.current.active && !animFlipRef.current) applyTrack(0, false); };
		if (typeof ResizeObserver !== "undefined") {
			const ro = new ResizeObserver(rebase);
			ro.observe(el);
			return () => ro.disconnect();
		}
		window.addEventListener("resize", rebase); // 구형 브라우저 폴백
		return () => window.removeEventListener("resize", rebase);
	}, [applyTrack]);

	// 드래그 — 화면(출력창 밖)=플립 전용. 출력창 안=스크롤 여지에 따라 네이티브 스크롤, 경계에서 플립 연동
	// (맨 위 아래로 당김=과거 · 맨 아래 위로 밀기=최신 — 제스처 시작점 기준 1회 판정). 첫 페이지 맨 위
	// 당김은 당김-리로드(ptr 핸들러)가 소관. 짧은 탭(8px 미만)은 클릭으로 통과.
	useEffect(() => {
		const canScroll = (el: HTMLElement | null, dy: number) => {
			if (!el || dy === 0) return false;
			return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 2 : el.scrollTop > 2; // dy>0 = 손가락 위 = 아래로 스크롤
		};
		const onTouchStart = (e: TouchEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("input, textarea, .turk-drawer")) return; // 입력창·드로어 — 자체 스크롤 (출력창은 아래 판정에서 분기)
			// 플립 애니메이션 중 새 제스처 무시 — 190ms 관통 클릭만 허용 (moved=false)
			if (animFlipRef.current) return;
			const now = performance.now();
			dragState.current = { active: true, mode: "idle", moved: false, lastY: e.touches[0]?.clientY ?? 0, velocity: 0, lastTime: now, shift: 0 };
			applyTrack(0, false); // 잔여 드래그 오프셋 스냅
		};
		const onTouchMove = (e: TouchEvent) => {
			const ds = dragState.current;
			if (!ds.active) return;
			const y = e.touches[0]?.clientY ?? 0;
			const dy = ds.lastY - y;
			// 드래그 시작 감지: 일정 거리 이상 이동 시 제스처 확정 (짧은 탭은 클릭 유지)
			if (!ds.moved && Math.abs(dy) < 8) return;
			ds.moved = true;
			// 제스처 판정(1회) — 시작점의 스크롤 여지로 이 제스처의 소관 확정
			if (ds.mode === "idle") {
				const sc = curScrollRef.current;
				const inBox = !!(e.target as Element | null)?.closest?.(".turk-message");
				// 첫 페이지 맨 위 아래당김 — 당김-리로드 소관 (과거 페이지 없음)
				if (inBox && dy < 0 && pageIdxRef.current === 0 && sc && sc.scrollTop <= 0) { ds.mode = "ptr"; return; }
				// 출력창 안 + 그 방향 스크롤 여지 — 네이티브 스크롤에 맡김 (이 제스처는 preventDefault 금지)
				if (inBox && canScroll(sc, dy)) { ds.mode = "native"; return; }
				ds.mode = "page"; // 그 외(출력창 밖 전역·경계·내용 없음) — 페이지 플립
			}
			if (ds.mode === "native" || ds.mode === "ptr") return; // 네이티브 스크롤·당김-리로드 — 여기선 손대지 않는다
			const now = performance.now();
			const dt = now - ds.lastTime;
			if (dt > 0) {
				// 순간 속도(px/ms) — 이동평균으로 부드럽게
				const inst = dy / dt;
				ds.velocity = ds.velocity * 0.6 + inst * 0.4;
			}
			ds.lastY = y;
			ds.lastTime = now;
			// 트랙 직접 구동 — shift 음수 = 다음(최신) 방향. 원시 이동량은 그대로 축적(플립 판정용),
			// 경계 밖 시각 오프셋만 고무밴드 감쇠(0.35) — 원시와 표시의 분리
			ds.shift += -dy;
			const atFirst = pageIdxRef.current <= 0, atLast = pageIdxRef.current >= pagesLenRef.current - 1;
			const damped = (ds.shift > 0 && atFirst) || (ds.shift < 0 && atLast) ? ds.shift * 0.35 : ds.shift;
			applyTrack(damped, false);
			e.preventDefault();
		};
		const onTouchEnd = (e: TouchEvent) => {
			const ds = dragState.current;
			if (ds.moved && ds.mode === "page") {
				e.preventDefault(); // 클릭 차단
				// 임계(¼슬롯)·플릭(속도)으로 플립 — 미달시 제자리 스냅
				const h = slotH();
				const flick = Math.abs(ds.velocity) > 0.5;
				if (ds.shift < -h * 0.25 || (flick && ds.velocity > 0)) flipTo(1); // 다음(최신)
				else if (ds.shift > h * 0.25 || (flick && ds.velocity < 0)) flipTo(-1); // 이전(과거)
				else applyTrack(0, true);
			}
			ds.active = false; ds.moved = false; ds.mode = "idle"; ds.shift = 0; ds.velocity = 0;
		};
		window.addEventListener("touchstart", onTouchStart, { passive: true });
		window.addEventListener("touchmove", onTouchMove, { passive: false });
		window.addEventListener("touchend", onTouchEnd, { passive: false });
		window.addEventListener("touchcancel", onTouchEnd, { passive: false });

		// 마우스 휠/트랙패드 — 출력창 위: 스크롤 여지면 네이티브, 경계면 플립 연동. 그 외 화면: 플립 전용.
		// 반응성 계약: 노치 1회(≈100px)에 즉시 플립 — 시간 기반 폐기 금지(연타를 삼켜 둔감해지던 구조),
		// 플립 애니메이션(190ms) 중에만 폐기하고 마감 직후 다음 노치가 이어받는다. line 모드(Firefox)는 px 환산.
		let wheelAcc = 0, lastWheelEvAt = 0, wheelRun = false; // 런=플립 후 모멘텀 — 정숙(300ms) 후 새 플릭 재허용
		const onWheel = (e: WheelEvent) => {
			const t = e.target as HTMLElement;
			if (t.closest("input, textarea, .turk-drawer")) return; // 입력창·드로어 — 자체 스크롤
			const wNow = performance.now();
			if (wheelRun && wNow - lastWheelEvAt > 300) wheelRun = false; // 정숙 갭 — 모멘텀 종료, 새 제스처
			lastWheelEvAt = wNow;
			const inBox = !!t.closest(".turk-message");
			if (inBox && canScroll(curScrollRef.current, e.deltaY)) return; // 출력창 내부 스크롤 여지 — 네이티브
			e.preventDefault();
			const d = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY; // line 모드 휠 → px 환산 (노치 ≈ 3라인 × 33px)
			if (animFlipRef.current) { wheelAcc = 0; return; } // 플립 진행중 — 마감 후 다음 노치가 받음
			if ((wheelAcc > 0) !== (d > 0)) wheelAcc = 0; // 방향 전환 — 잔여 축적 초기화
			wheelAcc += d;
			if (Math.abs(wheelAcc) >= 60) {
				const dir = wheelAcc > 0 ? 1 : -1;
				wheelAcc = 0;
				if (wheelRun) return; // 런 중 모멘텀 — 흡수(연쇄 캔슬). 플립은 런당 1회
				// 모든 휠 플립은 저항(첫 노치 엿보기+스냅백, 이어지는 노치 확정) — 커서 위치(출력창 안밖) 무관 통일 계약
				if (resistPush(dir)) { flipTo(dir); wheelRun = true; }
			}
		};
		window.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			window.removeEventListener("touchstart", onTouchStart);
			window.removeEventListener("touchmove", onTouchMove);
			window.removeEventListener("touchend", onTouchEnd);
			window.removeEventListener("touchcancel", onTouchEnd);
			window.removeEventListener("wheel", onWheel);
		};
	}, [applyTrack, flipTo, resistPush]);

	// ── 키보드 숏컷 — 엔터=입력창 포커스(입력창 밖), Esc=취소(턴 취소·메뉴 닫기), ↑↓=페이지 플립 ──
	// 입력 필드·드로어 내부는 자체 동작 우선(커서 이동·폼 Escape·버튼 활성화 간섭 금지)
	useEffect(() => {
		// 프레스 세션 — 홀드 중 플립은 1회만: 넘긴 뒤엔 키를 떼고 다시 눌러야 다음 페이지(연쇄 캔슬).
		// 스크롤(내용 읽기)은 홀드로 계속 가능 — 정지되는 것은 페이지 전환뿐.
		const held = { flipped: false };
		const onKey = (e: KeyboardEvent) => {
			if (e.ctrlKey || e.altKey || e.metaKey) return; // 조합 키는 브라우저·OS 소관
			const t = e.target as HTMLElement | null;
			const inField = !!t?.closest?.("input, textarea, .turk-drawer");
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				if (inField) return; // 입력 커서 이동·드로어 목록 스크롤은 자체 동작
				e.preventDefault();
				// 출력창 스크롤 우선 — 끄트머리(경계)에서 페이지 전환까지 연동 (휠과 동일 계약)
				const sc = curScrollRef.current;
				const down = e.key === "ArrowDown";
				const can = sc ? (down ? sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2 : sc.scrollTop > 2) : false;
				if (can && sc) { sc.scrollTop += (down ? 1 : -1) * sc.clientHeight * 0.75; return; } // ¾ 뷰포트씩
				// 경계 — 저항 후 플립: 첫 푸시는 이웃 페이지 엿보기+스냅백, 이어지는 푸시에 확정
				const dir = down ? 1 : -1;
				if (!e.repeat) held.flipped = false; // 새 프레스 — 세션 리셋
				if (held.flipped) return; // 이 프레스에서 이미 넘김 — 릴리스까지 정지 (연쇄 캔슬)
				if (resistPush(dir)) { flipTo(dir); held.flipped = true; }
				return;
			}
			if (e.key === "Escape") {
				if (inField) return; // 폼 내부 Escape — 폼 onKeyDown(취소)이 담당, 이중 발사 방지
				if (menuMode.current !== "none") { // 열린 메뉴 닫기 — 취소 버튼과 동일 마무리(원 화면 복원)
					menuMode.current = "none";
					setState(prevStateRef.current ?? emptyState(gridRef.current.rows, gridRef.current.cols));
					prevStateRef.current = null;
					e.preventDefault();
					return;
				}
				if (loading) { cancelTurn(); e.preventDefault(); } // 진행 턴 취소 — 폼 취소 버튼과 동일 계약
				return;
			}
			if (e.key === "Enter") {
				if (inField || t?.tagName === "BUTTON" || t?.isContentEditable) return; // 필드·포커스된 버튼 활성화·편집은 자체 동작
				e.preventDefault();
				inputRef.current?.focus(); // 입력창 밖 엔터 — 곧장 타이핑 시작
			}
		};
		const onKeyUp = (e: KeyboardEvent) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") held.flipped = false; }; // 릴리스 — 다음 프레스 세션
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKeyUp);
		return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onKeyUp); };
	}, [flipTo, loading, resistPush]);

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

	// ── 프롬프트 본문 구성 (공용) — 첨부 경로 주입 + 스케줄러 피드백 ──
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
		// 현재 일시 주입 삭제 — 매턴 이산(노이즈)이었던 관계로 제거. 시각이 필요하면 AGENTS.md 계약대로
		// 모델이 bash로 직접 조회(스케줄 when 계산시에만). (261025)
		return message;
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
		try { window.history.pushState(null, "", "#" + encodeURIComponent(k)); } catch { /* 무시 */ } // pushState는 hashchange를 유발하지 않음 — 풀리로드 없음
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
	// 페이지별 그리드 원료 — 과거 페이지 보는 중엔 그 턴의 버튼을 표시. 조작 계약은 live와 동일(라벨 프롬프트 전송 —
	// 입력창이 과거 페이지에서도 현재 세션으로 전송되는 것과 대칭. 응답 커밋 시 live 점프로 마감). 분기(fork) 질문은 Phase 2.
	// 파싱 실패(silent·원문) 턴은 빈 그리드 — 출력창(flex)이 흡수해 커진다 (빈 라인 숨김 계약과 동일 감각).
	const activePast = pageIdx < pages.length - 1 && pages[pageIdx].kind === "past" ? pages[pageIdx].turn : null;
	const gridState: TurkState = activePast ? (activePast.parsed ?? { message: activePast.a, buttons: {} }) : state;
	const gridRows: [string, string][][] = [];
	for (let r = 0; r < rows; r++) {
		const row: [string, string][] = [];
		for (let c = 0; c < cols; c++) {
			const idx = String(r * cols + c);
			row.push([idx, gridState.buttons?.[idx] ?? ""]);
		}
		// 빈 라인 숨김(261012) — 라벨이 하나라도 있는 라인만 그리고, 그리드가 수축한 만큼 출력창(flex)이 흡수해 커진다.
		// 라벨 라인의 빈 칸은 기존 그대로(그리드 틀 유지·애니메이션 지연도 원 행 인덱스 기준 유지).
		if (row.every(([, label]) => !label)) continue;
		gridRows.push(row);
	}

	// 최신(live) 페이지 점프 — 제목 칩 탭. 진행중 플립 선점 취소 후 즉시 전환
	const jumpToLatest = () => {
		if (pageIdx >= pages.length - 1) return;
		clearTimeout(flipTimerRef.current);
		animFlipRef.current = false;
		wasAtLastRef.current = true;
		setPageIdx(pages.length - 1);
	};

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
				<button className="turk-schedule-btn" onClick={() => handleSend("현재 스케줄 목록을 보여줘")} title={schedCount > 0 ? `스케줄 관리 — 활성 ${schedCount}개` : "스케줄 관리"} style={{ color: schedCount > 0 ? "var(--success)" : undefined }}><span className="turk-sch-badge"><AlarmClock className="turk-ico" style={{ width: "1.3em", height: "1.3em" }} />{schedCount > 0 && <b>{schedCount}</b>}</span></button>
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
				}} title={currentModel || "모델 선택"}>{(currentModel.split("/").pop() || currentModel) || "모델 선택"}</button> {!!(supportedThinkingLevelsRef.current.filter(k => k !== "off").length === 0) ? null : (<button className="turk-thinking-btn" onClick={cycleThinking} style={{ color: (supportedThinkingLevelsRef.current.filter(k => k !== "off").length === 0 || thinkingLevel === "off") ? "var(--muted-foreground)" : "var(--success)" }} title={`씽킹 레벨 순환: ${thinkingLevel}`}><Sparkles className="turk-ico" />{((({ off: "--", none: "--", minimal: "MI", low: "LO", medium: "ME", high: "HI", xhigh: "XH", max: "MA" } as Record<string, string>)[thinkingLevel]) ?? thinkingLevel.slice(0, 2))}</button>)} <button className="turk-new-btn" onClick={() => {
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
					{(() => {
						// 도넛 — 단일 경로 (261012): 미측정(null)도 같은 렌더 — 원호·중앙 숫자만 생략 (상태 분기 → 모양 분기 금지 계약)
						const has = contextPct != null;
						const pct = has ? Math.min(100, Math.max(0, contextPct)) : 0;
						const col = !has ? "var(--muted-foreground)" : contextPct < 50 ? "var(--success)" : contextPct < 80 ? "#eab308" : contextPct < 95 ? "var(--warning)" : "var(--destructive)";
						return (<span className="turk-ctx turk-ctx-donut" title="컨텍스트 사용률 (첫 실측 응답부터 표시)"><svg viewBox="0 0 36 36" className="turk-ctx-ring"><circle cx="18" cy="18" r="15" fill="none" stroke="var(--muted-foreground)" strokeOpacity="0.25" strokeWidth="3.5" />{has && <circle cx="18" cy="18" r="15" fill="none" stroke={col} strokeWidth="3.5" strokeDasharray={`${pct} ${100 - pct}`} pathLength={100} strokeDashoffset={25} strokeLinecap="round" />}</svg>{<span className="turk-ctx-n" style={{ color: col, opacity: has ? 1 : 0 }}>{has ? Math.round(contextPct) : 0}</span>}{/* 투명 글자: 미측정에도 글리프 무게 유지 — 옵티컬 균형 */}</span>);
					})()}
				</button></span>
			</header>

			<div className={"turk-strip-slot" + (loading ? "" : " turk-strip-collapsed")}>
				{/* 인디케이터(씽킹/툴) — 딤(로딩) 중에만 표시·정상 높이. 딤이 아니면 텍스트 숨김+영역 축소(예전 동작).
					짝(answerTo)은 출력창 위 독립 박스로 상단 배치 — 대기 중 이전 입력이 인디케이터 기본값으로 보여 혼동되던 문제 해소 */}
				{loading ? (
					<div className={"turk-thinking-area" + (thinkingExpanded ? " expanded" : "")} onClick={() => { if (thinkingText.trim()) setThinkingExpanded((v) => !v); }}>
						{/* 스피너 — 스트립 왼쪽 고정, 로딩 내내 상시 회전 (툴/씽킹/대기 모두). 색 = 옆 텍스트 색 반영 (툴=warning) */}
						<span className={"turk-spin" + (toolStatus ? " turk-spin-tool" : "")} aria-hidden="true"><span className="turk-spin-inner">{SPIN_FRAMES.split("").map((ch, i) => <span key={i}>{ch}</span>)}</span></span>
						{toolStatus ? (
							<div className="turk-strip-tool"><Wrench className="turk-ico" /> {toolStatus.name}: {toolStatus.args}</div>
						) : (
							<div className="turk-thinking-text" ref={stripRef}>{thinkingText.trim() ? (thinkingExpanded ? thinkingText : (thinkingText.split("\n").filter((l) => l.trim()).pop() ?? "")) : "생각중"}</div>
						)}
					</div>
				) : null}
			</div>

			<div className={"turk-message-wrap" + (loading ? " turk-loading" : "")}>
				<div className="turk-ptr" aria-hidden="true"><span className="turk-ptr-ico"><RefreshCw className="turk-ico" /></span></div>
				{/* 복사 — 보고 있는 페이지 기준: 과거 페이지는 그 턴의 표시본(parsed.message, 실패시 원문) */}
				<button className="turk-copy-btn" onClick={() => { const text = activePast ? (activePast.parsed?.message ?? activePast.a) : state.message; navigator.clipboard?.writeText(text).then(() => { const b = document.querySelector(".turk-copy-btn"); if (b) { b.classList.add("turk-copy-done"); setTimeout(() => b.classList.remove("turk-copy-done"), 800); } }); }} title="마크다운 복사"><Copy className="turk-ico" /></button>
				{/* 페이저 — 3슬롯(prev·cur·next) 가상 트랙. translateY는 applyTrack이 직접 구동(드래그·플립),
					경계 밖 슬롯은 빈 칸으로 자리 유지(지오메트리 일정). 짝 라벨·pop 애니메이션은 페이지 내부에 승계 */}
				<div className="turk-pager" ref={pagerRef}>
					<div className="turk-pager-track" ref={trackRef}>
						{[-1, 0, 1].map((rel) => {
							const i = pageIdx + rel;
							const pv = i >= 0 && i < pages.length ? pages[i] : null;
							if (!pv) return <div className="turk-page turk-page-empty" key={`e${rel}`} aria-hidden="true" />;
							if (pv.kind === "live") return (
								/* 신원 "live" 고정 — 인덱스 키는 history 갱신(pages.length 흔들림) 때마다 live 슬롯을
								   리마운트해 pop("화면 나타남")을 재생했다. 새 턴의 pop은 내부 key(msgVer)가 담당 */
								<div className="turk-page" key="live">
									{/* 애니메이션 단위 박스 — key(msgVer) 리마운트로 매 턴 pop 재생 (기존 .turk-msg-anim 계약 승계) */}
									<div key={msgVerRef.current} className="turk-msg-anim">
										{(state.answerTo || pages.length > 1) && (
											/* 항상 표시 — 딤 중에도 유지: 짝 박스는 플로우라 스트립과 간섭 없음. 몇턴 중 몇턴(live=마지막) */
											<div className="turk-answer-chip" title={state.answerTo}>
												{state.answerTo && <span className="turk-answer-q">{state.answerTo}</span>}
												{pages.length > 1 && <span className="turk-answer-pos">{pages.length}/{pages.length}턴</span>}
											</div>
										)}
										<div ref={i === pageIdx ? curScrollRef : undefined} className={"turk-message" + (loading ? " turk-message-loading" : "")}>
											{/* 메인 출력(live) — 짝 박스 아래 나머지 영역 (인디케이터 혼동 해소) */}
											<Md text={state.message} />
										</div>
									</div>
								</div>
							);
							const t = pv.turn;
							return (
								<div className="turk-page" key={i} data-page={i}>
									{/* 과거 턴 — 짝 헤더(질문) + 마크다운 답변. 파싱 실패 응답은 원문 그대로 (전체 로그 계약) */}
									{t.compact && (
										/* 컴팩트 전환점 — 이 턴부터 모델은 위 요약으로 과거를 기억 (tooltip=요약 원문) */
										<div className="turk-compact-mark" title={t.compact.summary ?? "컴팩트 요약본 없음"}>🧹 컴팩트{t.compact.ts ? ` · ${t.compact.ts.slice(0, 16).replace("T", " ")}` : ""} — 이 지점부터 과거는 요약으로 기억</div>
									)}
									{(t.q || pages.length > 1) && (
										/* 과거 턴 제목 — 몇턴 중 몇턴. 탭하면 최신(live) 페이지로 점프 */
										<div className={"turk-answer-chip" + (i < pages.length - 1 ? " turk-answer-chip-jump" : "")} title={[t.q, t.model, t.ts?.slice(0, 10)].filter(Boolean).join(" · ") + (i < pages.length - 1 ? " — 탭하면 최신으로" : "")} onClick={i < pages.length - 1 ? jumpToLatest : undefined}>
											{t.q && <span className="turk-answer-q">{t.q}</span>}
											{pages.length > 1 && <span className="turk-answer-pos">{i + 1}/{pages.length}턴</span>}
										</div>
									)}
									<div ref={i === pageIdx ? curScrollRef : undefined} className="turk-message turk-message-past">
										<Md text={t.parsed?.message ?? t.a} />
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</div>

			<div className={`turk-grid${loading ? " turk-grid-loading" : ""}${keyboardUp ? " turk-grid-hidden" : ""}`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
				{gridRows.flat().map(([idx, label]) =>
					label ? (
						<button
							key={`${idx}:${gridVerRef.current}`}
							className={`turk-grid-btn${loading || !piReady ? " turk-grid-btn-off" : ""}${gridState.colors?.[idx] ? ` turk-bg-${gridState.colors[idx]}` : ""}${gridState.textColors?.[idx] ? ` turk-fg-${gridState.textColors[idx]}` : gridState.colors?.[idx] ? ` turk-fg-${["secondary", "muted", "accent", "destructive"].includes(gridState.colors[idx]) ? "white" : "black"}` : ""}`}
							aria-disabled={loading || !piReady}
							onClick={() => { if (loading || !piReady) return; handleSend(label); }} // disabled 속성 금지 — 비활성 폼 컨트롤은 터치 이벤트 자체가 소멸해 버튼영역 드래그(페이지 플립)가 죽는다. 클릭만 논리 가드.
							style={menuMode.current === "model" ? (() => {
								// 모델 선택 화면: 모델명이 길면 폰트 자동 축소 (기준 8칸, 최소 0.8em)
								const w = [...label].reduce((a, c) => a + (/[^\u0000-\u007f]/.test(c) ? 2 : 1), 0);
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
					if ((input.trim() || attachments.length > 0) && !loading && piReady) { handleSend(input.trim()); return; }
					if (!input.trim() && attachments.length === 0) inputRef.current?.blur(); // 빈 입력 엔터 — 언포커스(모바일 키보드 내림)
				}}
				onKeyDown={(e) => {
					if (e.key === "Escape" && loading) {
						cancelTurn();
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
					onClick={loading ? (() => { cancelTurn(); }) : undefined}
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