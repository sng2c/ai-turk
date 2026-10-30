/**
 * AI Turk 세션 코어 — server.ts(prod)와 vite.config.ts(dev turkPlugin)의 공용 부분.
 *
 * 지금까지 두 진입점에 쌍둥이 복제되던 세션/WS/영속화/푸시 로직의 단일 진원.
 * 발산 이력: dev측에 서버 자가수정(261008)·스트리밍 리플레이·풀 push payload가 누락돼 있었음 —
 * 이 파일은 prod(server.ts) 동작을 정본으로 수렴한다. 이후 풀(1b)·인증(Phase 2)도 여기에만 얹는다.
 *
 * 풀 시맨틱(1b): 세션 셸은 불멸(sessions 맵 무상한 — LRU 소멸 경로 제거, 스케줄 유실 결함 해소),
 * 희소자원=백엔드만 상한(TURK_MAX_BACKENDS) 배분. 수요지점(프롬프트·컴팩트 발화 + 스케줄러 트리거)에서
 * ensureBackend가 멱등 할당·유휴 LRU 회수를 수행하고, 60s 스윕이 WS 없는 유휴 백엔드를
 * dormant(backend=null — 셸·스케줄러 유지)로 회수한다. 재할당 큐 불필요 — start()가 spawn 직후
 * 동기 pi_ready emit + OS stdin 파이프가 부팅 전 명령 버퍼링 (backend.ts 근거).
 *
 * 열림 무지연·지연 할당(261010): WS 접속은 뷰어 신호일 뿐 — 백엔드를 기동하지 않고 pi_ready를 합성해 즉시
 * 서빙한다(스폰 0·디스크 0). dormant 세션의 get_state는 셸 상태로 합성 응답(lastModel 존재 시 model 포함),
 * get_available_models는 전역 캐시 재전달, set_thinking_level·set_model은 큐잉(pi_ready 재생) — 프로세스
 * 수요는 작업 명령(prompt·compact + 스케줄 발화)에만 발생. conversation.json도 첫 발화 성공 경로에서만 생성 —
 * 클릭만 한 대화는 dir 없이 재시작 시 자연 소멸(장부 자정).
 *
 * 대화 레지스트리(1c): 부팅 스윕이 데이터 dir을 스캔해 전 대화의 세션 셸을 복원한다(백엔드 스폰 없음 —
 * 수요 시점 기동; schedules.json은 Scheduler loadFromFile이 과거 nextRun=delay 0 즉시발화·미래=타이머 부활).
 * 각 대화의 메타는 <userKey>/conversation.json { title, createdAt, lastActiveAt, model? }로 영속화되고,
 * listConversations()(GET /api/conversations의 단일 진원)로 목록을 제공한다.
 *
 * 대화별 마지막 모델(무관성 계약): 라이브 get_state의 data.model을 lastModel로 보존(변화시에만 메타 model
 * 필드 영속 — 매 get_state마다 디스크를 찍지 않게), dormant 합성 get_state가 이를 재전달해 대화 진입 시
 * 마지막 모델 표시. dormant set_model은 pendingModel 큐잉 + 표시 선행 갱신 + 합성 성공 응답 — 스폰 0으로
 * 대화의 모델이 바뀐다 (실측 확정은 재생 set_model 이후 라이브 get_state의 기록점이 기록).
 *
 * 의존: ws, web-push, env-paths, node:fs/path/os — 신규 의존성 없음.
 */

import { WebSocket, WebSocketServer } from "ws";
import { createBackend, type Backend, type BackendOptions, type TurkEvent } from "./backend.ts";
import { Scheduler, formatTriggerMessage } from "./scheduler.ts";
import { validateTurkResponse } from "./src/lib/response-schema.ts";
import { ensureAgentsMd, applyEnvSection } from "./src/lib/agents-md-server.ts";
import envPaths from "env-paths";
import webpush from "web-push";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, statSync } from "node:fs";

const DATA_DIR = envPaths("ai-turk").data;

// 모델 메뉴 provider 화이트리스트 — TURK_PI_PROVIDERS (쉼표 구분, 예: "provider-a,provider-b").
// 미지정=필터 없음(전체 — 기존 동작). 지정 시 get_available_models 응답을 그 provider들만으로 좁힌다:
// 커스텀 provider(개인 게이트웨이 등)만 노출하는 운영 설정이며 값은 배포 .env(비공개)에만 존재 — 리포에는 변수 계약만.
const MODELS_PROVIDERS_WHITELIST = (process.env.TURK_PI_PROVIDERS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

// ── 워크스페이스 위치 분리 (261010 B확정) — 상태(DATA_DIR)와 작업물(산출물) 분리, 코드 마이그레이션 없음 ──
// TURK_WORKSPACES_ROOT 미설정 → 현행 경로 유지(join(DATA_DIR, userKey, "workspace") — 동작 0변경).
// 설정(절대경로) → join(ROOT, userKey). 호출시점 env 판독 — 테스트에서 동적 스위칭 가능.
export function workspacePath(userKey: string): string {
	const root = process.env.TURK_WORKSPACES_ROOT;
	return root ? join(root, userKey) : join(DATA_DIR, userKey, "workspace");
}

// ── userKey 형식 검증 (Phase 2) — userKey가 DATA_DIR 경로 조합에 직접 쓰이므로 경로조작 차단 ──
// 빈값·>100자·슬래시·".."·제어문자 거부, 한글·UUID·하이픈 통과. auth.ts에 동일 규칙 쌍둥이 존재
// (authorize 미주입 무인증 경로에도 항상 적용되도록 core 로컬 복제 — auth import의 모듈 부작용(시크릿 생성) 회피).
export function verifyUserKeyFormat(key: string): boolean {
	if (!key || key.length > 100) return false;
	if (key.includes("/") || key.includes("\\") || key.includes("..")) return false;
	for (const ch of key) {
		const c = ch.charCodeAt(0);
		if (c < 0x20 || c === 0x7f) return false; // 제어문자
	}
	return true;
}

// ── 1c 대화 레지스트리 — 데이터 dir 스캔: 상태 파일을 1개라도 보유한 디렉토리만 대화로 판별 ──
// agent-session-id(세션)·schedules.json(스케줄)·conversation.json(메타) 중 하나라도 있으면 대화.
// 루트의 파일(vapid.json 등)·상태 파일 없는 빈 디렉토리는 제외. 결과는 알파벳 정렬(스캔 결정성 — 테스트·로그 재현).
const CONVERSATION_STATE_FILES = ["agent-session-id", "schedules.json", "conversation.json"] as const;

// ── 히스토리 리더 상수/헬퍼 (출력 페이지 뷰어) ──
// 서버 자가수정 주입 프롬프트 식별 전위 — 히스토리 턴 경계에서 제외된다 (아래 readConversationHistory).
const RETRY_Q_PREFIXES = [
	"지난 응답이 올바른 JSON 형식이 아닙니다.",
	"지난 턴의 출력에 JSON 버튼 그리드가 없습니다.",
] as const;
const HISTORY_MAX_TURNS = 300; // 최근 턴 상한 — 페이로드 절약 (전체 로그 중 꼬리)

// pi 세션 파일 위치 — ~/.pi/agent/sessions/<sanitized-cwd>/<timestamp>_<session-id>.jsonl.
// cwd 치환 규칙을 재현하지 않고 session-id(UUID) 파일명 접미로 전 트리에서 역탐색(충돌 불가 — 커스텀 --session-id).
function findSessionFile(sessionId: string): string | null {
	const root = join(homedir(), ".pi", "agent", "sessions");
	let best: string | null = null, bestMtime = 0;
	try {
		for (const d of readdirSync(root, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			const dir = join(root, d.name);
			let files: string[];
			try { files = readdirSync(dir); } catch { continue; }
			for (const f of files) {
				if (!f.endsWith(`_${sessionId}.jsonl`)) continue;
				try {
					const m = statSync(join(dir, f)).mtimeMs;
					if (m > bestMtime) { bestMtime = m; best = join(dir, f); } // 동일 id 파일(레어) — 최신본
				} catch { /* 무시 */ }
			}
		}
	} catch { return null; } // sessions dir 미존재 — pi 세션 없음
	return best;
}

// AgentMessage 텍스트 블록 적출 — content가 배열이면 text 블록 join, 문자열이면 그대로
function agentMessageText(m: any): string {
	if (typeof m?.content === "string") return m.content;
	if (Array.isArray(m?.content)) return m.content.filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("\n");
	return "";
}
export function scanConversationDirs(dataDir: string): string[] {
	try {
		return readdirSync(dataDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && CONVERSATION_STATE_FILES.some((f) => existsSync(join(dataDir, d.name, f))))
			.map((d) => d.name)
			.sort();
	} catch { return []; } // 데이터 dir 미존재 — 신규 설치
}

// ── 세션 구조 — 유저(브라우저)별 독립 백엔드 + 스케줄러 ───────────────────
export interface Session {
	userKey: string;
	thinkingBuf: string; // 턴 내 씽킹 누적 — 재접속 소켓 리플레이용 (줄단위, agent_start 클리어)
	textBuf: string; // 턴 내 응답 텍스트 누적 — 리플레이용
	agentSessionId: string | null; // 백엔드 세션 ID (파일 영속, ready 시 get_state로 갱신). null = 새 세션
	backend: Backend | null; // 풀 회수·dormant 전환 시 null — 수요 시점에 ensureBackend가 재할당
	backendReady: boolean; // pi_ready 수신 플래그 — 백엔드 교체(크래시·회수) 때마다 리셋
	scheduler: Scheduler;
	pushSubscription: any; // 마지막 구독 (1인 — 세션당 1개)
	ws: Set<WebSocket>; // 같은 유저 다중 탭 — 동일 세션 broadcast. 사생활 탭 = 다른 userKey = 다른 세션
	lastResponse: any | null; // 마지막 agent_end 이벤트 캐시 — WS 미연결(백그라운드) 유실분 복원용 (마지막 1건)
	lastTurnFailed: boolean; // 응답 실패 명시 정의 — 마지막 agent_end.error 여부. get_state로 UI 전달
	lastPrompt: string | null; // 처리중 사용자 프롬프트 — 재연결 시 "뭘 기다리는지" 입력창 표시용 (isStreaming과 짝)
	lastResponsePrompt: string | null; // lastResponse가 대답하는 프롬프트 — 응답 상단 짝표시용
	isStreaming: boolean; // 백엔드 응답 생성 중 여부
	inCompact: boolean; // pi 컴팩트 턴 진행 중 — turk-JSON 위반 판정·자가수정·실패 마감 제외용 (1회 소비: agent_end에서 해제)
	lastActivity: number; // 마지막 활동 타임스탬프 (유휴 백엔드 회수 판정용)
	title: string | null; // 대화 타이틀 (1c) — 첫 유저 프롬프트 30자, null=미확정 (conversation.json 영속)
	createdAt: number; // 대화 생성 시각 (1c) — conversation.json에서 복원, 세션 재생성 시에도 보존
	lastActiveAt: number; // 마지막 대화 활동 (1c) — 접속 확정·프롬프트 발화마다 갱신, 레지스트리 정렬 기준
	lastViewedAt: number; // 마지막 열람 (1c) — 복원 기준 전용(lastActiveAt과 분리). 접속=열람으로 갱신, 백그라운드 턴·푸시는 건드리지 않음
	lastViewedWritten: number; // 위 갱신의 메타 디스크 기록 직후 시각 — 컴타 소켓 폭풍 대비 쓰기 스로틀
	currentRoute: "user" | "scheduler" | "tool"; // 현재 프롬프트 경로 — agent_start에 주입
	parseRetryCount: number; // 서버 자가수정(위반 응답 재시도) 카운터 — 성공·취소·신규 유저입력에서 리셋
	pendingThinkingLevel?: string; // 열림 무지연 — dormant 동안 수신한 set_thinking_level 큐 (pi_ready 재할당 시 재생 후 소멸)
	lastModel: Record<string, unknown> | null; // 대화별 마지막 실측 모델 — get_state data.model 원형 보존(JSON 안전 얕은 복사: provider·name·id·thinkingLevelMap·reasoning 등 통째). dormant 합성 get_state 재전달 + conversation.json model 필드 영속 — 모델은 대화의 속성(프로세스와 무관)
	lastContextPct: number | null; // 대화별 마지막 실측 컨텍스트 사용률(%) — 라이브 get_session_stats에서 변화시에만 기록. dormant 합성 stats 재전달 + conversation.json ctxPct 영속 — dormant 열람 시 헤더 바·메뉴 표시 (마지막 라이브 턴 시점 값)
	unread: boolean; // 확인 안 함 — 보는 탭 없이(ws 0) 턴이 끝난 대화. 드로어 노란 좌바. 접속(enterSession) 시 해소 + meta unread 영속
	lastThinkingLevel: string | null; // 대화별 마지막 실측 씽킹 레벨 — 라이브 get_state data.thinkingLevel에서 변화시에만 기록. dormant 합성 get_state 재전달 + conversation.json thinkingLevel 영속 + dormant set_thinking_level 선행 갱신 — 모델과 동일 완결
	pendingModel: { provider: string; modelId: string } | null; // dormant set_model 큐 — pi_ready 재생 1회 소멸 (pendingThinkingLevel과 동일 계약). 표시는 lastModel 선행 갱신이 담당
}

// ── Phase 2 인증 주입 계약 — server.ts(TURK_AUTH=1)가 auth.ts의 createAuthorizer() 객체를 전달.
//    core가 auth 모듈을 import하지 않기 위한 로컬 정의 (의존 방향: server→core · server→auth).
//    auth.ts의 Authorizer와 구조 일치만 요구 — stub 주입으로 단위테스트 가능.
export interface CoreAuthorizerRequest {
	url?: string; // ws 핸드셰이크 req(IncomingMessage)는 url·headers 보유
	headers?: Record<string, string | string[] | undefined>;
}
export interface CoreAuthorizer {
	authorizeRequest(req: CoreAuthorizerRequest): Promise<string | null>; // 쿠키 JWT 검증 → username | null
	checkConversation(username: string, userKey: string): "own" | "orphan" | "foreign";
	claimConversation(username: string, userKey: string): boolean;
	listOwnedKeys(username: string): string[]; // listConversations(username) own-필터용 — users.json 단일 판독
	/** 4c-refit — 계정별 환경변수 수령: userKey 소유 계정의 env 통째로. 백엔드 주입 전용 — 값은 spawn 프로세스
	 *  환경으로만 흐르고 응답·이벤트·AGENTS.md 어디에도 미기록(이름 목록만). 미소유·고아·AUTH off → {}. */
	accountEnv(userKey: string): Record<string, string>;
}

export interface SessionCoreConfig {
	maxSessions?: number; // 동시 백엔드 상한 (기본: TURK_MAX_BACKENDS || TURK_MAX_SESSIONS || 5) — 필드명 호환 유지(server.ts가 core.maxSessions 소비)
	parseRetries?: number; // 응답 자가수정 재시도 한도 (기본: TURK_PARSE_RETRIES || 2)
	debug?: boolean; // 진단 로그 (기본: TURK_DEBUG)
	backendFactory?: (opts: BackendOptions) => Backend; // 백엔드 팩터리 주입 (기본 createBackend — 테스트에서 FakeBackend)
	scanOnBoot?: boolean; // 부팅 스윕 (1c) — 코어 생성 시 데이터 dir을 스캔해 전 대화 셸을 복원. 기본 true (테스트 오염 방지 옵트아웃용 false)
	authorize?: CoreAuthorizer; // Phase 2 인증 (TURK_AUTH=1) — 미주입=기존 무인증 동작 (dev 기본 경로)
}

export interface SessionCore {
	sessions: Map<string, Session>;
	maxSessions: number;
	getOrCreateSession(userKey: string): Session | { error: string };
	removeSession(userKey: string): void;
	removeAllSessions(): void;
	handleConnection(ws: WebSocket, req: { url?: string; headers?: Record<string, string | string[] | undefined> }): void;
	keepAlive(wss: WebSocketServer): void;
	ensureBackend(session: Session): boolean; // 풀 할당 — 멱등(alive면 no-op). cap 도달 시 유휴 LRU victim 회수 후 할당, victim 없으면 false
	reclaimSweep(): number; // 유휴 백엔드 회수 스윕 1회 실행 (60s 인터벌 + 테스트·수동 트리거용) — 회수 수 반환
	listConversations(username?: string): ConversationSummary[]; // 대화 레지스트리 목록 (1c) — authorize 주입 시 username의 own만 필터 (orphan·foreign 제외)
	readConversationHistory(userKey: string): HistoryTurn[]; // 히스토리 리더 — pi 세션 JSONL에서 활성 브랜치 턴 목록 (페이지 뷰어 원료). 스폰 없이 디스크 직접 판독
	renameConversation(userKey: string, title: string): boolean; // 대화 이름 변경 (Phase 3) — 세션 셸·conversation.json 동시 갱신. 형식 위반·미존재 → false
	deleteConversation(userKey: string): boolean; // 대화 삭제 (Phase 3) — 셸 제거(removeSession 재사용) + 데이터·워크스페이스 dir 소멸. 멱등 — 형식 위반만 false
}

// 히스토리 턴 — GET /api/conversations/<key>/history 응답 항목 (시간순).
// q = 원 유저 프롬프트(첨부 경로 주입 포함 원문), a = 최종 assistant 텍스트(터크 JSON 원문 — 클라가 parseTurkJSON로 해석),
// id = assistant 엔트리 id·qId = user 엔트리 id (Phase 2 분기 fork 원료), model/ts = 페이지 헤더 표시용.
export interface HistoryTurn {
	id: string;
	qId: string;
	q: string;
	a: string;
	model?: string;
	ts?: string;
	compact?: { summary?: string; ts?: string }; // 직전 컴팩트 마커 — 이 턴부터 모델은 요약 기억. 클라 페이지 상단 라인 원료
}

// 대화 레지스트리 항목 (1c) — GET /api/conversations 응답 본체
export interface ConversationSummary {
	id: string; // userKey
	title: string | null; // 첫 유저 프롬프트 30자 (미확정 null)
	createdAt: number;
	lastActiveAt: number;
	active: boolean; // 백엔드 alive 여부
	streaming: boolean; // 응답 생성 중
	unread: boolean; // 확인 안 함 (ws 0에서 마감된 미열람 턴 존재)
	scheduleCount: number; // 등록 스케줄 수 — scheduler.list().data.count
	backendState: "active" | "dormant" | "starting"; // alive&&ready / 셸만(스폰 없음) / alive+미ready
}

// ── 영속화 헬퍼 (파일명/위치는 prod 종래 그대로) ───────────────────────────
function configPath(userKey: string): string {
	return `${DATA_DIR}/${userKey}/agent-session-id`;
}
function loadAgentSessionId(userKey: string): string | null {
	try {
		const f = configPath(userKey);
		if (!existsSync(f)) return null;
		const id = readFileSync(f, "utf-8").trim();
		return id || null;
	} catch { return null; }
}
function saveAgentSessionId(userKey: string, agentSessionId: string): void {
	try {
		const dir = `${DATA_DIR}/${userKey}`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(configPath(userKey), agentSessionId); // 평문 UUID
	} catch (err) { console.log(`[${userKey.slice(0, 8)}] [config] 저장 실패: ${err instanceof Error ? err.message : err}`); }
}
// ── lastPrompt 영속화 (서버 출력버퍼) — 재시작·세션 재생성·다른 브라우저와 무관하게 이전 입력 제공 ──
function loadLastPrompt(userKey: string): string | null {
	try {
		const f = `${DATA_DIR}/${userKey}/last-prompt`;
		if (!existsSync(f)) return null;
		return readFileSync(f, "utf-8") || null;
	} catch { return null; }
}
function saveLastPrompt(userKey: string, v: string): void {
	try { writeFileSync(`${DATA_DIR}/${userKey}/last-prompt`, v); } catch { /* 디스크 실패 무시 */ }
}

// ── lastResponse 영속화 (서버 출력버퍼) — 재시작·세션 재생성 후에도 마지막 가시 응답 복원.
//    lastPrompt와 대칭. agent_end 캐시 지점에서만 기록 — silent·스키마 위반 응답은 미기록.
function lastResponsePath(userKey: string): string {
	return `${DATA_DIR}/${userKey}/last-response`;
}
function loadLastResponse(userKey: string): { ev: any; prompt: string | null } | null {
	try {
		const f = lastResponsePath(userKey);
		if (!existsSync(f)) return null;
		return JSON.parse(readFileSync(f, "utf-8"));
	} catch { return null; }
}
function saveLastResponse(userKey: string, ev: any, prompt: string | null): void {
	try { writeFileSync(lastResponsePath(userKey), JSON.stringify({ ev, prompt })); } catch { /* 디스크 실패 무시 */ }
}
function clearLastResponse(userKey: string): void {
	try { rmSync(lastResponsePath(userKey), { force: true }); } catch { /* 무시 */ }
}
function pushPath(userKey: string): string {
	return `${DATA_DIR}/${userKey}/push.json`;
}
function loadPushSubscription(userKey: string): any | null {
	try {
		const f = pushPath(userKey);
		if (!existsSync(f)) return null;
		return JSON.parse(readFileSync(f, "utf-8"));
	} catch { return null; }
}
function savePushSubscription(userKey: string, sub: any): void {
	try {
		const dir = `${DATA_DIR}/${userKey}`;
		mkdirSync(dir, { recursive: true });
		writeFileSync(pushPath(userKey), JSON.stringify(sub));
	} catch (err) { console.log(`[${userKey.slice(0, 8)}] [push] 저장 실패: ${err instanceof Error ? err.message : err}`); }
}
function clearPushSubscription(userKey: string): void {
	try { rmSync(pushPath(userKey), { force: true }); } catch { /* 무시 */ }
}

// ── conversation.json 영속화 (1c 대화 레지스트리) — 대화 메타. 스키마: { title, createdAt, lastActiveAt, model? } ──
// title=null(미확정) → 첫 유저 프롬프트 30자로 확정. model은 선택 필드(과거 메타 부재 허용), 존재 시 data.model 원형 저장. createdAt은 세션 재생성 시 기존 파일을 만나면 보존(미수정).
interface ConversationMeta {
	title: string | null;
	createdAt: number;
	lastActiveAt: number;
	lastViewedAt?: number; // 마지막 열람 (선택 — 레거시 파일 부재 허용). 복원 기준 = 이 값 1위 (turn 기반 lastActiveAt와 분리)
	model?: Record<string, unknown> | null; // 대화별 마지막 실측 모델 (선택 — 기능 이전 메타 부재 허용)
	ctxPct?: number | null; // 대화별 마지막 실측 컨텍스트 사용률(%) (선택 — 부재 허용)
	thinkingLevel?: string | null; // 대화별 마지막 실측 씽킹 레벨 (선택 — 부재 허용)
	unread?: boolean; // 확인 안 함 (true만 기록 — 해소 시 재기록에서 자연 제거)
}
function conversationMetaPath(userKey: string): string {
	return `${DATA_DIR}/${userKey}/conversation.json`;
}
function loadConversationMeta(userKey: string): ConversationMeta | null {
	try {
		const f = conversationMetaPath(userKey);
		if (!existsSync(f)) return null;
		const m = JSON.parse(readFileSync(f, "utf-8"));
		if (typeof m?.createdAt !== "number" || typeof m?.lastActiveAt !== "number" || (m.title !== null && typeof m.title !== "string")) return null; // 스키마 무효 → 신규 취급
		return m;
	} catch { return null; }
}
function saveConversationMeta(userKey: string, meta: ConversationMeta): void {
	try {
		mkdirSync(`${DATA_DIR}/${userKey}`, { recursive: true });
		writeFileSync(conversationMetaPath(userKey), JSON.stringify(meta));
	} catch (err) { console.log(`[${userKey.slice(0, 8)}] [conversation] 저장 실패: ${err instanceof Error ? err.message : err}`); }
}

// ── 응답 텍스트에서 마지막 assistant 텍스트 추출 ─────────────────────────
function extractTextFromMessages(messages: any[]): string {
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

// 응답 텍스트에서 터크 JSON 추출 후 JSON Schema 1차 게이트 검사.
// 후보(코드펜스→greedy→첫'{') 중 스키마 유효한 것 채택 — 전부 위반 시 parsed는 보존하되 valid=false.
// 스키마가 법: Visible/Silent 이분법·schedules 형태 위반은 소비부(캐시·push·적용)에서 일괄 배제된다.
// errors = 마지막 후보의 오류(클라 parseTurkJSON과 동일 규칙) — 서버 자가수정 안내문에 그대로 실린다.
export function parseTurkResponse(ev: TurkEvent): { text: string; parsed: any | null; valid: boolean; errors?: string } {
	const messages = (ev as any).messages;
	const text = Array.isArray(messages) ? extractTextFromMessages(messages) : "";
	if (!text) return { text: "", parsed: null, valid: false, errors: "최종 출력 텍스트 없음(도구만)" };
	const candidates: string[] = [];
	const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fence) candidates.push(fence[1]);
	const greedy = text.match(/\{[\s\S]*\}/);
	if (greedy) candidates.push(greedy[0]);
	const firstBrace = text.indexOf("{");
	if (firstBrace !== -1) candidates.push(text.slice(firstBrace));
	let firstParsed: any = null, lastError: string | undefined;
	for (const raw of candidates) {
		const s = raw.trim();
		if (!s) continue;
		try {
			const obj = JSON.parse(s);
			const v = validateTurkResponse(obj);
			if (v.ok) return { text, parsed: obj, valid: true };
			if (firstParsed === null) firstParsed = obj;
			lastError = v.errors ?? "schema violation"; // JSON Schema 1차 게이트
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}
	return { text, parsed: firstParsed, valid: false, errors: lastError ?? "파싱 실패" };
}

// ── 풀 판정 순수함수 (1b) — now 주입으로 단위테스트 가능 ──────────────────
// 회수 부정조건: WS 있음(대화 가능성 우선)·isStreaming(백그라운드 응답 생성 중 — 회수=응답 유실)·dormant(이미 backend null — stop 재호출 없음)
export function shouldReclaim(
	s: Pick<Session, "ws" | "isStreaming" | "backend" | "lastActivity">,
	now: number,
	idleMs: number,
): boolean {
	return s.ws.size === 0 && !s.isStreaming && s.backend?.alive() === true && now - s.lastActivity > idleMs;
}

// 유휴 victim 선택(수요 확보용 스틸) — WS 없음·비스트리밍·alive 중 최오래(lastActivity 최소) 1명 LRU. 없으면 null.
// 시간 임계 없음: 스틸의 대가는 재기동 수 초(대화 연속성 보존)뿐인 반면, 임계를 두면 최근 유휴들이 만원을 막아
// 신규 수요가 최대 TURK_IDLE_RECLAIM_SEC 까지 서비스 거부되는 비대칭이 생긴다. 임계는 스윕(시간 주도 회수)에만 속한다.
export function pickReclaimVictim(sessions: Map<string, Session>): Session | null {
	let victim: Session | null = null;
	for (const s of sessions.values()) {
		if (s.ws.size !== 0 || s.isStreaming || s.backend?.alive() !== true) continue;
		if (!victim || s.lastActivity < victim.lastActivity) victim = s;
	}
	return victim;
}

// ── 세션 코어 팩터리 ─────────────────────────────────────────────────────
export function createSessionCore(cfg?: SessionCoreConfig): SessionCore {
	const DEBUG = cfg?.debug ?? !!process.env.TURK_DEBUG;
	// ── 1b 풀 설정 ──
	const envInt = (v: string | undefined, fallback: number): number => {
		const n = v === undefined || v === "" ? NaN : parseInt(v, 10);
		return Number.isFinite(n) ? n : fallback;
	};
	// 동시 백엔드 상한 — TURK_MAX_BACKENDS 신설(구 TURK_MAX_SESSIONS 승계), 기본 5.
	const MAX_BACKENDS = cfg?.maxSessions ?? envInt(process.env.TURK_MAX_BACKENDS, envInt(process.env.TURK_MAX_SESSIONS, 5));
	const IDLE_RECLAIM_MS = envInt(process.env.TURK_IDLE_RECLAIM_SEC, 300) * 1000; // WS 없는 유휴 백엔드 회수 임계 (ms)
	const createBackendFn = cfg?.backendFactory ?? createBackend; // 백엔드 팩터리 — 테스트 주입용 (기본 createBackend)
	const SERVER_PARSE_RETRIES = cfg?.parseRetries ?? parseInt(process.env.TURK_PARSE_RETRIES || "2"); // 서버 자가수정 재시도 한도 — 응답 위반(파싱·스키마) 시 원문+에러 되돌려 교정
	const authorize = cfg?.authorize; // Phase 2 인증·소유권 계약 (미주입=기존 무인증 동작)

	// ── Web Push (VAPID 키 파일 영속화) — 재시작마다 키가 바뀌면 기존 구독 전부 무효(403) → 푸시 실패 ──
	const vapidPath = join(DATA_DIR, "vapid.json");
	let vapidKeys: { publicKey: string; privateKey: string };
	try {
		vapidKeys = JSON.parse(readFileSync(vapidPath, "utf-8"));
		console.log("[VAPID] 저장된 키 로드");
	} catch {
		vapidKeys = webpush.generateVAPIDKeys();
		try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(vapidPath, JSON.stringify(vapidKeys)); console.log("[VAPID] 신규 키 생성+저장"); } catch { /* 디스크 실패 — 메모리 키로 계속 */ }
	}
	const VAPID_PUBLIC_KEY: string = vapidKeys.publicKey;
	webpush.setVapidDetails("mailto:ai-turk@local", VAPID_PUBLIC_KEY, vapidKeys.privateKey);

	const sessions = new Map<string, Session>();

	// ── get_available_models 전역 캐시 (열림 무지연) — 마지막 라이브 성공 응답 1건 보관 → dormant 재요청에
	//    재전달. 모델 목록은 계정·대화 공통 자원이라 코어 단위 1슬롯 캐시로 족하다 (세션 키 불필요).
	let modelsCache: TurkEvent | null = null;

	// ── 1c 부팅 스윕 — 대화 레지스트리 복원: 데이터 dir 스캔 → 전 대화 셸 생성 (백엔드 스폰 없음) ──
	// createSession의 Scheduler가 schedules.json을 로드해 즉시 부활 — 과거 nextRun은 delay 0 즉시발화,
	// 미래는 타이머 부활. 셸만 복원하는 이유: 백엔드 수요는 과기 스케줄 발화 지점에서만 발생 (결정 기록 261010).
	if (cfg?.scanOnBoot !== false) {
		const keys = scanConversationDirs(DATA_DIR);
		let restored = 0;
		for (const key of keys) {
			if (sessions.has(key)) continue;
			createSession(key);
			restored++;
		}
		console.log(`[Pool] 부팅 스윕: 대화 ${restored}개 셸 복원`);
	}

	// 같은 세션(유저) WS 전체에 broadcast — 다중 탭 동기화
	function broadcast(session: Session, data: Record<string, unknown>): void {
		if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [WS] 송신: type=${data.type}${data.command ? " command=" + data.command : ""}`);
		const msg = JSON.stringify(data);
		for (const ws of session.ws) {
			if (ws.readyState === WebSocket.OPEN) ws.send(msg);
		}
	}

	// 1c 대화 메타 갱신 — lastActiveAt=now 파일 저장.
	// 기록 존재 게이트(열림 무지연): 기본은 conversation.json이 이미 존재할 때만 갱신 — 클릭만 한(무발화)
	// 대화는 디스크 기록 0(dir 자체 미생성)이라 재시작 시 자연 소멸. create=true는 프롬프트 성공 경로(sendToBackend)
	// 전용 — 첫 발화가 대화의 디스크 시작점(장부 자정). 접속 확정(enterSession) 경로는 게이트 갱신만.
	// 메타 저장 본체 — model(lastModel)은 선택 필드: 존재 시에만 기록 (기존 title·createdAt·lastActiveAt 보존)
	function metaPayload(session: Session): ConversationMeta {
		return { title: session.title, createdAt: session.createdAt, lastActiveAt: session.lastActiveAt, lastViewedAt: session.lastViewedAt, ...(session.lastModel ? { model: session.lastModel } : {}), ...(session.lastContextPct != null ? { ctxPct: session.lastContextPct } : {}), ...(session.lastThinkingLevel != null ? { thinkingLevel: session.lastThinkingLevel } : {}), ...(session.unread ? { unread: true } : {}) };
	}
	function touchConversationMeta(session: Session, create = false): void {
		session.lastActiveAt = Date.now();
		if (!create && !existsSync(conversationMetaPath(session.userKey))) return; // 클릭만 한 대화 — 메타 미생성
		saveConversationMeta(session.userKey, metaPayload(session));
	}

	// ── 웹 푸시 ────────────────────────────────────────────────────────────
	// 스키마 유효 + Visible 응답만 푸시 — Silent·위반(빈 message 등)은 폐기
	// 전체 text + sessionId + userKey 전송 — sw.js가 userKey로 tag·억제·클릭 포커스를 키별 구분
	function sendPushNotification(session: Session, ev: TurkEvent): void {
		const { text, parsed, valid } = parseTurkResponse(ev);
		if (!text) return;
		if (!valid || parsed?.silent === true) return;
		const payload = JSON.stringify({ body: text, sessionId: session.agentSessionId || "", url: "/#" + session.userKey, userKey: session.userKey, title: session.title }); // title = 대화 별명 (1c) — sw.js가 푸시 제목으로 우선 사용, null이면 키 표기 폴백
		webpush.sendNotification(session.pushSubscription, payload)
			.then(() => console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 성공`))
		.catch((err: any) => {
			console.log(`[${session.userKey.slice(0, 8)}] [Push] 전송 실패: ${err.message}`);
			// 구독 자체가 죽은 것(410/404) — 폐기 + 클라에 재구독 요청 (자가치유 루프)
			if (err.statusCode === 410 || err.statusCode === 404) {
				session.pushSubscription = null;
				clearPushSubscription(session.userKey);
				broadcast(session, { type: "push_invalid" });
			}
		});
	}

	// backend.send 가로채기 — route 추적 + dormant 합성 게이트(열림 무지연) + 백엔드 수요 ensure
	function sendToBackend(session: Session, cmd: Record<string, unknown>, opts?: { route?: "user" | "scheduler" | "tool" }): void {
		const route = (opts?.route ?? cmd.route ?? "user") as "user" | "scheduler" | "tool";
		// ── dormant 합성·큐잉 — 미기동 세션의 조회성·설정성 명령은 스폰 없이 마감 ("WS는 뷰어 신호,
		//    프로세스는 작업 명령만 부른다" 계약 — 접속 후 클라가 내 뱉는 get_state/models/thinking이
		//    백엔드를 깨우지 않는다). 수요지점은 아래 ensure 목록(prompt·compact + 스케줄 발화)만 — set_model은 큐잉으로 스폰 0 수용.
		if (!(session.backend?.alive())) {
			// get_state 합성 — 캐시된 세션 셸 상태로 응답. 새 대화(agentSessionId null) → sessionId="" →
			// 클라 복원 스킵(빈 그리드), 기존 대화 → 진짜 agentSessionId + lastResponse로 완전 복원.
			// 필드 세트는 라이브 get_state 보강 블록(onEvent)과 동일 유지 — 클라 소비 계약 단일 정합.
			// model은 lastModel 존재 시만 포함 — 기능 이전 생성분(실측 이력 없음)은 absent(클라 가드 소비 현행과 동일).
			// thinkingLevel·messageCount 등은 클라가 가드형 소비(if 존재 검사)이라 absent 허용.
			if (cmd.type === "get_state") {
					healStreaming(session); // 유령 스트리밍 — 백엔드 없는 streaming 기록을 복원 전에 해제 (dim 스틱 근원 차단)
				broadcast(session, {
					type: "response", command: "get_state", success: true,
					data: { sessionId: session.agentSessionId ?? "", lastPrompt: session.lastPrompt,
						isStreaming: session.isStreaming, route: session.currentRoute,
						lastResponse: session.lastResponse, lastResponsePrompt: session.lastResponsePrompt,
						lastTurnFailed: session.lastTurnFailed, backendState: backendStateOf(session), isCompacting: false, ...(session.lastModel ? { model: session.lastModel } : {}), ...(session.lastThinkingLevel != null ? { thinkingLevel: session.lastThinkingLevel } : {}) },
				});
				return;
			}
			// get_session_stats 합성 — dormant는 라이브 계산 불가하므로 마지막 실측(lastContextPct) 재전달.
			// 값은 마지막 라이브 턴 시점 (첫 발화 후 라이브 stats가 갱신). 실측 이력 없으면 무응답 — 클라 가드 소비(현행).
			if (cmd.type === "get_session_stats" && session.lastContextPct != null) {
				broadcast(session, { type: "response", command: "get_session_stats", success: true, data: { contextUsage: { percent: session.lastContextPct } } });
				return;
			}
			// get_available_models 합성 — 전역 캐시(마지막 라이브 성공 응답) 재전달. 캐시 없음(서버 재시작 직후
			// 라이브 목록을 1회도 받지 못한 신규 대화)은 무응답 수용 — 클라 현상 유지(빈 메뉴), 드롭다운 재오픈
			// 등 라이브 경로 응답으로 캐시가 채워지면 이후는 합성. 스폰하지 않는다.
			if (cmd.type === "get_available_models") {
				if (modelsCache) broadcast(session, modelsCache);
				return;
			}
			// set_thinking_level 큐잉 — 모델·컨텍스트%와 동일 완결(261012): 합성 success 응답 + lastThinkingLevel
			// 선행 갱신(표시 확정 — 클라 set→get_state 체인이 합성 get_state.thinkingLevel로 마감). 큐는 pi_ready에서
			// spawn 동기 재생 → 같은 틱 후속 prompt에 선행 보장 (변경 없음).
			if (cmd.type === "set_thinking_level") {
				const lvl = String(cmd.level ?? "");
				session.pendingThinkingLevel = lvl;
				session.lastThinkingLevel = lvl; // 표시 선행 갱신 — dormant 표시·재접속 동기화 원료
				touchConversationMeta(session); // exists-게이트 — thinkingLevel 필드 추가 기록
				broadcast(session, { type: "response", command: "set_thinking_level", success: true, data: {} }); // 합성 성공 — 클라 get_state 체인 유발
				return;
			}
			// set_model dormant 큐잉 — 모델은 대화의 속성(프로세스의 속성이 아님): 스폰 없이 변경을 수용해
			// pendingModel로 큐잉(pi_ready에서 set_model → set_thinking_level 순 재생 후 1회 소멸). 표시는
			// lastModel 선행 갱신 + 합성 get_state로 확정되고, 합성 성공 응답이 클라의 set_model→get_state 체인을 유발한다.
			if (cmd.type === "set_model") {
				const provider = String(cmd.provider ?? "");
				const modelId = String(cmd.modelId ?? cmd.model ?? "");
				if (!provider || !modelId) return; // 형식 파라미터 — 무응답 (기존 관례)
				session.pendingModel = { provider, modelId };
				session.lastModel = { ...session.lastModel, provider, name: modelId, id: modelId }; // 표시 선행 갱신 — 기존 thinkingLevelMap 등 원형 보존
				touchConversationMeta(session); // exists-게이트 — 미발화 대화는 디스크 0 유지 (설정 계약)
				broadcast(session, { type: "response", command: "set_model", success: true, data: {} }); // 합성 성공 — 클라 get_state 체인 → 합성 get_state.model이 표시 확정
				return;
			}
		}
		// 프롬프트·컴팩트는 백엔드 수요지점(스케줄러 트리거·WS 발화 공용) — 발화/실행 전 멱등 할당.
		// set_model은 수요지점 탈락 — dormant는 위 합성 블록이 큐잉, alive면 그대로 백엔드 직송(ensure는 alive no-op).
		// 실측 확정은 재생·직송 set_model 이후 라이브 get_state(onEvent 기록점)가 lastModel에 기록한다.
		// 컴팩트 미게이트는 실장애(261010): dormant 세션에서 무음 소실 → UI '진행 중' 사장.
		// cap 초과 거부 시: agent_start/isStreaming 설정 없이 에러 응답을 클라가 해듑하는 형태로 마감 (문안 기존 준수).
		if (cmd.type === "prompt" || cmd.type === "compact") {
			if (!ensureBackend(session)) {
				console.log(`[${session.userKey.slice(0, 8)}] [Pool] 백엔드 초과 — ${cmd.type} 거부 (활성 ${activeBackendCount()}/${MAX_BACKENDS})`);
				if (cmd.type === "compact") broadcast(session, { type: "response", command: "compact", success: false, error: "최대 백엔드 초과 — 잠시 후 다시 시도해 주세요" });
				else broadcast(session, { type: "agent_end", error: "최대 백엔드 초과 — 활성 세션이 가득 찼습니다. 잠시 후 다시 시도해 주세요." });
				return;
			}
			session.lastActivity = Date.now(); // 발화 = 활동 — 유휴 회수 임계 갱신
			// 1c 대화 메타 — 프롬프트 성공 경로 한정 무조건 기록(create=true — 신규 대화 메타 생성도 여기가 유일 시점).
			// 첫 유저 프롬프트 30자로 타이틀 확정 (거부·scheduler/tool 라우트 불변 — set_model은 여기 도달 불가)
			if (route === "user" && typeof cmd.userInput === "string" && session.title === null) session.title = cmd.userInput.slice(0, 30);
			touchConversationMeta(session, true);
		}
		session.currentRoute = route;
		// 처리중 프롬프트 기록 — 재연결/새로고침 후 get_state로 표시 (user 라우트 순수 입력만)
		if (cmd.type === "prompt" && route === "user" && typeof cmd.userInput === "string") {
			session.lastPrompt = cmd.userInput;
			session.parseRetryCount = 0; // 신규 유저 턴 — 자가수정 카운터 리셋 (소진 후 재전송도 재검증)
			saveLastPrompt(session.userKey, cmd.userInput); // 출력버퍼 영속화
		}
		// prompt 전송 전에 합성 agent_start broadcast — 즉시 로고 전환 + dim
		if (cmd.type === "prompt") {
			session.isStreaming = true;
			broadcast(session, { type: "agent_start", route });
		}
		// 취소 완결 — abort만으론 pi 자동재시도 '지연'을 못 끊음. abort_retry 병행으로 사용자 의도(완전 취소) 보장
		if (cmd.type === "abort") {
			const wasStreaming = session.isStreaming;
			session.backend?.send({ type: "abort_retry" });
			session.backend?.send(cmd);
			// 수신자 없는 취소 — 백엔드가 죽었거나(dormant·크래시) 이 세션에 진행 턴이 없으면 abort에 응답이 영영 없다.
			// 클라 dim을 즉시 해제시키는 취소 확정 응답을 합성 (취소 = 무조건 완료 계약).
			if (!session.backend?.alive() || !wasStreaming) {
				session.isStreaming = false;
				console.log(`[${session.userKey.slice(0, 8)}] [Abort] 수신자 없는 취소 — 즉시 완결 합성`);
				broadcast(session, { type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
			}
			return;
		}
		session.backend?.send(cmd)
	}

	// ── 풀 시맨틱 (1b) — 희소자원=백엔드, 세션 셸은 불멸 ──────────────────────
	// 활성 백엔드 수 — cap 판정용 (dormant·기동 실패 셸은 미집계)
	function activeBackendCount(): number {
		let n = 0;
		for (const s of sessions.values()) if (s.backend?.alive()) n++;
		return n;
	}

	// 백엔드 회수 — stop→null→ready=false. 셸·스케줄러·lastResponse 캐시는 유지 (다음 수요에 재할당)
	function reclaimSession(session: Session, reason: string): void {
		console.log(`[${session.userKey.slice(0, 8)}] [Pool] 백엔드 회수(${reason}) — dormant 전환 (활성 ${activeBackendCount() - 1}/${MAX_BACKENDS})`);
		session.backend?.stop();
		session.backend = null;
		session.backendReady = false;
	}

	// 풀 할당 — 멱등(이미 alive면 무동작, 기동 중도 true). cap 도달 시 WS 없는 유휴 victim(최오래 LRU)을
	// 회수해 슬롯 확보 — victim 없으면 false(거부; 호출부 정책: WS 프롬프트=에러 broadcast / 스케줄러=1m 재등록).
	function ensureBackend(session: Session): boolean {
		if (session.backend?.alive()) return true;
		if (activeBackendCount() >= MAX_BACKENDS) {
			const victim = pickReclaimVictim(sessions);
			if (!victim) return false;
			reclaimSession(victim, "신규 할당용 슬롯 확보");
		}
		startBackend(session);
		return true;
	}

	// 유휴 백엔드 회수 스윕 1회 — 테스트·수동 트리거용 노출. 회수 수 반환.
	function reclaimSweep(): number {
		const now = Date.now();
		let reclaimed = 0;
		for (const s of sessions.values()) {
			if (!shouldReclaim(s, now, IDLE_RECLAIM_MS)) continue;
			reclaimSession(s, `유휴 ${Math.floor((now - s.lastActivity) / 1000)}s`);
			reclaimed++;
		}
		return reclaimed;
	}
	setInterval(reclaimSweep, 60_000).unref?.(); // 60s 회수 스윕 — 서버 생명 유지 책임은 listen 쪽

	// ── 1c 대화 레지스트리 — 백엔드 상태 표기 + 목록 ─────────────────────────
	// dormant(셸만 — 백엔드 null·비alive) / starting(스폰됐지만 ready 전) / active(ready 완료)
	// 유령 스트리밍 치유 — isStreaming인데 살아있는 백엔드가 없으면(pi kill·스폰 직후 크래시 등) 턴은 더 이상 없다.
	// get_state 구성점에서 기록을 false로 고친다 — 브로드캐스트 없이도 클라 복원(else setLoading(false))이 dim을 해제.
	// 취소 불가 유령 턴의 근원 차단 (863bffcb 케이스).
	function healStreaming(session: Session): void {
		if (session.isStreaming && session.backend?.alive() !== true) {
			session.isStreaming = false;
			console.log(`[${session.userKey.slice(0, 8)}] [Pool] 유령 스트리밍 치유 — 백엔드 없음, isStreaming 해제`);
		}
	}
	function backendStateOf(session: Session): "active" | "dormant" | "starting" {
		if (session.backend?.alive() !== true) return "dormant";
		return session.backendReady ? "active" : "starting";
	}
	// GET /api/conversations 단일 진원 — lastActiveAt 내림차순 (최근 대화 우선)
	// authorize 주입 + username 지정 시 own만 필터 (자신의 userKeys에 등록된 대화) — orphan·foreign 제외
	function listConversations(username?: string): ConversationSummary[] {
		const owned = authorize && username ? new Set(authorize.listOwnedKeys(username)) : null;
		const list = Array.from(sessions.values())
			.filter((s) => !owned || owned.has(s.userKey))
			.map((s) => ({
			id: s.userKey,
			title: s.title,
			createdAt: s.createdAt,
			lastActiveAt: s.lastActiveAt,
			active: s.backend?.alive() === true,
			streaming: s.isStreaming,
			unread: s.unread,
			scheduleCount: s.scheduler.list().data.count,
			backendState: backendStateOf(s),
		}));
		list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		return list;
	}

	// ── 히스토리 리더 (출력 페이지 뷰어) — pi 세션 JSONL에서 활성 브랜치 턴 목록을 읽는다 ──
	// 백엔드 스폰 없이 디스크 직접 판독(appendFileSync 동기 플러시 — agent_end 시점 이미 기록완료) —
	// dormant 대화도 즉시 서빙. claude 백엔드(세션 파일 없음)·미발화 대화는 빈 목록 → 클라가 단일 페이지로 동작.
	// 활성 브랜치 = 마지막 엔트리→루트 경로(pi buildSessionPath 계약 — leaf 미지정시 append 순 마지막).
	// 서버 자가수정 재시도 프롬프트는 턴 경계에서 제외(원 질문 승계), aborted 최종응답은 미완 턴으로 배제.
	function readConversationHistory(userKey: string): HistoryTurn[] {
		if (!verifyUserKeyFormat(userKey)) return [];
		const sid = loadAgentSessionId(userKey);
		if (!sid) return [];
		const file = findSessionFile(sid);
		if (!file) return [];
		let raw: string;
		try { raw = readFileSync(file, "utf-8"); } catch { return []; }
		const entries: any[] = [];
		const byId = new Map<string, any>();
		for (const line of raw.split("\n")) {
			const s = line.trim();
			if (!s) continue;
			try {
				const e = JSON.parse(s);
				if (e?.type === "session") continue; // 헤더는 트리 밖
				entries.push(e);
				if (e?.id) byId.set(e.id, e);
			} catch { continue; } // 끊긴 꼬리 라인 — 무시
		}
		// 활성 브랜치 — 마지막 엔트리부터 parentId를 따라 루트까지, 뒤집어 시간순으로
		const path: any[] = [];
		let cur: any = entries[entries.length - 1] ?? null;
		while (cur) { path.push(cur); cur = cur.parentId ? (byId.get(cur.parentId) ?? null) : null; }
		path.reverse();
		// 턴 구성 — user 프롬프트로 시작, 턴 내 마지막 assistant 텍스트(도구 체인의 최종응답)로 마감.
		// 재시도 주입은 user 프롬프트지만 턴 경계가 아니다(원 질문 승계) — skip해 다음 assistant가 a를 덮어쓴다.
		// compaction 엔트리는 턴 경계가 아니지만 "기억 전환점"이라 다음 턴에 마커로 부착 (페이지 상단 🧹 라인).
		const turns: HistoryTurn[] = [];
		let q: string | null = null, qId = "";
		let a: string | null = null, aId = "", model: string | undefined, ts: string | undefined;
		let pendingCompact: { summary?: string; ts?: string } | null = null; // compaction 엔트리 → 다음 턴 시작 시 소비
		let turnCompact: { summary?: string; ts?: string } | null = null; // 이 턴의 마커 — 컴팩트 직후 시작 턴에만
		const flush = () => {
			if (q != null && a != null) turns.push({ id: aId, qId, q, a, ...(model ? { model } : {}), ...(ts ? { ts } : {}), ...(turnCompact ? { compact: turnCompact } : {}) });
			q = null; a = null; model = undefined; ts = undefined; turnCompact = null;
		};
		for (const e of path) {
			if (e.type === "compaction") {
				pendingCompact = { ...(typeof e.summary === "string" && e.summary ? { summary: e.summary } : {}), ...(typeof e.timestamp === "string" ? { ts: e.timestamp } : {}) };
				continue;
			}
			if (e.type !== "message") continue; // model_change 등은 표시에서 제외
			const m = e.message ?? {};
			if (m.role === "user") {
				const text = agentMessageText(m);
				if (!text) continue;
				if (RETRY_Q_PREFIXES.some((p) => text.startsWith(p))) continue; // 서버 자가수정 주입 — 턴 경계 아님
				flush();
				q = text; qId = String(e.id ?? "");
				turnCompact = pendingCompact; pendingCompact = null; // 컴팩트 직후 시작 턴 — 이 지점부터 요약 기억 마커
			} else if (m.role === "assistant" && m.stopReason !== "aborted") {
				const text = agentMessageText(m);
				if (text) { a = text; aId = String(e.id ?? ""); model = typeof m.model === "string" ? m.model : undefined; ts = typeof e.timestamp === "string" ? e.timestamp : undefined; }
			}
		}
		flush();
		return turns.slice(-HISTORY_MAX_TURNS); // 최근순 상한 — 페이로드 절약 (컴팩션 이전 포함 전체 중 꼬리)
	}

	// ── 개별 대화 관리 (Phase 3) — 드로어 항목 PATCH/DELETE의 단일 진원 ──
	// 이름 변경 — 형식 검증(경로조작 방어) 후 세션 셸의 title을 갱신하고 conversation.json에 저장.
	// title 규칙: 빈 문자열·100자 이하 허용, 초과분은 slice(0,100) (첫 프롬프트 30자 자동 타이틀과 취지 동일).
	function renameConversation(userKey: string, title: string): boolean {
		if (!verifyUserKeyFormat(userKey) || typeof title !== "string") return false;
		const session = sessions.get(userKey);
		if (!session) return false; // 미존재 대화 — 레지스트리에 셸이 없는 키
		session.title = title.length > 100 ? title.slice(0, 100) : title;
		saveConversationMeta(userKey, metaPayload(session)); // model 필드 보존 — rename이 모델 이력을 지우지 않게
		console.log(`[${userKey.slice(0, 8)}] [Registry] 이름 변경: ${session.title}`);
		return true;
	}

	// 삭제 — 존재 세션은 removeSession 재사용(session_terminated broadcast·WS close·스케줄 destroy·backend stop이
	// 전부 이관) 후 데이터 dir(상태파일·conversation.json·schedules.json 통째)를 rm. 멱등 — 셸이 이미 없어도 dir
	// 소멸·true로 귀결 (드로어 재시도·폴링 레이스에서 안전). workspacePath가 DATA_DIR 밖(TURK_WORKSPACES_ROOT)이면 그것도 제거.
	function deleteConversation(userKey: string): boolean {
		if (!verifyUserKeyFormat(userKey)) return false; // rm 경로조작 방어 — server.ts 라우트와 이중 가드
		removeSession(userKey); // 미존재 셸은 no-op — 멱등 성립
		try { rmSync(`${DATA_DIR}/${userKey}`, { recursive: true, force: true }); } catch (e) { console.log(`[${userKey.slice(0, 8)}] [Registry] 데이터 dir 삭제 실패: ${e instanceof Error ? e.message : e}`); }
		try {
			const wsPath = workspacePath(userKey);
			if (!wsPath.startsWith(`${DATA_DIR}/`)) rmSync(wsPath, { recursive: true, force: true }); // DATA_DIR 내부면 위 rm이 소멸시킨 뒤라 무해 재시도
		} catch { /* 무시 */ }
		console.log(`[${userKey.slice(0, 8)}] [Registry] 대화 삭제 — 목록·스케줄·백엔드 정리`);
		return true;
	}

	// ── 백엔드 시작 (세션별) ────────────────────────────────────────────────
	function startBackend(session: Session): void {
		// 4c-refit — 계정별 환경변수: authorize 계약으로 userKey 소유 계정의 env를 1회 수령한다 (계약 구조만 —
		// 코어는 auth·env-store 모듈을 모른다). 기존 env.json 직접 판독 경로 제거 — 계정의 모든 대화가 같은 env를
		// 공유 주입받는다. 미소유·고아·AUTH off → {} — 값은 spawn 프로세스 환경으로만 흐른다
		// (소유·검증은 서버 라우트(/api/env*)·auth.ts가 전담 — 구 own-only 라우트 계약 대신 계정 인증 계약으로 교체).
		const workspaceEnv = authorize ? authorize.accountEnv(session.userKey) : {};
		try {
			const agentCwd = workspacePath(session.userKey); // 위치 분리(TURK_WORKSPACES_ROOT) — 미설정 시 현행 경로
			mkdirSync(agentCwd, { recursive: true });
			const agentsMdPath = join(agentCwd, "AGENTS.md");
			ensureAgentsMd(agentsMdPath); // 순서 계약: 템플릿 생성 → 환경변수 섹션 갱신 (마커 존재 보장 후 교체)
			applyEnvSection(agentsMdPath, Object.keys(workspaceEnv)); // 계정 env 이름 목록 — 같은 계정 대화들 동일 목록(일관성) / 값은 절대 문서화 금지 / 불변 시 write 없음
		} catch (e) { console.error(`[Turk] AGENTS.md 생성 실패: ${e}`); }
		session.backend = createBackendFn({
			cwd: workspacePath(session.userKey),
			userKey: session.agentSessionId ?? undefined, // 저장된 agentSessionId 있으면 지정(같은 세션 복원), 없으면 undefined(새 세션). claude는 무시
			model: session.lastModel && typeof session.lastModel.id === "string" && session.lastModel.id
				? (typeof session.lastModel.provider === "string" && session.lastModel.provider ? `${session.lastModel.provider}/${session.lastModel.id}` : session.lastModel.id)
				: undefined, // 대화별 마지막 모델로 스폰 — 무관성 계약의 실측 반쪽. provider/id 형식 필수: bare id는 다중 provider에서 ambiguous 즉시 exit (pi 프로세스 종료됨 버그의 근원, 실측)
			workspaceEnv, // 4c-refit — 계정 env. spawn 환경 병합은 backend.ts 담당 (계약 키 최후 순위) — 로그·브로드캐스트 경로 없음
			onLog: (m: string) => console.log(`[${session.userKey.slice(0, 8)}] ${m}`),
		});
		session.backend.onEvent((ev: TurkEvent) => {
			if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [백엔드] 이벤트: type=${ev.type}`);
			if (ev.type === "pi_ready") {
				session.backendReady = true;
				(ev as any).vapidPublicKey = VAPID_PUBLIC_KEY;
				// 지연 큐 재생 ① 모델 — dormant 동안 수신한 set_model을 재생 (set_model → set_thinking_level → 후속 prompt
				// 순서 계약 — 드래프트 첫메시지 체인과 동일). 재생 직후 즉시 소멸(1회). 재생 set_model의 응답 자체에는
				// model이 없을 수 있어 실측 확정은 후속 라이브 get_state의 기록점이 기록한다 (순서만 보장).
				if (session.pendingModel) {
					const pm = session.pendingModel;
					session.pendingModel = null;
					session.backend?.send({ type: "set_model", provider: pm.provider, modelId: pm.modelId });
				}
				// 지연 큐 재생 ② 씽킹 — dormant 동안 수신한 set_thinking_level을 재할당(재생성) 직후 1회 재생.
				// FakeBackend·PiBackend 공통 근거: spawn 직후 동기 pi_ready emit → 이 블록은 startBackend() 호출 틱 안에서
				// 실행 → sendToBackend의 후속 prompt보다 선행 보장 (stdin 파이프 버퍼링 — backend.ts 재현 불필요).
				// 재생 후 소멸 — 이후 라이브 변경값이 최신이므로, 과거 큐값이 미래 리스폰마다 재적용되는 부작용 차단.
				if (session.pendingThinkingLevel) {
					session.backend?.send({ type: "set_thinking_level", level: session.pendingThinkingLevel });
					session.pendingThinkingLevel = undefined;
				}
			}
			// get_available_models 전역 캐시 — 성공 응답만 보관 (dormant 재요청 합성 응답원, 실패·위반 응답은 미보관)
			// 화이트리스트(TURK_PI_PROVIDERS) 지정 시 캐시·브로드캐스트 전에 응답 본체를 필터 — 클라 메뉴·localStorage
			// 캐시·합성 재전달이 전부 같은 좁힌 목록을 보게 단일 진원 유지. 빈 결과는 설정 오타 의심 경고만(동작은 그대로).
			if (ev.type === "response" && ev.command === "get_available_models" && (ev as any).success) {
				if (MODELS_PROVIDERS_WHITELIST.length && Array.isArray((ev as any).data?.models)) {
					const all = (ev as any).data.models as any[];
					const kept = all.filter((m) => MODELS_PROVIDERS_WHITELIST.includes(String(m?.provider)));
					if (!kept.length) console.log(`[Models] 화이트리스트(TURK_PI_PROVIDERS) 매칭 0 — 전체 ${all.length}개 그대로 (설정 확인 필요)`);
					if (kept.length) (ev as any).data = { ...(ev as any).data, models: kept };
				}
				modelsCache = ev;
			}
			// get_state 응답에서 실제 agentSessionId 확인 → 파일 영속 (ready 후 갱신)
			if (ev.type === "response" && (ev as any).command === "get_state") {
				const sid = (ev as any).data?.sessionId;
				if (typeof sid === "string" && sid && sid !== session.agentSessionId) {
					session.agentSessionId = sid;
					saveAgentSessionId(session.userKey, sid);
					console.log(`[${session.userKey.slice(0, 8)}] [config] agentSessionId 갱신: ${sid.slice(0, 8)}`);
				}
			}
			if (ev.type === "pi_exit" || ev.type === "pi_error") {
				session.backendReady = false;
				// 비정상 종료 처리 — WS 있으면 기존 자동 재시작(1.5s, 60s/5회 스로틀 — 백그라운드 크래시 벽돌 방지).
				// 무WS 크래시는 재시작해도 수신자 없어 복구 불가 — dormant 전환(backend null) 후 수요 시 재할당.
				if (session.ws.size > 0) scheduleBackendRestart(session);
				else {
					session.backend = null;
					console.log(`[${session.userKey.slice(0, 8)}] [Pool] 무WS 비정상 종료 — dormant 전환 (수요 시 재할당)`);
				}
			}
			// 컴팩트 트랙 — 컴팩트 턴의 agent_end(요약문)는 turk-JSON 위반이 아니다: 판정·자가수정·실패 마감에서 제외
			// (미제외 시 리트라이 2회 소진 → lastTurnFailed=true → 클라 get_state 실패 화면으로 화면 전면 교체 = 컴팩트가 화면을 비우던 버그)
			if (ev.type === "compaction_start" || ev.type === "compaction_end") session.inCompact = true;
			// agent_start: 스트리밍 시작
			if (ev.type === "agent_start") { session.isStreaming = true; session.thinkingBuf = ""; session.textBuf = ""; return; } // pi 것 스킵 — 서버가 이미 합성 전송
			// agent_end: 스트리밍 종료 + 큐 드레인 + 웹 푸시
			if (ev.type === "agent_end") {
				const compactTurn = session.inCompact === true;
				session.inCompact = false; // 컴팩트 시그니처 1회 소비 — pi 컴팩트 직후의 agent_end가 유일 방문
				session.isStreaming = false;
				// 턴 마감 = 대화 활동 — 레지스트리 정렬 기준 즉시 갱신 (라이브·원격(푸시) 공통).
				// 재시작 후에도 최근 정렬 유지 — touch가 메타 lastActiveAt 영속. 새 턴 없는 대화는 기존 위치 유지(정렬 키 불변).
				session.lastActiveAt = Date.now();
				touchConversationMeta(session);
				if (session.ws.size === 0 && !session.unread) { session.unread = true; console.log(`[${session.userKey.slice(0, 8)}] [Unread] 확인 안 함 표기 (ws 0 턴 마감)`); }
				if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] agent_end 도착 — drainQueue 호출`);
				// 응답 실패 명시 정의 — agent_end.error → 실패 플래그. lastResponse는 성공분만 캐시
				const aborted = Array.isArray((ev as any).messages) && (ev as any).messages.some((m: any) => m.role === "assistant" && m.stopReason === "aborted");
				session.lastTurnFailed = !!(ev as any).error;
				// 응답 파싱 — JSON Schema 1차 게이트 [스키마=법, 프롬프트=보조 교육]
				// 컴팩트 요약문은 스키마 심사 밖 — 파스 자체 생략 (캐시도 안 넣는다)
				const { parsed: respParsed, valid: respValid, errors: respErrors, text: respText } = compactTurn ? { parsed: null, valid: false, errors: undefined as unknown as string, text: "" } : parseTurkResponse(ev);
				if (DEBUG && !respValid && respErrors) console.log(`[${session.userKey.slice(0, 8)}] [Schema] 응답 위반 → 미기록: ${respErrors.slice(0, 200)}`);
				// 성공/취소 — 자가수정 카운터 리셋
				if (respValid || aborted) session.parseRetryCount = 0;
				// 위반(파싱 실패·스키마 미달·빈 텍스트) — 서버 자가수정 대상 (WS 유무 무관)
				const violated = !compactTurn && !session.lastTurnFailed && !aborted && !respValid;
				const retryPlanned = violated && session.parseRetryCount < SERVER_PARSE_RETRIES;
				if (retryPlanned) (ev as any).willRetry = true; // 클라 agent_end가 willRetry=true로 전파 — dim 유지, 주입 agent_start가 인계
				// 취소(aborted)·스키마 위반·silent는 lastResponse 캐시에서 제외 (AGENTS.md 약속: silent = no cache) —
				// 빈 message 등 위반 응답은 스키마 단계에서 자동 배제 → 이전 가시 화면 복원본 보존
				if (!compactTurn && !session.lastTurnFailed && !aborted && respValid && respParsed?.silent !== true) { session.lastResponse = ev; session.lastResponsePrompt = session.lastPrompt; saveLastResponse(session.userKey, ev, session.lastPrompt); } // 응답↔프롬프트 짝 — 파일 영속화(lastPrompt와 대칭)
				// 실패/자가수정: lastPrompt 유지 — get_state가 재시도 에코로 전달 (실패 화면과 짝); 정상 완결 턴에만 클리어
				if (!session.lastTurnFailed && !violated) session.lastPrompt = null;
				// schedules 배열을 서버가 응답에서 직접 스케줄러에 적용 — 클라이언트 릴레이 제거.
				// 백그라운드(WS 끊김) 트리거에서도 체이닝 재등록이 유실되지 않게 (silent 스킵의 schedules 재등록이 사라지던 버그 수정)
				// 결과 broadcast는 기존 클라이언트 로직이 소비 — list 자동 재주입(data.text)·오류 피드백(error)
				if (!compactTurn && !session.lastTurnFailed && !aborted && respValid && Array.isArray(respParsed?.schedules)) {
					for (const sch of respParsed.schedules) {
						if (!sch || typeof sch !== "object") continue;
						const r = session.scheduler.handle(sch);
						console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] 응답 적용: action=${sch.action} id=${sch.id ?? "-"} when=${sch.when ?? "-"} → ${r.success ? "ok" : `오류: ${r.error}`}`);
						broadcast(session, {
							type: "response",
							command: "schedule",
							success: r.success,
							...(r.success ? { data: r.data } : { error: r.error }),
						});
					}
				}
				session.scheduler.drainQueue();
				// 서버측 푸시 억제 (261010) — session.ws가 살아있으면 "이 대화를 포그라운드로 보는 탭"이 있다는 뜻
				// (App이 visibilitychange로 백그라운드 진입 시 WS를 능동 종료하는 계약 기반 — 주소창 해시와 무관).
				// 다른 대화를 보고 있다면 이 대화의 ws는 0 → 푸시 발송 (다른 대화 알림은 받아야 맞음).
				if (!compactTurn && session.pushSubscription && session.ws.size === 0) sendPushNotification(session, ev); // 컴팩트 내부 이벤트는 푸시 안함
				// ── 서버 자가수정 주입 (broadcast 후 — 이벤트 순서: agent_end(willRetry) → agent_start(재시도 턴)).
				//    클라 전담 시절엔 백그라운드(WS 끊김) 턴의 위반 응답이 무보정·무기록으로 유실됨 (261008 #chn —
				//    최종 응답 message 내 미이스케이프 따옴표 1건 → 출력버퍼 기록 누락). 소진 시 실패 확정 마감.
				if (violated) {
					const errInfo: string = respErrors ?? "파싱 실패";
					if (retryPlanned) {
						session.parseRetryCount++;
						const guide = respText
							? `지난 응답이 올바른 JSON 형식이 아닙니다. JSON.parse 에러: ${errInfo}\n다음 원문을 참고하여, 동일한 내용으로 올바른 JSON 버튼 그리드 하나만 다시 출력하세요. 원문 외 설명/코드펜스 금지.\n\n[잘못된 응답]\n${respText.slice(0, 800)}`
							: "지난 턴의 출력에 JSON 버튼 그리드가 없습니다. 방금 수행한 작업 결과를 turk JSON 버튼 그리드(message+buttons)로 정리해 출력하세요. 원문 외 설명/코드펜스 금지.";
						console.log(`[${session.userKey.slice(0, 8)}] [Schema] 응답 위반 → 서버 자가수정 주입 (${session.parseRetryCount}/${SERVER_PARSE_RETRIES}): ${errInfo.slice(0, 120)}`);
						sendToBackend(session, { type: "prompt", message: guide }, { route: "tool" }); // 클라 시절 재시도 계약 동일 — route tool이라 lastPrompt 불변(짝 보존). [현재 일시] prefix 제거(매턴 노이즈 — 261025)
					} else {
						// 재시도 소진 — 실패 확정: lastTurnFailed(입력 에코 유지·get_state 실패 화면) + 실패 전파
						session.lastTurnFailed = true;
						console.log(`[${session.userKey.slice(0, 8)}] [Schema] 응답 위반 재시도 소진(${SERVER_PARSE_RETRIES}) — 실패 확정: ${errInfo.slice(0, 120)}`);
						broadcast(session, { type: "agent_end", error: `[파싱실패] ${String(errInfo).slice(0, 200)}` });
					}
				}
			}
			// 줄단위 캐시 누적 — 재접속 소켓에 get_state 응답 직후 전달(던져주기)용
			if (ev.type === "message_update" && (ev as any).assistantMessageEvent?.type === "thinking_delta") {
				session.thinkingBuf += String((ev as any).assistantMessageEvent.delta ?? "");
			}
			if (ev.type === "message_update" && (ev as any).assistantMessageEvent?.type === "text_delta") {
				session.textBuf += String((ev as any).assistantMessageEvent.delta ?? "");
			}
			// get_state 응답 보강: isStreaming 등 주입
			const isGetState = ev.type === "response" && ev.command === "get_state";
			if (isGetState) healStreaming(session); // 유령 스트리밍 치유 — 라이브 경로도 동일 계약
			if (isGetState) {
				(ev as any).data = { ...(ev as any).data, lastPrompt: session.lastPrompt, isStreaming: session.isStreaming, route: session.currentRoute, lastResponse: session.lastResponse, lastResponsePrompt: session.lastResponsePrompt, lastTurnFailed: session.lastTurnFailed, backendState: backendStateOf(session) };
				// lastModel 기록 — 라이브 실측 model을 대화 속성으로 보존 (data.model 원형 JSON 안전 얕은 복사).
				// 값 변화시에만(직전 lastModel과 provider/name/id 비교) 기록+메타 갱신 — 매 get_state마다 디스크 찍기 방지.
				// 합성 set_model 성공 후 클라가 get_state를 반드시 보내므로 이 기록점 하나로 set_model 변경이 자동 승계된다.
				const lm = (ev as any).data?.model;
				if (lm && typeof lm === "object") {
					const prev = session.lastModel;
					if (!prev || prev.provider !== lm.provider || prev.name !== lm.name || prev.id !== lm.id) {
						session.lastModel = { ...lm };
						touchConversationMeta(session); // exists-게이트 — model 필드 추가 기록, 기존 필드 보존
					}
				}
			}
			// lastContextPct 기록 — 라이브 get_session_stats 실측을 대화 속성으로 보존 (lastModel 관례:
			// 값 변화시에만 기록+메타 갱신 — 매 stats마다 디스크 찍기 방지). dormant 합성 stats의 원료.
			const statsPct = ev.type === "response" && (ev as any).command === "get_session_stats" && (ev as any).success && typeof (ev as any).data?.contextUsage?.percent === "number" ? (ev as any).data.contextUsage.percent : undefined;
			if (statsPct !== undefined && statsPct !== session.lastContextPct) {
				session.lastContextPct = statsPct;
				touchConversationMeta(session); // exists-게이트 — ctxPct 필드 추가 기록, 기존 필드 보존
			}
			// lastThinkingLevel 기록 — 라이브 get_state 실측을 대화 속성으로 보존 (동일 관례: 변화시에만).
			// dormant 합성 get_state의 원료 — 재접속·재시작 표시 동기화.
			const liveLevel = isGetState && typeof (ev as any).data?.thinkingLevel === "string" ? (ev as any).data.thinkingLevel : undefined;
			if (liveLevel !== undefined && liveLevel !== session.lastThinkingLevel) {
				session.lastThinkingLevel = liveLevel;
				touchConversationMeta(session); // exists-게이트 — thinkingLevel 필드 추가 기록, 기존 필드 보존
			}
			broadcast(session, ev);
			// 리플레이 — get_state 응답(클라 복원 클리어) 직후에 던져야 클리어에 흡수되지 않음.
			// 신규 소켓(replayPending) 1회 한정 — 기존 탭은 라이브 델타를 이미 받고 있어 중복 배제.
			if (isGetState && session.isStreaming) {
				for (const ws of session.ws) {
					if (!(ws as any).replayPending) continue;
					(ws as any).replayPending = false;
					if (session.thinkingBuf) ws.send(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: session.thinkingBuf } }));
					if (session.textBuf) ws.send(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: session.textBuf } }));
				}
			}
		});
		session.backend.start();
	}

	// ── pi 비정상 종료 자동 재시작 — 백그라운드(클라 없음) 크래시로 세션 벽돌 방지. 60s 내 5회 초과 시 포기 ──
	const piRestartLog = new Map<string, number[]>();
	function scheduleBackendRestart(session: Session): void {
		const now = Date.now();
		const recent = (piRestartLog.get(session.userKey) ?? []).filter((t) => now - t < 60000);
		recent.push(now);
		piRestartLog.set(session.userKey, recent);
		if (recent.length > 5) { console.log(`[${session.userKey.slice(0, 8)}] [pi] 60s 내 재시작 5회 초과 — 자동 재시작 중단`); return; }
		setTimeout(() => {
			const s = sessions.get(session.userKey);
			if (!s || s.backend?.alive() || s.backendReady) return; // 이미 재시작됨
			console.log(`[${session.userKey.slice(0, 8)}] [pi] 비정상 종료 감지 → 자동 재시작`);
			startBackend(s);
		}, 1500);
	}

	// ── 세션 관리 ────────────────────────────────────────────────────────────
	function createSession(userKey: string): Session {
		const now = Date.now();
		const convMeta = loadConversationMeta(userKey); // 파일 없으면 null — 메모리 createdAt=now로 셸만 생성.
		// 신규 메타 파일 생성 제거(열림 무지연): 클릭만 한 대화는 dir·conversation.json를 만들지 않는다 —
		// 첫 발화(sendToBackend 성공 경로 touchConversationMeta create=true)가 유일한 디스크 생성 시점.
		// 기존 파일 있으면 복원(createdAt·title 보존) — 부팅 스윕·재접속 대화의 정합 유지.
		const session: Session = {
			userKey,
			agentSessionId: loadAgentSessionId(userKey), // 저장된 ID 있으면 복원, 없으면 null(새 세션)
			backend: null,
			backendReady: false,
			scheduler: new Scheduler({
				onTrigger: (entries) => {
					console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] onTrigger → 백엔드 주입: ids=${entries.map((e) => e.id).join(",")}`);
					// 선확인 — cap 초과면 발화 스킵 후 동일 id를 1m 뒤로 재등록 (once-체이닝 계약 재사용: 목록 보존·자가치유·관측 가능)
					if (!ensureBackend(session)) {
						for (const e of entries) {
							const r = session.scheduler.handle({ action: "add", id: e.id, when: "1m", prompt: e.prompt, condition: e.condition });
							console.log(`[${session.userKey.slice(0, 8)}] [Pool] 백엔드 초과 → 스케줄 1m 재등록: id=${e.id} → ${r.success ? "ok" : `오류: ${r.error}`}`);
						}
						return;
					}
					const msg = formatTriggerMessage(entries, new Date());
					sendToBackend(session, { type: "prompt", message: msg }, { route: "scheduler" });
					broadcast(session, { type: "scheduler_trigger", ids: entries.map((e) => e.id), whens: entries.map((e) => e.when) });
				},
				isBusy: () => session.isStreaming,
				storageDir: `${DATA_DIR}/${userKey}`,
			}),
			pushSubscription: loadPushSubscription(userKey), // 영속화된 구독 복원 (재시작 후 재구독 불필요)
			ws: new Set(),
			lastResponse: loadLastResponse(userKey)?.ev ?? null, // 영속 버퍼에서 복원 — 재시작·세션 재생성에도 마지막 가시 응답 유지
			lastTurnFailed: false,
			inCompact: false,
			lastPrompt: loadLastPrompt(userKey), // 영속 버퍼에서 복원 — 이전 입력 짝 캡션
			lastResponsePrompt: loadLastResponse(userKey)?.prompt ?? null,
			isStreaming: false,
			lastActivity: now,
			title: convMeta?.title ?? null, // conversation.json 복원 — 기존 대화면 보존
			createdAt: convMeta?.createdAt ?? now,
			lastActiveAt: convMeta?.lastActiveAt ?? now,
			lastViewedAt: convMeta?.lastViewedAt ?? 0, // 복원 기준 — 파일 부재(신규)는 0(열람 미경험)
			lastViewedWritten: convMeta?.lastViewedAt ?? 0,
			lastModel: convMeta?.model && typeof convMeta.model === "object" && !Array.isArray(convMeta.model) ? convMeta.model : null, // 메타 model 복원 — 원형 그대로 (부재·기형 null). 부팅 스윕·재시작 모두 createSession 경유 적재점
			lastContextPct: typeof convMeta?.ctxPct === "number" ? convMeta.ctxPct : null, // 메타 ctxPct 복원 — 부재·기형 null
			lastThinkingLevel: typeof convMeta?.thinkingLevel === "string" ? convMeta.thinkingLevel : null, // 메타 thinkingLevel 복원 — 부재·기형 null
			unread: convMeta?.unread === true, // 메타 unread 복원
			pendingModel: null,
			currentRoute: "user",
			parseRetryCount: 0,
			thinkingBuf: "",
			textBuf: "",
		};
		sessions.set(userKey, session);
		return session; // 순수 셸 — 백엔드는 수요 시점(프롬프트·컴팩트 발화 + 스케줄 트리거)에 ensureBackend가 기동 (열림 무지연 — 접속 미기동)
	}

	function removeSession(userKey: string): void {
		const session = sessions.get(userKey);
		if (!session) return;
		// WS들에게 세션 종료 알림
		broadcast(session, { type: "session_terminated", reason: "유휴 세션 정리" });
		for (const ws of session.ws) ws.close();
		session.scheduler.destroy();
		session.backend?.stop();
		sessions.delete(userKey);
	}

	// 유저 키로 세션 조회/생성 — 셸은 무상한(1b: LRU 소멸 경로 제거 — 스케줄 유실 결함 해소).
	// 희소자원은 백엔드뿐 — 배분·회수는 ensureBackend·회수 스윕이 담당.
	function getOrCreateSession(userKey: string): Session | { error: string } {
		const existing = sessions.get(userKey);
		if (existing) {
			existing.lastActivity = Date.now();
			return existing;
		}
		return createSession(userKey);
	}

	function removeAllSessions(): void {
		for (const userKey of sessions.keys()) removeSession(userKey);
	}

	// ── WS 연결·메시지 처리 (prod/dev 공용) ──────────────────────────────────
	const customCommands = ["restart_pi", "reload", "schedule", "push_subscribe", "attach", "ping"];

	function denyConnection(ws: WebSocket, message: string): void {
		ws.send(JSON.stringify({ type: "session_error", error: message }));
		ws.close();
	}

	// 연결 이후 공통 진입 (Phase 2) — 형식·인증 게이트 통과 후 세션 확정·소유권·기존 흐름.
	// authorize 미주입 시 username=null — 기존 무인증 동작 불변.
	function enterSession(ws: WebSocket, userKey: string, username: string | null): void {
		const result = getOrCreateSession(userKey);
		if ("error" in result) {
			denyConnection(ws, result.error);
			return;
		}
		const session = result;
		// ④ 소유권 게이트 (authorize 주입 시) — own=진입 / orphan=자동 claim 후 진입 / foreign=거부 (남의 대화)
		if (authorize && username) {
			const rel = authorize.checkConversation(username, userKey);
			if (rel === "foreign") { denyConnection(ws, "권한 없음 — 다른 계정의 대화입니다"); return; }
			if (rel === "orphan") authorize.claimConversation(username, userKey); // 고아 인수 — 레거시 대화 첫 접속 자동 claim (마이그레이션 계약)
		}
		// 접속 = 확인 — unread(true)일 때만 해소·메타 재기록(payload에 false 미포함 → 필드 자연 제거).
		// 열람만 한 접속은 lastActiveAt 미갱신 — "대화 없이 열기만 한 대화는 그 자리 유지"(261012).
		// 클릭만 한(무발화) 대화는 메타 존재 불확정 → 디스크 기록 0 유지.
		if (session.unread) { session.unread = false; touchConversationMeta(session); }
		// 마지막 열람 갱신 — 복원 기준. WS 접속=전경 열람 신호(onVisible 계약), 백그라운드 턴 마감·푸시는 이 필드 미건의.
		// 쓰기 30s 스로틀 — 컴타 전환 소켓의 초당 연결에도 디스크 스톰 없게 (값 동일이면 스킵).
		session.lastViewedAt = Date.now();
		if (session.lastViewedAt - session.lastViewedWritten > 30_000) {
			session.lastViewedWritten = session.lastViewedAt;
			touchConversationMeta(session);
		}
		// 백엔드 기동 제거(열림 무지연·지연 할당) — 접속은 뷰어 신호일 뿐, 프로세스는 작업 명령만 부른다.
		// 기동 수요 = sendToBackend ensure 목록(prompt·compact) + 스케줄러 트리거 발화만. 접속 직후 클라의
		// pi_ready→get_state는 dormant 합성 응답으로 즉시 마감 — 스폰·지연·교착 없음(뷰어만으로 풀을 잠그지 않게).
		session.ws.add(ws);
		session.lastActivity = Date.now();
		(ws as any).isAlive = true;
		ws.on("pong", () => { (ws as any).isAlive = true; });
		if (session.isStreaming && (session.thinkingBuf || session.textBuf)) {
			(ws as any).replayPending = true; // 스트리밍 중 접속 — get_state 응답 직후 줄단위 캐시 전달 예약
		}
		console.log(`[Turk] 연결: ${userKey.slice(0, 8)} (세션 ${sessions.size} · 백엔드 ${activeBackendCount()}/${MAX_BACKENDS})`);

		// 셸 서빙 준비 신호 — 무조건 pi_ready 합성 (backend 필드 없음, vapidPublicKey만 포함 — 푸시 등록은 셸 단계에서도 가능).
		// defaultModel: 시작시 지정 계약(TURK_PI_MODEL — 미지정 시 pi 자체 기본) — 클라가 캐시해 드래프트(#new)
		// 시딩의 1순위로 쓴다. 새 대화의 실제 시작 모델 = 이 값 (드래프트에서 직접 고르면 set_model이 덮음).
		// 클라는 pi_ready를 멱등 소비 — 이후 진짜 백엔드가 기동되면 개별 pi_ready가 도착해 동일 경로(pi_ready→get_state)를 탄다.
		// cap·스폰 조건과 완전 무관 — 접속 자체가 서빙 가능 상태(빈 그리드든 복원이든)라 뜻.
		ws.send(JSON.stringify({ type: "pi_ready", vapidPublicKey: VAPID_PUBLIC_KEY, ...(process.env.TURK_PI_MODEL ? { defaultModel: process.env.TURK_PI_MODEL } : {}) }));

		ws.on("message", (raw) => {
			try {
				const msg = JSON.parse(raw.toString());
				if (DEBUG) console.log(`[${userKey.slice(0, 8)}] [WS] 수신: type=${msg.type}`);
				if (customCommands.includes(msg.type)) {
					if (msg.type === "restart_pi") {
						if (session.backend) { session.backend.stop(); session.backend = null; }
						session.backendReady = false;
						session.agentSessionId = null;
						session.lastResponse = null; // 새 세션 — 응답 캐시 클리어
						session.lastTurnFailed = false; // 새 세션 — 실패 플래그 클리어
						session.lastPrompt = null; // 새 세션 — 처리중 표시 클리어
						saveLastPrompt(session.userKey, ""); // 새 세션 — 영속 버퍼도 클리어
						session.lastResponsePrompt = null; // 새 세션 — 짝 정보 클리어
						clearLastResponse(session.userKey); // 새 세션 — 영속 응답 버퍼도 클리어
						console.log(`[${userKey.slice(0, 8)}] [restart_pi] 새 세션 시작 (agentSessionId 클리어)`);
						setTimeout(() => startBackend(session), 500);
					} else if (msg.type === "reload") {
						// /reload — 컴팩트형 수요지점: 지금 즉시 fresh 백엔드. 살아있으면 stop 후, dormant면 그대로
						// ensureBackend가 스폰 — 어느 쪽이든 --session-id 재부착 + AGENTS.md·스킬·설정 재독 완료 상태로 마감.
						// 세션 상태(agentSessionId·lastResponse·버퍼) 전부 보존 — restart_pi(세션 파괴)와 대조.
						// cap-full(LRU victim도 없음)이면 success:false — 컴팩트와 동일한 침묵 실패 계약.
						if (session.backend) { session.backend.stop(); session.backend = null; }
						session.backendReady = false;
						const reloaded = ensureBackend(session);
						console.log(`[${userKey.slice(0, 8)}] [reload] 백엔드 재기동 (세션 유지·${reloaded ? "즉시 재스폰" : "cap-full 거부"})`);
						broadcast(session, { type: "response", command: "reload", success: reloaded, data: {} });
					} else if (msg.type === "schedule") {
						console.log(`[${userKey.slice(0, 8)}] [Scheduler] 명령 수신: action=${msg.action} id=${msg.id ?? "-"} when=${msg.when ?? "-"}`);
						const r = session.scheduler.handle(msg);
						broadcast(session, {
							type: "response",
							command: "schedule",
							success: r.success,
							...(r.success ? { data: r.data } : { error: r.error }),
						});
					} else if (msg.type === "push_subscribe") {
						session.pushSubscription = msg.subscription;
						savePushSubscription(userKey, msg.subscription); // 영속화
						if (DEBUG) console.log(`[${userKey.slice(0, 8)}] [Push] 구독 수신+저장: ${msg.subscription?.endpoint?.slice(0, 60)}`);
					} else if (msg.type === "ping") {
						ws.send(JSON.stringify({ type: "pong" })); // 앱레벨 하트비트 — 클라 워치독 좀비 판정용 (pi로 전달 안 함)
					} else if (msg.type === "attach") {
						// 파일 업로드 → OS 임시디렉토리 저장 (휘발 — OS가 정리) — 에이전트가 자기 read 도구로 읽음
						const MAX_ATTACH = 50 * 1024 * 1024;
						const data = typeof msg.data === "string" ? msg.data : "";
						const name = String(msg.name ?? "file").split(/[\\/]/).pop()!.replace(/[\x00-\x1f]/g, "").trim().slice(0, 100) || "file";
						if (!data || data.length > MAX_ATTACH * 1.4) {
							ws.send(JSON.stringify({ type: "response", command: "attach", success: false, error: "파일 크기 초과 — 최대 50MB" }));
						} else {
							try {
								const dir = join(tmpdir(), "ai-turk-attach", userKey);
								mkdirSync(dir, { recursive: true });
								const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
								const abs = join(dir, `${ts}-${name}`);
								writeFileSync(abs, Buffer.from(data, "base64"));
								console.log(`[${userKey.slice(0, 8)}] [Attach] 저장: ${abs}`);
								ws.send(JSON.stringify({ type: "response", command: "attach", success: true, data: { path: abs, name } }));
							} catch (err) {
								ws.send(JSON.stringify({ type: "response", command: "attach", success: false, error: err instanceof Error ? err.message : String(err) }));
							}
						}
					}
				} else {
					sendToBackend(session, msg);
				}
			} catch (e) {
				console.error("[Turk] 메시지 파싱 오류:", e);
			}
		});

		ws.on("close", (code, reason) => {
			session.ws.delete(ws);
			session.lastActivity = Date.now();
			console.log(`[Turk] 종료: ${userKey.slice(0, 8)} code=${code} reason=${reason.toString() || "-"} (남은 WS ${session.ws.size})`);
		});
	}

	// ── WS 연결 게이트 (Phase 2) — ①형식검증(authorize 무관 항상) ②인증(authorize 주입 시) → enterSession ──
	function handleConnection(ws: WebSocket, req: { url?: string; headers?: Record<string, string | string[] | undefined> }): void {
		const url = new URL(req.url || "/", "http://t"); // url 파서 기반값 — noServer 모드도 full URL이 옴
		const userKey = url.searchParams.get("u");
		if (!userKey) { denyConnection(ws, "userKey 누락 — 클라이언트 설정 확인 필요"); return; }
		// ① userKey 형식 검증 — authorize 유무 무관 항상 (userKey가 DATA_DIR 경로 조합에 직접 쓰이므로 ../ 경로조작 차단)
		if (!verifyUserKeyFormat(userKey)) { denyConnection(ws, "userKey 형식이 올바르지 않습니다"); return; }
		// ② 인증 게이트 — authorize 주입 시에만 (TURK_AUTH=1). 쿠키 JWT 검증 → username 또는 접속 거부.
		if (authorize) {
			authorize.authorizeRequest(req).then((username) => {
				if (!username) { denyConnection(ws, "로그인 필요"); return; }
				enterSession(ws, userKey, username);
			}).catch(() => denyConnection(ws, "인증 처리 오류")); // 주입 객체 예외에도 소켓 정리 (핸들러 미등록 상태 유실 방지)
			return;
		}
		enterSession(ws, userKey, null); // 무인증(dev·기본) — 동기 진입, 기존 동작 그대로
	}

	// WS keepalive — 모바일 NAT의 유휴 컷(1005 churn) 방지 + pong 2회 무응답 좀비 소켓 서버측 정리(isAlive)
	function keepAlive(wss: WebSocketServer): void {
		const iv = setInterval(() => {
			for (const c of wss.clients) {
				if (c.readyState !== WebSocket.OPEN) continue;
				if ((c as any).isAlive === false) { c.terminate(); continue; }
				(c as any).isAlive = false;
				c.ping();
			}
		}, 25000);
		iv.unref?.(); // 서버 생명 유지 책임은 listen 쪽 — keepalive가 프로세스를 붙잡지 않게 (dev·prod 동일)
	}

	return { sessions, maxSessions: MAX_BACKENDS, getOrCreateSession, removeSession, removeAllSessions, handleConnection, keepAlive, ensureBackend, reclaimSweep, listConversations, readConversationHistory, renameConversation, deleteConversation };
}
