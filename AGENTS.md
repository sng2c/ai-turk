# AI Turk 에이전트 지침

## 프로젝트 개요

React + Vite + TypeScript 기반 AI UI 컨트롤러. 동적 버튼 그리드를 생성하는 챗봇 인터페이스.
`pi --mode rpc`를 영구 백엔드로 사용 (WebSocket 통신, 세션 컨텍스트 자동 관리, 도구 지원).

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Vite 8 + Tailwind v4 + Pixelact UI
- **폰트**: Neo둥근모 (한글/영문 픽셀 폰트, jsDelivr CDN)
- **백엔드**: Node.js + `ws` (WebSocket) + `pi --mode rpc` (JSONL 프로토콜)
- **통신**: WebSocket (`/ws`) — 실시간 스트리밍 (`text_delta` 이벤트)
- **설정**: `.env` (포트, 모델)
- **제어**: `turkctl` 스크립트 (서버 구동/제어)

## 아키텍처

```
브라우저 (React) ←WebSocket→ Vite 서버 ←stdin/stdout→ pi --mode rpc
                                   ↑
                            .env에서 모델/API 설정
```

### 핵심: HMR 자동 반영

`npm run dev`는 HMR(Hot Module Replacement)을 지원합니다.
코드 수정 시 **서버 재시작 없이** 브라우저에 자동 반영됩니다.
에이전트가 코드를 고치면 즉시 화면에 적용되므로, 빌드 없이 `turkctl start` 한 번으로 개발합니다.
단, `vite.config.ts`나 `.env` 변경 시에만 Vite 서버가 재시작됩니다.

### pi RPC 프로토콜

- **명령 (stdin → JSONL)**: `prompt`, `abort`, `new_session`, `set_model`, `bash` 등
- **이벤트 (stdout → JSONL)**: `agent_start`, `message_update` (text_delta), `agent_end` 등
- **스트리밍**: `text_delta` 이벤트로 실시간 텍스트 출력
- **세션**: `--no-session` 모드 (프로세스 생명주기 = 세션)

## /start — 서버 실행

```bash
cd ~/ai-turk
npm install 2>/dev/null
[ -f .env ] || cp .env.example .env
turkctl start
```

## /stop — 서버 중지

```bash
turkctl stop
```

## /restart — 서버 재시작

```bash
turkctl restart
```

## /doctor — 상태 진단

```bash
cd ~/ai-turk

# 기본 상태
turkctl status

# pi 프로세스
turkctl pi

# WebSocket 연결 테스트
turkctl ws

# 세션 정보
turkctl session

# 환경 확인
node --version
pi --version 2>/dev/null || echo "❌ pi 미설치"
[ -d node_modules ] && echo "✅ node_modules 존재" || echo "❌ npm install 필요"
[ -f .env ] && echo "✅ .env 존재" || echo "❌ .env 없음"
npx tsc -b --noEmit 2>&1 | tail -3
```

## /logs — 실시간 로그

```bash
turkctl logs
```

## 코딩 규칙

- 한국어 주석 사용
- 프론트엔드: `src/App.tsx` (단일 컴포넌트), `src/App.css`
- 백엔드: `server.ts` (Express 없이 Node.js 내장 http + ws)
- WebSocket 프로토콜: pi 이벤트를 그대로 브로드캐스트, 클라이언트 명령을 pi stdin에 전달
- **코드 수정 후 재시작 불필요** — HMR로 자동 반영
- `vite.config.ts`나 `.env` 변경 시에만 `turkctl restart` 필요

## turkctl 명령어

```
turkctl start     # 개발 서버 시작 (npm run dev, 백그라운드, HMR)
turkctl stop      # 서버 및 pi 프로세스 종료
turkctl restart   # 서버 재시작
turkctl status    # 실행 상태 + 헬스체크
turkctl logs      # 실시간 로그 (tail -f)
turkctl session    # 현재 세션 정보 조회
turkctl ws        # WebSocket 연결 테스트
turkctl pi        # pi RPC 프로세스 상태
turkctl build     # 프로덕션 빌드 → dist/
```

> **원칙**: 항상 `turkctl`로 구동 제어. 직접 `npm run dev`나 `pkill` 사용 금지.

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `🔴 연결 끊김` | 서버 미실행 | `turkctl start` |
| `🟡 pi 시작중` | pi 프로세스 시작 대기 | 몇 초 대기, 안 되면 `turkctl pi` |
| `[파싱실패]` | 모델이 JSON 외 텍스트 출력 | 시스템 프롬프트 수정 또는 `--no-tools` |
| `EADDRINUSE` | 포트 충돌 | `turkctl restart` |
| 빌드 실패 | TypeScript 에러 | `npx tsc -b --noEmit` |
| CSS 미반영 | HMR 캐시 꼬임 | `turkctl restart` |