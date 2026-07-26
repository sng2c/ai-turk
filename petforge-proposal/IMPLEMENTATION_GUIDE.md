# PetForge 중독성 기능 구현 가이드

> PetForge 실제 코드에 적용하기 위한 기술 문서
> 원본: https://petforge-full.vercel.app/
> 분석/기획: ./petforge-analysis/, ./detailed_plan.md

---

## 1. 소스 구조 파악 (Reverse Engineering)

실제 배포된 SPA는 Vite + React 기반. 추정 구조:

```
src/
  main.tsx              # 진입점
  App.tsx               # 라우팅
  components/
    Home.tsx            # 랜딩/홈
    Game.tsx            # 메인 게임 (탭 네비게이션)
    Battle.tsx          # 전투 화면
    Breeding.tsx        # 교배소
    Market.tsx          # 마켓
    Galaxy.tsx          # 은하계 탐험
    Quest.tsx           # 퀘스트
    Collection.tsx      # 도감/컬렉션
  data/
    species.ts          # 종족 데이터 (di 배열)
    skills.ts           # 스킬 데이터 (Pa 객체)
    planets.ts          # 행성 데이터 (Es, Dr 배열)
    config.ts           # 게임 밸런스 (mg 객체)
  hooks/
    useGame.ts          # GameProvider (k6)
    useBattle.ts        # 전투 로직
  utils/
    battle.ts           # 전투 수학 (u1, jt, calcBattlePower)
```

분석에서 추출한 핵심 변수:
- `di` — 기본 종족 배열
- `Pa` — 종족별 스킬 객체 `{0:[...], 1:[...], ...}`
- `Es` / `Dr` — 행성/성운 데이터
- `mg` / `br` — 게임 설정/등급 보너스
- `k6` — GameProvider 함수
- `e3` — Battle 컴포넌트
- `D8` — 교배 함수
- `jt` — 펫 스탯 계산 함수

---

## 2. 기능별 구현 체크리스트

### A. 빠른 배틀 (Quick Battle)
**목표**: 메인 화면에서 30초 핵심 루프

**수정 파일**:
- `src/components/Game.tsx` 또는 `src/components/Home.tsx`
- `src/hooks/useGame.ts` — `quickBattle()` 추가
- `src/utils/battle.ts` — `calcQuickBattleResult()`

**구현 단계**:
1. "⚡ 빠른 배틀" 버튼 추가
2. `autoSelectDeck(pets)` 함수: 최근 승리 덱 또는 추천 덱 반환
3. 적 생성: `createEnemy(streak, difficulty)`
4. 3배속 자동 전투 시뮬레이션
5. 보상 계산: `baseGold * (1 + streakBonus) * firstWinMult`
6. 승리 후 룰렛 모달 호출

**주의**:
- 기존 배틀 함수 `e3` / `jn` 재사용 가능
- Promise + setTimeout으로 애니메이션 유지
- 연승 카운터는 `state.winStreak`

---

### B. 승리 룰렛 (Post-Battle Roulette)
**목표**: 보상 폭발 + 광고 수익

**수정 파일**:
- `src/components/RouletteModal.tsx` (신규)
- `src/components/Battle.tsx`
- `src/hooks/useGame.ts` — `playRoulette(adWatched)`

**구현 단계**:
1. 3 슬롯 룰렛 컴포넌트
2. 보상 풀: 골드×1.5, 돌연변이 포션, EXP부스트, 스킬재료
3. `setInterval`로 회전 애니메이션
4. 광고 시청 시 +2회 (ad state 관리)
5. 보상 적용 후 UI 업데이트

---

### C. 연승 보너스 시각화
**목표**: 긴장감 + 보상 기대감

**수정 파일**:
- `src/components/Battle.tsx` — 연승 UI
- `src/index.css` — 불꽃 이펙트 애니메이션

**구현 단계**:
1. 3/5/10 연승 단계별 `.streak-dot.active`
2. 배틀 버튼 테두리 불꽃 glow 효과
3. 연승 끊기 직전 경고 토스트
4. `streakBonus = Math.min(streak, 10) * 0.1`

---

### D. 성운 시너지 (Nebula Synergy)
**목표**: 덱 빌드 전략화

**수정 파일**:
- `src/utils/battle.ts` — `calcSynergy(deck)`
- `src/components/Battle.tsx` — 시너지 UI

**구현 단계**:
1. 덱 내 같은 `galaxyId` 개수 카운트
2. 보너스:
   - 2마리: 속성 데미지 +15%, SP 회복 +10%
   - 3마리: 속성 데미지 +30%, 궁극기 시작 +20
3. 전투 시작 시 시너지 아이콘 표시
4. `battlePower *= synergyBonus` 반영

---

### E. 유물 시스템 (Relics)
**목표**: 매판 다른 메타, 수집 욕구

**수정 파일**:
- `src/data/relics.ts` (신규)
- `src/hooks/useGame.ts` — `relics`, `equippedRelics` 상태 추가
- `src/components/RelicInventory.tsx` (신규)
- `src/utils/battle.ts` — `getRelicBonus(type, params)`

**구현 단계**:
1. 유물 데이터 정의 (8개 샘플)
2. 인벤토리/슬롯 UI
3. 전투력 계산에 유물 효과 반영:
   - crit_rate, def_pct, synergy_amp, first_strike, ult_start, dot_amp, element_cdr, vs_element
4. 보스/행성 드랍 로직

---

### F. 배틀패스 (Battle Pass)
**목표**: 장기 몰입 + 매출

**수정 파일**:
- `src/components/BattlePass.tsx` (신규)
- `src/hooks/useGame.ts` — `passXp`, `passLevel`, `passClaimed`
- `src/data/passRewards.ts` (신규)

**구현 단계**:
1. 무료/유료 트랙 토글
2. XP 획득: 배틀 +30, 승리 +20 추가, 교배 +10, 행성 +50
3. `level * 100` XP 필요
4. 보상 수령 버튼 + 상태 업데이트
5. 50단계 확장 시 데이터 파일만 추가

---

### G. 주간 시드 던전 (Weekly Seed Dungeon)
**목표**: 매주 새로운 메타

**수정 파일**:
- `src/components/SeedDungeon.tsx` (신규)
- `src/utils/seed.ts` — `generateWeeklySeed()`
- `src/data/seedRules.ts` (신규)

**구현 단계**:
1. 현재 주차 기반 시드 생성 (deterministic)
2. 규칙 3개 랜덤 조합
3. 덱 규칙 체크
4. 보스 스탯 조정 (HP 2배, 보상 3배 등)
5. 클리어 시 등급(S/A)에 따른 보상

---

### H. PvP 아레나
**목표**: 소셜 경쟁

**수정 파일**:
- `src/components/Arena.tsx` (신규)
- `src/hooks/useGame.ts` — `arenaScore`, `defenseDeck`, `arenaHistory`
- `src/utils/arena.ts` — `generateOpponents(score)`, `calcArenaPower()`

**구현 단계**:
1. 공격 덱 / 방어 덱 분리 저장
2. 5명의 비동기 상대 생성
3. 점수 기반 매치메이킹
4. AI가 상대 방어 덱 운영
5. 점수 변동 및 티어 계산
6. 전적 기록

---

### I. 도감 세트 보너스
**목표**: 수집 동기 + 전력 상승

**수정 파일**:
- `src/data/dexSets.ts` (신규)
- `src/components/DexSet.tsx` (신규)
- `src/utils/battle.ts` — `getDexBonus()`

**구현 단계**:
1. 세트 데이터: 기본4종, G1, G2 등
2. 보유 펫 체크
3. 완성 시 "활성화" 버튼
4. 영구 버프 적용 (HP/ATK/DEF/크리)

---

### J. 스토리 & 컷신
**목표**: 세계관 몰입

**수정 파일**:
- `src/data/stories.ts` (신규)
- `src/components/StoryBook.tsx` (신규)
- `src/components/CutsceneModal.tsx` (신규)

**구현 단계**:
1. 진행 조건 기반 스토리 카드 해금
2. 클릭 시 로어 모달
3. 첫 보스/첫 전투 시 컷신 모달
4. 보스 데이터에 title, quote 추가

---

## 3. 상태 관리 확장

`GameProvider` (k6)에 추가할 state:

```typescript
interface GameState {
  // 기존
  pets: Pet[];
  gold: number;
  market: MarketItem[];
  inventory: Inventory;
  winStreak: number;
  battleHistory: BattleResult[];

  // 신규
  settings: {
    battleSpeed: number;
  };
  pass: {
    xp: number;
    level: number;
    tier: 'free' | 'paid';
    claimed: Set<string>;
  };
  relics: {
    owned: Relic[];
    equipped: (Relic | null)[];
  };
  arena: {
    score: number;
    defenseDeck: Pet[];
    history: ArenaResult[];
  };
  dex: {
    claimed: Set<string>;
  };
  seed: {
    week: number;
    rules: SeedRule[];
    boss: Boss;
    cleared: boolean;
  };
  stories: {
    unlocked: Set<string>;
    seenCutscenes: Set<string>;
  };
}
```

---

## 4. 밸런스 참고값

| 시스템 | 기본값 | 최대 | 비고 |
|--------|--------|------|------|
| 빠른 배틀 골드 | 80G | 320G | 10연승 + 일일 첫승 |
| 연승 보너스 | 10% | 100% | 10연승 |
| 시너지 2마리 | 15% | - | 속성 데미지 |
| 시너지 3마리 | 30% | - | + 궁극기 +20 |
| 배틀패스 XP | 100×Lv | - | 50Lv 권장 |
| 유물 드랍률 | 10% | 25% | 보스/시드 |
| 도감 버프 | 3% | 5% | HP/ATK/DEF/크리 |

---

## 5. 적용 우선순위 (ROI)

1. **빠른 배틀 + 룰렛** — 낮은 개발 비용, 높은 DAU 효과
2. **연승 보너스 시각화** — 거의 무료, 체감 큼
3. **성운 시너지** — 기존 시스템에 자연스러움
4. **배틀패스** — 매출 직결
5. **유물 + 시드 던전** — 중기 몰입
6. **PvP + 도감 세트** — 소셜/수집
7. **스토리/컷신** — 마무리 몰입

---

## 6. 테스트 체크리스트

- [ ] 빠른 배틀 30초 내 종료
- [ ] 연승 보너스 3/5/10 단계 정상 표시
- [ ] 룰렛 보상 정상 지급
- [ ] 성운 시너지 덱 빌드에 따른 전투력 변화
- [ ] 유물 장착/해제 시 전투력 반영
- [ ] 배틀패스 레벨업 및 보상 수령
- [ ] 시드 던전 규칙 위반 시 차단
- [ ] PvP 점수/티어/전적 정상 기록
- [ ] 도감 세트 완성 시 영구 버프 적용
- [ ] 컷신 첫 1회만 표시

---

## 7. 다음 단계

1. PetForge 실제 소스 클론
2. 위 파일별로 브랜치 나눠 구현
3. 기능별 PR 생성
4. Vercel 프리뷰로 QA
5. 프로덕션 배포

