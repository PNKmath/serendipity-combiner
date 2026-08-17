/* 활자상자 — 조판과 재발견
 *
 * 잠금은 세 종류다: 활자 수, 슬롯의 축, 슬롯의 단어.
 * 이 셋의 조합만으로 "완전 랜덤"부터 "하나 붙잡고 스무 번 돌리기"까지 나온다.
 * 단어를 잠그면 축도 따라 잠긴다 — 축이 바뀌면 그 단어가 존재할 수 없으므로.
 *
 * 모드는 사전과 축만 갈아끼운다. 슬롯의 `pos`는 그 칸이 뽑히는 축의 이름이며,
 * 글감 모드에서는 품사(형용사·명사…), 제품 모드에서는 기술·대상·마찰·포맷·비틀기다.
 * 예전 기록과 호환을 지키려고 필드 이름은 `pos`를 그대로 쓴다.
 */

const HISTORY_CAP = 2000;

// ── 저장소 ──────────────────────────────────────────────

const memory = {};

const store = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return key in memory ? memory[key] : fallback;
    }
  },
  write(key, value) {
    memory[key] = value;
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* 파일 모드나 사생활 보호 모드에서는 메모리에만 남는다 */
    }
  },
};

// ── 상태 ────────────────────────────────────────────────

let state = store.read('sc.state', null) || {
  mode: DEFAULT_MODE,
  count: 3,
  countLocked: false,
  slots: [],
  currentId: null,
  stash: {},
};

// 모드가 없던 시절의 기록과 상태는 모두 글감으로 읽는다
if (!MODES[state.mode]) state.mode = DEFAULT_MODE;
if (!state.stash) state.stash = {};

let history = store.read('sc.history', []);
let filter = 'note';
let modeFilter = 'all';
let wordFilter = null;

const saveState = () => store.write('sc.state', state);
const saveHistory = () => store.write('sc.history', history);

// ── 뽑기 ────────────────────────────────────────────────

const pick = (list) => list[Math.floor(Math.random() * list.length)];

const mode = () => MODES[state.mode];

// once에 걸린 축은 이미 쓰인 자리가 있으면 다시 뽑지 않는다
function randAxis(taken = []) {
  const m = mode();
  const open = m.axes.filter((a) => !(m.once.includes(a) && taken.includes(a)));
  return pick(open.length ? open : m.axes);
}

const randWord = (axis) => pick(mode().pools[axis]);

// 단어 잠금은 품사 잠금을 함축하므로, "이 칸이 다시 뽑기에서 지켜지는가"와
// "이 칸의 품사가 고정인가"는 같은 조건이 된다.
const isLocked = (slot) => slot.posLocked || slot.wordLocked;

function newSlot(taken = []) {
  const axis = randAxis(taken);
  return { pos: axis, word: randWord(axis), posLocked: false, wordLocked: false, struck: true };
}

function draw() {
  const m = mode();
  const lockedCount = state.slots.filter(isLocked).length;

  let n = state.count;
  if (!state.countLocked) {
    const min = Math.max(m.min, lockedCount);
    n = min + Math.floor(Math.random() * (Math.max(m.max, min) - min + 1));
  } else {
    n = Math.max(n, lockedCount);
  }

  let slots = state.slots.slice();

  if (n < slots.length) {
    // 잠긴 칸을 먼저 지키고, 남는 자리를 왼쪽부터 채운다
    const keep = new Set(slots.filter(isLocked));
    for (const s of slots) {
      if (keep.size >= n) break;
      if (!isLocked(s)) keep.add(s);
    }
    slots = slots.filter((s) => keep.has(s));
  } else {
    while (slots.length < n) slots.push(newSlot());
  }

  // 잠긴 축을 먼저 세어두면 once에 걸린 축이 두 번 뽑히지 않는다
  const taken = slots.filter(isLocked).map((s) => s.pos);
  slots = slots.map((s) => {
    if (s.wordLocked) return { ...s, struck: false };
    if (s.posLocked) return { ...s, word: randWord(s.pos), struck: true };
    const axis = randAxis(taken);
    taken.push(axis);
    return { ...s, pos: axis, word: randWord(axis), struck: true };
  });

  state.count = slots.length;
  state.slots = slots;

  commitNew();
  render();
}

// 뽑을 때마다 새 기록이 열린다. 메모를 안 써도 조합 자체는 남는다.
function commitNew() {
  const entry = {
    id: `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    at: Date.now(),
    mode: state.mode,
    slots: state.slots.map((s) => ({ pos: s.pos, word: s.word })),
    note: '',
    pinned: false,
  };
  history.unshift(entry);
  trimHistory();
  state.currentId = entry.id;
  saveHistory();
  saveState();
}

// 넘긴 조합부터 오래된 순으로 덜어낸다. 적은 것과 표시한 것은 남긴다.
function trimHistory() {
  if (history.length <= HISTORY_CAP) return;
  for (let i = history.length - 1; i >= 0 && history.length > HISTORY_CAP; i--) {
    if (!history[i].note.trim() && !history[i].pinned) history.splice(i, 1);
  }
  if (history.length > HISTORY_CAP) history.length = HISTORY_CAP;
}

const currentEntry = () => history.find((e) => e.id === state.currentId);

// ── 조판 화면 ───────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const stick = $('stick');

function icon(name) {
  return `<svg aria-hidden="true"><use href="#${name}"></use></svg>`;
}

// 제품 사전에는 「리포트 자동 발송」처럼 긴 말이 있다. 활자 크기를 낮춰
// 카드가 저 혼자 커지지 않게 한다.
const wordScale = (w) => (w.length >= 9 ? 2 : w.length >= 6 ? 1 : 0);

function renderStick() {
  stick.innerHTML = '';

  state.slots.forEach((slot, i) => {
    const el = document.createElement('div');
    el.className = 'slug';
    if (slot.wordLocked) el.classList.add('is-set');
    if (isLocked(slot)) el.classList.add('is-poslocked');
    if (slot.struck) {
      el.classList.add('is-struck');
      el.style.animationDelay = `${i * 35}ms`;
    }

    const options = mode()
      .axes.map((a) => `<option value="${a}"${a === slot.pos ? ' selected' : ''}>${a}</option>`)
      .join('');

    el.innerHTML = `
      <div class="slug__head">
        <button class="slug__lock" data-act="poslock" aria-pressed="${isLocked(slot)}"
                title="${isLocked(slot) ? '축 고정 해제' : '축 고정'}">
          ${icon(isLocked(slot) ? 'i-lock' : 'i-unlock')}
        </button>
        <select class="slug__pos" data-act="pos" aria-label="${i + 1}번째 축">${options}</select>
      </div>
      <button class="slug__word" data-act="wordlock" data-long="${wordScale(slot.word)}"
              title="${slot.wordLocked ? '단어 고정 해제' : '단어 고정'}">${slot.word}</button>
      <div class="slug__acts">
        <button class="slug__act" data-act="reroll" title="이 칸만 다시 뽑기">${icon('i-redraw')}</button>
        <button class="slug__act" data-act="remove" title="이 칸 빼기"
                ${state.slots.length <= mode().min ? 'disabled' : ''}>${icon('i-remove')}</button>
      </div>`;

    el.addEventListener('pointerdown', (ev) => startDrag(ev, i, el));
    el.addEventListener('keydown', (ev) => {
      if (!ev.altKey) return;
      const to = ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'ArrowRight' ? i + 1 : -1;
      if (to < 0 || to >= state.slots.length) return;
      ev.preventDefault();
      moveSlot(i, to);
    });
    el.addEventListener('click', (ev) => {
      if (didDrag) return; // 옮기고 손을 뗀 것은 누른 것이 아니다
      const btn = ev.target.closest('[data-act]');
      if (!btn || btn.tagName === 'SELECT') return;
      slotAction(btn.dataset.act, i);
    });
    el.querySelector('[data-act="pos"]').addEventListener('change', (ev) => {
      const s = state.slots[i];
      s.pos = ev.target.value;
      s.word = randWord(s.pos);
      s.posLocked = true; // 직접 고른 축은 지켜준다
      s.struck = true;
      syncCurrent();
      render();
    });

    stick.appendChild(el);
    slot.struck = false;
  });

  const add = document.createElement('button');
  add.className = 'addslug';
  add.textContent = '+';
  add.title = '활자 추가';
  add.disabled = state.slots.length >= mode().max;
  add.addEventListener('click', () => {
    if (state.slots.length >= mode().max) return;
    state.slots.push(newSlot(state.slots.map((s) => s.pos)));
    state.count = state.slots.length;
    syncCurrent();
    render();
  });
  stick.appendChild(add);
}

function slotAction(act, i) {
  const s = state.slots[i];
  if (act === 'poslock') {
    if (s.wordLocked) {
      s.wordLocked = false;
      s.posLocked = false;
    } else {
      s.posLocked = !s.posLocked;
    }
  } else if (act === 'wordlock') {
    s.wordLocked = !s.wordLocked;
  } else if (act === 'reroll') {
    if (!s.posLocked && !s.wordLocked) {
      s.pos = randAxis(state.slots.filter((o) => o !== s).map((o) => o.pos));
    }
    s.word = randWord(s.pos);
    s.struck = true;
    syncCurrent();
  } else if (act === 'remove') {
    if (state.slots.length <= mode().min) return;
    state.slots.splice(i, 1);
    state.count = state.slots.length;
    syncCurrent();
  }
  render();
}

// ── 활자 옮기기 ─────────────────────────────────────────
//
// 집어 든 활자는 조판대에서 떠서 포인터를 따라다니고, 원래 있던 자리에는
// 빈 자리(ghost)가 남아 어디에 놓이는지 미리 보여준다.

let drag = null;
let didDrag = false;

const DRAG_THRESHOLD = 5; // 이만큼 움직이기 전까지는 누른 것으로 본다

function startDrag(ev, index, el) {
  if (ev.button !== 0 || drag) return;
  if (ev.target.closest('select, .slug__lock, .slug__act')) return;

  didDrag = false;
  const rect = el.getBoundingClientRect();
  drag = {
    index,
    el,
    startX: ev.clientX,
    startY: ev.clientY,
    grabX: ev.clientX - rect.left,
    grabY: ev.clientY - rect.top,
    width: rect.width,
    height: rect.height,
    lifted: false,
    ghost: null,
  };

  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}

function onDragMove(ev) {
  if (!drag) return;

  if (!drag.lifted) {
    if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.lifted = true;
    didDrag = true;

    const ghost = document.createElement('div');
    ghost.className = 'slug-ghost';
    ghost.style.width = `${drag.width}px`;
    ghost.style.height = `${drag.height}px`;
    drag.ghost = ghost;
    stick.insertBefore(ghost, drag.el);

    drag.el.classList.add('is-dragging');
    drag.el.style.width = `${drag.width}px`;
    drag.el.style.height = `${drag.height}px`;
  }

  ev.preventDefault();
  drag.el.style.left = `${ev.clientX - drag.grabX}px`;
  drag.el.style.top = `${ev.clientY - drag.grabY}px`;
  placeGhost(ev.clientX, ev.clientY);
}

// 포인터보다 오른쪽에 있는 첫 활자 앞이 놓일 자리다. 줄이 넘어간 경우까지
// 다루려고 세로 위치도 함께 본다.
function placeGhost(x, y) {
  const others = [...stick.querySelectorAll('.slug')].filter((n) => n !== drag.el);
  let before = null;
  for (const n of others) {
    const r = n.getBoundingClientRect();
    if (y < r.bottom && x < r.left + r.width / 2) {
      before = n;
      break;
    }
  }
  const anchor = before || stick.querySelector('.addslug');
  if (drag.ghost.nextSibling !== anchor) stick.insertBefore(drag.ghost, anchor);
}

function endDrag() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);

  const d = drag;
  drag = null;
  if (!d || !d.lifted) return;

  // 빈 자리 앞에 놓인 활자의 수가 곧 새 자리다
  let to = 0;
  for (const node of stick.children) {
    if (node === d.ghost) break;
    if (node.classList.contains('slug') && node !== d.el) to++;
  }

  d.ghost.remove();
  d.el.classList.remove('is-dragging');
  d.el.removeAttribute('style');

  moveSlot(d.index, to);
  setTimeout(() => { didDrag = false; }, 0);
}

function moveSlot(from, to) {
  if (from !== to) {
    const [moved] = state.slots.splice(from, 1);
    state.slots.splice(to, 0, moved);
    syncCurrent();
  }
  render();
  const landed = stick.querySelectorAll('.slug')[to];
  if (landed) landed.querySelector('.slug__word').focus();
}

// 조판을 손보면 열려 있는 기록도 같이 고쳐진다
function syncCurrent() {
  const entry = currentEntry();
  if (entry) {
    entry.slots = state.slots.map((s) => ({ pos: s.pos, word: s.word }));
    saveHistory();
  }
}

// 원리 이름만 찍힌 활자는 아무 생각도 불러오지 않는다. 설명은 카드를 키우지 않고
// 조판대 아래 한 줄로 뺀다.
function renderGloss() {
  const el = $('gloss');
  const found = state.slots.filter((s) => TRIZ[s.word]);
  el.classList.toggle('hidden', found.length === 0);
  el.innerHTML = found
    .map((s) => {
      const t = TRIZ[s.word];
      return `<p class="gloss__line"><span class="gloss__no">TRIZ ${t.no}</span>
        <b>${s.word}</b><span class="gloss__dash">—</span>${t.hint}</p>`;
    })
    .join('');
}

function renderRail() {
  $('mode-seg')
    .querySelectorAll('[data-mode]')
    .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));

  $('count-n').textContent = state.slots.length;
  const lock = $('count-lock');
  lock.setAttribute('aria-pressed', String(state.countLocked));
  lock.querySelector('use').setAttribute('href', state.countLocked ? '#i-lock' : '#i-unlock');
  $('count-lock-label').textContent = state.countLocked ? '개수 고정' : '개수 랜덤';

  const entry = currentEntry();
  const pin = $('pin');
  const pinned = !!(entry && entry.pinned);
  pin.setAttribute('aria-pressed', String(pinned));
  pin.querySelector('use').setAttribute('href', pinned ? '#i-pin' : '#i-pin-o');
}

function render() {
  renderStick();
  renderGloss();
  renderRail();
  const entry = currentEntry();
  if (entry && $('note').value !== entry.note) $('note').value = entry.note;
  saveState();
}

// ── 모드 갈아끼우기 ─────────────────────────────────────

function drawFresh() {
  const m = mode();
  const n = m.min + Math.floor(Math.random() * (m.max - m.min + 1));
  const taken = [];
  state.slots = Array.from({ length: n }, () => {
    const s = newSlot(taken);
    taken.push(s.pos);
    return s;
  });
  state.count = n;
  commitNew();
  render();
}

function switchMode(next) {
  if (next === state.mode || !MODES[next]) return;

  // 떠나는 모드의 조판을 그대로 넣어두고, 돌아오면 꺼내 쓴다
  state.stash[state.mode] = {
    count: state.count,
    countLocked: state.countLocked,
    slots: state.slots,
  };
  state.mode = next;

  const kept = state.stash[next];
  const usable =
    kept && kept.slots.length && kept.slots.every((s) => MODES[next].axes.includes(s.pos));

  if (usable) {
    state.count = kept.count;
    state.countLocked = kept.countLocked;
    state.slots = kept.slots;
    commitNew();
    render();
  } else {
    state.countLocked = false;
    drawFresh();
  }
}

// ── 재발견 화면 ─────────────────────────────────────────

function formatDate(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const entryMode = (e) => e.mode || DEFAULT_MODE;

function matchesFilter(e) {
  if (modeFilter !== 'all' && entryMode(e) !== modeFilter) return false;
  if (wordFilter && !e.slots.some((s) => s.word === wordFilter)) return false;
  if (filter === 'note') return e.note.trim().length > 0;
  if (filter === 'pin') return e.pinned;
  if (filter === 'skip') return !e.note.trim();
  return true;
}

function entryNode(e) {
  const el = document.createElement('article');
  el.className = 'entry';

  const words = e.slots
    .map((s) => {
      const t = TRIZ[s.word];
      const tip = t ? `${s.pos} · TRIZ ${t.no} — ${t.hint}` : `${s.pos} · 이 단어로 모아보기`;
      return `<button class="miniword" data-word="${s.word}" title="${tip}">${s.word}</button>`;
    })
    .join('');

  el.innerHTML = `
    <div class="entry__line">${words}</div>
    ${e.note.trim() ? `<p class="entry__note">${escapeHtml(e.note)}</p>` : ''}
    <div class="entry__meta">
      <button class="entry__pin" data-pin aria-pressed="${e.pinned}" title="표시해두기">
        ${icon(e.pinned ? 'i-pin' : 'i-pin-o')}
      </button>
      <span class="entry__mode">${entryMode(e)}</span>
      <span>${formatDate(e.at)}</span>
      <button class="entry__del" data-del>지우기</button>
    </div>`;

  el.addEventListener('click', (ev) => {
    const w = ev.target.closest('[data-word]');
    if (w) {
      wordFilter = w.dataset.word;
      if (filter === 'note') filter = 'all';
      syncFilterChips();
      renderRecall();
      return;
    }
    if (ev.target.closest('[data-pin]')) {
      e.pinned = !e.pinned;
      saveHistory();
      renderRecall();
      renderRail();
      return;
    }
    if (ev.target.closest('[data-del]')) {
      history = history.filter((x) => x.id !== e.id);
      saveHistory();
      renderRecall();
    }
  });

  return el;
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderRecall() {
  // 단어 필터 표시
  const slot = $('wordfilter-slot');
  slot.innerHTML = '';
  if (wordFilter) {
    const chip = document.createElement('div');
    chip.className = 'wordfilter';
    chip.innerHTML = `<span>“${wordFilter}”이(가) 들어간 조합</span><button title="해제">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      wordFilter = null;
      renderRecall();
    });
    slot.appendChild(chip);
  }

  // 다시 마주치기 — 지금 걸러 보는 범위 안에서 한 조각을 올린다.
  // 「그냥 넘긴 것」을 보고 있으면 넘긴 조합이 올라오는 게 맞다.
  // 단어를 파고드는 중일 때는 올리지 않는다 — 그건 조회지 재발견이 아니다.
  const surfaced = $('surfaced');
  surfaced.innerHTML = '';
  const pool = history.filter((e) => e.id !== state.currentId && matchesFilter(e));
  let resurfaced = null;
  if (pool.length >= 3 && !wordFilter) {
    resurfaced = pick(pool);
    const box = document.createElement('div');
    box.className = 'surfaced';
    box.innerHTML = '<div class="surfaced__label">다시 마주치기</div>';
    box.appendChild(entryNode(resurfaced));
    surfaced.appendChild(box);
  }

  const list = $('entries');
  list.innerHTML = '';
  // 위에 올라온 조합은 아래 목록에서 뺀다 — 같은 것이 두 번 보이지 않게
  const rows = history.filter((e) => e !== resurfaced && matchesFilter(e));

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = wordFilter
      ? '이 단어로 만든 조합이 아직 없습니다.'
      : filter === 'note'
      ? '아직 적어둔 것이 없습니다. 조판으로 가서 한 줄 남겨보세요.'
      : '아직 없습니다.';
    list.appendChild(empty);
    return;
  }

  rows.forEach((e) => list.appendChild(entryNode(e)));
}

function syncFilterChips() {
  const box = $('filters');
  box.querySelectorAll('[data-filter]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.filter === filter));
  });
  box.querySelectorAll('[data-modefilter]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.modefilter === modeFilter));
  });
}

// ── 배선 ────────────────────────────────────────────────

$('draw').addEventListener('click', draw);

$('count-lock').addEventListener('click', () => {
  state.countLocked = !state.countLocked;
  state.count = state.slots.length;
  render();
});

$('unlock-all').addEventListener('click', () => {
  state.countLocked = false;
  state.slots.forEach((s) => {
    s.posLocked = false;
    s.wordLocked = false;
  });
  render();
});

$('pin').addEventListener('click', () => {
  const entry = currentEntry();
  if (!entry) return;
  entry.pinned = !entry.pinned;
  saveHistory();
  renderRail();
});

let noteTimer = null;
$('note').addEventListener('input', (ev) => {
  const entry = currentEntry();
  if (!entry) return;
  entry.note = ev.target.value;
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    saveHistory();
    const badge = $('saved');
    badge.classList.add('is-on');
    setTimeout(() => badge.classList.remove('is-on'), 1200);
  }, 400);
});

$('filters').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-filter], [data-modefilter]');
  if (!b) return;
  if (b.dataset.filter) filter = b.dataset.filter;
  else modeFilter = b.dataset.modefilter;
  syncFilterChips();
  renderRecall();
});

$('mode-seg').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-mode]');
  if (b) switchMode(b.dataset.mode);
});

function showTab(name) {
  const compose = name === 'compose';
  $('view-compose').classList.toggle('hidden', !compose);
  $('view-recall').classList.toggle('hidden', compose);
  $('tab-compose').setAttribute('aria-selected', String(compose));
  $('tab-recall').setAttribute('aria-selected', String(!compose));
  if (!compose) renderRecall();
}
$('tab-compose').addEventListener('click', () => showTab('compose'));
$('tab-recall').addEventListener('click', () => showTab('recall'));

document.addEventListener('keydown', (ev) => {
  if (ev.code !== 'Space' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const t = ev.target;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'BUTTON')) return;
  if ($('view-compose').classList.contains('hidden')) return;
  ev.preventDefault();
  draw();
});

// ── 시작 ────────────────────────────────────────────────

// 저장된 조판이 지금 모드의 축과 맞지 않으면 새로 뽑는다
const restorable = state.slots.length && state.slots.every((s) => mode().axes.includes(s.pos));

if (restorable) {
  if (!currentEntry()) commitNew();
  render();
} else {
  drawFresh();
}
syncFilterChips();
