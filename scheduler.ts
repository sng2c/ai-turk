/**
 * AI Turk 프롬프트 스케줄러 — cron 표현식으로 백엔드에 프롬프트를 자동 주입.
 *
 * LLM 응답 JSON 의 schedules 배열을 서버가 이 클래스로 관리.
 * 백엔드를 직접 호출하지 않고 onTrigger 콜백으로 서버에 위임.
 *
 * 메모리만 사용 (디스크 저장 없음). 서버 프로세스 생명주기 = 세션.
 * 모든 스케줄은 반복 — 1회성은 LLM이 repeat:false 응답으로 자동 제거.
 */

import { CronExpressionParser } from "cron-parser";

// ── 상수 ────────────────────────────────────────────────────────────────
const MAX_SCHEDULES = 5;
const MIN_INTERVAL_MS = 60_000;

// ── 타입 정의 ────────────────────────────────────────────────────────────
export interface ScheduleEntry {
	id: string;
	cron: string; // cron 표현식 ("0 9 * * *", "*/5 * * * *", "0 0 11 1 *")
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
	onTrigger: (entry: ScheduleEntry) => void; // 트리거 시 서버가 주입 수행
	isBusy: () => boolean; // 백엔드가 응답 생성 중인지
}

// ── cron 표현식 → 다음 실행까지 ms ────────────────────────────────────────
/**
 * cron 표현식을 파싱하여 다음 실행 시각까지의 ms 계산.
 * 형식 오류 시 { ms: 0, error: "..." }
 */
export function parseCron(cron: string): { ms: number; error?: string } {
	try {
		const iter = CronExpressionParser.parse(cron, { tz: undefined });
		let next = iter.next();
		let ms = next.getTime() - Date.now();
		// 첫 실행이 최소 간격 미만이면 다음 cron 시각으로 건너뜀 (등록 시각 엣지 케이스)
		if (ms < MIN_INTERVAL_MS) {
			next = iter.next();
			ms = next.getTime() - Date.now();
		}
		if (ms < MIN_INTERVAL_MS) {
			return { ms: 0, error: `cron 간격이 최소 1분 미만` };
		}
		return { ms };
	} catch (e) {
		return { ms: 0, error: `cron 형식 오류: '${cron}' — 예: '0 9 * * *' (매일 9시), '*/5 * * * *' (5분마다), '0 0 11 1 *' (매년 1/11)` };
	}
}

// ── 크론 표현식 간단 설명 (표시용) ────────────────────────────────────────
export function describeCron(cron: string): string {
	return cron; // LLM/사용자에게 cron 표현식 그대로 표시
}

// ── 백엔드에 주입할 메시지 생성 ──────────────────────────────────────────
/**
 * 백엔드에 주입할 메시지 생성.
 * 마지막에 줄바꿈 1개 (systemPrompt 는 sendPrompt 가 별도 부착).
 */
export function formatTriggerMessage(entry: ScheduleEntry, executedAt: Date): string {
	const cond = entry.condition
		? `\n[조건부 스케줄] 조건: "${entry.condition}"\n이 조건을 먼저 평가하세요 — 반드시 명백한 사실(객관적 팩트)을 web_search 등 도구로 확인. 추측이나 주관적 판단 금지.\n- 확실히 참으로 확인됨: 아래 지시에 따라 정상 응답.\n- 확실히 거짓으로 확인됨: 조건이 맞지 않아 수행할 행동이 없음. 응답으로 {"message":"","buttons":{},"noResponse":true} 반환 (응답 폐기됨, 사용자에게 표시/알림 없음).\n- 확인 불가(도구 실패, 정보 부족 등): 사용자에게 상황을 알리는 정상 응답(예: "조건을 확인할 수 없어요: <이유>. 스케줄을 수정해주세요.").`
		: "";
	return `[예약 스케줄 실행] id: ${entry.id} · cron: ${entry.cron} · ${executedAt.toLocaleString("ko-KR")}${cond}\n이 메시지는 위 예약 스케줄이 실행된 것입니다. 아래 지시에 따라 응답하세요.\n\n[응답 형식] 반드시 단일 JSON 객체 — {"message":"...","buttons":{...}}. 코드 펜스/설명 금지.\n[반복 여부 — 필수] 매 응답에 "repeat":true 또는 "repeat":false 포함.\n- repeat:true: 계속 반복(스케줄 유지). 지속 반복형이거나 아직 목적 미달성 시.\n- repeat:false: 완료(스케줄 자동 제거). 목적 달성형에서 목표 이룬 경우.\n프롬프트 지시와 현재 상황을 보고 판단하세요.\n\n${entry.prompt}\n`;
}

// ── 목록 텍스트 포맷 ────────────────────────────────────────────────────
/**
 * list() 결과를 사용자에게 보여줄 텍스트 포맷.
 */
export function formatListText(entries: ScheduleEntry[]): string {
	let text = `[현재 스케줄 목록 (${MAX_SCHEDULES}개 중 ${entries.length}개 활성)]\n`;
	for (const e of entries) {
		const preview = e.prompt.slice(0, 30);
		const cond = e.condition ? ` [조건: ${e.condition}]` : "";
		text += `- ${e.id}: cron "${e.cron}"${cond} — "${preview}${e.prompt.length > 30 ? "..." : ""}"\n`;
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
	handle(cmd: { action: string; id?: string; cron?: string; prompt?: string; condition?: string }): ScheduleResult {
		switch (cmd.action) {
			case "add":
				return this.add(cmd.id ?? "", cmd.cron ?? "", cmd.prompt ?? "", cmd.condition);
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
	add(id: string, cron: string, prompt: string, condition?: string): ScheduleResult {
		if (!id) {
			return { success: false, error: "id가 필요합니다" };
		}
		const parsed = parseCron(cron);
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
			cron,
			prompt,
			condition,
			timer: null,
			nextRun: now + parsed.ms,
		};

		entry.timer = setTimeout(() => this.trigger(id), parsed.ms);
		this.schedules.set(id, entry);

		return { success: true, data: { id, cron, nextRun: entry.nextRun } };
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

	// ── 전체 제거 ──────────────────────────────────────────────────────
	clear(): ScheduleResult {
		for (const entry of this.schedules.values()) {
			if (entry.timer) clearTimeout(entry.timer);
		}
		const count = this.schedules.size;
		this.schedules.clear();
		this.queue = [];
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

	// ── 내부: 트리거 실행 (cron 기반 — 실행 후 다음 시각 재예약) ─────────
	private trigger(id: string): void {
		const entry = this.schedules.get(id);
		if (!entry) return; // 제거된 스케줄

		// 백엔드 busy 시 큐에 적재 (재예약은 계속 진행)
		if (this.opts.isBusy()) {
			if (this.queue.length < MAX_SCHEDULES && !this.queue.includes(id)) {
				this.queue.push(id);
			}
		} else {
			this.opts.onTrigger(entry);
		}

		// 다음 cron 실행 시각으로 재예약 (반복)
		const parsed = parseCron(entry.cron);
		if (parsed.error) {
			// cron이 더 이상 유효하지 않으면 제거
			this.remove(id);
			return;
		}
		entry.nextRun = Date.now() + parsed.ms;
		entry.timer = setTimeout(() => this.trigger(id), parsed.ms);
	}
}