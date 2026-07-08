# AI Turk 에이전트 지침

## 프로젝트 개요

React + Vite + TypeScript 기반 AI UI 컨트롤러. 동적 버튼 그리드를 생성하는 챗봇 인터페이스.
`pi --mode rpc`를 영구 백엔드로 사용 (WebSocket 통신, 세션 컨텍스트 자동 관리, 도구 지원).

## 기술 스택

- **프론트엔드**: React 19 + TypeScript + Vite 8
- **백엔드**: Node.js + `ws` (WebSocket) + `pi --mode rpc` (JSONL 프로토콜)
- **통신**: WebSocket (`/ws`) — 실시간 스트리밍 (`text_delta` 이벤트)
- **설정**: `.env` (백엔드), `.env.local` (Vite 개발 서버)

## 아키텍처

```
브라우저 (React) ←WebSocket→ 백엔드 서버 ←stdin/stdout→ pi --mode rpc
                                   ↑
                            .env에서 모델/API 설정
```

### pi RPC 프로토콜

- **명령 (stdin → JSONL)**: `prompt`, `abort`, `new_session`, `set_model`, `bash` 등
- **이벤트 (stdout → JSONL)**: `agent_start`, `message_update` (text_delta), `agent_end` 등
- **스트리밍**: `text_delta` 이벤트로 실시간 텍스트 출력
- **세션**: `--no-session` 모드 (프로세스 생명주기 = 세션)

### 상태 관리 (React)

- `state`: 현재 버튼 그리드 + 메시지 (`{message, buttons}`)
- `streamingText`: `text_delta` 누적 (실시간 표시)
- `toolStatus`: 도구 실행 상태 (`{name, args}`)
- `sessionInitRef`: 시스템 지시 전송 여부 (첫 메시지에만 포함)
- `connected`, `piReady`: WebSocket/pi 연결 상태

### 시스템 지시

- 세션 첫 메시지에만 시스템 지시 포함 (JSON 버튼 그리드 형식)
- 이후 메시지는 사용자 입력만 전송 — pi가 컨텍스트 유지
- 그리드 변경 시 `new_session`으로 리셋 → 다시 첫 메시지에 시스템 지시 포함

## /start — 의존성 해결 + 서버 실행

```bash
cd ~/ai-turk

# 1. 의존성 설치
npm install

# 2. .env 없으면 생성
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️ .env 생성됨 — 필요시 수정: nano .env"
fi

# 3. 기존 서버 중지
pkill -f "tsx server.ts" 2>/dev/null; fuser -k 3001/tcp 2>/dev/null; sleep 1

# 4. 백엔드 서버 실행 (pi RPC + WebSocket)
nohup npx tsx server.ts > /tmp/ai-turk-server.log 2>&1 &

sleep 4

# 5. 개발 모드: Vite도 실행 (프론트엔드 + WebSocket 프록시)
# 프로덕션 모드: 백엔드가 dist/ 정적 파일 서빙
if [ ! -d dist ]; then
  nohup npm run dev > /tmp/ai-turk-vite.log 2>&1 &
  sleep 3
  PORT=3000
else
  PORT=3001
fi

if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/" | grep -q 200; then
  echo "✅ 서버 실행됨: http://127.0.0.1:$PORT"
  echo "   백엔드: http://127.0.0.1:3001"
  echo "   WebSocket: ws://127.0.0.1:$PORT/ws"
else
  echo "❌ 서버 시작 실패 — /doctor 로 확인"
  cat /tmp/ai-turk-server.log
  cat /tmp/ai-turk-vite.log 2>/dev/null
fi
```

## /stop — 서버 중지

```bash
pkill -f "tsx server.ts" 2>/dev/null
pkill -f "vite" 2>/dev/null
fuser -k 3000/tcp 2>/dev/null; fuser -k 3001/tcp 2>/dev/null
echo "✅ 서버 중지됨"
```

## /doctor — 상태 진단

```bash
cd ~/ai-turk

# Node 버전
node --version

# pi 버전
pi --version 2>/dev/null || echo "❌ pi 미설치"

# 의존성
[ -d node_modules ] && echo "✅ node_modules 존재" || echo "❌ npm install 필요"

# .env
[ -f .env ] && echo "✅ .env 존재" || echo "❌ .env 없음 — cp .env.example .env"

# TypeScript 컴파일
npx tsc -b --noEmit 2>&1 | tail -3

# 백엔드 상태
if curl -s http://127.0.0.1:3001/api/health 2>/dev/null | grep -q '"ok":true'; then
  echo "✅ 백엔드 실행 중"
  curl -s http://127.0.0.1:3001/api/health
  echo
else
  echo "⚪ 백엔드 미실행 — npx tsx server.ts"
fi

# 프론트엔드 상태
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ 2>/dev/null | grep -q 200; then
  echo "✅ Vite 개발 서버 실행 중 (포트 3000)"
fi
```

## 코딩 규칙

- 한국어 주석 사용
- 프론트엔드: `src/App.tsx` (단일 컴포넌트), `src/App.css`
- 백엔드: `server.ts` (Express 없이 Node.js 내장 http + ws)
- WebSocket 프로토콜: pi 이벤트를 그대로 브로드캐스트, 클라이언트 명령을 pi stdin에 전달
- `.env` 변경 후 백엔드 재시작 필요

## 개발 명령

```bash
npm run dev        # Vite 개발 서버 (포트 3000, /ws 프록시 → 3001)
npm run server     # 백엔드 서버 (포트 3001, pi RPC + WebSocket)
npm run dev:full   # Vite + 백엔드 동시 실행
npm run build      # 프로덕션 빌드 → dist/
npm start          # 프로덕션 서버 (백엔드가 dist/ 서빙 + WebSocket)
```

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `🔴 연결 끊김` | 백엔드 미실행 | `npm run server` |
| `🟡 pi 시작중` | pi 프로세스 시작 대기 | 몇 초 대기, 안 되면 `/doctor` |
| `[파싱실패]` | 모델이 JSON 외 텍스트 출력 | 시스템 프롬프트 수정 또는 `--no-tools` |
| `EADDRINUSE` | 포트 충돌 | `fuser -k 3001/tcp` 후 재시작 |
| 빌드 실패 | TypeScript 에러 | `npx tsc -b --noEmit` |