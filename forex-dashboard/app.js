// Forex Dashboard - 환율 데이터 시각화
// Data: Frankfurter API (ECB 기반, 무료, 키 불필요) https://frankfurter.dev

const FLAGS = {
  USD: '🇺🇸', KRW: '🇰🇷', EUR: '🇪🇺', JPY: '🇯🇵', CNY: '🇨🇳',
  GBP: '🇬🇧', CHF: '🇨🇭', AUD: '🇦🇺', CAD: '🇨🇦', HKD: '🇭🇰',
  SGD: '🇸🇬', NZD: '🇳🇿', SEK: '🇸🇪', NOK: '🇳🇴', DKK: '🇩🇰',
};

const CURRENCY_NAMES = {
  USD: '미국 달러', KRW: '원화', EUR: '유로', JPY: '엔화', CNY: '위안',
  GBP: '파운드', CHF: '스위스프랑', AUD: '호주달러', CAD: '캐나다달러', HKD: '홍콩달러',
  SGD: '싱가포르달러', NZD: '뉴질랜드달러', SEK: '스웨덴크로나', NOK: '노르웨이크로나', DKK: '덴마크크로네',
};

// 기본 표시할 통화 (base 제외)
const DEFAULT_PAIRS = ['KRW', 'EUR', 'JPY', 'CNY', 'GBP', 'CNY', 'AUD', 'CHF'];

let state = {
  base: 'USD',
  range: 30,
  history: {},   // {date: {code: rate}}
  latest: {},
  alerts: JSON.parse(localStorage.getItem('forex_alerts') || '{}'),
  mainChart: null,
  currentTab: 'overview',
};

function init() {
  state.base = document.getElementById('baseSelect').value;
  state.range = parseInt(document.getElementById('rangeSelect').value);
  loadData();
}

async function loadData() {
  state.base = document.getElementById('baseSelect').value;
  state.range = parseInt(document.getElementById('rangeSelect').value);
  const grid = document.getElementById('rateGrid');
  grid.innerHTML = '<div class="loading">📡 환율 데이터 로딩 중...</div>';

  const end = new Date();
  const start = new Date(end.getTime() - state.range * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const s = fmt(start), e = fmt(end);

  try {
    const pairs = DEFAULT_PAIRS.filter(c => c !== state.base).slice(0, 8).join(',');
    const url = `https://api.frankfurter.app/${s}..${e}?from=${state.base}&to=${pairs}`;
    const res = await fetch(url);
    const data = await res.json();
    state.history = data.rates;
    const dates = Object.keys(state.history).sort();
    state.latest = state.history[dates[dates.length - 1]];

    document.getElementById('refreshInfo').textContent = `업데이트: ${data.date} (ECB 기준)`;
    renderOverview();
    setupChartPairSelect();
    if (state.currentTab === 'chart') renderChart();
    renderAlerts();
  } catch (err) {
    grid.innerHTML = `<div class="loading">❌ 로딩 실패: ${err.message}</div>`;
  }
}

function changeBase() {
  loadData();
}

function renderOverview() {
  const grid = document.getElementById('rateGrid');
  const dates = Object.keys(state.history).sort();
  const prevDate = dates.length >= 2 ? dates[dates.length - 2] : null;

  grid.innerHTML = Object.entries(state.latest).map(([code, rate]) => {
    const prev = prevDate ? state.history[prevDate][code] : rate;
    const diff = rate - prev;
    const pct = prev ? (diff / prev * 100) : 0;
    const up = diff >= 0;
    const cls = up ? 'up' : 'down';
    const arrow = up ? '▲' : '▼';
    const sparkData = dates.slice(-12).map(d => state.history[d][code]);

    return `<div class="card">
      <div class="pair">
        <span class="pair-flag">${FLAGS[code] || '🏳️'}</span>
        <span class="pair-name">${state.base}/${code}</span>
      </div>
      <div class="rate">${formatRate(rate)}</div>
      <div class="change ${cls}">${arrow} ${Math.abs(diff).toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</div>
      <svg class="spark" viewBox="0 0 120 40" preserveAspectRatio="none">${sparkPath(sparkData, up ? '#00d4aa' : '#ff5566')}</svg>
    </div>`;
  }).join('');
}

function sparkPath(data, color) {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * 120;
    const y = 40 - ((v - min) / range) * 36 - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="2"/>`;
}

function formatRate(r) {
  if (r >= 100) return r.toFixed(2);
  if (r >= 1) return r.toFixed(4);
  return r.toFixed(6);
}

function setupChartPairSelect() {
  const sel = document.getElementById('chartPairSelect');
  const codes = Object.keys(state.latest);
  sel.innerHTML = codes.map(c => `<option value="${c}">${FLAGS[c] || '🏳️'} ${state.base}/${c} (${CURRENCY_NAMES[c] || c})</option>`).join('');
}

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab')[['overview', 'chart', 'alerts'].indexOf(tab)].classList.add('active');
  document.getElementById('overviewTab').classList.toggle('hidden', tab !== 'overview');
  document.getElementById('chartTab').classList.toggle('hidden', tab !== 'chart');
  document.getElementById('alertsTab').classList.toggle('hidden', tab !== 'alerts');
  if (tab === 'chart') renderChart();
  if (tab === 'alerts') renderAlerts();
}

function renderChart() {
  const code = document.getElementById('chartPairSelect').value || Object.keys(state.latest)[0];
  const dates = Object.keys(state.history).sort();
  const values = dates.map(d => state.history[d][code]);
  const ctx = document.getElementById('mainChart').getContext('2d');

  if (state.mainChart) state.mainChart.destroy();

  const first = values[0], last = values[values.length - 1];
  const up = last >= first;
  const color = up ? '#00d4aa' : '#ff5566';

  state.mainChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: `${state.base}/${code}`,
        data: values,
        borderColor: color,
        backgroundColor: color + '22',
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e8eef5' } } },
      scales: {
        x: { ticks: { color: '#8896a8', maxTicksLimit: 8 }, grid: { color: '#1a2030' } },
        y: { ticks: { color: '#8896a8' }, grid: { color: '#1a2030' } },
      },
    },
  });

  const min = Math.min(...values), max = Math.max(...values);
  const change = last - first;
  const pct = (change / first * 100);
  const high = values.indexOf(max), low = values.indexOf(min);
  document.getElementById('chartStats').innerHTML = `
    <div>📈 <span>${formatRate(last)}</span> (최신)</div>
    <div>⬆️ 최고 <span>${formatRate(max)}</span> (${dates[high]})</div>
    <div>⬇️ 최저 <span>${formatRate(min)}</span> (${dates[low]})</div>
    <div>📊 변동 <span style="color:${up?'var(--up)':'var(--down)'}">${change >= 0 ? '+' : ''}${change.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span></div>
  `;
}

function renderAlerts() {
  const list = document.getElementById('alertList');
  const codes = Object.keys(state.latest);
  list.innerHTML = codes.map(code => {
    const cur = state.alerts[code];
    const above = cur ? cur.above : '';
    const below = cur ? cur.below : '';
    const triggered = (cur && ((cur.above && state.latest[code] >= parseFloat(cur.above)) || (cur.below && state.latest[code] <= parseFloat(cur.below))));
    return `<div class="alert-row" style="${triggered ? 'border:1px solid var(--accent); box-shadow:0 0 8px var(--accent);' : ''}">
      <span>${FLAGS[code] || '🏳️'} ${state.base}/${code} <span style="color:var(--dim)">(${formatRate(state.latest[code])})</span></span>
      <span>
        상승 알림 ≥ <input type="number" value="${above}" placeholder="-" onchange="setAlert('${code}','above',this.value)">
        하락 알림 ≤ <input type="number" value="${below}" placeholder="-" onchange="setAlert('${code}','below',this.value)">
      </span>
    </div>`;
  }).join('');
}

function setAlert(code, type, value) {
  if (!state.alerts[code]) state.alerts[code] = {};
  if (value === '') delete state.alerts[code][type];
  else state.alerts[code][type] = parseFloat(value);
  if (!state.alerts[code].above && !state.alerts[code].below) delete state.alerts[code];
  localStorage.setItem('forex_alerts', JSON.stringify(state.alerts));
  renderAlerts();
}

// 자동 새로고침 (5분)
setInterval(() => {
  if (state.currentTab === 'overview') loadData();
}, 5 * 60 * 1000);

init();