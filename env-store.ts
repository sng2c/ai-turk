/**
 * env-store.ts — 대화별 환경변수 저장소 (Phase 4c)
 *
 * 단일 책임: fs 접촉. 값의 유일한 흐름은 loadConversationEnv → BackendOptions.workspaceEnv →
 * 백엔드 spawn 프로세스 환경이며, 어떤 응답·목록·로그에도 값을 반환하지 않는다
 * (listConversationEnvKeys는 이름만 — "값 반환 API 존재 금지" 계약. LLM 노출 경로와 구조적으로 분리).
 *
 * 저장: `${DATA_DIR}/<userKey>/env.json` — { "KEY": "value" } flat JSON.
 * users.json 관례 동일: 쓰기 후 chmodSync 0o600, 미존재·스키마 손상은 {}로 시작.
 * 소유권(own만) 처리는 서버 라우트(/api/env/*)가 전담 — 이 모듈과 세션 코어는 authorize를 모른다 (Phase 3 계약 재사용).
 */

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import envPaths from "env-paths";

const DATA_DIR = envPaths("ai-turk").data;

// ── 키 규칙 — 대문자 시작 + 대문자·숫자·언더스코어, 1~64자 ──────────────
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

// ── 예약 키 — 서버 계약(GATEWAY_/TURK_)·런타임 계약(NODE_/ANTHROPIC_/OPENAI_/OLLAMA_) 접두사 +
//    셸·프로세스 필수 정확 일치. 사용자 키가 계약 키를 덮지 못하게 하는 1차 방어 (2차: spawn 병합 순서 — backend.ts) ──
const RESERVED_PREFIXES = ["GATEWAY_", "TURK_", "NODE_", "ANTHROPIC_", "OPENAI_", "OLLAMA_"] as const;
const RESERVED_EXACT = new Set(["PATH", "HOME", "SHELL", "PWD", "TMPDIR", "LANG", "TERM"]);

const MAX_KEYS = 20;              // 대화당 키 상한
const MAX_VALUE_BYTES = 4 * 1024; // 값 상한 (utf8 바이트 — 문자열만)

function isValidEnvKey(key: string): boolean {
	return typeof key === "string" && key.length >= 1 && key.length <= 64 && KEY_RE.test(key);
}

// ── userKey 형식 검증 — session-core.ts·auth.ts의 쌍둥이 3번째 (모듈 순환 import 회피 로컬 복제 관례).
//    userKey가 DATA_DIR 경로 조합에 직접 쓰이므로 ../ 경로조작 차단 ──
function verifyUserKeyFormat(key: string): boolean {
	if (!key || key.length > 100) return false;
	if (key.includes("/") || key.includes("\\") || key.includes("..")) return false;
	for (const ch of key) {
		const c = ch.charCodeAt(0);
		if (c < 0x20 || c === 0x7f) return false; // 제어문자
	}
	return true;
}

function envFilePath(userKey: string): string {
	return join(DATA_DIR, userKey, "env.json");
}

/** 판독 — 미존재·손상·비문자열 값 전부 {}로 시작 (users.json 관례 동일, 방어적 로드). */
export function loadConversationEnv(userKey: string): Record<string, string> {
	if (!verifyUserKeyFormat(userKey)) return {};
	try {
		const parsed = JSON.parse(readFileSync(envFilePath(userKey), "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof v === "string") out[k] = v; // 문자열 쌍만 수용 — 타입 오염 방어
		}
		return out;
	} catch { return {}; }
}

/** 이름 목록만 반환 — 값을 반환하는 API는 이 모듈에 존재하지 않는다 (계약). 결정적 순서(정렬). */
export function listConversationEnvKeys(userKey: string): string[] {
	return Object.keys(loadConversationEnv(userKey)).sort();
}

/** upsert — 검증 순서: userKey 형식 → 키 형식 → 예약 → 값 타입·크기 → 키 수 상한. 기존 키 갱신은 상한과 무관. */
export function setConversationEnv(userKey: string, key: string, value: string): { ok: boolean; error?: string } {
	if (!verifyUserKeyFormat(userKey)) return { ok: false, error: "대화 키 형식이 올바르지 않습니다" };
	if (!isValidEnvKey(key)) return { ok: false, error: "키는 대문자로 시작하는 A-Z·0-9·_ 조합 1~64자여야 합니다" };
	if (RESERVED_EXACT.has(key) || RESERVED_PREFIXES.some((p) => key.startsWith(p))) {
		return { ok: false, error: "예약된 키 이름입니다 (서버·런타임 계약 보호)" };
	}
	if (typeof value !== "string") return { ok: false, error: "값은 문자열이어야 합니다" }; // 직접 호출 방어
	if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) return { ok: false, error: "값은 4KB 이하여야 합니다" };
	const env = loadConversationEnv(userKey);
	if (!(key in env) && Object.keys(env).length >= MAX_KEYS) return { ok: false, error: "대화당 환경변수는 최대 20개입니다" };
	env[key] = value;
	try {
		mkdirSync(join(DATA_DIR, userKey), { recursive: true });
		writeFileSync(envFilePath(userKey), JSON.stringify(env));
		chmodSync(envFilePath(userKey), 0o600); // 쓰기 후 0600 — 사용자 자격 증명 파일 (users.json 관례 동일)
		return { ok: true };
	} catch (err) {
		console.log(`[env-store] 저장 실패: ${err instanceof Error ? err.message : err}`); // 값은 절대 로그에 미출력
		return { ok: false, error: "저장 실패" };
	}
}

/** 키 제거 — 멱등 (원래 없어도·애초 저장 불가한 형식도 true). false는 fs 저장 실패뿐. */
export function deleteConversationEnvKey(userKey: string, key: string): boolean {
	if (!verifyUserKeyFormat(userKey)) return false; // rm 경로조작 방어
	const env = loadConversationEnv(userKey);
	if (!(key in env)) return true; // 멱등 — 미존재 귀결
	delete env[key];
	try {
		writeFileSync(envFilePath(userKey), JSON.stringify(env));
		chmodSync(envFilePath(userKey), 0o600);
		return true;
	} catch (err) {
		console.log(`[env-store] 삭제 실패: ${err instanceof Error ? err.message : err}`);
		return false;
	}
}