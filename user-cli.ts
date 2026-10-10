/**
 * user-cli.ts — AI Turk 계정 관리 CLI (Phase 2) — turkctl user 서브커맨드 위임 대상.
 *
 * 사용법: turkctl user <명령>
 *   add <name>              계정 추가 — 비밀번호 2회 입력 확인
 *   passwd <name>           비밀번호 변경 — 2회 입력 확인
 *   rm <name>               계정 삭제 (소유 대화는 고아화 — 남이 첫 접속 시 claim 가능해짐 주의)
 *   list                    계정 목록 — 소유 userKeys · 생성시각
 *   claim <name> <userKey>  대화를 계정에 귀속 — orphan만 성공 (남의 소 foreign 거부)
 *
 * 저장: DATA_DIR/users.json (0o600) — auth.ts 헬퍼 재사용 (해시·claim 규칙 단일 진원).
 * 시크릿·해시·토큰 값을 출력하지 않는다.
 * 입력: node:fs readSync 차단 판독 — TTY(대화형)·파이프(printf | turkctl user add ...) 겸용.
 * (readline/promises는 파이프 입력에서 question 프라미스가 미정착되는 퀴크 있음 — Termux node 22 재현)
 */

import { readSync } from "node:fs";
import {
	loadUsers,
	saveUsers,
	hashPassword,
	verifyPassword,
	checkConversation,
	claimConversation,
} from "./auth.ts";

const usage = (): never => {
	console.error(`사용법: turkctl user <명령>
  add <name>              계정 추가 (비밀번호 2회 확인)
  passwd <name>           비밀번호 변경
  rm <name>               계정 삭제
  list                    계정 목록
  claim <name> <userKey>  고아 대화 귀속 (남의 소 foreign 거부)`);
	process.exit(1);
};

/** 종료 1로 즉시 마감 — never 반환으로 호출 이후 흐름을 TS narrowing에도 명시 (선언형 함수여야 확실히 적용). */
function die(msg: string): never {
	console.error(`❌ ${msg}`);
	process.exit(1);
}

/** stdin에서 1줄 차단 판독 — 바이트 누적 후 완성 시점 UTF-8 디코드 (멀티바이트 안전). EOF → null. */
function readLine(): string | null {
	const bytes: number[] = [];
	const buf = Buffer.alloc(1);
	while (true) {
		let n: number;
		try { n = readSync(0, buf, 0, 1, null); } catch { break; } // 판독 오류 — 지금까지 입력으로 마감
		if (n === 0) break; // EOF
		if (buf[0] === 0x0a) return Buffer.from(bytes).toString("utf8").replace(/\r$/, ""); // CRLF 제거
		bytes.push(buf[0]);
		if (bytes.length > 4096) return null; // 입력 과다 방어
	}
	return bytes.length ? Buffer.from(bytes).toString("utf8").replace(/\r$/, "") : null;
}

/** 프롬프트 출력 후 1줄 판독 — EOF면 종료 (조용한 부분입력 수용 금지). */
function ask(prompt: string): string {
	process.stdout.write(prompt);
	const line = readLine();
	if (line === null) die("입력이 끊겼습니다 (EOF)");
	return line;
}

/** 비밀번호 2회 입력 확인 — 불일치·빈값은 즉시 종료. */
function askPasswords(prompt: string): string {
	const pw1 = ask(`${prompt}: `);
	const pw2 = ask(`${prompt} (확인): `);
	if (!pw1) die("비밀번호가 비어 있습니다");
	if (pw1 !== pw2) die("비밀번호 불일치 — 다시 시도하세요");
	return pw1;
}

function main(): void {
	const [cmd, name, userKey, ...rest] = process.argv.slice(2);
	const users = loadUsers();

	if (cmd === "add") {
		if (!name || rest.length) usage();
		if (users.accounts[name]) die(`이미 존재하는 계정: ${name}`);
		if (name.length > 100) die("계정명이 너무 깁니다 (최대 100자)");
		const pw = askPasswords("비밀번호");
		users.accounts[name] = { ...hashPassword(pw), userKeys: [], createdAt: Date.now() };
		saveUsers(users);
		console.log(`✅ 계정 추가 완료: ${name}`);
		return;
	}

	if (cmd === "passwd") {
		if (!name || rest.length) usage();
		const acc = users.accounts[name];
		if (!acc) die(`계정 없음: ${name}`);
		const pw = askPasswords("새 비밀번호");
		if (verifyPassword(pw, acc)) die("기존 비밀번호와 동일합니다");
		// userKeys·createdAt 보존 — 인증 자격(salt/hash)만 교체
		users.accounts[name] = { ...acc, ...hashPassword(pw) };
		saveUsers(users);
		console.log(`✅ 비밀번호 변경 완료: ${name}`);
		return;
	}

	if (cmd === "rm") {
		if (!name || rest.length) usage();
		if (!users.accounts[name]) die(`계정 없음: ${name}`);
		delete users.accounts[name];
		saveUsers(users);
		console.log(`✅ 계정 삭제 완료: ${name} — 소유 대화는 고아화 (남이 첫 접속 시 자동 claim 가능해짐 주의)`);
		return;
	}

	if (cmd === "list") {
		if (name) usage();
		const names = Object.keys(users.accounts).sort();
		console.log(`계정 ${names.length}개:`);
		for (const n of names) {
			const a = users.accounts[n];
			const keys = Array.isArray(a.userKeys) ? a.userKeys : [];
			console.log(`  ${n} — 대화 ${keys.length}개 [${keys.join(", ") || "-"}] (${new Date(a.createdAt).toISOString().slice(0, 10)})`);
		}
		return;
	}

	if (cmd === "claim") {
		if (!name || !userKey || rest.length) usage();
		if (!users.accounts[name]) die(`계정 없음: ${name}`);
		const rel = checkConversation(name, userKey);
		if (rel === "foreign") die("거부 — 다른 계정이 소유한 대화입니다");
		if (rel === "own") {
			console.log(`ℹ️  이미 귀속된 대화 — 변경 없음: ${name} ← ${userKey}`);
			return;
		}
		const r = claimConversation(name, userKey); // orphan 귀속 — auth.ts 단일 진원
		if (!r) die("거부 — 귀속 실패 (계정 상태 확인 필요)");
		console.log(`✅ 귀속 완료: ${name} ← ${userKey}`);
		return;
	}

	usage();
}

try {
	main();
} catch (e: unknown) {
	console.error(`❌ ${e instanceof Error ? e.message : e}`);
	process.exit(1);
}