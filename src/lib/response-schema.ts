// 터크 응답 JSON Schema — 응답 계약의 단일 진원(법).
// 프롬프트(AGENTS.md)는 보조 교육일 뿐, 이 스키마가 서버·클라 공용 1차 게이트로 검사한다.
// Visible/Silent 이분법(silent면 message 빈 문자열, 아니면 최소 1자)과 schedules 요소 형태를 강제.
// Node(서버)·브라우저(클라) 양쪽 import 가능 (의존: ajv).

import { Ajv } from "ajv";

export const TURK_RESPONSE_SCHEMA = {
	$schema: "http://json-schema.org/draft-07/schema#",
	title: "AI-Turk response",
	type: "object",
	required: ["message", "buttons"],
	properties: {
		message: { type: "string" },
		buttons: { type: "object", additionalProperties: { type: "string" } },
		colors: { type: "object", additionalProperties: { type: "string" } },
		textColors: { type: "object", additionalProperties: { type: "string" } },
		silent: { type: "boolean" },
		repeat: { type: "boolean" },
		schedules: {
			type: "array",
			items: {
				type: "object",
				required: ["action"],
				properties: {
					action: { enum: ["add", "remove", "clear", "list"] },
					id: { type: "string", minLength: 1 },
					when: { type: "string", minLength: 1 },
					prompt: { type: "string", minLength: 1 },
					condition: { type: "string" },
				},
				// add는 id/when/prompt 필수, remove는 id 필수
				allOf: [
					{ if: { properties: { action: { const: "add" } }, required: ["action"] }, then: { required: ["id", "when", "prompt"] } },
					{ if: { properties: { action: { const: "remove" } }, required: ["action"] }, then: { required: ["id"] } },
				],
			},
		},
	},
	// Visible/Silent 이분법 — 스키마가 강제하는 계약의 핵심
	allOf: [
		// Silent: message는 빈 문자열이어야
		{ if: { properties: { silent: { const: true } }, required: ["silent"] }, then: { properties: { message: { type: "string", maxLength: 0 } } } },
		// Visible( silent 없음/false ): message는 최소 1자
		{ if: { not: { properties: { silent: { const: true } }, required: ["silent"] } }, then: { properties: { message: { type: "string", minLength: 1 } } } },
	],
} as unknown as object;

const ajv = new Ajv({ allErrors: true });
const compiled = ajv.compile(TURK_RESPONSE_SCHEMA);

/**
 * 응답을 JSON Schema로 검사 — 서버·클라 공용 1차 게이트.
 * 위반 시 { ok: false, errors } — errors는 self-correction 재시도 안내문에 그대로 실린다.
 */
export function validateTurkResponse(obj: unknown): { ok: boolean; errors?: string } {
	if (obj === null || typeof obj !== "object") return { ok: false, errors: "response is not a JSON object" };
	if (!compiled(obj)) {
		const errs = (compiled.errors ?? []).map((e: { instancePath?: string; message?: string }) => `${e.instancePath || "/"} ${e.message}`).join("; ");
		return { ok: false, errors: errs };
	}
	return { ok: true };
}