// =================================================================
// Workout Tracker — vanilla JS, no APIs, no AI.
// Data is saved to BOTH localStorage and IndexedDB on every change;
// on boot the freshest copy wins, so losing one store loses nothing.
// =================================================================

// ---------------- store ----------------
const STORE_KEY = 'wtt_v1';
const IDB_NAME = 'wtt';

const DEFAULT_STATE = {
  savedAt: 0,
  sessions: [],        // finished workouts
  plans: [],           // saved workout plans
  activeSession: null, // in-progress workout (survives app close)
  settings: {
    unit: 'lbs',
    excludeLegs: true,
    equipment: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight'],
  },
};

function mergeState(data) {
  return {
    ...structuredClone(DEFAULT_STATE),
    ...data,
    settings: { ...structuredClone(DEFAULT_STATE.settings), ...(data.settings || {}) },
  };
}

let state = (() => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? mergeState(JSON.parse(raw)) : structuredClone(DEFAULT_STATE);
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
})();

// IndexedDB mirror — second copy of everything
let idb = null;
function idbOpen() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
function idbWrite(json) {
  if (!idb) return;
  try { idb.transaction('kv', 'readwrite').objectStore('kv').put(json, 'state'); } catch {}
}
function idbRead() {
  return new Promise(resolve => {
    if (!idb) return resolve(null);
    try {
      const req = idb.transaction('kv').objectStore('kv').get('state');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

function save() {
  state.savedAt = Date.now();
  const json = JSON.stringify(state);
  try { localStorage.setItem(STORE_KEY, json); } catch {}
  idbWrite(json);
}

async function bootStorage() {
  idb = await idbOpen();
  // if IndexedDB holds a newer copy (e.g. localStorage got cleared), restore it
  const raw = await idbRead();
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if ((data.savedAt || 0) > (state.savedAt || 0)) { state = mergeState(data); render(); }
    } catch {}
  }
  save(); // make sure both stores hold the latest
  // ask the browser to never evict our storage under pressure
  if (navigator.storage && navigator.storage.persist) {
    try { await navigator.storage.persist(); } catch {}
  }
}

// ---------------- helpers ----------------
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function dateKey(d = new Date()) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function parseKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function daysBetween(keyA, keyB) {
  return Math.round((parseKey(keyB) - parseKey(keyA)) / 86400000);
}
function fmtDay(key) {
  return parseKey(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Deterministic per-day PRNG so generated workouts rotate day to day (time-based, no AI)
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const dayRand = mulberry32(Math.floor(Date.now() / 86400000));

function toast(msg) {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------------- recency engine ----------------
function muscleStatus() {
  const status = {};
  for (const m of Object.keys(MUSCLES)) status[m] = { direct: null, indirect: null };

  for (const sess of state.sessions) {
    for (const ex of sess.exercises) {
      const def = EXERCISES_BY_ID[ex.exId];
      if (!def) continue;
      if (!ex.sets.some(s => s.done)) continue;
      for (const m of def.primary) {
        if (!status[m].direct || sess.date > status[m].direct) status[m].direct = sess.date;
      }
      for (const m of def.secondary) {
        if (!status[m].indirect || sess.date > status[m].indirect) status[m].indirect = sess.date;
      }
    }
  }

  const today = dateKey();
  for (const m of Object.keys(status)) {
    const st = status[m];
    st.days = st.direct ? daysBetween(st.direct, today) : null; // null = never trained
    st.level = st.days === null ? 'never'
      : st.days <= 2 ? 'fresh'
      : st.days <= 4 ? 'ok'
      : st.days <= 7 ? 'stale'
      : st.days <= 13 ? 'old' : 'never';
  }
  return status;
}

// Recency → fill color: deep green when fresh, fading out the longer it's been.
// Never trained = neutral gray.
function muscleFill(st) {
  if (st.days === null) return null;
  const t = Math.max(0, 1 - st.days / 14);   // 1 today → 0 at 14+ days
  const alpha = 0.10 + 0.90 * Math.pow(t, 1.35);
  return `rgba(52, 211, 153, ${alpha.toFixed(3)})`;
}

function neglectedMuscles(status) {
  return Object.keys(MUSCLES)
    .filter(m => !(state.settings.excludeLegs && MUSCLES[m].leg))
    .filter(m => status[m].days === null || status[m].days >= 4)
    .sort((a, b) => (status[b].days ?? 999) - (status[a].days ?? 999));
}

function suggestSplit(status) {
  let best = null;
  for (const [key, split] of Object.entries(SPLITS)) {
    if (state.settings.excludeLegs && split.muscles.every(m => MUSCLES[m].leg)) continue;
    const scores = split.muscles
      .filter(m => !(state.settings.excludeLegs && MUSCLES[m].leg))
      .map(m => Math.min(status[m].days ?? 21, 21));
    if (!scores.length) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (!best || avg > best.score) best = { key, split, score: avg };
  }
  return best;
}

// Build an exercise list covering the given muscles (rule-based, no AI)
function generateWorkout(muscles, count = 6) {
  const allowed = EXERCISES.filter(e => state.settings.equipment.includes(e.equipment));
  const status = muscleStatus();
  const ordered = [...muscles].sort((a, b) => (status[b].days ?? 999) - (status[a].days ?? 999));
  const picked = [];

  const pickFor = (muscle, compoundFirst) => {
    const pool = allowed.filter(e =>
      e.primary.includes(muscle) &&
      !picked.includes(e) &&
      (compoundFirst === null || e.compound === compoundFirst)
    );
    if (!pool.length) return null;
    return pool[Math.floor(dayRand() * pool.length)];
  };

  for (const m of ordered) {
    if (picked.length >= count) break;
    const ex = pickFor(m, true) || pickFor(m, null);
    if (ex) picked.push(ex);
  }
  let guard = 0;
  while (picked.length < count && guard++ < 30) {
    const m = ordered[Math.floor(dayRand() * ordered.length)];
    const ex = pickFor(m, null);
    if (ex) picked.push(ex);
  }
  return picked.map(e => e.id);
}

// Primary + secondary muscle sets for a list of exercise ids
function workoutTargets(exIds) {
  const primary = new Set(), secondary = new Set();
  for (const id of exIds) {
    const def = EXERCISES_BY_ID[id];
    if (!def) continue;
    def.primary.forEach(m => primary.add(m));
    def.secondary.forEach(m => secondary.add(m));
  }
  for (const m of primary) secondary.delete(m);
  return { primary: [...primary], secondary: [...secondary] };
}

// ---------------- body maps ----------------
function bodyMapsHTML(opts = {}) {
  const front = $('#tpl-body-front').innerHTML;
  const back = $('#tpl-body-back').innerHTML;
  if (opts.target) {
    // highlight map: primary solid, secondary faint
    return `<div class="bodymap-wrap ${opts.mini ? 'bodymap-mini' : ''}" data-map="target"
      data-primary="${opts.target.primary.join(',')}" data-secondary="${opts.target.secondary.join(',')}">${front}${back}</div>`;
  }
  // recency map (home)
  return `<div class="bodymap-wrap" data-map="recency">${front}${back}</div>`;
}

// after any innerHTML update, color the maps inside `root`
function paintMaps(root) {
  root.querySelectorAll('[data-map]').forEach(wrap => {
    if (wrap.dataset.map === 'recency') {
      const status = muscleStatus();
      wrap.querySelectorAll('.muscles [data-m]').forEach(el => {
        const fill = muscleFill(status[el.dataset.m]);
        if (fill) el.style.fill = fill;
      });
    } else {
      const prim = new Set(wrap.dataset.primary.split(',').filter(Boolean));
      const sec = new Set(wrap.dataset.secondary.split(',').filter(Boolean));
      wrap.querySelectorAll('.muscles [data-m]').forEach(el => {
        if (prim.has(el.dataset.m)) el.style.fill = 'var(--accent)';
        else if (sec.has(el.dataset.m)) el.style.fill = 'rgba(52, 211, 153, 0.32)';
      });
    }
  });
}

// ---------------- session helpers ----------------
function lastSetFor(exId) {
  for (let i = state.sessions.length - 1; i >= 0; i--) {
    const ex = state.sessions[i].exercises.find(e => e.exId === exId);
    if (ex) {
      const done = ex.sets.filter(s => s.done);
      if (done.length) return done[done.length - 1];
    }
  }
  return null;
}

function newSets() {
  return [{ w: '', r: '', done: false }, { w: '', r: '', done: false }, { w: '', r: '', done: false }];
}

function startSession(name, exIds) {
  state.activeSession = {
    id: uid(), date: dateKey(), start: Date.now(), name,
    exercises: exIds.map(id => ({ exId: id, sets: newSets() })),
  };
  save();
  closeModal();
  navigate('session');
}

function finishSession() {
  const s = state.activeSession;
  if (!s) return;
  const cleaned = s.exercises
    .map(ex => ({ exId: ex.exId, sets: ex.sets.filter(set => set.done) }))
    .filter(ex => ex.sets.length);
  if (!cleaned.length) {
    confirmSheet({
      title: 'No completed sets',
      message: 'You haven\'t checked off any sets. Discard this workout?',
      confirmLabel: 'Discard', danger: true,
    }, () => {
      state.activeSession = null;
      save();
      navigate('home');
    });
    return;
  }
  state.sessions.push({ id: s.id, date: s.date, start: s.start, end: Date.now(), name: s.name, exercises: cleaned });
  state.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start);
  state.activeSession = null;
  save();
  toast('Workout saved 💪');
  navigate('home');
}

// ---------------- modals ----------------
function showModal(html) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal-sheet"><div class="modal-grab"></div>${html}</div></div>`;
  root.querySelector('.modal-backdrop').addEventListener('click', e => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  paintMaps(root);
  return root;
}
function closeModal() { $('#modal-root').innerHTML = ''; }

// app-styled confirm (replaces browser confirm())
function confirmSheet({ title, message, confirmLabel = 'Confirm', danger = false }, onConfirm) {
  const root = showModal(`
    <h2>${esc(title)}</h2>
    <p class="muted" style="margin-bottom:18px">${esc(message)}</p>
    <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-block" id="dlg-confirm" style="margin-bottom:8px">${esc(confirmLabel)}</button>
    <button class="btn btn-ghost btn-block" id="dlg-cancel">Cancel</button>
  `);
  root.querySelector('#dlg-confirm').addEventListener('click', () => { closeModal(); onConfirm(); });
  root.querySelector('#dlg-cancel').addEventListener('click', closeModal);
}

// app-styled prompt (replaces browser prompt())
function promptSheet({ title, placeholder = '', value = '', submitLabel = 'Save' }, onSubmit) {
  const root = showModal(`
    <h2>${esc(title)}</h2>
    <input type="text" id="dlg-input" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" style="margin:8px 0 16px">
    <button class="btn btn-primary btn-block" id="dlg-submit">${esc(submitLabel)}</button>
  `);
  const input = root.querySelector('#dlg-input');
  input.focus();
  input.select();
  const submit = () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    closeModal();
    onSubmit(v);
  };
  root.querySelector('#dlg-submit').addEventListener('click', submit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// Exercise detail: what it is, what it hits (with diagram), your last numbers
function openExerciseDetail(exId, onAdd) {
  const e = EXERCISES_BY_ID[exId];
  if (!e) return;
  const prev = lastSetFor(exId);
  const unit = state.settings.unit;
  const root = showModal(`
    <h2>${esc(e.name)}</h2>
    <div class="chip-list" style="margin-top:6px">
      <span class="chip chip-static">${e.equipment}</span>
      <span class="chip chip-static">${e.compound ? 'compound' : 'isolation'}</span>
      ${prev ? `<span class="chip chip-static">last: ${esc(prev.w)}${unit} × ${esc(prev.r)}</span>` : ''}
    </div>
    <p style="font-size:14.5px;line-height:1.55;color:var(--text);margin:12px 2px 16px">${esc(e.desc || '')}</p>
    <h2>Muscles targeted</h2>
    ${bodyMapsHTML({ target: { primary: e.primary, secondary: e.secondary }, mini: true })}
    <div class="legend">
      <span><i style="background:var(--accent)"></i> primary: ${e.primary.map(m => MUSCLES[m].name).join(', ')}</span>
      ${e.secondary.length ? `<span><i style="background:rgba(52,211,153,.32)"></i> also works: ${e.secondary.map(m => MUSCLES[m].name).join(', ')}</span>` : ''}
    </div>
    ${onAdd ? `<button class="btn btn-primary btn-block" id="detail-add" style="margin-top:16px">Add to workout</button>` : ''}
  `);
  if (onAdd) root.querySelector('#detail-add').addEventListener('click', () => { closeModal(); onAdd(exId); });
}

// Workout preview: full target diagram + tappable exercise list + start button
function openWorkoutPreview(name, exIds, { startLabel = 'Start Workout', onStart } = {}) {
  const targets = workoutTargets(exIds);
  showModal(`
    <h2>${esc(name)}</h2>
    <p class="muted" style="margin-bottom:10px">${exIds.length} exercises · tap one to see what it does</p>
    ${bodyMapsHTML({ target: targets, mini: true })}
    <div class="legend" style="margin-bottom:14px">
      <span><i style="background:var(--accent)"></i> primary target</span>
      <span><i style="background:rgba(52,211,153,.32)"></i> also worked</span>
    </div>
    ${exIds.map(id => {
      const e = EXERCISES_BY_ID[id];
      return `<div class="ex-item" data-action="ex-detail" data-id="${id}">
        <div class="ex-info">
          <div class="ex-name">${esc(e?.name || id)}</div>
          <div class="ex-meta">${(e?.primary || []).map(m => MUSCLES[m].name).join(', ')} · ${e?.equipment || ''}</div>
        </div>
        <span class="ex-info-icon">ⓘ</span>
      </div>`;
    }).join('')}
    ${onStart ? `<button class="btn btn-primary btn-block" data-action="preview-start" style="margin-top:12px">${esc(startLabel)}</button>` : ''}
  `);
  previewStartCallback = onStart || null;
}
let previewStartCallback = null;

// Searchable exercise picker → callback with exercise id
function openExercisePicker(onPick) {
  const render = (q = '', muscle = '') => {
    const list = EXERCISES.filter(e =>
      (!q || e.name.toLowerCase().includes(q.toLowerCase())) &&
      (!muscle || e.primary.includes(muscle))
    );
    return list.map(e => `
      <div class="ex-item" data-pick="${e.id}">
        <span class="ex-info-icon" data-info="${e.id}">ⓘ</span>
        <div class="ex-info">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-meta">${e.primary.map(m => MUSCLES[m].name).join(', ')} · ${e.equipment}</div>
        </div>
        <span style="color:var(--accent);font-size:20px;font-weight:700">+</span>
      </div>`).join('') || '<div class="empty">No matches</div>';
  };

  const root = showModal(`
    <h2>Add Exercise</h2>
    <input type="search" id="picker-search" placeholder="Search exercises…" autocomplete="off">
    <div class="chip-list" id="picker-muscles">
      ${Object.entries(MUSCLES).map(([k, m]) => `<button class="chip" data-muscle="${k}">${m.name}</button>`).join('')}
    </div>
    <div id="picker-list">${render()}</div>
  `);

  let activeMuscle = '';
  const refresh = () => { root.querySelector('#picker-list').innerHTML = render(root.querySelector('#picker-search').value, activeMuscle); };
  root.querySelector('#picker-search').addEventListener('input', refresh);
  root.querySelector('#picker-muscles').addEventListener('click', e => {
    const btn = e.target.closest('[data-muscle]');
    if (!btn) return;
    activeMuscle = activeMuscle === btn.dataset.muscle ? '' : btn.dataset.muscle;
    root.querySelectorAll('#picker-muscles .chip').forEach(c => c.classList.toggle('on', c.dataset.muscle === activeMuscle));
    refresh();
  });
  root.querySelector('#picker-list').addEventListener('click', e => {
    const info = e.target.closest('[data-info]');
    if (info) { openExerciseDetail(info.dataset.info, onPick); return; }
    const item = e.target.closest('[data-pick]');
    if (item) { closeModal(); onPick(item.dataset.pick); }
  });
}

// Muscle detail: what it is, your history with it, exercises for it
function openMuscleDetail(muscle) {
  const st = muscleStatus()[muscle];
  const m = MUSCLES[muscle];
  const monthAgo = dateKey(new Date(Date.now() - 30 * 86400000));
  let sets30 = 0, sessions30 = new Set();
  for (const sess of state.sessions) {
    if (sess.date < monthAgo) continue;
    for (const ex of sess.exercises) {
      const def = EXERCISES_BY_ID[ex.exId];
      if (def && def.primary.includes(muscle)) {
        const done = ex.sets.filter(s => s.done).length;
        if (done) { sets30 += done; sessions30.add(sess.id); }
      }
    }
  }
  const exs = EXERCISES.filter(e => e.primary.includes(muscle) && state.settings.equipment.includes(e.equipment)).slice(0, 7);
  showModal(`
    <h2>${esc(m.name)}</h2>
    <p style="font-size:14px;line-height:1.55;color:var(--text-dim);margin:6px 2px 14px">${esc(m.desc)}</p>
    <div class="stat-grid" style="margin-bottom:16px">
      <div class="stat"><b>${st.days === null ? '—' : st.days + 'd'}</b><span>since trained</span></div>
      <div class="stat"><b>${sets30}</b><span>sets · 30 days</span></div>
      <div class="stat"><b>${sessions30.size}</b><span>workouts · 30 days</span></div>
    </div>
    ${st.indirect ? `<p class="muted" style="margin-bottom:12px">Also hit indirectly on ${fmtDay(st.indirect)}</p>` : ''}
    <h2>Exercises for ${esc(m.name.toLowerCase())}</h2>
    ${exs.map(e => `
      <div class="ex-item" data-action="ex-detail" data-id="${e.id}">
        <div class="ex-info">
          <div class="ex-name">${esc(e.name)}</div>
          <div class="ex-meta">${e.equipment}${e.compound ? ' · compound' : ''}</div>
        </div>
        <span class="ex-info-icon">ⓘ</span>
      </div>`).join('')}
    <button class="btn btn-primary btn-block" style="margin-top:10px" data-action="quick-muscle" data-muscle="${muscle}">Start a ${esc(m.name)} workout</button>
  `);
}

// ---------------- views ----------------
let currentTab = 'home';
let historyMonth = new Date();
let historySelected = dateKey();
let plannerState = { split: 'push', muscles: [], count: 6, generated: null };

function navigate(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tab || (tab === 'session' && t.dataset.tab === 'log')));
  render();
  window.scrollTo(0, 0);
}

function render() {
  const v = $('#view');
  if (currentTab === 'home') v.innerHTML = viewHome();
  else if (currentTab === 'plan') v.innerHTML = viewPlan();
  else if (currentTab === 'log') v.innerHTML = viewLog();
  else if (currentTab === 'session') v.innerHTML = viewSession();
  else if (currentTab === 'history') v.innerHTML = viewHistory();
  else if (currentTab === 'settings') v.innerHTML = viewSettings();
  paintMaps(v);
  updateSessionBar();
}

// ----- HOME -----
function viewHome() {
  const status = muscleStatus();
  const neglected = neglectedMuscles(status);
  const suggestion = suggestSplit(status);
  const today = dateKey();
  const todaySessions = state.sessions.filter(s => s.date === today);

  let suggestionHTML = '';
  if (suggestion) {
    suggestionHTML = `
      <div class="card suggestion-card">
        <div class="row-between">
          <div>
            <span class="badge">Suggested today</span>
            <h2 style="margin:2px 0 2px">${esc(suggestion.split.name)}</h2>
            <div class="muted">${suggestion.split.muscles.filter(m => !(state.settings.excludeLegs && MUSCLES[m].leg)).map(m => MUSCLES[m].name).join(' · ')}</div>
          </div>
          <button class="btn btn-primary" data-action="preview-suggested" data-split="${suggestion.key}">Start</button>
        </div>
      </div>`;
  }

  const neglectedHTML = neglected.length
    ? neglected.map(m => {
        const st = status[m];
        return `
          <div class="muscle-row" data-action="muscle-detail" data-muscle="${m}">
            <span class="muscle-dot" style="background:var(--m-${st.level})"></span>
            <span class="muscle-name">${MUSCLES[m].name}</span>
            <span class="muscle-days">${st.days === null ? 'never trained' : st.days + 'd ago'}</span>
            <button class="btn btn-small btn-ghost" data-action="quick-muscle" data-muscle="${m}">Train</button>
          </div>`;
      }).join('')
    : '<div class="empty">Everything is fresh — nice work 🎉</div>';

  return `
    <div class="row-between">
      <div>
        <h1>Muscle Map</h1>
        <p class="subtitle">${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}${todaySessions.length ? ` · ${todaySessions.length} logged today` : ''}</p>
      </div>
    </div>

    <div class="section card">
      ${bodyMapsHTML()}
      <div class="fade-legend">
        <span>14d+</span>
        <div class="fade-bar"></div>
        <span>today</span>
      </div>
      <p class="muted" style="text-align:center;margin-top:8px">Deep green = trained recently · faded = overdue · gray = never<br>Tap any muscle for details</p>
    </div>

    ${suggestionHTML}

    <div class="section card">
      <h2>Needs Training${state.settings.excludeLegs ? ' <span class="muted" style="font-weight:400">(legs exempt)</span>' : ''}</h2>
      ${neglectedHTML}
    </div>`;
}

// ----- PLAN -----
function viewPlan() {
  const p = plannerState;
  const targets = p.generated ? workoutTargets(p.generated) : null;
  const generatedHTML = p.generated ? `
    <div class="card">
      <div class="row-between" style="margin-bottom:10px">
        <h2 style="margin:0">Your Plan</h2>
        <button class="btn btn-small" data-action="plan-shuffle">↻ Shuffle</button>
      </div>
      ${bodyMapsHTML({ target: targets, mini: true })}
      <div class="legend" style="margin-bottom:12px">
        <span><i style="background:var(--accent)"></i> primary target</span>
        <span><i style="background:rgba(52,211,153,.32)"></i> also worked</span>
      </div>
      ${p.generated.map((id, i) => {
        const e = EXERCISES_BY_ID[id];
        return `<div class="ex-item" data-action="ex-detail" data-id="${id}">
          <div class="ex-info"><div class="ex-name">${esc(e.name)}</div><div class="ex-meta">${e.primary.map(m => MUSCLES[m].name).join(', ')} · ${e.equipment}</div></div>
          <span class="ex-info-icon">ⓘ</span>
          <button class="ex-remove" data-action="plan-remove" data-idx="${i}">×</button>
        </div>`;
      }).join('')}
      <button class="btn btn-block btn-ghost" data-action="plan-add" style="margin:4px 0 10px">+ Add exercise</button>
      <div class="row">
        <button class="btn grow" data-action="plan-save">Save Plan</button>
        <button class="btn btn-primary grow" data-action="plan-start">Start Now</button>
      </div>
    </div>` : '';

  return `
    <h1>Plan a Workout</h1>
    <p class="subtitle">Pick a focus — exercises come from the built-in library</p>

    <div class="section card">
      <h2>Focus</h2>
      <div class="chip-list">
        ${Object.entries(SPLITS).map(([k, s]) => `<button class="chip ${p.split === k ? 'on' : ''}" data-action="plan-split" data-split="${k}">${s.short}</button>`).join('')}
        <button class="chip ${p.split === 'custom' ? 'on' : ''}" data-action="plan-split" data-split="custom">Custom</button>
      </div>
      ${p.split === 'custom' ? `
        <h2 style="margin-top:14px">Muscles</h2>
        <div class="chip-list">
          ${Object.entries(MUSCLES).map(([k, m]) => `<button class="chip ${p.muscles.includes(k) ? 'on' : ''}" data-action="plan-muscle" data-muscle="${k}">${m.name}</button>`).join('')}
        </div>` : ''}
      <h2 style="margin-top:14px">Exercises</h2>
      <div class="seg">
        ${[4, 5, 6, 7, 8].map(n => `<button class="${p.count === n ? 'on' : ''}" data-action="plan-count" data-count="${n}">${n}</button>`).join('')}
      </div>
      <button class="btn btn-primary btn-block" style="margin-top:14px" data-action="plan-generate">Generate Workout</button>
    </div>

    ${generatedHTML}

    <div class="section card">
      <h2>Saved Plans</h2>
      ${state.plans.length ? state.plans.map(pl => `
        <div class="ex-item" data-action="plan-preview" data-id="${pl.id}">
          <div class="ex-info">
            <div class="ex-name">${esc(pl.name)}</div>
            <div class="ex-meta">${pl.exIds.length} exercises · ${[...new Set(pl.exIds.flatMap(id => EXERCISES_BY_ID[id]?.primary || []))].map(m => MUSCLES[m].name).slice(0, 4).join(', ')}</div>
          </div>
          <button class="btn btn-small btn-primary" data-action="plan-start-saved" data-id="${pl.id}">Start</button>
          <button class="ex-remove" data-action="plan-delete" data-id="${pl.id}">×</button>
        </div>`).join('') : '<div class="empty">No saved plans yet</div>'}
    </div>`;
}

// ----- LOG (start a session) -----
function viewLog() {
  if (state.activeSession) { return viewSession(); }
  const status = muscleStatus();
  const suggestion = suggestSplit(status);
  const last = state.sessions[state.sessions.length - 1];

  return `
    <h1>Start a Workout</h1>
    <p class="subtitle">Log as you go — sets, reps and weight</p>

    ${suggestion ? `
      <div class="section card suggestion-card">
        <span class="badge">Suggested</span>
        <div class="row-between">
          <div>
            <div class="ex-name">${esc(suggestion.split.name)}</div>
            <div class="muted">Most neglected muscles right now</div>
          </div>
          <button class="btn btn-small btn-primary" data-action="preview-suggested" data-split="${suggestion.key}">Start</button>
        </div>
      </div>` : ''}

    <div class="section card card-tight">
      <div class="row-between">
        <div>
          <div class="ex-name">Empty Session</div>
          <div class="muted">Add exercises as you go</div>
        </div>
        <button class="btn btn-small" data-action="start-empty">Start</button>
      </div>
    </div>

    ${last ? `
      <div class="card card-tight">
        <div class="row-between">
          <div>
            <div class="ex-name">Repeat: ${esc(last.name)}</div>
            <div class="muted">${fmtDay(last.date)} · ${last.exercises.length} exercises</div>
          </div>
          <button class="btn btn-small" data-action="start-repeat">Start</button>
        </div>
      </div>` : ''}

    ${state.plans.length ? `
      <div class="section card">
        <h2>From a Saved Plan</h2>
        ${state.plans.map(pl => `
          <div class="ex-item" data-action="plan-preview" data-id="${pl.id}">
            <div class="ex-info"><div class="ex-name">${esc(pl.name)}</div><div class="ex-meta">${pl.exIds.length} exercises</div></div>
            <button class="btn btn-small btn-primary" data-action="plan-start-saved" data-id="${pl.id}">Start</button>
          </div>`).join('')}
      </div>` : ''}`;
}

// ----- ACTIVE SESSION -----
function viewSession() {
  const s = state.activeSession;
  if (!s) return viewLog();
  const unit = state.settings.unit;

  const exHTML = s.exercises.map((ex, ei) => {
    const def = EXERCISES_BY_ID[ex.exId];
    const prev = lastSetFor(ex.exId);
    return `
      <div class="card">
        <div class="row-between" style="margin-bottom:10px">
          <div data-action="ex-detail" data-id="${ex.exId}">
            <div class="ex-name">${esc(def?.name || ex.exId)} <span class="ex-info-icon">ⓘ</span></div>
            <div class="ex-meta">${(def?.primary || []).map(m => MUSCLES[m].name).join(', ')}${prev ? ` · last: ${esc(prev.w)}${unit} × ${esc(prev.r)}` : ''}</div>
          </div>
          <button class="ex-remove" data-action="sess-remove-ex" data-ex="${ei}">×</button>
        </div>
        <div class="set-head"><span>Set</span><span>${unit}</span><span>Reps</span><span>✓</span></div>
        ${ex.sets.map((set, si) => `
          <div class="set-row">
            <span class="set-num">${si + 1}</span>
            <input type="number" inputmode="decimal" placeholder="${prev ? esc(prev.w) : '0'}" value="${esc(set.w)}" data-input="set" data-ex="${ei}" data-set="${si}" data-field="w" ${set.done ? 'class="done-input"' : ''}>
            <input type="number" inputmode="numeric" placeholder="${prev ? esc(prev.r) : '0'}" value="${esc(set.r)}" data-input="set" data-ex="${ei}" data-set="${si}" data-field="r" ${set.done ? 'class="done-input"' : ''}>
            <button class="set-check ${set.done ? 'done' : ''}" data-action="sess-toggle-set" data-ex="${ei}" data-set="${si}">✓</button>
          </div>`).join('')}
        <button class="btn btn-small btn-ghost btn-block" data-action="sess-add-set" data-ex="${ei}" style="margin-top:6px">+ Add set</button>
      </div>`;
  }).join('');

  return `
    <div class="row-between">
      <div>
        <h1>${esc(s.name)}</h1>
        <p class="subtitle">Started ${new Date(s.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · <span class="session-timer" id="session-timer">${fmtClock(Date.now() - s.start)}</span></p>
      </div>
    </div>

    <div class="section">${exHTML}</div>

    <button class="btn btn-ghost btn-block" data-action="sess-add-ex" style="margin-bottom:10px">+ Add exercise</button>
    <button class="btn btn-primary btn-block" data-action="sess-finish" style="margin-bottom:10px">Finish Workout</button>
    <button class="btn btn-danger btn-block" data-action="sess-cancel">Discard Workout</button>`;
}

// ----- HISTORY -----
function viewHistory() {
  const y = historyMonth.getFullYear(), m = historyMonth.getMonth();
  const first = new Date(y, m, 1);
  const startDow = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayK = dateKey();

  const byDay = {};
  for (const s of state.sessions) (byDay[s.date] ??= []).push(s);

  let cells = '';
  for (let i = 0; i < startDow; i++) {
    const d = new Date(y, m, i - startDow + 1);
    cells += `<button class="cal-day other">${d.getDate()}</button>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const k = dateKey(new Date(y, m, d));
    const n = (byDay[k] || []).length;
    cells += `
      <button class="cal-day ${k === todayK ? 'today' : ''} ${k === historySelected ? 'selected' : ''}" data-action="hist-day" data-key="${k}">
        ${d}
        <span class="dots">${'<i></i>'.repeat(Math.min(n, 3))}</span>
      </button>`;
  }

  const weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
  const thisWeek = state.sessions.filter(s => s.date >= dateKey(weekAgo)).length;
  const totalSets = state.sessions.reduce((a, s) => a + s.exercises.reduce((b, e) => b + e.sets.length, 0), 0);

  const daySessions = byDay[historySelected] || [];
  const dayHTML = daySessions.length ? daySessions.map(s => {
    const targets = workoutTargets(s.exercises.map(e => e.exId));
    return `
      <div class="card">
        <div class="row-between">
          <div>
            <div class="ex-name">${esc(s.name)}</div>
            <div class="ex-meta">${s.end ? fmtClock(s.end - s.start) + ' · ' : ''}${s.exercises.length} exercises</div>
          </div>
          <button class="ex-remove" data-action="hist-delete" data-id="${s.id}">×</button>
        </div>
        <div class="chip-list">${targets.primary.map(m => `<span class="chip chip-static">${MUSCLES[m].name}</span>`).join('')}</div>
        ${s.exercises.map(e => `
          <div class="muscle-row" data-action="ex-detail" data-id="${e.exId}">
            <span class="muscle-name">${esc(EXERCISES_BY_ID[e.exId]?.name || e.exId)}</span>
            <span class="muscle-days">${e.sets.map(set => `${set.w || 0}×${set.r || 0}`).join('  ')}</span>
          </div>`).join('')}
      </div>`;
  }).join('') : `<div class="empty">No workouts on ${fmtDay(historySelected)}</div>`;

  return `
    <h1>History</h1>
    <p class="subtitle">Every session, every day</p>

    <div class="section stat-grid">
      <div class="stat"><b>${thisWeek}</b><span>this week</span></div>
      <div class="stat"><b>${state.sessions.length}</b><span>all time</span></div>
      <div class="stat"><b>${totalSets}</b><span>total sets</span></div>
    </div>

    <div class="section card">
      <div class="cal-head">
        <button class="cal-nav" data-action="hist-prev">‹</button>
        <span class="cal-title">${historyMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
        <button class="cal-nav" data-action="hist-next">›</button>
      </div>
      <div class="cal-grid">
        ${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(d => `<span class="cal-dow">${d}</span>`).join('')}
        ${cells}
      </div>
    </div>

    <div class="section">
      <h2>${fmtDay(historySelected)}</h2>
      ${dayHTML}
    </div>`;
}

// ----- SETTINGS -----
function viewSettings() {
  const s = state.settings;
  return `
    <h1>Settings</h1>
    <p class="subtitle">All data lives on this device — nothing leaves your phone</p>

    <div class="section card">
      <h2>Units</h2>
      <div class="seg">
        <button class="${s.unit === 'lbs' ? 'on' : ''}" data-action="set-unit" data-unit="lbs">lbs</button>
        <button class="${s.unit === 'kg' ? 'on' : ''}" data-action="set-unit" data-unit="kg">kg</button>
      </div>
    </div>

    <div class="section card">
      <div class="row-between">
        <div>
          <div class="ex-name">Exempt legs from suggestions</div>
          <div class="muted">Leg muscles won't appear in "needs training"</div>
        </div>
        <button class="btn btn-small ${s.excludeLegs ? 'btn-primary' : 'btn-ghost'}" data-action="toggle-legs">${s.excludeLegs ? 'On' : 'Off'}</button>
      </div>
    </div>

    <div class="section card">
      <h2>My Equipment</h2>
      <p class="muted" style="margin-bottom:8px">Generated workouts only use what you have</p>
      <div class="chip-list">
        ${['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight'].map(eq =>
          `<button class="chip ${s.equipment.includes(eq) ? 'on' : ''}" data-action="toggle-equip" data-equip="${eq}">${eq}</button>`).join('')}
      </div>
    </div>

    <div class="section card">
      <h2>Your Data</h2>
      <p class="muted" style="margin-bottom:6px">Saved to two separate stores on this device on every change (localStorage + IndexedDB), so it survives clearing either one. <span id="persist-status"></span></p>
      <p class="muted" style="margin-bottom:10px">Export a backup file occasionally — especially before iOS updates or switching phones.</p>
      <div class="row">
        <button class="btn grow" data-action="export-data">Export</button>
        <button class="btn grow" data-action="import-data">Import</button>
      </div>
      <input type="file" id="import-file" accept=".json,application/json" class="hidden">
    </div>

    <div class="section card">
      <button class="btn btn-danger btn-block" data-action="clear-data">Erase All Data</button>
    </div>

    <p class="muted" style="text-align:center;margin-top:20px">Workout Tracker · offline · $0 forever</p>`;
}

async function updatePersistStatus() {
  const el = $('#persist-status');
  if (!el || !navigator.storage || !navigator.storage.persisted) return;
  try {
    const p = await navigator.storage.persisted();
    el.textContent = p ? 'Protected storage: on ✓' : '';
  } catch {}
}

// ---------------- session bar + timer ----------------
function updateSessionBar() {
  const bar = $('#session-bar');
  const show = state.activeSession && currentTab !== 'session' && currentTab !== 'log';
  bar.classList.toggle('hidden', !show);
  if (show) {
    $('#session-bar-text').textContent = `${state.activeSession.name} · ${fmtClock(Date.now() - state.activeSession.start)}`;
  }
  if (currentTab === 'settings') updatePersistStatus();
}

setInterval(() => {
  if (!state.activeSession) return;
  const t = $('#session-timer');
  if (t) t.textContent = fmtClock(Date.now() - state.activeSession.start);
  updateSessionBar();
}, 1000);

// ---------------- export / import ----------------
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `workout-backup-${dateKey()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Backup exported');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.sessions)) throw new Error('bad file');
      state = mergeState(data);
      save();
      render();
      toast('Backup restored');
    } catch {
      toast('Could not read that file');
    }
  };
  reader.readAsText(file);
}

// ---------------- event wiring ----------------
document.querySelector('.tabbar').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  if (tab.dataset.tab === 'log' && state.activeSession) navigate('session');
  else navigate(tab.dataset.tab);
});

document.body.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');

  // muscle tap on any body map
  const muscleEl = e.target.closest('.bodymap [data-m]');
  if (muscleEl && !el) { openMuscleDetail(muscleEl.dataset.m); return; }

  if (!el) return;
  const a = el.dataset.action;

  // --- shared ---
  if (a === 'ex-detail') { openExerciseDetail(el.dataset.id); return; }
  if (a === 'muscle-detail') { openMuscleDetail(el.dataset.muscle); return; }
  if (a === 'preview-start') { if (previewStartCallback) previewStartCallback(); return; }

  // --- home / suggestions ---
  if (a === 'preview-suggested') {
    const key = el.dataset.split;
    const split = SPLITS[key];
    const muscles = split.muscles.filter(m => !(state.settings.excludeLegs && MUSCLES[m].leg));
    const exIds = generateWorkout(muscles.length ? muscles : split.muscles, 6);
    openWorkoutPreview(split.name, exIds, {
      startLabel: `Start ${split.name}`,
      onStart: () => startSession(split.name, exIds),
    });
  }
  if (a === 'quick-muscle') {
    const muscle = el.dataset.muscle;
    const exIds = generateWorkout([muscle], 4);
    openWorkoutPreview(`${MUSCLES[muscle].name} Workout`, exIds, {
      startLabel: 'Start Workout',
      onStart: () => startSession(`${MUSCLES[muscle].name} Workout`, exIds),
    });
  }
  if (a === 'resume-session') navigate('session');

  // --- planner ---
  if (a === 'plan-split') { plannerState.split = el.dataset.split; render(); }
  if (a === 'plan-muscle') {
    const m = el.dataset.muscle;
    const i = plannerState.muscles.indexOf(m);
    i >= 0 ? plannerState.muscles.splice(i, 1) : plannerState.muscles.push(m);
    render();
  }
  if (a === 'plan-count') { plannerState.count = Number(el.dataset.count); render(); }
  if (a === 'plan-generate' || a === 'plan-shuffle') {
    const muscles = plannerState.split === 'custom' ? plannerState.muscles : SPLITS[plannerState.split].muscles;
    if (!muscles.length) { toast('Pick at least one muscle'); return; }
    plannerState.generated = generateWorkout(muscles, plannerState.count);
    render();
  }
  if (a === 'plan-remove') { plannerState.generated.splice(Number(el.dataset.idx), 1); render(); }
  if (a === 'plan-add') openExercisePicker(id => { plannerState.generated.push(id); render(); });
  if (a === 'plan-save') {
    promptSheet({
      title: 'Name this plan',
      placeholder: 'e.g. Tuesday Push',
      value: plannerState.split === 'custom' ? 'Custom Plan' : SPLITS[plannerState.split].name,
    }, name => {
      state.plans.push({ id: uid(), name, exIds: [...plannerState.generated] });
      save(); render(); toast('Plan saved');
    });
  }
  if (a === 'plan-start') {
    const name = plannerState.split === 'custom' ? 'Custom Workout' : SPLITS[plannerState.split].name;
    startSession(name, [...plannerState.generated]);
  }
  if (a === 'plan-preview') {
    const pl = state.plans.find(p => p.id === el.dataset.id);
    if (pl) openWorkoutPreview(pl.name, pl.exIds, {
      startLabel: `Start ${pl.name}`,
      onStart: () => startSession(pl.name, [...pl.exIds]),
    });
  }
  if (a === 'plan-start-saved') {
    e.stopPropagation();
    const pl = state.plans.find(p => p.id === el.dataset.id);
    if (pl) startSession(pl.name, [...pl.exIds]);
  }
  if (a === 'plan-delete') {
    const pl = state.plans.find(p => p.id === el.dataset.id);
    if (pl) confirmSheet({
      title: 'Delete plan', message: `Delete "${pl.name}"? This won't affect your history.`,
      confirmLabel: 'Delete', danger: true,
    }, () => {
      state.plans = state.plans.filter(p => p.id !== pl.id);
      save(); render();
    });
  }

  // --- log / session ---
  if (a === 'start-empty') startSession('Workout', []);
  if (a === 'start-repeat') {
    const last = state.sessions[state.sessions.length - 1];
    if (last) startSession(last.name, last.exercises.map(e => e.exId));
  }
  if (a === 'sess-add-ex') openExercisePicker(id => {
    state.activeSession.exercises.push({ exId: id, sets: newSets() });
    save(); render();
  });
  if (a === 'sess-remove-ex') {
    e.stopPropagation();
    state.activeSession.exercises.splice(Number(el.dataset.ex), 1);
    save(); render();
  }
  if (a === 'sess-add-set') {
    const ex = state.activeSession.exercises[Number(el.dataset.ex)];
    const lastSet = ex.sets[ex.sets.length - 1];
    ex.sets.push({ w: lastSet ? lastSet.w : '', r: lastSet ? lastSet.r : '', done: false });
    save(); render();
  }
  if (a === 'sess-toggle-set') {
    const ex = state.activeSession.exercises[Number(el.dataset.ex)];
    const set = ex.sets[Number(el.dataset.set)];
    if (!set.done) {
      // checking an empty set inherits the placeholder (= last time's numbers)
      const prev = lastSetFor(ex.exId);
      if (!set.w && prev) set.w = prev.w;
      if (!set.r && prev) set.r = prev.r;
    }
    set.done = !set.done;
    save(); render();
  }
  if (a === 'sess-finish') finishSession();
  if (a === 'sess-cancel') {
    confirmSheet({
      title: 'Discard workout', message: 'Nothing from this session will be saved.',
      confirmLabel: 'Discard', danger: true,
    }, () => {
      state.activeSession = null;
      save(); navigate('home');
    });
  }

  // --- history ---
  if (a === 'hist-day') { historySelected = el.dataset.key; render(); }
  if (a === 'hist-prev') { historyMonth = new Date(historyMonth.getFullYear(), historyMonth.getMonth() - 1, 1); render(); }
  if (a === 'hist-next') { historyMonth = new Date(historyMonth.getFullYear(), historyMonth.getMonth() + 1, 1); render(); }
  if (a === 'hist-delete') {
    e.stopPropagation();
    const id = el.dataset.id;
    confirmSheet({
      title: 'Delete workout', message: 'Remove this workout from your history? This affects your muscle map.',
      confirmLabel: 'Delete', danger: true,
    }, () => {
      state.sessions = state.sessions.filter(s => s.id !== id);
      save(); render();
    });
  }

  // --- settings ---
  if (a === 'set-unit') { state.settings.unit = el.dataset.unit; save(); render(); }
  if (a === 'toggle-legs') { state.settings.excludeLegs = !state.settings.excludeLegs; save(); render(); }
  if (a === 'toggle-equip') {
    const eq = el.dataset.equip;
    const i = state.settings.equipment.indexOf(eq);
    if (i >= 0) {
      if (state.settings.equipment.length === 1) { toast('Keep at least one'); return; }
      state.settings.equipment.splice(i, 1);
    } else state.settings.equipment.push(eq);
    save(); render();
  }
  if (a === 'export-data') exportData();
  if (a === 'import-data') $('#import-file').click();
  if (a === 'clear-data') {
    confirmSheet({
      title: 'Erase all data', message: 'Every workout, plan and setting will be permanently deleted from this device.',
      confirmLabel: 'Erase everything', danger: true,
    }, () => {
      state = structuredClone(DEFAULT_STATE);
      save(); render(); toast('All data erased');
    });
  }
});

// set inputs (weight/reps) during a session
document.body.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.input === 'set' && state.activeSession) {
    const ex = state.activeSession.exercises[Number(el.dataset.ex)];
    if (ex) { ex.sets[Number(el.dataset.set)][el.dataset.field] = el.value; save(); }
  }
});
document.body.addEventListener('change', e => {
  if (e.target.id === 'import-file' && e.target.files[0]) { importData(e.target.files[0]); e.target.value = ''; }
});

// ---------------- boot ----------------
render();
bootStorage();
// if a workout was in progress when the app was closed, jump back into it
if (state.activeSession) navigate('session');
