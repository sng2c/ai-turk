// PetForge Proto - Quick Battle & Streak

const PETS = [
  { id: 0, name: '루미나', element: '빛', icon: '✦', galaxyId: 0, atk: 35, hp: 120, color: '#f8e060' },
  { id: 1, name: '테라스', element: '땅', icon: '◆', galaxyId: 1, atk: 38, hp: 135, color: '#d08030' },
  { id: 2, name: '아쿠아', element: '물', icon: '💧', galaxyId: 2, atk: 34, hp: 115, color: '#40c8f0' },
  { id: 3, name: '이그니스', element: '불', icon: '🔥', galaxyId: 3, atk: 45, hp: 110, color: '#f05020' },
];

const ELEMENT_MULT = {
  '빛': { '어둠': 1.5, '번개': 0.6 },
  '땅': { '번개': 1.5, '물': 0.6 },
  '물': { '불': 1.5, '자연': 0.6 },
  '불': { '자연': 1.5, '물': 0.6 },
};

const ROULETTE_ITEMS = [
  { icon: '💰', label: '골드x1.5', type: 'gold_mult' },
  { icon: '🧪', label: '돌연변이', type: 'potion' },
  { icon: '⬆️', label: 'EXP부스트', type: 'exp' },
  { icon: '💎', label: '스킬재료', type: 'material' },
];

let state = {
  gold: 1200,
  streak: 0,
  speed: 1.0,
  deck: [],
  firstWinToday: false,
  wins: 0,
  battles: 0,
};

function init() {
  buildDeck();
  renderDeck();
  updateUI();
}

function buildDeck() {
  // 우선순위: 고 atk + 성운 시너리 가능한 조합
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

function updateUI() {
  document.getElementById('gold').textContent = state.gold.toLocaleString() + 'G';
  document.getElementById('streak').textContent = state.streak;
  document.getElementById('speed').textContent = state.speed.toFixed(1) + 'x';

  const dots = [document.getElementById('sd0'), document.getElementById('sd1'), document.getElementById('sd2')];
  dots.forEach(d => d.classList.remove('active'));
  if (state.streak >= 3) dots[0].classList.add('active');
  if (state.streak >= 5) dots[1].classList.add('active');
  if (state.streak >= 10) dots[2].classList.add('active');
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
  const synergyBonus = synergy.count >= 3 ? 1.3 : synergy.count >= 2 ? 1.15 : 1.0;

  const myPower = state.deck.reduce((sum, p) => sum + p.atk, 0) * synergyBonus;
  const enemy = createEnemy(state.streak);
  const enemyPower = enemy.atk * (1 + Math.min(state.streak, 10) * 0.02);

  const win = myPower >= enemyPower;

  setTimeout(() => {
    state.battles++;
    if (win) {
      state.streak++;
      state.wins++;
      const baseGold = 80;
      const streakBonus = Math.min(state.streak, 10) * 0.1; // max 100%
      const isFirstWin = !state.firstWinToday;
      const firstWinMult = isFirstWin ? 2 : 1;
      const earned = Math.round(baseGold * (1 + streakBonus) * firstWinMult);
      state.gold += earned;
      if (isFirstWin) state.firstWinToday = true;

      log(`🏆 승리! ${enemy.name} 처치 · +${earned.toLocaleString()}G ${isFirstWin ? '(일일 첫승 2배!)' : ''} · 🔥 ${state.streak}연승`, 'win reward');
      updateUI();
      showRoulette();
    } else {
      log(`💀 패배... ${enemy.name}에게 졌습니다. 연승이 끊겼습니다.`, 'lose');
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

function showRoulette() {
  const modal = document.getElementById('rouletteModal');
  const slots = [0, 1, 2].map(i => document.getElementById(`slot${i}`));
  const resultEl = document.getElementById('rouletteResult');
  modal.style.display = 'flex';

  // reset
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

function closeRoulette() {
  document.getElementById('rouletteModal').style.display = 'none';
}

init();
