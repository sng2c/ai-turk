// PetForge Proto - Quick Battle, Battle Pass & Relics

const PETS = [
  { id: 0, name: '루미나', element: '빛', icon: '✦', galaxyId: 0, atk: 35, hp: 120, color: '#f8e060' },
  { id: 1, name: '테라스', element: '땅', icon: '◆', galaxyId: 1, atk: 38, hp: 135, color: '#d08030' },
  { id: 2, name: '아쿠아', element: '물', icon: '💧', galaxyId: 2, atk: 34, hp: 115, color: '#40c8f0' },
  { id: 3, name: '이그니스', element: '불', icon: '🔥', galaxyId: 3, atk: 45, hp: 110, color: '#f05020' },
];

const ROULETTE_ITEMS = [
  { icon: '💰', label: '골드x1.5', type: 'gold_mult' },
  { icon: '🧪', label: '돌연변이', type: 'potion' },
  { icon: '⬆️', label: 'EXP부스트', type: 'exp' },
  { icon: '💎', label: '스킬재료', type: 'material' },
];

const RELICS = [
  { id: 'light_shard', icon: '✨', name: '빛의 잔해', desc: '빛 속성 스킬 쿨다운 -1턴', bonus: { type: 'element_cdr', value: 1, element: '빛' } },
  { id: 'magma_heart', icon: '🔥', name: '용암 심장', desc: '화상 데미지 +50%', bonus: { type: 'dot_amp', value: 1.5, status: 'burn' } },
  { id: 'time_fragment', icon: '⏳', name: '시공 조각', desc: '첫 턴 선공 보장', bonus: { type: 'first_strike', value: true } },
  { id: 'lucky_star', icon: '🌟', name: '행운의 별', desc: '크리티컬 확률 +15%', bonus: { type: 'crit_rate', value: 15 } },
  { id: 'abyss_lantern', icon: '🔵', name: '심해 등불', desc: '어둠 속성 적에게 데미지 +20%', bonus: { type: 'vs_element', value: 1.2, element: '어둠' } },
  { id: 'titan_seed', icon: '🌰', name: '타이탄 씨앗', desc: 'DEF +20%', bonus: { type: 'def_pct', value: 20 } },
  { id: 'prism_lens', icon: '🔮', name: '프리즘 렌즈', desc: '궁극기 게이지 시작 +25', bonus: { type: 'ult_start', value: 25 } },
  { id: 'galactic_orb', icon: '🌌', name: '은하 구슬', desc: '성운 시너지 효과 +50%', bonus: { type: 'synergy_amp', value: 1.5 } },
];

const SEED_RULES = [
  { id: 'only_fire', name: '🔥 화염 속성만', desc: '화염 속성 펫만 출전 가능', check: (deck) => deck.every(p => p.element === '불'), bad: true },
  { id: 'only_water', name: '💧 물 속성만', desc: '물 속성 펫만 출전 가능', check: (deck) => deck.every(p => p.element === '물'), bad: true },
  { id: 'ult_half', name: '⚡ 궁극기 SP 절반', desc: '궁극기 SP 비용 50% 감소', check: () => true },
  { id: 'enemy_hp_2x', name: '👾 적 HP 2배', desc: '적 전체 HP 두 배', check: () => true, bad: true },
  { id: 'reward_3x', name: '💰 보상 3배', desc: '골드/EXP 보상 3배', check: () => true },
  { id: 'no_heal', name: '🚫 회복 금지', desc: '치유 스킬 사용 불가', check: () => true, bad: true },
  { id: 'crit_fest', name: '💥 크리 +30%', desc: '모든 펫 크리티컬 확률 +30%', check: () => true },
  { id: 'speed_run', name: '🏃 스피드런', desc: '5턴 안에 보스 처치 시 추가 보상', check: () => true },
];

const SEED_BOSSES = [
  { name: '성운 거대 골렘', icon: '🗿', hpMult: 3, atkMult: 1.4 },
  { name: '혼돈의 별핵', icon: '☄️', hpMult: 2.5, atkMult: 1.8 },
  { name: '심해 우주선', icon: '🛸', hpMult: 2, atkMult: 2.0 },
  { name: '태양 폭군', icon: '🌞', hpMult: 3.5, atkMult: 1.5 },
];

const PASS_REWARDS = [
  { level: 1,  free: { icon: '💰', name: '골드 200', reward: () => state.gold += 200 },
              paid: { icon: '💎', name: '스킬 재료 x3', reward: () => {} } },
  { level: 2,  free: { icon: '⬆️', name: 'EXP 부스트 10분', reward: () => {} },
              paid: { icon: '🧪', name: '돌연변이 포션 x2', reward: () => {} } },
  { level: 3,  free: { icon: '🎟️', name: '룰렛 티켓', reward: () => state.passTickets = (state.passTickets || 0) + 1 },
              paid: { icon: '👕', name: '한정 스킨', reward: () => {} } },
  { level: 4,  free: { icon: '💰', name: '골드 500', reward: () => state.gold += 500 },
              paid: { icon: '💰', name: '골드 1500', reward: () => state.gold += 1500 } },
  { level: 5,  free: { icon: '🏆', name: '배틀패스 엠블럼', reward: () => {} },
              paid: { icon: '🌟', name: 'UR 뽑기권', reward: () => {} } },
];

let state = {
  gold: 1200,
  streak: 0,
  speed: 1.0,
  deck: [],
  firstWinToday: false,
  wins: 0,
  battles: 0,
  passXp: 0,
  passLevel: 1,
  passTier: 'free',
  passClaimed: new Set(),
  passTickets: 0,
  relics: [...RELICS], // owned
  equippedRelics: [null, null, null], // slot 0..2
  selectedRelicSlot: null,
  seedWeek: 0,
  seedRules: [],
  seedBoss: null,
  seedCleared: false,
  arenaScore: 1000,
  arenaHistory: [],
  defenseDeck: [],
};

function init() {
  buildDeck();
  state.defenseDeck = [...state.deck];
  renderDeck();
  renderRelicSlots();
  renderPass();
  generateWeeklySeed();
  renderSeedDungeon();
  renderArena();
  updateUI();
  setInterval(updateSeedTimer, 60000);
}

function buildDeck() {
  const sorted = [...PETS].sort((a, b) => b.atk - a.atk);
  const top = sorted[0];
  const sameGalaxy = sorted.filter(p => p.galaxyId === top.galaxyId && p.id !== top.id);
  const others = sorted.filter(p => p.galaxyId !== top.galaxyId);
  state.deck = [top, sameGalaxy[0] || others[0], sameGalaxy[1] || others[1] || others[0]].slice(0, 3);
}

function renderDeck() {
  const el = document.getElementById('deck');
  const synergy = calcSynergy(state.deck);
  el.innerHTML = state.deck.map(p => {
    const glow = synergy.count >= 2 && p.galaxyId === synergy.galaxyId ? `box-shadow: 0 0 12px ${p.color}; border-color:${p.color};` : '';
    return `<div class="pet" style="${glow}">
      <div>${p.icon}</div>
      <div class="name">${p.name}</div>
      <div class="element">${p.element}</div>
    </div>`;
  }).join('');
}

function calcSynergy(deck) {
  const counts = {};
  deck.forEach(p => { counts[p.galaxyId] = (counts[p.galaxyId] || 0) + 1; });
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!best) return { count: 1, galaxyId: deck[0]?.galaxyId };
  return { count: best[1], galaxyId: parseInt(best[0]) };
}

function getRelicBonus(type, params = {}) {
  let total = 0;
  let multi = 1;
  let flag = false;
  state.equippedRelics.forEach(r => {
    if (!r) return;
    const b = r.bonus;
    if (b.type === type) {
      if (type === 'synergy_amp') multi *= b.value;
      else if (type === 'first_strike') flag = true;
      else if (type === 'crit_rate') total += b.value;
      else if (type === 'def_pct') total += b.value;
      else if (type === 'ult_start') total += b.value;
      else if (type === 'dot_amp' && b.status === params.status) multi *= b.value;
      else if (type === 'element_cdr' && b.element === params.element) total += b.value;
      else if (type === 'vs_element' && b.element === params.element) multi *= b.value;
    }
  });
  return { total, multi, flag };
}

function updateUI() {
  document.getElementById('gold').textContent = state.gold.toLocaleString() + 'G';
  document.getElementById('streak').textContent = state.streak;
  document.getElementById('speed').textContent = state.speed.toFixed(1) + 'x';

  const dots = [document.getElementById('sd0'), document.getElementById('sd1'), document.getElementById('sd2')];
  dots.forEach(d => d.classList.remove('active'));
  if (state.streak >= 3) dots[0].classList.add('active');
  if (state.streak >= 5) dots[1].classList.add('active');
  if (state.streak >= 10) dots[2].classList.add('active');

  document.getElementById('passLevel').textContent = state.passLevel;
  const xpNeed = state.passLevel * 100;
  const pct = Math.min(100, Math.floor((state.passXp / xpNeed) * 100));
  document.getElementById('passFill').style.width = pct + '%';

  document.getElementById('arenaScore').textContent = state.arenaScore;
  document.getElementById('arenaTier').textContent = getArenaTier(state.arenaScore).name;
  document.getElementById('defenseTag').textContent = `방어 덱: ${state.defenseDeck.map(p => p.icon).join('')}`;

  updateSeedTimer();
}

function log(msg, cls = '') {
  const el = document.getElementById('log');
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.innerHTML = msg;
  el.prepend(div);
}

function startQuickBattle() {
  const btn = document.getElementById('battleBtn');
  btn.disabled = true;
  btn.textContent = '전투 중...';

  const synergy = calcSynergy(state.deck);
  let synergyBonus = synergy.count >= 3 ? 1.3 : synergy.count >= 2 ? 1.15 : 1.0;
  const synAmp = getRelicBonus('synergy_amp');
  synergyBonus = 1 + (synergyBonus - 1) * synAmp.multi;

  const critRate = getRelicBonus('crit_rate').total;
  const crit = Math.random() * 100 < critRate + 5; // base 5% crit

  let myPower = state.deck.reduce((sum, p) => sum + p.atk, 0) * synergyBonus;
  if (crit) myPower *= 1.5;
  const defPct = getRelicBonus('def_pct').total;

  const enemy = createEnemy(state.streak);
  let enemyPower = enemy.atk * (1 + Math.min(state.streak, 10) * 0.02);
  enemyPower = enemyPower / (1 + defPct / 100);

  const firstStrike = getRelicBonus('first_strike').flag;
  const win = firstStrike ? true : myPower >= enemyPower;

  setTimeout(() => {
    state.battles++;
    const xpGain = 20 + (win ? 30 : 10) + state.streak * 2;
    gainPassXp(xpGain);

    if (win) {
      state.streak++;
      state.wins++;
      const baseGold = 80;
      const streakBonus = Math.min(state.streak, 10) * 0.1;
      const isFirstWin = !state.firstWinToday;
      const firstWinMult = isFirstWin ? 2 : 1;
      const earned = Math.round(baseGold * (1 + streakBonus) * firstWinMult);
      state.gold += earned;
      if (isFirstWin) state.firstWinToday = true;

      // 10% 확률로 유물 획득
      let relicDrop = '';
      if (Math.random() < 0.1) {
        const newRelic = RELICS[Math.floor(Math.random() * RELICS.length)];
        if (!state.relics.find(r => r.id === newRelic.id)) {
          state.relics.push(newRelic);
          relicDrop = ` · 🔮 ${newRelic.name} 획득!`;
        }
      }

      const critText = crit ? ' (💥 크리티컬!)' : '';
      const firstText = firstStrike ? ' (⚡ 선공!)' : '';
      log(`🏆 승리! ${enemy.name} 처치${critText}${firstText} · +${earned.toLocaleString()}G ${isFirstWin ? '(일일 첫승 2배!)' : ''} · 🔥 ${state.streak}연승 · +${xpGain} BP XP${relicDrop}`, 'win reward');
      updateUI();
      renderRelicSlots();
      showRoulette();
    } else {
      log(`💀 패배... ${enemy.name}에게 졌습니다. 연승이 끊겼습니다. (+${xpGain} BP XP)`, 'lose');
      state.streak = 0;
      updateUI();
    }

    btn.disabled = false;
    btn.textContent = '⚔️ 빠른 배틀 시작';
  }, 1000 / state.speed);
}

function createEnemy(streak) {
  const names = ['어둠의 슬라임', '성운 포식자', '우주 버섯', '은하 늑대'];
  const name = names[Math.floor(Math.random() * names.length)];
  const atk = 60 + Math.floor(Math.random() * 30) + streak * 2;
  return { name, atk };
}

function gainPassXp(amount) {
  state.passXp += amount;
  while (state.passXp >= state.passLevel * 100 && state.passLevel < PASS_REWARDS.length) {
    state.passXp -= state.passLevel * 100;
    state.passLevel++;
    log(`🎫 배틀패스 Lv.${state.passLevel} 달성! 보상을 수령하세요.`, 'reward');
  }
  renderPass();
}

function switchPass(tier) {
  state.passTier = tier;
  document.getElementById('freeTab').classList.toggle('active', tier === 'free');
  document.getElementById('paidTab').classList.toggle('active', tier === 'paid');
  renderPass();
}

function renderPass() {
  const el = document.getElementById('passRewards');
  el.innerHTML = PASS_REWARDS.map(r => {
    const reward = state.passTier === 'free' ? r.free : r.paid;
    const key = `${state.passTier}-${r.level}`;
    const claimed = state.passClaimed.has(key);
    const available = state.passLevel >= r.level;
    const lockIcon = available ? '' : '🔒 ';
    const cls = `pass-row ${claimed ? 'pass-claimed' : ''}`;
    return `<div class="${cls}">
      <span class="pass-icon">${lockIcon}${reward.icon}</span>
      <span class="pass-name">Lv.${r.level} ${reward.name}</span>
      <span class="pass-tag ${state.passTier === 'paid' ? 'paid' : ''}">${state.passTier === 'free' ? 'FREE' : 'PAID'}</span>
      ${available && !claimed ? `<button class="tier-btn" onclick="claimPass(${r.level})">수령</button>` : ''}
    </div>`;
  }).join('');
}

function claimPass(level) {
  const key = `${state.passTier}-${level}`;
  if (state.passClaimed.has(key) || state.passLevel < level) return;
  state.passClaimed.add(key);
  const reward = state.passTier === 'free' ? PASS_REWARDS.find(r => r.level === level).free : PASS_REWARDS.find(r => r.level === level).paid;
  reward.reward();
  log(`🎁 ${reward.name} 수령 완료!`, 'reward');
  updateUI();
  renderPass();
}

// Relic functions
function renderRelicSlots() {
  state.equippedRelics.forEach((r, i) => {
    const box = document.getElementById(`rSlot${i}`);
    if (r) {
      box.className = 'slot-box filled';
      box.innerHTML = `<span class="emoji">${r.icon}</span><span>${r.name}</span>`;
    } else {
      box.className = 'slot-box';
      box.innerHTML = `+<br>슬롯${i + 1}`;
    }
  });
}

function openRelicModal(slotIdx) {
  state.selectedRelicSlot = slotIdx;
  document.getElementById('relicModalTitle').textContent = `🔮 슬롯 ${slotIdx + 1}에 유물 장착`;
  const list = document.getElementById('relicList');
  list.innerHTML = state.relics.map(r => {
    const equippedIdx = state.equippedRelics.findIndex(e => e && e.id === r.id);
    const isEquipped = equippedIdx !== -1;
    const equippedText = isEquipped ? `(슬롯${equippedIdx + 1})` : '';
    const cls = state.equippedRelics[slotIdx] && state.equippedRelics[slotIdx].id === r.id ? 'relic-row equipped' : 'relic-row';
    return `<div class="${cls}" onclick="equipRelic('${r.id}')">
      <div class="relic-icon">${r.icon}</div>
      <div class="relic-info">
        <div class="relic-name">${r.name} ${equippedText}</div>
        <div class="relic-desc">${r.desc}</div>
      </div>
    </div>`;
  }).join('');
  document.getElementById('relicModal').style.display = 'flex';
}

function equipRelic(relicId) {
  const relic = state.relics.find(r => r.id === relicId);
  if (!relic) return;
  const slot = state.selectedRelicSlot;
  // remove from other slot if equipped there
  state.equippedRelics = state.equippedRelics.map(r => (r && r.id === relicId ? null : r));
  state.equippedRelics[slot] = relic;
  renderRelicSlots();
  closeRelicModal();
  log(`🔮 ${relic.name} 슬롯 ${slot + 1}에 장착!`, 'reward');
  updateUI();
}

function closeRelicModal() {
  document.getElementById('relicModal').style.display = 'none';
  state.selectedRelicSlot = null;
}

function showRoulette() {
  const modal = document.getElementById('rouletteModal');
  const slots = [0, 1, 2].map(i => document.getElementById(`slot${i}`));
  const resultEl = document.getElementById('rouletteResult');
  modal.style.display = 'flex';

  slots.forEach(s => { s.classList.remove('win'); s.innerHTML = '❓<div class="slot-label"></div>'; });
  resultEl.textContent = '룰렛 돌리는 중...';

  const winnerIdx = Math.floor(Math.random() * 3);
  const winner = ROULETTE_ITEMS[Math.floor(Math.random() * ROULETTE_ITEMS.length)];

  let spins = 0;
  const interval = setInterval(() => {
    slots.forEach((s, i) => {
      const item = ROULETTE_ITEMS[Math.floor(Math.random() * ROULETTE_ITEMS.length)];
      s.innerHTML = `${item.icon}<div class="slot-label">${item.label}</div>`;
      s.classList.toggle('win', i === (spins % 3));
    });
    spins++;
    if (spins >= 12) {
      clearInterval(interval);
      slots.forEach(s => s.classList.remove('win'));
      slots[winnerIdx].innerHTML = `${winner.icon}<div class="slot-label">${winner.label}</div>`;
      slots[winnerIdx].classList.add('win');

      let resultText = `🎉 ${winner.label} 획득!`;
      if (winner.type === 'gold_mult') {
        const bonus = Math.round(state.gold * 0.5);
        state.gold += bonus;
        resultText += ` (+${bonus.toLocaleString()}G)`;
      }
      resultEl.innerHTML = resultText;
      updateUI();
    }
  }, 100);
}

// Weekly Seed Dungeon functions
function generateWeeklySeed() {
  // deterministic pseudo-random based on current week
  const now = new Date();
  const week = Math.floor(now.getTime() / (7 * 24 * 60 * 60 * 1000));
  state.seedWeek = week;
  state.seedCleared = false;

  const seededRandom = (n) => {
    const x = Math.sin(week * 997 + n * 31) * 10000;
    return x - Math.floor(x);
  };

  const shuffled = [...SEED_RULES].sort((a, b) => seededRandom(a.id.charCodeAt(0)) - seededRandom(b.id.charCodeAt(0)));
  state.seedRules = shuffled.slice(0, 3);
  state.seedBoss = SEED_BOSSES[Math.floor(seededRandom(99) * SEED_BOSSES.length)];
}

function renderSeedDungeon() {
  const rulesEl = document.getElementById('seedRules');
  const rewardsEl = document.getElementById('seedRewards');
  const bossEl = document.getElementById('seedBoss');

  rulesEl.innerHTML = state.seedRules.map(r =>
    `<span class="seed-rule ${r.bad ? 'bad' : ''}">${r.name}</span>`
  ).join('');

  bossEl.innerHTML = `👑 시드 보스: ${state.seedBoss.icon} ${state.seedBoss.name}`;

  const reward3x = state.seedRules.some(r => r.id === 'reward_3x');
  const mult = reward3x ? 3 : 1;
  rewardsEl.innerHTML = `
    <div class="seed-reward"><span class="rank">1위</span><span>유물 + 골드 ${(500 * mult).toLocaleString()}G</span></div>
    <div class="seed-reward"><span class="rank">S</span><span>골드 ${(300 * mult).toLocaleString()}G + 스킬재료</span></div>
    <div class="seed-reward"><span class="rank">A</span><span>골드 ${(150 * mult).toLocaleString()}G</span></div>
  `;

  document.getElementById('seedBtn').disabled = state.seedCleared;
  document.getElementById('seedBtn').textContent = state.seedCleared ? '✅ 이번 주 클리어 완료' : '🌠 시드 던전 도전';
}

function updateSeedTimer() {
  const now = new Date();
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + ((8 - now.getDay()) % 7));
  nextMonday.setHours(0, 0, 0, 0);
  if (nextMonday <= now) nextMonday.setDate(nextMonday.getDate() + 7);
  const diff = Math.max(0, nextMonday - now);
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const el = document.getElementById('seedTimer');
  if (el) el.textContent = `다음 시드: ${h}시간 ${m}분`;
}

function runSeedDungeon() {
  const btn = document.getElementById('seedBtn');
  btn.disabled = true;
  btn.textContent = '도전 중...';

  // Check rule compliance
  const failedRule = state.seedRules.find(r => !r.check(state.deck));
  if (failedRule) {
    log(`🚫 시드 규칙 위반: ${failedRule.desc}`, 'lose');
    btn.disabled = false;
    btn.textContent = '🌠 시드 던전 도전';
    return;
  }

  const reward3x = state.seedRules.some(r => r.id === 'reward_3x');
  const enemyHpMult = state.seedBoss.hpMult * (state.seedRules.some(r => r.id === 'enemy_hp_2x') ? 2 : 1);
  const critFest = state.seedRules.some(r => r.id === 'crit_fest');

  const synergy = calcSynergy(state.deck);
  let synergyBonus = synergy.count >= 3 ? 1.3 : synergy.count >= 2 ? 1.15 : 1.0;
  const synAmp = getRelicBonus('synergy_amp');
  synergyBonus = 1 + (synergyBonus - 1) * synAmp.multi;

  const baseCrit = critFest ? 35 : 5;
  const critRate = baseCrit + getRelicBonus('crit_rate').total;
  const crit = Math.random() * 100 < critRate;

  let myPower = state.deck.reduce((sum, p) => sum + p.atk, 0) * synergyBonus;
  if (crit) myPower *= 1.5;

  const defPct = getRelicBonus('def_pct').total;
  let enemyPower = (120 * state.seedBoss.atkMult * enemyHpMult) / (1 + defPct / 100);

  const firstStrike = getRelicBonus('first_strike').flag;
  const win = firstStrike ? true : myPower >= enemyPower;

  setTimeout(() => {
    if (win) {
      state.seedCleared = true;
      const mult = reward3x ? 3 : 1;
      const gold = 300 * mult;
      state.gold += gold;

      // ranking grade by clear speed/turns (simplified)
      const rank = state.seedRules.some(r => r.id === 'speed_run') ? 'S' : 'A';
      let relicDrop = '';
      if (Math.random() < 0.25 || rank === 'S') {
        const newRelic = RELICS[Math.floor(Math.random() * RELICS.length)];
        if (!state.relics.find(r => r.id === newRelic.id)) {
          state.relics.push(newRelic);
          relicDrop = ` · 🔮 ${newRelic.name} 획득!`;
        }
      }

      log(`🌌 시드 던전 클리어! [${rank}] ${state.seedBoss.name} 처치 · +${gold.toLocaleString()}G${relicDrop}`, 'win reward');
      gainPassXp(80 * mult);
      renderSeedDungeon();
      renderRelicSlots();
      updateUI();
    } else {
      log(`💀 시드 던전 실패... ${state.seedBoss.name}이(가) 강력합니다.`, 'lose');
    }

    btn.disabled = false;
    btn.textContent = state.seedCleared ? '✅ 이번 주 클리어 완료' : '🌠 시드 던전 도전';
  }, 1500);
}

function closeRoulette() {
  document.getElementById('rouletteModal').style.display = 'none';
}

// PvP Arena functions
const ARENA_TIERS = [
  { name: '브론즈', min: 0 },
  { name: '실버', min: 1100 },
  { name: '골드', min: 1300 },
  { name: '플래티넘', min: 1500 },
  { name: '다이아몬드', min: 1700 },
  { name: '마스터', min: 1900 },
];

function getArenaTier(score) {
  for (let i = ARENA_TIERS.length - 1; i >= 0; i--) {
    if (score >= ARENA_TIERS[i].min) return ARENA_TIERS[i];
  }
  return ARENA_TIERS[0];
}

function generateArenaOpponents() {
  const names = ['스타포지', '네뷸러', '펫마스터', '은하냥', '코스모스', '루나틱', '볼트', '아쿠아맨'];
  const ops = [];
  for (let i = 0; i < 5; i++) {
    const score = Math.max(800, state.arenaScore + Math.floor(Math.random() * 400) - 150);
    const deck = [];
    for (let j = 0; j < 3; j++) {
      deck.push(PETS[Math.floor(Math.random() * PETS.length)]);
    }
    ops.push({
      id: i,
      name: names[Math.floor(Math.random() * names.length)] + (i + 1),
      score,
      deck,
    });
  }
  return ops.sort((a, b) => a.score - b.score);
}

function renderArena() {
  const list = document.getElementById('arenaList');
  const ops = generateArenaOpponents();
  list.innerHTML = ops.map((op, idx) => {
    const tier = getArenaTier(op.score);
    return `<div class="arena-row">
      <span class="arena-rank">${idx + 1}</span>
      <div class="arena-deck">
        ${op.deck.map(p => `<div class="pet-mini" style="border-color:${p.color};">${p.icon}</div>`).join('')}
      </div>
      <div class="arena-score">
        <div>${op.name}</div>
        <div>${tier.name} · ${op.score}점</div>
      </div>
      <button class="arena-btn" onclick="challengePvp(${op.id}, '${op.name}', ${op.score})">도전</button>
    </div>`;
  }).join('');
}

function challengePvp(opId, opName, opScore) {
  const modal = document.getElementById('pvpModal');
  const content = document.getElementById('pvpContent');
  const result = document.getElementById('pvpResult');
  modal.style.display = 'flex';
  result.textContent = '전투 시뮬레이션 중...';

  // Find opponent deck from last generated list by re-generating or storing. Simpler: store in DOM not possible. Regenerate.
  const ops = generateArenaOpponents();
  const op = ops.find(o => o.name === opName);
  if (!op) return;

  content.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div>나의 덱<br/>${state.deck.map(p => p.icon).join(' ')}</div>
      <div style="font-size:20px;">VS</div>
      <div>${op.name}<br/>${op.deck.map(p => p.icon).join(' ')}</div>
    </div>
  `;

  setTimeout(() => {
    const myPower = calcBattlePower(state.deck, state.equippedRelics);
    const opPower = calcBattlePower(op.deck, [null, null, null]);
    const win = myPower >= opPower;
    const scoreDelta = win ? Math.max(15, Math.floor((opScore - state.arenaScore) / 20) + 20) : -Math.max(10, Math.floor((state.arenaScore - opScore) / 30) + 10);

    state.arenaScore = Math.max(0, state.arenaScore + scoreDelta);
    const gold = win ? 100 : 20;
    state.gold += gold;
    state.arenaHistory.unshift({ name: op.name, win, scoreDelta });
    if (state.arenaHistory.length > 5) state.arenaHistory.pop();

    result.innerHTML = win
      ? `<div class="win">🏆 승리!</div><div>${opName}撃파 · 점수 ${scoreDelta > 0 ? '+' : ''}${scoreDelta} · +${gold}G</div>`
      : `<div class="lose">💀 패배...</div><div>${opName}에게 졌습니다 · 점수 ${scoreDelta} · +${gold}G</div>`;

    if (win) {
      gainPassXp(40);
      log(`⚔️ PvP 승리! ${opName}撃파 · 점수 ${scoreDelta > 0 ? '+' : ''}${scoreDelta} · 티어: ${getArenaTier(state.arenaScore).name}`, 'win reward');
    } else {
      log(`⚔️ PvP 패배... ${opName}에게 졌습니다. 점수 ${scoreDelta}`, 'lose');
    }

    renderArenaHistory();
    renderArena();
    updateUI();
  }, 1000);
}

function calcBattlePower(deck, relics) {
  const synergy = calcSynergy(deck);
  let synergyBonus = synergy.count >= 3 ? 1.3 : synergy.count >= 2 ? 1.15 : 1.0;
  const synAmp = { multi: 1 }; // no relics for opponents
  if (relics) {
    relics.forEach(r => {
      if (r && r.bonus.type === 'synergy_amp') synAmp.multi *= r.bonus.value;
    });
  }
  synergyBonus = 1 + (synergyBonus - 1) * synAmp.multi;

  const baseCrit = 5;
  let critRate = baseCrit;
  if (relics) {
    relics.forEach(r => {
      if (r && r.bonus.type === 'crit_rate') critRate += r.bonus.value;
    });
  }
  const crit = Math.random() * 100 < critRate;

  let power = deck.reduce((sum, p) => sum + p.atk, 0) * synergyBonus;
  if (crit) power *= 1.5;

  let defPct = 0;
  if (relics) {
    relics.forEach(r => {
      if (r && r.bonus.type === 'def_pct') defPct += r.bonus.value;
    });
  }
  power = power * (1 + defPct / 100);

  const firstStrike = relics && relics.some(r => r && r.bonus.type === 'first_strike');
  if (firstStrike) power *= 1.2;

  return power;
}

function renderArenaHistory() {
  const el = document.getElementById('arenaHistory');
  if (state.arenaHistory.length === 0) {
    el.textContent = '최근 전적이 여기에 표시됩니다';
    return;
  }
  el.innerHTML = state.arenaHistory.map(h => {
    const color = h.win ? 'var(--ok)' : 'var(--danger)';
    return `<span style="color:${color}">${h.win ? '승' : '패'} ${h.name} (${h.scoreDelta > 0 ? '+' : ''}${h.scoreDelta})</span>`;
  }).join(' · ');
}

function closePvpModal() {
  document.getElementById('pvpModal').style.display = 'none';
}

init();
