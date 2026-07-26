# 외환 대시보드 (Forex Dashboard)

> 무료 환율 API(Frankfurter, ECB 기준)를 사용한 환율 시각화 대시보드

## 데모

- http://115.71.237.101:8082/ (서버 실행 중)

## 기능

- 📊 **개요 탭**: 주요 8개 통화쌍 카드 + 스파크라인 + 일일 변동률
- 📈 **차트 탭**: Chart.js 기반 기간별 추세 차트 (7/30/90/180일)
- 🔔 **알림 탭**: 환율 임계값 설정 (상승/하락 알림, localStorage 저장)
- 🔄 5분 자동 새로고침
- 기준 통화 변경 (USD/KRW/EUR/JPY/CNY/GBP)
- 다크 테마

## 데이터 소스

- Frankfurter API: https://frankfurter.dev (ECB 환율, 무료, API 키 불필요)
- 영업일 기준 데이터 (주말/휴일 제외)

## 파일

- `index.html` — UI
- `app.js` — 데이터 수집/시각화 로직

## 실행

```bash
python3 -m http.server 8082 --directory forex-dashboard
```

## 참고

- ECB 기준 환율이라 실시간 시장가와 약간 다를 수 있음
- 실제 매매용이 아님 (참고용)
- 알림은 브라우저 내 강조 표시만 (외부 알림 미연동)