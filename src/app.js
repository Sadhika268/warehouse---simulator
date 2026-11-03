'use strict';
/* UI for the warehouse live simulator. Depends on engine.js (Sim, defaultConfig, validateConfig, ...). */
const $ = id => document.getElementById(id);
const COL = { teal: '#00a7a7', blue: '#5b9bd5', orange: '#ed7d31', red: '#d92d20', green: '#12b76a', amber: '#f79009', purple: '#7a5af8', ink: '#1b2a41', mute: '#667085', line: '#d9dee7' };
const AREA_NAMES = { S4: 'Inbound staging', S6: 'Inbound P&D', S8: 'Main storage', S10: 'Outbound P&D', S12: 'Outbound staging', S11: 'Replen. destination' };
const SNAP = { S4: 0, S6: 1, S8: 2, S10: 3, S12: 4, S11: 5, F1: 6, F2: 7, F3: 8, F5: 9, F7: 10, F9: 11, F7R: 12, F11: 13, F13: 14, F14: 15, uF7: 16, uF9: 17, uF7R: 18, F17s6: 30, F17s10: 31 };

let cfg = defaultConfig(), sim = null, running = false, cursor = -1, accum = 0, lastTs = 0, dots = [], notesShown = -1, lastChart = 0;
let dwellSeen = 0, maxDwell = { IN: 0, OUT: 0 }, peakCache = { n: 0, v: null };

// ---------- utils ----------
const pad = n => String(n).padStart(2, '0');
const clock = t => `Day ${Math.floor(t / 1440) + 1} ${pad(Math.floor((t % 1440) / 60))}:${pad(Math.floor(t % 60))}`;
const dur = m => m < 1 ? '0' : m < 90 ? `${m.toFixed(0)} min` : `${(m / 60).toFixed(1)} h`;
const num = v => (v === Infinity ? '∞' : Math.round(v).toLocaleString('en-GB'));
const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
// older saved scenarios may lack newer fields (e.g. F17): deep-merge over the defaults
function mergeCfg(base, over) { for (const k in over) { if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') mergeCfg(base[k], over[k]); else base[k] = over[k]; } return base; }
function setPath(o, p, v) { const k = p.split('.'); const last = k.pop(); k.reduce((a, x) => a[x], o)[last] = v; }
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
function csvOf(headers, rows) { return [headers.join(','), ...rows.map(r => r.map(v => typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(','))].join('\n'); }
function download(name, text, type = 'text/csv') { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 500); }
function fit(c, lw, lh) {
  const dpr = window.devicePixelRatio || 1, w = c.clientWidth || lw, h = Math.round(w * lh / lw);
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px'; }
  const x = c.getContext('2d'); x.setTransform(c.width / lw, 0, 0, c.height / lh, 0, 0); return x;
}

// ---------- tabs ----------
const TABS = [['live', 'Live'], ['snap', 'Snapshot'], ['inputs', 'Inputs'], ['results', 'Results'], ['ledger', 'Ledgers'], ['scen', 'Scenarios'], ['layout', 'Layout']];
TABS.forEach(([id, label], i) => { const b = document.createElement('button'); b.textContent = label; b.dataset.tab = id; if (!i) b.className = 'on'; $('nav').appendChild(b); });
$('nav').onclick = e => { const id = e.target.dataset.tab; if (!id) return; showTab(id); };
function showTab(id) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === id));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + id));
  if (id === 'results') renderResults(); if (id === 'ledger') renderLedger(); if (id === 'scen') renderScenarios(); if (id === 'live') drawCharts(true); if (id === 'snap') renderSnapshot(); if (id === 'inputs') drawInputsDiagram();
}

// ---------- inputs ----------
function field(path, label, o = {}) {
  const l = document.createElement('label'); const s = document.createElement('span'); s.textContent = label; l.appendChild(s);
  let inp;
  if (o.options) { inp = document.createElement('select'); o.options.forEach(([v, t]) => { const op = document.createElement('option'); op.value = v; op.textContent = t; inp.appendChild(op); }); inp.value = getPath(cfg, path); }
  else if (o.check) { inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!getPath(cfg, path); }
  else if (o.text) { inp = document.createElement('input'); inp.type = 'text'; inp.value = getPath(cfg, path); }
  else { inp = document.createElement('input'); inp.type = 'number'; inp.step = o.step || 'any'; if (o.min !== undefined) inp.min = o.min; const v = getPath(cfg, path); inp.value = o.pct ? +(v * 100).toFixed(4) : (v === null ? '' : v); }
  inp.onchange = () => {
    let v;
    if (o.options) v = isNaN(+inp.value) ? inp.value : +inp.value; else if (o.check) v = inp.checked; else if (o.text) v = inp.value;
    else { v = inp.value === '' ? (o.nullable ? null : 0) : +inp.value; if (o.pct) v /= 100; }
    setPath(cfg, path, v); onCfgChange();
  };
  l.appendChild(inp); return l;
}
function buildInputs() {
  const run = $('inpRun'); run.innerHTML = '';
  run.append(field('scenarioId', 'Scenario ID', { text: 1 }), field('run.days', 'Horizon (days)', { min: 1, step: 1 }),
    field('run.stepMin', 'Time step (min)', { options: [[1, '1'], [2, '2'], [5, '5'], [10, '10'], [15, '15'], [30, '30'], [60, '60']] }),
    field('run.drainHours', 'Max drain extension (h)', { min: 0 }), field('truck.inPallets', 'Pallets per inbound truck', { min: 1 }),
    field('truck.outPallets', 'Pallets per outbound truck (OD-03)', { min: 1 }));
  const sh = $('inpShared'); sh.innerHTML = '';
  sh.append(field('flowCap', 'Maximum capacity of any single flow (pallets/h)', { min: 0 }), field('repl.split10', 'Replenishment via S10 (%, rest via S6)', { pct: 1, min: 0 }),
    field('shared.tie', 'Tie-break at identical ready time', { options: [['F7,F9,F7R', 'F7 → F9 → F7-REPL (BRD order)'], ['F7,F7R,F9', 'F7 → F7-REPL → F9'], ['F9,F7,F7R', 'F9 → F7 → F7-REPL']] }),
    field('overflow', 'Area over-capacity (OD-06)', { options: [['report', 'Report breach, keep flowing'], ['block', 'Block upstream completion']] }),
    field('enforceNonShared', 'Use the people / capacity defined below (off = every flow runs at the single-flow maximum and people are sized from demand)', { check: 1 }));
  // display-only setting: changing it redraws the Results without resetting the run
  const hl = field('highlightPct', 'Hourly dashboard: highlight in red above (% of capacity)', { min: 0, step: 1 }); hl.querySelector('input').onchange = e => { cfg.highlightPct = +e.target.value || 0; if (sim && sim.finished && $('tab-results').classList.contains('on')) renderResults(); }; sh.appendChild(hl);
  $('inpAreas').innerHTML = ''; const t = document.createElement('table'); t.innerHTML = '<tr><th class="l">Area</th><th>Capacity</th><th>Initial stock</th></tr>';
  AREA_IDS.forEach(id => {
    const tr = document.createElement('tr'); tr.innerHTML = `<td>${id} <span class="small">${AREA_NAMES[id]}</span></td><td></td><td></td>`;
    ['cap', 'init'].forEach((k, i) => { const inp = field(`areas.${id}.${k}`, ''); const e = inp.querySelector('input'); e.style.width = '100px'; tr.children[i + 1].appendChild(e); });
    t.appendChild(tr);
  });
  $('inpAreas').appendChild(t);
  buildProfile(); refreshDerived();
}
// Process master: every flow can be defined by (1) people x productivity or (2) a capacity in pallets/h, from which the model derives the people needed.
function buildProcTable() {
  const wrap = $('inpProc'); wrap.innerHTML = '';
  const pt = document.createElement('table'); pt.innerHTML = '<tr><th class="l">Process</th><th>Define by</th><th>Productivity / person</th><th>Unit</th><th>People (FTE)</th><th>Capacity (pallets/h)</th></tr>';
  const numInput = (path, w) => { const e = field(path, '').querySelector('input'); e.style.width = (w || 80) + 'px'; return e; };
  const modeSel = (cur, opts, set) => { const m = document.createElement('select'); opts.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; m.appendChild(o); }); m.value = cur; m.onchange = () => set(m.value); return m; };
  const mk = (id, label) => { const tr = document.createElement('tr'); tr.innerHTML = `<td><b>${id === 'POOL' ? 'F7 + F9 + F7-REPL' : id}</b> <span class="small">${label}</span></td><td></td><td></td><td class="small l"></td><td></td><td></td>`; return tr; };
  const flowRow = id => {
    const f = flowCapacity(cfg, id), tr = mk(id, (PNAME[id] || id).replace(id + ' ', '')); tr.children[3].textContent = cfg.proc[id].unit;
    tr.children[1].appendChild(modeSel(f.mode, [['people', 'People × productivity'], ['capacity', 'Capacity (pallets/h)']], v => {
      if (v === 'capacity' && f.mode !== 'capacity') cfg.proc[id].capacity = Math.round(f.effective); if (v === 'people' && f.mode === 'capacity') cfg.proc[id].n = f.needed; cfg.proc[id].mode = v; onCfgChange(); }));
    tr.children[2].appendChild(numInput(`proc.${id}.prod`));
    if (f.mode === 'people') { tr.children[4].appendChild(numInput(`proc.${id}.n`, 60)); tr.children[5].innerHTML = `<b>${num(f.effective)}</b>${f.capped ? ` <span class="small">(capped from ${num(f.raw)})</span>` : ''}`; }
    else { tr.children[4].innerHTML = `<b>${f.needed}</b> <span class="small">needed</span>`; tr.children[5].appendChild(numInput(`proc.${id}.capacity`)); if (f.capped) tr.children[5].insertAdjacentHTML('beforeend', ` <span class="small">→ capped at ${num(cfg.flowCap)}</span>`); }
    pt.appendChild(tr);
  };
  const subRow = id => { const tr = mk(id, (PNAME[id] || id).replace(id + ' ', '') + ' (in pool)'); tr.children[1].innerHTML = '<span class="small">pool</span>'; tr.children[2].appendChild(numInput(`proc.${id}.prod`)); tr.children[3].textContent = cfg.proc[id].unit; tr.children[4].innerHTML = '<span class="small">pool</span>'; tr.children[5].innerHTML = '<span class="small">pool</span>'; pt.appendChild(tr); };
  ['F1', 'F2', 'F3', 'F5'].forEach(flowRow);
  const pi = poolInfo(cfg), pr = mk('POOL', 'shared pool: one capacity for the sum of the 3 flows'); pr.style.background = '#fff7ed';
  pr.children[1].appendChild(modeSel(pi.mode, [['capacity', 'Capacity (pallets/h)'], ['people', 'People × productivity']], v => { if (v === 'people' && pi.mode !== 'people') cfg.shared.people = pi.needed; if (v === 'capacity' && pi.mode !== 'capacity') cfg.shared.cap = Math.round(pi.effective); cfg.shared.mode = v; onCfgChange(); }));
  pr.children[2].innerHTML = `${cfg.proc.F7.prod} <span class="small">(F7)</span>`; pr.children[3].textContent = 'pallets/h/person';
  if (pi.mode === 'people') { pr.children[4].appendChild(numInput('shared.people', 60)); pr.children[5].innerHTML = `<b>${num(pi.effective)}</b>`; }
  else { pr.children[4].innerHTML = `<b>${pi.needed}</b> <span class="small">needed</span>`; pr.children[5].appendChild(numInput('shared.cap')); }
  pt.appendChild(pr); ['F7', 'F9', 'F7R'].forEach(subRow); ['F11', 'F13', 'F14', 'F17'].forEach(flowRow);
  wrap.appendChild(pt);
  const note = document.createElement('div'); note.className = 'small'; note.id = 'procNote';
  note.textContent = `Two ways to define a flow: "People × productivity" (capacity = productivity × people) or "Capacity" (you enter the maximum pallets/h and the model gives the people needed, rounded up). Every single flow is capped at ${num(cfg.flowCap)} pallets/h. The shared pool F7 + F9 + F7-REPL has one capacity for the sum of the three flows and is not limited by the single-flow maximum. F1/F14 productivity is in trucks/h, converted with pallets per truck. Real headcounts are not defined yet (OD-04).`;
  wrap.appendChild(note);
}
function refreshDerived() { buildProcTable(); drawInputsDiagram(); }function buildProfile() {
  const tot = profileTotals(cfg.profile);
  let h = '<div class="scroll" style="max-height:520px"><table><tr><th>Hour</th><th>Inbound</th><th>Outbound</th><th>Replenishment (F7-REPL)</th><th>Total</th></tr>';
  cfg.profile.forEach((r, i) => { h += `<tr><td>${pad(i)}:00</td>` + [0, 1, 2].map(k => `<td><input type="number" min="0" data-h="${i}" data-k="${k}" value="${r[k]}" style="width:80px"></td>`).join('') + `<td>${r[0] + r[1] + r[2]}</td></tr>`; });
  h += `<tr><td><b>Imported sum</b></td><td><b>${tot[0]}</b></td><td><b>${tot[1]}</b></td><td><b>${tot[2]}</b></td><td><b>${tot[0] + tot[1] + tot[2]}</b></td></tr>`;
  h += '<tr><td>Official daily total</td>' + ['inbound', 'outbound', 'replenishment'].map(k => `<td><input type="number" min="0" data-ctl="${k}" value="${cfg.control[k] ?? ''}" style="width:80px" placeholder="enter"></td>`).join('') + '<td></td></tr></table></div>';
  $('inpProfile').innerHTML = h;
  $('inpProfile').querySelectorAll('input').forEach(i => i.onchange = () => {
    if (i.dataset.ctl) cfg.control[i.dataset.ctl] = i.value === '' ? null : +i.value; else cfg.profile[+i.dataset.h][+i.dataset.k] = +i.value || 0;
    onCfgChange(true);
  });
}
function onCfgChange(rebuildProfile) { if (rebuildProfile) buildProfile(); refreshDerived(); resetSim(); }
function showValidation() {
  const v = validateConfig(cfg);
  const html = v.errors.map(e => `<div class="msg err">${esc(e)}</div>`).join('') + v.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
  $('valMsgs').innerHTML = html; $('inpMsgs').innerHTML = html; return v;
}

// ---------- presets ----------
const PRESETS = {
  'Baseline (BRD Appendix A)': c => c,
  'T01 Zero demand': c => { c.profile = c.profile.map(() => [0, 0, 0]); c.run.days = 1; return c; },
  'T03/T04 05:00 outbound peak only': c => { c.profile = c.profile.map(() => [0, 0, 0]); c.profile[5] = [0, 416, 0]; c.profile[6] = [0, 208, 0]; c.run.days = 1; return c; },
  'T10 Insufficient S8 stock (1,000)': c => { c.areas.S8.init = 1000; c.run.days = 3; return c; },
  'Shared pool 320 pallets/h': c => { c.shared.cap = 320; return c; },
  'Overflow blocks upstream (OD-06)': c => { c.overflow = 'block'; return c; },
  'Tie-break F7 → F7-REPL → F9': c => { c.shared.tie = 'F7,F7R,F9'; return c; },
  'Size people from demand (each flow at design capacity)': c => { c.enforceNonShared = false; return c; },
};
Object.keys(PRESETS).forEach(k => { const o = document.createElement('option'); o.textContent = k; $('preset').appendChild(o); });
$('btnPreset').onclick = () => { cfg = PRESETS[$('preset').value](defaultConfig()); buildInputs(); resetSim(); };
$('btnExportCfg').onclick = () => download(`${cfg.scenarioId}.json`, JSON.stringify(cfg, null, 2), 'application/json');
$('importCfg').onchange = e => { const f = e.target.files[0]; if (!f) return; f.text().then(t => { cfg = mergeCfg(defaultConfig(), JSON.parse(t)); buildInputs(); resetSim(); }); e.target.value = ''; };

// ---------- run control ----------
const SPEEDS = [[1, '1 min / s'], [5, '5 min / s'], [15, '15 min / s'], [60, '1 h / s'], [240, '4 h / s'], [1440, '1 day / s'], [14400, '10 days / s']];
SPEEDS.forEach(([v, t]) => { const o = document.createElement('option'); o.value = v; o.textContent = t; $('speed').appendChild(o); }); $('speed').value = 240;

function resetSim() {
  running = false; $('btnRun').textContent = '▶ Start'; accum = 0; cursor = -1; dots = []; notesShown = -1; dwellSeen = 0; maxDwell = { IN: 0, OUT: 0 }; peakCache = { n: 0, v: null };
  const v = showValidation(); sim = new Sim(cfg); $('scrub').max = 0; $('scrub').value = 0;
  $('btnRun').disabled = v.errors.length > 0; drawCharts(true); updatePanels();
}
function advance(simMin) {
  accum += simMin; let n = Math.floor(accum / cfg.run.stepMin); accum -= n * cfg.run.stepMin; n = Math.min(n, 30000);
  while (n-- > 0 && !sim.finished) sim.step();
  if (sim.finished) { running = false; $('btnRun').textContent = '▶ Start'; }
}
$('btnRun').onclick = () => { if (sim.finished) resetSim(); running = !running; cursor = -1; $('btnRun').textContent = running ? '⏸ Pause' : '▶ Start'; lastTs = performance.now(); };
$('btnStep').onclick = () => { running = false; $('btnRun').textContent = '▶ Start'; cursor = -1; accum = 0; for (let i = 0; i < 60 / cfg.run.stepMin && !sim.finished; i++) sim.step(); };
$('btnEnd').onclick = () => { running = false; $('btnRun').textContent = '▶ Start'; cursor = -1; sim.run(); };
$('btnReset').onclick = resetSim;
$('btnLive').onclick = () => { cursor = -1; };
$('scrub').oninput = e => { running = false; $('btnRun').textContent = '▶ Start'; cursor = +e.target.value; };
$('win').onchange = () => drawCharts(true); $('pplMode').onchange = () => drawCharts(true);

// ---------- snapshot helpers ----------
function snapAt(idx) {
  const hist = sim.hist; let row, t;
  if (idx < 0 || idx >= hist.length) idx = hist.length - 1;
  if (idx < 0) {
    row = new Float32Array(32); AREA_IDS.forEach(id => row[SNAP[id]] = cfg.areas[id].init); t = 0;
  } else { row = hist[idx]; t = sim.histT[idx]; }
  const k = Math.max(1, Math.round(60 / cfg.run.stepMin)); let u7 = 0, u9 = 0, u9r = 0;
  for (let i = Math.max(0, idx - k + 1); i <= idx && idx >= 0; i++) { u7 += hist[i][16]; u9 += hist[i][17]; u9r += hist[i][18]; }
  const w = workAt(idx), ppl = {}; PROC_ORDER.forEach(id => ppl[id] = pq(id, w[id]));
  return { row, t, idx, u7, u9, u9r, w, ppl, pplPool: pq('F7', poolWork(cfg, w)), pplTotal: peopleTotal(cfg, w, pplFte()), q17s6: row[30], q17s10: row[31] };
}
// People view: A = whole people needed in the hour (rounded up, worst case); B = average people / FTE (not rounded)
const pplFte = () => $('pplMode').value === 'B';
const pq = (id, pallets) => peopleReq(cfg, id, pallets, pplFte());
const fp = v => pplFte() ? (Math.round(v * 10) / 10).toFixed(1) : String(v);
// pallets processed per process in the 60 minutes up to history index idx (rolling), from cumulative counters
function workAt(idx) {
  const w = {}; if (idx < 0 || !sim.hist.length) { PROC_ORDER.forEach(id => w[id] = 0); return w; }
  const k = Math.max(1, Math.round(60 / cfg.run.stepMin)), a = sim.hist[idx], b = idx - k >= 0 ? sim.hist[idx - k] : null;
  PROC_ORDER.forEach((id, j) => w[id] = a[19 + j] - (b ? b[19 + j] : 0)); return w;
}
function peaksUpTo(idx) {
  if (idx < 0) return null; if (!peakCache.v || idx < peakCache.n) peakCache = { n: 0, v: AREA_IDS.concat('S11').map(() => 0) };
  for (let i = peakCache.n; i <= idx; i++) for (let a = 0; a < 6; a++) if (sim.hist[i][a] > peakCache.v[a]) peakCache.v[a] = sim.hist[i][a];
  peakCache.n = idx + 1; return peakCache.v;
}

// ---------- floor / diagram drawing ----------
const LW = 1320, LH = 580, LH_STATIC = 470;
const L = {}; (function () {
  let x = 12; const gap = 14;
  [['F1', 70], ['F2', 70], ['F3', 70], ['S4', 86], ['F5', 70], ['S6', 86], ['F7', 70], ['S8', 140], ['F9', 70], ['S10', 86], ['F11', 70], ['S12', 86], ['F13', 70], ['F14', 70]]
    .forEach(([id, w]) => { L[id] = { x, w, cx: x + w / 2 }; x += w + gap; });
  L.S11 = { x: L.S8.cx - 85, w: 170, cx: L.S8.cx, y: 366, h: 76 };
})();
const ORDER = ['F1', 'F2', 'F3', 'S4', 'F5', 'S6', 'F7', 'S8', 'F9', 'S10', 'F11', 'S12', 'F13', 'F14'];
const AY = 110, AH = 170, AB = AY + AH, PY = 146, PH = 100, MID = 196, BR = 317, PUR = '#b9a9f5';
const LN = L.S11.y + L.S11.h / 2;
const F7R = { x: L.S8.cx - 65, y: 295, w: 130, h: 44 };
const F17L = { x: (L.S6.x + 22 + L.S11.x) / 2 - 35, y: LN - 29, w: 70, h: 58 }, F17R = { x: (L.S10.x + 70 + L.S11.x + L.S11.w) / 2 - 35, y: LN - 29, w: 70, h: 58 };
const PSUB = { F1: 'check', F2: 'unload', F3: 'receive', F5: 'S4→S6', F7: 'S6→S8', F9: 'S8→S10', F11: 'S10→S12', F13: 'S12→trucks', F14: 'dispatch' };
const EDGES = {
  'F1>F2': [[L.F1.cx, MID], [L.F2.cx, MID]], 'F2>F3': [[L.F2.cx, MID], [L.F3.cx, MID]], 'F3>S4': [[L.F3.cx, MID], [L.S4.cx, MID]], 'S4>S6': [[L.S4.cx, MID], [L.S6.cx, MID]],
  'S6>S8': [[L.S6.cx, MID], [L.S8.cx, MID]], 'S8>S10': [[L.S8.cx, MID], [L.S10.cx, MID]], 'S10>S12': [[L.S10.cx, MID], [L.S12.cx, MID]],
  'S12>F13': [[L.S12.cx, MID], [L.F13.cx, MID]], 'F13>F14': [[L.F13.cx, MID], [L.F14.cx, MID]], 'F14>out': [[L.F14.cx, MID], [LW - 4, MID]],
  'S8>S10r': [[L.S8.cx, AB], [L.S8.cx, BR], [L.S10.x + 22, BR], [L.S10.x + 22, AB]], 'S8>S6r': [[L.S8.cx, AB], [L.S8.cx, BR], [L.S6.x + 70, BR], [L.S6.x + 70, AB]],
  'S10r>S11': [[L.S10.x + 70, AB], [L.S10.x + 70, LN], [L.S11.x + L.S11.w, LN]], 'S6r>S11': [[L.S6.x + 22, AB], [L.S6.x + 22, LN], [L.S11.x, LN]],
};
const EDGECOL = { 'F1>F2': COL.blue, 'F2>F3': COL.blue, 'F3>S4': COL.blue, 'S4>S6': COL.blue, 'S6>S8': COL.blue, 'S8>S10': COL.green, 'S10>S12': COL.green, 'S12>F13': COL.green, 'F13>F14': COL.green, 'F14>out': COL.green };
function spawnDots() {
  for (const k in sim.flowAcc) {
    const q = sim.flowAcc[k]; if (q > 0 && EDGES[k]) { const n = Math.min(4, Math.ceil(q / 8)); for (let i = 0; i < n; i++) dots.push({ e: k, s: -i * 0.07 }); }
    sim.flowAcc[k] = 0;
  }
  if (dots.length > 400) dots.splice(0, dots.length - 400);
}
function pathPoint(pts, s) {
  const segs = []; let tot = 0; for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); segs.push(d); tot += d; }
  let d = Math.max(0, Math.min(1, s)) * tot; for (let i = 0; i < segs.length; i++) { if (d <= segs[i]) { const f = d / segs[i]; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f]; } d -= segs[i]; }
  return pts[pts.length - 1];
}
function arrow(x, pts, col) {
  x.strokeStyle = col || '#aab4c3'; x.fillStyle = col || '#aab4c3'; x.lineWidth = 1.6; x.beginPath(); x.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => x.lineTo(p[0], p[1])); x.stroke();
  const a = pts[pts.length - 2], b = pts[pts.length - 1], ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
  x.beginPath(); x.moveTo(b[0], b[1]); x.lineTo(b[0] - 8 * Math.cos(ang - .45), b[1] - 8 * Math.sin(ang - .45)); x.lineTo(b[0] - 8 * Math.cos(ang + .45), b[1] - 8 * Math.sin(ang + .45)); x.fill();
}
function rr(x, X, Y, W, H, r, fill, stroke) { x.beginPath(); x.roundRect(X, Y, W, H, r); if (fill) { x.fillStyle = fill; x.fill(); } if (stroke) { x.strokeStyle = stroke; x.lineWidth = 1.5; x.stroke(); } }
function txt(x, s, X, Y, size, col, align, bold) { x.font = `${bold ? '600 ' : ''}${size}px Segoe UI, sans-serif`; x.fillStyle = col || COL.ink; x.textAlign = align || 'center'; x.fillText(s, X, Y); }

// One drawing routine for the Live floor, the Inputs capacity diagram and the Snapshot view.
// spec = { areas:{id:{big,sub,bottom,bottom2,ratio,over}}, procs:{id:{lines:[]}}, f7r:{lines}, f17l:{lines}, f17r:{lines}, s11:{big,line} }
function drawBase(x, spec) {
  for (let i = 0; i < ORDER.length - 1; i++) { const a = L[ORDER[i]], b = L[ORDER[i + 1]]; arrow(x, [[a.x + a.w + 1, MID], [b.x - 1, MID]]); }
  arrow(x, [[L.F14.x + L.F14.w + 1, MID], [LW - 3, MID]]);
  arrow(x, [[L.S8.cx, AB + 1], [L.S8.cx, F7R.y - 1]], PUR);
  arrow(x, [[F7R.x - 1, BR], [L.S6.x + 70, BR], [L.S6.x + 70, AB + 1]], PUR); arrow(x, [[F7R.x + F7R.w + 1, BR], [L.S10.x + 22, BR], [L.S10.x + 22, AB + 1]], PUR);
  arrow(x, [[L.S10.x + 70, AB + 1], [L.S10.x + 70, LN], [L.S11.x + L.S11.w + 1, LN]], PUR); arrow(x, [[L.S6.x + 22, AB + 1], [L.S6.x + 22, LN], [L.S11.x - 1, LN]], PUR);
  txt(x, `${Math.round((1 - cfg.repl.split10) * 100)}%`, (F7R.x + L.S6.x + 70) / 2, BR - 5, 11, COL.purple, 'center', true); txt(x, `${Math.round(cfg.repl.split10 * 100)}%`, (F7R.x + F7R.w + L.S10.x + 22) / 2, BR - 5, 11, COL.purple, 'center', true);
  AREA_IDS.forEach(id => {
    const p = L[id], a = spec.areas[id];
    rr(x, p.x, AY, p.w, AH, 8, '#eaf6f6', a.over ? COL.red : COL.teal);
    const fh = Math.min(1, a.ratio) * (AH - 4), fc = a.over ? COL.red : a.ratio > .85 ? COL.amber : COL.teal;
    x.save(); x.beginPath(); x.roundRect(p.x + 1, AY + 1, p.w - 2, AH - 2, 7); x.clip(); x.globalAlpha = .55; x.fillStyle = fc; x.fillRect(p.x, AY + AH - fh, p.w, fh); x.restore();
    if (a.over) rr(x, p.x, AY - 5, p.w, 5, 2, COL.red);
    txt(x, id, p.cx, AY + 18, 15, COL.ink, 'center', true); txt(x, AREA_NAMES[id], p.cx, AY + 31, 9, COL.mute);
    txt(x, a.big, p.cx, AY + 88, id === 'S8' ? 24 : 20, a.over ? COL.red : COL.ink, 'center', true); txt(x, a.sub, p.cx, AY + 105, 10, COL.mute);
    if (a.bottom) txt(x, a.bottom, p.cx, AY + 148, 10, a.bottomRed ? COL.red : COL.mute, 'center', !!a.bottomRed);
    if (a.bottom2) txt(x, a.bottom2, p.cx, AY + 162, 10, COL.red, 'center', true);
  });
  const S11 = L.S11; rr(x, S11.x, S11.y, S11.w, S11.h, 8, '#eaf6f6', COL.teal);
  txt(x, 'S11  Final replenishment', S11.cx, S11.y + 17, 12, COL.ink, 'center', true); txt(x, spec.s11.big, S11.cx, S11.y + 46, 22, COL.ink, 'center', true); if (spec.s11.line) txt(x, spec.s11.line, S11.cx, S11.y + 66, 10, COL.blue, 'center', true);
  rr(x, F7R.x, F7R.y, F7R.w, F7R.h, 8, COL.orange); txt(x, 'F7-REPL  replen pick', F7R.x + F7R.w / 2, F7R.y + 16, 11, '#fff', 'center', true); txt(x, spec.f7r.lines.join(' · '), F7R.x + F7R.w / 2, F7R.y + 33, 10, '#fff');
  [[F17L, 'S6→S11', spec.f17l], [F17R, 'S10→S11', spec.f17r]].forEach(([b, lab, sp]) => {
    rr(x, b.x, b.y, b.w, b.h, 8, COL.blue); txt(x, 'F17 · EPT', b.x + b.w / 2, b.y + 15, 11, '#fff', 'center', true); txt(x, lab, b.x + b.w / 2, b.y + 29, 9, '#e8f0fb');
    sp.lines.forEach((t, i) => txt(x, t, b.x + b.w / 2, b.y + 42 + i * 11, 10, '#fff'));
  });
  ORDER.filter(id => id[0] === 'F').forEach(id => {
    const p = L[id], pool = id === 'F7' || id === 'F9';
    rr(x, p.x, PY, p.w, PH, 8, pool ? COL.orange : COL.blue); txt(x, id, p.cx, PY + 22, 16, '#fff', 'center', true); txt(x, PSUB[id], p.cx, PY + 37, 9, '#fff');
    spec.procs[id].lines.forEach((t, i) => txt(x, t, p.cx, PY + 54 + i * 13, 10, '#fff'));
  });
}
// builds the drawing spec from a history snapshot S (live floor or Snapshot tab)
function snapSpec(S, pk, live) {
  const r = S.row, spec = { areas: {}, procs: {}, s11: {} }; const pr = id => (cfg.enforceNonShared ? `${fp(S.ppl[id])}/${flowCapacity(cfg, id).people} ppl` : `${fp(S.ppl[id])} ppl`);
  AREA_IDS.forEach(id => {
    const stock = r[SNAP[id]], cap = cfg.areas[id].cap, ratio = cap > 0 ? stock / cap : 0, peak = pk ? pk[SNAP[id]] : cfg.areas[id].init;
    spec.areas[id] = { big: num(stock), sub: `of ${num(cap)}  (${cap > 0 ? Math.round(ratio * 100) : 0}%)`, ratio, over: stock > cap, bottom: `peak ${num(peak)}`, bottomRed: peak > cap, bottom2: peak > cap ? `+${num(peak - cap)} over` : '' };
  });
  const lines = id => live ? [`Q ${num(r[SNAP[id]])}`, pr(id), `${num(sim.rate(id))}/h`] : [`Q ${num(r[SNAP[id]])}`, `${num(S.w[id])}/h done`, pr(id)];
  ['F1', 'F2', 'F3', 'F5', 'F11', 'F13', 'F14'].forEach(id => spec.procs[id] = { lines: lines(id) });
  ['F7', 'F9'].forEach(id => spec.procs[id] = { lines: [`queue ${num(r[SNAP[id]])}`, live ? `${fp(S.ppl[id])} ppl` : `${num(S.w[id])}/h done`, live ? '' : `${fp(S.ppl[id])} ppl`].filter(Boolean) });
  spec.f7r = { lines: [`queue ${num(r[SNAP.F7R])}`, `${fp(S.ppl.F7R)} ppl`] };
  spec.f17l = { lines: [`waiting ${num(S.q17s6)}`] }; spec.f17r = { lines: [`waiting ${num(S.q17s10)}`] };
  spec.s11 = { big: num(r[SNAP.S11]), line: `F17: ${fp(S.ppl.F17)}${cfg.enforceNonShared ? '/' + flowCapacity(cfg, 'F17').people : ''} ppl` };
  return spec;
}
// static capacity view for the Inputs tab: flow capacity (productivity x FTE or entered capacity) and stock capacity
function capacitySpec() {
  const spec = { areas: {}, procs: {}, s11: { big: '∞', line: 'no capacity limit' } }, pi = poolInfo(cfg);
  AREA_IDS.forEach(id => { const a = cfg.areas[id]; spec.areas[id] = { big: num(a.cap), sub: 'pallets capacity', ratio: a.cap > 0 ? a.init / a.cap : 0, over: false, bottom: `initial stock ${num(a.init)}` }; });
  const fl = id => { const f = flowCapacity(cfg, id), eff = cfg.enforceNonShared ? f.effective : cfg.flowCap; return [`${num(eff)}/h`, `${cfg.enforceNonShared ? f.people : '–'} ppl`, f.capped && cfg.enforceNonShared ? 'capped' : f.mode === 'capacity' ? 'by capacity' : 'by people']; };
  ['F1', 'F2', 'F3', 'F5', 'F11', 'F13', 'F14'].forEach(id => spec.procs[id] = { lines: fl(id) });
  ['F7', 'F9'].forEach(id => spec.procs[id] = { lines: ['pool total', `${num(pi.effective)}/h`, `${pi.people} ppl`] });
  spec.f7r = { lines: [`pool ${num(pi.effective)}/h`] };
  const f17 = fl('F17'); spec.f17l = { lines: [f17[0], f17[1]] }; spec.f17r = { lines: [f17[0], f17[1]] };
  return spec;
}
function drawInputsDiagram() {
  const c = $('diagInputs'); if (!c || !$('tab-inputs').classList.contains('on') && c.clientWidth === 0) return;
  const x = fit(c, LW, LH_STATIC); x.clearRect(0, 0, LW, LH_STATIC);
  txt(x, '◄ EAST — INBOUND', 12, 28, 13, COL.blue, 'left', true); txt(x, 'WEST — OUTBOUND ►', LW - 12, 28, 13, COL.green, 'right', true); txt(x, 'MAIN STORAGE', L.S8.cx, 28, 13, COL.teal, 'center', true);
  txt(x, 'Static stock & flow diagram — flow capacity (pallets/h) and stock capacity (pallets)', LW / 2, 62, 14, COL.ink, 'center', true);
  txt(x, 'Flow boxes: capacity pallets/h · people (FTE) · how it is defined.  Area boxes: stock capacity and initial stock.', LW / 2, 82, 11, COL.mute, 'center');
  drawBase(x, capacitySpec());
  const pi = poolInfo(cfg); txt(x, `Shared pool F7 + F9 + F7-REPL: ${num(pi.effective)} pallets/h in total (${pi.people} people at ${cfg.proc.F7.prod}/h) · single flows are capped at ${num(cfg.flowCap)} pallets/h`, LW / 2, LH_STATIC - 12, 12, COL.orange, 'center', true);
}

function drawFloor(dtReal) {
  const c = $('floor'), x = fit(c, LW, LH); x.clearRect(0, 0, LW, LH);
  const S = snapAt(cursor), r = S.row, pk = peaksUpTo(S.idx);
  txt(x, '◄ EAST — INBOUND', 12, 30, 13, COL.blue, 'left', true); txt(x, 'WEST — OUTBOUND ►', LW - 12, 30, 13, COL.green, 'right', true);
  txt(x, 'MAIN STORAGE', L.S8.cx, 30, 13, COL.teal, 'center', true); txt(x, `${clock(S.t)}`, LW / 2, 56, 16, COL.ink, 'center', true);
  drawBase(x, snapSpec(S, pk, true));
  [[L.F7, r[SNAP.F7], 'S6'], [L.F9, r[SNAP.F9], 'S8']].forEach(([p, b, where]) => { if (b > 0) { rr(x, p.x - 6, 112, p.w + 12, 30, 6, COL.red); txt(x, `QUEUED ${num(b)}`, p.cx, 125, 10, '#fff', 'center', true); txt(x, `held in ${where}`, p.cx, 137, 9, '#fff'); } });
  // shared pool gauge
  const gx = 15, gy = 484, gw = 480, used = S.u7 + S.u9 + S.u9r, cap = poolCap(cfg), sc = gw / Math.max(cap, used, 1);
  rr(x, gx - 5, gy - 28, gw + 10, 92, 8, '#fff7ed', '#f5c28f'); txt(x, `SHARED POOL  F7 + F9 + F7-REPL ≤ ${num(cap)}/h`, gx, gy - 10, 12, COL.orange, 'left', true);
  rr(x, gx, gy, gw, 18, 4, '#e8edf4'); let px = gx; [[S.u7, COL.blue], [S.u9, COL.orange], [S.u9r, COL.purple]].forEach(([v, col]) => { x.fillStyle = col; x.fillRect(px, gy, v * sc, 18); px += v * sc; });
  x.strokeStyle = COL.red; x.lineWidth = 2; x.beginPath(); x.moveTo(gx + cap * sc, gy - 4); x.lineTo(gx + cap * sc, gy + 22); x.stroke();
  txt(x, `last 60 min: ${num(used)} / ${num(cap)}  (F7 ${num(S.u7)} · F9 out ${num(S.u9)} · F7-REPL ${num(S.u9r)})`, gx, gy + 38, 11, COL.ink, 'left'); txt(x, 'blue F7 putaway · orange F9 outbound · purple F7-REPL replenishment', gx, gy + 54, 10, COL.mute, 'left');
  // people needed (last 60 min of work)
  const modeTxt = pplFte() ? 'B: average FTE' : 'A: whole people, worst case per hour', pi = poolInfo(cfg);
  rr(x, 520, 456, LW - 532, 86, 8, '#eef6ff', '#a9c8ec'); txt(x, `PEOPLE NEEDED NOW (${modeTxt}): ${fp(S.pplTotal)}`, 532, 477, 13, COL.blue, 'left', true);
  txt(x, `Dock F1: ${fp(S.ppl.F1)} · F2: ${fp(S.ppl.F2)} · F3: ${fp(S.ppl.F3)} · F5: ${fp(S.ppl.F5)} · Pool F7+F9+F7-REPL: ${fp(S.pplPool)} · F11: ${fp(S.ppl.F11)} · F13: ${fp(S.ppl.F13)} · F14: ${fp(S.ppl.F14)} · F17: ${fp(S.ppl.F17)}`, 532, 496, 11, COL.ink, 'left');
  txt(x, `Pool capacity ${num(pi.effective)}/h = ${pi.needed} people at ${cfg.proc.F7.prod}/h each (${pi.mode === 'people' ? 'defined by people' : 'defined by capacity'}); single flows are capped at ${num(cfg.flowCap)}/h`, 532, 514, 11, COL.mute, 'left');
  txt(x, `Peak so far: ${fp(pplPeakSoFar())} people in one hour`, 532, 531, 11, COL.mute, 'left');
  txt(x, 'Teal fill = stock vs capacity · amber > 85 % · red = over capacity (event-level peak shown)', LW - 12, LH - 8, 10, COL.mute, 'right');
  if (running) spawnDots();
  for (const d of dots) { if (d.s < 0) continue; const pts = EDGES[d.e]; const [px2, py2] = pathPoint(pts, d.s); x.fillStyle = EDGECOL[d.e] || COL.purple; x.globalAlpha = .9; x.beginPath(); x.arc(px2, py2, 3.2, 0, 7); x.fill(); x.globalAlpha = 1; }
  for (const d of dots) d.s += dtReal / 0.9; dots = dots.filter(d => d.s <= 1);
}
// ---------- charts ----------
function lineChart(id, series, yMaxMin, hline, unit, lw = 700) {
  const c = $(id), x = fit(c, lw, 240); x.clearRect(0, 0, lw, 240);
  const n = sim.hist.length, win = +$('win').value; const dt = cfg.run.stepMin;
  const endT = Math.max(n * dt, 60), startT = win > 0 ? Math.max(0, endT - win * 60) : 0;
  const i0 = Math.floor(startT / dt), i1 = (cursor >= 0 ? Math.min(cursor + 1, n) : n);
  const m = { l: 42, r: 8, t: 8, b: 22 }, W = lw - m.l - m.r, H = 240 - m.t - m.b;
  let ymax = yMaxMin; const stride = Math.max(1, Math.floor((i1 - i0) / W));
  for (let i = i0; i < i1; i += stride) for (const s of series) ymax = Math.max(ymax, s.f(sim.hist[i], i));
  ymax *= 1.08; const X = t => m.l + (t - startT) / Math.max(1, endT - startT) * W, Y = v => m.t + H - v / ymax * H;
  x.strokeStyle = '#eef1f6'; x.fillStyle = COL.mute; x.font = '10px Segoe UI'; x.textAlign = 'right'; x.lineWidth = 1;
  for (let g = 0; g <= 4; g++) { const v = ymax * g / 4, yy = Y(v); x.beginPath(); x.moveTo(m.l, yy); x.lineTo(lw - m.r, yy); x.stroke(); x.fillText(Math.round(v) + (unit || ''), m.l - 4, yy + 3); }
  const span = endT - startT, tick = span > 4320 ? 1440 : span > 1440 ? 360 : 120; x.textAlign = 'center';
  for (let t = Math.ceil(startT / tick) * tick; t <= endT; t += tick) { x.strokeStyle = '#f1f3f8'; x.beginPath(); x.moveTo(X(t), m.t); x.lineTo(X(t), m.t + H); x.stroke(); x.fillText(tick >= 1440 ? `D${t / 1440 + 1}` : `${pad(Math.floor(t % 1440 / 60))}:00`, X(t), 236); }
  if (hline !== undefined) { x.strokeStyle = COL.red; x.setLineDash([5, 4]); x.beginPath(); x.moveTo(m.l, Y(hline)); x.lineTo(lw - m.r, Y(hline)); x.stroke(); x.setLineDash([]); }
  for (const s of series) {
    x.strokeStyle = s.col; x.lineWidth = 1.6; x.beginPath(); let first = true;
    for (let i = i0; i < i1; i += stride) { const px = X(sim.histT[i]), py = Y(s.f(sim.hist[i], i)); if (first) { x.moveTo(px, py); first = false; } else x.lineTo(px, py); }
    x.stroke();
  }
}
const OCC = AREA_IDS.map((id, i) => ({ id, col: [COL.blue, COL.amber, COL.teal, COL.green, COL.purple][i], f: r => 100 * r[SNAP[id]] / Math.max(1, cfg.areas[id].cap) }));
const BLS = [{ name: 'F7 backlog (held in S6)', col: COL.blue, f: r => r[SNAP.F7] }, { name: 'F9 outbound backlog (held in S8)', col: COL.orange, f: r => r[SNAP.F9] }, { name: 'F7-REPL replenishment backlog (held in S8)', col: COL.purple, f: r => r[SNAP.F7R] }];
$('legOcc').innerHTML = OCC.map(s => `<span><i style="background:${s.col}"></i>${s.id}</span>`).join('') + '<span style="color:#d92d20">- - 100 % capacity</span>';
$('legBl').innerHTML = BLS.map(s => `<span><i style="background:${s.col}"></i>${s.name}</span>`).join('');
const pplAt = i => { const w = {}; const a = sim.hist[i], k = Math.max(1, Math.round(60 / cfg.run.stepMin)), b = i - k >= 0 ? sim.hist[i - k] : null; PROC_ORDER.forEach((id, j) => w[id] = a[19 + j] - (b ? b[19 + j] : 0)); return w; };
const PPL = [
  { name: 'Dock F1–F3', col: COL.blue, f: (r, i) => { const w = pplAt(i); return pq('F1', w.F1) + pq('F2', w.F2) + pq('F3', w.F3); } },
  { name: 'F5', col: COL.teal, f: (r, i) => pq('F5', pplAt(i).F5) },
  { name: 'Pool F7 + F9 + F7-REPL', col: COL.orange, f: (r, i) => { const w = pplAt(i); return pq('F7', poolWork(cfg, w)); } },
  { name: 'F11', col: COL.green, f: (r, i) => pq('F11', pplAt(i).F11) },
  { name: 'F13 + F14', col: COL.purple, f: (r, i) => { const w = pplAt(i); return pq('F13', w.F13) + pq('F14', w.F14); } },
  { name: 'F17 (EPT)', col: COL.amber, f: (r, i) => pq('F17', pplAt(i).F17) },
  { name: 'TOTAL people', col: COL.ink, f: (r, i) => peopleTotal(cfg, pplAt(i), pplFte()) },
];
$('legPpl').innerHTML = PPL.map(s => `<span><i style="background:${s.col}"></i>${s.name}</span>`).join('');
function pplPeakSoFar() { let m = 0; for (const h of sim.hours) m = Math.max(m, peopleTotal(cfg, h, pplFte())); return m; }function drawCharts(force) {
  const now = performance.now(); if (!force && now - lastChart < 250) return; lastChart = now;
  lineChart('chartOcc', OCC, 120, 100, '%'); lineChart('chartBl', BLS, 20); lineChart('chartPpl', PPL, 4, undefined, '', 1440);
}
document.querySelectorAll('[data-png]').forEach(b => b.onclick = () => { const a = document.createElement('a'); a.href = $(b.dataset.png).toDataURL('image/png'); a.download = b.dataset.png + '.png'; a.click(); });

// ---------- panels ----------
function updatePanels() {
  const S = snapAt(cursor), r = S.row;
  for (; dwellSeen < sim.dwell.length; dwellSeen++) { const d = sim.dwell[dwellSeen]; if (maxDwell[d.flow] !== undefined && d.wait > maxDwell[d.flow]) maxDwell[d.flow] = d.wait; }
  const used = S.u7 + S.u9 + S.u9r, cap = poolCap(cfg), bl = r[SNAP.F7] + r[SNAP.F9] + r[SNAP.F7R];
  const breaches = AREA_IDS.filter(id => sim.areas[id].peak > cfg.areas[id].cap);
  const cy = cycleStats(S.t), cyc = v => v === null ? '–' : dur(v), cav = e => e.q ? dur(e.sum / e.q) : '–';
  const k = (label, val, cls) => `<div class="kpi ${cls || ''}"><b>${val}</b><span>${label}</span></div>`;
  $('kpis').innerHTML = k('Pool use (last 60 min)', `${num(used)}/${cap}`, used >= cap * .98 ? 'warn' : '') + k('Waiting at pool now', num(bl), bl > 0 ? 'warn' : 'ok') +
    k('Max carry-over backlog (hour end)', num(sim.maxBL.tot), sim.maxBL.tot > 0 ? 'bad' : 'ok') + k('S8 stock', num(r[SNAP.S8])) +
    k('Inbound cycle time (latest)', cyc(cy.IN.last)) + k('Average inbound cycle time', cav(cy.IN)) + k('Outbound cycle time (latest)', cyc(cy.OUT.last)) + k('Average outbound cycle time', cav(cy.OUT)) +
    k('Max inbound dwell', dur(maxDwell.IN)) + k('Max outbound dwell', dur(maxDwell.OUT)) +
    k('Areas over capacity', breaches.length ? breaches.join(', ') : 'none', breaches.length ? 'bad' : 'ok') + k('People needed now (' + (pplFte() ? 'avg FTE' : 'whole people') + ')', fp(S.pplTotal)) + k('Peak people in one hour', fp(pplPeakSoFar())) + k('Completed (in/out/rep)', `${num(sim.completed.IN)}/${num(sim.completed.OUT)}/${num(sim.completed.REP)}`);
  $('clock').textContent = clock(S.t);
  $('status').textContent = sim.finished ? (sim.drained ? '● finished — all demand cleared' : '● finished — residual backlog') : (cursor >= 0 ? '● replay' : running ? '● running' : '● paused');
  $('scrub').max = Math.max(0, sim.hist.length - 1); if (cursor < 0) $('scrub').value = sim.hist.length - 1;
  if (notesShown !== sim.notes.length) { notesShown = sim.notes.length; $('log').innerHTML = sim.notes.slice(-80).reverse().map(n => `<div class="${n.kind}"><span class="small">${clock(n.t)}</span> ${esc(n.text)}</div>`).join(''); }
}
let lastFrame = performance.now(), lastPanel = 0;
function frame(ts) {
  const dtReal = Math.min(0.1, (ts - lastFrame) / 1000); lastFrame = ts;
  if (running) advance(+$('speed').value * dtReal);
  if ($('tab-live').classList.contains('on')) { drawFloor(dtReal); drawCharts(); if (ts - lastPanel > 120) { lastPanel = ts; updatePanels(); } }
  requestAnimationFrame(frame);
}

// ---------- results ----------
function tag(ok, t) { return `<span class="tag ${ok ? 'pass' : 'fail'}">${t || (ok ? 'PASS' : 'FAIL')}</span>`; }
const FLOWN = { IN: 'Inbound (F1→S8)', OUT: 'Outbound (S8→F14)', REP: 'Replenishment (S8→F7-REPL→S6/S10→F17→S11)' };
function renderResults() {
  const body = $('resBody');
  if (!sim.finished) { $('resNote').textContent = 'Run the scenario to the end (live or with the button) to see results.'; body.innerHTML = '<div class="card">No completed run yet.</div>'; return; }
  $('resNote').textContent = `Run complete at ${clock(sim.t)} (${sim.drained ? 'all demand cleared' : 'residual backlog'}).`;
  const r = sim.result, v = validateConfig(cfg); let h = '';
  h += v.warnings.map(w => `<div class="msg warn">${esc(w)}</div>`).join('');
  const verdictCls = r.capacityVerdict === 'PASS' ? 'pass' : r.capacityVerdict === 'FAIL' ? 'fail' : 'mid';
  h += `<div class="card"><h3>Executive summary</h3><div class="bar" style="gap:18px;align-items:flex-start">
    <div><div class="small">Design capacity</div><span class="tag ${verdictCls}" style="font-size:14px">${r.capacityVerdict}</span></div>
    <div><div class="small">Max backlog (F7 / F9 + F7-REPL)</div><b>${num(r.backlog.max.F7)} / ${num(r.backlog.max.F9)}</b> <span class="small">peak combined ${num(r.backlog.max.tot)} @ ${clock(r.backlog.max.totT)}</span></div>
    <div><div class="small">Ending backlog</div><b>${num(r.residual.total)}</b></div>
    <div><div class="small">Longest recovery</div><b>${dur(r.backlog.maxRecovery)}</b></div>
    <div><div class="small">Max inbound dwell</div><b>${dur(r.dwell.IN.max)}</b></div><div><div class="small">Max outbound dwell</div><b>${dur(r.dwell.OUT.max)}</b></div>
    <div><div class="small">Primary constraint</div><b>${r.primary ? r.primary.stage + ' (' + num(r.primary.palletHours) + ' pallet-h waiting)' : 'none'}</b></div>
    <div><div class="small">Shared pool saturated</div><b>${Math.round(r.sharedSaturation * 100)}%</b> <span class="small">of busy steps</span></div></div>
    <div style="margin-top:8px"><span class="small">Top causal hours: </span>${r.top3.map(t => `<b>${clock(t.abs * 60)}</b> (peak backlog ${num(t.bl)})`).join(' · ') || 'none'}</div>
    <div style="margin-top:8px">${r.areas.filter(a => a.id !== 'S11').map(a => `${a.id} ${tag(!a.breach)}`).join(' &nbsp; ')}</div></div>`;
  h += '<div class="card"><h3>Area report (event-level occupancy)</h3><table><tr><th>Area</th><th>Opening</th><th>Inbound</th><th>Outbound</th><th>Closing</th><th>Peak</th><th>Peak at</th><th>Capacity</th><th>Peak %</th><th>Result</th><th>Excess</th><th>Episodes</th><th>Time over</th></tr>';
  r.areas.forEach(a => { h += `<tr><td>${a.id}</td><td>${num(a.opening)}</td><td>${num(a.inflow)}</td><td>${num(a.outflow)}</td><td>${num(a.closing)}</td><td>${num(a.peak)}</td><td>${clock(a.peakT)}</td><td>${num(a.cap)}</td><td>${a.cap === Infinity ? '–' : Math.round(100 * a.peak / a.cap) + '%'}</td><td>${a.id === 'S11' ? '–' : tag(!a.breach)}</td><td>${a.excess ? num(a.excess) : '–'}</td><td>${a.episodes.length}</td><td>${dur(a.minOver)}</td></tr>`; });
  h += '</table>';
  const eps = r.areas.flatMap(a => a.episodes).sort((a, b) => a.start - b.start);
  if (eps.length) h += `<h2>Capacity breaches (${eps.length})</h2><div class="scroll" style="max-height:240px"><table><tr><th>Area</th><th>Start</th><th>End</th><th>Peak</th><th>Peak at</th><th>Excess</th></tr>${eps.map(e => `<tr><td>${e.area}</td><td>${clock(e.start)}</td><td>${e.end === null ? 'open' : clock(e.end)}</td><td>${num(e.peak)}</td><td>${clock(e.peakT)}</td><td>${num(e.excess)}</td></tr>`).join('')}</table></div>`;
  h += '</div>';
  h += hourlyDashboardHtml();
  h += peopleCardHtml();
  h += '<div class="card"><h3>Dwell (additional wait, productive processing time excluded; pallet-weighted)</h3><table><tr><th>Flow</th><th>Pallets</th><th>Avg</th><th>Median</th><th>P90</th><th>P95</th><th>P99</th><th>Max</th><th>% pallets &gt; 0</th><th>Avg lead time</th><th>Max cohort</th><th>Wait split</th></tr>';
  for (const f of ['IN', 'OUT', 'REP']) {
    const d = r.dwell[f], tot = d.cap + d.stock + d.block || 1;
    h += `<tr><td>${FLOWN[f]}</td><td>${num(d.pallets)}</td><td>${dur(d.avg)}</td><td>${dur(d.median)}</td><td>${dur(d.p90)}</td><td>${dur(d.p95)}</td><td>${dur(d.p99)}</td><td><b>${dur(d.max)}</b></td><td>${d.pctPos.toFixed(1)}%</td><td>${dur(d.avgLead)}</td><td class="l">${d.maxRow ? `${d.maxRow.cohort} (req ${clock(d.maxRow.origin)})` : '–'}</td>
      <td style="min-width:160px"><div class="hbar"><i style="width:${100 * d.cap / tot}%;background:${COL.orange}"></i><i style="width:${100 * d.stock / tot}%;background:${COL.red}"></i><i style="width:${100 * d.block / tot}%;background:${COL.purple}"></i></div></td></tr>`;
  }
  h += '</table><div class="legend small" style="margin-top:4px"><span><i style="background:#ed7d31"></i>waiting for processing capacity</span><span><i style="background:#d92d20"></i>waiting for stock availability</span><span><i style="background:#7a5af8"></i>blocked by full downstream area</span></div>';
  h += '<h2>Dwell contribution by process / queue</h2><table><tr><th>Flow</th>' + PROC_ORDER.map(s => `<th>${s}</th>`).join('') + '</tr>';
  for (const f of ['IN', 'OUT', 'REP']) { const d = r.dwell[f], tot = Object.values(d.stages).reduce((a, b) => a + b, 0) || 1; h += `<tr><td>${FLOWN[f]}</td>` + PROC_ORDER.map(s => `<td>${d.stages[s] ? Math.round(100 * d.stages[s] / tot) + '%' : '–'}</td>`).join('') + '</tr>'; }
  h += '</table><h2>Dwell histogram (pallets by additional wait)</h2><div id="hist"></div>';
  h += `<h2>Hourly heat map — average dwell by request day / hour <select id="hmFlow"><option value="IN">Inbound</option><option value="OUT">Outbound</option><option value="REP">Replenishment</option></select></h2><canvas id="heat" width="900" height="200"></canvas></div>`;
  h += '<div class="card"><h3>Backlog episodes at the shared pool</h3>';
  h += r.backlog.episodes.length ? `<div class="scroll" style="max-height:260px"><table><tr><th>Start</th><th>Cleared</th><th>Duration</th><th>Peak pallets</th><th>Peak at</th></tr>${r.backlog.episodes.map(e => `<tr><td>${clock(e.start)}</td><td>${e.end === null ? 'not cleared' : clock(e.end)}</td><td>${dur((e.end === null ? sim.t : e.end) - e.start)}</td><td>${num(e.peak)}</td><td>${clock(e.peakT)}</td></tr>`).join('')}</table></div>` : 'No backlog ever formed at the shared pool.';
  h += '</div>';
  h += `<div class="card"><h3>Validation checks (BRD Section 12)</h3>${r.checks.map(c => `<div>${tag(c.ok)} <b>${c.id}</b> ${esc(c.text)}</div>`).join('')}${sim.ledgerTruncated ? '<div class="msg warn">Ledger limit reached — ledgers are truncated (aggregates are still complete).</div>' : ''}<div id="testOut"></div></div>`;
  body.innerHTML = h; drawHist(); $('hmFlow').onchange = drawHeat; drawHeat();
}
// ---------- people required ----------
const PNAME = { F1: 'F1 Truck check', F2: 'F2 Unloading', F3: 'F3 Pallet receiving', F5: 'F5 S4→S6 move', F7: 'F7 Putaway', F9: 'F9 Outbound pick', F7R: 'F7-REPL Replen pick', F11: 'F11 S10→S12 move', F13: 'F13 Truck loading', F14: 'F14 Dispatch', F17: 'F17 EPT S6/S10→S11' };
const PUNIT = { F1: 'trucks', F14: 'trucks' };
let sizingCache = null;
// People are sized on a run whose non-shared processes are not headcount-limited, so the result is driven by demand only.
function getSizing() {
  if (!sizingCache || sizingCache.sim !== sim) {
    let s = sim;
    if (cfg.enforceNonShared) { const c = JSON.parse(JSON.stringify(cfg)); c.enforceNonShared = false; s = new Sim(c, { maxLedger: 0 }).run(); }
    sizingCache = { sim: sim, people: peopleSummary(s), basis: cfg.enforceNonShared ? 'unconstrained' : 'configured' };
  }
  return sizingCache;
}
function peopleBlock(S, isB, days) {
  const f = v => isB ? (Math.round(v * 10) / 10).toFixed(1) : String(v);
  let h = `<div class="bar" style="gap:22px;margin:8px 0"><div><div class="small">${isB ? 'Peak average-FTE in one hour' : 'Peak people in one hour'}</div><b style="font-size:20px">${f(S.total.peak)}</b> <span class="small">at ${clock(S.total.peakAt * 60)}</span></div>
    <div><div class="small">Average while working</div><b style="font-size:20px">${S.total.avgActive.toFixed(1)}</b></div>
    <div><div class="small">Average over the whole 24 h</div><b style="font-size:20px">${S.total.avgOverDay.toFixed(1)}</b></div>
    <div><div class="small">Person-hours per day</div><b style="font-size:20px">${S.total.personHoursPerDay.toFixed(0)}</b></div></div>`;
  h += '<table><tr><th>Process</th><th>Productivity / person</th><th>Pallets per day</th><th>Peak</th><th>Peak at</th><th>Average (working hours)</th><th>Working h/day</th><th>Person-hours/day</th><th>Configured headcount</th></tr>';
  const row = (id, label, prod, conf) => { const b = S.byProc[id], keys = id === 'POOL' ? ['F7', 'F9', 'F7R'] : [id], pallets = keys.reduce((a, k) => a + S.hourly.reduce((s, x) => s + x.work[k], 0), 0);
    return `<tr><td>${label}</td><td>${prod}</td><td>${num(pallets / days)}</td><td><b>${f(b.peak)}</b></td><td>${b.peak ? clock(b.peakAt * 60) : '–'}</td><td>${b.avgActive.toFixed(1)}</td><td>${(b.activeHours / days).toFixed(1)}</td><td>${(b.personHours / days).toFixed(0)}</td><td>${conf}</td></tr>`; };
  const nsRow = id => row(id, PNAME[id], `${cfg.proc[id].prod} ${PUNIT[id] || 'pallets'}/h`, cfg.proc[id].n);
  ['F1', 'F2', 'F3', 'F5'].forEach(id => h += nsRow(id));
  h += row('POOL', '<b>F7 + F9 + F7-REPL (shared pool)</b>', `${cfg.proc.F7.prod} pallets/h`, `pool ${num(poolCap(cfg))}/h ≈ ${poolInfo(cfg).needed} ppl`);
  ['F7', 'F9', 'F7R'].forEach(id => h += row(id, '&nbsp;&nbsp;↳ ' + PNAME[id], `${cfg.proc[id].prod} pallets/h`, '–'));
  ['F11', 'F13', 'F14', 'F17'].forEach(id => h += nsRow(id));
  h += '</table><div class="small">The total counts the shared pool once (not F7, F9 and F7-REPL separately).</div>';
  const cols = [...PROC_ORDER, 'POOL', 'TOTAL'], mx = Math.max(1e-9, ...S.byHod.map(r => r.total));
  h += `<h2>${isB ? 'Average people (FTE)' : 'People needed'} by hour of day (highest across all simulated days)</h2><div class="scroll" style="max-height:420px"><table><tr><th>Hour</th>` + cols.map(c => `<th>${c === 'POOL' ? 'Pool F7+F9+F7R' : c === 'F7R' ? 'F7-REPL' : c}</th>`).join('') + '</tr>';
  S.byHod.forEach(r => { h += `<tr><td>${pad(r.hod)}:00</td>` + cols.map(c => { const v = c === 'TOTAL' ? r.total : c === 'POOL' ? r.pool : r.ppl[c]; return `<td style="${v ? `background:rgba(91,155,213,${0.12 + 0.7 * v / mx})` : 'color:#aab'};${c === 'TOTAL' ? 'font-weight:700' : ''}">${v ? f(v) : '·'}</td>`; }).join('') + '</tr>'; });
  return h + '</table></div>';
}
function peopleCardHtml() {
  const { people: P, basis } = getSizing(), days = Math.max(1, cfg.run.days);
  let h = '<div class="card"><h3>People required per flow per hour — two scenarios</h3>';
  h += `<div class="small"><b>Selected method: A, counted per hour.</b> Work = pallets (trucks for F1/F14) completed in the hour ÷ productivity per person. The shared pool (F7 + F9 + F7-REPL) is always capped at the ${num(poolCap(cfg))} pallets/h pool capacity, i.e. at most ${P.poolCapacityPeople} people (${cfg.proc.F7.prod}/h each); demand above that becomes backlog, not extra people. ${basis === 'unconstrained' ? `Sized on a run where F1–F5, F11–F14 and F17 are not headcount-limited but each is still capped at the ${num(cfg.flowCap)} pallets/h single-flow maximum, so numbers reflect demand rather than placeholder headcounts.` : 'Based on the current run.'} Scenario B is kept as a reference.</div>`;
  h += `<table style="margin:8px 0"><tr><th class="l">Scenario</th><th class="l">How it is calculated</th><th class="l">Use it for</th></tr>
    <tr><td class="l"><b>A · Peak (whole people)</b></td><td class="l" style="white-space:normal">Hourly work ÷ productivity, <b>rounded up</b> to whole people. Assumes every lot must be finished within the hour it arrives (all pallets land at the start of the hour), so it is the worst case.</td><td class="l" style="white-space:normal">Rostering / minimum people physically on the floor each hour so nothing carries over. Peak-capacity and safety sizing.</td></tr>
    <tr><td class="l"><b>B · Average (FTE)</b></td><td class="l" style="white-space:normal">Same work, <b>not rounded</b> = average people kept busy through the hour (person-hours ÷ hours). Assumes work can be spread across the hour and people are flexible between processes.</td><td class="l" style="white-space:normal">Labour budget, FTE and cost planning; comparing against a shift pattern with flexible, multi-skilled staff.</td></tr></table>`;
  h += '<h2>Scenario A — Peak (whole people, worst case per hour)</h2>' + peopleBlock(P.A, false, days);
  h += '<h2 style="margin-top:18px">Scenario B — Average (FTE, not rounded)</h2>' + peopleBlock(P.B, true, days);
  return h + '</div>';
}
function peopleCsv() {
  const { people: P } = getSizing(), cols = [...PROC_ORDER, 'POOL'], nm = c => c === 'POOL' ? 'pool_F7_F9_F7R' : c;
  const head = ['hour', ...cols.map(c => 'A_' + nm(c)), 'A_total_people', ...cols.map(c => 'B_' + nm(c) + '_fte'), 'B_total_fte'];
  return csvOf(head, P.A.hourly.map((x, i) => { const y = P.B.hourly[i]; return [clock(x.abs * 60), ...cols.map(c => c === 'POOL' ? x.pool : x.ppl[c]), x.total, ...cols.map(c => +(c === 'POOL' ? y.pool : y.ppl[c]).toFixed(2)), +y.total.toFixed(2)]; }));
}
function drawHist() {
  const bins = [[0, 0, 'none'], [0, 15, '≤15 min'], [15, 30, '15–30 min'], [30, 60, '30–60 min'], [60, 120, '1–2 h'], [120, 240, '2–4 h'], [240, 1e9, '>4 h']];
  let h = '<table><tr><th>Flow</th>' + bins.map(b => `<th>${b[2]}</th>`).join('') + '</tr>';
  for (const f of ['IN', 'OUT', 'REP']) {
    const rows = sim.dwell.filter(d => d.flow === f), tot = rows.reduce((a, d) => a + d.qty, 0) || 1;
    h += `<tr><td>${FLOWN[f]}</td>` + bins.map(([lo, hi], i) => { const q = rows.filter(d => i === 0 ? d.wait <= 0 : d.wait > lo && d.wait <= hi).reduce((a, d) => a + d.qty, 0); return `<td><div class="hbar" style="width:90px;display:inline-flex;vertical-align:middle"><i style="width:${100 * q / tot}%;background:${COL.orange}"></i></div> ${Math.round(100 * q / tot)}%</td>`; }).join('') + '</tr>';
  }
  $('hist').innerHTML = h + '</table>';
}
function drawHeat() {
  const f = $('hmFlow').value, c = $('heat'), days = cfg.run.days, rowH = Math.max(14, Math.min(26, 190 / days)); c.height = 30 + days * rowH + 8; c.style.height = '';
  const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height); const cw = (c.width - 60) / 24, g = {};
  sim.dwell.filter(d => d.flow === f).forEach(d => { const k = Math.floor(d.origin / 60); g[k] = g[k] || [0, 0]; g[k][0] += d.wait * d.qty; g[k][1] += d.qty; });
  let mx = 1; Object.values(g).forEach(v => mx = Math.max(mx, v[0] / v[1]));
  x.font = '10px Segoe UI'; x.fillStyle = COL.mute; x.textAlign = 'center'; for (let hh = 0; hh < 24; hh += 2) x.fillText(pad(hh), 60 + hh * cw + cw / 2, 12);
  for (let d = 0; d < days; d++) {
    x.textAlign = 'right'; x.fillStyle = COL.mute; x.fillText(`D${d + 1}`, 52, 30 + d * rowH + rowH / 2 + 3);
    for (let hh = 0; hh < 24; hh++) { const v = g[d * 24 + hh]; const a = v ? (v[0] / v[1]) / mx : -1; x.fillStyle = a < 0 ? '#f3f5f9' : `rgba(217,45,32,${0.08 + 0.92 * a})`; x.fillRect(60 + hh * cw, 20 + d * rowH, cw - 1, rowH - 1); }
  }
  x.fillStyle = COL.mute; x.textAlign = 'left'; x.fillText(`dark = longer (max ${dur(mx)}); grey = no completions`, 60, c.height - 1);
}
$('btnRunRes').onclick = () => { if (!sim.finished) { cursor = -1; running = false; $('btnRun').textContent = '▶ Start'; sim.run(); } renderResults(); };
$('btnTests').onclick = () => { if (!sim.finished) { sim.run(); renderResults(); } const out = runSelfTests(); const el = $('testOut') || $('resBody'); el.insertAdjacentHTML('beforeend', `<h2>BRD self-tests</h2>${out.map(t => `<div>${tag(t.ok)} <b>${t.id}</b> ${esc(t.text)}${t.detail ? ` <span class="small">${esc(t.detail)}</span>` : ''}</div>`).join('')}`); };

// ---------- self tests ----------
function blankCfg() { const c = defaultConfig(); c.profile = c.profile.map(() => [0, 0, 0]); c.run.days = 1; return c; }
function runSelfTests() {
  const T = [], add = (id, text, ok, detail) => T.push({ id, text, ok, detail });
  let c = blankCfg(), s = new Sim(c).run();
  add('T01', 'Zero demand: no movements, no dwell, stock unchanged', s.ledger.length === 0 && s.dwell.length === 0 && s.areas.S8.stock === 10000 && s.result.kpi.maxBacklog === 0);
  c = blankCfg(); c.profile[5] = [0, 200, 0]; s = new Sim(c).run();
  add('T02', 'Below capacity: no shared-resource backlog', s.maxBL.tot === 0, `max backlog ${s.maxBL.tot}`);
  c = blankCfg(); c.profile[5] = [0, 416, 0]; c.profile[6] = [0, 208, 0]; s = new Sim(c).run();
  add('T03', '05:00 peak: 260 served in hour 1, 156 remain as F9 backlog in S8', s.hours[5].F9 === 260 && s.hours[5].blF9 === 156, `served ${s.hours[5].F9}, backlog ${s.hours[5].blF9}`);
  add('T04', 'Next hour: 156 old backlog served first; 104 remain', s.hours[6].blF9 === 104, `backlog ${s.hours[6].blF9}`);
  c = blankCfg(); c.areas.S6.init = 30; c.profile[0] = [0, 30, 30]; s = new Sim(c).run();
  const order = []; s.qledger.filter(q => ['F7', 'F9', 'F7R'].includes(q.stage)).forEach(q => { if (order[order.length - 1] !== q.stage) order.push(q.stage); });
  add('T05', 'Tie-break at equal ready time: F7 → F9 → F7-REPL', order.join('>') === 'F7>F9>F7R', order.join(' > '));
  c = blankCfg(); c.profile[5] = [0, 0, 400]; s = new Sim(c).run();
  add('T06/T07', 'Replenishment S8 → F7-REPL → S10/S6 → F17 → S11: all 400 reach S11, S8 loses 400, S10/S6 end empty', s.areas.S11.stock === 400 && s.areas.S8.stock === 9600 && s.areas.S10.stock === 0 && s.areas.S6.stock === 0 && s.completed.REP === 400);
  add('T08', 'Split 50/50: S10 and S6 each receive 200 from F7-REPL', s.areas.S10.inflow === 200 && s.areas.S6.inflow === 200, `S10 in ${s.areas.S10.inflow}, S6 in ${s.areas.S6.inflow}`);
  c = blankCfg(); c.profile[5] = [0, 416, 100]; s = new Sim(c).run();
  add('T13', 'F7-REPL shares the 260/h pool with F9 (F9 + F7-REPL in hour 05 ≤ 260)', s.hours[5].F9 + s.hours[5].F7R === 260, `F9 ${s.hours[5].F9} + F7-REPL ${s.hours[5].F7R}`);
  c = blankCfg(); c.profile[5] = [0, 0, 400]; c.proc.F17.n = 1; s = new Sim(c).run();
  add('T14', 'F17 is its own process (not in the pool): limited by its headcount, pallets wait in S6/S10 meanwhile', s.hours.every(h => h.F17 <= c.proc.F17.prod + 1) && s.areas.S6.peak > 0 && s.areas.S11.stock === 400, `F17 max/h ${Math.max(...s.hours.map(h => h.F17))}, S6 peak ${s.areas.S6.peak}`);
  c = defaultConfig(); c.run.days = 2; s = new Sim(c).run(); const pe = peopleSummary(s);
  add('T15', `People: the shared pool never needs more than ceil(${poolCap(c)} ÷ ${c.proc.F7.prod}) = ${poolInfo(c).needed} people; F17 uses F5's ${c.proc.F5.prod}/h`, pe.A.byProc.POOL.peak <= poolInfo(c).needed && c.proc.F17.prod === c.proc.F5.prod && c.proc.F7R.prod === c.proc.F7.prod, `pool peak ${pe.A.byProc.POOL.peak}`);
  c = defaultConfig(); const capOk = ['F1', 'F2', 'F3', 'F5', 'F11', 'F13', 'F14', 'F17'].every(id => new Sim(c).rate(id) <= c.flowCap);
  c.proc.F11.n = 100; c.proc.F14.n = 50; const capHuge = new Sim(c).rate('F11') === c.flowCap && new Sim(c).rate('F14') === c.flowCap;
  add('T16', 'No flow can exceed the design capacity: defaults are within 260/h, and 100 people on F11 are still capped at 260/h', capOk && capHuge, `F11 default ${new Sim(defaultConfig()).rate('F11')}/h`);
  c = blankCfg(); c.profile[5] = [0, 416, 0]; s = new Sim(c).run();
  add('T17', 'F11 (7 people = 238/h) is slower than F9 (260/h): S10 builds up at the 05:00 peak instead of staying empty', s.areas.S10.peak > 20 && s.areas.S10.peak <= 180, `S10 peak ${s.areas.S10.peak} at ${clock(s.areas.S10.peakT)}`);
  c = defaultConfig(); c.proc.F11.mode = 'capacity'; c.proc.F11.capacity = 200; let fc = flowCapacity(c, 'F11');
  add('T18', 'Define a flow by capacity: F11 = 200 pallets/h gives ceil(200 ÷ 34) = 6 people needed and runs at 200/h', fc.effective === 200 && fc.needed === 6 && new Sim(c).rate('F11') === 200, `capacity ${fc.effective}/h, people needed ${fc.needed}`);
  c.proc.F11.capacity = 500; fc = flowCapacity(c, 'F11');
  add('T19', 'A capacity entered above the single-flow maximum is capped (500 → 260)', fc.capped && fc.effective === c.flowCap && new Sim(c).rate('F11') === c.flowCap, `effective ${fc.effective}/h`);
  c = blankCfg(); c.shared.mode = 'people'; c.shared.people = 10; c.profile[5] = [0, 416, 0]; s = new Sim(c).run();
  add('T20', 'Pool defined by people: 10 people × 30 = 300 pallets/h; the 05:00 peak serves 300 and leaves 116', poolCap(c) === 300 && s.hours[5].F9 === 300 && s.hours[5].blF9 === 116, `served ${s.hours[5].F9}, backlog ${s.hours[5].blF9}`);
  c = blankCfg(); c.shared.cap = 320; c.profile[5] = [0, 416, 0]; s = new Sim(c).run();
  add('T21', 'Pool capacity is a variable: 320 pallets/h serves 320 and leaves 96 at the 05:00 peak', s.hours[5].F9 === 320 && s.hours[5].blF9 === 96, `served ${s.hours[5].F9}, backlog ${s.hours[5].blF9}`);
  c = defaultConfig(); c.flowCap = 200;
  add('T22', 'Single-flow maximum is a variable: with 200 pallets/h, F2 (248 by people) is capped at 200 while the pool stays 260', new Sim(c).rate('F2') === 200 && new Sim(c).rate('F7') === 260, `F2 ${new Sim(c).rate('F2')}/h, pool ${new Sim(c).rate('F7')}/h`);
  c = blankCfg(); c.profile[4] = [50, 0, 0]; s = new Sim(c).run(); const inRows = s.dwell.filter(d => d.flow === 'IN'), avgLead = inRows.reduce((a, d) => a + d.lead * d.qty, 0) / inRows.reduce((a, d) => a + d.qty, 0);
  add('T23', 'Cycle time: inbound lead time (F1 → S8) is positive and the average does not exceed the maximum', inRows.length > 0 && avgLead > 0 && avgLead <= Math.max(...inRows.map(d => d.lead)), `average ${dur(avgLead)}`);
  s = new Sim(defaultConfig()).run(); add('T09', 'Baseline S8 initial stock 10,000: no stock starvation', s.stockStarveMin === 0 && s.areas.S8.init === 10000);
  c = blankCfg(); c.areas.S8.init = 100; c.profile[5] = [0, 416, 0]; c.profile[8] = [250, 0, 0]; s = new Sim(c).run();
  add('T10', 'Insufficient S8: stock-starvation wait is separated from capacity wait', s.result.dwell.OUT.stock > 0, `stock-wait ${Math.round(s.result.dwell.OUT.stock)} pallet-min`);
  c = defaultConfig(); c.control.inbound = 1900; const v = validateConfig(c);
  add('T11', 'Control-total mismatch raises a warning', v.warnings.some(w => w.includes('mismatch')));
  c = blankCfg(); c.profile[5] = [0, 10000, 0]; c.run.drainHours = 1; s = new Sim(c).run();
  add('T12', 'End-of-horizon: residual backlog is reported explicitly', !s.drained && s.result.residual.total > 0 && s.result.capacityVerdict === 'FAIL', `residual ${s.result.residual.total}`);
  c = defaultConfig(); const a = JSON.stringify(new Sim(c).run().result.kpi), b = JSON.stringify(new Sim(c).run().result.kpi);
  add('AC-011', 'Identical deterministic inputs give identical outputs', a === b);
  c = defaultConfig(); s = new Sim(c).run(); add('AC-001/007/012', 'Baseline: balances, no negative stock, no lost pallets', s.result.checks.filter(k => ['AC-001', 'AC-007', 'AC-012'].includes(k.id)).every(k => k.ok));
  return T;
}

// ---------- ledgers ----------
const LEDGER_DEFS = {
  events: { h: ['Timestamp', 'Cohort', 'Flow', 'Process', 'Area', 'Δ qty', 'Stock before', 'Stock after'], rows: () => sim.ledger.map(e => [clock(e.t), e.cohort, e.flow, e.proc, e.area, e.delta, e.before, e.after]) },
  queue: { h: ['Stage', 'Cohort', 'Flow', 'Request time', 'Ready', 'Service start', 'Completion', 'Qty', 'Wait (min)', 'Stock wait (min)', 'Blocked wait (min)', 'Queue position'], rows: () => sim.qledger.map(q => [q.stage, q.cohort, q.flow, clock(q.reqTime), clock(q.ready), clock(q.start), clock(q.done), q.qty, +q.wait.toFixed(2), +q.stockWait.toFixed(2), +q.blockWait.toFixed(2), q.pos]) },
  dwell: { h: ['Flow', 'Cohort', 'Request/arrival', 'Completion', 'Qty', 'Lead time (min)', 'Productive (min)', 'Additional dwell (min)', 'Capacity wait', 'Stock wait', 'Blocked wait'], rows: () => sim.dwell.map(d => [d.flow, d.cohort, clock(d.origin), clock(d.done), d.qty, +d.lead.toFixed(2), +d.prod.toFixed(2), +d.wait.toFixed(2), +d.capW.toFixed(2), +d.stockW.toFixed(2), +d.blockW.toFixed(2)]) },
};
function renderLedger() {
  const def = LEDGER_DEFS[$('ledWhich').value], f = $('ledFilter').value.trim().toLowerCase(); const rows = def.rows(); const out = []; let total = 0;
  for (const r of rows) { if (f && !r.join(' ').toLowerCase().includes(f)) continue; total++; if (out.length < 1000) out.push(r); }
  $('ledNote').textContent = `${total.toLocaleString('en-GB')} matching rows (showing first ${out.length}). ${sim.ledgerTruncated ? 'Ledger limit reached; truncated.' : ''}`;
  $('ledTable').innerHTML = `<table><tr>${def.h.map(x => `<th>${x}</th>`).join('')}</tr>${out.map(r => `<tr>${r.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</table>`;
}
$('ledWhich').onchange = renderLedger; $('ledFilter').oninput = renderLedger;
document.querySelectorAll('[data-csv]').forEach(b => b.onclick = () => {
  const k = b.dataset.csv; if (k === 'people') { if (!sim.finished) sim.run(); download(`${cfg.scenarioId}_people.csv`, peopleCsv()); return; } let h, rows;
  if (LEDGER_DEFS[k]) { h = LEDGER_DEFS[k].h; rows = LEDGER_DEFS[k].rows(); }
  else if (k === 'hourly') { const hc = hourlyColumns(); h = ['hour', 'new_in', 'new_out', 'new_repl', ...hc.map(c => c.csv), 'pool_total', 'backlog_F7', 'backlog_F9_F7R', 'done_in', 'done_out', 'max_dwell_in_min', 'max_dwell_out_min']; rows = sim.hours.map(x => [clock(x.abs * 60), x.newIn, x.newOut, x.newRep, ...hc.map(c => c.val(x)), x.F7 + x.F9 + x.F7R, x.blF7, x.blF9, x.doneIn, x.doneOut, +x.maxDwellIn.toFixed(2), +x.maxDwellOut.toFixed(2)]); }
  else { const r = sim.result || summarize(sim); h = ['area', 'opening', 'inflow', 'outflow', 'closing', 'peak', 'peak_time', 'capacity', 'breach', 'excess']; rows = r.areas.map(a => [a.id, a.opening, a.inflow, a.outflow, a.closing, a.peak, clock(a.peakT), a.cap === Infinity ? '' : a.cap, a.breach, a.excess]); }
  download(`${cfg.scenarioId}_${k}.csv`, csvOf(h, rows));
});

// ---------- scenarios ----------
const store = { get: () => { try { return JSON.parse(localStorage.getItem('whsim.scenarios') || '{}'); } catch (e) { return {}; } }, set: o => { try { localStorage.setItem('whsim.scenarios', JSON.stringify(o)); } catch (e) { alert('Could not save: ' + e.message); } } };
function renderScenarios() {
  const all = store.get(), names = Object.keys(all);
  $('scList').innerHTML = names.length ? `<table>${names.map(n => `<tr><td class="l">${esc(n)}</td><td><button class="b" data-a="load" data-n="${esc(n)}">Load</button> <button class="b" data-a="dup" data-n="${esc(n)}">Duplicate</button> <button class="b" data-a="del" data-n="${esc(n)}">Delete</button></td></tr>`).join('')}</table>` : '<span class="small">No saved scenarios yet.</span>';
  const opts = ['<option value="__current">(current inputs)</option>', ...names.map(n => `<option>${esc(n)}</option>`)].join(''); $('cmpA').innerHTML = opts; $('cmpB').innerHTML = opts; if (names.length) $('cmpB').value = names[0];
  $('scList').querySelectorAll('button').forEach(b => b.onclick = () => {
    const a = store.get(), n = b.dataset.n; const name = n.replace(/&amp;/g, '&');
    if (b.dataset.a === 'load') { cfg = mergeCfg(defaultConfig(), JSON.parse(JSON.stringify(a[name]))); buildInputs(); resetSim(); showTab('live'); }
    if (b.dataset.a === 'dup') { a[name + ' (copy)'] = a[name]; store.set(a); renderScenarios(); }
    if (b.dataset.a === 'del') { delete a[name]; store.set(a); renderScenarios(); }
  });
}
$('scSave').onclick = () => { const n = $('scName').value.trim() || cfg.scenarioId; const a = store.get(); a[n] = JSON.parse(JSON.stringify(cfg)); store.set(a); renderScenarios(); };
function flat(o, p = '', out = {}) { for (const k in o) { const v = o[k], key = p ? `${p}.${k}` : k; if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, key, out); else if (Array.isArray(v)) v.forEach((x, i) => Array.isArray(x) ? x.forEach((y, j) => out[`${key}[${pad(i)}:00].${['in', 'out', 'rep'][j]}`] = y) : out[`${key}[${i}]`] = x); else out[key] = v; } return out; }
$('cmpGo').onclick = () => {
  const all = store.get(), get = n => n === '__current' ? JSON.parse(JSON.stringify(cfg)) : mergeCfg(defaultConfig(), all[n.replace(/&amp;/g, '&')]);
  const A = get($('cmpA').value), B = get($('cmpB').value), fa = flat(A), fb = flat(B); const diffs = Object.keys(Object.assign({}, fa, fb)).filter(k => k !== 'scenarioId' && fa[k] !== fb[k]);
  const ra = new Sim(A).run().result.kpi, rb = new Sim(B).run().result.kpi; const keys = ['capacityVerdict', 'maxBacklog', 'maxBacklogF7', 'maxBacklogF9', 'endingBacklog', 'maxDwellIn', 'maxDwellOut', 'p95In', 'p95Out', 'breaches', 'recovery'];
  const fmt = (k, v) => typeof v === 'number' ? (/Dwell|p95|recovery/.test(k) ? dur(v) : num(v)) : v;
  // signed difference (B minus A): keeps the sign, so decreases are no longer shown as 0
  const sd = (k, d) => { const a = Math.abs(d); if (a < 1e-9) return '0'; const body = /Dwell|p95|recovery/.test(k) ? (a < 1 ? '<1 min' : dur(a)) : num(a); return (d > 0 ? '+' : '−') + body; };
  $('cmpOut').innerHTML = `<h2>Input deltas (${diffs.length})</h2><div class="scroll" style="max-height:200px"><table><tr><th>Input</th><th>A</th><th>B</th></tr>${diffs.map(k => `<tr><td>${esc(k)}</td><td>${esc(fa[k])}</td><td>${esc(fb[k])}</td></tr>`).join('')}</table></div>
    <h2>KPI deltas</h2><table><tr><th>KPI</th><th>A</th><th>B</th><th>Δ</th></tr>${keys.map(k => `<tr><td>${k}</td><td>${fmt(k, ra[k])}</td><td>${fmt(k, rb[k])}</td><td>${typeof ra[k] === 'number' ? sd(k, rb[k] - ra[k]) : ra[k] === rb[k] ? '–' : 'changed'}</td></tr>`).join('')}${AREA_IDS.map(a => `<tr><td>peak ${a}</td><td>${num(ra.peaks[a])}</td><td>${num(rb.peaks[a])}</td><td>${sd('peak', rb.peaks[a] - ra.peaks[a])}</td></tr>`).join('')}</table>`;
};
$('sensGo').onclick = () => {
  const caps = $('sensCap').value.split(',').map(Number).filter(v => v >= 0), s8 = $('sensS8').value.split(',').map(Number).filter(v => v >= 0); const rows = [];
  for (const cp of caps) for (const st of s8) { const c = JSON.parse(JSON.stringify(cfg)); c.shared.mode = 'capacity'; c.shared.cap = cp; c.areas.S8.init = st; const s = new Sim(c, { maxLedger: 0 }).run(), k = s.result.kpi; rows.push([cp, st, k.capacityVerdict, k.maxBacklog, k.endingBacklog, k.maxDwellIn, k.maxDwellOut, k.breaches, k.peaks.S6, k.recovery]); }
  $('sensOut').innerHTML = `<table><tr><th>Pool/h</th><th>S8 initial</th><th>Verdict</th><th>Max backlog</th><th>Ending backlog</th><th>Max inbound dwell</th><th>Max outbound dwell</th><th>Breaches</th><th>S6 peak</th><th>Recovery</th></tr>${rows.map(r => `<tr><td>${r[0]}</td><td>${num(r[1])}</td><td>${r[2]}</td><td>${num(r[3])}</td><td>${num(r[4])}</td><td>${dur(r[5])}</td><td>${dur(r[6])}</td><td>${r[7]}</td><td>${num(r[8])}</td><td>${dur(r[9])}</td></tr>`).join('')}</table>`;
};

// ---------- cycle times, hourly dashboard (operation order), snapshot ----------
// cycle time = elapsed time incl. processing: inbound F1 arrival -> entry into S8 (F7 done); outbound request at S8 -> F14 done
function cycleStats(tLimit) {
  const o = { IN: { last: null, sum: 0, q: 0 }, OUT: { last: null, sum: 0, q: 0 } };
  for (const d of sim.dwell) { if (d.done > tLimit) continue; const e = o[d.flow]; if (!e) continue; e.last = d.lead; e.sum += d.lead * d.qty; e.q += d.qty; }
  return o;
}
// columns follow the operation order: F1 F2 F3 S4 F5 S6 F7 S8 F9 S10 F11 S12 F13 F14, then the replenishment branch F7-REPL F17 S11
// utilisation highlighting: red when a stock area or a flow is above the threshold (Inputs tab, default 90%) of its capacity in the hour
const HOT_STYLE = 'background:#f5b5b0;color:#912018;font-weight:600';
const hotLimit = () => (cfg.highlightPct === undefined ? 90 : Number(cfg.highlightPct) || 0) / 100;   // threshold from the Inputs tab (percent of capacity)
function hourlyColumns() {
  const poolU = x => { const c = poolCap(cfg); return c > 0 ? (x.F7 + x.F9 + x.F7R) / c : 0; };
  // flow: pallets completed in the hour / (capacity pallets/h x 1 h). F7, F9 and F7-REPL share the pool, so they are red when the pool is above 90% and they worked.
  const flow = id => {
    const pool = id === 'F7' || id === 'F9' || id === 'F7R', cap = pool ? 0 : sim.rate(id);
    const hot = x => pool ? ((x[id] || 0) > 0 && poolU(x) > hotLimit()) : (cap > 0 && isFinite(cap) && (x[id] || 0) / cap > hotLimit());
    return { id, type: 'flow', head: id === 'F7R' ? 'F7-REPL' : id, csv: id === 'F7R' ? 'F7_REPL' : id, val: x => x[id] || 0, cell: x => `<td${hot(x) ? ` style="${HOT_STYLE}"` : ''}>${x[id] || 0}</td>` };
  };
  // stock: red when the event-level peak inside the hour was above the threshold of the capacity (the peak is the only rule)
  const stock = id => ({ id, type: 'stock', head: id, csv: id, val: x => x.stock[id], cell: x => {
    const cap = cfg.areas[id] ? cfg.areas[id].cap : 0; let st = '';
    if (id !== 'S11' && cap > 0 && x.peak[id] / cap > hotLimit()) st = HOT_STYLE;
    return `<td${st ? ` style="${st}"` : ''}>${num(x.stock[id])}${id !== 'S11' ? `<span class="small"> /${num(x.peak[id])}</span>` : ''}</td>`; } });
  return [flow('F1'), flow('F2'), flow('F3'), stock('S4'), flow('F5'), stock('S6'), flow('F7'), stock('S8'), flow('F9'), stock('S10'), flow('F11'), stock('S12'), flow('F13'), flow('F14'), flow('F7R'), flow('F17'), stock('S11')];
}
function hourlyDashboardHtml() {
  const cols = hourlyColumns(), cap = poolCap(cfg);
  let h = '<div class="card"><h3>Hourly dashboard (columns in operation order)</h3><div class="scroll" style="max-height:440px"><table><tr><th>Hour</th><th>New in</th><th>New out</th><th>New repl.</th>' +
    cols.map(c => `<th class="${c.type === 'flow' ? 'flowh' : 'stockh'}">${c.head}</th>`).join('') + '<th>Pool F7+F9+F7-REPL</th><th>Backlog F7</th><th>Backlog F9+REPL</th><th>Done in</th><th>Done out</th><th>Max dwell in</th><th>Max dwell out</th></tr>';
  sim.hours.forEach(x => {
    const pool = x.F7 + x.F9 + x.F7R;
    h += `<tr><td>${clock(x.abs * 60)}</td><td>${x.newIn}</td><td>${x.newOut}</td><td>${x.newRep}</td>${cols.map(c => c.cell(x)).join('')}<td${pool / cap > hotLimit() ? ` style="${HOT_STYLE}"` : ''}>${pool}</td><td${x.blF7 ? ' style="background:#fef0c7"' : ''}>${x.blF7}</td><td${x.blF9 ? ' style="background:#fef0c7"' : ''}>${x.blF9}</td><td>${x.doneIn}</td><td>${x.doneOut}</td><td>${dur(x.maxDwellIn)}</td><td>${dur(x.maxDwellOut)}</td></tr>`;
  });
  return h + '</table></div><div class="small">Blue headers = flows (pallets completed in the hour), green headers = stock areas (hour-end stock / event-level peak inside the hour). Order: F1 F2 F3 S4 F5 S6 F7 S8 F9 S10 F11 S12 F13 F14, then the replenishment branch F7-REPL F17 S11. <b>Red</b> = above ' + Math.round(hotLimit() * 100) + '% of capacity (threshold set on the Inputs tab): a stock area when its event-level peak inside the hour was above the threshold of its capacity, a flow when the pallets completed in the hour are above the threshold of its hourly capacity, the pool column (and the F7, F9, F7-REPL cells that worked) when F7 + F9 + F7-REPL is above the threshold of the pool capacity. Amber = backlog waiting at the pool.</div></div>';
}
function snapT() { return ((+$('snapDay').value || 1) - 1) * 1440 + (+$('snapTime').value); }
function setSnapT(t) { t = Math.max(0, t); $('snapDay').value = Math.floor(t / 1440) + 1; $('snapTime').value = Math.floor(t % 1440); renderSnapshot(); }
function renderSnapshot() {
  const c = $('diagSnap'); if (!c) return;
  const t = snapT(), x = fit(c, LW, LH_STATIC); x.clearRect(0, 0, LW, LH_STATIC); $('snapClock').textContent = clock(t);
  const idx = Math.round(t / cfg.run.stepMin) - 1;
  txt(x, '◄ EAST — INBOUND', 12, 28, 13, COL.blue, 'left', true); txt(x, 'WEST — OUTBOUND ►', LW - 12, 28, 13, COL.green, 'right', true); txt(x, 'MAIN STORAGE', L.S8.cx, 28, 13, COL.teal, 'center', true);
  if (!sim.hist.length || idx >= sim.hist.length) {
    $('snapMsg').textContent = 'The simulation has not reached this time yet — press "Run simulation to end" (or run it on the Live tab).';
    txt(x, 'No data for this time yet', LW / 2, LH_STATIC / 2, 18, COL.mute, 'center', true); return;
  }
  $('snapMsg').textContent = '';
  const S = snapAt(idx), pk = peaksUpTo(idx);
  txt(x, `${clock(S.t)} — static stock & flow`, LW / 2, 62, 15, COL.ink, 'center', true);
  txt(x, 'Stock = pallets in the area at this moment · flow boxes: Q = pallets waiting, "/h done" = pallets completed in the previous 60 min, ppl = people needed for that work', LW / 2, 82, 11, COL.mute, 'center');
  drawBase(x, snapSpec(S, pk, false));
  const pi = poolInfo(cfg); txt(x, `Shared pool F7 + F9 + F7-REPL: ${num(S.w.F7 + S.w.F9 + S.w.F7R)} of ${num(pi.effective)} pallets/h used in the last 60 min · people needed in total: ${fp(S.pplTotal)}`, LW / 2, LH_STATIC - 12, 12, COL.orange, 'center', true);
}
$('snapDay').oninput = renderSnapshot; $('snapTime').oninput = renderSnapshot; $('pplMode').addEventListener('change', () => { if ($('tab-snap').classList.contains('on')) renderSnapshot(); });
$('snapPrev').onclick = () => setSnapT(snapT() - 60); $('snapNext').onclick = () => setSnapT(snapT() + 60);
$('snapNow').onclick = () => setSnapT(sim.t); $('snapRun').onclick = () => { if (!sim.finished) { running = false; $('btnRun').textContent = '▶ Start'; cursor = -1; sim.run(); } renderSnapshot(); };
// ---------- boot ----------
buildInputs(); resetSim(); requestAnimationFrame(frame);
(function () { // optional deep-link for demos/tests: #run=<minutes>&tab=<id>&end
  const q = new URLSearchParams(location.hash.slice(1)); if (q.has('run')) { advance(+q.get('run')); cursor = -1; } if (q.has('end')) sim.run(); if (q.has('tab')) showTab(q.get('tab')); if (q.has('tests')) $('btnTests').click(); if (q.has('scroll')) setTimeout(() => window.scrollTo(0, +q.get('scroll')), 50);
})();
window.__app = { get sim() { return sim; }, get cfg() { return cfg; }, runSelfTests };


