'use strict';

/* ===== 調整可能な定数 ===== */
const SLOTS_PER_CELL = 10;
const MAX_CELLS      = 12;
const START_MAX_COIN = 2;                 // 初期 maxCoin（→ 初期セル数 3）
const INITIAL_COINS  = { 0: 6, 1: 4 };    // 初期配置枚数（tier: 枚数）。空セルを残して手詰まりを避ける
const DEAL_COUNT_MIN = 0;
const DEAL_COUNT_MAX = 5;                 // 各ティアの配布枚数上限
const REQUIRE_MATCH_ON_DROP = true;       // 手動移動は「空セル or トップが同じ数字」のみ許可（ディールの混在積みは別）
const DEAL_ATTEMPTS  = 40;                // 詰み回避のための再抽選回数

// ディール下限：max − セルの数（playtest で差し替え可能）
function dealFloorFn(maxCoin, cellCount) {
  return Math.max(0, maxCoin - cellCount);
}

const STORAGE_KEY = 'dealcoin.state.v1';
const HS_KEY = 'dealcoin.highscore.v1';

/* ===== 状態 ===== */
const state = {
  cells: [],   // number[][]  index 0 = 底, 末尾 = トップ（手前）
  maxCoin: START_MAX_COIN,
  score: 0,
  highScore: 0,
};
let selectedIdx = null;
const mergedFlash = new Set(); // アニメ用（このrenderで弾けるセル）
const droppedCoins = new Set(); // アニメ用（このrenderで降ってくるコイン "cellIdx:slotIdx"）

/* ===== ユーティリティ ===== */
const $ = (id) => document.getElementById(id);
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const cloneCells = (cells) => cells.map((c) => c.slice());
const freeSlots = (cell) => SLOTS_PER_CELL - cell.length;
const cellCount = () => Math.min(MAX_CELLS, state.maxCoin + 1);
const coinValue = (tier) => Math.round(2 * Math.pow(5, tier)); // マージ加点用

function topRun(cell) {
  if (cell.length === 0) return { tier: null, length: 0 };
  const tier = cell[cell.length - 1];
  let length = 0;
  for (let i = cell.length - 1; i >= 0 && cell[i] === tier; i--) length++;
  return { tier, length };
}

function coinColor(tier) {
  const hue = (tier * 47) % 360;
  return `hsl(${hue} 78% 62%)`;
}

/* ===== 盤面ロジック ===== */
function newGame() {
  state.maxCoin = START_MAX_COIN;
  state.score = 0;
  const n = Math.min(MAX_CELLS, START_MAX_COIN + 1);
  state.cells = Array.from({ length: n }, () => []);
  // 初期コインも「1セル1数字」で配置（placeDeal と同じ規則）
  placeDeal(state.cells, { ...INITIAL_COINS });
  selectedIdx = null;
  resolveMerges();
}

// s から d へ動かせる枚数を返す（0 = 不可）。
// 通常はトップ run 全部。ただし移動先が全て同ティアで、そこへ積むと
// ちょうど10個そろってマージが起きる場合は、run の一部だけ動かせる（部分移動）。
function computeMove(cells, srcIdx, dstIdx) {
  if (srcIdx === dstIdx) return 0;
  const src = cells[srcIdx];
  const dst = cells[dstIdx];
  const run = topRun(src);
  if (run.length === 0) return 0;

  // 通常移動: run 全部が入る空きがある
  const free = SLOTS_PER_CELL - dst.length;
  if (free >= run.length) {
    if (REQUIRE_MATCH_ON_DROP && dst.length > 0 && dst[dst.length - 1] !== run.tier) return 0;
    return run.length;
  }

  // マージ完成の部分移動: dst が全て同ティア && 10個まで満たせるだけ run がある
  if (dst.length > 0 && dst.every((v) => v === run.tier)) {
    const need = SLOTS_PER_CELL - dst.length; // 10 に届かせる枚数
    if (run.length >= need) return need;
  }
  return 0;
}

function canMove(srcIdx, dstIdx) {
  return computeMove(state.cells, srcIdx, dstIdx) > 0;
}

function moveRun(srcIdx, dstIdx) {
  const amount = computeMove(state.cells, srcIdx, dstIdx);
  if (amount <= 0) return;
  const src = state.cells[srcIdx];
  const dst = state.cells[dstIdx];
  const tier = src[src.length - 1];
  for (let i = 0; i < amount; i++) src.pop();
  for (let i = 0; i < amount; i++) dst.push(tier);
}

// 10個同一のセルを [n+1, n+1] に崩す（scoring付き・実状態を変更）
function resolveMerges() {
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < state.cells.length; i++) {
      const cell = state.cells[i];
      if (cell.length === SLOTS_PER_CELL && cell.every((v) => v === cell[0])) {
        const n = cell[0];
        state.cells[i] = [n + 1, n + 1];
        state.score += coinValue(n + 1);
        mergedFlash.add(i);
        changed = true;
      }
    }
    if (changed) updateMaxAndCells();
  }
  updateMaxAndCells();
  if (state.score > state.highScore) {
    state.highScore = state.score;
    saveHighScore();
  }
}

function updateMaxAndCells() {
  let present = state.maxCoin;
  for (const cell of state.cells) {
    for (const v of cell) if (v > present) present = v;
  }
  state.maxCoin = Math.max(state.maxCoin, present); // 単調増加（セルは減らさない）
  const desired = cellCount();
  while (state.cells.length < desired) state.cells.push([]);
  retireBelowFloor(dealFloorFn(state.maxCoin, state.cells.length));
}

// 下限未満のティアを盤上から除去（引退）
function retireBelowFloor(floor) {
  if (floor <= 0) return;
  for (let i = 0; i < state.cells.length; i++) {
    state.cells[i] = state.cells[i].filter((v) => v >= floor);
  }
}

/* ===== 合法手判定 & ディール ===== */
function hasLegalMove(cells) {
  for (let s = 0; s < cells.length; s++) {
    if (cells[s].length === 0) continue;
    for (let d = 0; d < cells.length; d++) {
      if (d !== s && computeMove(cells, s, d) > 0) return true;
    }
  }
  return false;
}

// マージだけ解決した結果のセル配列を返す（純粋・状態は変えない）
function resolveMergesPure(cells) {
  const out = cloneCells(cells);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const cell = out[i];
      if (cell.length === SLOTS_PER_CELL && cell.every((v) => v === cell[0])) {
        out[i] = [cell[0] + 1, cell[0] + 1];
        changed = true;
      }
    }
  }
  return out;
}

// 移動だけで（ディール無しで）いずれかのマージを完成できるか。有界DFS。
// 必要条件: あるティアが盤上に10枚以上ある。
function mergeReachable(cells) {
  const cnt = {};
  for (const c of cells) for (const v of c) cnt[v] = (cnt[v] || 0) + 1;
  if (!Object.values(cnt).some((n) => n >= SLOTS_PER_CELL)) return false;
  const seen = new Set();
  const stack = [cloneCells(cells)];
  let budget = 4000;
  while (stack.length && budget-- > 0) {
    const cur = stack.pop();
    const key = cur.map((c) => c.join('.')).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    for (let s = 0; s < cur.length; s++) {
      if (cur[s].length === 0) continue;
      const tier = cur[s][cur[s].length - 1];
      for (let d = 0; d < cur.length; d++) {
        const amount = computeMove(cur, s, d);
        if (amount <= 0) continue;
        const nx = cloneCells(cur);
        for (let i = 0; i < amount; i++) nx[s].pop();
        for (let i = 0; i < amount; i++) nx[d].push(tier);
        for (const c of nx) if (c.length === SLOTS_PER_CELL && c.every((v) => v === c[0])) return true;
        stack.push(nx);
      }
    }
  }
  return false;
}

// この盤面はまだ進行できるか（詰み/不毛でないか）。
//   - 合法手がある（今すぐ動かせる）→ OK
//   - まだマージ到達可能（移動で完成できる）→ OK
//   - 配れる数字のスタック（空 or そのトップ）があり、配り続ければ10個に届く → OK
// いずれも無ければ「詰み/不毛」。
function canProgress(cells, floor, ceil) {
  if (hasLegalMove(cells)) return true;
  if (mergeReachable(cells)) return true;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (freeSlots(cell) <= 0) continue;
    const top = cell.length ? cell[cell.length - 1] : null;
    if (cell.length === 0) { if (ceil >= floor) return true; } // 空セルに配れる
    else if (top >= floor && top <= ceil) return true;         // 配れる数字のスタックを伸ばせる
  }
  return false;
}

// counts を配置する。cells を破壊的に変更して返す。
// ルール（これだけ）:
//   - 1バッチ = 1つの数字を数枚まとめて配る。
//   - 置ける先は「空セル」か「同じ数字のセル（空きあり）」だけ（別の数字の上には積まない）。
//   - 制約を満たすセルの中から、寄せる/散らす等の作為なしにランダムに選ぶ。
//   - 丸ごと入らなければ入るだけ、置ける先が無ければそのバッチは配らない。
function placeDeal(cells, counts) {
  const tiers = Object.keys(counts).map(Number);
  for (const t of tiers) {
    const c = counts[t];
    if (!c || c <= 0) continue;
    const valid = [];
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (freeSlots(cell) <= 0) continue;
      if (cell.length === 0 || cell[cell.length - 1] === t) valid.push(i);
    }
    if (valid.length === 0) continue; // このバッチは置ける先が無い
    const dest = valid[randInt(0, valid.length - 1)];
    const put = Math.min(c, freeSlots(cells[dest]));
    for (let k = 0; k < put; k++) cells[dest].push(t);
  }
  return cells;
}

function deal() {
  const floor = dealFloorFn(state.maxCoin, state.cells.length);
  const ceil = state.maxCoin - 1;
  if (ceil < floor) { message('配れる数字が無い'); return; }

  const beforeLen = state.cells.map((c) => c.length);
  const placedSomething = (trial) => trial.some((c, i) => c.length > beforeLen[i]);

  // 基本はランダム。結果が詰み/不毛になる配りだけ再抽選する。
  // どう配っても詰み/不毛にしかならない場合は、何か置ける配りをそのまま採用。
  let chosen = null;   // 詰み/不毛でない配り（採用）
  let fallback = null; // とにかく何か置けた配り（保険）
  const ATTEMPTS = 50;
  for (let a = 0; a < ATTEMPTS && !chosen; a++) {
    const counts = {};
    let sum = 0;
    for (let t = floor; t <= ceil; t++) {
      counts[t] = randInt(DEAL_COUNT_MIN, DEAL_COUNT_MAX);
      sum += counts[t];
    }
    if (sum === 0) continue;
    const trial = placeDeal(cloneCells(state.cells), counts);
    if (!placedSomething(trial)) continue;
    if (!fallback) fallback = trial;
    const after = resolveMergesPure(trial);
    if (canProgress(after, floor, ceil)) chosen = trial; // 詰み/不毛でない→採用
    // それ以外は再抽選
  }

  const result = chosen || fallback;
  if (!result) {
    // 空セルも同じ数字のセルも無い（全トップが max）。移動で寄せて整理する場面。
    message('配る場所が無い。コインを動かして整理しろ');
    return;
  }

  state.cells = result;
  // 新しく積まれたコインの位置を記録（降ってくる演出用）
  droppedCoins.clear();
  for (let i = 0; i < state.cells.length; i++) {
    for (let s = beforeLen[i]; s < state.cells[i].length; s++) droppedCoins.add(i + ':' + s);
  }
  selectedIdx = null;
  resolveMerges(); // マージしたセルは位置がずれる→ render 側の slot<length ガードで自然に落下対象から外れる
  message('');
  saveState();
  render();
}

/* ===== 入力 ===== */
function onCellClick(idx) {
  if (selectedIdx === null) {
    if (state.cells[idx].length > 0) selectedIdx = idx;
    render();
    return;
  }
  if (selectedIdx === idx) {
    selectedIdx = null;
    render();
    return;
  }
  if (canMove(selectedIdx, idx)) {
    moveRun(selectedIdx, idx);
    selectedIdx = null;
    resolveMerges();
    message('');
    saveState();
    render();
    if (!hasLegalMove(state.cells)) {
      message('動かせる手が無い。ディールで補充しろ');
    }
  } else if (state.cells[idx].length > 0) {
    selectedIdx = idx; // 選択を移す
    render();
  } else {
    flashInvalid(idx);
  }
}

function flashInvalid(idx) {
  const el = document.querySelector(`.cell[data-idx="${idx}"]`);
  if (!el) return;
  el.classList.add('invalid');
  setTimeout(() => el.classList.remove('invalid'), 200);
}

/* ===== 描画 ===== */
function render() {
  const board = $('board');
  board.innerHTML = '';
  const selRun = selectedIdx !== null ? topRun(state.cells[selectedIdx]) : null;
  let dropOrder = 0; // 降ってくるコインのカスケード順

  state.cells.forEach((cell, idx) => {
    const cellEl = document.createElement('div');
    cellEl.className = 'cell';
    cellEl.dataset.idx = idx;
    if (idx === selectedIdx) cellEl.classList.add('selected');
    if (selectedIdx !== null && idx !== selectedIdx && canMove(selectedIdx, idx)) {
      cellEl.classList.add('target');
    }
    if (mergedFlash.has(idx)) cellEl.classList.add('merge-flash'); // マージ発生セルを光らせる

    for (let s = 0; s < SLOTS_PER_CELL; s++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      if (s < cell.length) {
        const coin = document.createElement('div');
        coin.className = 'coin';
        coin.style.background = coinColor(cell[s]);
        coin.textContent = cell[s];
        // 選択セルのトップrunをハイライト
        if (idx === selectedIdx && selRun && s >= cell.length - selRun.length) {
          coin.classList.add('picked');
        }
        if (mergedFlash.has(idx) && s < 2) coin.classList.add('merged');
        if (droppedCoins.has(idx + ':' + s)) {
          coin.classList.add('dropping');
          coin.style.animationDelay = Math.min(dropOrder, 12) * 45 + 'ms';
          dropOrder++;
        }
        slot.appendChild(coin);
      }
      cellEl.appendChild(slot);
    }

    cellEl.addEventListener('click', () => onCellClick(idx));
    board.appendChild(cellEl);
  });

  mergedFlash.clear();
  droppedCoins.clear();

  $('score').textContent = state.score.toLocaleString();
  $('maxcoin').textContent = state.maxCoin;
  $('highscore').textContent = state.highScore.toLocaleString();
}

function message(text) {
  $('message').textContent = text;
}

/* ===== 永続化 ===== */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      cells: state.cells,
      maxCoin: state.maxCoin,
      score: state.score,
    }));
  } catch (e) { /* ignore */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!Array.isArray(d.cells)) return null;
    return d;
  } catch (e) { return null; }
}

function loadHighScore() {
  try {
    const v = Number(localStorage.getItem(HS_KEY));
    return Number.isFinite(v) ? v : 0;
  } catch (e) { return 0; }
}

function saveHighScore() {
  try { localStorage.setItem(HS_KEY, String(state.highScore)); } catch (e) { /* ignore */ }
}

/* ===== 起動 ===== */
function init() {
  state.highScore = loadHighScore();
  const saved = loadState();
  if (saved) {
    state.cells = saved.cells.map((c) => c.slice());
    state.maxCoin = saved.maxCoin ?? START_MAX_COIN;
    state.score = saved.score ?? 0;
    if (state.score > state.highScore) state.highScore = state.score;
    updateMaxAndCells();
  } else {
    newGame();
  }

  $('deal-btn').addEventListener('click', deal);
  $('new-btn').addEventListener('click', () => {
    newGame();
    message('');
    saveState();
    render();
  });

  render();
}

document.addEventListener('DOMContentLoaded', init);
