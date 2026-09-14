// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreFromValues, settle, bandToAllocation, parseExpr, evalExpr, computeAll, scoreMetric, weeklySummary, _internal } from "../engine.js";
import { makeSyntheticHistory } from "./synthetic.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(fs.readFileSync(path.join(here, "..", "03_metrics.json"), "utf8"));
const config = JSON.parse(fs.readFileSync(path.join(here, "..", "config.json"), "utf8"));

// ---------------------------------------------------------------------------
// 04_SIZING_MODEL.md example (2026-09-11 close) — composite ≈ 38 ± 3, band 30–60 → 60% invested
// ---------------------------------------------------------------------------
const EXAMPLE = {
  dfii5_level: 2.30, dfii5_chg_60d: 0.45, dfii10_gap_rstar: 1.59, dfii30_level: 3.05, real_policy_rate: 0.33, fed_path_6m: 30,
  t10yie_level: 2.38, t5yifr_level: 2.30, acm_tp10_level: 1.25, curve_2s30s_chg_20d: -5, dollar_broad_chg_60d: -1.5, gold_real_corr_60d: -0.45,
  bills_share: 22.5, walcl_chg_13w: 80, tga_chg_4w: 50, sofr_iorb_spread: 5, rrp_level: 20, buyback_actual_qtr: 12, auction_tail_long: 1.0,
  interest_to_receipts: 0.21, foreign_official_chg_12m: -80, cb_gold_purchases_3m: 180,
};

test("04 example: per-metric scores match the table", () => {
  const { per } = scoreFromValues(EXAMPLE, registry, config);
  const expect = { dfii5_level: 0, dfii5_chg_60d: 5, dfii10_gap_rstar: 0, dfii30_level: 0, real_policy_rate: 56, fed_path_6m: 20,
    t10yie_level: 48, t5yifr_level: 50, acm_tp10_level: 83, curve_2s30s_chg_20d: 38, dollar_broad_chg_60d: 69, gold_real_corr_60d: 19,
    bills_share: 75, walcl_chg_13w: 70, tga_chg_4w: 38, sofr_iorb_spread: 67, rrp_level: 90, buyback_actual_qtr: 35, auction_tail_long: 67,
    interest_to_receipts: 60, foreign_official_chg_12m: 70, cb_gold_purchases_3m: 60 };
  for (const [id, s] of Object.entries(expect)) assert.ok(Math.abs(per[id].score - s) <= 1.5, `${id}: got ${per[id].score.toFixed(1)} want ${s}`);
});

test("04 example: group scores and composite within ±3, band = 30–60 → 60% invested", () => {
  const { groups, composite } = scoreFromValues(EXAMPLE, registry, config);
  assert.ok(Math.abs(groups.real_rate_path.score - 15) <= 3, "real_rate_path " + groups.real_rate_path.score);
  assert.ok(Math.abs(groups.anchor.score - 47) <= 3, "anchor " + groups.anchor.score);
  assert.ok(Math.abs(groups.plumbing.score - 64) <= 3, "plumbing " + groups.plumbing.score);
  assert.ok(Math.abs(composite - 38) <= 3, "composite " + composite);
  const b = _internal.bandIndex(composite, config.bands);
  assert.equal(b, 1);
  const alloc = bandToAllocation(b, config);
  assert.equal(alloc.invested_pct, 60);
  assert.equal(alloc.dry_powder_pct, 40);
});

test("04 example: a 25bp hike on 9/16 keeps the same band (composite ~36-37)", () => {
  const v = { ...EXAMPLE, real_policy_rate: 0.58, fed_path_6m: 20 };
  const { composite } = scoreFromValues(v, registry, config);
  assert.ok(composite >= 34 && composite <= 40, "composite " + composite);
  assert.equal(_internal.bandIndex(composite, config.bands), 1);
});

test("stale metric (> stale_days_zero_weight trading days) gets weight 0", () => {
  const a = scoreFromValues(EXAMPLE, registry, config, { cb_gold_purchases_3m: 11, foreign_official_chg_12m: 40 });
  assert.equal(a.per.cb_gold_purchases_3m.weight_used, 0);
  assert.equal(a.per.foreign_official_chg_12m.weight_used, 0);
  assert.equal(a.per.bills_share.weight_used, 1.0);
  const b = scoreFromValues(EXAMPLE, registry, config, { cb_gold_purchases_3m: 10 });
  assert.equal(b.per.cb_gold_purchases_3m.weight_used, 0.5);
});

test("scoreMetric piecewise map, both directions, clamps", () => {
  const lo = { direction: "lower_is_bullish", thresholds: { bullish: 0, neutral: 1, bearish: 2 } };
  assert.equal(scoreMetric(-1, lo), 100); assert.equal(scoreMetric(0.5, lo), 75); assert.equal(scoreMetric(1, lo), 50); assert.equal(scoreMetric(1.5, lo), 25); assert.equal(scoreMetric(3, lo), 0);
  const hi = { direction: "higher_is_bullish", thresholds: { bearish: 2.0, neutral: 2.4, bullish: 2.75 } };
  assert.equal(scoreMetric(1, hi), 0); assert.equal(scoreMetric(2.4, hi), 50); assert.equal(scoreMetric(2.75, hi), 100); assert.equal(scoreMetric(null, hi), null);
});

// ---------------------------------------------------------------------------
// Hysteresis: single-week crossing does not switch; two consecutive Fridays do.
// ---------------------------------------------------------------------------
const S = (date, composite, crisis = false, intervention = false) => ({ date, composite, crisis, intervention });
const fridays = (n, start = "2026-01-02") => { const out = []; let d = new Date(start + "T00:00:00Z"); for (let i = 0; i < n; i++) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 7); } return out; };

test("hysteresis: one Friday above the line does not switch band; two consecutive do", () => {
  const f = fridays(6);
  const r = settle([S(f[0], 38), S(f[1], 38), S(f[2], 65), S(f[3], 38), S(f[4], 65), S(f[5], 65)], config);
  const bands = r.history.map((h) => h.band);
  assert.deepEqual(bands, [1, 1, 1, 1, 1, 2]);
  assert.equal(r.state.lastChange, f[5]);
  assert.match(r.history[2].note, /pending 1\/2/);
});

test("hysteresis is symmetric on the way down", () => {
  const f = fridays(5);
  const r = settle([S(f[0], 70), S(f[1], 70), S(f[2], 20), S(f[3], 20), S(f[4], 20)], config);
  assert.deepEqual(r.history.map((h) => h.band), [2, 2, 2, 0, 0]);
});

// ---------------------------------------------------------------------------
// Crisis sequence override
// ---------------------------------------------------------------------------
test("crisis ON + intervention OFF: overlay adds frozen even with composite 85; reductions still allowed", () => {
  const f = fridays(7);
  const r = settle([S(f[0], 45), S(f[1], 45), S(f[2], 85, true), S(f[3], 85, true), S(f[4], 85, true), S(f[5], 10, true), S(f[6], 10, true)], config);
  const bands = r.history.map((h) => h.band);
  assert.deepEqual(bands.slice(0, 5), [1, 1, 1, 1, 1], "adds frozen");
  assert.match(r.history[3].note, /frozen/);
  assert.deepEqual(bands.slice(5), [1, 0], "reduction allowed under crisis");
});

test("intervention ON: overlay straight to max, skipping hysteresis", () => {
  const f = fridays(3);
  const r = settle([S(f[0], 45), S(f[1], 40, true, true), S(f[2], 40, true, true)], config);
  assert.deepEqual(r.history.map((h) => h.band), [1, 3, 3]);
  assert.equal(bandToAllocation(3, config).invested_pct, 100);
  assert.equal(bandToAllocation(3, config).dry_powder_pct, 0);
});

test("after intervention turns OFF, 4-week hold before any downgrade", () => {
  const f = fridays(9);
  const seq = [S(f[0], 45), S(f[1], 45, true, true), S(f[2], 30), S(f[3], 30), S(f[4], 30), S(f[5], 30), S(f[6], 30), S(f[7], 30), S(f[8], 30)];
  const r = settle(seq, config);
  const bands = r.history.map((h) => h.band);
  // f[1] -> top. f[2..5] = 4 weeks hold (composite 30 = band 1 pending), downgrade allowed from f[6] on (needs 2 consecutive already accumulated → switches at f[6])
  assert.equal(bands[1], 3);
  assert.deepEqual(bands.slice(2, 6), [3, 3, 3, 3], "held 4 weeks");
  assert.equal(bands[6], 1, "downgrade after hold");
});

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------
test("expression parser: comparisons, between, AND/OR, calls, near-trigger", () => {
  const env = { get: (n) => ({ x: 2.5, y: -10, z: 0.29, flag: "ON", ON: "ON", "config.manual_intervention.on": true, chg_20d__DFII30: 0.35 })[n] ?? null, call: () => null };
  const ev = (s, near = 0.2) => evalExpr(parseExpr(s.replace(/(chg_\d+[dwm])\(([A-Za-z0-9_]+)\)/g, "$1__$2")), env, near);
  assert.equal(ev("x > 2").ok, true);
  assert.equal(ev("x between 2.0 and 2.6").ok, true);
  assert.equal(ev("x between 2.6 and 3.0").ok, false);
  assert.equal(ev("x between 2.6 and 3.0").near, true, "2.5 is within 20% of range [2.6,3.0]");
  assert.equal(ev("y < -25").ok, false);
  assert.equal(ev("y < -25").near, false);
  assert.equal(ev("y < -11").near, true);
  assert.equal(ev("z > 0.3").near, true);
  assert.equal(ev("flag == ON").ok, true);
  assert.equal(ev("config.manual_intervention.on == true").ok, true);
  assert.equal(ev("x > 2 AND y < 0").ok, true);
  assert.equal(ev("x > 3 OR y < 0").ok, true);
  assert.equal(ev("x > 3 AND y < 0").ok, false);
  assert.equal(ev("x > 2.9 AND y < 0").near, true);
  assert.equal(ev("chg_20d(DFII30) > 0.40").near, true);
  assert.equal(ev("chg_20d(DFII30) > 0.40 AND x < 0").near, false);
  assert.equal(ev("missing > 1").ok, false);
});

// ---------------------------------------------------------------------------
// End-to-end on a synthetic history: no throws, all metrics computed, stale handling, band math
// ---------------------------------------------------------------------------
test("computeAll on synthetic history: full output, every metric has a value, nulls flagged stale", () => {
  const hist = makeSyntheticHistory({ days: 700, seed: 7 });
  const res = computeAll(hist, registry, config, { cb_gold_purchases_tonnes: { "2026-05": 40, "2026-06": 55, "2026-07": 60 } });
  assert.ok(res.composite >= 0 && res.composite <= 100, "composite in range: " + res.composite);
  for (const m of registry.metrics) {
    const r = res.metrics[m.id];
    assert.ok(r, "metric present " + m.id);
    if (m.id === "cb_gold_purchases_3m") continue;
    assert.ok(Number.isFinite(r.value), `${m.id} value ${r.value}`);
    assert.ok(Number.isFinite(r.score), `${m.id} score`);
  }
  assert.equal(typeof res.crisis_flag, "boolean");
  assert.ok(res.series.length > 400);
  assert.ok(res.decomposition.length > 400, "gold model fit + decomposition");
  assert.ok(Number.isFinite(res.gold_model.b) && res.gold_model.b < 0, "log(gold) ~ DFII10 slope negative: " + res.gold_model.b);
  assert.ok(res.settlement_history.length >= 20);
  assert.ok([0, 1, 2, 3].includes(res.band.effective_band));
  assert.ok(Math.abs(res.band.invested_pct - (40 + config.bands[res.band.effective_band].overlay_fraction * 60)) < 0.01);
  assert.ok(res.what_changed.length <= 5);
  assert.equal(res.data_status.length, registry.metrics.length);
  assert.ok(weeklySummary(res).includes("composite"));
  for (const k of ["A", "B", "C", "D"]) assert.ok(res.regime_state[k].total > 0);
});

test("computeAll: a metric whose series stops updating goes stale and drops to weight 0 (page shows 'stale N 天')", () => {
  const hist = makeSyntheticHistory({ days: 400, seed: 3 });
  const col = hist.daily.columns.T5YIFR;
  for (let i = col.length - 15; i < col.length; i++) col[i] = null;   // 15 trading days without data
  const res = computeAll(hist, registry, config);
  const m = res.metrics.t5yifr_level;
  assert.ok(m.stale_rows >= 15, "stale rows " + m.stale_rows);
  assert.equal(m.weight_used, 0);
  assert.ok(Number.isFinite(m.value), "still carries last valid value");
  const ok = res.metrics.t10yie_level;
  assert.equal(ok.weight_used, 1.0);
});

test("computeAll: manual intervention switch in config forces overlay to max today", () => {
  const hist = makeSyntheticHistory({ days: 400, seed: 5 });
  const cfg = { ...config, manual_intervention: { on: true, date: "2026-09-01", note: "test" } };
  const res = computeAll(hist, registry, cfg);
  assert.equal(res.intervention_flag, true);
  assert.equal(res.band.effective_band, 3);
  assert.equal(res.band.invested_pct, 100);
  assert.equal(res.tranches.crisis.met, true);
});

test("history.json null days: explicit null row keeps the table aligned and does not become 0", () => {
  const hist = makeSyntheticHistory({ days: 300, seed: 1 });
  const last = hist.daily.dates.length - 1;
  for (const c of Object.keys(hist.daily.columns)) hist.daily.columns[c][last] = null;
  const res = computeAll(hist, registry, config);
  assert.equal(res.as_of, hist.daily.dates[last]);
  assert.ok(res.metrics.dfii5_level.stale_rows === 1);
  assert.ok(res.metrics.dfii5_level.value !== 0 && Number.isFinite(res.metrics.dfii5_level.value));
});
