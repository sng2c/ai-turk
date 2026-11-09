/**
 * tests/workspace-serve.test.ts — 세션 워크스페이스 파일 서빙 단위테스트
 *
 * parseWorkspaceFilesPath (파싱·경로조작 차단) / readWorkspaceFile (경계 검증·MIME·sandbox·상한)
 * 관례: 평문 tsx 스크립트 · ✅/❌ 출력 · 실패 시 exit 1 (pool.test.ts 동일)
 *
 * 격리: TURK_WORKSPACES_ROOT를 임시 dir로 지정 — workspacePath는 호출시점 env 판독 (session-core 계약),
 * 본 테스트는 createSessionCore를 만지지 않으므로 세션·백엔드 오염 없음. 모듈 로드 자체는 무부작용.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync } from "node:fs";
import { parseWorkspaceFilesPath, readWorkspaceFile } from "../src/lib/workspace-serve.ts";

const TMP = mkdtempSync(join(tmpdir(), "ai-turk-wsfiles-"));
process.env.TURK_WORKSPACES_ROOT = TMP; // 호출시점 판독 — readWorkspaceFile이 이 경로를 쓴다

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
	if (cond) { pass++; console.log(`✅ ${name}`); }
	else { fail++; console.log(`❌ ${name} ${detail}`); }
}

// ── 1. 파싱·형식 검증 ────────────────────────────────────────────────────
ok("정상 경로 파싱", JSON.stringify(parseWorkspaceFilesPath("/files/abc123/out.svg")) === JSON.stringify({ userKey: "abc123", rel: "out.svg" }));
ok("서브디렉토리 경로 파싱", parseWorkspaceFilesPath("/files/abc123/sub/a.txt")?.rel === "sub/a.txt");
ok("빈 rel — userKey만", parseWorkspaceFilesPath("/files/abc123")?.rel === "" && parseWorkspaceFilesPath("/files/abc123/")?.rel === "");
ok("중복 슬래시 흡수", parseWorkspaceFilesPath("/files/abc123//x.png")?.rel === "x.png");
ok("%인코딩 복원", parseWorkspaceFilesPath("/files/abc123/my%20file.svg")?.rel === "my file.svg");
ok("슬래시 없는 경로 거부", parseWorkspaceFilesPath("/files") === null);
ok("userKey 누락 거부", parseWorkspaceFilesPath("/files/") === null);
ok("userKey 형식 위반 거부(제어문자)", parseWorkspaceFilesPath("/files/a%01b/out.svg") === null);
ok(".. 세그먼트 거부(어휘)", parseWorkspaceFilesPath("/files/abc123/../secret.txt") === null);
ok("%2E%2E 인코딩 .. 거부", parseWorkspaceFilesPath("/files/abc123/%2E%2E/secret.txt") === null);
ok(". 세그먼트 거부", parseWorkspaceFilesPath("/files/abc123/./x.png") === null);
ok("NUL 세그먼트 거부", parseWorkspaceFilesPath("/files/abc123/x%00.png") === null);
ok("디코딩 후 슬래시 세그먼트 거부", parseWorkspaceFilesPath("/files/abc123/a%2Fb.png") === null);
ok("절대 경로 세그먼트 거부", parseWorkspaceFilesPath("/files/abc123/%2Fetc%2Fpasswd") === null);
ok("깨진 %시퀀스 거부", parseWorkspaceFilesPath("/files/abc123/x%zz.png") === null);
ok("접두어 불일치 거부", parseWorkspaceFilesPath("/other/abc123/x.png") === null);

// ── 2. 판독·경계 검증 (실제 fs) ──────────────────────────────────────────
const KEY = "convkey1";
const wsDir = join(TMP, KEY);
mkdirSync(wsDir, { recursive: true });
writeFileSync(join(wsDir, "out.svg"), `<svg xmlns="http://www.w3.org/2000/svg"></svg>`, "utf8");
writeFileSync(join(wsDir, "big.bin"), "data", "utf8");
mkdirSync(join(wsDir, "sub"), { recursive: true });
writeFileSync(join(wsDir, "sub", "report.csv"), "a,b\n1,2", "utf8");
// 워크스페이스 밖 비밀 파일 — symlink 탈출 시도 원료
writeFileSync(join(TMP, "secret.txt"), "top-secret", "utf8");

const svg = await readWorkspaceFile(KEY, "out.svg");
ok("정상 파일 판독", svg.ok === true && svg.data.toString("utf8").includes("svg"));
ok("SVG mime+sandbox", svg.ok === true && svg.mime === "image/svg+xml" && svg.sandbox === true);

const csv = await readWorkspaceFile(KEY, join("sub", "report.csv"));
ok("서브디렉토리 판독+mime", csv.ok === true && csv.mime === "text/csv; charset=utf-8" && csv.sandbox === false);

ok("미존재 파일 notfound", (await readWorkspaceFile(KEY, "ghost.bin")).ok === false && (await readWorkspaceFile(KEY, "ghost.bin")).code === "notfound");
ok("빈 rel 거부", (await readWorkspaceFile(KEY, "")).code === "notfound");
ok("미존재 세션 workspace notfound", (await readWorkspaceFile("nosuchconv", "x.png")).code === "notfound");

// symlink 탈출 차단 — 워크스페이스 안의 링크가 밖(secret.txt)을 가리켜도 실경로 경계 거부
try {
	symlinkSync(join(TMP, "secret.txt"), join(wsDir, "leak.txt"));
	const leak = await readWorkspaceFile(KEY, "leak.txt");
	ok("symlink 탈출 거부", leak.ok === false && leak.code === "invalid");
} catch (e) {
	console.log(`(symlink 생성 미지원 — 이 케이스 스킵) ${e instanceof Error ? e.message : e}`);
}

// 어휘가드 이중 방어 — 세그먼트 검증을 통과한 것처럼 조합된 절대 밖 경로도 invalid
ok("어휘 가드 밖 경로 거부", (await readWorkspaceFile(KEY, join("..", "secret.txt"))).code === "invalid");

// ── 3. 사용자 커스텀 AGENTS.md 섹션 적용 (agents-md-server) ───────────────
{
	const { ensureAgentsMd, applyFilesSection, applyEnvSection } = await import("../src/lib/agents-md-server.ts");
	const { FILES_SECTION_OPEN, FILES_SECTION_CLOSE, ENV_SECTION_OPEN } = await import("../src/lib/agents-md.ts");
	const p = join(TMP, "agents.md");
	ensureAgentsMd(p, () => {});
	const before = readFileSync(p, "utf8");
	ok("템플릿에 files 마커 포함(말미 추가 가능 상태)", applyFilesSection(p, KEY, () => {}));
	const after = readFileSync(p, "utf8");
	// 마커 쌍은 템플릿에 없으므로 말미에 추가되어야 한다
	ok("files 섹션 추가", after.includes(FILES_SECTION_OPEN) && after.includes(FILES_SECTION_CLOSE) && after.includes(`/files/${KEY}/`));
	ok("files 섹션 불변 재적용 no-op", applyFilesSection(p, KEY, () => {}) && readFileSync(p, "utf8") === after);
	// env 섹션과 독립 섹션 — 서로 파괴하지 않는다
	ok("env 섹션 병존", applyEnvSection(p, ["MY_TOKEN"], () => {}) && readFileSync(p, "utf8").includes("MY_TOKEN") && readFileSync(p, "utf8").includes(`/files/${KEY}/`));
	ok("env 열기전 마커 순서(env가 먼저)", readFileSync(p, "utf8").indexOf(ENV_SECTION_OPEN) < readFileSync(p, "utf8").indexOf(FILES_SECTION_OPEN));
	ok("userKey별 내용 교체 — 다른 키로 갱신", applyFilesSection(p, "convkey2", () => {}) && readFileSync(p, "utf8").includes("/files/convkey2/") && !readFileSync(p, "utf8").includes(`/files/${KEY}/`));
	void before;
}

// ── 마무리 ────────────────────────────────────────────────────────────────
rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
