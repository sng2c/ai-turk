// userKey 표시 유틸 — 서버(server.ts)·빌드(vite.config.ts)·클라(turk.tsx) 공용 순수 함수.
// 브라우저/DOM 의존 없음.

// ── userKey 축약 — UUID형(36자 랜덤키)은 첫 8자, 사용자 지정 해시명("mom" 등)은 그대로.
//    탭 타이틀·A2HS 홈스크린 라벨은 짧아야 읽히므로 UUID 전체 대신 식별 가능한 접두만 노출.
export function shortUserKey(key: string): string {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(key) ? key.slice(0, 8) : key;
}

// ── A2HS(홈스크린 설치) 라벨·탭 타이틀 조합 — userid가 포함된 앱 이름
export function userTitle(key: string): string {
	// 주소창 해시(#<userKey>)와 동일 표기 — 알림→딥링크 연상 직관화
	return `AI Turk #${shortUserKey(key)}`;
}