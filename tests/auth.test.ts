/**
 * tests/auth.test.ts — Phase 2 로그인/계정 단위테스트 (L1 순수 + L2 코어 통합)
 *
 * 구성: A 비밀번호·토큰 / B users 저장소 / C 소유권·레이트리밋·attemptLogin / D userKey 형식 / E 코어 통합(stub Authorizer)
 * 관례: pool.test.ts 복제 — 평문 tsx 스크립트 · ✅/❌ 출력 · 실패 시 exit 1
 *
 * 격리: auth.ts도 DATA_DIR을 모듈 로드 시 확정 (env-paths, XDG_DATA_HOME 따름) → 세션 코어와 동일하게
 * 모듈 로드 전 XDG 격리 + 동적 import. 시크릿 파일(auth-secret)은 코어 데이터 dir과 동일 곳에 생성됨 — 임시 dir라 정리로 제거.
 * 제약: 실시간 대기 없음 — 레이트리밋 만료는 now 주입(check/fail의 now 인자)으로 결정론 검증.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, mkdirSync } from "node:fs";
import envPaths from "env-paths";
import { SignJWT } from "jose";
import type { Backend, BackendOptions, TurkEvent } from "../backend.ts";

// ── 모듈 로드 전 데이터 경로 격리 (auth.ts·session-core.ts 둘 다 모듈 로드 시 DATA_DIR 확정) ──
const TMP_DATA = mkdtempSync(join(tmpdir(), "ai-turk-auth-"));
process.env.XDG_DATA_HOME = TMP_DATA;

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra?: string): void {
	if (cond) { pass++; console.log("✅", name); }
	else { fail++; console.log("❌", name, extra ?? ""); }
}

// ── 모듈 로드 — XDG 주입 후 동적 import ──
const A = await import("../auth.ts");
const SC = await import("../session-core.ts");
const DATA = envPaths("ai-turk").data; // 두 모듈의 DATA_DIR과 동일 규칙

// ── FakeBackend — Backend 인터페이스 구현 (pool.test.ts 동일 축약) ──
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
		this.emit({ type: "pi_ready", backend: this.kind() }); // PiBackend 근거 재현 — spawn 직후 동기 pi_ready emit
	}
	send(_cmd: Record<string, unknown>): void {}
	onEvent(cb: (ev: TurkEvent) => void): void { this.cb = cb; }
	stop(): void { this.stopping = true; this.aliveState = false; }
	alive(): boolean { return this.aliveState; }
	kind(): "pi" | "claude" { return "pi"; }
	emit(ev: TurkEvent): void { this.cb?.(ev); }
}

// ── WS 스텁 — handleConnection 등록 핸들러 직접 호출 (pool.test.ts 동일 축약) ──
function makeWs(): any {
	const handlers: Record<string, ((...args: any[]) => void)[]> = {};
	const sent: unknown[] = [];
	const ws: any = {
		OPEN: 1,
		readyState: 1,
		sent,
		handlers,
		send(raw: string) { sent.push(JSON.parse(raw)); },
		on(ev: string, cb: (...args: any[]) => void) { (handlers[ev] ??= []).push(cb); },
		close() {
			ws.readyState = 3;
			for (const cb of handlers.close ?? []) cb(1000, Buffer.from("client"));
		},
	};
	return ws;
}
const firstMsg = (ws: any) => ws.sent[0] as Record<string, any> | undefined;

// ═══════════════ A. 비밀번호·토큰 (L1 순수) ═══════════════
{
	const c = A.hashPassword("비밀1234!");
	ok("A1 비밀번호 해시/검증 왕복 — salt 16B hex·hash 64B hex",
		/^[0-9a-f]{32}$/.test(c.salt) && Buffer.from(c.hash, "hex").length === 64 && A.verifyPassword("비밀1234!", c) === true);
	ok("A2 오답 거부 — timingSafeEqual 비교", A.verifyPassword("틀린비밀", c) === false);
	ok("A2b salt 재사용 금지 — 두 해시 서로 다름 (같은 비번)", (() => {
		const c2 = A.hashPassword("비밀1234!");
		return c2.salt !== c.salt && c2.hash !== c.hash && A.verifyPassword("비밀1234!", c2);
	})());
}
{
	const token = await A.issueToken("alice");
	ok("A3 토큰 발급/검증 왕복 — sub 복원", (await A.verifyToken(token)) === "alice");
	ok("A3b 토큰 형식 — 3세그먼트 HS256 JWT", token.split(".").length === 3);
	// 만료 토큰 — 같은 시크릿(auth-secret 파일 판독)으로 과거 exp 서명
	const secret = new Uint8Array(Buffer.from(readFileSync(join(DATA, "auth-secret"), "utf8").trim(), "base64"));
	const expiredToken = await new SignJWT({})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject("alice")
		.setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
		.setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
		.sign(secret);
	ok("A4 만료 토큰 거부 (exp 과거)", (await A.verifyToken(expiredToken)) === null);
	const parts = token.split(".");
	parts[1] = parts[1].replace(/^./, parts[1][0] === "e" ? "f" : "e"); // payload 첫 바이트 교체 (base64url 상 유효)
	const tampered = parts.join(".");
	ok("A5 변조 토큰 거부 (서명 불일치) + 원본은 유효", tampered !== token && (await A.verifyToken(tampered)) === null && (await A.verifyToken(token)) === "alice");
}

// ═══════════════ B. users.json 저장소 (L1 순수) ═══════════════
{
	const cred = A.hashPassword("pw-bob");
	A.saveUsers({ accounts: { bob: { ...cred, userKeys: ["bob-1"], createdAt: 123 } } });
	const loaded = A.loadUsers();
	ok("B6 users 저장/로드 왕복 — 스키마 유지 + users.json·auth-secret 0o600",
		loaded.accounts.bob?.userKeys[0] === "bob-1" && loaded.accounts.bob?.createdAt === 123
		&& (statSync(join(DATA, "users.json")).mode & 0o777) === 0o600
		&& (statSync(join(DATA, "auth-secret")).mode & 0o777) === 0o600);
	writeFileSync(join(DATA, "users.json"), "{ 깨진 json");
	ok("B6b 손상 users.json → {} 시작 (미존재·손상 동일 방어)", Object.keys(A.loadUsers().accounts).length === 0);
}

// ═══════════════ C. 소유권·레이트리밋·attemptLogin (L1 순수) ═══════════════
{
	const alicePw = A.hashPassword("alice-pw");
	const bobPw = A.hashPassword("bob-pw");
	A.saveUsers({
		accounts: {
			alice: { ...alicePw, userKeys: ["a-key"], createdAt: 1 },
			bob: { ...bobPw, userKeys: ["b-key"], createdAt: 2 },
		},
	});
	ok("C7 소유권 판정 — own/orphan/foreign",
		A.checkConversation("alice", "a-key") === "own"
		&& A.checkConversation("alice", "b-key") === "foreign"
		&& A.checkConversation("bob", "b-key") === "own"
		&& A.checkConversation("alice", "ghost-key") === "orphan");
	ok("C8 claim orphan → own + 저장 영속", A.claimConversation("alice", "c-key") === true && A.checkConversation("alice", "c-key") === "own" && A.ownedKeysOf("alice").includes("c-key"));
	ok("C8b foreign claim 거부 + 소유 불변", A.claimConversation("alice", "b-key") === false && A.checkConversation("bob", "b-key") === "own" && A.checkConversation("alice", "b-key") === "foreign");
	// 레이트리밋 — windowMs·maxFails 주입 + now 주입 (실시간 대기 0)
	const t0 = 1_000_000;
	const rl = new A.RateLimiter(100, 3);
	ok("C9 레이트리밋 — 한계 미만 허용", rl.check("ip1", t0) === true);
	rl.fail("ip1", t0); rl.fail("ip1", t0); rl.fail("ip1", t0);
	ok("C9b 한계(3회) 도달 → 차단", rl.check("ip1", t0 + 1) === false);
	ok("C9c 만료 후 해제", rl.check("ip1", t0 + 101) === true);
	const rl3 = new A.RateLimiter(100, 2);
	rl3.fail("old", t0); // 만료 예정
	rl3.fail("live", t0 + 90); // 윈도 유효
	rl3.fail("live", t0 + 90); // 한계 도달 예정 — 2회
	ok("C9d 만료 항목 정리 — 만료만 제거·유효 것 보존",
		rl3.cleanup(t0 + 150) === 1 && rl3.check("old", t0 + 150) === true && rl3.check("live", t0 + 150) === false);
}
{
	// attemptLogin — C 블록의 users.json (alice/bob) 그대로 사용
	const r = await A.attemptLogin("alice", "alice-pw", "ip-ok");
	ok("C10 attemptLogin 성공 — setCookie(turk_auth·보안속성)+토큰 유효", await (async () => {
		if (!r.ok) return false;
		const cookie = A.parseCookieHeader(r.setCookie);
		return r.setCookie.includes("turk_auth=") && r.setCookie.includes("HttpOnly")
			&& r.setCookie.includes("SameSite=Lax") && r.setCookie.includes("Path=/") && r.setCookie.includes("Max-Age=2592000")
			&& (await A.verifyToken(cookie["turk_auth"])) === "alice";
	})());
	const unknown = await A.attemptLogin("ghost-user-xyz", "x", "ip-u1");
	const wrong = await A.attemptLogin("alice", "wrong-pw", "ip-u2");
	ok("C11 미지 사용자 vs 오답 — 동일 문구 (사용자 열거 방지)", !unknown.ok && !wrong.ok && unknown.error === wrong.error && wrong.error.includes("올바르지 않습니다"));
	let limited = false;
	for (let i = 0; i < 11; i++) {
		const r2 = await A.attemptLogin("ghost-user-xyz", "x", "ip-burst");
		if (!r2.ok && r2.rateLimited) { limited = i >= 10; break; } // 10회 실패 뒤 11번째 시도부터 차단
	}
	ok("C11b 실패 10회 초과 → rateLimited (서버 429 신호)", limited);
	// 로그아웃 쿠키 — Max-Age=0 클리어
	ok("C11c logout 쿠키 — Max-Age=0 즉시 만료", A.clearCookie().includes("Max-Age=0") && A.clearCookie().includes("HttpOnly"));
}

// ═══════════════ D. userKey 형식 검증 (L1 순수) ═══════════════
{
	ok("D12 userKey 형식 — 경로조작·제어문자·빈값 거부",
		A.verifyUserKeyFormat("../x") === false && A.verifyUserKeyFormat("a/b") === false && A.verifyUserKeyFormat("a\\b") === false
		&& A.verifyUserKeyFormat("..") === false && A.verifyUserKeyFormat("bad\nkey") === false && A.verifyUserKeyFormat("") === false);
	ok("D12b 통과 — 한글·UUID·하이픈·점 1개",
		A.verifyUserKeyFormat("주식") === true && A.verifyUserKeyFormat("550e8400-e29b-41d4-a716-446655440000") === true
		&& A.verifyUserKeyFormat("mom") === true && A.verifyUserKeyFormat("k-0.5") === true);
	ok("D12c 길이 상한 100 (101 거부·100 통과)", A.verifyUserKeyFormat("x".repeat(101)) === false && A.verifyUserKeyFormat("x".repeat(100)) === true);
}

// ═══════════════ E. 코어 통합 — stub Authorizer 주입 (L2 코어 통합) ═══════════════
{
	interface StubAuth {
		authorizeRequest(req: { headers?: Record<string, string | string[] | undefined> }): Promise<string | null>;
		checkConversation(username: string, userKey: string): "own" | "orphan" | "foreign";
		claimConversation(username: string, userKey: string): boolean;
		listOwnedKeys(username: string): string[];
	}
	// alice만 사용자 — own-key는 원래 소유, orphan-key는 무주(claim 대상), foreign-key는 남의 소유 시뮬레이션
	const owned = new Set<string>(["own-key"]);
	const foreignOwners = new Set<string>(["foreign-key"]);
	const claims: string[] = [];
	const stub: StubAuth = {
		authorizeRequest: async (req) => (req?.headers?.cookie === "turk_auth=tok-alice" ? "alice" : null),
		checkConversation: (_username, userKey) => {
			if (owned.has(userKey)) return "own";
			if (foreignOwners.has(userKey)) return "foreign";
			return "orphan";
		},
		claimConversation: (username, userKey) => { claims.push(`${username}/${userKey}`); owned.add(userKey); return true; },
		listOwnedKeys: (username) => (username === "alice" ? [...owned] : []),
	};
	function newCore(auth?: StubAuth) {
		const backends: FakeBackend[] = [];
		const core = SC.createSessionCore({
			maxSessions: 5,
			scanOnBoot: false,
			authorize: auth as never, // stub — CoreAuthorizer 구조 일치
			backendFactory: (o: BackendOptions) => { const b = new FakeBackend(o); backends.push(b); return b; },
		});
		return { core, backends };
	}
	const E = newCore(stub);
	const settle = () => new Promise<void>((r) => setImmediate(r)); // 인증 게이트 microtask 정착 대기 (테스트 동기 단정 방지)
	const wsOwn = makeWs();
	E.core.handleConnection(wsOwn, { url: "/ws?u=own-key", headers: { cookie: "turk_auth=tok-alice" } });
	await settle();
	ok("E13 own 진입 — 백엔드 할당·pi_ready 통지", firstMsg(wsOwn)?.type === "pi_ready" && (wsOwn as any).readyState === 1 && E.core.sessions.has("own-key"));
	const wsOrphan = makeWs();
	E.core.handleConnection(wsOrphan, { url: "/ws?u=orphan-key", headers: { cookie: "turk_auth=tok-alice" } });
	await settle();
	ok("E13b orphan → 자동 claim 후 진입", claims.includes("alice/orphan-key") && firstMsg(wsOrphan)?.type === "pi_ready" && owned.has("orphan-key"));
	const wsForeign = makeWs();
	E.core.handleConnection(wsForeign, { url: "/ws?u=foreign-key", headers: { cookie: "turk_auth=tok-alice" } });
	await settle();
	ok("E13c foreign → session_error(권한 없음)+close · claim 미호출",
		firstMsg(wsForeign)?.type === "session_error" && String(firstMsg(wsForeign)?.error).includes("권한 없음")
		&& (wsForeign as any).readyState === 3 && !claims.some((c) => c.includes("foreign-key")));
	ok("E13d listConversations(username) — own만 필터 (orphan·foreign 제외)",
		JSON.stringify(E.core.listConversations("alice").map((c: { id: string }) => c.id).sort()) === JSON.stringify(["orphan-key", "own-key"]));
	ok("E13e listConversations() — username 미지정 시 전체 (기존 동작)",
		E.core.listConversations().length === 3);
	const wsNone = makeWs();
	E.core.handleConnection(wsNone, { url: "/ws?u=own-key", headers: {} }); // 쿠키 없음
	await settle();
	ok("E14 미인증(쿠키 없음) → session_error(로그인 필요)+close",
		firstMsg(wsNone)?.type === "session_error" && String(firstMsg(wsNone)?.error).includes("로그인") && (wsNone as any).readyState === 3);
	// authorize 없는 코어 — 형식 검증은 항상 적용 (경로조작 차단) + 정상 키는 기존 무인증 동작 유지
	const F = newCore();
	const wsBad = makeWs();
	F.core.handleConnection(wsBad, { url: "/ws?u=..%2Fescape" }); // ../escape
	ok("E15 authorize 없어도 형식 검증 항상 — session_error+close·세션 미생성",
		firstMsg(wsBad)?.type === "session_error" && String(firstMsg(wsBad)?.error).includes("형식")
		&& (wsBad as any).readyState === 3 && !F.core.sessions.has("../escape"));
	const wsPlain = makeWs();
	F.core.handleConnection(wsPlain, { url: "/ws?u=f-normal" });
	ok("E15b 무인증 코어 정상 키 — pi_ready (기존 동작 회귀 없음)", firstMsg(wsPlain)?.type === "pi_ready" && F.core.sessions.has("f-normal"));
}

// ═══════════════ F. 비밀번호 변경 (Phase 3 — C 블록의 users.json 유지: alice·bob) ═══════════════
{
	ok("F16 changePassword 현재 비번 오답 거부 — false · 자격 불변",
		(() => {
			const before = A.loadUsers().accounts.alice;
			const r = A.changePassword("alice", "틀린비밀", "새비번1234");
			const after = A.loadUsers().accounts.alice;
			return r === false && before.hash === after.hash && before.salt === after.salt;
		})());
	ok("F17 changePassword 성공 — 새 비번 로그인 가능 · 구 비번 불가",
		(await (async () => {
			if (A.changePassword("alice", "alice-pw", "new-pw-1234") !== true) return false;
			const reLogin = await A.attemptLogin("alice", "new-pw-1234", "ip-f1");
			const oldLogin = await A.attemptLogin("alice", "alice-pw", "ip-f2");
			return reLogin.ok === true && !oldLogin.ok;
		})()));
	ok("F18 changePassword next 4자 미만 거부 — false · 자격 불변",
		(() => {
			const before = A.loadUsers().accounts.alice;
			return A.changePassword("alice", "new-pw-1234", "ab") === false
				&& A.changePassword("alice", "new-pw-1234", "") === false
				&& A.loadUsers().accounts.alice.hash === before.hash && A.loadUsers().accounts.alice.salt === before.salt;
		})());
	ok("F18b 미존재 계정 거부 — false (userKeys·스키마 불변)",
		A.changePassword("ghost-user-xyz", "x", "abcd") === false
			&& A.ownedKeysOf("alice").includes("a-key")); // 자격 교체 사이드이펙트 없음
}

// ╔══════════════ G. 잔여키 정리 (Phase 4a — release·reconcile) ═══════════════
// dir 준비 — reconcile은 DATA_DIR/<키> 디렉토리 존재 여부만 판정. 고아 dir(g-orphan)은 어느 계정에도 귀속시키지 않는다.
{
	mkdirSync(join(DATA, "g-live-a"), { recursive: true });
	mkdirSync(join(DATA, "g-live-b"), { recursive: true });
	mkdirSync(join(DATA, "g-orphan"), { recursive: true }); // 소유자 없는 dir — dir 무사·무소권 입증 대상
	A.saveUsers({
		accounts: {
			alice: { ...A.hashPassword("g-alice-pw"), userKeys: ["g-live-a", "g-dead-a"], createdAt: 10 }, // g-dead-a = dir 없음
			bob: { ...A.hashPassword("g-bob-pw"), userKeys: ["g-live-b", "g-dead-b", "g-b-temp"], createdAt: 20 }, // g-dead-b = dir 없음
		},
	});

	// release — 소유 키 제거·저장 반영
	ok("G19 release 소유 키 — userKeys 제거·저장 반영·타 키 보존",
		(() => {
			if (A.releaseConversation("bob", "g-b-temp") !== true) return false;
			const keys = A.loadUsers().accounts.bob?.userKeys ?? [];
			return !keys.includes("g-b-temp") && keys.includes("g-live-b") && keys.includes("g-dead-b");
		})());
	// release 멱등 — 이미 없는 키도 true (재호출·삭제된 대화 재시도 안전)
	ok("G20 release 멱등 — 키 없어도 true·장부 불변 (재저장 없음)",
		(() => {
			const before = JSON.stringify(A.loadUsers().accounts.bob);
			return A.releaseConversation("bob", "g-b-temp") === true && JSON.stringify(A.loadUsers().accounts.bob) === before;
		})());
	// release 미존재 계정 — false
	ok("G21 release 미존재 계정 — false", A.releaseConversation("ghost-user-xyz", "g-live-a") === false);

	// reconcile — dir 없는 키만 탈락·dir 있는 소유 유지
	ok("G22 reconcile — dir 없는 키만 탈락·dir 있는 소유 유지",
		(() => {
			const dropped = A.reconcileUsersWithDisk();
			const loaded = A.loadUsers();
			return dropped === 2 // dir 없음 = g-dead-a·g-dead-b 뿐 (반환값 = 탈락 수)
				&& JSON.stringify(loaded.accounts.alice?.userKeys) === JSON.stringify(["g-live-a"])
				&& JSON.stringify(loaded.accounts.bob?.userKeys) === JSON.stringify(["g-live-b"]);
		})());
	ok("G22b reconcile 멱등 — 재호출 탈락 0 (변경 없어 재저장 없음)", A.reconcileUsersWithDisk() === 0);

	// 고아 dir — 소유자 생기지 않고 dir 무사 (단방향 장부 위생 계약)
	ok("G23 고아 dir — reconcile이 dir을 건드리지 않음·무소권 유지",
		statSync(join(DATA, "g-orphan")).isDirectory() // dir 삭제·변형 없음
		&& A.checkConversation("alice", "g-orphan") === "orphan" && A.checkConversation("bob", "g-orphan") === "orphan"); // 어떤 계정에도 귀속 안 됨

	// 회귀 입증 — A claim → release → B 관점 orphan (foreign 오판 차단 결함 해소) → B claim 성공
	ok("G24 회귀 — claim→release 후 타 계정 관점 orphan → 고아 자동클레임 경로 회복",
		await (async () => {
			if (A.claimConversation("alice", "g-handover") !== true) return false;
			if (A.checkConversation("bob", "g-handover") !== "foreign") return false; // 전제: release 전에는 foreign 차단 (결함 상황 재현)
			if (A.releaseConversation("alice", "g-handover") !== true) return false;
			if (A.checkConversation("bob", "g-handover") !== "orphan") return false; // 결함 해소 — foreign 오판 소실
			if (A.claimConversation("bob", "g-handover") !== true) return false; // B 자동 claim 성공
			return A.checkConversation("bob", "g-handover") === "own";
		})());
}

console.log(`\n${pass}/${pass + fail} 통과`);
rmSync(TMP_DATA, { recursive: true, force: true }); // 임시 데이터 정리
process.exit(fail === 0 ? 0 : 1);