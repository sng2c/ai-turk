#!/usr/bin/env bash
# scripts/deploy.sh — prod 배포 자동화 (cron 자동/수동 겸용)
#
# 사용법: scripts/deploy.sh [--auto]
#   --auto : cron용 — origin/main과 동일 HEAD면 즉시 조용히 exit 0 (로그 불남김)
#   기본   : 수동 — 로그 항상 출력
#
# cron 등록 예: */10 * * * * cd ~/ai-turk && ./scripts/deploy.sh --auto >> deploy.log 2>&1
# 로그는 표준 출력, 에러는 표준 에러 → cron 리다이렉트로 함께 수집된다 (deploy.log는 gitignore).

set -euo pipefail

# ── 인자 해석 ──
AUTO=0
case "${1:-}" in
  "") ;;
  --auto) AUTO=1 ;;
  *) echo "에러: 알 수 없는 인자 '$1' — 사용법: scripts/deploy.sh [--auto]" >&2; exit 1 ;;
esac

# ── 중복 실행 방지: 동시 cron/수동 겹침 시 후발 주자는 즉시 포기 ──
# /tmp는 리눅스 서버 기준, TMPDIR가 정의된 환경(Termux 등)은 그쪽을 쓴다
LOCK="${TMPDIR:-/tmp}/ai-turk-deploy.lock"
exec 9>"$LOCK"
flock -n 9 || { echo "이미 실행 중" >&2; exit 1; }

# ── 0. 환경 부트스트랩 ──
# cron은 로그인셸이 아니므로 nvm이 초기화되어 있지 않아 PATH에 npm이 없다.
# 시스템에 npm이 보이지 않을 때만 nvm을 적재해 기본 노드를 올린다.
command -v npm >/dev/null 2>&1 || {
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use default >/dev/null
}

# ── 1. 리포 루트 기준 실행 ──
cd "$(dirname "$0")/.."

# ── 2. 원격 갱신 확인 ──
git fetch origin main --quiet
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)

if [ "$OLD" = "$NEW" ]; then
  if [ "$AUTO" = 1 ]; then
    exit 0   # 갱신 없음 — 조용히 종료 (로그 불남김)
  fi
  echo "이미 최신 (${OLD:0:7}) — 배포할 변경 없음"
  exit 0
fi

# ── 3. fast-forward 풀 (다이버전트면 수동 개입 필요) ──
if ! git pull --ff-only origin main; then
  echo "에러: fast-forward 불가 (로컬·원격 다이버전트) — 수동 개입 후 재실행" >&2
  exit 1
fi

# ── 4. 변경 파일 목록 ──
CHANGED=$(git diff --name-only "$OLD" "$NEW")

# ── 5. 의존성 갱신 — lock이 바뀐 경우에만 ──
if grep -q "package-lock.json" <<<"$CHANGED"; then
  npm install --no-audit --no-fund
fi

# ── 6. 테스트 게이트 ──
# 레드면 여기서 중단 — 러닝 프로세스는 아직 구코드(이전 빌드)로 구동 중이라 무사.
# 다음 배포 주기(또는 수동 재실행)에 자연 재시도된다.
if ! npm test; then
  echo "에러: 테스트 레드 — 배포 중단 (러닝 프로세스는 구코드 유지, 무사)" >&2
  exit 1
fi

# ── 7. 빌드 ──
npm run build

# ── 8. 조건부 재시작 — 서버/설정 쪽 파일이 바뀐 경우만 ──
# 정적(UI) 전용 변경은 빌드된 번들 교체로 즉시 서빙되므로 재시작 불필요.
WATCH='server.ts|backend.ts|session-core.ts|auth.ts|scheduler.ts|user-cli.ts|vite.config.ts|package.json|tsconfig.node.json|turkctl'
RESTART="정적 전용 — 재시작 생략 (빌드 즉시 반영)"
if grep -Eq "$WATCH" <<<"$CHANGED"; then
  if command -v pm2 >/dev/null 2>&1; then
    pm2 restart turk
    RESTART="pm2 restart turk 수행"
  else
    RESTART="pm2 없음 — 재시작 스킵 (개발 환경)"
  fi
fi

# ── 9. 완료 로그 ──
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 배포 완료: ${OLD:0:7} → ${NEW:0:7}"
echo "  변경 $(wc -l <<<"$CHANGED")건:"
sed 's/^/    /' <<<"$CHANGED"
echo "  재시작: $RESTART"