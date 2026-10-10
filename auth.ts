/**
 * AI Turk 인증 모듈 (Phase 2) — 순수 로직 (HTTP·WS 배선 없음; server.ts가 조립)
 *
 * 구성:
 *  - users.json 계정 저장소 — scrypt 비밀번호(salt+hash) · 계정별 소유 userKeys · 쓰기 후 chmod 0o600
 *  - jose JWT (HS256, 30일) — 시크릿은 DATA_DIR/auth-secret base64 저장 (VAPID 영속화 패턴)
 *  - turk_auth 쿠키 — HttpOnly·Secure·SameSite=Lax (토큰은 응답 JSON에 노출 금지 — Set-Cookie로만)
 *  - per-IP 레이트리밋 — 실패 10회/15분 초과 차단 (windowMs·maxFails 주입 가능)
 *  - attemptLogin — 미지 사용자·비밀번호 오류 동일 문구 (사용자 열거 방지)
 *  - 대화 소유권 — own/orphan/foreign 판정 · orphan 자동 claim (레거시 마이그레이션 계약)
 *  - 잔여키 정리 (Phase 4a) — releaseConversation(삭제 시 소유 해제) · reconcileUsersWithDisk(부팅 소급 대사)
 *  - createAuthorizer — session-core에 주입할 계약 객체 (core는 auth 타입을 import하지 않고 구조 일치만)
 *
 * 제약: DATA_DIR은 모듈 로드 시 확정 (env-paths, XDG_DATA_HOME 따름) → 테스트는 XDG 격리 후 동적 import.
 * 시크릿·토큰·해시 값을 로그에 출력하지 않는다.
 */

import { SignJWT, jwtVerify } from "jose";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";

const DATA_DIR = envPaths("ai-turk").data;

// ── 계정 저장소 (users.json) ────────────────────────────────────────────
// 스키마: { "accounts": { [username]: { salt, hash, userKeys, env?, createdAt } } }
export interface UserAccount {
	salt: string; // hex — randomBytes(16)
	hash: string; // hex — scryptSync 64바이트
	userKeys: string[]; // 소유 대화(userKey) 목록 — 레지스트리 계정 경계
	env?: Record<string, string>; // 계정별 환경변수 (4c-refit) — 키의 주인 = 사람 = 계정. env-store.ts가 관리자,
	// 이 필드의 값은 이 모듈 accountEnv(userKey) 주입 경로로만 읽힌다 (응답·로그·목록 어디에도 값 미반환)
	createdAt: number;
}
export interface UsersFile {
	accounts: Record<string, UserAccount>;
}

function usersPath(): string {
	return join(DATA_DIR, "users.json");
}

export function emptyUsers(): UsersFile {
	return { accounts: {} };
}

/** 미존재·스키마 손상은 전부 {}로 시작 (방어적 로드). */
export function loadUsers(): UsersFile {
	try {
		const parsed = JSON.parse(readFileSync(usersPath(), "utf8"));
		if (parsed && typeof parsed === "object" && parsed.accounts && typeof parsed.accounts === "object") return parsed as UsersFile;
		return emptyUsers();
	} catch {
		return emptyUsers();
	}
}

/** 저장 — 디렉터리 보장 + 0o600 (계정 데이터 비공개). */
export function saveUsers(users: UsersFile): void {
	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(usersPath(), JSON.stringify(users));
	chmodSync(usersPath(), 0o600);
}

// ── scrypt 비밀번호 (node:crypto) ──────────────────────────────────────
export function hashPassword(pw: string): { salt: string; hash: string } {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(pw, salt, 64).toString("hex");
	return { salt, hash };
}

/** timingSafeEqual 비교 — 길이 상이·형식 파손·자격 누락은 전부 false. */
export function verifyPassword(pw: string, cred: { salt: string; hash: string }): boolean {
	try {
		const stored = Buffer.from(cred.hash, "hex");
		const computed = scryptSync(pw, cred.salt, 64);
		return stored.length === computed.length && timingSafeEqual(stored, computed);
	} catch {
		return false;
	}
}

// ── JWT (jose) — 시크릿 파일 영속화: 잃으면 기존 토큰 전부 무효(강제 로그아웃)이므로 VAPID처럼 보존 ──
const SECRET_FILE = join(DATA_DIR, "auth-secret");
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30일 — 쿠키 Max-Age와 동기

function loadOrCreateSecret(): Uint8Array {
	try {
		const b64 = readFileSync(SECRET_FILE, "utf8").trim();
		if (b64) return new Uint8Array(Buffer.from(b64, "base64"));
	} catch { /* 없음 → 신규 생성 */ }
	const secret = randomBytes(32);
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(SECRET_FILE, secret.toString("base64"));
		chmodSync(SECRET_FILE, 0o600);
	} catch { /* 디스크 실패 — 메모리 키로 계속 (재시작마다 강제 로그아웃) */ }
	return new Uint8Array(secret);
}
const JWT_SECRET = loadOrCreateSecret(); // 모듈 로드 1회 — 테스트는 XDG 격리로 겁리

/** HS256 · {sub: username, iat, exp: now+30d}. */
export async function issueToken(username: string): Promise<string> {
	return new SignJWT({})
		.setProtectedHeader({ alg: "HS256" })
		.setSubject(username)
		.setIssuedAt()
		.setExpirationTime(Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS)
		.sign(JWT_SECRET);
}

/** 검증 실패(만료·변조·서명 불일치·형식 파손) 전부 null. */
export async function verifyToken(token: string): Promise<string | null> {
	try {
		const { payload } = await jwtVerify(token, JWT_SECRET);
		return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
	} catch {
		return null;
	}
}

// ── 쿠키 — 이름 turk_auth 고정 ──────────────────────────────────────────
export const AUTH_COOKIE_NAME = "turk_auth";

/** Set-Cookie 값 (로그인 성공) — HttpOnly·Secure·SameSite=Lax·Path=/ · Max-Age=30일. */
export function issueCookie(token: string): string {
	return `${AUTH_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${TOKEN_TTL_SECONDS}`;
}

/** Set-Cookie 값 (로그아웃 — 즉시 만료 클리어). */
export function clearCookie(): string {
	return `${AUTH_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** 쿠키 헤더 파싱 — "a=1; b=2" → {a,b}. JWT는 base64url(=;/% 미포함)이라 디코드 없이 원값 사용 안전. */
export function parseCookieHeader(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const name = part.slice(0, idx).trim();
		if (name) out[name] = part.slice(idx + 1).trim();
	}
	return out;
}

// ── 레이트리밋 — per-IP 실패 카운트 (실패 10회/15분 초과 시 차단) ──────────
export interface RateEntry {
	count: number;
	resetAt: number;
}

export class RateLimiter {
	readonly windowMs: number;
	readonly maxFails: number;
	private map = new Map<string, RateEntry>();
	constructor(windowMs: number = 15 * 60_000, maxFails: number = 10) {
		this.windowMs = windowMs; // 테스트 주입용
		this.maxFails = maxFails;
	}
	/** 허용 여부 — 윈도 내 실패 한계 도달 시 false. 만료 항목은 이 시점 정리. */
	check(ip: string, now: number = Date.now()): boolean {
		const e = this.map.get(ip);
		if (!e) return true;
		if (now >= e.resetAt) {
			this.map.delete(ip);
			return true;
		}
		return e.count < this.maxFails;
	}
	/** 실패 기록 — 첫 실패가 윈도 시작점. 만료된 기존 항목은 리셋. */
	fail(ip: string, now: number = Date.now()): RateEntry {
		const e = this.map.get(ip);
		if (!e || now >= e.resetAt) {
			const fresh: RateEntry = { count: 1, resetAt: now + this.windowMs };
			this.map.set(ip, fresh);
			return fresh;
		}
		e.count++;
		return e;
	}
	/** 만료 항목 일괄 정리 — 제거 수 반환 (메모리 과성장 방지·테스트 관측용). */
	cleanup(now: number = Date.now()): number {
		let removed = 0;
		for (const [ip, e] of this.map) {
			if (now >= e.resetAt) {
				this.map.delete(ip);
				removed++;
			}
		}
		return removed;
	}
}

// ── 로그인 시도 — 서버 라우트의 단일 진원 ────────────────────────────────
// 미지 사용자·비밀번호 오류 = 동일 문구 (사용자 열거 방지 — 존재 여부가 응답 시간·문구로 새어나가지 않게)
export const LOGIN_ERROR_MESSAGE = "아이디 또는 비밀번호가 올바르지 않습니다";
export const RATE_LIMIT_MESSAGE = "로그인 시도 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요";

export type LoginAttempt =
	| { ok: true; username: string; setCookie: string }
	| { ok: false; error: string; rateLimited?: boolean };

const loginLimiter = new RateLimiter(); // 기본 정책 — 10회/15분
const DUMMY_CRED = hashPassword("turk-timing-dummy"); // 타이밍 균등화용 더미 자격 — 모듈 로드 1회

/**
 * 레이트리밋 → 계정 조회·검증 → 성공: {ok, username, setCookie} / 실패: {ok:false, error}.
 * 실패는 fail(ip) 카운트 — 성공은 카운트를 건드리지 않는다 (윈도가 성공 시 초기화되면 무차별 대입에 실패 예산을 되돌려주는 틈이 됨).
 */
export async function attemptLogin(username: string, password: string, ip: string, now: number = Date.now()): Promise<LoginAttempt> {
	if (!loginLimiter.check(ip, now)) {
		return { ok: false, rateLimited: true, error: RATE_LIMIT_MESSAGE };
	}
	const acc: UserAccount | undefined = loadUsers().accounts[username];
	if (!acc) {
		verifyPassword(password, DUMMY_CRED); // 타이밍 균등화 — scrypt 비용을 미지 사용자에도 지불 (시간 차 계정 유출 방지)
		loginLimiter.fail(ip, now);
		return { ok: false, error: LOGIN_ERROR_MESSAGE };
	}
	if (!verifyPassword(password, acc)) {
		loginLimiter.fail(ip, now);
		return { ok: false, error: LOGIN_ERROR_MESSAGE };
	}
	const token = await issueToken(username);
	return { ok: true, username, setCookie: issueCookie(token) };
}

// ── 비밀번호 변경 (Phase 3) — 드로어 계정 섹션의 POST /api/passwd 단일 진원 ──
// 계정 미존재·현재 비번 불일치·next 길이 4 미만 → false. 성공 시 hashPassword(next)로 교체·저장.
// 오류 문구 구분(현재 비번 오답 vs 길이 규칙)은 server.ts 라우트가 담당(라우트가 next 길이를 먼저 검사) —
// 본 함수는 불리언만 반환 (attemptLogin과 달리 열거 방지 대상이 아님: 호출자는 이미 인증된 본인).
export function changePassword(username: string, current: string, next: string): boolean {
	const users = loadUsers();
	const acc: UserAccount | undefined = users.accounts[username];
	if (!acc) return false;
	if (!verifyPassword(current, acc)) return false; // scrypt 선검증 — 비일관 타이밍 최소화 (성공 경로와 비용 유사)
	if (!next || next.length < 4) return false;
	Object.assign(acc, hashPassword(next)); // salt·hash 교체 — userKeys·createdAt 보존
	saveUsers(users);
	return true;
}

// ── 대화 소유권 — 계정 경계 (userKey ↔ 계정 userKeys) ─────────────────────
export type Ownership = "own" | "orphan" | "foreign";

/** orphan = 어느 계정에도 없는 무주고아 (레거시·신규 대화). */
export function checkConversation(username: string, userKey: string): Ownership {
	for (const [name, acc] of Object.entries(loadUsers().accounts)) {
		if (Array.isArray(acc.userKeys) && acc.userKeys.includes(userKey)) return name === username ? "own" : "foreign";
	}
	return "orphan";
}

/** orphan → 해당 계정 userKeys에 추가·저장 (멱등). foreign·계정 미존재는 거부(false). */
export function claimConversation(username: string, userKey: string): boolean {
	const users = loadUsers();
	const acc: UserAccount | undefined = users.accounts[username];
	if (!acc) return false;
	for (const [name, a] of Object.entries(users.accounts)) {
		if (name !== username && Array.isArray(a.userKeys) && a.userKeys.includes(userKey)) return false; // 남의 소유 방어
	}
	if (!Array.isArray(acc.userKeys)) acc.userKeys = [];
	if (!acc.userKeys.includes(userKey)) {
		acc.userKeys.push(userKey);
		saveUsers(users);
	}
	return true; // 이미 자기 소유 = 멱등 성공
}

/** 계정 소유 userKeys — listConversations(username) own-필터용 (users.json 단일 판독). */
export function ownedKeysOf(username: string): string[] {
	const acc: UserAccount | undefined = loadUsers().accounts[username];
	return acc && Array.isArray(acc.userKeys) ? acc.userKeys : [];
}

/** 소유 등록 해제 (Phase 4a) — 대화 삭제 직후 장부 잔여키 방지 (server.ts DELETE 라우트 배선).
 * 계정 미존재 → false. 키가 userKeys에 있으면 제거·저장·true, 없으면 true (멱등 — 이미 정리됨·드로어 재시도 안전).
 * 이 해제가 없으면 삭제된 대화의 키가 장부에 잔류해 타 계정 재접속 시 checkConversation이 foreign으로 오판 —
 * 고아 자동클레임 경로가 막히는 결함의 원천 차단. fs를 만지지 않으므로 userKey 형식 검증 불필요 (경로조작 무해). */
export function releaseConversation(username: string, userKey: string): boolean {
	const users = loadUsers();
	const acc: UserAccount | undefined = users.accounts[username];
	if (!acc) return false;
	if (Array.isArray(acc.userKeys) && acc.userKeys.includes(userKey)) {
		acc.userKeys = acc.userKeys.filter((k) => k !== userKey);
		saveUsers(users);
	}
	return true;
}

/** 장부-디스크 대사 (Phase 4a 부팅 배선) — 삭제된 대화의 잔여 소유 등록 소급 정리.
 * 단방향 장부 위생 계약: dir은 절대 건드리지 않는다 — dir(`DATA_DIR/<키>`) 없는 키만 장부에서 탈락, 변경시 저장.
 * 소유자 없는 dir(고아)은 소유 없음 그대로 — 어떤 계정에도 귀속시키지 않고, 지우지도 않는다 (고아 자동클레임 경로 보존).
 * 형식 위반 키(`../` 등)는 core가 dir 조합을 금지하므로 dir 없음과 동일 취급 — 탈락 (장부 데이터 경로조작 방어).
 * 반환 = 탈락 키 수 (변경 없으면 0·저장 생략 → 재호출 멱등). */
export function reconcileUsersWithDisk(): number {
	const users = loadUsers();
	let dropped = 0;
	for (const acc of Object.values(users.accounts)) {
		if (!Array.isArray(acc.userKeys) || acc.userKeys.length === 0) continue;
		const kept: string[] = [];
		for (const key of acc.userKeys) {
			let dirExists = false;
			if (verifyUserKeyFormat(key)) {
				try { dirExists = statSync(join(DATA_DIR, key)).isDirectory(); } catch { dirExists = false; } // 미존재·파일이 놓인 경우도 dir 없음
			}
			if (dirExists) kept.push(key);
			else dropped++;
		}
		if (kept.length !== acc.userKeys.length) acc.userKeys = kept;
	}
	if (dropped > 0) saveUsers(users);
	return dropped;
}

// ── 세션 코어 주입 계약 — session-core는 로컬(CoreAuthorizer) 인터페이스로 구조 일치만 요구 ──
export interface AuthorizerRequest {
	url?: string; // ws 핸드셰이크 req(IncomingMessage)는 url·headers 보유
	headers?: Record<string, string | string[] | undefined>;
}
export interface Authorizer {
	authorizeRequest(req: AuthorizerRequest): Promise<string | null>;
	checkConversation(username: string, userKey: string): Ownership;
	claimConversation(username: string, userKey: string): boolean;
	releaseConversation(username: string, userKey: string): boolean; // Phase 4a — 소유 해제 (server.ts DELETE 라우트가 소비 — 소유권 판정·claim·해제 삼형제 완결)
	listOwnedKeys(username: string): string[];
	/** 4c-refit — userKey 소유 계정의 env (세션 코어에게 주입 전용). 미소유·고아 → {} — 값은 백엔드 spawn 프로세스 환경으로만 흐른다. */
	accountEnv(userKey: string): Record<string, string>;
}

/** userKey의 소유자 계정 username | null (users.json 1회 판독 역색인) — env-store 마이그레이션·accountEnv 공용 진원. */
export function ownerOfUserKey(userKey: string): string | null {
	for (const [name, acc] of Object.entries(loadUsers().accounts)) {
		if (Array.isArray(acc.userKeys) && acc.userKeys.includes(userKey)) return name;
	}
	return null; // 미소유·고아
}

/** 4c-refit — userKey 소유 계정의 환경변수 (세션 코어 주입 경로 유일). users.json 1회 판독으로 유저 역색인 후
 *  acc.env를 문자열-방어 복사로 반환. 미소유·고아·계정 미보유 → {}. 값은 createBackend spawn 프로세스 환경으로만
 *  흐른다 — 응답·목록·로그 어디에도 미출력 (env-store 이름-반환 계약과 짝). 여기서 env-store을 import하지 않는다
 *  (auth↔env-store 순환 방지 — 방어 복사 4줄의 이중 구현이 순환보다 싸다). */
function accountEnvOf(userKey: string): Record<string, string> {
	const owner = ownerOfUserKey(userKey);
	if (!owner) return {};
	const env = loadUsers().accounts[owner]?.env;
	if (!env || typeof env !== "object") return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(env)) {
		if (typeof v === "string") out[k] = v; // 문자열 쌍만 — 타입 오염 방어 (hand-edit 포함)
	}
	return out;
}

/** 쿠키(turk_auth) → JWT 검증 → username | null. 쿠키 헤더 없으면 null (검증 오류도 null). */
export function createAuthorizer(): Authorizer {
	return {
		authorizeRequest(req) {
			const raw = req?.headers?.cookie;
			const header = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
			if (!header) return Promise.resolve(null);
			const token = parseCookieHeader(header)[AUTH_COOKIE_NAME];
			if (!token) return Promise.resolve(null);
			return verifyToken(token);
		},
		checkConversation,
		claimConversation,
		releaseConversation,
		listOwnedKeys: ownedKeysOf,
		accountEnv: accountEnvOf,
	};
}

// ── userKey 형식 검증 — userKey가 DATA_DIR 경로 조합에 직접 쓰이므로 경로조작 차단 ──
// session-core.ts에 동일 규칙 쌍둥이 존재 (무인증 경로에도 항상 적용되도록 코어 로컬 복제 —
// auth import이 만드는 모듈 부작용(시크릿 생성)을 core가 떠안지 않게). 규칙 변경 시 쌍둥이 동시 수정.
export function verifyUserKeyFormat(key: string): boolean {
	if (!key || key.length > 100) return false;
	if (key.includes("/") || key.includes("\\") || key.includes("..")) return false;
	for (const ch of key) {
		const c = ch.charCodeAt(0);
		if (c < 0x20 || c === 0x7f) return false; // 제어문자 — 한글·UUID·하이픈은 통과
	}
	return true;
}