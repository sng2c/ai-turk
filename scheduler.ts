/**
 * AI Turk 프롬프트 스케줄러 — when 문자열(상대/절대)로 백엔드에 프롬프트 자동 주입.
 *
 * LLM 응답 JSON 의 schedules 배열을 서버가 이 클래스로 관리.
 * 백엔드를 직접 호출하지 않고 onTrigger 콜백으로 서버에 위임.
 *
 * 메모리만 사용 (디스크 저장 없음). 서버 프로세스 생명주기 = 세션.
 * 스케줄은 기본 once — 실행 후 자동 제거. 반복/신규/갱신 시 LLM이 schedules 배열로 재등록 (체이닝 강제).
 *
 * 동시 트리거는 같은 timers 단계에 모아(batch) 하나의 백엔드 프롬프트로 결합 → 백엔드 1회 호출, 응답 1개.
 *
 * when 형식 (LLM이 출력, 서버가 파싱):
 *   - 상대: "30m" / "2h" / "1d" / "90s" / "5000ms"  (now + delta)
 *   - 절대: "21:00" (HH:MM, 다음 해당 시각) / "2026-07-12T21:00" (ISO, offset 없으면 로컬)
 *   - cron 미지원 — 반복 시 상대/절대 시간 + 재등록 (체이닝)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

// 진단 로그 토글: TURK_DEBUG=1
const DEBUG = !!process.env.TURK_DEBUG;

// ── 상수 ────────────────────────────────────────────────────────────────
// 0 = unlimited. 환경변수 TURK_MAX_SCHEDULES로 덮어쓰기.
const MAX_SCHEDULES = (() => {
	const v = Number(process.env.TURK_MAX_SCHEDULES ?? "20");
	return Number.isFinite(v) && v >= 0 ? v : 20;
})();
const MIN_INTERVAL_MS = 60_000;

const UNIT_MS: Record<string, number> = {
	ms: 1,
	s: 1_000,
	m: 60_000,
	h: 3_600_000,
	d: 86_400_000,
};

// ── 타입 정의 ────────────────────────────────────────────────────────────
export interface ScheduleEntry {
	id: string;
	when: string; // "30m" | "21:00" | "2026-07-12T21:00" (cron 미지원 — once 체이닝)
	prompt: string;
	condition?: string; // 조건부 스케줄 — 충족 시만 실행, 불충족 시 no-response 응답
	timer: NodeJS.Timeout | null;
	nextRun: number | null; // 다음 실행 시각의 타임스탬프 (ms)
}

export interface ScheduleResult {
	success: boolean;
	data?: any;
	error?: string;
}

export interface SchedulerOptions {
	onTrigger: (entries: ScheduleEntry[]) => void; // 트리거 시 서버가 주입 수행 (복수 합치기)
	isBusy: () => boolean; // 백엔드가 응답 생성 중인지
	storageDir?: string; // 영속화 디렉토리 (생략 시 메모리만) — schedules.json 저장/로드
}

// ── 정규식 ──────────────────────────────────────────────────────────────
const RELATIVE_RE = /^(\d+)(ms|s|m|h|d)$/;
const ABSOLUTE_TIME_RE = /^(\d{1,2}):(\d{2})$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const CRON_RE = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/; // 5필드

// ── when 문자열 → 다음 실행까지 ms ────────────────────────────────────────
/**
 * when 문자열을 파싱하여 다음 실행 시각까지의 ms 계산.
 * 상대/절대 순차 정규식 매칭 — 전부 실패 시 오류 반환(폴백 없음). cron 미지원(once 체이닝 강제).
 */
export function parseWhen(when: string): { ms: number; error?: string } {
	// 상대: "30m" / "2h" / "1d" / "90s" / "5000ms"
	const rel = RELATIVE_RE.exec(when);
	if (rel) {
		const ms = Number(rel[1]) * UNIT_MS[rel[2]];
		if (ms < MIN_INTERVAL_MS) {
			return { ms: 0, error: `relative time below minimum 1 minute: '${when}' — e.g. '30m', '2h', '1d'` };
		}
		return { ms };
	}

	// 절대 HH:MM (다음 해당 시각 — 오늘 지났으면 내일)
	const abs = ABSOLUTE_TIME_RE.exec(when);
	if (abs) {
		const h = Number(abs[1]);
		const min = Number(abs[2]);
		if (h > 23 || min > 59) {
			return { ms: 0, error: `time out of range: '${when}' — HH:MM (00:00~23:59)` };
		}
		const now = new Date();
		const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, min, 0, 0);
		let ms = target.getTime() - now.getTime();
		if (ms < MIN_INTERVAL_MS) {
			target.setDate(target.getDate() + 1);
			ms = target.getTime() - now.getTime();
		}
		return { ms };
	}

	// 절대 ISO (해당 시각 — offset 없으면 로컬 타임, 지났으면 오류)
	if (ISO_RE.test(when)) {
		const target = new Date(when);
		if (isNaN(target.getTime())) {
			return { ms: 0, error: `ISO time format error: '${when}' — e.g. '2026-07-12T21:00'` };
		}
		const ms = target.getTime() - Date.now();
		if (ms < MIN_INTERVAL_MS) {
			return { ms: 0, error: `ISO time not at least 1 minute in future: '${when}'` };
		}
		return { ms };
	}

	// cron 5필드 — 미지원 (once 체이닝 강제: cron 자동 반복 대신 상대/절대 시간 + 재등록)
	if (CRON_RE.test(when)) {
		return { ms: 0, error: `cron not supported: '${when}' — use relative ('30m') or absolute ('21:00') and re-register for recurring` };
	}

	return { ms: 0, error: `unknown when format: '${when}' — e.g. '30m'(relative), '21:00'(absolute), '2026-07-12T21:00'(ISO)` };
}

// ── when 표현식 표시용 ──────────────────────────────────────────────────
export function describeWhen(when: string): string {
	return when; // LLM/사용자에게 when 문자열 그대로 표시
}

// ── 백엔드에 주입할 메시지 생성 (복수 entry 결합) ──────────────────────────
/**
 * 백엔드에 주입할 메시지 생성 — 동시 트리거들을 하나의 프롬프트로 결합.
 * 마지막에 줄바꿈 1개 (systemPrompt 는 sendPrompt 가 별도 부착).
 */
export function formatTriggerMessage(entries: ScheduleEntry[], executedAt: Date): string {
	const ids = entries.map((e) => e.id).join(", ");
	const blocks = entries
		.map((e) => {
			const cond = e.condition
				? `\n[Conditional schedule] condition: "${e.condition}"\nEvaluate this condition first — must verify with clear facts (objective) via web_search or other tools. No speculation/subjective judgment.\n- Confirmed true: respond normally per instructions below.\n- Confirmed false: no action to perform. Return {"message":"","buttons":{},"noResponse":true} for this schedule (response discarded, no UI display/notification).\n- Cannot verify (tool failure, insufficient info): respond normally informing the user (e.g., "Cannot verify the condition: <reason>. Please edit the schedule.").`
				: "";
			return `--- schedule id: ${e.id} · when: ${e.when} ---${cond}\n${e.prompt}`;
		})
		.join("\n\n");
	return `[Scheduled tasks triggered] ids: ${ids} · ${executedAt.toLocaleString("ko-KR")}\nThis message indicates the above scheduled tasks have triggered. Respond per the instructions below.\n\n[Response format] Must be a single JSON object — {"message":"...","buttons":{...}}. No code fences/explanation.\n[schedules control — once] Each schedule is auto-removed after execution. Control via the schedules array in your response:\n- Recurring: re-register the same schedule (same id)\n- Follow-up/new/sequential tasks: add a new schedule\n- Update: add with the same id (overwrite)\n- once/done: omit schedules\nschedules element format: {"id","when","prompt",...} — when: "30m"(relative) | "21:00"(absolute) | "2026-07-12T21:00"(ISO). No cron — re-register for recurring.\nJudge based on the prompt instructions and current context.\n\n${blocks}\n`;
}

// ── 목록 텍스트 포맷 ────────────────────────────────────────────────────
/**
 * list() 결과를 사용자에게 보여줄 텍스트 포맷.
 */
export function formatListText(entries: ScheduleEntry[]): string {
	let text = `[Current schedules (${MAX_SCHEDULES > 0 ? `${MAX_SCHEDULES} max` : "unlimited"}, ${entries.length} active)]\n`;
	for (const e of entries) {
		const preview = e.prompt.slice(0, 30);
		const cond = e.condition ? ` [cond: ${e.condition}]` : "";
		text += `- ${e.id}: when "${e.when}"${cond} — "${preview}${e.prompt.length > 30 ? "..." : ""}"\n`;
	}
	text += `[Show the user the schedule status above as a button grid]`;
	return text;
}

// ── 스케줄러 클래스 ─────────────────────────────────────────────────────
export class Scheduler {
	private opts: SchedulerOptions;
	private schedules = new Map<string, ScheduleEntry>();
	private pendingBatch: ScheduleEntry[] = []; // 동시 트리거 모음 — busy 시 대기
	private batchScheduled = false; // setImmediate 중복 예약 방지
	private storageFile: string | null = null;

	constructor(opts: SchedulerOptions) {
		this.opts = opts;
		if (opts.storageDir) {
			this.storageFile = `${opts.storageDir}/schedules.json`;
			this.loadFromFile();
		}
	}

	// ── 영속화: 파일 저장 ──────────────────────────────────────────────
	private persist(): void {
		if (!this.storageFile) return;
		try {
			const arr = Array.from(this.schedules.values()).map((e) => ({
				id: e.id, when: e.when, prompt: e.prompt, condition: e.condition, nextRun: e.nextRun,
			}));
			mkdirSync(this.opts.storageDir!, { recursive: true });
			writeFileSync(this.storageFile, JSON.stringify(arr));
		} catch (err) {
			if (DEBUG) console.log(`[Scheduler] persist 실패: ${err instanceof Error ? err.message : err}`);
		}
	}

	// ── 영속화: 파일 로드 (서버 시작 시) ────────────────────────────────
	private loadFromFile(): void {
		if (!this.storageFile || !existsSync(this.storageFile)) return;
		try {
			const arr = JSON.parse(readFileSync(this.storageFile, "utf-8")) as Array<{ id: string; when: string; prompt: string; condition?: string; nextRun: number | null }>;
			const now = Date.now();
			for (const item of arr) {
				if (!item.id || !item.when || !item.prompt) continue;
				const ms = item.nextRun ? item.nextRun - now : NaN;
				if (!Number.isFinite(ms)) continue; // 무효만 폐기
				const delay = Math.max(ms, 0); // 과거 nextRun은 즉시 실행(놓친 스케줄 복구)
				const entry: ScheduleEntry = {
					id: item.id, when: item.when, prompt: item.prompt, condition: item.condition,
					timer: setTimeout(() => this.trigger(item.id), delay),
					nextRun: item.nextRun,
				};
				this.schedules.set(item.id, entry);
			}
			console.log(`[Scheduler] 로드: ${this.schedules.size}개 복원`);
		} catch (err) {
			console.log(`[Scheduler] 로드 실패: ${err instanceof Error ? err.message : err}`);
		}
	}

	// ── WebSocket 명령 처리 ──────────────────────────────────────────────
	handle(cmd: { action: string; id?: string; when?: string; prompt?: string; condition?: string }): ScheduleResult {
		switch (cmd.action) {
			case "add":
				return this.add(cmd.id ?? "", cmd.when ?? "", cmd.prompt ?? "", cmd.condition);
			case "remove":
				return this.remove(cmd.id ?? "");
			case "clear":
				return this.clear();
			case "list":
				return this.list();
			default:
				return { success: false, error: `unknown action: ${cmd.action ?? "(unspecified)"}` };
		}
	}

	// ── 스케줄 추가 ──────────────────────────────────────────────────────
	add(id: string, when: string, prompt: string, condition?: string): ScheduleResult {
		if (typeof id !== "string" || !id) {
			return { success: false, error: `[Schedule error] id missing — schedules element requires a string id` };
		}
		if (typeof when !== "string" || !when) {
			return { success: false, error: `[Schedule error] id="${id}" when missing — e.g. '30m', '21:00', '2026-07-12T21:00'` };
		}
		if (typeof prompt !== "string" || !prompt) {
			return { success: false, error: `[Schedule error] id="${id}" prompt missing — execution instruction (string) required` };
		}
		const parsed = parseWhen(when);
		if (parsed.error) {
			return { success: false, error: `[Schedule error] id="${id}" when="${when}": ${parsed.error}` };
		}

		// 최대 개수 검사 (기존 id 업데이트 시에는 제외)
		if (MAX_SCHEDULES > 0 && this.schedules.size >= MAX_SCHEDULES && !this.schedules.has(id)) {
			return { success: false, error: `[Schedule error] id="${id}" max schedules (${MAX_SCHEDULES}) exceeded — remove an existing schedule before add` };
		}

		// 기존 id가 있으면 타이머 정리 후 덮어쓰기
		const existing = this.schedules.get(id);
		if (existing?.timer) {
			clearTimeout(existing.timer);
		}

		const now = Date.now();
		const entry: ScheduleEntry = {
			id,
			when,
			prompt,
			condition,
			timer: null,
			nextRun: now + parsed.ms,
		};

		entry.timer = setTimeout(() => this.trigger(id), parsed.ms);
		this.schedules.set(id, entry);
		this.persist();

		return { success: true, data: { id, when, nextRun: entry.nextRun } };
	}

	// ── 스케줄 제거 ──────────────────────────────────────────────────────
	remove(id: string): ScheduleResult {
		const entry = this.schedules.get(id);
		if (!entry) return { success: true, data: { id } }; // idempotent — 이미 제거됨
		if (entry.timer) {
			clearTimeout(entry.timer);
		}
		this.schedules.delete(id);
		// pendingBatch에서도 제거
		this.pendingBatch = this.pendingBatch.filter((e) => e.id !== id);
		this.persist();

		return { success: true, data: { id } };
	}

	// ── 전체 제거 ──────────────────────────────────────────────────────
	clear(): ScheduleResult {
		for (const entry of this.schedules.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		const count = this.schedules.size;
		this.schedules.clear();
		this.pendingBatch = [];
		this.persist();
		return { success: true, data: { count } };
	}

	// ── 목록 조회 ──────────────────────────────────────────────────────
	list(): ScheduleResult {
		const entries = Array.from(this.schedules.values());
		return {
			success: true,
			data: {
				text: formatListText(entries),
				count: entries.length,
			},
		};
	}

	// ── 큐 비우기 (agent_end 후 호출) ─────────────────────────────────────
	drainQueue(): void {
		// pendingBatch가 비어있지 않고 백엔드가 idle이면 flushBatch 실행
		this.flushBatch();
	}

	// ── 모든 타이머 정리 (서버 종료 시) ─────────────────────────────────
	destroy(): void {
		for (const entry of this.schedules.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.schedules.clear();
		this.pendingBatch = [];
	}

	// ── 내부: 트리거 도달 — batch에 적재 후 같은 틱에 flush ───────────────
	private trigger(id: string): void {
		const entry = this.schedules.get(id);
		if (!entry) return; // 제거된 스케줄

		// once — batch에 적재 (타이머 만료, 즉시 제거)
		if (entry.timer) clearTimeout(entry.timer);
		this.schedules.delete(id);
		this.pendingBatch.push(entry);

		if (DEBUG) console.log(`[Scheduler] trigger 도달: id=${id} when=${entry.when} → batch(${this.pendingBatch.length})`);

		// 같은 timers 단계의 다른 트리거들과 합치기 위해 setImmediate로 flush 예약 (queueMicrotask는 현재 macrotask 끝에 실행 → 별도 setTimeout 콜백과 합쳐지지 않음)
		if (!this.batchScheduled) {
			this.batchScheduled = true;
			setImmediate(() => this.flushBatch());
		}
	}

	// ── 내부: batch flush — busy면 대기(pendingBatch 유지), idle이면 주입 ─
	private flushBatch(): void {
		this.batchScheduled = false;
		if (this.pendingBatch.length === 0) return;
		if (this.opts.isBusy()) {
			// 백엔드 busy — pendingBatch 유지, 다음 drainQueue(agent_end)에서 재시도
			if (DEBUG) console.log(`[Scheduler] flush 지연(busy): batch(${this.pendingBatch.length}) 대기`);
			return;
		}
		const entries = this.pendingBatch.splice(0);
		const ids = entries.map((e) => e.id).join(",");
		if (DEBUG) console.log(`[Scheduler] flush 실행: ids=${ids} (${entries.length}개)`);
		this.opts.onTrigger(entries);
	}
}