// Synthetic history.json generator (same shape as scripts/snapshot.py output) for engine tests.
// Not real data.  Random walks anchored near the 2026-09 levels in 02_THESIS_AND_REGIMES.md.
export function makeSyntheticHistory({ days = 700, seed = 1, end = "2026-09-11" } = {}) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

  // trading days back from `end` — always start no later than 2005-01-03 so the gold model window is covered
  const dates = [];
  const d = new Date(end + "T00:00:00Z");
  const minStart = new Date("2005-01-03T00:00:00Z");
  while (dates.length < days || d >= minStart) { if (d.getUTCDay() > 0 && d.getUTCDay() < 6) dates.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  dates.reverse();
  const n = dates.length;

  const walk = (endLevel, vol, min = -Infinity, max = Infinity) => {
    const out = new Array(n); let x = endLevel;
    for (let i = n - 1; i >= 0; i--) { out[i] = Math.min(max, Math.max(min, x)); x -= vol * gauss(); }
    return out;
  };
  const dfii10 = walk(2.59, 0.03, -1.2, 3.2);
  // gold: log-linear in DFII10 with slope ~ -0.45 plus its own random premium walk that grows late in the sample
  const prem = walk(0, 0.003);
  const gold = dfii10.map((r, i) => Math.exp(7.9 - 0.45 * r + prem[i] + (i > n - 800 ? (i - (n - 800)) / 800 * 1.0 : 0)));
  const daily = {
    DFII5: dfii10.map((v) => v - 0.29 + 0.05 * gauss()),
    DFII10: dfii10,
    DFII30: dfii10.map((v) => v + 0.46 + 0.05 * gauss()),
    DGS2: walk(4.56, 0.04, 0, 6), DGS10: walk(4.97, 0.04, 0, 6), DGS30: walk(5.37, 0.04, 0, 6.5),
    T10YIE: walk(2.38, 0.015, 1.5, 3.2), T5YIFR: walk(2.30, 0.012, 1.5, 3.2),
    EFFR: walk(3.63, 0.005, 0, 6).map((v) => Math.round(v * 100) / 100), IORB: walk(3.65, 0.004, 0, 6).map((v) => Math.round(v * 100) / 100),
    SOFR: walk(3.62, 0.01, 0, 6), RRPONTSYD: walk(20, 3, 0, 2500), DTWEXBGS: walk(118, 0.3, 90, 135), BAMLH0A0HYM2: walk(2.65, 0.03, 2, 12),
    DEXUSEU: walk(1.16, 0.004, 0.8, 1.6), DEXJPUS: walk(156, 0.6, 75, 165), DEXCHUS: walk(6.71, 0.01, 6, 7.4),
    gold_spot: gold, MOVE: walk(82, 1.5, 40, 200), ACMTP10: walk(1.25, 0.02, -1.5, 3), fed_path_6m: walk(30, 3, -300, 300),
  };
  // only the last ~90 rows of fed_path_6m are "available" (ZQ contract history), engine falls back before that
  for (let i = 0; i < n - 90; i++) daily.fed_path_6m[i] = null;
  // sprinkle a few nulls (holidays / missing prints) — never 0
  for (let k = 0; k < 40; k++) { const c = Object.keys(daily)[Math.floor(rnd() * 5)]; daily[c][Math.floor(rnd() * (n - 10))] = null; }

  // weekly (Wednesdays) H.4.1 in $mn
  const wdates = dates.filter((x) => new Date(x + "T00:00:00Z").getUTCDay() === 3);
  const wn = wdates.length;
  const walkW = (endLevel, vol) => { const out = new Array(wn); let x = endLevel; for (let i = wn - 1; i >= 0; i--) { out[i] = x; x -= vol * gauss(); } return out; };
  const weekly = { WALCL: walkW(6740619, 8000), WTREGEN: walkW(883335, 25000), WRESBAL: walkW(2991310, 30000) };

  // monthly (first-of-month FRED style, plus month-end fiscal rows merged in the same table)
  const months = []; { const m = new Date(dates[0].slice(0, 7) + "-01T00:00:00Z"); const endM = new Date(end.slice(0, 7) + "-01T00:00:00Z"); while (m <= endM) { months.push(m.toISOString().slice(0, 10)); m.setUTCMonth(m.getUTCMonth() + 1); } }
  const mn = months.length;
  const monthEnd = (iso) => { const y = +iso.slice(0, 4), mo = +iso.slice(5, 7); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
  const cpi = new Array(mn), pce = new Array(mn), un = new Array(mn);
  for (let i = 0; i < mn; i++) { cpi[i] = 100 * Math.pow(1.033, (i - mn) / 12) * 334.131 / 100; pce[i] = 130.658 * Math.pow(1.033, (i - mn) / 12); un[i] = 4.1 + 0.3 * Math.sin(i / 7); }
  const monthly = { dates: [], columns: {} };
  const allMonthlyDates = new Set();
  const cols = { CPIAUCSL: {}, PCEPILFE: {}, UNRATE: {}, GDP: {}, OPHNFB: {}, bills_share: {}, receipts_bn: {}, net_interest_bn: {}, net_outlays_bn: {}, foreign_official_bn: {} };
  for (let i = 0; i < mn; i++) {
    const m1 = months[i], me = monthEnd(m1);
    // FRED monthlies are lagged ~6 weeks: drop the last 1-2 months
    if (i < mn - 1) { cols.CPIAUCSL[m1] = cpi[i]; cols.UNRATE[m1] = un[i]; }
    if (i < mn - 2) cols.PCEPILFE[m1] = pce[i];
    if (+m1.slice(5, 7) % 3 === 1 && i < mn - 3) { cols.GDP[m1] = 32486 * Math.pow(1.045, (i - mn) / 12); cols.OPHNFB[m1] = 120 * Math.pow(1.02, (i - mn) / 12); }
    if (i < mn - 1) { cols.bills_share[me] = 22.5 + gauss() * 0.3; cols.receipts_bn[me] = 450 + 80 * gauss(); cols.net_interest_bn[me] = 88 + 6 * gauss(); cols.net_outlays_bn[me] = 600 + 60 * gauss(); }
    if (i < mn - 3) cols.foreign_official_bn[me] = 3850 + 60 * gauss();
    allMonthlyDates.add(m1); allMonthlyDates.add(me);
  }
  monthly.dates = [...allMonthlyDates].sort();
  for (const [c, map] of Object.entries(cols)) monthly.columns[c] = monthly.dates.map((dd) => (dd in map ? map[dd] : null));

  // auctions: monthly 10y/30y nominal, quarterly TIPS
  const auctions = [];
  for (let i = 0; i < mn - 1; i++) {
    const m1 = months[i];
    auctions.push({ date: m1.slice(0, 8) + "12", cusip: "N10" + i, type: "Note", term: "10-Year", bucket: "10y_nominal", high_yield: 4.5 + 0.3 * gauss(), btc: 2.5 + 0.15 * gauss(), reopening: i % 3 !== 0, offering_bn: 39, accepted_bn: 39 });
    auctions.push({ date: m1.slice(0, 8) + "13", cusip: "B30" + i, type: "Bond", term: "30-Year", bucket: "30y_nominal", high_yield: 5.0 + 0.3 * gauss(), btc: 2.4 + 0.15 * gauss(), reopening: i % 3 !== 0, offering_bn: 22, accepted_bn: 22 });
    if (i % 3 === 1) auctions.push({ date: m1.slice(0, 8) + "20", cusip: "T10" + i, type: "TIPS", term: "10-Year", bucket: "10y_tips", high_yield: 2.2 + 0.2 * gauss(), btc: 2.4 + 0.2 * gauss(), reopening: false, offering_bn: 19, accepted_bn: 19 });
  }
  auctions.sort((a, b) => a.date.localeCompare(b.date));
  const buybacks = [];
  for (let i = Math.max(0, mn - 6); i < mn; i++) {
    const m1 = months[i];
    buybacks.push({ date: m1.slice(0, 8) + "10", accepted_bn: 4 + 2 * rnd(), offered_bn: 10, max_bn: 6, maturity_begin: "2040-01-01", maturity_end: "2046-01-01", years_to_begin: 14, n_eligible: 20, n_accepted: 10 });
    buybacks.push({ date: m1.slice(0, 8) + "03", accepted_bn: 12.5, offered_bn: 28, max_bn: 12.5, maturity_begin: "2026-10-15", maturity_end: "2028-08-31", years_to_begin: 0.1, n_eligible: 46, n_accepted: 23 });
  }
  buybacks.sort((a, b) => a.date.localeCompare(b.date));
  const srf = dates.slice(-60).map((x) => ({ date: x, accepted_bn: 0 }));
  const cot = [{ date: "2026-09-08", open_interest: 411227, mm_long: 145804, mm_short: 10832, mm_net: 134972 }];
  const meta = {};
  for (const c of Object.keys(daily)) meta[c] = { status: "live", last_date: dates[n - 1], endpoint: "synthetic", fresh: true, cadence: "daily" };
  meta.gold_spot.status = "fallback"; meta.gold_spot.note = "synthetic";
  return {
    version: 1, sample: true, generated_at: end + "T22:05:00Z",
    daily: { dates, columns: daily }, weekly: { dates: wdates, columns: weekly }, monthly,
    auctions, buybacks, buyback_schedule: [], srf, cot, meta,
    runs: [{ run_at: end + "T22:05:00Z", date: end, ok: Object.keys(daily), failed: [] }],
  };
}
