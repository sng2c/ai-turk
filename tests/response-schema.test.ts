// JSON Schema 1차 게이트 단위 테스트 — 이분법·schedules 형태
import { validateTurkResponse } from "../src/lib/response-schema.ts";

const cases: Array<[string, unknown, boolean]> = [
	["Visible 정상", { message: "hi", buttons: { "0": "" } }, true],
	["빈 message (silent 없음) → 위반", { message: "", buttons: {} }, false],
	["Silent 정상 (빈 message)", { silent: true, message: "", buttons: {} }, true],
	["silent + message 있음 → 위반", { silent: true, message: "hello", buttons: {} }, false],
	["silent:false + 빈 message → 위반", { silent: false, message: "", buttons: {} }, false],
	["buttons 누락 → 위반", { message: "hi" }, false],
	["schedules add 정상", { message: "hi", buttons: {}, schedules: [{ action: "add", id: "a", when: "1d", prompt: "p" }] }, true],
	["schedules add prompt 누락 → 위반", { message: "hi", buttons: {}, schedules: [{ action: "add", id: "a", when: "1d" }] }, false],
	["schedules remove id 누락 → 위반", { message: "hi", buttons: {}, schedules: [{ action: "remove" }] }, false],
	["colors record 정상", { message: "hi", buttons: {}, colors: { "0": "success" }, textColors: { "0": "black" } }, true],
];

let pass = 0;
for (const [name, obj, want] of cases) {
	const r = validateTurkResponse(obj);
	const ok = r.ok === want;
	if (ok) pass++;
	console.log(ok ? "✅" : "❌", name, ok ? "" : `→ ${r.errors ?? "(no errors?)"}`);
}
console.log(`\n${pass}/${cases.length} 통과`);
if (pass !== cases.length) process.exit(1);