/**
 * AI Turk 세션 코어 — server.ts(prod)와 vite.config.ts(dev turkPlugin)의 공용 부분.
 *
 * 지금까지 두 진입점에 쌍둥이 복제되던 세션/WS/영속화/푸시 로직의 단일 진원.
 * 발산 이력: dev측에 서버 자가수정(261008)·스트리밍 리플레이·풀 push payload가 누락돼 있었음 —
 * 이 파일은 prod(server.ts) 동작을 정본으로 수렴한다. 이후 풀(1b)·인증(Phase 2)도 여기에만 얹는다.
 *
 * 의존: ws, web-push, env-paths, node:fs/path/os — 신규 의존성 없음.
 */

import { WebSocket, WebSocketServer } from "ws";
import { createBackend, type Backend, type TurkEvent } from "./backend.ts";
import { Scheduler, formatTriggerMessage } from "./scheduler.ts";
import { validateTurkResponse } from "./src/lib/response-schema.ts";
import { ensureAgentsMd } from "./src/lib/agents-md-server.ts";
import envPaths from "env-paths";
import webpush from "web-push";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";

const DATA_DIR = envPaths("ai-turk").data;

// ── 세션 구조 — 유저(브라우저)별 독립 백엔드 + 스케줄러 ───────────────────
export interface Session {
	userKey: string;
	thinkingBuf: string; // 턴 내 씽킹 누적 — 재접속 소켓 리플레이용 (줄단위, agent_start 클리어)
	textBuf: string; // 턴 내 응답 텍스트 누적 — 리플레이용
	agentSessionId: string | null; // 백엔드 세션 ID (파일 영속, ready 시 get_state로 갱신). null = 새 세션
	backend: Backend | null;
	backendReady: boolean;
	scheduler: Scheduler;
	pushSubscription: any; // 마지막 구독 (1인 — 세션당 1개)
	ws: Set<WebSocket>; // 같은 유저 다중 탭 — 동일 세션 broadcast. 사생활 탭 = 다른 userKey = 다른 세션
	lastResponse: any | null; // 마지막 agent_end 이벤트 캐시 — WS 미연결(백그라운드) 유실분 복원용 (마지막 1건)
	lastTurnFailed: boolean; // 응답 실패 명시 정의 — 마지막 agent_end.error 여부. get_state로 UI 전달
	lastPrompt: string | null; // 처리중 사용자 프롬프트 — 재연결 시 "뭘 기다리는지" 입력창 표시용 (isStreaming과 짝)
	lastResponsePrompt: string | null; // lastResponse가 대답하는 프롬프트 — 응답 상단 짝표시용
	isStreaming: boolean; // 백엔드 응답 생성 중 여부
	lastActivity: number; // 마지막 활동 타임스탬프 (LRU 정리용)
	currentRoute: "user" | "scheduler" | "tool"; // 현재 프롬프트 경로 — agent_start에 주입
	parseRetryCount: number; // 서버 자가수정(위반 응답 재시도) 카운터 — 성공·취소·신규 유저입력에서 리셋
}

export interface SessionCoreConfig {
	maxSessions?: number; // 동시 세션 상한 (기본: TURK_MAX_SESSIONS || 5)
	parseRetries?: number; // 응답 자가수정 재시도 한도 (기본: TURK_PARSE_RETRIES || 2)
	debug?: boolean; // 진단 로그 (기본: TURK_DEBUG)
}

export interface SessionCore {
	sessions: Map<string, Session>;
	maxSessions: number;
	getOrCreateSession(userKey: string): Session | { error: string };
	removeSession(userKey: string): void;
	removeAllSessions(): void;
	handleConnection(ws: WebSocket, req: { url?: string }): void;
	keepAlive(wss: WebSocketServer): void;
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

// ── 세션 코어 팩터리 ─────────────────────────────────────────────────────
export function createSessionCore(cfg?: SessionCoreConfig): SessionCore {
	const DEBUG = cfg?.debug ?? !!process.env.TURK_DEBUG;
	const MAX_SESSIONS = cfg?.maxSessions ?? parseInt(process.env.TURK_MAX_SESSIONS || "5");
	const SERVER_PARSE_RETRIES = cfg?.parseRetries ?? parseInt(process.env.TURK_PARSE_RETRIES || "2"); // 서버 자가수정 재시도 한도 — 응답 위반(파싱·스키마) 시 원문+에러 되돌려 교정

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

	// 같은 세션(유저) WS 전체에 broadcast — 다중 탭 동기화
	function broadcast(session: Session, data: Record<string, unknown>): void {
		if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [WS] 송신: type=${data.type}${data.command ? " command=" + data.command : ""}`);
		const msg = JSON.stringify(data);
		for (const ws of session.ws) {
			if (ws.readyState === WebSocket.OPEN) ws.send(msg);
		}
	}

	// ── 웹 푸시 ────────────────────────────────────────────────────────────
	// 스키마 유효 + Visible 응답만 푸시 — Silent·위반(빈 message 등)은 폐기
	// 전체 text + sessionId + userKey 전송 — sw.js가 userKey로 tag·억제·클릭 포커스를 키별 구분
	function sendPushNotification(session: Session, ev: TurkEvent): void {
		const { text, parsed, valid } = parseTurkResponse(ev);
		if (!text) return;
		if (!valid || parsed?.silent === true) return;
		const payload = JSON.stringify({ body: text, sessionId: session.agentSessionId || "", url: "/#" + session.userKey, userKey: session.userKey });
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

	// backend.send 가로채서 route 추적
	function sendToBackend(session: Session, cmd: Record<string, unknown>, opts?: { route?: "user" | "scheduler" | "tool" }): void {
		const route = (opts?.route ?? cmd.route ?? "user") as "user" | "scheduler" | "tool";
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
		if (cmd.type === "abort") session.backend?.send({ type: "abort_retry" });
		session.backend?.send(cmd);
	}

	// ── 백엔드 시작 (세션별) ────────────────────────────────────────────────
	function startBackend(session: Session): void {
		try {
			const agentCwd = join(DATA_DIR, session.userKey, "workspace");
			mkdirSync(agentCwd, { recursive: true });
			const agentsMdPath = join(agentCwd, "AGENTS.md");
			ensureAgentsMd(agentsMdPath);
		} catch (e) { console.error(`[Turk] AGENTS.md 생성 실패: ${e}`); }
		session.backend = createBackend({
			cwd: join(DATA_DIR, session.userKey, "workspace"),
			userKey: session.agentSessionId ?? undefined, // 저장된 agentSessionId 있으면 지정(같은 세션 복원), 없으면 undefined(새 세션). claude는 무시
			onLog: (m: string) => console.log(`[${session.userKey.slice(0, 8)}] ${m}`),
		});
		session.backend.onEvent((ev: TurkEvent) => {
			if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [백엔드] 이벤트: type=${ev.type}`);
			if (ev.type === "pi_ready") {
				session.backendReady = true;
				(ev as any).vapidPublicKey = VAPID_PUBLIC_KEY;
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
				scheduleBackendRestart(session); // 비정상 종료 자동 재시작 — 백그라운드 크래시로 세션 벽돌(pi_starting 고정) 방지
			}
			// agent_start: 스트리밍 시작
			if (ev.type === "agent_start") { session.isStreaming = true; session.thinkingBuf = ""; session.textBuf = ""; return; } // pi 것 스킵 — 서버가 이미 합성 전송
			// agent_end: 스트리밍 종료 + 큐 드레인 + 웹 푸시
			if (ev.type === "agent_end") {
				session.isStreaming = false;
				if (DEBUG) console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] agent_end 도착 — drainQueue 호출`);
				// 응답 실패 명시 정의 — agent_end.error → 실패 플래그. lastResponse는 성공분만 캐시
				const aborted = Array.isArray((ev as any).messages) && (ev as any).messages.some((m: any) => m.role === "assistant" && m.stopReason === "aborted");
				session.lastTurnFailed = !!(ev as any).error;
				// 응답 파싱 — JSON Schema 1차 게이트 [스키마=법, 프롬프트=보조 교육]
				const { parsed: respParsed, valid: respValid, errors: respErrors, text: respText } = parseTurkResponse(ev);
				if (DEBUG && !respValid && respErrors) console.log(`[${session.userKey.slice(0, 8)}] [Schema] 응답 위반 → 미기록: ${respErrors.slice(0, 200)}`);
				// 성공/취소 — 자가수정 카운터 리셋
				if (respValid || aborted) session.parseRetryCount = 0;
				// 위반(파싱 실패·스키마 미달·빈 텍스트) — 서버 자가수정 대상 (WS 유무 무관)
				const violated = !session.lastTurnFailed && !aborted && !respValid;
				const retryPlanned = violated && session.parseRetryCount < SERVER_PARSE_RETRIES;
				if (retryPlanned) (ev as any).willRetry = true; // 클라 agent_end가 willRetry=true로 전파 — dim 유지, 주입 agent_start가 인계
				// 취소(aborted)·스키마 위반·silent는 lastResponse 캐시에서 제외 (AGENTS.md 약속: silent = no cache) —
				// 빈 message 등 위반 응답은 스키마 단계에서 자동 배제 → 이전 가시 화면 복원본 보존
				if (!session.lastTurnFailed && !aborted && respValid && respParsed?.silent !== true) { session.lastResponse = ev; session.lastResponsePrompt = session.lastPrompt; saveLastResponse(session.userKey, ev, session.lastPrompt); } // 응답↔프롬프트 짝 — 파일 영속화(lastPrompt와 대칭)
				// 실패/자가수정: lastPrompt 유지 — get_state가 재시도 에코로 전달 (실패 화면과 짝); 정상 완결 턴에만 클리어
				if (!session.lastTurnFailed && !violated) session.lastPrompt = null;
				// schedules 배열을 서버가 응답에서 직접 스케줄러에 적용 — 클라이언트 릴레이 제거.
				// 백그라운드(WS 끊김) 트리거에서도 체이닝 재등록이 유실되지 않게 (silent 스킵의 schedules 재등록이 사라지던 버그 수정)
				// 결과 broadcast는 기존 클라이언트 로직이 소비 — list 자동 재주입(data.text)·오류 피드백(error)
				if (!session.lastTurnFailed && !aborted && respValid && Array.isArray(respParsed?.schedules)) {
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
				if (session.pushSubscription) sendPushNotification(session, ev);
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
						const dt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric", weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
						console.log(`[${session.userKey.slice(0, 8)}] [Schema] 응답 위반 → 서버 자가수정 주입 (${session.parseRetryCount}/${SERVER_PARSE_RETRIES}): ${errInfo.slice(0, 120)}`);
						sendToBackend(session, { type: "prompt", message: `[현재 일시: ${dt} KST]\n\n${guide}` }, { route: "tool" }); // 클라 시절 재시도 계약 동일 — route tool이라 lastPrompt 불변(짝 보존)
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
			if (isGetState) {
				(ev as any).data = { ...(ev as any).data, lastPrompt: session.lastPrompt, isStreaming: session.isStreaming, route: session.currentRoute, lastResponse: session.lastResponse, lastResponsePrompt: session.lastResponsePrompt, lastTurnFailed: session.lastTurnFailed };
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
		const session: Session = {
			userKey,
			agentSessionId: loadAgentSessionId(userKey), // 저장된 ID 있으면 복원, 없으면 null(새 세션)
			backend: null,
			backendReady: false,
			scheduler: new Scheduler({
				onTrigger: (entries) => {
					console.log(`[${session.userKey.slice(0, 8)}] [Scheduler] onTrigger → 백엔드 주입: ids=${entries.map((e) => e.id).join(",")}`);
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
			lastPrompt: loadLastPrompt(userKey), // 영속 버퍼에서 복원 — 이전 입력 짝 캡션
			lastResponsePrompt: loadLastResponse(userKey)?.prompt ?? null,
			isStreaming: false,
			lastActivity: Date.now(),
			currentRoute: "user",
			parseRetryCount: 0,
			thinkingBuf: "",
			textBuf: "",
		};
		sessions.set(userKey, session);
		startBackend(session);
		return session;
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

	// 유저 키로 세션 조회/생성. 최대 도달 시 WS 없는 유휴 세션 LRU 강제 종료 → 수용.
	function getOrCreateSession(userKey: string): Session | { error: string } {
		const existing = sessions.get(userKey);
		if (existing) {
			existing.lastActivity = Date.now();
			return existing;
		}
		if (sessions.size >= MAX_SESSIONS) {
			// WS 없는 유휴 세션 중 가장 오래된 것(LRU) 강제 종료
			let oldest: Session | null = null;
			for (const s of sessions.values()) {
				if (s.ws.size === 0 && (!oldest || s.lastActivity < oldest.lastActivity)) oldest = s;
			}
			if (oldest) {
				console.log(`[Turk] LRU 정리: ${oldest.userKey.slice(0, 8)}`);
				removeSession(oldest.userKey);
			} else {
				return { error: `최대 세션 수(${MAX_SESSIONS}) 초과 — 모든 세션 활성 중` };
			}
		}
		return createSession(userKey);
	}

	function removeAllSessions(): void {
		for (const userKey of sessions.keys()) removeSession(userKey);
	}

	// ── WS 연결·메시지 처리 (prod/dev 공용) ──────────────────────────────────
	const customCommands = ["restart_pi", "schedule", "push_subscribe", "attach", "ping"];

	function handleConnection(ws: WebSocket, req: { url?: string }): void {
		const url = new URL(req.url || "/", "http://t"); // url 파서 기반값 — noServer 모드도 full URL이 옴
		const userKey = url.searchParams.get("u");
		if (!userKey) {
			ws.send(JSON.stringify({ type: "session_error", error: "userKey 누락 — 클라이언트 설정 확인 필요" }));
			ws.close();
			return;
		}
		const result = getOrCreateSession(userKey);
		if ("error" in result) {
			ws.send(JSON.stringify({ type: "session_error", error: result.error }));
			ws.close();
			return;
		}
		const session = result;
		session.ws.add(ws);
		session.lastActivity = Date.now();
		(ws as any).isAlive = true;
		ws.on("pong", () => { (ws as any).isAlive = true; });
		if (session.isStreaming && (session.thinkingBuf || session.textBuf)) {
			(ws as any).replayPending = true; // 스트리밍 중 접속 — get_state 응답 직후 줄단위 캐시 전달 예약
		}
		console.log(`[Turk] 연결: ${userKey.slice(0, 8)} (세션 ${sessions.size}/${MAX_SESSIONS})`);

		// 백엔드 상태 즉시 통지 (새 탭/재연결 동기화)
		ws.send(JSON.stringify({
			type: session.backendReady ? "pi_ready" : "pi_starting",
			...(session.backendReady ? { backend: session.backend?.kind(), vapidPublicKey: VAPID_PUBLIC_KEY } : {}),
		}));

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

	return { sessions, maxSessions: MAX_SESSIONS, getOrCreateSession, removeSession, removeAllSessions, handleConnection, keepAlive };
}
