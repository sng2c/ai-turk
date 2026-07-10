# AI Turk 에이전트 지침

## 프로젝트 개요

React + Vite + TypeScript 기반 AI UI 컨트롤러. 동적 버튼 그리드를 생성하는 챗봇 인터페이스.
백엔드를 추상화하여 **pi RPC** 와 **Claude Code stream-json** 양쪽을 지원 (`.env`의 `TURK_BACKEND`로 전환).
WebSocket 통신, 세션 컨텍스트 자동 관리, 도구 지원.

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Vite 8 + Tailwind v4 + Pixelact UI
- **폰트**: Neo둥근모 (한글/영문 픽셀 폰트, jsDelivr CDN)
- **백엔드**: Node.js + `ws` (WebSocket) + 백엔드 추상화 (`backend.ts`)
  - `pi` — `pi --mode rpc` (JSONL 프로토콜, 기본)
  - `claude` — `claude -p --input-format/output-format stream-json` (Ollama Anthropic 호환 엔드포인트 경유)
- **통신**: WebSocket (`/ws`) — 실시간 스트리밍 (`text_delta` 이벤트)
- **설정**: `.env` (포트, 백엔드 종류, 모델)
- **제어**: `turkctl` 스크립트 (서버 구동/제어)

## 아키텍처

```
브라우저 (React) ←WebSocket→ Vite 서버 ←stdin/stdout→ 백엔드 (pi | claude)
                                   ↑
                            .env에서 백엔드/모델/API 설정
```

### 백엔드 추상화

`backend.ts` 가 `Backend` 인터페이스를 정의하고 `PiBackend`(패스스루) 와
`ClaudeBackend`(stream-json → pi 이벤트 번역) 를 구현. App.tsx 는 항상
**pi 이벤트 포맷**만 받으므로 백엔드 종류를 의식하지 않는다.

### 핵심: HMR 자동 반영

`npm run dev`는 HMR(Hot Module Replacement)을 지원합니다.
코드 수정 시 **서버 재시작 없이** 브라우저에 자동 반영됩니다.
에이전트가 코드를 고치면 즉시 화면에 적용되므로, 빌드 없이 `turkctl start` 한 번으로 개발합니다.
단, `vite.config.ts`나 `.env` 변경 시에만 Vite 서버가 재시작됩니다.

### 백엔드 프로토콜

- **공통 이벤트 (App.tsx 가 받는 pi 포맷)**: `pi_ready`, `agent_start`, `message_update` (text_delta/thinking_delta), `tool_execution_start/end`, `agent_end`, `pi_exit`
- **pi 명령 (stdin → JSONL)**: `prompt`, `abort`, `new_session`, `set_model`, `get_state` 등
- **claude 백엔드**: 위 명령을 Claude stream-json 입력으로 번역. 런타임 제어(`set_model`/`cycle_thinking_level` 등)는 합성 응답으로 no-op 처리 (Claude Code 는 CLI 플래그 기반)
- **스트리밍**: `text_delta` 이벤트로 실시간 텍스트 출력
- **세션**: `--no-session`/`-p` 모드 (프로세스 생명주기 = 세션)

## /start — 서버 실행

```bash
cd ~/ai-turk
npm install 2>/dev/null
[ -f .env ] || cp .env.example .env
turkctl start
```

### 백엔드 전환 (pi ↔ claude)

`.env` 의 `TURK_BACKEND` 와 관련 변수로 백엔드를 선택. 기본은 `pi`.

**Claude 백엔드 (Ollama Claude 조합)** — `ollama launch claude --model <m>` 와 동등:
```bash
# .env 에 추가/주석해제
TURK_BACKEND=claude
TURK_RPC_MODEL=glm-5.1:cloud        # Ollama 에 pull 된 모델
ANTHROPIC_BASE_URL=http://localhost:11434   # Ollama Anthropic 호환 엔드포인트
ANTHROPIC_AUTH_TOKEN=ollama          # 임의값 (비어두면 subscription 폴백)
```
전환 후 `turkctl restart` (또는 `.env` 변경 시 자동 재시작).
타이틀 옆 `<sub>` 로 백엔드 종류(pi/claude) 가 표시됨.

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

# 기본 상태 (백엔드 종류 표시)
turkctl status

# 백엔드 프로세스
turkctl pi

# WebSocket 연결 테스트
turkctl ws

# 세션 정보
turkctl session

# 환경 확인
node --version
pi --version 2>/dev/null || echo "❌ pi 미설치"
claude --version 2>/dev/null || echo "ℹ️ claude 미설치 (TURK_BACKEND=claude 시에만 필요)"
ollama --version 2>/dev/null || echo "ℹ️ ollama 미설치 (claude 백엔드 시 필요)"
[ -d node_modules ] && echo "✅ node_modules 존재" || echo "❌ npm install 필요"
[ -f .env ] && echo "✅ .env 존재" || echo "❌ .env 없음"
# 현재 백엔드 확인
grep -E "^TURK_BACKEND" .env 2>/dev/null || echo "TURK_BACKEND=pi (기본)"
npx tsc -b --noEmit 2>&1 | tail -3
```

## /logs — 실시간 로그

```bash
turkctl logs
```

## 코딩 규칙

- 한국어 주석 사용
- 프론트엔드: `src/App.tsx` (단일 컴포넌트), `src/tailwind.css` (Tailwind 통합 — App.css 병합됨)
- 백엔드 추상화: `backend.ts` (PiBackend / ClaudeBackend + 번역 로직)
- 서버: `server.ts` (Express 없이 Node.js 내장 http + ws, `createBackend()` 사용)
- 개발 통합: `vite.config.ts` 의 turkPlugin (동일 `createBackend()` 사용 — 중복 없음)
- WebSocket 프로토콜: 백엔드 이벤트를 pi 포맷으로 브로드캐스트, 클라이언트 명령을 백엔드 stdin에 전달
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
| `🟡 pi 시작중` | 백엔드 프로세스 시작 대기 | 몇 초 대기, 안 되면 `turkctl pi` |
| `[파싱실패]` | 모델이 JSON 외 텍스트 출력 | 자가 수정 재시도로 자동 복구 (최대 2회) |
| `EADDRINUSE` | 포트 충돌 | `turkctl restart` |
| 빌드 실패 | TypeScript 에러 | `npx tsc -b --noEmit` |
| CSS 미반영 | HMR 캐시 꼬임 | `turkctl restart` |
| claude 백엔드 응답 없음 | Ollama 미실행/모델 미pull | `ollama serve` + `ollama pull glm-5.1:cloud` |
| claude `Not logged in` | `ANTHROPIC_AUTH_TOKEN` 누락 | `.env`에 `ANTHROPIC_AUTH_TOKEN=ollama` 설정 |