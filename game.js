'use strict';

/* ===== 調整可能な定数 ===== */
const SLOTS_PER_CELL = 10;
const MAX_CELLS      = 12;
const START_MAX_COIN = 2;                 // 初期 maxCoin（→ 初期セル数 3）
const INITIAL_COINS  = { 0: 6, 1: 4 };    // 初期配置枚数（tier: 枚数）。空セルを残して手詰まりを避ける
const DEAL_COUNT_MIN = 0;
const DEAL_COUNT_MAX = 5;                 // 各ティアの配布枚数上限

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
// 移動先が「空セル」か「トップが同じ数字」のとき、トップ run を入るだけ動かせる。
// run が空きより多ければ入る分だけの部分移動（＝dst が10個で埋まる。同一なら結果的にマージ）。
function computeMove(cells, srcIdx, dstIdx) {
  if (srcIdx === dstIdx) return 0;
  const src = cells[srcIdx];
  const dst = cells[dstIdx];
  const run = topRun(src);
  if (run.length === 0) return 0;
  const free = SLOTS_PER_CELL - dst.length;
  if (free <= 0) return 0;
  // 空セル、またはトップが同じ数字にのみ積める（別の数字の上には積めない）
  if (dst.length === 0 || dst[dst.length - 1] === run.tier) {
    return Math.min(run.length, free);
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
//   - 移動でマージ到達可能 → OK
//   - 配りで進展できる余地がある → OK
//       ・空セルがある（配れる数字を撒いて育てられる）
//       ・「配れる数字だけで構成された(=丸ごと同一の)セル」に空きがある（10個まで伸ばせる）
//   いずれも無ければ「詰み/不毛」。
function canProgress(cells, floor, ceil) {
  if (ceil < floor) return hasLegalMove(cells) || mergeReachable(cells);
  if (hasLegalMove(cells)) return true;
  if (mergeReachable(cells)) return true;
  for (const cell of cells) {
    if (freeSlots(cell) <= 0) continue;
    if (cell.length === 0) return true; // 空セルに配って育てられる
    // 混在セルはそれ以上マージへ育たない。丸ごと同一かつ配れる数字なら伸ばせる。
    if (cell.every((v) => v === cell[0]) && cell[0] >= floor && cell[0] <= ceil) return true;
  }
  return false;
}

// counts を配置する。cells を破壊的に変更して返す。
// ルール（これだけ）:
//   - 1バッチ = 1つの数字を数枚まとめて配る。
//   - 「1回のディールで 1セルに配る数字は1種類」だけが制約（＝各数字は別々のセルへ）。
//     セルの中身は問わない。空セルにも、別の数字が入ったセルの上にも積んでよい（混在OK）。
//   - どのセルに置くかは、空きのあるセルの中から作為なくランダムに選ぶ。
//   - 空きが足りなければ入るだけ、空きセルが尽きたらそのバッチは配らない。
function placeDeal(cells, counts) {
  const tiers = Object.keys(counts).map(Number).filter((t) => counts[t] > 0);
  const used = new Set(); // このディールで既に配ったセル（1ディール1セル1数字）
  for (const t of tiers) {
    const valid = [];
    for (let i = 0; i < cells.length; i++) {
      if (freeSlots(cells[i]) > 0 && !used.has(i)) valid.push(i);
    }
    if (valid.length === 0) continue; // 空きセルが無い → このバッチは配らない
    const dest = valid[randInt(0, valid.length - 1)];
    used.add(dest);
    const put = Math.min(counts[t], freeSlots(cells[dest]));
    for (let k = 0; k < put; k++) cells[dest].push(t);
  }
  return cells;
}

// 盤面が詰み（進行不能）なら詰み表示、そうでなければメッセージを消す。
function updateStatusMessage() {
  const floor = dealFloorFn(state.maxCoin, state.cells.length);
  const ceil = state.maxCoin - 1;
  if (!canProgress(state.cells, floor, ceil)) {
    message('詰みだ……「はじめから」でやり直せ');
  } else {
    message('');
  }
}

function deal() {
  const floor = dealFloorFn(state.maxCoin, state.cells.length);
  const ceil = state.maxCoin - 1;
  if (ceil < floor) { message('配れる数字が無い'); return; }

  const beforeLen = state.cells.map((c) => c.length);
  const placedAny = (cells) => cells.some((c, i) => c.length > beforeLen[i]);
  const rollCounts = () => {
    const counts = {};
    let sum = 0;
    for (let t = floor; t <= ceil; t++) { counts[t] = randInt(DEAL_COUNT_MIN, DEAL_COUNT_MAX); sum += counts[t]; }
    if (sum === 0) counts[randInt(floor, ceil)] = randInt(1, DEAL_COUNT_MAX);
    return counts;
  };

  // 基本ランダム。ただし「配った後に合法手が生まれない配り（全 top が相異なり空セルも無い）」は
  // 避ける方向に再抽選する。空きがある限り hasLegalMove な配りを選び、埋まってきて無理なら諦める。
  let chosen = null, fallback = null;
  const ATTEMPTS = 30;
  for (let a = 0; a < ATTEMPTS && !chosen; a++) {
    const trial = placeDeal(cloneCells(state.cells), rollCounts());
    if (!placedAny(trial)) continue;
    if (!fallback) fallback = trial;
    if (hasLegalMove(resolveMergesPure(trial))) chosen = trial;
  }
  const result = chosen || fallback;
  if (!result) {
    // 全セル満杯などでどこにも置けない。詰みかどうかを表示する。
    updateStatusMessage();
    return;
  }
  state.cells = result;

  // 新しく積まれたコインの位置を記録（降ってくる演出用）
  droppedCoins.clear();
  for (let i = 0; i < state.cells.length; i++) {
    for (let s = beforeLen[i]; s < state.cells[i].length; s++) droppedCoins.add(i + ':' + s);
  }
  selectedIdx = null;
  resolveMerges();
  saveState();
  render();
  updateStatusMessage();
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
    saveState();
    render();
    updateStatusMessage();
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

  console.log(boardString()); // 盤面を文字列で出力（共有用）
}

// 盤面を1行の文字列で表す。各 [...] は 1セル、左が底(index0)・右がトップ(手前)。
function boardString() {
  const cells = state.cells.map((c) => `[${c.join(',')}]`).join(' ');
  return `max=${state.maxCoin} score=${state.score} :: ${cells}`;
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
