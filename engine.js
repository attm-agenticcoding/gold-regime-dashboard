/*
 * Gold Regime Monitor — scoring & sizing engine (pure functions, no I/O).
 *
 * Inputs : history.json (data layer), 03_metrics.json (registry), config.json, manual.json
 * Output : computeAll() -> { composite, subscores, regime_state, regime_evidence, crisis_flag,
 *          intervention_flag, band, last_state_change, ... } plus chart series.
 *
 * Runs in the browser (ES module) and in node (tests).  Metric thresholds / weights / groups /
 * trigger expressions all come from the registry; this file only knows HOW to compute a
 * transform, never WHAT the thresholds are.
 */

// ---------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const round = (v, d = 2) => (isNum(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const std = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
const pearson = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 5) return null;
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
};
const addMonths = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
const addDays = (iso, n) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = (iso) => new Date(iso + "T00:00:00Z").getUTCDay(); // 0=Sun..6=Sat

// ---------------------------------------------------------------------------
// Table access.  A "table" is {dates:[iso...], columns:{name:[v|null...]}} sorted by date.
// ---------------------------------------------------------------------------
class Table {
  constructor(t) {
    this.dates = (t && t.dates) || [];
    this.columns = (t && t.columns) || {};
    this.index = new Map(this.dates.map((d, i) => [d, i]));
  }
  col(name) { return this.columns[name] || null; }
  has(name) { return !!this.columns[name]; }
  get n() { return this.dates.length; }
  /** index of last date <= iso (or -1) */
  idxAtOrBefore(iso) {
    if (this.index.has(iso)) return this.index.get(iso);
    let lo = 0, hi = this.dates.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (this.dates[mid] <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  /** last non-null value at or before row i: {value, idx, staleRows} */
  asOf(name, i) {
    const c = this.col(name);
    if (!c) return { value: null, idx: -1, staleRows: Infinity };
    for (let k = Math.min(i, c.length - 1); k >= 0; k--) if (isNum(c[k])) return { value: c[k], idx: k, staleRows: i - k };
    return { value: null, idx: -1, staleRows: Infinity };
  }
  /** value at row i - n (as-of) minus... helper: as-of value n rows back */
  asOfBack(name, i, n) { return i - n < 0 ? { value: null, idx: -1, staleRows: Infinity } : this.asOf(name, i - n); }
  /** array of last-valid values for rows [i-n+1 .. i] (forward-filled), null where none */
  window(name, i, n) {
    const c = this.col(name); const out = [];
    if (!c) return out;
    let last = null;
    for (let k = Math.max(0, i - n - 400); k <= i; k++) { if (isNum(c[k])) last = c[k]; if (k > i - n) out.push(last); }
    return out;
  }
  /** raw values (not filled) for rows [i-n+1..i] paired with dates */
  rawWindow(name, i, n) {
    const c = this.col(name) || []; const out = [];
    for (let k = Math.max(0, i - n + 1); k <= i; k++) out.push([this.dates[k], isNum(c[k]) ? c[k] : null]);
    return out;
  }
}

/** last observation in a low-frequency table with date <= iso; returns {value, date, k, back(n)} */
function lastObs(tbl, name, iso) {
  const k = tbl.idxAtOrBefore(iso);
  const c = tbl.col(name);
  if (!c || k < 0) return { value: null, date: null, k: -1 };
  for (let j = k; j >= 0; j--) if (isNum(c[j])) return { value: c[j], date: tbl.dates[j], k: j };
  return { value: null, date: null, k: -1 };
}
function obsBack(tbl, name, k, n) {
  const c = tbl.col(name);
  if (!c) return null;
  // n-th previous non-null observation strictly before k
  let cnt = 0;
  for (let j = k - 1; j >= 0; j--) if (isNum(c[j])) { cnt++; if (cnt === n) return { value: c[j], date: tbl.dates[j], k: j }; }
  return null;
}
function trailingSum(tbl, name, k, n) {
  const c = tbl.col(name); if (!c || k < 0) return null;
  let s = 0, cnt = 0;
  for (let j = k; j >= 0 && cnt < n; j--) if (isNum(c[j])) { s += c[j]; cnt++; }
  return cnt === n ? s : null;
}

// ---------------------------------------------------------------------------
// Scoring: piecewise-linear map to 0..100 in the gold-bullish direction
// ---------------------------------------------------------------------------
export function scoreMetric(value, m) {
  if (!isNum(value)) return null;
  const t = m.thresholds;
  const lerp = (x, x0, x1, y0, y1) => y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  if (m.direction === "lower_is_bullish") {
    if (value <= t.bullish) return 100;
    if (value >= t.bearish) return 0;
    if (value <= t.neutral) return lerp(value, t.bullish, t.neutral, 100, 50);
    return lerp(value, t.neutral, t.bearish, 50, 0);
  }
  // higher_is_bullish
  if (value >= t.bullish) return 100;
  if (value <= t.bearish) return 0;
  if (value >= t.neutral) return lerp(value, t.neutral, t.bullish, 50, 100);
  return lerp(value, t.bearish, t.neutral, 0, 50);
}

/** Weighted group + composite from {id: {score, weight_used}} */
export function aggregate(perMetric, metrics, registry) {
  const groups = {};
  for (const [gid, g] of Object.entries(registry.groups)) groups[gid] = { weight: g.weight, label: g.label, label_zh: g.label_zh, score: null, sumW: 0, sumWS: 0, members: [] };
  for (const m of metrics) {
    const r = perMetric[m.id];
    const g = groups[m.group];
    if (!g || !r) continue;
    g.members.push(m.id);
    if (isNum(r.score) && r.weight_used > 0) { g.sumW += r.weight_used; g.sumWS += r.weight_used * r.score; }
  }
  let comp = 0, wsum = 0;
  for (const g of Object.values(groups)) {
    g.score = g.sumW > 0 ? g.sumWS / g.sumW : null;
    if (isNum(g.score)) { comp += g.weight * g.score; wsum += g.weight; }
  }
  const composite = wsum > 0 ? comp / wsum : null;   // renormalise if a whole group is missing
  return { groups, composite };
}

/** Score directly from a {id: value} map (used by the 04_SIZING_MODEL unit test). */
export function scoreFromValues(values, registry, config, staleRows = {}) {
  const per = {};
  const limit = config.stale_days_zero_weight ?? 10;
  for (const m of registry.metrics) {
    const v = values[m.id];
    const stale = staleRows[m.id] ?? 0;
    let score = scoreMetric(v, m);
    const weight_used = (!isNum(score) || stale > limit) ? 0 : m.weight;
    per[m.id] = { value: v, score, weight: m.weight, weight_used, stale_rows: stale };
  }
  const { groups, composite } = aggregate(per, registry.metrics, registry);
  return { per, groups, composite };
}

// ---------------------------------------------------------------------------
// Expression evaluator for regime triggers / flags / tranche rules
//   supports: numbers, identifiers (a.b.c), fn(args), + - * /, comparisons,
//   'x between a and b', AND / OR / NOT, parentheses.  Returns {ok, near, value}.
// ---------------------------------------------------------------------------
function tokenize(src) {
  const re = /\s*(>=|<=|==|!=|[<>()+\-*\/,]|[A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?|\.\d+)/g;
  const out = []; let m; let last = 0;
  while ((m = re.exec(src))) { if (m.index !== last) throw new Error("bad expr near " + src.slice(last, m.index + 5)); out.push(m[1]); last = re.lastIndex; }
  if (last !== src.length && src.slice(last).trim()) throw new Error("bad expr tail: " + src.slice(last));
  return out;
}

export function parseExpr(src) {
  const t = tokenize(src); let p = 0;
  const peek = () => t[p], next = () => t[p++];
  const up = (s) => (s || "").toUpperCase();
  function orx() { let l = andx(); while (up(peek()) === "OR") { next(); l = { op: "OR", l, r: andx() }; } return l; }
  function andx() { let l = notx(); while (up(peek()) === "AND") { next(); l = { op: "AND", l, r: notx() }; } return l; }
  function notx() { if (up(peek()) === "NOT") { next(); return { op: "NOT", e: notx() }; } return cmp(); }
  function cmp() {
    const l = sum();
    const k = peek();
    if (up(k) === "BETWEEN") { next(); const a = sum(); if (up(next()) !== "AND") throw new Error("between needs 'and'"); const b = sum(); return { op: "between", l, a, b }; }
    if (["<", "<=", ">", ">=", "==", "!="].includes(k)) { next(); return { op: k, l, r: sum() }; }
    return l;
  }
  function sum() { let l = prod(); while (peek() === "+" || peek() === "-") { const op = next(); l = { op, l, r: prod() }; } return l; }
  function prod() { let l = unary(); while (peek() === "*" || peek() === "/") { const op = next(); l = { op, l, r: unary() }; } return l; }
  function unary() { if (peek() === "-") { next(); return { op: "neg", e: unary() }; } return primary(); }
  function primary() {
    const k = next();
    if (k === undefined) throw new Error("unexpected end");
    if (k === "(") { const e = orx(); if (next() !== ")") throw new Error("expected )"); return e; }
    if (/^[\d.]/.test(k)) return { op: "num", v: parseFloat(k) };
    if (peek() === "(") { next(); const args = []; if (peek() !== ")") { args.push(orx()); while (peek() === ",") { next(); args.push(orx()); } } if (next() !== ")") throw new Error("expected ) after args"); return { op: "call", name: k, args }; }
    return { op: "id", name: k };
  }
  const ast = orx();
  if (p !== t.length) throw new Error("trailing tokens: " + t.slice(p).join(" "));
  return ast;
}

/**
 * env.get(name) -> number|boolean|null ; env.call(name, args[]) -> number|null
 * nearPct: fraction for "near trigger" (0.2 = within 20% of threshold)
 */
export function evalExpr(ast, env, nearPct = 0.2) {
  const num = (node) => {
    const r = ev(node);
    return isNum(r.value) ? r.value : (typeof r.value === "boolean" ? (r.value ? 1 : 0) : null);
  };
  const nearOf = (l, r) => (isNum(l) && isNum(r)) ? Math.abs(l - r) <= nearPct * Math.max(Math.abs(r), Math.abs(l)) : false;
  function ev(node) {
    switch (node.op) {
      case "num": return { value: node.v };
      case "id": {
        if (node.name === "true") return { value: true };
        if (node.name === "false") return { value: false };
        const v = env.get(node.name); return { value: v === undefined ? null : v };
      }
      case "call": { const v = env.call(node.name, node.args.map(num)); return { value: v === undefined ? null : v }; }
      case "neg": { const v = num(node.e); return { value: isNum(v) ? -v : null }; }
      case "+": case "-": case "*": case "/": {
        const a = num(node.l), b = num(node.r);
        if (!isNum(a) || !isNum(b)) return { value: null };
        return { value: node.op === "+" ? a + b : node.op === "-" ? a - b : node.op === "*" ? a * b : (b === 0 ? null : a / b) };
      }
      case "<": case "<=": case ">": case ">=": {
        const a = num(node.l), b = num(node.r);
        if (!isNum(a) || !isNum(b)) return { value: null, ok: false, near: false, lhs: a, rhs: b };
        const ok = node.op === "<" ? a < b : node.op === "<=" ? a <= b : node.op === ">" ? a > b : a >= b;
        return { value: ok, ok, near: !ok && nearOf(a, b), lhs: a, rhs: b };
      }
      case "==": case "!=": {
        const l = ev(node.l).value, r = ev(node.r).value;
        const norm = (x) => (typeof x === "string" ? x.toUpperCase() : x);
        const eq = norm(l) === norm(r) || (isNum(l) && isNum(r) && Math.abs(l - r) < 1e-9);
        const ok = node.op === "==" ? eq : !eq;
        return { value: ok, ok, near: false, lhs: l, rhs: r };
      }
      case "between": {
        const x = num(node.l), a = num(node.a), b = num(node.b);
        if (!isNum(x) || !isNum(a) || !isNum(b)) return { value: null, ok: false, near: false, lhs: x };
        const ok = x >= a && x <= b;
        const near = !ok && (nearOf(x, a) || nearOf(x, b));
        return { value: ok, ok, near, lhs: x, rhs: [a, b] };
      }
      case "AND": { const l = ev(node.l), r = ev(node.r); const ok = !!l.ok && !!r.ok; const near = !ok && (l.ok || l.near) && (r.ok || r.near); return { value: ok, ok, near, parts: [l, r] }; }
      case "OR": { const l = ev(node.l), r = ev(node.r); const ok = !!l.ok || !!r.ok; const near = !ok && (!!l.near || !!r.near); return { value: ok, ok, near, parts: [l, r] }; }
      case "NOT": { const e = ev(node.e); return { value: !e.ok, ok: !e.ok, near: false }; }
      default: throw new Error("bad node " + node.op);
    }
  }
  const r = ev(ast);
  if (r.ok === undefined) { // bare value used as boolean
    const v = r.value; r.ok = v === true || (isNum(v) && v !== 0); r.near = false;
  }
  return r;
}

const exprCache = new Map();
export function evaluate(src, env, nearPct) {
  let ast = exprCache.get(src);
  if (!ast) { ast = parseExpr(src); exprCache.set(src, ast); }
  return evalExpr(ast, env, nearPct);
}

// ---------------------------------------------------------------------------
// Metric computation as of a daily-table row index
// ---------------------------------------------------------------------------
function buildContext(history, config, manual) {
  const daily = new Table(history.daily);
  const weekly = new Table(history.weekly);
  const monthly = new Table(history.monthly);
  // effective fed path column: ZQ-implied where present, else (DGS2 - EFFR)*100 bp
  if (!daily.has("fed_path_6m_eff")) {
    const zq = daily.col("fed_path_6m") || [], d2 = daily.col("DGS2") || [], ef = daily.col("EFFR") || [];
    const eff = [], src = [];
    let lastE = null;
    for (let i = 0; i < daily.n; i++) {
      if (isNum(ef[i])) lastE = ef[i];
      if (isNum(zq[i])) { eff.push(zq[i]); src.push("zq"); }
      else if (isNum(d2[i]) && isNum(lastE)) { eff.push(round((d2[i] - lastE) * 100, 1)); src.push("fallback"); }
      else { eff.push(null); src.push(null); }
    }
    daily.columns.fed_path_6m_eff = eff;
    daily.columns.fed_path_6m_src = src;
  }
  return { daily, weekly, monthly, history, config, manual: manual || {}, auctions: history.auctions || [], buybacks: history.buybacks || [], srf: history.srf || [] };
}

function monthsBetween(a, b) { return (new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / (30.4375 * 86400000); }

/** long-end auctions tail proxy (bid-to-cover z-score vs previous N same-bucket auctions), avg of last 3 as of date */
function auctionTailProxy(ctx, iso) {
  const cfg = ctx.config;
  const N = cfg.auction_lookback_n ?? 12, k = cfg.auction_tail_bp_per_sigma ?? 1.0;
  const past = ctx.auctions.filter((a) => a.date <= iso && isNum(a.btc));
  const last3 = past.slice(-3);
  if (last3.length < 3) return { value: null, detail: [] };
  const detail = last3.map((a) => {
    const prev = past.filter((p) => p.bucket === a.bucket && p.date < a.date).slice(-N).map((p) => p.btc);
    const mu = mean(prev), sd = std(prev);
    const z = (prev.length >= 4 && sd > 0) ? (a.btc - mu) / sd : null;
    return { ...a, btc_mean: round(mu, 2), z: round(z, 2), tail_proxy_bp: isNum(z) ? round(-z * k, 2) : null };
  });
  const vals = detail.map((d) => d.tail_proxy_bp).filter(isNum);
  return { value: vals.length ? mean(vals) : null, detail };
}

function buybackQtr(ctx, iso) {
  const minY = ctx.config.buyback_long_end_min_years ?? 10;
  const from = addMonths(iso, -3);
  const ops = ctx.buybacks.filter((b) => b.date > from && b.date <= iso);
  const longOps = ops.filter((b) => isNum(b.years_to_begin) && b.years_to_begin >= minY);
  return { value: longOps.reduce((s, b) => s + (b.accepted_bn || 0), 0), all_bn: ops.reduce((s, b) => s + (b.accepted_bn || 0), 0), n: longOps.length, ops: longOps.slice(-6) };
}

function srfAvg5(ctx, iso) {
  const rows = ctx.srf.filter((s) => s.date <= iso).slice(-5);
  return rows.length ? mean(rows.map((r) => r.accepted_bn || 0)) : null;
}

function goldModel(ctx) {
  if (ctx._goldModel) return ctx._goldModel;
  const { daily, config } = ctx;
  const w = config.gold_model_fit_window || { start: "2006-01-01", end: "2021-12-31" };
  const g = daily.col("gold_spot") || [], r = daily.col("DFII10") || [];
  const xs = [], ys = [];
  for (let i = 0; i < daily.n; i++) {
    const d = daily.dates[i];
    if (d < w.start || d > w.end) continue;
    if (isNum(g[i]) && g[i] > 0 && isNum(r[i])) { xs.push(r[i]); ys.push(Math.log(g[i])); }
  }
  let model = { a: null, b: null, n: xs.length, r2: null, window: w };
  if (xs.length >= 24) {
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const b = sxy / sxx, a = my - b * mx;
    model = { a, b, n: xs.length, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : null, window: w };
  }
  ctx._goldModel = model;
  return model;
}

/** Compute one metric's value (and inputs) as of daily row i. */
function metricValue(m, ctx, i) {
  const { daily, weekly, monthly, config, manual } = ctx;
  const iso = daily.dates[i];
  const D = (name) => daily.asOf(name, i);
  const chgD = (name, n) => { const a = D(name), b = daily.asOfBack(name, i, n); return (isNum(a.value) && isNum(b.value)) ? a.value - b.value : null; };
  const out = (value, inputs = {}, staleRows = 0, extra = {}) => ({ value, inputs, stale_rows: staleRows, ...extra });

  // --- generic FRED-style transforms on the daily table
  if (m.source === "fred" && m.transform === "level" && m.cadence === "daily") {
    const a = D(m.series); return out(a.value, { [m.series]: a.value }, a.staleRows);
  }
  if (m.source === "fred" && /^chg_(\d+)d(_pct)?$/.test(m.transform) && m.cadence === "daily") {
    const [, n, pct] = m.transform.match(/^chg_(\d+)d(_pct)?$/);
    const a = D(m.series), b = daily.asOfBack(m.series, i, +n);
    let v = null;
    if (isNum(a.value) && isNum(b.value)) v = pct ? ((a.value / b.value) - 1) * 100 : a.value - b.value;
    return out(v, { now: a.value, then: b.value, then_date: b.idx >= 0 ? daily.dates[b.idx] : null }, a.staleRows);
  }
  if (m.source === "fred" && /^chg_(\d+)w$/.test(m.transform)) {
    const n = +m.transform.match(/^chg_(\d+)w$/)[1];
    const a = lastObs(weekly, m.series, iso); const b = a.k >= 0 ? obsBack(weekly, m.series, a.k, n) : null;
    const v = (a.value != null && b && isNum(b.value)) ? (a.value - b.value) / 1000 : null;  // FRED H.4.1 in $mn -> $bn
    const staleRows = a.date ? Math.max(0, i - daily.idxAtOrBefore(a.date)) : Infinity;
    return out(v, { now_bn: a.value != null ? a.value / 1000 : null, then_bn: b ? b.value / 1000 : null, now_date: a.date, then_date: b && b.date }, staleRows);
  }

  // --- derived / special metrics by id
  switch (m.id) {
    case "dfii10_gap_rstar": { const a = D("DFII10"); return out(isNum(a.value) ? a.value - (config.r_star ?? 1.0) : null, { DFII10: a.value, r_star: config.r_star }, a.staleRows); }
    case "real_policy_rate": {
      const e = D("EFFR"); const p = lastObs(monthly, "PCEPILFE", iso); const p12 = p.k >= 0 ? obsBack(monthly, "PCEPILFE", p.k, 12) : null;
      const yoy = (p.value != null && p12) ? ((p.value / p12.value) - 1) * 100 : null;
      return out((isNum(e.value) && isNum(yoy)) ? e.value - yoy : null, { EFFR: e.value, core_pce_yoy: round(yoy, 2), pce_month: p.date }, e.staleRows);
    }
    case "fed_path_6m": { const a = D("fed_path_6m_eff"); const src = daily.col("fed_path_6m_src")[a.idx]; return out(a.value, { source: src, contract: (ctx.history.meta && ctx.history.meta.fed_path_contract) || null }, a.staleRows, { fallback_used: src === "fallback" }); }
    case "acm_tp10_level": { const a = D("ACMTP10"); return out(a.value, { ACMTP10: a.value }, a.staleRows); }
    case "curve_2s30s_chg_20d": {
      const s30 = D("DGS30"), s2 = D("DGS2"), b30 = daily.asOfBack("DGS30", i, 20), b2 = daily.asOfBack("DGS2", i, 20);
      const now = (isNum(s30.value) && isNum(s2.value)) ? s30.value - s2.value : null, then = (isNum(b30.value) && isNum(b2.value)) ? b30.value - b2.value : null;
      const v = (isNum(now) && isNum(then)) ? (now - then) * 100 : null;
      return out(v, { spread_now_bp: round(now * 100, 0), spread_then_bp: round(then * 100, 0), dgs30_chg_20d: chgD("DGS30", 20) }, Math.max(s30.staleRows, s2.staleRows));
    }
    case "gold_real_corr_60d": {
      const n = config.corr_window_days ?? 60;
      const g = daily.rawWindow("gold_spot", i, n + 1), r = daily.rawWindow("DFII10", i, n + 1);
      const dg = [], dr = [];
      let pg = null, pr = null;
      for (let k = 0; k < g.length; k++) {
        const gv = g[k][1], rv = r[k][1];
        if (isNum(gv) && isNum(rv)) { if (isNum(pg) && isNum(pr)) { dg.push(gv / pg - 1); dr.push(rv - pr); } pg = gv; pr = rv; }
      }
      const c = pearson(dg, dr);
      return out(c, { n_pairs: dg.length }, D("gold_spot").staleRows);
    }
    case "bills_share": { const a = lastObs(monthly, "bills_share", iso); return out(a.value, { month: a.date }, a.date ? i - daily.idxAtOrBefore(a.date) : Infinity); }
    case "sofr_iorb_spread": {
      const s = daily.window("SOFR", i, 5), b = daily.window("IORB", i, 5);
      const sp = s.map((x, k) => (isNum(x) && isNum(b[k])) ? (x - b[k]) * 100 : null).filter(isNum);
      const cur = D("SOFR"), cb = D("IORB");
      return out(sp.length ? mean(sp) : null, { sofr: cur.value, iorb: cb.value, spread_today_bp: (isNum(cur.value) && isNum(cb.value)) ? round((cur.value - cb.value) * 100, 1) : null }, cur.staleRows);
    }
    case "rrp_level": { const a = D("RRPONTSYD"); return out(a.value, { RRPONTSYD: a.value }, a.staleRows); }
    case "buyback_actual_qtr": { const b = buybackQtr(ctx, iso); return out(b.value, { n_long_ops: b.n, all_buckets_bn: round(b.all_bn, 2), ops: b.ops }, ctx.buybacks.length ? 0 : Infinity); }
    case "auction_tail_long": { const a = auctionTailProxy(ctx, iso); return out(a.value, { last3: a.detail, proxy: "bid-to-cover z-score x bp_per_sigma (no WI yield available)" }, a.detail.length ? 0 : Infinity, { fallback_used: true }); }
    case "interest_to_receipts": {
      const ni = lastObs(monthly, "net_interest_bn", iso);
      const sNI = ni.k >= 0 ? trailingSum(monthly, "net_interest_bn", ni.k, 12) : null;
      const sR = ni.k >= 0 ? trailingSum(monthly, "receipts_bn", ni.k, 12) : null;
      return out((isNum(sNI) && isNum(sR) && sR !== 0) ? sNI / sR : null, { net_interest_12m_bn: round(sNI, 0), receipts_12m_bn: round(sR, 0), month: ni.date }, ni.date ? i - daily.idxAtOrBefore(ni.date) : Infinity);
    }
    case "foreign_official_chg_12m": {
      const a = lastObs(monthly, "foreign_official_bn", iso); const b = a.k >= 0 ? obsBack(monthly, "foreign_official_bn", a.k, 12) : null;
      return out((a.value != null && b) ? a.value - b.value : null, { now: a.value, then: b && b.value, month: a.date }, a.date ? i - daily.idxAtOrBefore(a.date) : Infinity);
    }
    case "cb_gold_purchases_3m": {
      const tbl = (manual && manual.cb_gold_purchases_tonnes) || {};
      const months = Object.keys(tbl).filter((k) => /^\d{4}-\d{2}$/.test(k) && k <= iso.slice(0, 7)).sort();
      const last3 = months.slice(-3);
      const v = last3.length === 3 ? last3.reduce((s, k) => s + (+tbl[k] || 0), 0) : null;
      const lastM = months.length ? months[months.length - 1] : null;
      const staleRows = lastM ? Math.max(0, monthsBetween(lastM + "-01", iso) - 1) * 21 : Infinity; // rows since the end of the last filled month
      return out(v, { months: last3, tonnes: last3.map((k) => tbl[k]) }, staleRows, { manual: true });
    }
    default:
      return out(null, { error: "no transform for " + m.id }, Infinity);
  }
}

/** Build the identifier/function environment used by trigger expressions, as of row i. */
function makeEnv(ctx, i, mvals, flags) {
  const { daily, weekly, monthly, config } = ctx;
  const iso = daily.dates[i];
  const yoy = (name) => { const a = lastObs(monthly, name, iso); const b = a.k >= 0 ? obsBack(monthly, name, a.k, 12) : null; return (a.value != null && b) ? (a.value / b.value - 1) * 100 : null; };
  const deficitToGdp = () => {
    const o = lastObs(monthly, "net_outlays_bn", iso);
    const sO = o.k >= 0 ? trailingSum(monthly, "net_outlays_bn", o.k, 12) : null, sR = o.k >= 0 ? trailingSum(monthly, "receipts_bn", o.k, 12) : null;
    const gdp = lastObs(monthly, "GDP", iso).value;  // $bn SAAR
    return (isNum(sO) && isNum(sR) && isNum(gdp)) ? ((sO - sR) / gdp) * 100 : null;
  };
  const ids = {
    crisis_flag: flags.crisis ? "ON" : "OFF", intervention_flag: flags.intervention ? "ON" : "OFF", ON: "ON", OFF: "OFF", true: true, false: false,
    "config.manual_intervention.on": !!(config.manual_intervention && config.manual_intervention.on),
    CPIAUCSL_yoy: yoy("CPIAUCSL"), PCEPILFE_yoy: yoy("PCEPILFE"), productivity_yoy: yoy("OPHNFB"),
    deficit_to_gdp_trailing_12m: deficitToGdp(),
    MOVE_level: daily.asOf("MOVE", i).value, SRF_usage_5d_avg: srfAvg5(ctx, iso),
    gold_spot: daily.asOf("gold_spot", i).value,
  };
  return {
    get(name) {
      if (name in ids) return ids[name];
      if (mvals[name]) return mvals[name].value;                        // metric ids
      const mLevel = name.match(/^(.+)_level$/); if (mLevel && daily.has(mLevel[1])) return daily.asOf(mLevel[1], i).value;
      if (daily.has(name)) return daily.asOf(name, i).value;
      if (name === "fed_path_6m") return daily.asOf("fed_path_6m_eff", i).value;
      const mYoy = name.match(/^(.+)_yoy$/); if (mYoy && monthly.has(mYoy[1])) return yoy(mYoy[1]);
      if (monthly.has(name)) return lastObs(monthly, name, iso).value;
      return null;
    },
    call() { return null; },
  };
}

// The generic evaluator passes numeric args, but chg_Nd(SERIES) needs the *name*.  We pre-rewrite
// "chg_20d(DFII30)" -> identifier "chg_20d__DFII30" and resolve that in envWithCalls.get().
function rewriteCalls(src) { return src.replace(/(chg_\d+[dwm])\(([A-Za-z0-9_]+)\)/g, "$1__$2"); }

function envWithCalls(ctx, i, mvals, flags) {
  const base = makeEnv(ctx, i, mvals, flags);
  const { daily, weekly, monthly } = ctx;
  const iso = daily.dates[i];
  return {
    get(name) {
      const m = name.match(/^chg_(\d+)([dwm])__(.+)$/);
      if (!m) return base.get(name);
      const n = +m[1], unit = m[2], s = m[3] === "fed_path_6m" ? "fed_path_6m_eff" : m[3];
      if (unit === "d") {
        if (daily.has(s)) { const a = daily.asOf(s, i), b = daily.asOfBack(s, i, n); return (isNum(a.value) && isNum(b.value)) ? a.value - b.value : null; }
        return null;
      }
      if (unit === "w") { const a = lastObs(weekly, s, iso); const b = a.k >= 0 ? obsBack(weekly, s, a.k, n) : null; return (a.value != null && b) ? (a.value - b.value) / (s === "WALCL" || s === "WTREGEN" || s === "WRESBAL" ? 1000 : 1) : null; }
      if (unit === "m") { const a = lastObs(monthly, s, iso); const b = a.k >= 0 ? obsBack(monthly, s, a.k, n) : null; return (a.value != null && b) ? a.value - b.value : null; }
      return null;
    },
    call() { return null; },
  };
}

// ---------------------------------------------------------------------------
// Flags, regimes, tranches as of row i
// ---------------------------------------------------------------------------
function evalConditions(conds, env, nearPct) {
  return conds.map((c) => {
    let r;
    try { r = evaluate(rewriteCalls(c.expr), env, nearPct); } catch (e) { r = { ok: false, near: false, error: String(e) }; }
    return { id: c.id, expr: c.expr, ok: !!r.ok, near: !!r.near, lhs: r.lhs ?? null, rhs: r.rhs ?? null, note: c.note, error: r.error };
  });
}

function bandIndex(composite, bands) {
  if (!isNum(composite)) return null;
  for (let k = 0; k < bands.length; k++) if (composite < bands[k].max || k === bands.length - 1) return k;
  return bands.length - 1;
}

/** trading rows a metric may go without a new print before the stale counter starts (cadence + normal publication lag) */
const CADENCE_ALLOWANCE = { daily: 0, weekly: 7, monthly: 55, quarterly: 130, per_auction: 70, per_operation: 70, manual: 0 };

/** Everything for one date (row i) except the settled band (which needs the weekly replay). */
function snapshotAt(ctx, registry, i, opts = {}) {
  const { config } = ctx;
  const iso = ctx.daily.dates[i];
  const limit = config.stale_days_zero_weight ?? 10;
  const mvals = {};
  for (const m of registry.metrics) {
    const r = metricValue(m, ctx, i);
    let score = scoreMetric(r.value, m);
    let capped = false;
    if (m.cap_unless && isNum(score)) {
      const env0 = envWithCalls(ctx, i, mvals, { crisis: false, intervention: false });
      const c = evaluate(rewriteCalls(m.cap_unless.expr), env0, 0);
      if (!c.ok) { score = Math.min(score, m.cap_unless.cap); capped = true; }
    }
    // Stale rule: "no new print for > N trading days" is measured against each metric's own cadence —
    // a monthly series is not stale 11 days after its last release.  Allowance (trading rows) by cadence:
    const allowance = CADENCE_ALLOWANCE[m.cadence] ?? 0;
    const rawStale = isNum(r.stale_rows) ? r.stale_rows : Infinity;
    const stale = rawStale === Infinity ? Infinity : Math.max(0, rawStale - allowance);
    const weight_used = (!isNum(score) || stale > limit) ? 0 : m.weight;
    mvals[m.id] = { id: m.id, group: m.group, name: m.name, unit: m.unit, cadence: m.cadence, value: r.value, inputs: r.inputs, score, capped, weight: m.weight, weight_used, stale_rows: stale, stale_rows_raw: rawStale, stale: stale > limit, fallback_used: !!r.fallback_used, manual: !!r.manual, thresholds: m.thresholds, direction: m.direction, why: m.why };
  }
  const { groups, composite } = aggregate(mvals, registry.metrics, registry);

  // flags (crisis first, then intervention which may reference nothing from crisis)
  const env0 = envWithCalls(ctx, i, mvals, { crisis: false, intervention: false });
  const crisisConds = evalConditions(registry.crisis_flags.conditions, env0, 0);
  const crisisOn = crisisConds.filter((c) => c.ok).length >= (config.crisis_min_true ?? 2);
  const intervConds = evalConditions(registry.fed_intervention_flags.conditions, env0, 0);
  const intervOn = intervConds.some((c) => c.ok);
  const env = envWithCalls(ctx, i, mvals, { crisis: crisisOn, intervention: intervOn });
  const nearPct = config.near_trigger_pct ?? 0.2;

  const regimes = {};
  for (const [key, conds] of Object.entries(registry.regime_triggers)) {
    const letter = key[0];
    const rows = evalConditions(conds.map((c, k) => ({ id: `${key}_${k}`, ...c })), env, nearPct);
    regimes[letter] = { key, prior: (config.regime_priors || {})[letter] ?? null, satisfied: rows.filter((r) => r.ok).length, near: rows.filter((r) => r.near).length, total: rows.length, triggers: rows };
  }
  const evidence = Object.fromEntries(Object.entries(regimes).map(([k, r]) => [k, r.total ? r.satisfied / r.total : 0]));
  // "证据倾向": path with the highest satisfied share; ties -> higher prior
  const lead = Object.entries(regimes).sort((a, b) => (evidence[b[0]] - evidence[a[0]]) || ((b[1].prior ?? 0) - (a[1].prior ?? 0)))[0];

  const tranches = {};
  for (const [name, t] of Object.entries(config.tranches || {})) {
    let r; try { r = evaluate(rewriteCalls(t.trigger), env, nearPct); } catch (e) { r = { ok: false, near: false, error: String(e) }; }
    tranches[name] = { pct: t.pct, trigger: t.trigger, met: !!r.ok, near: !!r.near, error: r.error };
  }
  const en = config.expression_note || {};
  const expressionNote = isNum(composite) && composite >= (en.score_min ?? 30) && composite <= (en.score_max ?? 60) &&
    ((regimes.C && regimes.C.satisfied >= (en.c_min_true ?? 2)) || (regimes.B && regimes.B.satisfied >= (en.b_min_true ?? 2)));

  return { date: iso, i, metrics: mvals, groups, composite, crisis: { on: crisisOn, conditions: crisisConds, min_true: config.crisis_min_true ?? 2 }, intervention: { on: intervOn, conditions: intervConds }, regimes, evidence, lead_regime: lead ? lead[0] : null, tranches, expression_note: !!expressionNote, raw_band: bandIndex(composite, config.bands) };
}

// ---------------------------------------------------------------------------
// Weekly settlement + hysteresis + crisis-sequence override (pure state machine)
// ---------------------------------------------------------------------------
/**
 * @param {Array<{date, composite, crisis, intervention}>} settlements chronological
 * @returns {{state, history}}
 */
export function settle(settlements, config) {
  const bands = config.bands;
  const H = config.hysteresis_weeks ?? 2;
  const PH = config.post_intervention_hysteresis_weeks ?? 4;
  const top = bands.length - 1;
  let band = null, candidate = null, count = 0, lastChange = null, postHold = 0, forced = false;
  const history = [];
  for (const s of settlements) {
    const raw = bandIndex(s.composite, bands);
    let note = "";
    if (band === null) { band = raw; lastChange = s.date; note = "init"; }
    else if (s.intervention) {
      if (band !== top) { band = top; lastChange = s.date; }
      forced = true; candidate = null; count = 0; postHold = PH; note = "intervention: overlay to max";
    } else {
      if (forced) { forced = false; note = "intervention off: holding " + PH + "w"; }
      if (raw === null) note = note || "no composite";
      else if (raw !== band) {
        if (candidate === raw) count++; else { candidate = raw; count = 1; }
        if (count >= H) {
          if (raw > band && s.crisis) { note = "crisis: overlay adds frozen"; }
          else if (raw < band && postHold > 0) { note = "post-intervention hold, no downgrade"; }
          else { band = raw; lastChange = s.date; candidate = null; count = 0; note = "band changed"; }
        } else note = note || `pending ${count}/${H}`;
      } else { candidate = null; count = 0; }
      if (postHold > 0) postHold--;
    }
    history.push({ date: s.date, composite: round(s.composite, 1), raw_band: raw, band, crisis: !!s.crisis, intervention: !!s.intervention, candidate, count, note });
  }
  return { state: { band, candidate, count, lastChange, postHold, forced }, history };
}

export function bandToAllocation(bandIdx, config) {
  const f = bandIdx === null ? 0 : (config.bands[bandIdx].overlay_fraction ?? 0);
  const invested = (config.base_pct ?? 40) + f * (config.overlay_max_pct ?? 60);
  return { overlay_fraction: f, invested_pct: round(invested, 1), dry_powder_pct: round(100 - invested, 1), base_pct: config.base_pct ?? 40, overlay_pct: round(f * (config.overlay_max_pct ?? 60), 1) };
}

/** settlement dates: the last trading row of each ISO week (Fri or earlier if holiday) */
function settlementRows(daily, fromIdx, toIdx) {
  const rows = [];
  let prevWeek = null;
  for (let i = fromIdx; i <= toIdx; i++) {
    const d = daily.dates[i];
    const dt = new Date(d + "T00:00:00Z");
    const thu = new Date(dt); thu.setUTCDate(dt.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7));
    const wk = thu.getUTCFullYear() + "-" + Math.ceil((((thu - new Date(Date.UTC(thu.getUTCFullYear(), 0, 1))) / 86400000) + 1) / 7);
    if (prevWeek !== null && wk !== prevWeek) rows.push(i - 1);
    prevWeek = wk;
  }
  // the current week's last row counts only if it is a Friday (settled) — otherwise it's "in progress"
  if (toIdx >= fromIdx && dow(daily.dates[toIdx]) === 5) rows.push(toIdx);
  return rows;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
export function computeAll(history, registry, config, manual = {}, opts = {}) {
  const ctx = buildContext(history, config, manual);
  const { daily } = ctx;
  if (!daily.n) throw new Error("empty history");
  const asOfIdx = opts.asOf ? daily.idxAtOrBefore(opts.asOf) : daily.n - 1;
  const lookback = opts.lookbackDays ?? config.chart_lookback_days ?? 504;
  const startIdx = Math.max(0, asOfIdx - lookback + 1);

  // daily series over the lookback (composite, groups, corr, flags) — used for charts + settlement
  const series = [];
  const cache = new Map();
  const snapAt = (i) => { if (!cache.has(i)) cache.set(i, snapshotAt(ctx, registry, i)); return cache.get(i); };
  for (let i = startIdx; i <= asOfIdx; i++) {
    const s = snapAt(i);
    series.push({ date: s.date, composite: round(s.composite, 1), real_rate_path: round(s.groups.real_rate_path?.score, 1), anchor: round(s.groups.anchor?.score, 1), plumbing: round(s.groups.plumbing?.score, 1), corr: round(s.metrics.gold_real_corr_60d?.value, 3), crisis: s.crisis.on, intervention: s.intervention.on, raw_band: s.raw_band });
  }
  const now = snapAt(asOfIdx);
  const weekAgo = snapAt(Math.max(0, asOfIdx - 5));

  // settlement replay over the full lookback (older history would need the same; keep deterministic)
  const settlementIdx = settlementRows(daily, startIdx, asOfIdx);
  const settlements = settlementIdx.map((i) => { const s = snapAt(i); return { date: s.date, composite: s.composite, crisis: s.crisis.on, intervention: s.intervention.on }; });
  const settled = settle(settlements, config);
  let effBand = settled.state.band;
  let bandNote = "";
  if (now.intervention.on) { effBand = config.bands.length - 1; bandNote = "intervention_flag ON → overlay 置满（跳过滞回）"; }
  const alloc = bandToAllocation(effBand, config);
  const pending = now.raw_band !== null && now.raw_band !== effBand;
  const addsFrozen = now.crisis.on && !now.intervention.on;
  const lastSettlement = settled.history.length ? settled.history[settled.history.length - 1] : null;
  const nextFriday = (() => { const d = now.date; const k = (5 - dow(d) + 7) % 7; return addDays(d, k === 0 ? 0 : k); })();

  // group cards: week change + top-2 contributors (by weight*|score-50| ... use weight*score contribution)
  const subscores = {};
  for (const [gid, g] of Object.entries(now.groups)) {
    const members = g.members.map((id) => now.metrics[id]).filter((m) => isNum(m.score) && m.weight_used > 0);
    const contrib = members.map((m) => ({ id: m.id, name: m.name, score: round(m.score, 0), value: round(m.value, 2), unit: m.unit, contribution: round((m.weight_used / g.sumW) * (m.score - 50), 1) }))
      .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
    subscores[gid] = { label: g.label, label_zh: g.label_zh, weight: g.weight, score: round(g.score, 1), week_change: (isNum(g.score) && isNum(weekAgo.groups[gid]?.score)) ? round(g.score - weekAgo.groups[gid].score, 1) : null, top2: contrib.slice(0, 2), n_active: members.length, n_total: g.members.length };
  }

  // gold decomposition
  const model = goldModel(ctx);
  const decomposition = [];
  if (isNum(model.a)) {
    for (let i = startIdx; i <= asOfIdx; i++) {
      const g = daily.asOf("gold_spot", i).value, r = daily.asOf("DFII10", i).value;
      const mp = isNum(r) ? Math.exp(model.a + model.b * r) : null;
      decomposition.push({ date: daily.dates[i], gold: round(g, 1), model: round(mp, 1), premium: (isNum(g) && isNum(mp)) ? round(g - mp, 1) : null });
    }
  }
  // corr flips
  const flips = [];
  // a "flip" = sign change that then holds for at least 5 trading days (filters the noise around zero)
  for (let k = 1; k < series.length; k++) {
    const a = series[k - 1].corr, b = series[k].corr;
    if (!isNum(a) || !isNum(b) || Math.sign(a) === Math.sign(b) || b === 0) continue;
    const hold = series.slice(k, k + 5).every((p) => isNum(p.corr) && Math.sign(p.corr) === Math.sign(b));
    if (hold) flips.push({ date: series[k].date, to: b > 0 ? "positive" : "negative", corr: b });
  }

  // real curve
  const curve = ["DFII5", "DFII10", "DFII30"].map((s) => ({ tenor: s.replace("DFII", "") + "y", now: round(daily.asOf(s, asOfIdx).value, 2), m1: round(daily.asOfBack(s, asOfIdx, 21).value, 2), m3: round(daily.asOfBack(s, asOfIdx, 63).value, 2) }));

  // anchor + plumbing panels
  const chg = (s, n, scale = 1) => { const a = daily.asOf(s, asOfIdx), b = daily.asOfBack(s, asOfIdx, n); return (isNum(a.value) && isNum(b.value)) ? round((a.value - b.value) * scale, 2) : null; };
  const spread2s30s = (i) => { const a = daily.asOf("DGS30", i).value, b = daily.asOf("DGS2", i).value; return (isNum(a) && isNum(b)) ? (a - b) * 100 : null; };
  const anchorPanel = [
    { id: "T10YIE", label: "10y breakeven", value: round(daily.asOf("T10YIE", asOfIdx).value, 2), unit: "%", chg20: chg("T10YIE", 20, 100), chg60: chg("T10YIE", 60, 100), chg_unit: "bp" },
    { id: "T5YIFR", label: "5y5y forward", value: round(daily.asOf("T5YIFR", asOfIdx).value, 2), unit: "%", chg20: chg("T5YIFR", 20, 100), chg60: chg("T5YIFR", 60, 100), chg_unit: "bp" },
    { id: "ACMTP10", label: "ACM 10y term premium", value: round(daily.asOf("ACMTP10", asOfIdx).value, 2), unit: "%", chg20: chg("ACMTP10", 20, 100), chg60: chg("ACMTP10", 60, 100), chg_unit: "bp" },
    { id: "2s30s", label: "2s30s", value: round(spread2s30s(asOfIdx), 0), unit: "bp", chg20: round(spread2s30s(asOfIdx) - spread2s30s(Math.max(0, asOfIdx - 20)), 0), chg60: round(spread2s30s(asOfIdx) - spread2s30s(Math.max(0, asOfIdx - 60)), 0), chg_unit: "bp" },
    { id: "DTWEXBGS", label: "Broad dollar", value: round(daily.asOf("DTWEXBGS", asOfIdx).value, 2), unit: "", chg20: (() => { const a = daily.asOf("DTWEXBGS", asOfIdx).value, b = daily.asOfBack("DTWEXBGS", asOfIdx, 20).value; return (isNum(a) && isNum(b)) ? round((a / b - 1) * 100, 2) : null; })(), chg60: (() => { const a = daily.asOf("DTWEXBGS", asOfIdx).value, b = daily.asOfBack("DTWEXBGS", asOfIdx, 60).value; return (isNum(a) && isNum(b)) ? round((a / b - 1) * 100, 2) : null; })(), chg_unit: "%" },
  ];
  const m = now.metrics;
  const tga = lastObs(ctx.weekly, "WTREGEN", now.date);
  const plumbingPanel = {
    bills_share: { value: round(m.bills_share.value, 2), month: m.bills_share.inputs.month },
    walcl_chg_13w_bn: round(m.walcl_chg_13w.value, 0), walcl_bn: round(m.walcl_chg_13w.inputs.now_bn, 0), walcl_date: m.walcl_chg_13w.inputs.now_date,
    tga_bn: round(tga.value != null ? tga.value / 1000 : null, 0), tga_chg_4w_bn: round(m.tga_chg_4w.value, 0), tga_date: tga.date,
    sofr_iorb_bp: round(m.sofr_iorb_spread.value, 1), sofr: m.sofr_iorb_spread.inputs.sofr, iorb: m.sofr_iorb_spread.inputs.iorb,
    rrp_bn: round(m.rrp_level.value, 1),
    auctions: (m.auction_tail_long.inputs.last3 || []).map((a) => ({ date: a.date, bucket: a.bucket, term: a.term, reopening: a.reopening, high_yield: a.high_yield, btc: a.btc, btc_mean: a.btc_mean, z: a.z, tail_proxy_bp: a.tail_proxy_bp })),
    buyback_long_qtr_bn: round(m.buyback_actual_qtr.value, 2), buyback_all_qtr_bn: m.buyback_actual_qtr.inputs.all_buckets_bn, buyback_ops: m.buyback_actual_qtr.inputs.ops,
    interest_to_receipts: round(m.interest_to_receipts.value, 3), interest_12m_bn: m.interest_to_receipts.inputs.net_interest_12m_bn, receipts_12m_bn: m.interest_to_receipts.inputs.receipts_12m_bn, mts_month: m.interest_to_receipts.inputs.month,
    srf_5d_avg_bn: round(srfAvg5(ctx, now.date), 2),
    foreign_official_chg_12m_bn: round(m.foreign_official_chg_12m.value, 1), foreign_official_month: m.foreign_official_chg_12m.inputs.month,
  };

  // what changed: z-score change vs a week ago, z computed against trailing 252 rows of metric values
  const whatChanged = [];
  for (const md of registry.metrics) {
    const vals = [];
    for (let i = Math.max(startIdx, asOfIdx - 251); i <= asOfIdx; i++) { const v = snapAt(i).metrics[md.id].value; if (isNum(v)) vals.push(v); }
    if (vals.length < 40) continue;
    const mu = mean(vals), sd = std(vals);
    if (!sd) continue;
    const vNow = now.metrics[md.id].value, vThen = weekAgo.metrics[md.id].value;
    if (!isNum(vNow) || !isNum(vThen)) continue;
    const zNow = (vNow - mu) / sd, zThen = (vThen - mu) / sd;
    whatChanged.push({ id: md.id, name: md.name, group: md.group, value_now: round(vNow, 2), value_then: round(vThen, 2), unit: md.unit, z_now: round(zNow, 2), z_then: round(zThen, 2), dz: round(zNow - zThen, 2), score_now: round(now.metrics[md.id].score, 0), score_then: round(weekAgo.metrics[md.id].score, 0) });
  }
  whatChanged.sort((a, b) => Math.abs(b.dz) - Math.abs(a.dz));

  // data status
  const meta = history.meta || {};
  const dataStatus = registry.metrics.map((md) => {
    const r = now.metrics[md.id];
    const srcKey = md.series || ({ dfii10_gap_rstar: "DFII10", real_policy_rate: "EFFR", fed_path_6m: "fed_path_6m", acm_tp10_level: "ACMTP10", curve_2s30s_chg_20d: "DGS30", gold_real_corr_60d: "gold_spot", bills_share: "bills_share", sofr_iorb_spread: "SOFR", rrp_level: "RRPONTSYD", buyback_actual_qtr: "buybacks", auction_tail_long: "auctions_long", interest_to_receipts: "mts_receipts_interest", foreign_official_chg_12m: "foreign_official_bn", cb_gold_purchases_3m: "cb_gold_purchases_3m" })[md.id];
    const mt = meta[srcKey] || {};
    return { id: md.id, name: md.name, group: md.group, value: round(r.value, 3), score: round(r.score, 0), source: srcKey, status: mt.status || (r.manual ? "manual" : "unknown"), endpoint: mt.endpoint || null, last_date: mt.last_date || null, fresh: mt.fresh, error: mt.error || null, stale_rows: isNum(r.stale_rows) ? r.stale_rows : null, stale: r.stale, weight_used: r.weight_used, fallback_used: r.fallback_used || mt.status === "fallback", manual: r.manual, note: mt.note || null };
  });

  const gold = daily.asOf("gold_spot", asOfIdx).value;
  const ath = isNum(config.gold_ath_override) ? config.gold_ath_override : Math.max(...(daily.col("gold_spot") || []).filter(isNum));
  const goldInfo = { spot: round(gold, 1), ath: round(ath, 1), drawdown_pct: (isNum(gold) && isNum(ath)) ? round((gold / ath - 1) * 100, 1) : null, model_price: isNum(model.a) && isNum(daily.asOf("DFII10", asOfIdx).value) ? round(Math.exp(model.a + model.b * daily.asOf("DFII10", asOfIdx).value), 0) : null, ath_source: isNum(config.gold_ath_override) ? "config.gold_ath_override" : "running max of series" };
  goldInfo.premium = (isNum(goldInfo.model_price) && isNum(gold)) ? round(gold - goldInfo.model_price, 0) : null;

  const lastRun = (history.runs || []).slice(-1)[0] || null;

  return {
    as_of: now.date, generated_at: history.generated_at || null, sample: !!history.sample, last_run: lastRun,
    composite: round(now.composite, 1), composite_week_ago: round(weekAgo.composite, 1),
    subscores,
    regime_state: now.regimes, regime_evidence: now.evidence, lead_regime: now.lead_regime, regime_priors: config.regime_priors,
    crisis_flag: now.crisis.on, crisis: now.crisis, intervention_flag: now.intervention.on, intervention: now.intervention,
    band: { raw_band: now.raw_band, settled_band: settled.state.band, effective_band: effBand, pending, adds_frozen: addsFrozen, note: bandNote, candidate: settled.state.candidate, candidate_count: settled.state.count, hysteresis_weeks: config.hysteresis_weeks, post_hold_weeks_left: settled.state.postHold, bands: config.bands, ...alloc },
    last_state_change: settled.state.lastChange, last_settlement: lastSettlement, next_settlement: nextFriday,
    tranches: now.tranches, expression_note: now.expression_note,
    gold: goldInfo, gold_model: { a: round(model.a, 4), b: round(model.b, 4), n: model.n, r2: round(model.r2, 3), window: model.window },
    metrics: now.metrics, series, decomposition, flips, curve, r_star: config.r_star, anchor_panel: anchorPanel, plumbing_panel: plumbingPanel,
    what_changed: whatChanged.slice(0, 5), data_status: dataStatus, settlement_history: settled.history.slice(-26),
    cot: (history.cot || []).slice(-1)[0] || null,
  };
}

/** Text for the "Regime weekly" panel. */
export function weeklySummary(res) {
  if (!res) return "";
  const b = res.band;
  const reg = res.regime_state;
  const parts = [];
  parts.push(`截至 ${res.as_of}：composite ${res.composite}（上周 ${res.composite_week_ago ?? "—"}）。` +
    `Real-rate path ${res.subscores.real_rate_path?.score ?? "—"}，Anchor ${res.subscores.anchor?.score ?? "—"}，Plumbing ${res.subscores.plumbing?.score ?? "—"}。`);
  parts.push(`结算 band：${b.settled_band === null ? "—" : `#${b.settled_band + 1}`}（已投入 ${b.invested_pct}% / 干火药 ${b.dry_powder_pct}%）` +
    (b.pending ? `；日频 composite 落在 band #${b.raw_band + 1}，待确认（连续 ${b.hysteresis_weeks} 个周五）` : "") +
    (b.adds_frozen ? "；crisis_flag ON 且未介入 → overlay 冻结加仓" : "") + (res.intervention_flag ? "；intervention_flag ON → overlay 置满" : "") + "。");
  const ev = ["A", "B", "C", "D"].map((k) => `${k} ${reg[k]?.satisfied ?? 0}/${reg[k]?.total ?? 0}`).join("，");
  parts.push(`路径证据：${ev}；倾向 ${res.lead_regime ?? "—"}（先验 A ${res.regime_priors.A}/B ${res.regime_priors.B}/C ${res.regime_priors.C}/D ${res.regime_priors.D}）。`);
  const tr = Object.entries(res.tranches).map(([k, t]) => `${k} ${t.met ? "✓" : t.near ? "◐" : "✗"}`).join("，");
  parts.push(`三批触发：${tr}。金价 ${res.gold.spot}（ATH −${Math.abs(res.gold.drawdown_pct ?? 0)}%），模型价 ${res.gold.model_price ?? "—"}，溢价 ${res.gold.premium ?? "—"}。`);
  if (res.what_changed.length) parts.push("本周变动最大：" + res.what_changed.slice(0, 3).map((w) => `${w.id} ${w.value_then}→${w.value_now}`).join("；") + "。");
  if (res.expression_note) parts.push("提示：regime 跳变概率在升但未确认——优先考虑凸性表达（长期限黄金看涨、曲线陡峭化头寸），而不是加线性仓位；付的是期权费，不是每年 2% 的 carry。");
  return parts.join("\n");
}

export const _internal = { Table, lastObs, obsBack, trailingSum, metricValue, buildContext, snapshotAt, bandIndex, settlementRows };
