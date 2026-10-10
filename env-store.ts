/**
 * env-store.ts — 계정별 환경변수 저장소 (Phase 4c-refit)
 *
 * 단일 책임: users.json 안의 계정 env 필드(UserAccount.env)와 구 대화 env.json의 마이그레이션.
 * 키의 주인 = 사람 = 계정 — 계정의 모든 대화가 자기 계정의 env를 공유 주입받는다.
 * 값의 유일한 흐름은 주입 계통(session-core → auth.accountEnv → BackendOptions.workspaceEnv →
 * 백엔드 spawn 프로세스 환경)이며, 어떤 응답·목록·로그에도 값을 반환하지 않는다
 * (listAccountEnvKeys는 이름만 — "값 반환 API 존재 금지" 계약. LLM 노출 경로와 구조적으로 분리).
 *
 * 저장: users.json 내부 (별도 파일 아님) — 쓰기·0600·스키마 방어는 auth.ts saveUsers가 단일 진원.
 * 소유권 처리는 서버 라우트(/api/env/*)가 전담: 키의 주인이 계정이므로 쿠키 인증만으로 충분 — userKey 매개변수·소유권 검사 불필요.
 * 이 모듈은 auth.ts의 users.json 장부 함수를 import한다 (storage가 account 계층 위에 서는 정방향 의존 — 순환 회피:
 * auth는 이 모듈을 결코 import하지 않고, userKey→username 역색인·방어 복사를 자체 구현한다).
 * session-core는 이 모듈을 import하지 않는다 — env 수령은 authorize 계약(auth.accountEnv)으로만 (주석 고정).
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";
import { loadUsers, saveUsers, verifyUserKeyFormat } from "./auth.ts";

const DATA_DIR = envPaths("ai-turk").data; // 구 대화 env.json(<userKey>/env.json) 마이그레이션 스캔용

// ── 키 규칙 — 대문자 시작 + 대문자·숫자·언더스코어, 1~64자 ──────────────
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

// ── 예약 키 — 서버 계약(GATEWAY_/TURK_)·런타임 계약(NODE_/ANTHROPIC_/OPENAI_/OLLAMA_) 접두사 +
//    셸·프로세스 필수 정확 일치. 사용자 키가 계약 키를 덮지 못하게 하는 1차 방어 (2차: spawn 병합 순서 — backend.ts) ──
const RESERVED_PREFIXES = ["GATEWAY_", "TURK_", "NODE_", "ANTHROPIC_", "OPENAI_", "OLLAMA_"] as const;
const RESERVED_EXACT = new Set(["PATH", "HOME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM"]);

const MAX_KEYS = 20;              // 계정당 키 상한 (대화당 상한이던 4c 수치를 계정 스코프로 승격 — 동일 수치)
const MAX_VALUE_BYTES = 4 * 1024; // 값 상한 (utf8 바이트 — 문자열만)

/** 키 규칙 + 예약(접두사·정확일치) 검증 — 저장소 내부 검증·DELETE 라우트 세그먼트 검증·마이그레이션 병합의 공용 진원. */
export function isEnvKeyName(key: string): boolean {
	return typeof key === "string" && key.length >= 1 && key.length <= 64 && KEY_RE.test(key)
		&& !RESERVED_EXACT.has(key) && !RESERVED_PREFIXES.some((p) => key.startsWith(p));
}

/** 내부 변환 — 미보유·스키마 오염 계정 env는 전부 정규화 객체로 시작 (방어적 로드 — users.json 관례 동일). */
function normalizeAccountEnv(raw: unknown): Record<string, string> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v; // 문자열 쌍만 수용 — 타입 오염 방어
	}
	return out;
}

/** 계정 env 전체 판독 — 방어 복사. 주입 계통(auth.accountEnv)이 동일 데이터를 userKey 역색인으로 수령한다.
 *  ⚠ 계약: 여기서 반환한 값은 저장소 관측·테스트 전용 — 응답·목록·로그 어디에도 전달 금지 (값 반환 API는 주입 계통뿐). */
export function loadAccountEnv(username: string): Record<string, string> {
	const acc = loadUsers().accounts[username];
	if (!acc) return {};
	return normalizeAccountEnv(acc.env);
}

/** 계정 env 이름 목록만 반환 — 결정적 순서(정렬). 화면·AGENTS.md·목록은 항상 이름만 (계약). */
export function listAccountEnvKeys(username: string): string[] {
	return Object.keys(loadAccountEnv(username)).sort();
}

/** upsert — 검증 순서: 계정 존재 → 키 형식·예약 → 값 타입·크기 → 키 수 상한. 기존 키 갱신은 상한과 무관.
 *  username은 쿠키 인증(AUTH)으로 이미 확정된 본인을 서버가 전달한다 — 형식 검사는 env 키에만 집중 (계정 키는 경로로 쓰이지 않음). */
export function setAccountEnv(username: string, key: string, value: string): { ok: boolean; error?: string } {
	const users = loadUsers();
	const acc = users.accounts[username];
	if (!acc) return { ok: false, error: "계정을 찾을 수 없습니다" }; // 세션 도중 삭제된 계정 방어
	if (!isEnvKeyName(key)) return { ok: false, error: "키는 대문자로 시작하는 A-Z·0-9·_ 조합 1~64자여야 합니다" };
	if (typeof value !== "string") return { ok: false, error: "값은 문자열이어야 합니다" }; // 직접 호출 방어
	if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return { ok: false, error: "값은 4KB 이하여야 합니다" };
	const env = normalizeAccountEnv(acc.env);
	if (!(key in env) && Object.keys(env).length >= MAX_KEYS) return { ok: false, error: "계정당 환경변수는 최대 20개입니다" };
	env[key] = value;
	acc.env = env;
	try {
		saveUsers(users); // users.json 0600 — 장부 계약 동일
		return { ok: true };
	} catch (err) {
		console.log(`[env-store] 저장 실패: ${err instanceof Error ? err.message : err}`); // 값은 절대 로그에 미출력
		return { ok: false, error: "저장 실패" };
	}
}

/** 키 제거 — 멱등 (원래 없어도 true). false는 계정 미존재(fs 이전 판정) 또는 저장 실패뿐. */
export function deleteAccountEnvKey(username: string, key: string): boolean {
	const users = loadUsers();
	const acc = users.accounts[username];
	if (!acc) return false; // 세션 도중 삭제된 계정 — 쿠키 인증 직후라도 방어
	const env = normalizeAccountEnv(acc.env);
	if (!(key in env)) return true; // 멱등 — 미존재 귀결
	delete env[key];
	acc.env = env;
	try {
		saveUsers(users);
		return true;
	} catch (err) {
		console.log(`[env-store] 삭제 실패: ${err instanceof Error ? err.message : err}`);
		return false;
	}
}

// ── 대화 env.json → 계정 env 마이그레이션 (4c-refit 1회성) ─────────────────
// 구 4c 저장소(`<userKey>/env.json`)를 스캔해 소유 계정 env로 add-if-absent 병합(계정이 이미 있으면 계정이 승리) 후 구 파일 rm.
// 구 파일·값에 접촉하는 유일한 경로 — 마이그레이션 밖의 신 코드는 구 파일을 절대 읽지 않는다.
// 병합 키는 isEnvKeyName 규칙 통과 + 계정 상한 이내 (상한 초과·규칙 위반분은 폐기 — 구 파일은 신 코드 경로에서
// 어디에도 읽히지 않는 죽은 데이터; 폐기 개수만 로그에 남긴다, 값 미출력). 파싱 실패한 소유 파일은 파기하지 않고 유지.
// 반환 = 실제 신규 추가된 키 수 (계정이 이미 보유 → 계정 승리 = 이관 대상 아님). 멱등 — 재호출 0.
export function migrateConversationEnvToAccounts(): number {
	let entries;
	try {
		entries = readdirSync(DATA_DIR, { withFileTypes: true });
	} catch { return 0; } // DATA_DIR 미존재 — 이관 대상 없음
	let added = 0;
	for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) { // 이름 정렬 — 스캔 순서 결정화 (동일 계정 동일 키 경쟁에서도 결정적)
		if (!d.isDirectory() || !verifyUserKeyFormat(d.name)) continue; // 형식 위반 dir — 4a 잔여키 대사 취급 동일 스킵
		const envPath = join(DATA_DIR, d.name, "env.json");
		if (!existsSync(envPath)) continue;
		// 고아 판정 — 소유자 없는 대화의 env.json은 그대로 두되 미병합. 고아는 아직 누구도 구하지 않은 자산 —
		// 클레임 시점의 소유자가 쓸 것 (고아 자동클레임 계약과 맞물린 유산 이관 규칙). 이 주석은 계약 고정 — 지우지 않는다.
		let owner: string | null = null;
		for (const [name, acc] of Object.entries(loadUsers().accounts)) {
			if (Array.isArray(acc.userKeys) && acc.userKeys.includes(d.name)) { owner = name; break; }
		}
		if (!owner) continue; // 고아 — 파일 유지·미병합
		let oldEnv: Record<string, string> | null = null;
		try {
			const parsed = JSON.parse(readFileSync(envPath, "utf8")) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				oldEnv = {};
				for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
					if (typeof v === "string") oldEnv[k] = v;
				}
			}
		} catch { /* 파싱 실패 — 판독 불가 데이터는 파기하지 않는다 (파일 유지) */ }
		if (!oldEnv) continue;
		const users = loadUsers(); // 파일당 1회 판독·저장 — 파일별 실적 완결 (save 실패 시 파일 유지로 데이터 보존 우선)
		const acc = users.accounts[owner];
		if (!acc) continue; // 소유자 스캔 직후 삭제된 극단 레이스 — 방어
		const env = normalizeAccountEnv(acc.env);
		let merged = 0, dropped = 0;
		for (const [k, v] of Object.entries(oldEnv)) {
			if (!isEnvKeyName(k) || k in env) continue; // 규칙 위반 제외 · 계정 승리(add-if-absent)
			if (Object.keys(env).length >= MAX_KEYS) { dropped++; continue; } // 계정 상한 — 초과분 폐기
			env[k] = v;
			merged++; added++;
		}
		if (merged > 0) {
			try {
				acc.env = env;
				saveUsers(users);
			} catch (err) {
				console.log(`[env-store] 마이그레이션 저장 실패: ${err instanceof Error ? err.message : err}`); // 값 미출력
				continue; // 파일 유지 — 다음 부팅 재시도 (add-if-absent라 재병합 무해)
			}
		}
		if (dropped > 0) console.log(`[env-store] 마이그레이션 상한 폐기 ${dropped}키 (${d.name.slice(0, 8)}.)`); // 개수만 — 값 미출력
		try {
			rmSync(envPath); // 병합 실적 반영 성공 시에만 도달 — 구 파일 소멸 (rm 실패 시 재부팅에서 자가치유)
		} catch (err) {
			console.log(`[env-store] 마이그레이션 파일 제거 실패: ${err instanceof Error ? err.message : err}`);
		}
	}
	return added;
}