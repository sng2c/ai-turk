// 세션 워크스페이스 파일 서빙 단일 진원 — GET /files/<userKey>/<relpath>의 파싱·판독.
// Node 전용(node:fs/fsp 의존) — server.ts(prod)·vite.config.ts(dev)만 import. 브라우저 번들 금지.
//
// 계약:
// - userKey ↔ DATA_DIR/<userKey>/workspace(또는 TURK_WORKSPACES_ROOT/<userKey>)의 cwd 그대로 매핑.
//   즉 백엔드가 자기 working directory에 쓴 파일이 브라우저에 상대경로로 노출된다
//   (모델 출력 마크다운 `![x](/files/<userKey>/out.svg)` → 인라인 렌더).
// - 검증 3계층: ①userKey 형식(session-core.verifyUserKeyFormat) ②relpath 세그먼트(..·NUL·디코딩 후 슬래시 차단)
//   ③realpath 봉입(symlink로 workspace 밖을 가리켜도 실경로 경계 거부). 소유권·인증은 라우트 계약(server.ts·vite).
// - 스크립트 실행형 타입(text/html·image/svg+xml)은 sandbox 플래그 → 라우트가 Content-Security-Policy: sandbox로
//   응답해야 한다 (모델 생성물의 same-origin 스크립트 봉쇄 — XSS 원천 제거).
import { stat, readFile, realpath } from "node:fs/promises";
import { extname, resolve as presolve, sep, isAbsolute } from "node:path";
import { workspacePath, verifyUserKeyFormat } from "../../session-core.ts";

// 단일 파일 읽기 상한 — 메모리 폭탄 방지(첨부 50MB보다 작음: 세션 산출물 관점 기준)
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 라우트용 MIME — 확장자 → Content-Type. html·svg는 스크립트 실행형(sandbox 헤더 요구). */
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".bmp": "image/bmp",
	".css": "text/css; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8", // markdown — text/html 렌더 방지(스크립트 원천 차단)
	".json": "application/json",
	".csv": "text/csv; charset=utf-8",
	".wasm": "application/wasm",
	".woff2": "font/woff2",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".mp4": "video/mp4",
	".webm": "video/webm",
};

/** 스크립트 실행형 문서 판정 — 라우트가 CSP: sandbox 헤더를 붙여야 하는 타입. */
function needsSandbox(mime: string): boolean {
	return mime.startsWith("text/html") || mime === "image/svg+xml";
}

export interface WorkspaceFileParse {
	userKey: string;
	rel: string; // 워크스페이스(백엔드 cwd) 기준 상대경로 — 슬래시 join, 빈 세그먼트·위험 세그먼트 제거 완료
}
/**
 * URL pathname을 /files/<userKey>/<rel>로 해석. 형식 위반(경로조작 시도 포함)은 null — 라우트가 404/400 마감.
 * pathname은 %인코딩 상태로 들어오므로 세그먼트별로 복원해 검증(전역 decodeURIComponent는 세그먼트 경계를 깬다).
 */
export function parseWorkspaceFilesPath(pathname: string): WorkspaceFileParse | null {
	// 접두어 상수 — 접두어 뒤에 빈 rel만 있어도 디렉토리 요청(파일 아님)이라 그대로 진행해 read 단계에서 거부
	const REST = "/files/".length;
	if (!pathname.startsWith("/files/")) return null;
	const raw = pathname.slice(REST); // "<userKey>/<rel...>"
	const parts = raw.split("/").filter((s) => s.length > 0); // 빈 세그먼트(//·후행 /) 조용히 제거
	if (parts.length === 0) return null;
	let decoded: string[];
	try {
		decoded = parts.map((s) => decodeURIComponent(s)); // 깨진 %시퀀스 — catch로 형식 위반 처리
	} catch {
		return null;
	}
	const [userKey, ...rest] = decoded;
	if (!verifyUserKeyFormat(userKey)) return null;
	if (rest.length === 0) return { userKey, rel: "" }; // userKey 디렉토리 자체 — read 단계에서 notfound
	// relpath 세그먼트 규칙 — 빈·.·..·NUL·디코딩 후 슬래시 거부 (join 뒤 세그먼트 경계가 흐트러지는 것 원천 차단)
	for (const seg of rest) {
		if (!seg || seg === "." || seg === ".." || seg.includes("/") || seg.includes("\\") || seg.includes("\x00") || isAbsolute(seg)) return null;
	}
	return { userKey, rel: rest.join("/") };
}

export type WorkspaceFile =
	| { ok: true; data: Buffer; mime: string; sandbox: boolean }
	| { ok: false; code: "notfound" | "toolarge" | "invalid" };
/**
 * userKey 워크스페이스 내 rel 파일 판독. 미존재·경계 밖·디스크 오류는 ok:false — 라우트가 HTTP 상태로 반영.
 * 경계 검증 2단: ①어휘 resolve(join 근사) 가드 → ②realpath 쌍방 봉입(워크스페이스→파일, symlink 점프 차단).
 */
export async function readWorkspaceFile(userKey: string, rel: string): Promise<WorkspaceFile> {
	if (!rel) return { ok: false, code: "notfound" }; // 디렉토리·빈 rel — 파일만 서빙(index 노출 금지)
	const root = workspacePath(userKey); // 호출시점 env 판독(TURK_WORKSPACES_ROOT 스위칭 — pool.test.ts 계약)
	const abs = presolve(root, rel); // ① 어휘 가드 — rel 검증된 세그먼트라 .. 없음, 이중 방어
	if (!(abs === root || abs.startsWith(root + sep))) return { ok: false, code: "invalid" };
	// ② realpath 봉입 — 루트와 파일이 모두 실존해야 하고, symlink로 벗어난 실경로도 거부
	let realRoot: string;
	try {
		realRoot = await realpath(root);
	} catch {
		return { ok: false, code: "notfound" }; // 워크스페이스 자체 미생성(무발화 세션 등)
	}
	let real: string;
	try {
		real = await realpath(abs);
	} catch {
		return { ok: false, code: "notfound" };
	}
	if (!(real === realRoot || real.startsWith(realRoot + sep))) return { ok: false, code: "invalid" };
	try {
		const s = await stat(real);
		if (!s.isFile()) return { ok: false, code: "notfound" };
		if (s.size > MAX_FILE_BYTES) return { ok: false, code: "toolarge" };
		const data = await readFile(real);
		const mime = MIME[extname(real).toLowerCase()] || "application/octet-stream";
		return { ok: true, data, mime, sandbox: needsSandbox(mime) };
	} catch {
		return { ok: false, code: "notfound" };
	}
}
