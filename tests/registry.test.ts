/**
 * tests/registry.test.ts — 1c 대화 레지스트리 단위테스트 (L2 코어 통합)
 *
 * 구성: R1 스캔 필터 / R2 부팅 스윕 부활 / R3 conversation.json 라이프사이클 / R4 listConversations / R5 get_state 보강
 * 관례: pool.test.ts 복제 — 평문 tsx 스크립트 · ✅/❌ 출력 · 실패 시 exit 1
 *
 * 격리: 세션 코어 모듈 로드 전 XDG_DATA_HOME 주입(동적 import 필수 — DATA_DIR이 모듈 로드 시 확정)
 * → FakeBackend·WS 스텁으로 실제 경로(handleConnection 등록 핸들러 직접 호출) 검증.
 * 제약: 실시간 대기 >5초 금지 — 스케줄러 타이머 대기는 R2의 delay-0 과기분만(sleep ≤2s), 미래 타이머는 기다리지 않음.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import envPaths from "env-paths";
import type { Backend, BackendOptions, TurkEvent } from "../backend.ts";

// ── 세션 코어 모듈 로드 전 데이터 경로 격리 (env-paths가 XDG_DATA_HOME을 따름) ──
const TMP_DATA = mkdtempSync(join(tmpdir(), "ai-turk-registry-"));
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
const DATA = envPaths("ai-turk").data; // 코어의 DATA_DIR과 동일 규칙 — 부팅 스윕 fixture 지점

// ── FakeBackend — Backend 인터페이스 구현 + 테스트 헬퍼 (pool.test.ts 동일) ──
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
	send(cmd: Record<string, unknown>): void { this.records.push(cmd); }
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
		send(raw: string) { sent.push(JSON.parse(raw)); },
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
const listIds = (core: any) => core.listConversations().map((c: any) => c.id);

// ── 코어 팩터리 — FakeBackend 주입 + 소유 백엔드 배열 추적 ──
// scanOnBoot은 지정 케이스(R2)만 활성 — 이전 케이스가 만든 conversation.json을 끌어들이는 크로스 코어 오염 방지.
function newCore(maxSessions: number, opts: { scanOnBoot?: boolean } = {}) {
	const backends: FakeBackend[] = [];
	const core = SC.createSessionCore({
		maxSessions,
		scanOnBoot: opts.scanOnBoot ?? false,
		backendFactory: (bopts: BackendOptions) => { const b = new FakeBackend(bopts); backends.push(b); return b; },
	});
	const active = () => [...core.sessions.values()].filter((s) => s.backend?.alive()).length;
	return { core, backends, active };
}

// ═══════════════ R1. 스캔 필터 — scanConversationDirs (순수 함수, 코어 생성 전) ═══════════════
{
	// fixture 생성 순서를 역순(c→b→a)으로 — readdir 순서(tmpfs 삽입순)와 무관하게 정렬이 관측되게
	const scanDir = mkdtempSync(join(tmpdir(), "ai-turk-scan-"));
	mkdirSync(join(scanDir, "conv-c")); writeFileSync(join(scanDir, "conv-c", "conversation.json"), "{}");
	mkdirSync(join(scanDir, "conv-b")); writeFileSync(join(scanDir, "conv-b", "schedules.json"), "[]");
	mkdirSync(join(scanDir, "conv-a")); writeFileSync(join(scanDir, "conv-a", "agent-session-id"), "sess-1");
	mkdirSync(join(scanDir, "junk")); // 상태 파일 없는 빈 dir — 제외
	writeFileSync(join(scanDir, "vapid.json"), "{}"); // 루트 파일 — 제외
	const dirs = SC.scanConversationDirs(scanDir);
	ok("R1 상태 파일 보유 dir만 대화 판별 — [conv-a, conv-b, conv-c] 알파벳 정렬",
		JSON.stringify(dirs) === JSON.stringify(["conv-a", "conv-b", "conv-c"]), `got=${JSON.stringify(dirs)}`);
	ok("R1b dataDir 미존재 → 빈 배열 (신규 설치 방어)", JSON.stringify(SC.scanConversationDirs(join(scanDir, "nope"))) === "[]");
	rmSync(scanDir, { recursive: true, force: true });
}

// ═══════════════ R2. 부팅 스윕 부활 — 셸 복원 + 과기 nextRun 즉시발화 / 미래 스폰 없음 ═══════════════
{
	const t0 = Date.now();
	// fixture — schedules.json은 배열 스키마(Scheduler.loadFromFile 계약)
	mkdirSync(join(DATA, "boot-over"), { recursive: true });
	writeFileSync(join(DATA, "boot-over", "schedules.json"), JSON.stringify([
		{ id: "x", when: "1m", prompt: "부팅 캐치업 과제", nextRun: t0 - 60_000 }, // 과거 — 지연 0 즉시발화
	]));
	mkdirSync(join(DATA, "boot-future"), { recursive: true });
	writeFileSync(join(DATA, "boot-future", "schedules.json"), JSON.stringify([
		{ id: "y", when: "59m", prompt: "미래 스케줄", nextRun: t0 + 59 * 60_000 }, // 미래 — 타이머로만 대기
	]));
	const R2 = newCore(5, { scanOnBoot: true }); // 기본값(생략 시에도 true) — 명시는 가독용
	ok("R2a 부팅 스윕 — 셸 2개 복원(백엔드 스폰 0)",
		R2.core.sessions.size === 2 && R2.core.sessions.has("boot-over") && R2.core.sessions.has("boot-future") && R2.backends.length === 0,
		`size=${R2.core.sessions.size} backends=${R2.backends.length}`);
	await sleep(1500); // ≤2s — setTimeout(0) 과기 스케줄의 즉시발화 대기 (전체 유일 실대기)
	const bo = R2.core.sessions.get("boot-over") as any;
	const bf = R2.core.sessions.get("boot-future") as any;
	const fb = R2.backends[0] as FakeBackend | undefined;
	ok("R2b 과거 nextRun → delay 0 즉시발화 — boot-over만 스폰 + 프롬프트 기록 1회",
		R2.backends.length === 1 && bo?.backend === fb && fb?.records.length === 1
		&& (fb?.records[0] as any)?.type === "prompt" && String((fb?.records[0] as any)?.message).includes("부팅 캐치업 과제"),
		`backends=${R2.backends.length} records=${fb?.records.length}`);
	ok("R2c 미래 nextRun → 타이머 부활 대기 — 스폰 없음 dormant 셸", bf?.backend === null && bf?.backendReady === false);
	ok("R2d 부팅 스윕 로그 1줄", logBuf.some((l) => l.includes("부팅 스윕") && l.includes("2개")),
		`log=${logBuf.filter((l) => l.includes("부팅 스윕")).join(" | ")}`);
}

// ═══════════════ R3. conversation.json 라이프사이클 — 생성·타이틀·lastActiveAt·createdAt 보존 ═══════════════
{
	const R3 = newCore(5);
	const cpath = join(DATA, "r3-user", "conversation.json");
	const t1 = Date.now();
	const ws = connect(R3.core, "r3-user");
	ok("R3a 신규 접속 → 메타 생성 (title null, createdAt=now)", existsSync(cpath)
		&& (() => { const m = JSON.parse(readFileSync(cpath, "utf-8")); return m.title === null && typeof m.createdAt === "number" && m.createdAt >= t1 - 5; })());
	ok("R3b 세션 반영 — title null", (R3.core.sessions.get("r3-user") as any).title === null);

	// 발화 경로 엄정 검증 — 메타를 과거 값으로 되돌려놓고(메모리+디스크) user 프롬프트로 갱신 관측
	const T0 = Date.now() - 200_000;
	const sR3 = R3.core.sessions.get("r3-user") as any;
	sR3.createdAt = T0; sR3.lastActiveAt = T0; sR3.title = null;
	writeFileSync(cpath, JSON.stringify({ title: null, createdAt: T0, lastActiveAt: T0 }));
	const USER_TEXT = "안녕하세요 터크! 첫 대화 타이틀이 되는 아주 긴 프롬프트 문장으로서 30자 절단 지점이 이 근처일 것입니다";
	wsMessage(ws, { type: "prompt", userInput: USER_TEXT, message: USER_TEXT });
	const meta = JSON.parse(readFileSync(cpath, "utf-8"));
	ok("R3c user 프롬프트 → 타이틀 확정(30자 절단) + lastActiveAt 갱신 + createdAt 보존",
		meta.title === USER_TEXT.slice(0, 30) && meta.lastActiveAt > T0 && meta.createdAt === T0 && sR3.title === USER_TEXT.slice(0, 30),
		`title=${JSON.stringify(meta.title)} lastActiveAt=${meta.lastActiveAt} createdAt=${meta.createdAt}`);

	// 두 번째 프롬프트 — 타이틀 불변(첫 프롬프트 고정), lastActiveAt만 갱신
	await sleep(10);
	wsMessage(ws, { type: "prompt", userInput: "두 번째 프롬프트 — 타이틀을 바꾸면 안 됨", message: "x" });
	const meta2 = JSON.parse(readFileSync(cpath, "utf-8"));
	ok("R3d 두 번째 프롬프트 — 타이틀 불변 · lastActiveAt만 갱신", meta2.title === USER_TEXT.slice(0, 30) && meta2.lastActiveAt > meta.lastActiveAt);

	// 동일 코어 재접속 — createdAt 보존
	ws.close();
	const ws2 = connect(R3.core, "r3-user");
	const meta3 = JSON.parse(readFileSync(cpath, "utf-8"));
	ok("R3e 동일 코어 재접속 — touch가 createdAt 보존", meta3.createdAt === T0);
	ws2.close();

	// 재시작 시뮬레이션 — 신규 코어(scanOnBoot false) 접속 시점 createSession이 파일에서 복원
	const R3b = newCore(5);
	const ws3 = connect(R3b.core, "r3-user");
	const sR3b = R3b.core.sessions.get("r3-user") as any;
	const meta4 = JSON.parse(readFileSync(cpath, "utf-8"));
	ok("R3f 신규 코어 재접속(재시작) — 파일에서 createdAt·title 복원 보존",
		meta4.createdAt === T0 && sR3b.createdAt === T0 && sR3b.title === USER_TEXT.slice(0, 30));
	ws3.close();
}

// ═══════════════ R4. listConversations — 정렬·활성 필드·상태 매핑 ═══════════════
{
	const R4 = newCore(5);
	const wsA = connect(R4.core, "r4-a");
	wsMessage(wsA, { type: "prompt", userInput: "A대화 첫발화", message: "A" });
	await sleep(20); // lastActiveAt 우위 확정 (ms 해상도 대비)
	const wsB = connect(R4.core, "r4-b");
	wsMessage(wsB, { type: "prompt", userInput: "B대화 첫발화", message: "B" });
	wsMessage(wsA, { type: "schedule", action: "add", id: "r4-s1", when: "30m", prompt: "정기 점검" }); // r4-a에 스케줄 1건
	const sA = R4.core.sessions.get("r4-a") as any;
	const sB = R4.core.sessions.get("r4-b") as any;
	const l1 = R4.core.listConversations();
	ok("R4a 정렬 — lastActiveAt 내림차순 (최근 B 우선)", JSON.stringify(listIds(R4.core)) === JSON.stringify(["r4-b", "r4-a"]), `got=${JSON.stringify(listIds(R4.core))}`);
	ok("R4b 활성 필드 — active·streaming·backendState=active", l1.every((c: any) => c.active === true && c.streaming === true && c.backendState === "active"));
	ok("R4c scheduleCount — scheduler.list().data.count 연동",
		l1.find((c: any) => c.id === "r4-a")?.scheduleCount === 1 && l1.find((c: any) => c.id === "r4-b")?.scheduleCount === 0);
	// 상태 매핑 — starting(alive+미ready) / dormant(비alive)
	sA.isStreaming = false;
	sB.backendReady = false;
	ok("R4d backendState starting — alive+미ready", R4.core.listConversations().find((c: any) => c.id === "r4-b")?.backendState === "starting");
	sB.backend = null;
	const cB: any = R4.core.listConversations().find((c: any) => c.id === "r4-b");
	ok("R4e backendState dormant + active=false", cB?.backendState === "dormant" && cB?.active === false && cB?.streaming === sB.isStreaming);
	const keys = Object.keys(R4.core.listConversations()[0]);
	ok("R4f 응답 스키마 — 8필드 고정 계약",
		JSON.stringify(keys) === JSON.stringify(["id", "title", "createdAt", "lastActiveAt", "active", "streaming", "scheduleCount", "backendState"]),
		`got=${JSON.stringify(keys)}`);
	wsA.close(); wsB.close();
}

// ═══════════════ R5. get_state 보강 — backendState 주입 (FakeBackend emit 경로) ═══════════════
{
	const R5 = newCore(3);
	const ws = connect(R5.core, "r5-user");
	(R5.backends[0] as FakeBackend).emit({ type: "response", command: "get_state", data: {} } as TurkEvent);
	const ev = ws.sent.find((m: any) => m.type === "response" && m.command === "get_state");
	ok("R5 get_state 보강 — data.backendState=active 주입", ev?.data?.backendState === "active", `ev=${JSON.stringify(ev)}`);
	// 상태 전이가 보강에 실시간 반영되는지 — dormant로 만든 뒤 재emit
	(R5.core.sessions.get("r5-user") as any).backend = null;
	(R5.backends[0] as FakeBackend).emit({ type: "response", command: "get_state", data: {} } as TurkEvent);
	const ev2 = ws.sent.filter((m: any) => m.type === "response" && m.command === "get_state").pop();
	ok("R5b get_state 보강 — dormant 전이 실시간 반영", ev2?.data?.backendState === "dormant");
	ws.close();
}

console.log(`\n${pass}/${pass + fail} 통과`);
rmSync(TMP_DATA, { recursive: true, force: true }); // 임시 데이터 정리
process.exit(fail === 0 ? 0 : 1);