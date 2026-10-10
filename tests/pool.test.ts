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
import { mkdtempSync, rmSync } from "node:fs";
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

// ── 코어 팩터리 — FakeBackend 주입 + 소유 백엔드 배열 추적 ──
function newCore(maxSessions: number) {
	const backends: FakeBackend[] = [];
	const core = SC.createSessionCore({
		maxSessions,
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

// ═══════════════ B. cap·LRU (maxSessions=5) ═══════════════
{
	const B = newCore(5);
	const wsAl = connect(B.core, "b-alice");
	const wsBob = connect(B.core, "b-bob");
	const wsCa = connect(B.core, "b-carol");
	connect(B.core, "b-dave");
	const wsEve = connect(B.core, "b-eve");
	ok("B1 5 연결 → 5/5 백엔드 할당 (3/5 중간 단계 포함)", B.backends.length === 5 && B.active() === 5);

	// cap-full + 유휴 2개 — carol이 최오래 → victim
	wsBob.close();
	wsCa.close();
	const sBob = B.core.sessions.get("b-bob") as any;
	const sCarol = B.core.sessions.get("b-carol") as any;
	sBob.lastActivity = Date.now() - 310_000;
	sCarol.lastActivity = Date.now() - 400_000;
	const wsFrank = connect(B.core, "b-frank"); // 6번째 연결 — 셸은 무상한(LRU remove 제거), 백엔드만 cap 배분
	ok("B2 cap 초과 → 최오래 유휴 victim(carol) 회수 후 frank 할당",
		sCarol.backend === null && sCarol.backendReady === false && (B.backends[2] as FakeBackend).aliveState === false
		&& (B.backends[5] as FakeBackend).alive() === true && B.active() === 5,
		`sent=${JSON.stringify(B.backends.map((b) => b.aliveState))}`);
	ok("B2b victim 회수는 stop 1회 + 셸 보존 (LRU removeSession 경로 제거)",
		(B.backends[2] as FakeBackend).stopCount === 1 && B.core.sessions.has("b-carol") && B.core.sessions.size === 6);
	ok("B2c 할당 완료 후 접속 → 초기상태가 pi_ready (ensure가 초기 send 선행)", expectMsg(wsFrank, 0, "pi_ready"));

	// 전면 활성 가정 — bob을 스트리밍 중(백그라운드 응답 생성)으로 만들어 victim 후보 제외
	// (스틸은 임계 없으므로 최근 유휴만으론 보호되지 않음 — 전면활성 = WS부착 4 + 스트리밍 1)
	sBob.isStreaming = true;
	const wsGrace = connect(B.core, "b-grace");
	const sGrace = B.core.sessions.get("b-grace") as any;
	ok("B3 5/5 전면활성 → 신규 할당 거부 (pi_starting 접속, 백엔드 없음)",
		expectMsg(wsGrace, 0, "pi_starting") && sGrace.backend === null && B.backends.length === 6 && B.active() === 5);

	// B4 스트리밍 victim 제외 — 최오래(alice, 스트리밍)는 skip, 차오래 유휴(eve) 회수
	wsAl.close();
	wsEve.close();
	const sAlice = B.core.sessions.get("b-alice") as any;
	const sEve = B.core.sessions.get("b-eve") as any;
	sAlice.isStreaming = true; // 백그라운드 응답 생성 중 — 회수 금지 부정조건
	sAlice.lastActivity = Date.now() - 600_000;
	sEve.lastActivity = Date.now() - 350_000;
	connect(B.core, "b-hank");
	ok("B4 스트리밍 세션은 victim 제외 — 차오래 유휴(eve) 회수 후 hank 할당",
		(B.backends[0] as FakeBackend).aliveState === true && (B.backends[4] as FakeBackend).stopCount === 1
		&& (B.backends[6] as FakeBackend).alive() === true && B.active() === 5,
		`alices=${(B.backends[0] as FakeBackend).aliveState} eves=${(B.backends[4] as FakeBackend).stopCount}`);

	// B5 cap-full WS 프롬프트 → agent_end 에러 broadcast
	orderLog.length = 0;
	const backendCount = B.backends.length;
	wsMessage(wsGrace, { type: "prompt", userInput: "안녕", message: "안녕" });
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
	const sB = connect(C.core, "c-b"); // cap 도달 — dormant 연결
	const sBob = C.core.sessions.get("c-b") as any;
	ok("C0 cap-full 접속 → dormant(pi_starting)", expectMsg(sB, 0, "pi_starting") && sBob.backend === null && C.active() === 1);

	// 슬롯 해제 — 수동 회수 스윕 (실 인터벌 60s 대기 금지 — reclaimSweep 직접 호출로 우회)
	wsA.close();
	(C.core.sessions.get("c-a") as any).lastActivity = Date.now() - 400_000;
	C.core.reclaimSweep();
	const sA = C.core.sessions.get("c-a") as any;
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
	D.backends[0].emitExit();
	const s1 = D.core.sessions.get("d-one") as any;
	ok("D1a 크래시 즉시 — ready 해제, 즉시 시작 아님(재시작 스케줄)",
		s1.backendReady === false && (s1.backend as FakeBackend).aliveState === false && D.backends.length === 1);
	await sleep(1800);
	ok("D1b 1.5s 경과 → 재시작 1회 완료(ready 복원)",
		D.backends.length === 2 && (D.backends[1] as FakeBackend).startCount === 1
		&& s1.backend === D.backends[1] && s1.backendReady === true
		&& logBuf.some((l) => l.includes("비정상 종료 감지")));

	// D2 WS 없음 → dormant 전환(재시작 안함) → 재접속 시 재할당
	const ws2 = connect(D.core, "d-two");
	ws2.close();
	D.backends[2].emitExit();
	const s2 = D.core.sessions.get("d-two") as any;
	ok("D2a 무WS 크래시 → dormant(backend null)", s2.backend === null && s2.backendReady === false && D.backends.length === 3);
	await sleep(1800);
	ok("D2b 무WS 크래시 — 1.5s 경과에도 재시작 없음", D.backends.length === 3);
	const ws2b = connect(D.core, "d-two");
	ok("D2c dormant 재접속 → ensure 재할당(pi_ready)",
		expectMsg(ws2b, 0, "pi_ready") && D.backends.length === 4 && (D.backends[3] as FakeBackend).alive()
		&& (D.core.sessions.get("d-two") as any).backend === D.backends[3]);

	// D3 6회 연속 크래시 → 스로틀 중단
	connect(D.core, "d-three");
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