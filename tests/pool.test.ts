/**
 * tests/pool.test.ts — 1b 프로세스 풀 시맨틱 단위테스트 (L2 코어 통합)
 *
 * 구성: A 회수판정(순수함수 직접) / B cap·LRU / C dormant 즉시발화 / D 크래시 / E 파이프순서 / workspacePath
 * 관례: 평문 tsx 스크립트 · ✅/❌ 출력 · 실패 시 exit 1 (response-schema.test.ts 동일)
 *
 * 격리: 세션 코어 모듈 로드 전 XDG_DATA_HOME 주입(동적 import 필수 — DATA_DIR이 모듈 로드 시 확정)
 * → FakeBackend·WS 스텁으로 실제 경로(handleConnection 등록 핸들러 직접 호출) 검증.
 * 제약: 실시간 대기 >5초 금지 — 회수 인터벌·스케줄러 타이머는 대기하지 않고 reclaimSweep() 수동 호출로 우회.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import envPaths from "env-paths";
import type { Backend, BackendOptions, TurkEvent } from "../backend.ts";

// ── 세션 코어 모듈 로드 전 데이터 경로 격리 (env-paths가 XDG_DATA_HOME을 따름) ──
const TMP_DATA = mkdtempSync(join(tmpdir(), "ai-turk-pool-"));
process.env.XDG_DATA_HOME = TMP_DATA;

// ── 콘솔 티 — core 로그를 화면에도 흘리고 판정용 버퍼에 적재 ──
const logBuf: string[] = [];
const origLog = console.log;
console.log = (...args: unknown[]) => {
	logBuf.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
	origLog(...args);
};

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: string): void {
	if (cond) { pass++; console.log("✅", name); }
	else { fail++; console.log("❌", name, extra ?? ""); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 세션 코어 로드 — env 주입 후 동적 import (module DATA_DIR이 로드 시 확정이므로) ──
const SC = await import("../session-core.ts");

// 합성 agent_start(ws) → backend.send 순서 관측용 — 같은 틱 실행이라 순서 결정적
const orderLog: string[] = [];

// ── FakeBackend — Backend 인터페이스 구현 + 테스트 헬퍼 ──────────────────
class FakeBackend implements Backend {
	startCount = 0;
	stopCount = 0;
	records: Record<string, unknown>[] = [];
	aliveState = false;
	stopping = false;
	cb: ((ev: TurkEvent) => void) | null = null;
	opts: BackendOptions;
	constructor(opts: BackendOptions) { this.opts = opts; }
	start(): void {
		this.startCount++;
		this.aliveState = true;
		this.emitReady(); // PiBackend 근거 재현 — spawn 직후 동기 pi_ready emit
	}
	send(cmd: Record<string, unknown>): void {
		this.records.push(cmd);
		orderLog.push(`backend:${String(cmd.type)}`);
	}
	onEvent(cb: (ev: TurkEvent) => void): void { this.cb = cb; }
	stop(): void { this.stopping = true; this.stopCount++; this.aliveState = false; }
	alive(): boolean { return this.aliveState; }
	kind(): "pi" | "claude" { return "pi"; }
	emit(ev: TurkEvent): void { this.cb?.(ev); }
	emitReady(): void { this.emit({ type: "pi_ready", backend: this.kind() }); }
	emitExit(code = 1): void {
		if (this.stopping) return; // 실 백엔드 동일 — 의도적 stop은 exit 브로드캐스트 억제
		this.aliveState = false; // 실 크래시 동일 — 프로세스 소멸
		this.emit({ type: "pi_exit", code });
	}
}

// ── WS 스텁 — handleConnection이 등록한 핸들러를 직접 호출해 실제 경로 검증 ──
function makeWs(): any {
	const handlers: Record<string, ((...args: any[]) => void)[]> = {};
	const sent: Record<string, any>[] = [];
	const ws: any = {
		OPEN: 1,
		readyState: 1, // WebSocket.OPEN
		sent,
		handlers,
		send(raw: string) {
			const ev = JSON.parse(raw);
			sent.push(ev);
			orderLog.push(`ws:${ev.type}`);
		},
		on(ev: string, cb: (...args: any[]) => void) { (handlers[ev] ??= []).push(cb); },
		close() {
			ws.readyState = 3; // CLOSED
			for (const cb of handlers.close ?? []) cb(1000, Buffer.from("client"));
		},
	};
	return ws;
}
function wsMessage(ws: any, msg: Record<string, unknown>): void {
	for (const cb of ws.handlers.message ?? []) cb(JSON.stringify(msg));
}
function connect(core: any, userKey: string): any {
	const ws = makeWs();
	core.handleConnection(ws, { url: `/ws?u=${encodeURIComponent(userKey)}` });
	return ws;
}
const expectMsg = (ws: any, i: number, type: string) => ws.sent[i]?.type === type;
const activeCount = (core: any) => [...core.sessions.values()].filter((s: any) => s.backend?.alive()).length;
// 표준 유저 발화 — 클라 프롬프트 전송 형태(userInput+message) 재현 (B·C·D·F 공용 — 열림 무지간에서 할당 트리거는 발화뿐)
const sendPrompt = (ws: any, text = "안녕") => wsMessage(ws, { type: "prompt", userInput: text, message: text });

// ── 코어 팩터리 — FakeBackend 주입 + 소유 백엔드 배열 추적 ──
function newCore(maxSessions: number) {
	const backends: FakeBackend[] = [];
	const core = SC.createSessionCore({
		maxSessions,
		scanOnBoot: false, // 1c 부팅 스윕 옵트아웃 — 이전 케이스가 만든 conversation.json을 끌어들이는 크로스 코어 오염 방지
		backendFactory: (opts: BackendOptions) => { const b = new FakeBackend(opts); backends.push(b); return b; },
	});
	const active = () => [...core.sessions.values()].filter((s) => s.backend?.alive()).length;
	return { core, backends, active };
}

// ═══════════════ A. 회수판정 — 순수함수 직접 호출 (FakeBackend·WS 없음) ═══════════════
{
	const now = 1_000_000_000_000;
	const idleMs = 300_000;
	const S = (over: Record<string, any>) => ({
		ws: new Set(),
		isStreaming: false,
		backend: { alive: () => true },
		lastActivity: now - 400_000,
		...over,
	});

	ok("A1 WS 연결 + 유휴 1h → 보존 (대화 가능성 우선)", SC.shouldReclaim(S({ ws: new Set([{}]) }), now, idleMs) === false);
	ok("A2 WS 없음 + isStreaming → 보존 (회수=응답 유실)", SC.shouldReclaim(S({ isStreaming: true }), now, idleMs) === false);
	ok("A3 WS 없음 유휴 299s → 보존", SC.shouldReclaim(S({ lastActivity: now - 299_000 }), now, idleMs) === false);
	ok("A4 WS 없음 유휴 301s → 회수 대상", SC.shouldReclaim(S({ lastActivity: now - 301_000 }), now, idleMs) === true);
	ok("A5 dormant(backend=null) → 회수 대상 아님 (stop 재호출 없음)", SC.shouldReclaim(S({ backend: null }), now, idleMs) === false);

	// pickReclaimVictim 직접 — 스티(수요 확보)은 임계 없음: 최근 유휴(fresh)도 후보지만 최오래(idleOld)가 LRU 승자
	// 스트리밍·WS부착·dormant은 제외 — 회수 금지 부정조건
	const m = new Map<string, any>([
		["fresh", S({ lastActivity: now - 1_000 })],
		["streaming", S({ isStreaming: true, lastActivity: now - 500_000 })],
		["wsattached", S({ ws: new Set([{}]), lastActivity: now - 500_000 })],
		["idleOld", S({})],
		["dormant", S({ backend: null, lastActivity: now - 800_000 })],
	]);
	const v = SC.pickReclaimVictim(m);
	ok("A6 pickReclaimVictim — 후보 중 최오래 1명만 (임계 없음 — fresh도 후보지만 LRU에서 짐)", v === m.get("idleOld"));
}

// ═══════════════ B. cap·LRU (maxSessions=5) — 열림 무지간: 접속은 셸만, cap 배분은 발화 수요 시점 ═══════════════
{
	const B = newCore(5);
	const wsAl = connect(B.core, "b-alice");
	const wsBob = connect(B.core, "b-bob");
	const wsCa = connect(B.core, "b-carol");
	const wsDave = connect(B.core, "b-dave");
	const wsEve = connect(B.core, "b-eve");
	ok("B1 5 대화 접속 → 스폰 0 (접속은 뷰어 신호 — 프로세스를 부르지 않는다)", B.backends.length === 0 && B.active() === 0);
	sendPrompt(wsAl); sendPrompt(wsBob); sendPrompt(wsCa); sendPrompt(wsDave); sendPrompt(wsEve);
	ok("B1b 5 발화 → 5/5 백엔드 할당 (작업 명령만 수요)", B.backends.length === 5 && B.active() === 5);

	// cap-full + 유휴 2개 — carol이 최오래 → victim 예정.
	// FakeBackend는 자동 agent_end가 없어 발화 후 isStreaming=true 잔존 — victim 판정 전 정리(실기는 agent_end로 클리어).
	(B.core.sessions.get("b-bob") as any).isStreaming = false;
	(B.core.sessions.get("b-carol") as any).isStreaming = false;
	wsBob.close();
	wsCa.close();
	const sBob = B.core.sessions.get("b-bob") as any;
	const sCarol = B.core.sessions.get("b-carol") as any;
	sBob.lastActivity = Date.now() - 310_000;
	sCarol.lastActivity = Date.now() - 400_000;
	const wsFrank = connect(B.core, "b-frank"); // 6번째 접속 — 셸은 무상한(LRU remove 제거), 백엔드만 cap 배분
	ok("B2 cap-full 접속 → 스폰 0·스틸 없음 (dormant 셸 + pi_ready 합성)",
		sCarol.backend !== null && B.backends.length === 5 && B.active() === 5 && expectMsg(wsFrank, 0, "pi_ready"));
	sendPrompt(wsFrank); // 6번째 발화 — 수요 시점에만 victim 스틸
	ok("B2b cap 초과 발화 → 최오래 유휴 victim(carol) 회수 후 frank 할당",
		sCarol.backend === null && sCarol.backendReady === false && (B.backends[2] as FakeBackend).aliveState === false
		&& (B.backends[5] as FakeBackend).alive() === true && B.active() === 5,
		`states=${JSON.stringify(B.backends.map((b) => b.aliveState))}`);
	ok("B2c victim 회수는 stop 1회 + 셸 보존 (LRU removeSession 경로 제거)",
		(B.backends[2] as FakeBackend).stopCount === 1 && B.core.sessions.has("b-carol") && B.core.sessions.size === 6);

	// 전면 활성 가정 — bob을 스트리밍 중(백그라운드 응답 생성)으로 만들어 victim 후보 제외
	// (스틸은 임계 없으므로 최근 유휴만으론 보호되지 않음 — 전면활성 = WS부착 4 + 스트리밍 1)
	sBob.isStreaming = true;
	const wsGrace = connect(B.core, "b-grace");
	const sGrace = B.core.sessions.get("b-grace") as any;
	ok("B3 전면활성 접속 → 셸만(pi_ready 합성)·스폰 없음",
		expectMsg(wsGrace, 0, "pi_ready") && sGrace.backend === null && B.backends.length === 6 && B.active() === 5);

	// B4 스트리밍 victim 제외 — 최오래(alice, 스트리밍)는 skip, 차오래 유휴(eve) 회수
	wsAl.close();
	wsEve.close();
	const sAlice = B.core.sessions.get("b-alice") as any;
	const sEve = B.core.sessions.get("b-eve") as any;
	sAlice.isStreaming = true; // 백그라운드 응답 생성 중 — 회수 금지 부정조건
	sEve.isStreaming = false; // B1b 발화 잔존 정리 — eve를 victim 후보로 (bob은 스트리밍 유지 — 제외 검증)
	sAlice.lastActivity = Date.now() - 600_000;
	sEve.lastActivity = Date.now() - 350_000;
	const wsHank = connect(B.core, "b-hank");
	sendPrompt(wsHank); // 발화 수요 — victim 스틸은 발화 시점
	ok("B4 스트리밍 세션은 victim 제외 — 차오래 유휴(eve) 회수 후 hank 할당",
		(B.backends[0] as FakeBackend).aliveState === true && (B.backends[4] as FakeBackend).stopCount === 1
		&& (B.backends[6] as FakeBackend).alive() === true && B.active() === 5,
		`alices=${(B.backends[0] as FakeBackend).aliveState} eves=${(B.backends[4] as FakeBackend).stopCount}`);

	// B5 cap-full WS 프롬프트 → agent_end 에러 broadcast
	orderLog.length = 0;
	const backendCount = B.backends.length;
	sendPrompt(wsGrace);
	const last = wsGrace.sent[wsGrace.sent.length - 1];
	ok("B5 cap-full WS 프롬프트 → agent_end 에러 broadcast (agent_start/isStreaming 미설정)",
		last?.type === "agent_end" && typeof last.error === "string" && last.error.includes("최대 백엔드")
		&& !wsGrace.sent.some((m: any) => m.type === "agent_start")
		&& sGrace.isStreaming === false && B.backends.length === backendCount,
		`sent=${JSON.stringify(wsGrace.sent.map((m: any) => m.type))}`);
}

// ═══════════════ C. dormant 즉시발화 (maxSessions=1) ═══════════════
{
	const C = newCore(1);
	const wsA = connect(C.core, "c-a");
	const sB = connect(C.core, "c-b"); // 접속 둘 다 셸만 — 스폰 없음
	const sBob = C.core.sessions.get("c-b") as any;
	ok("C0 접속 2개 → 스폰 0 (pi_ready 합성 — 뷰어 신호, dormant 셸)", expectMsg(wsA, 0, "pi_ready") && expectMsg(sB, 0, "pi_ready")
		&& sBob.backend === null && C.backends.length === 0);

	sendPrompt(wsA); // 발화 → cap 1 할당 (작업 명령만 수요)
	ok("C0a 발화 → cap 1 할당", C.backends.length === 1 && C.active() === 1);

	// 슬롯 해제 — 수동 회수 스윕 (실 인터벌 60s 대기 금지 — reclaimSweep 직접 호출로 우회)
	wsA.close();
	const sA = C.core.sessions.get("c-a") as any;
	sA.isStreaming = false; // 발화 정리 — FakeBackend는 자동 agent_end를 내지 않는다
	sA.lastActivity = Date.now() - 400_000;
	C.core.reclaimSweep();
	ok("C0b 수동 회수 스윕 — 유휴 백엔드 dormant 전환", sA.backend === null && (C.backends[0] as FakeBackend).stopCount === 1 && C.active() === 0);

	// dormant 세션에 WS 프롬프트 → 즉시발화 (sendToBackend 가드가 ensureBackend)
	orderLog.length = 0;
	wsMessage(sB, { type: "prompt", userInput: "안녕", message: "안녕" });
	const fakeB = C.backends[1] as FakeBackend;
	ok("C1 dormant WS 프롬프트 → 백엔드 기동 1회 + prompt 전달 1회",
		fakeB.startCount === 1 && fakeB.records.length === 1 && (fakeB.records[0] as any).message === "안녕",
		`start=${fakeB.startCount} records=${fakeB.records.length}`);
	ok("C2 합성 agent_start가 backend.send에 선행 (같은 틱 — 로고 전환 우선)",
		orderLog.indexOf("ws:agent_start") !== -1
		&& orderLog.indexOf("ws:agent_start") < orderLog.indexOf("backend:prompt"),
		`order=${JSON.stringify(orderLog)}`);
	wsMessage(sB, { type: "prompt", userInput: "또", message: "또" });
	ok("C3 ensure 멱등 — 재발화도 start 2회 없음", fakeB.startCount === 1 && fakeB.records.length === 2);
}

// ═══════════════ D. 크래시 (maxSessions=5) ═══════════════
{
	const D = newCore(5);

	// D1 WS 있음 → 1.5s 후 자동 재시작 (짧은 실대기 허용)
	const ws1 = connect(D.core, "d-one");
	sendPrompt(ws1); // 발화 → 기동 (접속만으론 스폰 없음)
	D.backends[0].emitExit();
	const s1 = D.core.sessions.get("d-one") as any;
	ok("D1a 크래시 즉시 — ready 해제, 즉시 시작 아님(재시작 스케줄)",
		s1.backendReady === false && (s1.backend as FakeBackend).aliveState === false && D.backends.length === 1);
	await sleep(1800);
	ok("D1b 1.5s 경과 → 재시작 1회 완료(ready 복원)",
		D.backends.length === 2 && (D.backends[1] as FakeBackend).startCount === 1
		&& s1.backend === D.backends[1] && s1.backendReady === true
		&& logBuf.some((l) => l.includes("비정상 종료 감지")));

	// D2 WS 없음 → dormant 전환(재시작 안함) → 재접속·재발화 시 재할당
	const ws2 = connect(D.core, "d-two");
	sendPrompt(ws2); // 발화 → 기동 [2]
	(D.core.sessions.get("d-two") as any).isStreaming = false; // 발화 정리 — 크래시 시뮬
	ws2.close();
	D.backends[2].emitExit();
	const s2 = D.core.sessions.get("d-two") as any;
	ok("D2a 무WS 크래시 → dormant(backend null)", s2.backend === null && s2.backendReady === false && D.backends.length === 3);
	await sleep(1800);
	ok("D2b 무WS 크래시 — 1.5s 경과에도 재시작 없음", D.backends.length === 3);
	const ws2b = connect(D.core, "d-two");
	ok("D2c dormant 재접속 → 스폰 0·pi_ready 합성 (접속이 프로세스를 부르지 않음 — 회귀)",
		expectMsg(ws2b, 0, "pi_ready") && D.backends.length === 3 && (D.core.sessions.get("d-two") as any).backend === null);
	sendPrompt(ws2b);
	ok("D2d dormant 재개 발화 → ensure 재할당",
		D.backends.length === 4 && (D.backends[3] as FakeBackend).alive()
		&& (D.core.sessions.get("d-two") as any).backend === D.backends[3]);

	// D3 6회 연속 크래시 → 스로틀 중단
	const ws3 = connect(D.core, "d-three");
	sendPrompt(ws3); // 발화 → 기동 [4]
	for (let i = 0; i < 6; i++) D.backends[4].emitExit();
	ok("D3a 6회 연속 크래시 → 재시작 중단 로그", logBuf.some((l) => l.includes("자동 재시작 중단")));
	await sleep(1800);
	ok("D3b 스로틀 — 재시작 1회만 수행 후 중단",
		D.backends.length === 6 && (D.backends[5] as FakeBackend).startCount === 1 && D.active() === 3,
		`backends=${D.backends.length}`);
}

// ═══════════════ E. 파이프 순서 — start 직후 즉시 send 기록 ═══════════════
{
	const E = newCore(5);
	const s = E.core.getOrCreateSession("e-solo") as any;
	const r = E.core.ensureBackend(s);
	const fake = s.backend as FakeBackend;
	fake.send({ type: "prompt", message: "직후 발화" }); // 파이프 버퍼링 근거 — 기동 직후 send 유실 없음
	ok("E start 직후 ready 동기 emit + send 즉시 기록 (재할당 큐 불필요 근거)",
		r === true && s.backendReady === true && fake.startCount === 1 && fake.records.length === 1
		&& fake.opts.cwd === SC.workspacePath("e-solo"));
}

// ═══════════════ F. 열림 무지간·지연 할당 — 접속은 뷰어 신호, 프로세스는 작업 명령만 부른다 (maxSessions=5) ═══════════════
{
	const F = newCore(5);
	const DATA = envPaths("ai-turk").data; // 세션 코어 모듈과 동일 규칙 — XDG 격리 반영
	const metaFile = (k: string) => join(DATA, k, "conversation.json");

	// F1 신규 대화 connect — 스폰 0·디스크 0·pi_ready 합성
	const wsNew = connect(F.core, "f-new");
	const sF = F.core.sessions.get("f-new") as any;
	ok("F1a 신규 접속 — 스폰 0 (접속은 뷰어 신호)", F.backends.length === 0 && sF.backend === null && sF.backendReady === false);
	ok("F1b 접속 즉시 pi_ready 합성 — vapidPublicKey 포함·backend 필드 없음",
		expectMsg(wsNew, 0, "pi_ready") && typeof wsNew.sent[0].vapidPublicKey === "string" && !("backend" in wsNew.sent[0]));
	ok("F1c 클릭만 한 대화 — 디스크 0 (conversation.json·dir 미생성)", !existsSync(metaFile("f-new")) && !existsSync(join(DATA, "f-new")));

	// F1d dormant get_state 합성 — sessionId="" → 클라 복원 스킵(빈 그리드) 경로. 필드세트는 라이브 보강(onEvent)과 동일 기준
	wsMessage(wsNew, { type: "get_state" });
	const gs = wsNew.sent.find((m: any) => m.command === "get_state");
	ok("F1d dormant get_state 합성 — 빈 sessionId·dormant, absent 허용 필드 미포함",
		gs?.success === true && gs.data.sessionId === "" && gs.data.isStreaming === false && gs.data.route === "user"
		&& gs.data.lastResponse === null && gs.data.backendState === "dormant" && gs.data.isCompacting === false
		&& !("model" in gs.data) && !("thinkingLevel" in gs.data) && !("messageCount" in gs.data));

	// F2 캐시 없는 get_available_models — 무응답 수용 (서버 재시작 직후 신규 대화 빈 메뉴 — 스폰하지 않는다)
	const sentAfterF1 = wsNew.sent.length;
	wsMessage(wsNew, { type: "get_available_models" });
	ok("F2 캐시 없는 models 요청 — 무응답·스폰 0", wsNew.sent.length === sentAfterF1 && F.backends.length === 0);

	// F3 dormant 첫 prompt — 스폰 1회·prompt 전달·conversation.json 생성(title+createdAt)
	wsMessage(wsNew, { type: "prompt", userInput: "안녕 터크", message: "안녕 터크" });
	const fb0 = F.backends[0] as FakeBackend;
	ok("F3a dormant 첫 prompt — 스폰 1회·prompt 전달", fb0.startCount === 1 && fb0.records.length === 1 && (fb0.records[0] as any).message === "안녕 터크");
	ok("F3b 첫 발화가 메타 생성 — title(첫 프롬프트 30자)+createdAt 존재", (() => {
		try {
			const m = JSON.parse(readFileSync(metaFile("f-new"), "utf-8"));
			return m.title === "안녕 터크" && typeof m.createdAt === "number" && typeof m.lastActiveAt === "number";
		} catch { return false; }
	})());

	// F4 기존 dormant connect — 완전 복원 시뮬 (+접속 스폰 0 회귀)
	fb0.emit({ type: "response", command: "get_state", success: true, data: { sessionId: "f-sess-1" } } as TurkEvent); // 실 경로 재현 — get_state 응답 → agentSessionId 영속
	ok("F4a get_state 응답 — agentSessionId 메모리·파일 동시 확정",
		sF.agentSessionId === "f-sess-1" && existsSync(join(DATA, "f-new", "agent-session-id")));
	sF.lastResponse = { messages: [{ role: "assistant", content: [{ type: "text", text: "마지막 응답" }] }], stopReason: "end_turn" };
	sF.isStreaming = false; // 발화 정리 — FakeBackend는 자동 agent_end 없음
	wsNew.close();
	sF.lastActivity = Date.now() - 400_000;
	F.core.reclaimSweep();
	ok("F4b 회수 스윕 — dormant 전환", sF.backend === null && fb0.stopCount === 1 && F.backends.length === 1);
	const wsRes = connect(F.core, "f-new");
	ok("F4c 기존 dormant 재접속 — 스폰 0 (재접속만으론 프로세스 안 부름)", F.backends.length === 1 && sF.backend === null);
	wsMessage(wsRes, { type: "get_state" });
	const gs2 = wsRes.sent.find((m: any) => m.command === "get_state");
	ok("F4d get_state 합성 — 진짜 sessionId·lastResponse 포함(복원 시뮬)",
		gs2?.success === true && gs2.data.sessionId === "f-sess-1"
		&& gs2.data.lastResponse?.messages?.[0]?.content?.[0]?.text === "마지막 응답" && gs2.data.backendState === "dormant");

	// F5 set_thinking_level 지연 큐 — dormant 수신(무응답·스폰 0) → 첫 발화 스폰 → 재생이 prompt에 선행
	wsMessage(wsRes, { type: "set_thinking_level", level: "high" });
	ok("F5a dormant set_thinking_level — 큐잉(무응답·스폰 0)",
		sF.pendingThinkingLevel === "high" && F.backends.length === 1
		&& !wsRes.sent.some((m: any) => m.command === "set_thinking_level"));
	orderLog.length = 0;
	wsMessage(wsRes, { type: "prompt", userInput: "이후 발화", message: "이후 발화" });
	const fb1 = F.backends[1] as FakeBackend;
	ok("F5b 첫 발화 스폰 + 큐 재생이 prompt에 선행 (pi_ready 동기 emit 근거 — orderLog)",
		orderLog.indexOf("backend:set_thinking_level") !== -1
		&& orderLog.indexOf("backend:set_thinking_level") < orderLog.indexOf("backend:prompt")
		&& (fb1.records[0] as any).type === "set_thinking_level" && (fb1.records[0] as any).level === "high"
		&& (fb1.records[1] as any).type === "prompt");
	ok("F5c 큐 재생 후 소멸 — 과거 큐값이 미래 리스폰에 재적용되지 않게", sF.pendingThinkingLevel === undefined);

	// F6 get_available_models 전역 캐시 — 라이브 성공 응답 보관 → dormant 재요청에 합성 재전달(스폰 0)
	fb1.emit({ type: "response", command: "get_available_models", success: true, data: { models: [{ id: "m1", name: "Model 1", provider: "test" }] } } as TurkEvent);
	sF.isStreaming = false; // 발화 정리
	wsRes.close();
	sF.lastActivity = Date.now() - 400_000;
	F.core.reclaimSweep();
	ok("F6a 라이브 응답 캐시 후 dormant 전환", sF.backend === null && fb1.stopCount === 1 && F.backends.length === 2);
	const wsRes2 = connect(F.core, "f-new");
	ok("F6b 재접속 — 스폰 0", F.backends.length === 2 && sF.backend === null);
	wsMessage(wsRes2, { type: "get_available_models" });
	const mm = wsRes2.sent.find((m: any) => m.command === "get_available_models");
	ok("F6c dormant models 요청 — 전역 캐시 합성 재전달(스폰 0)",
		mm?.success === true && (mm.data?.models as any[])?.[0]?.id === "m1" && F.backends.length === 2);
	const wsOther = connect(F.core, "f-other"); // 다른 대화 shell — 전역 캐시 공유 검증
	wsMessage(wsOther, { type: "get_available_models" });
	const mo = wsOther.sent.find((m: any) => m.command === "get_available_models");
	ok("F6d 캐시는 세션 무관 전역 — 다른 dormant 대화도 동일 합성(스폰 0)",
		mo?.success === true && (mo.data?.models as any[])?.length === 1 && F.backends.length === 2);
}

// ═══════════════ G. 대화별 마지막 모델 — dormant 표시·변경(스폰 0)·재생·영속 ═══════════════
// 모델은 대화의 속성(프로세스의 속성이 아님): dormant에서도 표시·변경 가능, 서버 재시작 후에도 유지.
{
	const G = newCore(5);
	const DATA = envPaths("ai-turk").data; // 세션 코어 모듈과 동일 규칙 — XDG 격리 반영
	const metaFile = (k: string) => join(DATA, k, "conversation.json");

	// G1 dormant set_model — 스폰 0·pendingModel 큐·합성 success·lastModel 표시 선행 → 이어진 합성 get_state에 model
	const wsU = connect(G.core, "g-unborn");
	const sU = G.core.sessions.get("g-unborn") as any;
	wsMessage(wsU, { type: "set_model", provider: "test", modelId: "m9" });
	ok("G1a dormant set_model — 스폰 0 (모델은 대화의 속성 — 프로세스 수요 없음)", G.backends.length === 0 && sU.backend === null);
	const smResp = wsU.sent.find((m: any) => m.command === "set_model");
	ok("G1b 합성 success 응답 — 클라 get_state 체인 유발용", smResp?.type === "response" && smResp?.success === true);
	ok("G1c pendingModel 큐 + lastModel 표시 선행 갱신",
		sU.pendingModel?.provider === "test" && sU.pendingModel?.modelId === "m9"
		&& sU.lastModel?.provider === "test" && sU.lastModel?.name === "m9" && sU.lastModel?.id === "m9");
	ok("G1d 미발화 대화 set_model — 메타·dir 미생성 (디스크 0 계약 — touch exists-게이트)", !existsSync(join(DATA, "g-unborn")));
	wsMessage(wsU, { type: "get_state" });
	const gsU = wsU.sent.filter((m: any) => m.command === "get_state").pop();
	ok("G1e 이어진 합성 get_state — model 포함(표시 확정)", gsU?.data?.model?.id === "m9" && gsU.data?.model?.provider === "test", `sent=${JSON.stringify(wsU.sent.map((m: any) => m.command ?? m.type))}`);

	// G2 스폰(pi_ready) 재생 순서 — set_model → set_thinking_level → prompt (orderLog 단언)
	wsMessage(wsU, { type: "set_thinking_level", level: "high" }); // dormant 큐잉 — set_model 뒤에 재생되어야 함
	ok("G2-pre set_thinking_level도 스폰 수요 아님", G.backends.length === 0 && sU.pendingThinkingLevel === "high");
	orderLog.length = 0;
	wsMessage(wsU, { type: "prompt", userInput: "재생 발화", message: "재생 발화" });
	const fbG = G.backends[0] as FakeBackend;
	ok("G2a 스폰 직후 재생 순서 — set_model → set_thinking_level → prompt (orderLog)",
		orderLog.indexOf("backend:set_model") !== -1
		&& orderLog.indexOf("backend:set_model") < orderLog.indexOf("backend:set_thinking_level")
		&& orderLog.indexOf("backend:set_thinking_level") < orderLog.indexOf("backend:prompt"),
		`order=${JSON.stringify(orderLog)}`);
	ok("G2b 재생 set_model 페이로드 — provider·modelId 유지",
		(fbG.records[0] as any).type === "set_model" && (fbG.records[0] as any).provider === "test" && (fbG.records[0] as any).modelId === "m9",
		`records=${JSON.stringify(fbG.records.map((r) => r.type))}`);

	// G3 pendingModel 1회 소멸 — 재생 후 다시 dormant → 재발화해도 set_model 재전송 없음
	ok("G3a 재생 후 pendingModel 소멸", sU.pendingModel === null);
	sU.isStreaming = false; // FakeBackend는 자동 agent_end 없음 — 발화 잔존 정리 (victim 후보 조건)
	wsU.close();
	sU.lastActivity = Date.now() - 400_000;
	G.core.reclaimSweep();
	ok("G3b dormant 전환", sU.backend === null && fbG.stopCount === 1);
	const wsU2 = connect(G.core, "g-unborn"); // 스폰 0 — 셸(pi_ready 합성)만
	ok("G3c dorm 전환 후 재접속도 스폰 0", G.backends.length === 1 && G.active() === 0);
	orderLog.length = 0;
	wsMessage(wsU2, { type: "prompt", userInput: "재스폰 발화", message: "재스폰 발화" });
	const fbG2 = G.backends[1] as FakeBackend;
	ok("G3d 재스폰 — pendingModel 1회 소멸 계약(set_model 재전송 없음·prompt만)",
		fbG2.startCount === 1 && fbG2.records.length === 1 && (fbG2.records[0] as any).type === "prompt"
		&& !orderLog.includes("backend:set_model") && sU.pendingModel === null,
		`records=${JSON.stringify(fbG2.records.map((r) => r.type))}`);

	// G4 라이브 get_state model — lastModel 기록 + 메타 model 영속 + 변화시에만 재기록(디스크 터치 최소화)
	const wsL = connect(G.core, "g-live");
	wsMessage(wsL, { type: "prompt", userInput: "라이브 대화", message: "라이브 대화" }); // 메타 생성(발화 계약) → 라이브 경로
	const fbL = G.backends[2] as FakeBackend;
	fbL.emit({ type: "response", command: "get_state", success: true, data: { sessionId: "g-sess", model: { provider: "pi", name: "GPT-5", id: "gpt-5", thinkingLevelMap: { high: { budget: 999 } } } } } as TurkEvent);
	const sL = G.core.sessions.get("g-live") as any;
	ok("G4a 라이브 get_state.model → lastModel 원형 보존(얕은 복사 — 통째)",
		sL.lastModel.provider === "pi" && sL.lastModel.id === "gpt-5" && sL.lastModel.thinkingLevelMap?.high?.budget === 999);
	const metaL = JSON.parse(readFileSync(metaFile("g-live"), "utf-8"));
	ok("G4b 메타 model 필드 영속 + 기존 필드(title·createdAt) 보존",
		metaL.model?.id === "gpt-5" && metaL.title === "라이브 대화" && typeof metaL.createdAt === "number");
	// 변화 없음 — 재기록 없음: 참조 동일성 + mtime 불변(= 디스크 터치 0) 단언
	const same = sL.lastModel;
	const mt0 = statSync(metaFile("g-live")).mtimeMs;
	await sleep(10); // mtime 해상도 대비 — 변화 없으면 10ms 경과에도 불변
	fbL.emit({ type: "response", command: "get_state", success: true, data: { sessionId: "g-sess", model: { provider: "pi", name: "GPT-5", id: "gpt-5", thinkingLevelMap: { high: { budget: 999 } } } } } as TurkEvent);
	fbL.emit({ type: "response", command: "get_state", success: true, data: { sessionId: "g-sess", model: { provider: "pi", name: "GPT-5", id: "gpt-5", thinkingLevelMap: { high: { budget: 999 } } } } } as TurkEvent);
	ok("G4c 동일 model 연속 get_state 2회 — 재기록 없음(참조 동일·mtime 불변 = 디스크 터치 0)",
		sL.lastModel === same && statSync(metaFile("g-live")).mtimeMs === mt0);
	fbL.emit({ type: "response", command: "get_state", success: true, data: { sessionId: "g-sess", model: { provider: "pi", name: "GPT-X", id: "gpt-x" } } } as TurkEvent);
	const metaL2 = JSON.parse(readFileSync(metaFile("g-live"), "utf-8"));
	ok("G4d 모델 변화 → 재기록 — lastModel·메타 동시 갱신",
		sL.lastModel.id === "gpt-x" && metaL2.model?.id === "gpt-x" && sL.lastModel !== same
		&& statSync(metaFile("g-live")).mtimeMs !== mt0);

	// G5 부팅 복원 — meta.model → lastModel 적재 → dormant 합성 get_state 반영 (서버 재시작 계약)
	mkdirSync(join(DATA, "g-restore"), { recursive: true });
	writeFileSync(metaFile("g-restore"), JSON.stringify({ title: "복원 대화", createdAt: Date.now(), lastActiveAt: Date.now(), model: { provider: "ollama", name: "glm-5.1", id: "glm-5.1:cloud" } }));
	const restoreBackends: FakeBackend[] = [];
	const RG = SC.createSessionCore({
		maxSessions: 5,
		backendFactory: (o: BackendOptions) => { const b = new FakeBackend(o); restoreBackends.push(b); return b; },
	}); // scanOnBoot 기본 true — 부팅 스윕이 g-restore 셸 복원
	const wsR = connect(RG, "g-restore");
	const sR = RG.sessions.get("g-restore") as any;
	ok("G5a 부팅 복원 — 스폰 0·meta.model → lastModel 원형 적재",
		restoreBackends.length === 0 && sR.backend === null
		&& sR.lastModel?.id === "glm-5.1:cloud" && sR.lastModel?.provider === "ollama" && sR.lastModel?.name === "glm-5.1");
	wsMessage(wsR, { type: "get_state" });
	const gsR = wsR.sent.filter((m: any) => m.command === "get_state").pop();
	ok("G5b 복원 대화 합성 get_state — model 반영(대화 진입 시 마지막 모델 표시)",
		gsR?.data?.model?.id === "glm-5.1:cloud" && gsR.data?.model?.provider === "ollama");
}

// ═══════════════ workspacePath — 위치 분리 ═══════════════
{
	const DATA = envPaths("ai-turk").data; // 세션 코어 모듈과 동일 규칙 — XDG 격리 반영
	const saved = process.env.TURK_WORKSPACES_ROOT;
	try {
		delete process.env.TURK_WORKSPACES_ROOT;
		ok("W1 미설정 → 현행 경로 DATA_DIR/<uk>/workspace 유지 (동작 0변경)",
			SC.workspacePath("w-user1") === join(DATA, "w-user1", "workspace"),
			`got=${SC.workspacePath("w-user1")}`);
		const ROOT = join(TMP_DATA, "ws-root"); // 절대경로
		process.env.TURK_WORKSPACES_ROOT = ROOT;
		ok("W2 설정 → <ROOT>/<uk> 조합", SC.workspacePath("w-user1") === join(ROOT, "w-user1"));
		ok("W3 TURK_WORKSPACES_ROOT 우선 — DATA_DIR 계열 경로 아님",
			SC.workspacePath("w-user1").startsWith(ROOT) && !SC.workspacePath("w-user1").startsWith(DATA));
	} finally {
		if (saved === undefined) delete process.env.TURK_WORKSPACES_ROOT;
		else process.env.TURK_WORKSPACES_ROOT = saved;
	}
}

console.log(`\n${pass}/${pass + fail} 통과`);
rmSync(TMP_DATA, { recursive: true, force: true }); // 임시 데이터 정리
process.exit(fail === 0 ? 0 : 1);