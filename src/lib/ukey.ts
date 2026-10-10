// userKey 표시 유틸 — 서버(server.ts)·빌드(vite.config.ts)·클라(turk.tsx) 공용 순수 함수.
// 브라우저/DOM 의존 없음.

// ── userKey 축약 — UUID형(36자 랜덤키)은 첫 8자, 사용자 지정 해시명("mom" 등)은 그대로.
//    드로어 목록·푸시 폴백 제목 등 짧은 식별자가 필요한 곳에 사용.
//    탭 타이틀은 261010부터 "AI Turk" 고정 (루트 즐겨찾기 — 대화 식별은 드로어·푸시 별명 담당).
export function shortUserKey(key: string): string {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key) ? key.slice(0, 8) : key;
}