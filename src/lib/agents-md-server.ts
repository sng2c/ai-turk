// AGENTS.md 파일 보장 — 자동생성 파일은 새 버전으로 마이그레이션, 사용자 커스텀은 보호.
// Node 전용(node:fs 의존) — 브라우저 번들에 절대 포함되지 않도록 src/App.tsx는 import 금지.
// server.ts(프로덕션)·vite.config.ts(개발)만 import 한다.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
	agentsMdTemplate,
	AGENTS_MD_AUTOGEN_MARKER,
	AGENTS_MD_HEADER,
	ENV_SECTION_OPEN,
	ENV_SECTION_CLOSE,
} from "./agents-md.ts";

/**
 * path 위치의 AGENTS.md를 보장:
 *  - 없으면 생성
 *  - 자동생성 파일(마커 또는 레거시 헤더)이고 grid가 바뀌었으면 마이그레이션(덮어쓰기)
 *  - 사용자 커스텀 파일이면 보호(건드리지 않음)
 */
export function ensureAgentsMd(path: string, log: (msg: string) => void = console.log): void {
	const content = agentsMdTemplate();
	const marker = content.slice(0, content.indexOf("\n"));
	let write = true;
	if (existsSync(path)) {
		const existing = readFileSync(path, "utf8");
		const existingMarker = existing.slice(0, existing.indexOf("\n"));
		if (existingMarker === marker) {
			write = false; // 최신 — skip
		} else if (existingMarker.startsWith(AGENTS_MD_AUTOGEN_MARKER) || existing.startsWith(AGENTS_MD_HEADER)) {
			log(`[Turk] AGENTS.md 마이그레이션: ${path}`); // 자동생성(레거시 포함) — 덮어쓰기
		} else {
			write = false; // 사용자 커스텀 — 보호
		}
	}
	if (write) {
		writeFileSync(path, content, "utf8");
		log(`[Turk] AGENTS.md 생성됨: ${path}`);
	}
}

// ── 환경변수 섹션 갱신 (4c-refit 계정 스코프) — AGENTS.md의 `<!-- env:section -->` … `<!-- /env:section -->` 사이를 교체.
//    마커가 없으면(커스텀·레거시) 문서 말미에 섹션째 추가. 내용이 바뀔 때만 write — 불변 호출은 no-op
//    (pi의 AGENTS.md 감시 오동작 방지). 섹션에는 키 이름 목록만 기록하고 값은 절대 문서화하지 않는다 (env-store 계약).

/** env 섹션 본문 — 정렬된 키 이름 목록 + 계약 3절 (값 미기록 — 이름만). 결정적 생성 → 불변 판정 가능. */
function buildEnvSection(keys: string[]): string {
	const sorted = [...keys].sort();
	const names = sorted.length > 0 ? sorted.map((k) => `- ${k}`).join("\n") : "- (none configured)";
	return [
		"## Account environment variables",
		"",
		"Secret values for your account are injected into your process environment by the system — every conversation of the account shares the same set. This document lists NAMES ONLY — never values.",
		"",
		"Contract:",
		"1. For commands that need credentials/tokens, reference the variable as $NAME in your bash command (also valid as command arguments). NEVER print, echo, copy, or transmit the values — not even in your response.",
		"2. This list contains ONLY the currently configured variables — the values live in the process environment and are NOT stored in this document.",
		"3. If a variable you need is NOT in the list: do NOT ask the user for its value in chat. Instead, tell them to register an appropriately-named variable in the drawer (☰) → \"환경 변수 설정\" (Environment Variables). Values are never passed through chat.",
		"",
		"Configured variables (names only):",
		names,
	].join("\n");
}

/**
 * 섹션 적용. 반환: true = 성공(write 또는 이미 원하는 상태), false = fs 오류.
 * 순서 계약: ensureAgentsMd(템플릿 생성·마이그레이션) → applyEnvSection (마커 존재 보장 후 교체).
 */
export function applyEnvSection(path: string, keys: string[], log: (msg: string) => void = console.log): boolean {
	const section = `${ENV_SECTION_OPEN}\n${buildEnvSection(keys)}\n${ENV_SECTION_CLOSE}`;
	try {
		const content = existsSync(path) ? readFileSync(path, "utf8") : "";
		const openIdx = content.indexOf(ENV_SECTION_OPEN);
		const closeIdx = content.indexOf(ENV_SECTION_CLOSE);
		let next: string;
		if (openIdx !== -1 && closeIdx > openIdx) {
			// 마커 쌍 존재 — 사이 교체
			next = content.slice(0, openIdx) + section + content.slice(closeIdx + ENV_SECTION_CLOSE.length);
		} else {
			// 마커 없음 — 문서 말미에 추가
			const base = content.length > 0 && !content.endsWith("\n") ? content + "\n" : content;
			next = base.length > 0 ? `${base}\n${section}\n` : `${section}\n`;
		}
		if (next === content) return true; // 불변 — write 생략 (mtime 보존)
		writeFileSync(path, next, "utf8");
		log(`[Turk] AGENTS.md 환경변수 섹션 갱신: ${path} (${keys.length}개)`); // 이름 개수만 로그 — 값 무관
		return true;
	} catch (err) {
		log(`[Turk] AGENTS.md 환경변수 섹션 갱신 실패: ${err instanceof Error ? err.message : err}`);
		return false;
	}
}