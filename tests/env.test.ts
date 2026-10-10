/**
 * tests/env.test.ts — Phase 4c 대화별 환경변수 단위테스트 (L1 순수 + L2 코어 통합)
 *
 * 구성: A env-store 저장소 왕복 / B 키 규칙·예약 / C 제한(20개·4KB) / D 코어 주입(FakeBackend opts 값 단언·AGENTS.md 이름 목록) / E applyEnvSection
 * 관례: auth.test.ts 복제 — 평문 tsx 스크립트 · ✅/❌ 출력 · 실패 시 exit 1 · 더미 값만 사용(실 시크릿 금지)
 * 격리: env-store·session-core 모두 DATA_DIR을 모듈 로드 시 확정 (env-paths, XDG_DATA_HOME 따름) → 로드 전 XDG 주입 + 동적 import
 * 계약 주석 고정: 소유권 own-only는 서버 라우트(/api/env/*, server.ts)가 전담 — 세션 코어는 authorize를 모른다.
 *   Phase 3 대화관리 PATCH/DELETE의 own-only 계약을 그대로 재사용하므로 이 테스트에서 라우트 중복 검증하지 않는다.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import envPaths from "env-paths";
import type { Backend, BackendOptions, TurkEvent } from "../backend.ts";

// ── 모듈 로드 전 데이터 경로 격리 (env-store·session-core 둘 다 모듈 로드 시 DATA_DIR 확정) ──
const TMP_DATA = mkdtempSync(join(tmpdir(), "ai-turk-env-"));
process.env.XDG_DATA_HOME = TMP_DATA;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: string): void {
	if (cond) { pass++; console.log("✅", name); }
	else { fail++; console.log("❌", name, extra ?? ""); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 모듈 로드 — XDG 주입 후 동적 import ──
const E = await import("../env-store.ts");
const SC = await import("../session-core.ts");
const AMS = await import("../src/lib/agents-md-server.ts");
const DATA = envPaths("ai-turk").data; // env-store의 DATA_DIR과 동일 규칙

// ── FakeBackend — Backend 인터페이스 구현 + 주입 opts 관측 (pool.test.ts 동일 축약) ──
class FakeBackend implements Backend {
	startCount = 0;
	aliveState = false;
	stopping = false;
	cb: ((ev: TurkEvent) => void) | null = null;
	opts: BackendOptions;
	constructor(opts: BackendOptions) { this.opts = opts; }
	start(): void {
		this.startCount++;
		this.aliveState = true;
		this.cb?.({ type: "pi_ready", backend: this.kind() }); // PiBackend 근거 재현 — spawn 직후 동기 pi_ready emit
	}
	send(_cmd: Record<string, unknown>): void {}
	onEvent(cb: ((ev: TurkEvent) => void) | null): void { this.cb = cb; }
	stop(): void { this.stopping = true; this.aliveState = false; }
	alive(): boolean { return this.aliveState; }
	kind(): "pi" | "claude" { return "pi"; }
}

// ── WS 스텁 — handleConnection 등록 핸들러 직접 호출 (auth.test.ts 동일 축약) ──
function makeWs(): any {
	const handlers: Record<string, ((...args: any[]) => void)[]> = {};
	const sent: unknown[] = [];
	const ws: any = {
		OPEN: 1,
		readyState: 1,
		sent,
		send(raw: string) { sent.push(JSON.parse(raw)); },
		on(ev: string, cb: (...args: any[]) => void) { (handlers[ev] ??= []).push(cb); },
	};
	return ws;
}

// ═══════════════ A. env-store 저장소 왕복 (L1 순수) ═══════════════
{
	const u = "envstore-user";
	ok("A1 set→load 왕복 + 파일 0600",
		E.setConversationEnv(u, "NOTION_TOKEN", "dummy-notion-1").ok === true
		&& E.loadConversationEnv(u).NOTION_TOKEN === "dummy-notion-1"
		&& (statSync(join(DATA, u, "env.json")).mode & 0o777) === 0o600);
	ok("A2 이름 목록 — 이름만 반환 (값 반환 경로 없음 계약)", JSON.stringify(E.listConversationEnvKeys(u)) === JSON.stringify(["NOTION_TOKEN"]));
	ok("A3 upsert 갱신 — 같은 키 덮어씀 (기존 키는 상한과 무관)",
		E.setConversationEnv(u, "NOTION_TOKEN", "dummy-notion-2").ok === true
		&& E.loadConversationEnv(u).NOTION_TOKEN === "dummy-notion-2"
		&& E.listConversationEnvKeys(u).length === 1);
	ok("A4 delete 멱등 + 이후 저장 정상",
		E.deleteConversationEnvKey(u, "NOTION_TOKEN") === true
		&& E.deleteConversationEnvKey(u, "NOTION_TOKEN") === true // 멱등
		&& E.listConversationEnvKeys(u).length === 0
		&& E.setConversationEnv(u, "SECOND", "dummy-second").ok === true
		&& E.loadConversationEnv(u).SECOND === "dummy-second");
	const u2 = "envstore-corrupt";
	E.setConversationEnv(u2, "PRIOR", "dummy-prior");
	writeFileSync(join(DATA, u2, "env.json"), "{ 깨진 json");
	ok("A5 손상 env.json → {} 시작 (users.json 관례 동일) + set 재기록",
		Object.keys(E.loadConversationEnv(u2)).length === 0
		&& E.setConversationEnv(u2, "FRESH", "dummy-fresh").ok === true
		&& E.loadConversationEnv(u2).FRESH === "dummy-fresh");
}

// ═══════════════ B. 키 규칙·예약 거부 (L1 순수) ═══════════════
{
	const u = "envrule-user";
	const bad = ["foo_bar", "FOO-BAR", "1FOO", "_FOO", "", "FOO BAR", "A".repeat(65), "FOO!"];
	ok("B1 키 형식 거부 — 소문자·특수문자·숫자시작·_시작·빈값·공백·65자", bad.every((k) => E.setConversationEnv(u, k, "v").ok === false));
	ok("B2 64자 경계 통과 (1~64자 계약)", E.setConversationEnv(u, "A".repeat(64), "v").ok === true);
	const prefixes = ["TURK_PORT", "GATEWAY_TOKEN", "NODE_ENV", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST"];
	ok("B3 예약 prefix 거부 — GATEWAY_/TURK_/NODE_/ANTHROPIC_/OPENAI_/OLLAMA_", prefixes.every((k) => E.setConversationEnv(u, k, "v").ok === false));
	const exacts = ["PATH", "HOME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM"];
	ok("B4 예약 정확일치 거부 — 셸·프로세스 계약 보호", exacts.every((k) => E.setConversationEnv(u, k, "v").ok === false));
}

// ═══════════════ C. 제한 — 20개 상한 · 4KB 값 (L1 순수) ═══════════════
{
	const u = "envlimit-user";
	let allOk = true;
	for (let i = 1; i <= 20; i++) allOk &&= E.setConversationEnv(u, `KEY_${String(i).padStart(2, "0")}`, `v${i}`).ok === true;
	ok("C1 20개 저장 성공 — 상한까지 허용", allOk);
	ok("C2 21번째 키 거부", E.setConversationEnv(u, "KEY_OVERFLOW", "v").ok === false);
	ok("C3 기존 키 갱신은 상한과 무관 통과", E.setConversationEnv(u, "KEY_01", "v-updated").ok === true && E.loadConversationEnv(u).KEY_01 === "v-updated");
	const v = "envval-user";
	ok("C4 값 4KB 경계 — 4096바이트 통과 · 4097 초과 거부 · 한글 멀티바이트 바이트 기준",
		E.setConversationEnv(v, "VAL_OK", "a".repeat(4096)).ok === true
		&& E.setConversationEnv(v, "VAL_BIG", "a".repeat(4097)).ok === false
		&& E.setConversationEnv(v, "VAL_KO_BIG", "가".repeat(1366)).ok === false // 1366×3=4098바이트 — 문자열 길이 아닌 utf8 바이트 기준
		&& E.setConversationEnv(v, "VAL_KO_OK", "가".repeat(1365)).ok === true); // 4095바이트
}

// ═══════════════ D. 세션 코어 통합 — startBackend가 env.json을 workspaceEnv로 주입 (L2) ═══════════════
// 소유권 own-only는 서버 라우트(/api/env/*) 계약 — 코어는 authorize를 모른다 (주석 고정, 라우트 중복 검증 없음).
{
	const u = "envcore-user";
	const record: Record<string, string> = { FOO_TOKEN: "dummy-foo-1", BAR_KEY: "dummy-bar-2" };
	if (!E.setConversationEnv(u, "FOO_TOKEN", record.FOO_TOKEN).ok || !E.setConversationEnv(u, "BAR_KEY", record.BAR_KEY).ok) throw new Error("D 준비 실패");
	const backends: FakeBackend[] = [];
	const core = SC.createSessionCore({
		maxSessions: 2,
		scanOnBoot: false, // 부팅 스윕 옵트아웃 — 크로스 코어 오염 방지 (pool.test.ts 관례)
		backendFactory: (opts: BackendOptions) => { const b = new FakeBackend(opts); backends.push(b); return b; },
	});
	const ws = makeWs();
	core.handleConnection(ws, { url: `/ws?u=${encodeURIComponent(u)}` }); // 접속 즉시 ensureBackend → startBackend
	const b = backends[0];
	ok("D1 startBackend가 opts.workspaceEnv로 env.json 내용 전달 — 값 단언",
		!!b && JSON.stringify(b.opts.workspaceEnv) === JSON.stringify(record)
		&& b.opts.cwd === SC.workspacePath(u));
	ok("D2 워크스페이스 AGENTS.md에 이름 목록 반영 — 값은 절대 미기록", (() => {
		const md = readFileSync(join(SC.workspacePath(u), "AGENTS.md"), "utf8");
		return md.includes("## Conversation environment variables")
			&& md.includes("- FOO_TOKEN") && md.includes("- BAR_KEY")
			&& !md.includes("dummy-foo-1") && !md.includes("dummy-bar-2");
	})());
}

// ═══════════════ E. applyEnvSection — 마커 교체 · 불변 write 없음 · 마커 신규 추가 (L1) ═══════════════
{
	const dir = mkdtempSync(join(tmpdir(), "agentsmd-"));
	const f = join(dir, "AGENTS.md");
	writeFileSync(f, "# Header\n\n<!-- env:section -->\nOLD_KEY_ONE\n<!-- /env:section -->\n\ntail note\n");
	ok("E1 마커 사이 교체 — 이전 목록 소멸 · 정렬된 신규 이름 · 본문 보존", (() => {
		if (AMS.applyEnvSection(f, ["B_KEY", "A_KEY"]) !== true) return false;
		const c = readFileSync(f, "utf8");
		return !c.includes("OLD_KEY_ONE") && c.indexOf("- A_KEY") < c.indexOf("- B_KEY")
			&& c.includes("## Conversation environment variables")
			&& c.includes("# Header") && c.includes("tail note")
			&& c.split("<!-- env:section -->").length === 2 // 마커 쌍 유지 (중복 추가 없음)
			&& c.split("<!-- /env:section -->").length === 2;
	})());
	await sleep(25); // mtime 비교 전 대기 — 가상의 재기록이 mtime에 드러나도록
	const mtimeBefore = statSync(f).mtimeMs;
	AMS.applyEnvSection(f, ["A_KEY", "B_KEY"]); // 같은 집합 다른 순서 — 정렬로 동일 내용 → write 없음
	ok("E2 불변 write 없음 — mtime 보존 (pi의 AGENTS.md 감시 오동작 방지)", statSync(f).mtimeMs === mtimeBefore);
	writeFileSync(f, "커스텀 메모\n");
	ok("E3 마커 없는 문서(커스텀) — 말미 신규 추가", AMS.applyEnvSection(f, ["MY_TOKEN"]) === true
		&& (() => {
			const c = readFileSync(f, "utf8");
			return c.startsWith("커스텀 메모") && c.includes("- MY_TOKEN")
				&& c.lastIndexOf("<!-- /env:section -->") > c.lastIndexOf("<!-- env:section -->");
		})());
	ok("E4 0키 — '(none configured)' 섹션 유지 + 계약 문구 보존", (() => {
		if (AMS.applyEnvSection(f, []) !== true) return false;
		const c = readFileSync(f, "utf8");
		return c.includes("(none configured)") && c.includes("Values are never passed through chat.");
	})());
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} 통과`);
rmSync(TMP_DATA, { recursive: true, force: true }); // 임시 데이터 정리
process.exit(fail === 0 ? 0 : 1);