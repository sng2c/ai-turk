/**
 * AI Turk 프롬프트 스케줄러 — 지정 시각/간격으로 백엔드에 프롬프트를 자동 주입.
 *
 * LLM 응답 JSON 의 schedules 배열을 서버가 이 클래스로 관리.
 * 백엔드를 직접 호출하지 않고 onTrigger 콜백으로 서버에 위임.
 *
 * 메모리만 사용 (디스크 저장 없음). 서버 프로세스 생명주기 = 세션.
 */

// ── 상수 ────────────────────────────────────────────────────────────────
const MAX_SCHEDULES = 5;
const MIN_INTERVAL_MS = 60_000;

// ── 타입 정의 ────────────────────────────────────────────────────────────
export type ScheduleMode = "once" | "repeat" | "daily";

export interface ScheduleEntry {
	id: string;
	mode: ScheduleMode;
	at: string;
	prompt: string;
	timer: NodeJS.Timeout | null;
	nextRun: number | null; // 다음 실행 시각의 타임스탬프 (ms)
}

export interface ScheduleResult {
	success: boolean;
	data?: any;
	error?: string;
}

export interface SchedulerOptions {
	onTrigger: (entry: ScheduleEntry) => void; // 트리거 시 서버가 주입 수행
	isBusy: () => boolean; // 백엔드가 응답 생성 중인지
}

// ── at 문자열 → 밀리초 파싱 ──────────────────────────────────────────────
/**
 * "5m" → 300000, "1h" → 3600000, "30s" → 30000
 * "09:00" → 다음 해당 시각까지 ms
 * 형식 오류 시 { ms: 0, error: "..." }
 */
export function parseAt(at: string, mode: ScheduleMode): { ms: number; error?: string } {
	// 간격 형식: "30s", "5m", "1h"
	const intervalMatch = at.match(/^(\d+)([smh])$/);
	// 시각 형식: "09:00", "14:30"
	const clockMatch = at.match(/^(\d{1,2}):(\d{2})$/);

	if (mode === "daily") {
		// daily 는 시각 형식만 허용
		if (intervalMatch) {
			return { ms: 0, error: "daily 모드는 시각 형식('09:00')만 지원합니다" };
		}
		if (!clockMatch) {
			return { ms: 0, error: `at 형식 오류: '${at}' — 예: '09:00', '14:30'` };
		}
		// 다음 해당 시각까지 ms 계산
		const now = new Date();
		const target = new Date(now);
		target.setHours(Number(clockMatch[1]), Number(clockMatch[2]), 0, 0);
		if (target.getTime() <= now.getTime()) {
			// 이미 지난 시각 → 내일
			target.setDate(target.getDate() + 1);
		}
		const ms = target.getTime() - now.getTime();
		return { ms };
	}

	// once / repeat 는 간격 형식만 허용
	if (clockMatch) {
		return { ms: 0, error: `${mode} 모드는 간격 형식('5m', '1h', '30s')만 지원합니다` };
	}
	if (!intervalMatch) {
		return { ms: 0, error: `at 형식 오류: '${at}' — 예: '5m', '1h', '30s' 또는 '09:00'` };
	}

	const num = Number(intervalMatch[1]);
	const unit = intervalMatch[2];
	let ms: number;
	switch (unit) {
		case "s": ms = num * 1000; break;
		case "m": ms = num * 60_000; break;
		case "h": ms = num * 3_600_000; break;
		default: return { ms: 0, error: `at 형식 오류: '${at}' — 예: '5m', '1h', '30s'` };
	}

	if (ms < MIN_INTERVAL_MS) {
		return { ms: 0, error: "최소 간격은 1분(60초)입니다" };
	}

	return { ms };
}

// ── 트리거 메시지 포맷 ──────────────────────────────────────────────────
/**
 * 백엔드에 주입할 메시지 생성.
 * 마지막에 줄바꿈 1개 (systemPrompt 는 sendPrompt 가 별도 부착).
 */
export function formatTriggerMessage(entry: ScheduleEntry, executedAt: Date): string {
	return `[예약 스케줄 실행] id: ${entry.id} · ${entry.at} · ${entry.mode} · ${executedAt.toLocaleString("ko-KR")}\n이 메시지는 위 예약 스케줄이 실행된 것입니다. 아래 지시에 따라 응답하세요.\n\n${entry.prompt}\n`;
}

// ── 목록 텍스트 포맷 ────────────────────────────────────────────────────
/**
 * list() 결과를 사용자에게 보여줄 텍스트 포맷.
 */
export function formatListText(entries: ScheduleEntry[]): string {
	let text = `[현재 스케줄 목록 (${MAX_SCHEDULES}개 중 ${entries.length}개 활성)]\n`;
	for (const e of entries) {
		const preview = e.prompt.slice(0, 30);
		text += `- ${e.id}: ${e.mode} ${e.at} — "${preview}${e.prompt.length > 30 ? "..." : ""}"\n`;
	}
	text += `[위 목록을 참고하여 사용자에게 스케줄 현황을 버튼 그리드로 보여주세요]`;
	return text;
}

// ── 스케줄러 클래스 ─────────────────────────────────────────────────────
export class Scheduler {
	private opts: SchedulerOptions;
	private schedules = new Map<string, ScheduleEntry>();
	private queue: string[] = []; // 대기 큐 (entry id 목록, 최대 5, 중복 방지)

	constructor(opts: SchedulerOptions) {
		this.opts = opts;
	}

	// ── WebSocket 명령 처리 ──────────────────────────────────────────────
	handle(cmd: { action: string; id?: string; mode?: string; at?: string; prompt?: string }): ScheduleResult {
		switch (cmd.action) {
			case "add":
				return this.add(cmd.id ?? "", (cmd.mode ?? "") as ScheduleMode, cmd.at ?? "", cmd.prompt ?? "");
			case "remove":
				return this.remove(cmd.id ?? "");
			case "clear":
				return this.clear();
			case "list":
				return this.list();
			default:
				return { success: false, error: `알 수 없는 action: ${cmd.action ?? "(미지정)"}` };
		}
	}

	// ── 스케줄 추가 ──────────────────────────────────────────────────────
	add(id: string, mode: ScheduleMode, at: string, prompt: string): ScheduleResult {
		if (!id) {
			return { success: false, error: "id가 필요합니다" };
		}
		if (mode !== "once" && mode !== "repeat" && mode !== "daily") {
			return { success: false, error: `지원하지 않는 mode: '${mode}' — once/repeat/daily 중 하나` };
		}

		const parsed = parseAt(at, mode);
		if (parsed.error) {
			return { success: false, error: parsed.error };
		}

		// 최대 개수 검사 (기존 id 업데이트 시에는 제외)
		if (this.schedules.size >= MAX_SCHEDULES && !this.schedules.has(id)) {
			return { success: false, error: `스케줄 최대 개수(${MAX_SCHEDULES}개) 초과` };
		}

		// 기존 id가 있으면 타이머 정리 후 덮어쓰기
		const existing = this.schedules.get(id);
		if (existing?.timer) {
			clearTimeout(existing.timer);
		}

		const now = Date.now();
		const entry: ScheduleEntry = {
			id,
			mode,
			at,
			prompt,
			timer: null,
			nextRun: now + parsed.ms,
		};

		// 모드별 타이머 설정
		if (mode === "once") {
			entry.timer = setTimeout(() => this.trigger(id), parsed.ms);
		} else if (mode === "repeat") {
			entry.timer = setInterval(() => this.trigger(id), parsed.ms);
		} else {
			// daily: setTimeout 으로 다음 시각까지 대기, 실행 후 재예약
			entry.timer = setTimeout(() => this.triggerDaily(id), parsed.ms);
		}

		this.schedules.set(id, entry);

		return { success: true, data: { id, mode, at, nextRun: entry.nextRun } };
	}

	// ── 스케줄 제거 ──────────────────────────────────────────────────────
	remove(id: string): ScheduleResult {
		const entry = this.schedules.get(id);
		if (!entry) {
			return { success: false, error: `스케줄을 찾을 수 없습니다: ${id}` };
		}
		if (entry.timer) {
			clearTimeout(entry.timer);
		}
		this.schedules.delete(id);
		// 큐에서도 제거
		this.queue = this.queue.filter((qid) => qid !== id);
		return { success: true, data: { id } };
	}

	// ── 전체 삭제 ────────────────────────────────────────────────────────
	clear(): ScheduleResult {
		const count = this.schedules.size;
		for (const entry of this.schedules.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.schedules.clear();
		this.queue = [];
		return { success: true, data: { cleared: count } };
	}

	// ── 목록 조회 ────────────────────────────────────────────────────────
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
		if (this.queue.length === 0 || this.opts.isBusy()) return;
		const id = this.queue.shift()!;
		const entry = this.schedules.get(id);
		if (entry) {
			this.opts.onTrigger(entry);
		}
		// 큐에 더 있고 백엔드가 여전히 안 바쁘면 연속 실행은 다음 drainQueue 호출에 위임
	}

	// ── 모든 타이머 정리 (서버 종료 시) ─────────────────────────────────
	destroy(): void {
		for (const entry of this.schedules.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		this.schedules.clear();
		this.queue = [];
	}

	// ── 내부: 트리거 실행 ────────────────────────────────────────────────
	private trigger(id: string): void {
		const entry = this.schedules.get(id);
		if (!entry) return;

		// 백엔드 busy 시 큐에 적재
		if (this.opts.isBusy()) {
			if (this.queue.length < MAX_SCHEDULES && !this.queue.includes(id)) {
				this.queue.push(id);
			}
			return;
		}

		// once 모드: 실행 후 Map에서 제거 + 타이머 clear
		if (entry.mode === "once") {
			if (entry.timer) {
				clearTimeout(entry.timer);
			}
			this.schedules.delete(id);
			this.opts.onTrigger(entry);
			return;
		}

		// repeat 모드: 타이머는 그대로 유지하며 반복 실행
		this.opts.onTrigger(entry);
	}

	// ── 내부: daily 모드 트리거 (실행 후 다음 날 재예약) ────────────────
	private triggerDaily(id: string): void {
		const entry = this.schedules.get(id);
		if (!entry) return;

		// 다음 날 동일 시각으로 재예약 (24시간 후)
		const nextMs = 24 * 3_600_000;
		entry.nextRun = Date.now() + nextMs;
		entry.timer = setTimeout(() => this.triggerDaily(id), nextMs);

		// 백엔드 busy 시 큐에 적재
		if (this.opts.isBusy()) {
			if (this.queue.length < MAX_SCHEDULES && !this.queue.includes(id)) {
				this.queue.push(id);
			}
			return;
		}

		this.opts.onTrigger(entry);
	}
}