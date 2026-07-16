// AGENTS.md 파일 보장 — 자동생성 파일은 새 버전으로 마이그레이션, 사용자 커스텀은 보호.
// Node 전용(node:fs 의존) — 브라우저 번들에 절대 포함되지 않도록 src/App.tsx는 import 금지.
// server.ts(프로덕션)·vite.config.ts(개발)만 import 한다.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
	agentsMdTemplate,
	AGENTS_MD_AUTOGEN_MARKER,
	AGENTS_MD_HEADER,
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