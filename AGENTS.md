# AI Turk 에이전트 지침

## 프로젝트 개요

Streamlit 기반 AI UI 컨트롤러. Ollama Cloud API를 직접 호출하여 동적 버튼 그리드를 생성하는 챗봇 인터페이스.

## 기술 스택

- **런타임**: Python 3.13
- **프레임워크**: Streamlit 1.59
- **가상환경**: `.venv/`
- **의존성**: `requirements.txt` (streamlit 단일 패키지)
- **설정**: `.env` (API 키, 베이스 URL, 모델)

## 아키텍처

- `app.py`: 단일 파일 애플리케이션
- `.env`: 런타임 설정 (Git 추적 제외)
- `.env.example`: 설정 템플릿
- `requirements.txt`: pip 의존성

### 통신 흐름

```
사용자 입력 → Streamlit → Ollama Cloud API (/v1/chat/completions)
                              ↓
                          JSON 응답 파싱 → 버튼 그리드 렌더링
```

- `OLLAMA_API_KEY` 설정 시: 직접 API 호출 (빠름, ~6초)
- 미설정 시: `pi` CLI 서브프로세스로 폴백 (~15초)

### 상태 관리

- `st.session_state.messages`: API 모드 대화 히스토리 (시스템 프롬프트 + 사용자/어시스턴트 메시지)
- `st.session_state.session_id`: CLI 폴백 모드 세션 ID
- `st.session_state.current_state`: 현재 버튼 그리드 + 메시지
- `st.session_state.n_rows`, `n_cols`: 그리드 크기

## /start — 의존성 해결 + 서버 실행

```bash
cd ~/ai-turk

# 1. 가상환경 없으면 생성
if [ ! -d .venv ]; then
  python3 -m venv .venv
fi

# 2. 의존성 설치
.venv/bin/pip install -q -r requirements.txt

# 3. .env 없으면 .env.example에서 복사
if [ ! -f .env ]; then
  cp .env.example .env
  echo "⚠️ .env 생성됨 — API 키를 입력하세요: nano .env"
fi

# 4. 기존 서버 중지
fuser -k 8501/tcp 2>/dev/null; sleep 1

# 5. 서버 실행
nohup .venv/bin/streamlit run app.py \
  --server.address 127.0.0.1 \
  --server.headless true \
  --server.port 8501 \
  --server.runOnSave true \
  > /tmp/streamlit.log 2>&1 &

sleep 3
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8501/ | grep -q 200; then
  echo "✅ 서버 실행됨: http://127.0.0.1:8501"
else
  echo "❌ 서버 시작 실패 — /doctor 로 확인"
  cat /tmp/streamlit.log
fi
```

## /stop — 서버 중지

```bash
fuser -k 8501/tcp 2>/dev/null || pkill -f "streamlit run app.py"
echo "✅ 서버 중지됨"
```

## /doctor — 상태 진단

```bash
cd ~/ai-turk

# Python 버전
python3 --version

# 가상환경
[ -d .venv ] && echo "✅ .venv 존재" || echo "❌ .venv 없음 — /start 실행"

# 의존성
.venv/bin/pip show streamlit &>/dev/null && echo "✅ streamlit 설치됨" || echo "❌ streamlit 미설치 — /start 실행"

# .env 설정
[ -f .env ] && echo "✅ .env 존재" || echo "❌ .env 없음 — cp .env.example .env 후 API 키 입력"

# API 키 확인
python3 -c "
import os
from pathlib import Path
for line in (Path('.env').read_text().splitlines() if Path('.env').exists() else []):
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        k, _, v = line.partition('=')
        os.environ.setdefault(k.strip(), v.strip().strip('\"').strip(\"'\"))
key = os.environ.get('OLLAMA_API_KEY', '')
print(f'OLLAMA_API_KEY: {\"✅ 설정됨\" if key else \"❌ 미설정\"}')
print(f'OLLAMA_MODEL: {os.environ.get(\"OLLAMA_MODEL\", \"gemini-3-flash-preview\")}')
print(f'모드: {\"직접 API\" if key else \"pi CLI 폴백\"}')
"

# 포트 상태
if fuser 8501/tcp &>/dev/null; then
  echo "✅ 서버 실행 중 (포트 8501)"
else
  echo "⚪ 서버 미실행 — /start 로 시작"
fi

# API 연결 테스트
if [ -f .env ] && grep -q 'OLLAMA_API_KEY=.\+' .env 2>/dev/null; then
  API_KEY=$(grep '^OLLAMA_API_KEY=' .env | cut -d= -f2 | tr -d "'\"")
  BASE_URL=$(grep '^OLLAMA_BASE_URL=' .env | cut -d= -f2 | tr -d "'\"" | sed 's|/v1$||')
  .venv/bin/python3 -c "
import urllib.request, json
url = '${BASE_URL}/v1/models'
req = urllib.request.Request(url, headers={'Authorization': 'Bearer ${API_KEY}'})
try:
    with urllib.request.urlopen(req, timeout=10) as resp:
        models = json.loads(resp.read())
        print(f'✅ API 연결 성공 — {len(models.get(\"data\", []))}개 모델')
except Exception as e:
    print(f'❌ API 연결 실패: {e}')
"
fi
```

## 코딩 규칙

- 한국어 주석 사용
- `subprocess`, `urllib.request` 등 stdlib 우선 (최소 의존성)
- `.env` 변경 후 서버 재시작 필요
- 모바일 CSS 그리드 오버라이드는 `@media (max-width: 768px)` 내에 작성
- 버튼 그리드 열 수는 `--grid-cols` CSS 변수로 동적 주입

## 트러블슈팅

| 증상 | 원인 | 해결 |
|---|---|---|
| `st.session_state has no attribute "n_cols"` | 서버 재시작 후 세션 초기화 | 브라우저 새로고침 |
| API 호출 시 `[HTTP 401]` | API 키 만료/오류 | `.env`에서 키 확인 |
| `[파싱실패]` | 모델이 JSON 외 텍스트 출력 | 모델 변경 또는 시스템 프롬프트 수정 |
| 모바일에서 버튼 세로 쌓임 | CSS 미적용 | 브라우저 캐시 삭제 후 새로고침 |