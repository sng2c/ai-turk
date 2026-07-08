# AI Turk 에이전트 지침

## 프로젝트 개요

React + Vite + TypeScript 기반 AI UI 컨트롤러. 동적 버튼 그리드를 생성하는 챗봇 인터페이스.
Ollama Cloud API를 Vite 프록시로 호출 (API 키 서버 측 주입).

## 기술 스택

- **프레임워크**: React 19 + TypeScript
- **빌드**: Vite 8
- **API**: Vite dev server proxy → Ollama Cloud (`/api/chat/completions`)
- **설정**: `.env.local` (VITE_OLLAMA_API_KEY, VITE_OLLAMA_BASE_URL, VITE_OLLAMA_MODEL)

## 아키텍처

```
브라우저 (React) → /api/chat/completions → Vite proxy → Ollama Cloud API
                                              ↑
                                    .env.local에서 API 키 주입
```

- 프론트엔드에 API 키 노출 없음 (Vite 프록시가 `Authorization` 헤더 주입)
- 대화 히스토리: `messages` 상태 배열로 관리 (시스템 프롬프트 + 사용자/어시스턴트)
- JSON 파싱: 응답에서 `{...}` 추출 후 `JSON.parse`

### 상태 관리

- `messages`: 대화 히스토리 (첫 호출 시 시스템 프롬프트 포함)
- `state`: 현재 버튼 그리드 + 메시지 (`{message, buttons}`)
- `rows`, `cols`: 그리드 크기
- `initialized`: 시스템 프롬프트 전송 여부

## /start — 의존성 해결 + 서버 실행

```bash
cd ~/ai-turk

# 1. 의존성 설치
npm install

# 2. .env.local 없으면 생성
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "⚠️ .env.local 생성됨 — API 키를 입력하세요: nano .env.local"
fi

# 3. 기존 서버 중지
fuser -k 3000/tcp 2>/dev/null; sleep 1

# 4. 개발 서버 실행
nohup npm run dev > /tmp/ai-turk.log 2>&1 &

sleep 3
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/ | grep -q 200; then
  echo "✅ 서버 실행됨: http://127.0.0.1:3000"
else
  echo "❌ 서버 시작 실패 — /doctor 로 확인"
  cat /tmp/ai-turk.log
fi
```

## /stop — 서버 중지

```bash
fuser -k 3000/tcp 2>/dev/null || pkill -f "vite"
echo "✅ 서버 중지됨"
```

## /doctor — 상태 진단

```bash
cd ~/ai-turk

# Node 버전
node --version

# 의존성
[ -d node_modules ] && echo "✅ node_modules 존재" || echo "❌ npm install 필요"

# .env.local
[ -f .env.local ] && echo "✅ .env.local 존재" || echo "❌ .env.local 없음 — cp .env.example .env.local"

# 설정값
grep -q 'VITE_OLLAMA_API_KEY=.\+' .env.local 2>/dev/null && echo "✅ API 키 설정됨" || echo "❌ API 키 미설정"

# 빌드 테스트
npm run build 2>&1 | tail -3

# 포트 상태
if fuser 3000/tcp &>/dev/null; then
  echo "✅ 서버 실행 중 (포트 3000)"
else
  echo "⚪ 서버 미실행 — /start 로 시작"
fi

# API 연결 테스트
if [ -f .env.local ] && grep -q 'VITE_OLLAMA_API_KEY=.\+' .env.local 2>/dev/null; then
  API_KEY=$(grep '^VITE_OLLAMA_API_KEY=' .env.local | cut -d= -f2 | tr -d "'\"")
  BASE_URL=$(grep '^VITE_OLLAMA_BASE_URL=' .env.local | cut -d= -f2 | tr -d "'\"" | sed 's|/$||')
  curl -s -o /dev/null -w "API 상태: %{http_code}" -H "Authorization: Bearer $API_KEY" "$BASE_URL/v1/models" 2>/dev/null
  echo
fi
```

## 코딩 규칙

- 한국어 주석 사용
- 컴포넌트는 `src/` 아래 단일 파일 유지
- CSS는 `src/App.css` (글로벌 스타일, CSS 변수 사용)
- API 호출은 항상 `/api/chat/completions` (Vite 프록시가 `/v1/chat/completions`으로 변환)
- `.env.local` 변경 후 서버 재시작 필요

## 프로덕션 빌드

```bash
npm run build    # dist/ 에 빌드
npm run preview  # 프로덕션 빌드 로컬 프리뷰
```

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `[HTTP 401]` | API 키 오류 | `.env.local`에서 키 확인 |
| `[파싱실패]` | 모델이 JSON 외 텍스트 출력 | 모델 변경 또는 시스템 프롬프트 수정 |
| 프록시 에러 | Vite 프록시 설정 오류 | `vite.config.ts`에서 target 확인 |
| 빌드 실패 | TypeScript 에러 | `npx tsc -b` 로 타입 체크 |