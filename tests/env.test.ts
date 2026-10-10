/**
 * tests/env.test.ts — 4c-refit 계정별 환경변수 단위테스트 (L1 순수 + L2 코어 통합)
 *
 * 구성: A 계정 저장소(users.json env 필드) 왕복 / B 키 규칙·예약 / C 제한(20개·4KB) / D accountEnv 계약(auth.Authorizer)
 * / E 마이그레이션(구 <userKey>/env.json → 계정 env 병합) / F 세션 코어 주입(계정 env — 실 authorizer 연결) / G applyEnvSection
 * 관례: auth.test.ts 복제 — 평문 tsx 스크립트 · ✅/❌ 출력 · 실패 시 exit 1 · 더미 값만 사용(실 시크릿 금지)
 * 격리: env-store·auth·session-core 모두 DATA_DIR을 모듈 로드 시 확정 (env-paths, XDG_DATA_HOME 따름) → 로드 전 XDG 주입 + 동적 import
 * 계약 주석 고정: 구 대화 env.json의 파일·값 접촉은 migrateConversationEnvToAccounts 하나뿐 — 그 밖의 경로는 계정 env(users.json)만 안다.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import envPaths from "env-paths";
import type { Backend, BackendOptions, TurkEvent } from "../backend.ts";

// ── 모듈 로드 전 데이터 경로 격리 (env-store·auth·session-core 둘 다 모듈 로드 시 DATA_DIR 확정) ──
const TMP_DATA = mkdtempSync(join(tmpdir(), "ai-turk-env-"));
process.env.XDG_DATA_HOME = TMP_DATA;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: string): void {
	if (cond) { pass++; console.log("✅", name); }
	else { fail++; console.log("❌", name, extra ?? ""); }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── 모듈 로드 — XDG 주입 후 동적 import (env-store가 auth 부작용(시크릿 생성)도 TMP_DATA로 끌어들임 — 격리 계약 동일) ──
const E = await import("../env-store.ts");
const A = await import("../auth.ts");
const SC = await import("../session-core.ts");
const AMS = await import("../src/lib/agents-md-server.ts");
const DATA = envPaths("ai-turk").data; // env-store·auth의 DATA_DIR과 동일 규칙

// ── 테스트 계정 조립 — users.json 장부에 실제 자격(salt·hash)으로 1계정 삽입 ──
function addUser(name: string, userKeys: string[] = [], env?: Record<string, string>): void {
	const users = A.loadUsers();
	const cred = A.hashPassword(`dummy-pw-${name}`);
	users.accounts[name] = { salt: cred.salt, hash: cred.hash, userKeys, ...(env ? { env } : {}), createdAt: 1 };
	A.saveUsers(users);
}
function clearAccounts(): void {
	A.saveUsers(A.emptyUsers());
}

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
// ═══════════════ A. 계정 저장소 왕복 — users.json 내부 (L1 순수) ═══════════════
{
	clearAccounts();
	addUser("acct-a");
	ok("A1 set→load 왕복 + users.json 0600 유지 + env 필드 내부 저장 (별도 파일 아님)",
		E.setAccountEnv("acct-a", "NOTION_TOKEN", "dummy-notion-1").ok === true
		&& E.loadAccountEnv("acct-a").NOTION_TOKEN === "dummy-notion-1"
		&& (statSync(join(DATA, "users.json")).mode & 0o777) === 0o600
		&& existsSync(join(DATA, "acct-a", "env.json")) === false // 대화 스코프 구 파일이 아닌 users.json 내부 저장 (계약 1)
		&& JSON.parse(readFileSync(join(DATA, "users.json"), "utf8")).accounts["acct-a"].env.NOTION_TOKEN === "dummy-notion-1");
	ok("A2 이름 목록 — 정렬·이름만 반환 (값 반환 경로는 주입 계통뿐 계약)",
		E.setAccountEnv("acct-a", "B_KEY", "dummy-b").ok === true
		&& E.setAccountEnv("acct-a", "A_KEY", "dummy-a2").ok === true
		&& JSON.stringify(E.listAccountEnvKeys("acct-a")) === JSON.stringify(["A_KEY", "B_KEY", "NOTION_TOKEN"]));
	ok("A3 upsert 갱신 — 같은 키 덮어씀 (기존 키는 상한과 무관)·목록 무변경",
		E.setAccountEnv("acct-a", "A_KEY", "dummy-a3").ok === true
		&& E.loadAccountEnv("acct-a").A_KEY === "dummy-a3"
		&& E.listAccountEnvKeys("acct-a").length === 3);
	ok("A4 delete 멱등 + 값 소멸 + 이후 저장 정상",
		E.deleteAccountEnvKey("acct-a", "A_KEY") === true
		&& E.deleteAccountEnvKey("acct-a", "A_KEY") === true // 멱등
		&& "A_KEY" in E.loadAccountEnv("acct-a") === false
		&& E.setAccountEnv("acct-a", "SECOND", "dummy-second").ok === true
		&& E.loadAccountEnv("acct-a").SECOND === "dummy-second");
	ok("A5 미존재 계정 — load {} · list [] · set 거부 · delete false (멱등 계약 예외: 장부에 대상 없음)",
		Object.keys(E.loadAccountEnv("acct-ghost")).length === 0
		&& E.listAccountEnvKeys("acct-ghost").length === 0
		&& E.setAccountEnv("acct-ghost", "KEY", "v").ok === false
		&& E.deleteAccountEnvKey("acct-ghost", "KEY") === false);
	// 스키마 오염 env 필드 — hand-edit 방어 (문자열 쌍만 수용)
	const users = A.loadUsers();
	const acc = A.loadUsers().accounts["acct-a"];
	A.saveUsers({ accounts: { ...users.accounts, "acct-a": { ...acc, env: { STR: "v", NUM: 42, ARR: [1] } as unknown as Record<string, string> } } });
	ok("A6 오염 env 필드 방어 — hand-edit 값 오염 시 문자열 쌍만 수용 (정규화 로드)",
		JSON.stringify(E.loadAccountEnv("acct-a")) === JSON.stringify({ STR: "v" }));
}

// ═══════════════ B. 키 규칙·예약 거부 (L1 순수 — 저장소 진원 + DELETE 세그먼트 검증용 isEnvKeyName) ═══════════════
{
	clearAccounts();
	addUser("acct-rule");
	const bad = ["foo_bar", "FOO-BAR", "1FOO", "_FOO", "", "FOO BAR", "A".repeat(65), "FOO!"];
	ok("B1 키 형식 거부 — 소문자·특수문자·숫자시작·_시작·빈값·공백·65자", bad.every((k) => E.setAccountEnv("acct-rule", k, "v").ok === false));
	ok("B2 64자 경계 통과 (1~64자 계약)", E.setAccountEnv("acct-rule", "A".repeat(64), "v").ok === true);
	const prefixes = ["TURK_PORT", "GATEWAY_TOKEN", "NODE_ENV", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OLLAMA_HOST"];
	ok("B3 예약 prefix 거부 — GATEWAY_/TURK_/NODE_/ANTHROPIC_/OPENAI_/OLLAMA_", prefixes.every((k) => E.setAccountEnv("acct-rule", k, "v").ok === false));
	const exacts = ["PATH", "HOME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM"];
	ok("B4 예약 정확일치 거부 — 셸·프로세스 계약 보호", exacts.every((k) => E.setAccountEnv("acct-rule", k, "v").ok === false));
	ok("B5 isEnvKeyName — 저장소 검증과 동일 판정 (DELETE 라우트 세그먼트 검증 진원)", bad.every((k) => E.isEnvKeyName(k) === false)
		&& E.isEnvKeyName("A".repeat(64)) === true && prefixes.every((k) => E.isEnvKeyName(k) === false) && exacts.every((k) => E.isEnvKeyName(k) === false));
}

// ═══════════════ C. 제한 — 20개 상한 · 4KB 값 (L1 순수 — 상한은 이제 계당) ═══════════════
{
	clearAccounts();
	addUser("acct-limit");
	let allOk = true;
	for (let i = 1; i <= 20; i++) allOk &&= E.setAccountEnv("acct-limit", `KEY_${String(i).padStart(2, "0")}`, `v${i}`).ok === true;
	ok("C1 20개 저장 성공 — 상한까지 허용", allOk);
	ok("C2 21번째 키 거부", E.setAccountEnv("acct-limit", "KEY_OVERFLOW", "v").ok === false);
	ok("C3 기존 키 갱신은 상한과 무관 통과", E.setAccountEnv("acct-limit", "KEY_01", "v-updated").ok === true && E.loadAccountEnv("acct-limit").KEY_01 === "v-updated");
	addUser("acct-value"); // C4 전용 계정 — acct-limit은 이미 상한 20 (새 키 추가를 방해하므로 값 규칙은 분리 시험)
ok("C4 값 4KB 경계 — 4096바이트 통과 · 4097 초과 거부 · 한글 멀티바이트 바이트 기준",
		E.setAccountEnv("acct-value", "VAL_OK", "a".repeat(4096)).ok === true
		&& E.setAccountEnv("acct-value", "VAL_BIG", "a".repeat(4097)).ok === false
		&& E.setAccountEnv("acct-value", "VAL_KO_BIG", "가".repeat(1366)).ok === false // 1366×3=4098바이트 — 문자열 길이 아닌 utf8 바이트 기준
		&& E.setAccountEnv("acct-value", "VAL_KO_OK", "가".repeat(1365)).ok === true); // 4095바이트
}

// ═══════════════ D. accountEnv 계약 — userKey → 소유자 계정 env (auth.Authorizer) ═══════════════
{
	clearAccounts();
	addUser("acct-alice", ["conv-alice-1"], { FOO_TOKEN: "dummy-foo-1", BAR_KEY: "dummy-bar-1" });
	addUser("acct-bob", ["conv-bob-1"], { BAZ_TOKEN: "dummy-baz-1" });
	const authz = A.createAuthorizer(); // 실 authorizer — 구조 일치 (CoreAuthorizer) + 계약 동일
	ok("D1 소유 userKey → 소유자 계정 env 전체 반환 (값 포함 — 주입 계통 유일)",
		JSON.stringify(authz.accountEnv("conv-alice-1")) === JSON.stringify({ FOO_TOKEN: "dummy-foo-1", BAR_KEY: "dummy-bar-1" })
		&& JSON.stringify(authz.accountEnv("conv-bob-1")) === JSON.stringify({ BAZ_TOKEN: "dummy-baz-1" }));
	ok("D2 고아·미소유 userKey → {} — + 반환값은 방어 복사 (스토어 오염 전파 없음)",
		(() => {
			const orphan = authz.accountEnv("no-one-owns-this-key");
			if (Object.keys(orphan).length !== 0) return false;
			const alias = authz.accountEnv("conv-alice-1");
			alias.FOO_TOKEN = "dummy-tampered"; // 스토어가 아닌 복사본 오염
			return E.loadAccountEnv("acct-alice").FOO_TOKEN === "dummy-foo-1";
		})());
}

// ═══════════════ E. 마이그레이션 — 구 대화 env.json → 소유자 계정 env (add-if-absent · 계정 승리 · 고아 미병합) ═══════════════
{
	clearAccounts();
	addUser("acct-mig-a", ["mig-alice"], { PRIOR: "dummy-account-1" }); // PRIOR — 계정 승리 시험 키
	addUser("acct-mig-b", ["mig-bob", "mig-badkey"]); // mig-badkey도 소유 — 예약 키뿐인 병합-제로 파일 소멸 시험
	mkdirSync(join(DATA, "mig-alice"), { recursive: true });
	mkdirSync(join(DATA, "mig-bob"), { recursive: true });
	mkdirSync(join(DATA, "mig-orphan"), { recursive: true });
	mkdirSync(join(DATA, "mig-badkey"), { recursive: true });
	writeFileSync(join(DATA, "mig-alice", "env.json"), JSON.stringify({ PRIOR: "dummy-old-1", FRESH_KEY: "dummy-old-2", bad_key: "dummy-old-3" }));
	writeFileSync(join(DATA, "mig-bob", "env.json"), JSON.stringify({ BOB_TOKEN: "dummy-old-4" }));
	writeFileSync(join(DATA, "mig-orphan", "env.json"), JSON.stringify({ O_KEY: "dummy-old-5" })); // 소유자 없음
	writeFileSync(join(DATA, "mig-badkey", "env.json"), JSON.stringify({ TURK_BAD: "dummy-old-6" })); // 예약 prefix(TURK_) 스킵 시험
	const n = E.migrateConversationEnvToAccounts();
	ok("E1 이관 개수 = 실제 신규 추가 키만 (계정 승리·규칙 위반·예약·고아 제외 — FRESH_KEY+BOB_TOKEN)", n === 2, `got ${n}`);
	ok("E2 소유 대화 → 소유자 병합: 계정 우선(add-if-absent)·신규 추가·규칙 위반 스킵·users.json 반영",
		E.loadAccountEnv("acct-mig-a").PRIOR === "dummy-account-1" // 계정 승리 — 구 값 dummy-old-1로 덮이지 않음
		&& E.loadAccountEnv("acct-mig-a").FRESH_KEY === "dummy-old-2"
		&& !("bad_key" in E.loadAccountEnv("acct-mig-a"))
		&& E.loadAccountEnv("acct-mig-b").BOB_TOKEN === "dummy-old-4");
	ok("E3 병합 후 구 파일 소멸 — 병합 실적 0인 소유 파일도 정리, 고아만 유지",
		existsSync(join(DATA, "mig-alice", "env.json")) === false
		&& existsSync(join(DATA, "mig-bob", "env.json")) === false
		&& existsSync(join(DATA, "mig-badkey", "env.json")) === false // 예약 키뿐 → adds 0이지만 죽은 데이터 정리
		&& existsSync(join(DATA, "mig-orphan", "env.json")) === true); // 고아 — 그대로 두되 미병합 (클레임 시점 소유자의 자산)
	ok("E4 고아 미병합 — 어느 계정 env에도 O_KEY 없음",
		Object.values(A.loadUsers().accounts).every((acc) => !acc.env || !("O_KEY" in acc.env)));
	mkdirSync(join(DATA, "mig-corrupt"), { recursive: true });
	writeFileSync(join(DATA, "mig-corrupt", "env.json"), "{ 깨진 json");
	addUser("acct-mig-c", ["mig-corrupt"]);
	const n2 = E.migrateConversationEnvToAccounts();
	ok("E5 재이관 멱등 0 + 파싱 실패 소유 파일은 파기하지 않고 유지", n2 === 0 && existsSync(join(DATA, "mig-orphan", "env.json")) === true && existsSync(join(DATA, "mig-corrupt", "env.json")) === true);
}

// ═══════════════ F. 세션 코어 통합 — authorize.accountEnv → workspaceEnv 주입 (L2, 실 authorizer 연결) ═══════════════
{
	clearAccounts();
	addUser("acct-core", ["envcore-key", "envcore-key-2"], { FOO_TOKEN: "dummy-foo-1", BAR_KEY: "dummy-bar-2" });
	const backends: FakeBackend[] = [];
	const core = SC.createSessionCore({
		maxSessions: 2,
		scanOnBoot: false, // 부팅 스윕 옵트아웃 — 크로스 코어 오염 방지 (pool.test.ts 관례)
		authorize: A.createAuthorizer() as never, // 실 authorizer 전체 경로 — 쿠키 JWT → username → userKey 역색인 → 계정 env
		backendFactory: (opts: BackendOptions) => { const b = new FakeBackend(opts); backends.push(b); return b; },
	});
	const settle = () => sleep(60); // 실 authorizer(jwtVerify 비동기) 정착 대기 — setImmediate로는 부족 (V26 스케줄 실측)
	const token = await A.issueToken("acct-core");
	const ws1 = makeWs();
	core.handleConnection(ws1, { url: `/ws?u=${encodeURIComponent("envcore-key")}`, headers: { cookie: `turk_auth=${token}` } });
	await settle();
	const b1 = backends[0];
	ok("F1 startBackend가 opts.workspaceEnv로 계정 env 전달 — 쿠키 인증된 계정 소유 userKey 경로 · 값 단언",
		!!b1 && JSON.stringify(b1?.opts.workspaceEnv) === JSON.stringify({ FOO_TOKEN: "dummy-foo-1", BAR_KEY: "dummy-bar-2" })
		&& b1?.opts.cwd === SC.workspacePath("envcore-key"));
	const ws2 = makeWs();
	core.handleConnection(ws2, { url: `/ws?u=${encodeURIComponent("envcore-key-2")}`, headers: { cookie: `turk_auth=${token}` } });
	await settle();
	ok("F2 같은 계정 두 대화 — 동일 계정 env 공유 주입 (JSON 동등)",
		backends.length === 2 && JSON.stringify(backends[1]?.opts.workspaceEnv) === JSON.stringify(backends[0]?.opts.workspaceEnv));
	ok("F3 워크스페이스 AGENTS.md에 계정 env 이름 목록 — 값은 절대 미기록 · 계정 스코프 표기", (() => {
		const md = readFileSync(join(SC.workspacePath("envcore-key"), "AGENTS.md"), "utf8");
		return md.includes("## Account environment variables")
			&& md.includes("- FOO_TOKEN") && md.includes("- BAR_KEY")
			&& !md.includes("dummy-foo-1") && !md.includes("dummy-bar-2");
	})());
	const coreNoAuth = SC.createSessionCore({
		maxSessions: 2,
		scanOnBoot: false,
		backendFactory: (opts: BackendOptions) => { const b = new FakeBackend(opts); backends.push(b); return b; },
	}); // AUTH off core — authorize 미주입
	const ws3 = makeWs();
	coreNoAuth.handleConnection(ws3, { url: `/ws?u=${encodeURIComponent("envcore-anon")}` });
	ok("F4 AUTH off 코어 — workspaceEnv {} (무인증 경로는 env 없음 계약)",
		backends[2] && JSON.stringify(backends[2].opts.workspaceEnv) === "{}");
}

// ═══════════════ G. applyEnvSection — 마커 교체 · 불변 write 없음 · 마커 신규 추가 (L1) ═══════════════
{
	const dir = mkdtempSync(join(tmpdir(), "agentsmd-"));
	const f = join(dir, "AGENTS.md");
	writeFileSync(f, "# Header\n\n<!-- env:section -->\nOLD_KEY_ONE\n<!-- /env:section -->\n\ntail note\n");
	ok("G1 마커 사이 교체 — 이전 목록 소멸 · 정렬된 신규 이름 · 본문 보존", (() => {
		if (AMS.applyEnvSection(f, ["B_KEY", "A_KEY"]) !== true) return false;
		const c = readFileSync(f, "utf8");
		return !c.includes("OLD_KEY_ONE") && c.indexOf("- A_KEY") < c.indexOf("- B_KEY")
			&& c.includes("## Account environment variables")
			&& c.includes("# Header") && c.includes("tail note")
			&& c.split("<!-- env:section -->").length === 2 // 마커 쌍 유지 (중복 추가 없음)
			&& c.split("<!-- /env:section -->").length === 2;
	})());
	await sleep(25); // mtime 비교 전 대기 — 가상의 재기록이 mtime에 드러나도록
	const mtimeBefore = statSync(f).mtimeMs;
	AMS.applyEnvSection(f, ["A_KEY", "B_KEY"]); // 같은 집합 다른 순서 — 정렬로 동일 내용 → write 없음
	ok("G2 불변 write 없음 — mtime 보존 (pi의 AGENTS.md 감시 오동작 방지)", statSync(f).mtimeMs === mtimeBefore);
	writeFileSync(f, "커스텀 메모\n");
	ok("G3 마커 없는 문서(커스텀) — 말미 신규 추가", AMS.applyEnvSection(f, ["MY_TOKEN"]) === true
		&& (() => {
			const c = readFileSync(f, "utf8");
			return c.startsWith("커스텀 메모") && c.includes("- MY_TOKEN")
				&& c.lastIndexOf("<!-- /env:section -->") > c.lastIndexOf("<!-- env:section -->");
		})());
	ok("G4 0키 — '(none configured)' 섹션 유지 + 계약 문구 보존", (() => {
		if (AMS.applyEnvSection(f, []) !== true) return false;
		const c = readFileSync(f, "utf8");
		return c.includes("(none configured)") && c.includes("Values are never passed through chat.");
	})());
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} 통과`);
rmSync(TMP_DATA, { recursive: true, force: true }); // 임시 데이터 정리
process.exit(fail === 0 ? 0 : 1);