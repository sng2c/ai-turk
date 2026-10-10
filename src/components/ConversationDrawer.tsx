/**
 * ConversationDrawer — Phase 3 ChatGPT형 대화 관리 드로어 (사이드바·계정 섹션·비번 모달 단일 파일).
 *
 * 열림 상태는 App이 소유(drawerOpen && 조건부 렌더) — 이 컴포넌트는 마운트 동안만 사는다:
 *  10s 폴링도 unmount와 함께 저절로 해제된다(개별 정리 코드 불필요).
 *
 * 전환 계약: 항목 클릭·새 대화·현재 대화 삭제 모두 location.hash 갱신만 한다 —
 * App의 onHashChange(→ location.reload) 기존 계약을 재사용하며, WS·세션을 절대 건드리지 않는다.
 * (해시가 현재 키와 같으면 App이 리로드를 생략 → 현재 대화 클릭은 노오프, 의도된 동작)
 *
 * AUTH off(dev): /api/me·PATCH/DELETE·/api/passwd 서버가 404 응답(계약) → 계정 섹션은 username 응답이
 * 없어 자동 숨김, 액션은 실패 후 목록 갱신으로 무해 수렴. dev에서 개별 API가 없는 것은 의도된 위임 계약.
 */

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, User, KeyRound, LogOut, X } from "lucide-react";
import { shortUserKey } from "../lib/ukey";

// GET /api/conversations 항목 — session-core ConversationSummary와 필드 계약 동일
interface ConvSummary {
	id: string;
	title: string | null;
	createdAt: number;
	lastActiveAt: number;
	active: boolean;
	streaming: boolean;
	scheduleCount: number;
	backendState: "active" | "dormant" | "starting";
}

interface Props {
	userKey: string; // 현재 대화 — 목록 하이라이트 + 현재 대화 삭제 판정에 사용
	onClose: () => void;
}

export default function ConversationDrawer({ userKey, onClose }: Props) {
	// ── 목록 — 열림(mount) 1회 fetch + 10s 폴링(열려 있는 동안만) + 액션 후 재fetch ──
	const [convs, setConvs] = useState<ConvSummary[]>([]);
	const fetchList = useCallback(async () => {
		try {
			const r = await fetch("/api/conversations");
			if (!r.ok) return;
			const j: unknown = await r.json();
			if (Array.isArray(j)) setConvs(j as ConvSummary[]);
		} catch { /* 무시 — 폴링이 다시 시도 (오프라인 블립에 목록 보존) */ }
	}, []);
	useEffect(() => {
		fetchList();
		const iv = setInterval(() => fetchList(), 10_000);
		return () => clearInterval(iv);
	}, [fetchList]);

	// ── 계정 섹션 — /api/me의 username 응답일 때만 표시 ──
	// AUTH off({ok,auth:"off"})·401·SPA fallthrough(비JSON·HTML)·네트워크 실패 전부 숨김
	const [me, setMe] = useState<string | null>(null);
	useEffect(() => {
		fetch("/api/me").then(async (r) => {
			if (!r.ok) return;
			const j: unknown = await r.json();
			if (j && typeof j === "object" && typeof (j as { username?: unknown }).username === "string" && (j as { username: string }).username) {
				setMe((j as { username: string }).username);
			}
		}).catch(() => { /* 무시 — 익명 취급 (dev) */ });
	}, []);

	// ── 전환·신규 — 해시 갱신 → App의 hashchange→풀리로드 계약 (신규 전환 코드 없음) ──
	const switchTo = (id: string) => { location.hash = "#" + encodeURIComponent(id); };
	const newConversation = () => { location.hash = "#" + crypto.randomUUID(); }; // 기존 "🆕 새 세션"(restart_pi)과 다른 유저키 해시 신규 대화

	// ── 이름 변경 — 인라인 입력 전환 ──
	const [renameId, setRenameId] = useState<string | null>(null);
	const [renameText, setRenameText] = useState("");
	const startRename = (c: ConvSummary) => { setRenameId(c.id); setRenameText(c.title ?? ""); };
	const cancelRename = () => setRenameId(null);
	const commitRename = async () => {
		const id = renameId;
		if (id == null) return;
		const t = renameText.trim();
		if (!t) { cancelRename(); return; } // 빈 이름 — 변경 취소로 취급 (서버는 빈값 허용이나 UX상 유지)
		setRenameId(null);
		try {
			await fetch(`/api/conversations/${encodeURIComponent(id)}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
		} catch { /* 무시 — 목록 재fetch에서 서버 상태 확인 */ }
		fetchList();
	};

	// ── 삭제 — confirm 후 DELETE. 삭제 대상이 현재 대화면 신규 키 해시로 탈출(풀리로드 → 부활 방지) ──
	const [busyId, setBusyId] = useState<string | null>(null);
	const deleteConv = async (id: string) => {
		if (!window.confirm("이 대화를 삭제합니까? 복구 불가")) return;
		setBusyId(id);
		try {
			await fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
		} catch { /* 무시 — 아래 분기가 상태를 결정 */ }
		if (id === userKey) {
			location.hash = "#" + crypto.randomUUID(); // 현재 대화 삭제 — 같은 키 재진입(부활) 차단, 풀리로드
			return;
		}
		setBusyId(null);
		fetchList();
	};

	// ── 로그아웃 — 서버 쿠키 클리어 후 재로드 (AUTH off에도 무해 200) ──
	const logout = async () => {
		try { await fetch("/api/logout", { method: "POST" }); } catch { /* 무시 */ }
		location.reload();
	};

	// ── 비번 모달 상태 ──
	const [pwOpen, setPwOpen] = useState(false);
	const [pwCurrent, setPwCurrent] = useState("");
	const [pwNext, setPwNext] = useState("");
	const [pwConfirm, setPwConfirm] = useState("");
	const [pwMsg, setPwMsg] = useState("");
	const [pwMsgOk, setPwMsgOk] = useState(false);
	const [pwBusy, setPwBusy] = useState(false);
	const openPwModal = () => {
		setPwCurrent(""); setPwNext(""); setPwConfirm(""); setPwMsg(""); setPwMsgOk(false); // 초기화
		setPwOpen(true);
	};
	const closePwModal = () => { if (!pwBusy) setPwOpen(false); };

	const submitPw = async () => {
		if (pwBusy || pwMsgOk) return;
		// 클라이언트 검증 선행 — 통과 서버 검증(400 {error})에서만 문구 출력
		if (pwNext.length < 4) { setPwMsgOk(false); setPwMsg("새 비밀번호는 4자 이상"); return; }
		if (pwNext !== pwConfirm) { setPwMsgOk(false); setPwMsg("새 비밀번호가 일치하지 않습니다"); return; }
		setPwMsg(""); setPwBusy(true);
		try {
			const r = await fetch("/api/passwd", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ current: pwCurrent, next: pwNext }),
			});
			const j: any = await r.json().catch(() => ({}));
			if (r.ok && j.ok) {
				setPwMsgOk(true);
				setPwMsg("변경 완료"); // JWT username 기반 — 세션 유지
				setTimeout(() => { setPwOpen(false); setPwBusy(false); setPwMsgOk(false); setPwMsg(""); }, 1200); // 표시 후 닫기
				return;
			}
			setPwMsg(j?.error || "변경 실패");
		} catch { setPwMsg("네트워크 오류 — 다시 시도해 주세요"); }
		setPwBusy(false);
	};

	return (
		<>
			{/* 뒷판 딤 — 클릭으로 닫기 */}
			<div className="turk-drawer-backdrop" onClick={onClose} />
			<aside className="turk-drawer" role="dialog" aria-label="대화 목록">
				{/* 헤더 — 대화 타이틀 + 새 대화 + 닫기 */}
				<header className="turk-drawer-head">
					<span className="turk-drawer-title">대화</span>
					<button className="turk-drawer-icon-btn" onClick={newConversation} title="새 대화"><Plus className="turk-ico" /></button>
					<button className="turk-drawer-icon-btn" onClick={onClose} title="닫기"><X className="turk-ico" /></button>
				</header>

				{/* 목록 — 최근 활동순(서버 정렬). 항목 = 전환 클릭 영역 + 우측 개별 액션 */}
				<nav className="turk-drawer-list">
					{convs.length === 0 && <div className="turk-drawer-empty">대화가 없습니다<br />+ 버튼으로 새 대화를 시작하세요</div>}
					{convs.map((c) => (renameId === c.id ? (
						// 인라인 이름 변경 — Enter 확정 · Escape 취소 · 포커스 이탈도 확정
						<div key={c.id} className="turk-drawer-row turk-drawer-row-renaming">
							<input
								className="turk-drawer-rename-input"
								value={renameText}
								maxLength={100}
								autoFocus
								onChange={(e) => setRenameText(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") commitRename(); else if (e.key === "Escape") cancelRename(); }}
								onBlur={() => commitRename()}
							/>
						</div>
					) : (
						<div key={c.id} className={"turk-drawer-row" + (c.id === userKey ? " turk-drawer-row-current" : "")}>
							<button className="turk-drawer-item-main" onClick={() => switchTo(c.id)} title={c.title || c.id}>
								<span className="turk-drawer-item-title">{c.title || shortUserKey(c.id)}</span>
								<span className="turk-drawer-badges">
									{c.scheduleCount > 0 && <span className="turk-drawer-sch">⏰{c.scheduleCount}</span>}
									{c.streaming && <span className="turk-drawer-streaming" title="응답 생성 중">▶</span>}
									{c.backendState !== "dormant" && <span className={"turk-dot" + (c.backendState === "starting" ? " turk-dot-starting" : "")} title={c.backendState === "starting" ? "기동 중" : "활성"} />}
								</span>
							</button>
							<button className="turk-drawer-item-btn" disabled={busyId === c.id} onClick={() => startRename(c)} title="이름 변경"><Pencil className="turk-ico" /></button>
							<button className="turk-drawer-item-btn turk-drawer-item-btn-danger" disabled={busyId === c.id} onClick={() => deleteConv(c.id)} title="삭제"><Trash2 className="turk-ico" /></button>
						</div>
					)))}
				</nav>

				{/* 계정 섹션 — username 응답(AUTH on)일 때만 렌더 (dev 익명은 통째로 숨김) */}
				{me && (
					<footer className="turk-drawer-foot">
						<span className="turk-drawer-user"><User className="turk-ico" />{me}</span>
						<button className="turk-drawer-act" onClick={openPwModal}><KeyRound className="turk-ico" />비밀번호 변경</button>
						<button className="turk-drawer-act" onClick={logout}><LogOut className="turk-ico" />로그아웃</button>
					</footer>
				)}

				{/* 비번 모달 — 드로어 내부 오버레이. 입력·버튼은 로그인 페이지(LOGIN_PAGE)와 동일 톤 */}
				{pwOpen && (
					<div className="turk-drawer-pw-overlay" onClick={(e) => { if (e.target === e.currentTarget) closePwModal(); }}>
						<div className="turk-drawer-pw-card" role="dialog" aria-label="비밀번호 변경">
							<header className="turk-drawer-pw-head">
								<span>비밀번호 변경</span>
								<button className="turk-drawer-icon-btn" onClick={closePwModal} title="닫기"><X className="turk-ico" /></button>
							</header>
							<input type="password" autoComplete="current-password" placeholder="현재 비밀번호" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} />
							<input type="password" autoComplete="new-password" placeholder="새 비밀번호 (4자 이상)" value={pwNext} onChange={(e) => setPwNext(e.target.value)} />
							<input type="password" autoComplete="new-password" placeholder="새 비밀번호 확인" value={pwConfirm} onChange={(e) => setPwConfirm(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitPw(); }} />
							<button className="turk-drawer-pw-btn" onClick={submitPw} disabled={pwBusy || pwMsgOk}>{pwMsgOk ? "변경 완료" : pwBusy ? "변경 중..." : "변경"}</button>
							<div className={"turk-drawer-pw-msg" + (pwMsgOk ? " ok" : "")} role="alert">{pwMsg}</div>
						</div>
					</div>
				)}
			</aside>
		</>
	);
}