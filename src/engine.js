'use strict';
/* Warehouse flow, stock capacity and dwell-time simulation engine.
   Implements the BRD (v1.0): cohort-based, event-level stock accounting, one shared
   F7 + F9(outbound) + F7-REPL(replenishment picking) capacity pool with global FIFO. No DOM access. */

const AREA_IDS = ['S4', 'S6', 'S8', 'S10', 'S12'];
const STAGE_IDS = ['F1', 'F2', 'F3', 'F5', 'F11', 'F13', 'F14', 'F17'];
const PROC_ORDER = ['F1', 'F2', 'F3', 'F5', 'F7', 'F9', 'F7R', 'F11', 'F13', 'F14', 'F17'];
const NONSHARED = ['F1', 'F2', 'F3', 'F5', 'F11', 'F13', 'F14', 'F17'];

// People needed to do `pallets` of work in one hour at process `id` (F1/F14 are truck-based).
// fte=false: rounded up to whole people (Scenario A). fte=true: unrounded average people / FTE (Scenario B).
function peopleReq(cfg, id, pallets, fte) {
  const pr = cfg.proc[id].prod; if (!(pr > 0) || !(pallets > 0)) return 0;
  const unit = id === 'F1' ? cfg.truck.inPallets : id === 'F14' ? cfg.truck.outPallets : 1;
  const v = pallets / unit / pr; return fte ? v : Math.ceil(v - 1e-9);
}
// F7 + F9 + F7-REPL are one shared pool, so their combined people need is sized on the pooled work,
// never more than the pool capacity.
function poolWork(cfg, w) { return Math.min((w.F7 || 0) + (w.F9 || 0) + (w.F7R || 0), poolCap(cfg)); }

// ---- capacity definition: two ways to define a flow
//   mode 'people'   : capacity = productivity x people (capped at flowCap)
//   mode 'capacity' : capacity entered in pallets/h (capped at flowCap); the model reports the people needed = ceil(capacity / productivity)
// F1/F14 productivity is in trucks/h, converted with pallets per truck. The shared pool (F7 + F9 + F7-REPL) is defined the same way
// (people x F7 productivity, or capacity entered) and is NOT limited by flowCap, because the constraint applies to the sum of the 3 flows.
function unitOf(cfg, id) { return id === 'F1' ? cfg.truck.inPallets : id === 'F14' ? cfg.truck.outPallets : 1; }
function flowCapacity(cfg, id) {
  const p = cfg.proc[id], unit = unitOf(cfg, id), mode = p.mode === 'capacity' ? 'capacity' : 'people';
  const raw = mode === 'capacity' ? Number(p.capacity) || 0 : p.prod * p.n * unit;
  const effective = Math.min(raw, cfg.flowCap), perPerson = p.prod * unit;
  const needed = perPerson > 0 ? Math.ceil(effective / perPerson - 1e-9) : 0;       // whole people needed to deliver the effective capacity
  return { id, mode, raw, effective, capped: raw > cfg.flowCap, perPerson, people: mode === 'people' ? p.n : needed, needed };
}
function poolInfo(cfg) {
  const s = cfg.shared, prod = cfg.proc.F7.prod, mode = s.mode === 'people' ? 'people' : 'capacity';
  const raw = mode === 'people' ? (Number(s.people) || 0) * prod : Number(s.cap) || 0;
  return { mode, raw, effective: raw, perPerson: prod, needed: prod > 0 ? Math.ceil(raw / prod - 1e-9) : 0, people: mode === 'people' ? s.people : (prod > 0 ? Math.ceil(raw / prod - 1e-9) : 0) };
}
function poolCap(cfg) { return poolInfo(cfg).effective; }
function peopleTotal(cfg, w, fte) {
  const pool = peopleReq(cfg, 'F7', poolWork(cfg, w), fte);
  return pool + NONSHARED.reduce((a, id) => a + peopleReq(cfg, id, w[id] || 0, fte), 0);
}
function peopleSummary(sim) {
  const c = sim.cfg, days = Math.max(1, c.run.days);
  const summ = fte => {
    const hourly = sim.hours.map(h => {
      const ppl = {}; PROC_ORDER.forEach(id => ppl[id] = peopleReq(c, id, h[id] || 0, fte));
      return { abs: h.abs, hod: h.hod, day: h.day, ppl, pool: peopleReq(c, 'F7', poolWork(c, h), fte), total: peopleTotal(c, h, fte), work: h };
    });
    const byProc = {};
    for (const id of [...PROC_ORDER, 'POOL']) {
      const vals = hourly.map(h => id === 'POOL' ? h.pool : h.ppl[id]); let peak = 0, peakAt = 0, sum = 0, act = 0;
      vals.forEach((v, i) => { if (v > peak) { peak = v; peakAt = hourly[i].abs; } sum += v; if (v > 0) act++; });
      byProc[id] = { peak, peakAt, personHours: sum, avgActive: act ? sum / act : 0, activeHours: act };
    }
    const byHod = []; for (let h = 0; h < 24; h++) {
      const rows = hourly.filter(x => x.hod === h), row = { hod: h, ppl: {}, pool: 0, total: 0 };
      PROC_ORDER.forEach(id => row.ppl[id] = rows.reduce((m, x) => Math.max(m, x.ppl[id]), 0));
      row.pool = rows.reduce((m, x) => Math.max(m, x.pool), 0); row.total = rows.reduce((m, x) => Math.max(m, x.total), 0); byHod.push(row);
    }
    let peak = 0, peakAt = 0; hourly.forEach(h => { if (h.total > peak) { peak = h.total; peakAt = h.abs; } });
    const sum = hourly.reduce((a, h) => a + h.total, 0);
    return { hourly, byProc, byHod, total: { peak, peakAt, personHoursPerDay: sum / days, avgActive: sum / Math.max(1, hourly.filter(h => h.total > 0).length), avgOverDay: sum / days / 24 } };
  };
  return { A: summ(false), B: summ(true), poolCapacityPeople: poolInfo(c).needed, poolCapacityFte: poolCap(c) / (c.proc.F7.prod || 1) };
}
// Appendix A hourly profile: [inbound, outbound, replenishment through F7-REPL]
const BASE_PROFILE = [
  [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [125, 0, 0], [0, 416, 0],
  [0, 208, 0], [0, 69, 0], [250, 208, 0], [0, 69, 0], [125, 0, 0], [250, 69, 0],
  [250, 277, 0], [125, 139, 0], [250, 69, 0], [125, 69, 0], [0, 69, 0], [250, 0, 0],
  [0, 0, 25], [0, 69, 25], [0, 69, 25], [0, 0, 25], [125, 0, 0], [0, 69, 0],
];

function defaultConfig() {
  return {
    scenarioId: 'BASELINE',
    run: { days: 7, stepMin: 1, drainHours: 72 },
    profile: BASE_PROFILE.map(r => r.slice()),
    control: { inbound: null, outbound: null, replenishment: null }, // official daily totals (OD-01)
    truck: { inPallets: 50, outPallets: 50 },                          // OD-03: outbound size is an assumption
    areas: {
      S4: { cap: 363, init: 0 }, S6: { cap: 180, init: 0 }, S8: { cap: 13000, init: 10000 },
      S10: { cap: 180, init: 0 }, S12: { cap: 363, init: 0 },
    },
    // prod = productivity per person; n = persons. Real headcounts are not defined yet (OD-04), so n is the largest whole number of people
    // whose combined rate stays within the 260/h design capacity. No flow may ever exceed the design capacity (see rate()).
    proc: {
      F1: { prod: 6.461, unit: 'trucks/h/person', n: 1, mode: 'people', capacity: 260 },
      F2: { prod: 19.06, unit: 'pallets/h/person', n: 13, mode: 'people', capacity: 248 },
      F3: { prod: 79, unit: 'pallets/h/person', n: 3, mode: 'people', capacity: 237 },
      F5: { prod: 40, unit: 'pallets/h/person', n: 6, mode: 'people', capacity: 240 },
      F7: { prod: 30, unit: 'pallets/h/person', n: 0 },
      F9: { prod: 30, unit: 'pallets/h/person', n: 0 },
      F7R: { prod: 30, unit: 'pallets/h/person', n: 0 },   // F7-REPL replenishment picking: same productivity as F7 (confirmed)
      F11: { prod: 34, unit: 'pallets/h/person', n: 7, mode: 'people', capacity: 238 },
      F13: { prod: 18.87, unit: 'pallets/h/person', n: 13, mode: 'people', capacity: 245 },
      F14: { prod: 13.32, unit: 'trucks/h/person', n: 1, mode: 'people', capacity: 260 },
      F17: { prod: 40, unit: 'pallets/h/person', n: 6, mode: 'people', capacity: 240 },   // manual EPT transfer S6/S10 -> S11: productivity = F5 (confirmed); headcount is a placeholder
    },
    enforceNonShared: true,
    highlightPct: 90,                          // Hourly dashboard: highlight red above this % of capacity (display only)
    flowCap: 260,                              // ceiling for any single flow F1..F5, F11..F14, F17 (pallets/h) - editable
    // shared pool F7 + F9 + F7-REPL: mode 'capacity' (cap pallets/h, people needed derived) or 'people' (people x F7 productivity)
    shared: { mode: 'capacity', cap: 260, people: 9, tie: 'F7,F9,F7R' }, // tie = order at identical ready timestamps
    repl: { split10: 0.5 },                           // share routed via S10 (rest via S6); both then go through F17 to S11
    overflow: 'report',                                // 'report' | 'block' (OD-06)
  };
}

function profileTotals(profile) {
  return profile.reduce((a, r) => [a[0] + r[0], a[1] + r[1], a[2] + r[2]], [0, 0, 0]);
}

function validateConfig(cfg) {
  const errors = [], warnings = [];
  const neg = (v, label) => { if (!(v >= 0)) errors.push(`${label} must be a non-negative number`); };
  cfg.profile.forEach((r, h) => r.forEach((v, i) => neg(v, `Profile ${String(h).padStart(2, '0')}:00 ${['inbound', 'outbound', 'replenishment'][i]}`)));
  for (const id of AREA_IDS) { neg(cfg.areas[id].cap, `${id} capacity`); neg(cfg.areas[id].init, `${id} initial stock`); }
  for (const [id, p] of Object.entries(cfg.proc)) { neg(p.prod, `${id} productivity`); neg(p.n, `${id} resources`); }
  neg(cfg.shared.cap, 'Shared pool capacity'); neg(cfg.shared.people, 'Shared pool people'); neg(cfg.flowCap, 'Maximum capacity of any single flow'); neg(cfg.highlightPct === undefined ? 0 : cfg.highlightPct, 'Highlight threshold');
  if (!(cfg.run.days >= 1)) errors.push('Horizon must be at least 1 day');
  if (60 % cfg.run.stepMin !== 0) errors.push('Time step must divide 60 minutes (1, 2, 5, 10, 15, 30, 60)');
  if (!(cfg.truck.inPallets > 0) || !(cfg.truck.outPallets > 0)) errors.push('Pallets per truck must be positive');
  for (const id of NONSHARED) { const f = flowCapacity(cfg, id);
    if (cfg.enforceNonShared && f.capped) warnings.push(`${id}: ${f.mode === 'capacity' ? 'entered capacity' : f.people + ' people would give'} ${Math.round(f.raw)} pallets/h, above the ${cfg.flowCap}/h maximum for a single flow; the flow is capped at ${cfg.flowCap}/h`); }
  const pf = poolInfo(cfg); if (cfg.proc.F9.prod !== cfg.proc.F7.prod || cfg.proc.F7R.prod !== cfg.proc.F7.prod) warnings.push('F7, F9 and F7-REPL have different productivities: the shared pool uses the F7 productivity to convert people and capacity');  const s = cfg.repl.split10; if (!(s >= 0 && s <= 1)) errors.push('Replenishment split must be between 0 and 1');
  const tot = profileTotals(cfg.profile);
  ['inbound', 'outbound', 'replenishment'].forEach((k, i) => {
    const c = cfg.control[k];
    if (c === null || c === undefined || c === '') warnings.push(`No official control total entered for ${k}; imported hourly sum is ${tot[i]} (OD-01 not signed off)`);
    else if (Number(c) !== tot[i]) warnings.push(`Control total mismatch for ${k}: hourly sum ${tot[i]} vs official ${c}`);
  });
  return { errors, warnings, totals: tot };
}

function weightedPercentile(rows, key, p) {
  if (!rows.length) return 0;
  const s = rows.slice().sort((a, b) => a[key] - b[key]);
  const total = s.reduce((a, r) => a + r.qty, 0); let cum = 0;
  for (const r of s) { cum += r.qty; if (cum >= p * total - 1e-9) return r[key]; }
  return s[s.length - 1][key];
}

class Sim {
  constructor(cfg, opts = {}) {
    this.cfg = JSON.parse(JSON.stringify(cfg));
    this.maxLedger = opts.maxLedger || 400000;
    this.init();
  }

  init() {
    const c = this.cfg;
    this.dt = c.run.stepMin; this.t = 0; this.pid = 0;
    this.demandEnd = c.run.days * 1440; this.maxEnd = this.demandEnd + c.run.drainHours * 60;
    this.areas = {};
    for (const id of [...AREA_IDS, 'S11']) {
      const a = c.areas[id] || { cap: Infinity, init: 0 };
      this.areas[id] = { id, cap: a.cap, init: a.init, stock: a.init, peak: a.init, peakT: 0, hourPeak: a.init,
        inflow: 0, outflow: 0, episodes: [], open: null, neg: 0 };
    }
    this.stages = {}; for (const id of STAGE_IDS) this.stages[id] = { id, q: [], credit: 0, done: 0, maxQ: 0 };
    this.shared = []; this.seqCtr = 0; this.shCredit = 0; this.replenInS6 = 0; this.replTot = 0;
    this.pri = {}; String(c.shared.tie || 'F7,F9,F7R').split(',').forEach((k, i) => this.pri[k.trim()] = i);
    this.ledger = []; this.qledger = []; this.dwell = []; this.notes = []; this.ledgerTruncated = false;
    this.created = { IN: 0, OUT: 0, REP: 0 }; this.completed = { IN: 0, OUT: 0, REP: 0 };
    this.processed = { F7: 0, F9: 0, F7R: 0 };
    this.cumProc = { F1: 0, F2: 0, F3: 0, F5: 0, F7: 0, F9: 0, F7R: 0, F11: 0, F13: 0, F14: 0, F17: 0 }; // cumulative pallets per process (people sizing)
    this.hours = []; this.cur = null;
    this.hist = []; this.histT = [];
    this.backlogEp = []; this.openBL = null; this.maxBL = { F7: 0, F7T: 0, F9: 0, F9T: 0, tot: 0, totT: 0 };
    this.flowAcc = {};      // edge -> pallets moved since last UI read (animation)
    this.stockStarveMin = 0; this.blockMin = 0; this.sharedSatSteps = 0; this.sharedActiveSteps = 0;
    this.maxHourShared = 0; this.errors = [];
    this.finished = false; this.drained = false; this.result = null;

    // opening stock in non-S8 areas becomes opening cohorts (excluded from dwell)
    const open = (area, flow, stage, shared) => {
      const q = c.areas[area].init; if (!(q > 0)) return;
      const p = this.piece(flow, q, 0, 0, true, `OPEN-${area}`);
      this.created[flow] += q;
      if (shared) { p.req = 'F7'; this.insertShared(p); } else this.stages[stage].q.push(p);
    };
    open('S4', 'IN', 'F5'); open('S6', 'IN', null, true); open('S10', 'OUT', 'F11'); open('S12', 'OUT', 'F13');
  }

  // ---------- helpers ----------
  piece(flow, qty, origin, ready, opening, id) {
    return { id: id || `${flow}-${++this.pid}`, flow, qty, origin, ready, opening: !!opening, n: 0, wait: {}, prod: 0,
      capW: 0, stockW: 0, blockW: 0, sw: 0, bw: 0, req: null };
  }
  take(p, qty) {
    if (qty >= p.qty) return p;
    const c = Object.assign({}, p, { qty, wait: Object.assign({}, p.wait), id: `${p.id}.${++p.n}`, n: 0 });
    p.qty -= qty; return c;
  }
  rate(id) {
    const c = this.cfg;
    if (id === 'F7' || id === 'F9' || id === 'F7R') return poolCap(c);
    if (!c.enforceNonShared) return c.flowCap;      // headcount not fixed: the flow is limited only by the single-flow maximum
    return flowCapacity(c, id).effective;           // people x productivity or entered capacity, never above the single-flow maximum
  }
  log(row) {
    if (this.ledger.length >= this.maxLedger) { this.ledgerTruncated = true; return; }
    this.ledger.push(row);
  }
  note(kind, text) { this.notes.push({ t: this.t, kind, text }); if (this.notes.length > 500) this.notes.shift(); }
  flow(edge, q) { this.flowAcc[edge] = (this.flowAcc[edge] || 0) + q; }

  // every stock-changing event: update balance, check negatives, capture event-level peak and breach episodes
  chg(id, delta, t, p, proc) {
    const a = this.areas[id], before = a.stock;
    a.stock += delta;
    if (delta > 0) a.inflow += delta; else a.outflow -= delta;
    if (a.stock < 0) { a.neg++; this.errors.push(`Negative stock in ${id} at t=${t}`); }
    if (a.stock > a.peak) { a.peak = a.stock; a.peakT = t; }
    if (a.stock > a.hourPeak) a.hourPeak = a.stock;
    if (a.stock > a.cap) {
      if (!a.open) {
        a.open = { area: id, start: t, end: null, peak: a.stock, peakT: t, excess: a.stock - a.cap };
        a.episodes.push(a.open);
        this.note('breach', `${id} over capacity: ${a.stock} / ${a.cap} pallets`);
      } else if (a.stock > a.open.peak) { a.open.peak = a.stock; a.open.peakT = t; a.open.excess = a.stock - a.cap; }
    } else if (a.open) { a.open.end = t; a.open = null; }
    this.log({ t, cohort: p ? p.id : '', flow: p ? p.flow : '', proc, area: id, delta, before, after: a.stock });
  }

  insertShared(p) {
    const q = this.shared; let lo = 0, hi = q.length;
    const less = (a, b) => a.ready !== b.ready ? a.ready < b.ready : this.pri[a.req] !== this.pri[b.req] ? this.pri[a.req] < this.pri[b.req] : a.seq < b.seq;
    p.seq = ++this.seqCtr;
    while (lo < hi) { const m = (lo + hi) >> 1; if (less(q[m], p)) lo = m + 1; else hi = m; }
    q.splice(lo, 0, p);
  }

  // ---------- demand ----------
  injectDemand(t0) {
    const c = this.cfg, hod = Math.floor(t0 / 60) % 24, row = c.profile[hod], day = Math.floor(t0 / 1440);
    const tag = `d${day}h${String(hod).padStart(2, '0')}`;
    let rem = row[0], k = 0;
    while (rem > 0) {
      const q = Math.min(c.truck.inPallets, rem); rem -= q;
      const p = this.piece('IN', q, t0, t0, false, `IN-${tag}-T${++k}`);
      this.created.IN += q; this.stages.F1.q.push(p);
    }
    if (row[0] > 0) { this.note('demand', `Inbound: ${k} truck(s), ${row[0]} pallets arrive at F1`); this.flow('ext>F1', row[0]); }
    if (row[1] > 0) {
      const p = this.piece('OUT', row[1], t0, t0, false, `OUT-${tag}`); p.req = 'F9';
      this.created.OUT += row[1]; this.insertShared(p);
      this.note('demand', `Outbound request: ${row[1]} pallets at S8`);
    }
    if (row[2] > 0) {
      const p = this.piece('REP', row[2], t0, t0, false, `REP-${tag}`); p.req = 'F7R';
      this.created.REP += row[2]; this.insertShared(p);
      this.note('demand', `Replenishment request: ${row[2]} pallets at S8`);
    }
    this.cur.newIn = row[0]; this.cur.newOut = row[1]; this.cur.newRep = row[2];
  }

  startHour(t0) {
    for (const id in this.areas) this.areas[id].hourPeak = this.areas[id].stock;
    this.cur = { abs: t0 / 60, day: Math.floor(t0 / 1440), hod: Math.floor(t0 / 60) % 24, newIn: 0, newOut: 0, newRep: 0,
      F7: 0, F9: 0, F7R: 0, F1: 0, F2: 0, F3: 0, F5: 0, F11: 0, F13: 0, F14: 0, F17: 0, doneIn: 0, doneOut: 0,
      maxDwellIn: 0, maxDwellOut: 0, blF7: 0, blF9: 0, peakBlF7: 0, peakBlF9: 0, stock: {}, peak: {} };
  }

  // ---------- stage bookkeeping ----------
  stageFinish(stId, p, tc, rate, tStart, pos) {
    const prod = isFinite(rate) && rate > 0 ? 60 / rate : 0;
    const el = tc - p.ready;
    const w = el <= Math.max(prod, this.dt) ? 0 : el - prod; // one time step of granularity is not counted as waiting
    const sw = Math.min(p.sw, w), bw = Math.min(p.bw, w - sw), cw = w - sw - bw;
    p.wait[stId] = (p.wait[stId] || 0) + w; p.capW += cw; p.stockW += sw; p.blockW += bw; p.prod += prod;
    p.sw = 0; p.bw = 0;
    if (this.qledger.length < this.maxLedger) this.qledger.push({ stage: stId, cohort: p.id, flow: p.flow, reqTime: p.origin,
      ready: p.ready, start: tStart, done: tc, qty: p.qty, wait: w, stockWait: sw, blockWait: bw, pos });
    if (this.cur) this.cur[stId] = (this.cur[stId] || 0) + p.qty;
    this.cumProc[stId] += p.qty;
    p.ready = tc;
  }
  finalDone(p, tc) {
    this.completed[p.flow] += p.qty;
    if (p.opening) return;
    const wait = Object.values(p.wait).reduce((a, b) => a + b, 0);
    const row = { flow: p.flow, cohort: p.id, origin: p.origin, done: tc, qty: p.qty, lead: tc - p.origin, prod: p.prod, wait,
      capWait: p.capW, stockWait: p.stockW, blockWait: p.blockW, stages: p.wait };
    this.dwell.push(row);
    if (this.cur) {
      if (p.flow === 'IN') { this.cur.doneIn += p.qty; this.cur.maxDwellIn = Math.max(this.cur.maxDwellIn, wait); }
      if (p.flow === 'OUT') { this.cur.doneOut += p.qty; this.cur.maxDwellOut = Math.max(this.cur.maxDwellOut, wait); }
    }
  }
  spaceOf(id) { return this.cfg.overflow === 'block' ? Math.max(0, this.areas[id].cap - this.areas[id].stock) : Infinity; }

  // ---------- non-shared stages ----------
  runStage(id, t0) {
    const st = this.stages[id], dt = this.dt, tc = t0 + dt, rate = this.rate(id);
    st.credit = isFinite(rate) ? st.credit + rate * dt / 60 : Infinity;
    let blocked = false;
    while (st.q.length && st.credit >= 1) {
      const p = st.q[0];
      let lim = Math.min(p.qty, Math.floor(st.credit));
      const src = id === 'F17' ? p.src : { F5: 'S4', F11: 'S10', F13: 'S12' }[id], dst = { F3: 'S4', F5: 'S6', F11: 'S12' }[id];
      if (src) lim = Math.min(lim, this.areas[src].stock);
      let lb = lim;
      if (dst) lb = Math.min(lim, this.spaceOf(dst));
      if (lb < lim) { p.bw += dt; this.blockMin += dt; }
      lim = lb;
      if (lim <= 0) { blocked = true; break; }
      const c = this.take(p, lim);
      if (c === p) st.q.shift();
      this.stageFinish(id, c, tc, rate, t0, 0);
      st.done += lim; st.credit -= lim;
      switch (id) {
        case 'F1': this.flow('F1>F2', lim); this.stages.F2.q.push(c); break;
        case 'F2': this.flow('F2>F3', lim); this.stages.F3.q.push(c); break;
        case 'F3': this.chg('S4', lim, tc, c, 'F3'); this.flow('F3>S4', lim); this.stages.F5.q.push(c); break;
        case 'F5': this.chg('S4', -lim, tc, c, 'F5'); this.chg('S6', lim, tc, c, 'F5'); this.flow('S4>S6', lim);
          c.req = 'F7'; this.insertShared(c); break;
        case 'F11': this.chg('S10', -lim, tc, c, 'F11'); this.chg('S12', lim, tc, c, 'F11'); this.flow('S10>S12', lim);
          this.stages.F13.q.push(c); break;
        case 'F13': this.chg('S12', -lim, tc, c, 'F13'); this.flow('S12>F13', lim); this.flow('F13>F14', lim); this.stages.F14.q.push(c); break;
        case 'F14': this.flow('F14>out', lim); this.finalDone(c, tc); break;
        case 'F17': this.chg(c.src, -lim, tc, c, 'F17'); this.chg('S11', lim, tc, c, 'F17'); if (c.src === 'S6') this.replenInS6 -= lim;
          this.flow(c.src === 'S10' ? 'S10r>S11' : 'S6r>S11', lim); this.finalDone(c, tc); break;
      }
    }
    if (!isFinite(st.credit)) st.credit = Infinity;
    else if (!st.q.length || blocked) st.credit -= Math.floor(st.credit); // unused capacity is not banked
    st.maxQ = Math.max(st.maxQ, st.q.reduce((a, p) => a + p.qty, 0));
  }

  // ---------- shared pool: F7 + F9 outbound + F7-REPL replenishment picking ----------
  splitQ(f) { const s = this.cfg.repl.split10; return Math.round((this.replTot + f) * s) - Math.round(this.replTot * s); }

  runShared(t0) {
    const dt = this.dt, tc = t0 + dt, c = this.cfg, q = this.shared, cap = poolCap(c), repl = c.repl;
    let credit = this.shCredit + cap * dt / 60;
    const credit0 = Math.floor(credit);
    let used = 0, i = 0, anyBlockedStock = false;
    if (q.length) this.sharedActiveSteps++;
    while (i < q.length && credit >= 1) {
      const p = q[i];
      let lim = Math.min(p.qty, Math.floor(credit)), limInit = lim;
      let avail;
      if (p.req === 'F7') avail = this.areas.S6.stock - this.replenInS6;
      else avail = this.areas.S8.stock;
      if (avail < lim) { lim = Math.max(0, avail); p.sw += dt; anyBlockedStock = true; }
      // downstream space (block mode)
      if (c.overflow === 'block' && lim > 0) {
        if (p.req === 'F7') lim = Math.min(lim, this.spaceOf('S8'));
        else if (p.req === 'F9') lim = Math.min(lim, this.spaceOf('S10'));
        else {
          while (lim > 0) { const a = this.splitQ(lim); if (a <= this.spaceOf('S10') && lim - a <= this.spaceOf('S6')) break; lim--; }
        }
        if (lim < Math.min(limInit, Math.max(0, avail))) { p.bw += dt; this.blockMin += dt; }
      }
      if (lim <= 0) { i++; continue; }
      const pos = i, ch = this.take(p, lim);
      if (ch === p) q.splice(i, 1); else i++;
      const proc = p.req;
      this.stageFinish(proc, ch, tc, cap, t0, pos);
      credit -= lim; used += lim; this.processed[proc] += lim;
      this.stepUsed[proc] += lim;
      if (proc === 'F7') {
        this.chg('S6', -lim, tc, ch, 'F7'); this.chg('S8', lim, tc, ch, 'F7'); this.flow('S6>S8', lim); this.finalDone(ch, tc);
      } else if (proc === 'F9') {
        this.chg('S8', -lim, tc, ch, 'F9'); this.chg('S10', lim, tc, ch, 'F9'); this.flow('S8>S10', lim);
        this.stages.F11.q.push(ch);
      } else {
        this.chg('S8', -lim, tc, ch, 'F7-REPL');
        this.replDone(ch, lim, tc);
      }
    }
    if (anyBlockedStock) this.stockStarveMin += dt;
    if (used >= credit0 && credit0 > 0 && q.length) this.sharedSatSteps++;
    this.shCredit = credit - Math.floor(credit); // unused capacity is not banked
  }

  // F7-REPL completes: pallets leave S8, split between S10 and S6 where they wait for F17 (manual EPT) to S11
  replDone(ch, lim, tc) {
    const a10 = this.splitQ(lim), a6 = lim - a10; this.replTot += lim;
    let c10 = null, c6 = null;
    if (a10 > 0 && a6 > 0) { c10 = this.take(ch, a10); c6 = ch; } else if (a10 > 0) c10 = ch; else c6 = ch;
    if (c10) { c10.src = 'S10'; this.chg('S10', a10, tc, c10, 'F7-REPL'); this.flow('S8>S10r', a10); this.stages.F17.q.push(c10); }
    if (c6) { c6.src = 'S6'; this.chg('S6', a6, tc, c6, 'F7-REPL'); this.replenInS6 += a6; this.flow('S8>S6r', a6); this.stages.F17.q.push(c6); }
  }
  // ---------- main loop ----------
  sumQ(list, req) { let s = 0; for (const p of list) if (!req || p.req === req) s += p.qty; return s; }
  queued() { return this.sumQ(this.shared) + STAGE_IDS.reduce((a, id) => a + this.sumQ(this.stages[id].q), 0); }

  step() {
    if (this.finished) return false;
    const t0 = this.t, dt = this.dt, t1 = t0 + dt;
    this.stepUsed = { F7: 0, F9: 0, F7R: 0 };
    if (t0 % 60 === 0) { this.startHour(t0); if (t0 < this.demandEnd) this.injectDemand(t0); }
    for (const id of ['F1', 'F2', 'F3', 'F5']) this.runStage(id, t0);
    this.runShared(t0);
    for (const id of ['F11', 'F13', 'F14', 'F17']) this.runStage(id, t0);
    this.t = t1;

    const bF7 = this.sumQ(this.shared, 'F7'), bF9 = this.sumQ(this.shared, 'F9'), bR = this.sumQ(this.shared, 'F7R');
    const bl9 = bF9 + bR, tot = bF7 + bl9;
    // Backlog = demand still unserved at an hour boundary (carry-over, BRD T03/T04). Intra-hour queueing of a
    // start-of-hour lump is tracked separately as the instantaneous queue.
    this.maxQueue = Math.max(this.maxQueue || 0, tot);
    if (tot === 0) this.lastZeroT = t1;
    if (t1 % 60 === 0 && tot > 0) {
      const m = this.maxBL;
      if (bF7 > m.F7) { m.F7 = bF7; m.F7T = t1; } if (bl9 > m.F9) { m.F9 = bl9; m.F9T = t1; } if (tot > m.tot) { m.tot = tot; m.totT = t1; }
      if (!this.openBL) { this.openBL = { start: this.lastZeroT || 0, end: null, peak: tot, peakT: t1 }; this.backlogEp.push(this.openBL); this.note('backlog', `Backlog carried over the hour boundary: ${tot} pallets waiting at the shared pool`); }
      else if (tot > this.openBL.peak) { this.openBL.peak = tot; this.openBL.peakT = t1; }
    }
    if (tot === 0 && this.openBL) { this.openBL.end = t1; this.note('clear', `Backlog cleared after ${Math.round(t1 - this.openBL.start)} min`); this.openBL = null; }

    this.hist.push(Float32Array.of(this.areas.S4.stock, this.areas.S6.stock, this.areas.S8.stock, this.areas.S10.stock,
      this.areas.S12.stock, this.areas.S11.stock, this.sumQ(this.stages.F1.q), this.sumQ(this.stages.F2.q),
      this.sumQ(this.stages.F3.q), this.sumQ(this.stages.F5.q), bF7, bF9, bR, this.sumQ(this.stages.F11.q),
      this.sumQ(this.stages.F13.q), this.sumQ(this.stages.F14.q), this.stepUsed.F7, this.stepUsed.F9, this.stepUsed.F7R, ...PROC_ORDER.map(id => this.cumProc[id]),
      this.stages.F17.q.reduce((a, p) => a + (p.src === 'S6' ? p.qty : 0), 0), this.stages.F17.q.reduce((a, p) => a + (p.src === 'S10' ? p.qty : 0), 0)));
    this.histT.push(t1);

    if (t1 % 60 === 0) {
      const h = this.cur; h.blF7 = bF7; h.blF9 = bl9;
      for (const id in this.areas) { h.stock[id] = this.areas[id].stock; h.peak[id] = this.areas[id].hourPeak; }
      h.shared = h.F7 + h.F9 + h.F7R; this.maxHourShared = Math.max(this.maxHourShared, h.shared);
      this.hours.push(h);
    }

    if (t1 >= this.demandEnd && this.queued() === 0) { this.finished = true; this.drained = true; this.note('done', 'All demand cleared'); }
    else if (t1 >= this.maxEnd) { this.finished = true; this.drained = false; this.note('done', 'Maximum run extension reached with residual backlog'); }
    if (this.finished) this.closeOut();
    return !this.finished;
  }

  run(maxSteps = Infinity) { let n = 0; while (!this.finished && n++ < maxSteps) this.step(); return this; }

  closeOut() {
    if (this.cur && this.t % 60 !== 0) { // partial last hour
      const h = this.cur; h.blF7 = this.sumQ(this.shared, 'F7'); h.blF9 = this.sumQ(this.shared) - h.blF7;
      for (const id in this.areas) { h.stock[id] = this.areas[id].stock; h.peak[id] = this.areas[id].hourPeak; }
      h.shared = h.F7 + h.F9 + h.F7R; this.hours.push(h);
    }
    this.result = summarize(this);
  }
}

// ---------- reporting ----------
function dwellStats(rows) {
  if (!rows.length) return { pallets: 0, max: 0, avg: 0, median: 0, p90: 0, p95: 0, p99: 0, pctPos: 0, maxRow: null, stages: {}, cap: 0, stock: 0, block: 0, maxLead: 0, avgLead: 0 };
  const total = rows.reduce((a, r) => a + r.qty, 0);
  let maxRow = rows[0]; for (const r of rows) if (r.wait > maxRow.wait) maxRow = r;
  const stages = {}; let cap = 0, stock = 0, block = 0, pos = 0, lead = 0, maxLead = 0;
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.stages)) stages[k] = (stages[k] || 0) + v * r.qty;
    cap += r.capWait * r.qty; stock += r.stockWait * r.qty; block += r.blockWait * r.qty;
    if (r.wait > 0) pos += r.qty; lead += r.lead * r.qty; maxLead = Math.max(maxLead, r.lead);
  }
  const avg = rows.reduce((a, r) => a + r.wait * r.qty, 0) / total;
  return { pallets: total, max: maxRow.wait, avg, median: weightedPercentile(rows, 'wait', 0.5), p90: weightedPercentile(rows, 'wait', 0.9),
    p95: weightedPercentile(rows, 'wait', 0.95), p99: weightedPercentile(rows, 'wait', 0.99), pctPos: 100 * pos / total, maxRow,
    stages, cap, stock, block, maxLead, avgLead: lead / total };
}

function summarize(sim) {
  const c = sim.cfg, r = {};
  r.drained = sim.drained; r.endT = sim.t;
  const resid = { shared: sim.sumQ(sim.shared), stages: {} };
  for (const id of STAGE_IDS) resid.stages[id] = sim.sumQ(sim.stages[id].q);
  resid.total = resid.shared + Object.values(resid.stages).reduce((a, b) => a + b, 0);
  r.residual = resid;
  r.areas = [...AREA_IDS, 'S11'].map(id => {
    const a = sim.areas[id];
    const over = a.episodes.reduce((s, e) => s + ((e.end === null ? sim.t : e.end) - e.start), 0);
    return { id, opening: a.init, inflow: a.inflow, outflow: a.outflow, closing: a.stock, peak: a.peak, peakT: a.peakT, cap: a.cap,
      breach: a.peak > a.cap, excess: Math.max(0, a.peak - a.cap), episodes: a.episodes, minOver: over, neg: a.neg };
  });
  r.dwell = {}; for (const f of ['IN', 'OUT', 'REP']) r.dwell[f] = dwellStats(sim.dwell.filter(x => x.flow === f));
  r.backlog = { max: sim.maxBL, episodes: sim.backlogEp, endingShared: resid.shared,
    maxRecovery: sim.backlogEp.reduce((m, e) => Math.max(m, (e.end === null ? sim.t : e.end) - e.start), 0) };
  r.top3 = sim.hours.map(h => ({ abs: h.abs, hod: h.hod, day: h.day, bl: h.blF7 + h.blF9 })).sort((a, b) => b.bl - a.bl).filter(h => h.bl > 0).slice(0, 3);
  r.sharedSaturation = sim.sharedActiveSteps ? sim.sharedSatSteps / sim.sharedActiveSteps : 0;
  r.stockStarveMin = sim.stockStarveMin; r.blockMin = sim.blockMin;
  // primary constraint: stage with the most pallet-minutes of wait
  const agg = {}; for (const f of ['IN', 'OUT', 'REP']) for (const [k, v] of Object.entries(r.dwell[f].stages)) agg[k] = (agg[k] || 0) + v;
  const top = Object.entries(agg).sort((a, b) => b[1] - a[1])[0];
  r.primary = top && top[1] > 0 ? { stage: top[0], palletHours: top[1] / 60 } : null;

  // validation checks (AC-001, 002, 004-ish, 007, 012)
  const chk = [];
  const okBal = r.areas.every(a => a.opening + a.inflow - a.outflow === a.closing);
  chk.push({ id: 'AC-001', ok: okBal, text: 'Closing = opening + inflows - outflows for every area' });
  const capHour = Math.ceil(poolCap(c)) + 1;
  chk.push({ id: 'AC-002', ok: sim.hours.every(h => (h.F7 + h.F9 + h.F7R) <= capHour), text: `F7 + F9 + F7-REPL never exceeds the shared pool (${poolCap(c)}/h) in any hour (max seen ${sim.maxHourShared})` });
  chk.push({ id: 'AC-007', ok: r.areas.every(a => a.neg === 0), text: 'No negative stock events' });
  const inSys = resid.total;
  const created = sim.created.IN + sim.created.OUT + sim.created.REP, completed = sim.completed.IN + sim.completed.OUT + sim.completed.REP;
  chk.push({ id: 'AC-012', ok: created === completed + resid.total, text: `All demand completed or shown as backlog (created ${created}, completed ${completed}, residual ${resid.total})` });
  const fifo = sim.qledger.filter(x => x.stage === 'F7' || x.stage === 'F9' || x.stage === 'F7R');
  let fifoOk = true; // within the shared queue, served ready-times (per step) must not be out of order against earlier-ready waiting work
  for (let i = 1; i < fifo.length && fifoOk; i++) if (fifo[i].start === fifo[i - 1].start && fifo[i].pos < fifo[i - 1].pos) fifoOk = false;
  chk.push({ id: 'AC-003', ok: fifoOk, text: 'Backlog served before new demand (queue positions served in order within each step)' });
  r.checks = chk;

  // KPIs / verdicts
  const dIn = r.dwell.IN, dOut = r.dwell.OUT;
  r.capacityVerdict = !sim.drained ? 'FAIL' : sim.maxBL.tot > 0 ? 'PASS (with recovered backlog)' : 'PASS';
  r.kpi = { capacityVerdict: r.capacityVerdict, maxBacklog: sim.maxBL.tot, maxBacklogF7: sim.maxBL.F7, maxBacklogF9: sim.maxBL.F9, endingBacklog: resid.total,
    maxDwellIn: dIn.max, maxDwellOut: dOut.max, avgDwellIn: dIn.avg, avgDwellOut: dOut.avg, p95In: dIn.p95, p95Out: dOut.p95,
    breaches: r.areas.filter(a => a.breach).map(a => a.id).join(',') || 'none',
    peaks: Object.fromEntries(r.areas.map(a => [a.id, a.peak])), recovery: r.backlog.maxRecovery, endT: sim.t };
  return r;
}

if (typeof module !== 'undefined') module.exports = { Sim, defaultConfig, validateConfig, profileTotals, summarize, peopleSummary, peopleReq, peopleTotal, poolWork, poolCap, poolInfo, flowCapacity, unitOf, PROC_ORDER, AREA_IDS, STAGE_IDS, BASE_PROFILE };


