import { computeAll, weeklySummary } from "./engine.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const fmt = (v, d = 2, unit = "") => (isNum(v) ? v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) + unit : "—");
const sgn = (v, d = 1, unit = "") => (isNum(v) ? (v > 0 ? "+" : "") + fmt(v, d, unit) : "—");
const cls = (v) => (isNum(v) ? (v > 0 ? "pos" : v < 0 ? "neg" : "") : "");
const UNIT = { pct: "%", pct_points: "pp", bp: "bp", usd_bn: "bn", corr: "", ratio: "", tonnes: "t" };

async function loadJSON(p) { const r = await fetch(p + "?t=" + Date.now()); if (!r.ok) throw new Error(p + " " + r.status); return r.json(); }

function readLocal(k, fallback) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } }
function writeLocal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } }

// ---------------------------------------------------------------------------
// tiny SVG line chart with crosshair tooltip
// ---------------------------------------------------------------------------
function lineChart(el, { series, height = 220, yFmt = (v) => fmt(v, 1), refLines = [], bands = [], markers = [], legend = true, yDomain = null }) {
  el.classList.add("chart");
  const W = 720, H = height, m = { l: 44, r: 12, t: 10, b: 24 };
  const pts = series.flatMap((s) => s.data.filter((d) => isNum(d[1])));
  if (!pts.length) { el.innerHTML = '<p class="muted">无数据</p>'; return; }
  const dates = [...new Set(series.flatMap((s) => s.data.map((d) => d[0])))].sort();
  const x = (d) => m.l + (dates.indexOf(d) / Math.max(1, dates.length - 1)) * (W - m.l - m.r);
  let lo = Math.min(...pts.map((p) => p[1]), ...refLines.map((r) => r.y)), hi = Math.max(...pts.map((p) => p[1]), ...refLines.map((r) => r.y));
  if (yDomain) [lo, hi] = yDomain;
  if (lo === hi) { lo -= 1; hi += 1; }
  if (!yDomain) { const pad = (hi - lo) * 0.06; lo -= pad; hi += pad; }
  const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const niceStep = (span) => { const raw = span / 4, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
  const step = niceStep(hi - lo); const ys = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ys.push(+v.toFixed(10));
  const xt = []; for (let i = 0; i < dates.length; i += Math.ceil(dates.length / 5)) xt.push(dates[i]);
  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="height:${H}px">`;
  for (const b of bands) svg += `<rect x="${x(b.from)}" y="${m.t}" width="${Math.max(1, x(b.to) - x(b.from))}" height="${H - m.t - m.b}" fill="${b.color}" opacity="0.12"/>`;
  for (const v of ys) svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 6}" y="${y(v) + 3}" text-anchor="end">${yFmt(v)}</text>`;
  for (const d of xt) svg += `<text class="axis" x="${x(d)}" y="${H - 6}" text-anchor="middle">${d.slice(0, 7)}</text>`;
  for (const r of refLines) svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(r.y)}" y2="${y(r.y)}"/><text class="axis" x="${W - m.r}" y="${y(r.y) - 3}" text-anchor="end">${esc(r.label)}</text>`;
  for (const s of series) {
    let dp = "", pen = false;
    for (const [d, v] of s.data) { if (!isNum(v)) { pen = false; continue; } dp += (pen ? "L" : "M") + x(d).toFixed(1) + " " + y(v).toFixed(1); pen = true; }
    svg += `<path class="ln" d="${dp}" stroke="${s.color}" ${s.dash ? 'stroke-dasharray="5 4"' : ""} vector-effect="non-scaling-stroke"/>`;
  }
  for (const mk of markers) svg += `<circle cx="${x(mk.date)}" cy="${y(mk.y)}" r="4" fill="${mk.color}" stroke="var(--surface)" stroke-width="2"/>`;
  svg += `<line id="xh" class="ref" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" style="display:none"/></svg><div class="tip"></div>`;
  el.innerHTML = svg + (legend && series.length > 1 ? `<div class="legend">${series.map((s) => `<span><i style="border-color:${s.color}" class="${s.dash ? "dash" : ""}"></i>${esc(s.name)}</span>`).join("")}</div>` : "");
  const svgEl = el.querySelector("svg"), tip = el.querySelector(".tip"), xh = el.querySelector("#xh");
  const byDate = new Map(dates.map((d) => [d, series.map((s) => { const f = s.data.find((p) => p[0] === d); return f ? f[1] : null; })]));
  const move = (ev) => {
    const r = svgEl.getBoundingClientRect(); const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * W;
    const i = Math.round(((px - m.l) / (W - m.l - m.r)) * (dates.length - 1));
    if (i < 0 || i >= dates.length) return;
    const d = dates[i]; const vals = byDate.get(d);
    xh.setAttribute("x1", x(d)); xh.setAttribute("x2", x(d)); xh.style.display = "";
    tip.style.display = "block"; tip.innerHTML = `<b>${d}</b>` + series.map((s, k) => `<div><i style="color:${s.color}">■</i> ${esc(s.name)} <b class="num">${isNum(vals[k]) ? (s.fmt || yFmt)(vals[k]) : "—"}</b></div>`).join("");
    const left = (x(d) / W) * r.width; tip.style.left = Math.min(r.width - tip.offsetWidth - 4, Math.max(0, left + 8)) + "px"; tip.style.top = "6px";
  };
  svgEl.addEventListener("mousemove", move); svgEl.addEventListener("touchstart", move, { passive: true }); svgEl.addEventListener("touchmove", move, { passive: true });
  svgEl.addEventListener("mouseleave", () => { tip.style.display = "none"; xh.style.display = "none"; });
}

// ---------------------------------------------------------------------------
// renderers
// ---------------------------------------------------------------------------
const BAND_LABEL = (i, bands) => i === null ? "—" : `${i === 0 ? 0 : bands[i - 1].max}–${bands[i].max}`;

function renderHeader(r, cfg) {
  const b = r.band;
  const flags = `<span class="flag ${r.crisis_flag ? "on" : ""}">crisis ${r.crisis_flag ? "ON" : "OFF"}</span><span class="flag ${r.intervention_flag ? "on good" : ""}">Fed intervention ${r.intervention_flag ? "ON" : "OFF"}</span>`;
  const reg = ["A", "B", "C", "D"].map((k) => { const s = r.regime_state[k]; const name = { A: "缓慢转向", B: "危机/信用", C: "联储被俘", D: "AI 通缩" }[k]; return `<div class="regime ${r.lead_regime === k ? "lead" : ""}"><b>${k} <span class="num">${s.satisfied}/${s.total}</span>${s.near ? `<span class="near"> ◐${s.near}</span>` : ""}</b>${name}<br><span class="muted">先验 ${Math.round((s.prior ?? 0) * 100)}%</span></div>`; }).join("");
  const tr = Object.entries(r.tranches).map(([k, t]) => { const nm = { price: "价格批 ~15%（金价 ≤ 4,000）", signal: "信号批 ~15%（相关翻正 / BE>2.6 / 实际政策利率<0 / 核心PCE>3 时转降息）", crisis: "危机批（剩余，仅 intervention ON 后）" }[k] || k; return `<div class="check"><span class="m ${t.met ? "ok" : t.near ? "near" : "no"}">${t.met ? "✓" : t.near ? "◐" : "·"}</span><span>${nm}</span></div>`; }).join("");
  const investedNote = b.pending ? `<span class="wrn">日频 composite 在 band ${BAND_LABEL(b.raw_band, b.bands)}，待确认（连续 ${b.hysteresis_weeks} 个周五）</span>` : `<span class="muted">日频 composite 与结算 band 一致</span>`;
  $("#header").innerHTML = `
    <div class="hdr">
      <div><div class="score num">${fmt(r.composite, 0)}<small>/100</small></div><div class="muted" style="font-size:12px">上周 ${fmt(r.composite_week_ago, 0)} · <span class="${cls(r.composite - r.composite_week_ago)}">${sgn(r.composite - r.composite_week_ago, 1)}</span></div></div>
      <div class="kv">
        <span class="dim">Flags</span><span>${flags}</span>
        <span class="dim">结算 band</span><span><b>${BAND_LABEL(b.effective_band, b.bands)}</b> · ${investedNote}${b.adds_frozen ? ' · <span class="neg">crisis ON 未介入：冻结加仓</span>' : ""}${b.note ? ` · <span class="pos">${esc(b.note)}</span>` : ""}</span>
        <span class="dim">上次切换</span><span class="num">${r.last_state_change ?? "—"}</span>
        <span class="dim">本周结算</span><span class="num">${r.next_settlement}${r.last_settlement ? ` <span class="muted">（上次结算 ${r.last_settlement.date}：${r.last_settlement.composite}${r.last_settlement.note ? "，" + esc(r.last_settlement.note) : ""}）</span>` : ""}</span>
        <span class="dim">金价</span><span class="num">${fmt(r.gold.spot, 0)} · ATH ${fmt(r.gold.ath, 0)} · 回撤 ${fmt(r.gold.drawdown_pct, 1, "%")}</span>
      </div>
    </div>
    <div class="alloc">
      <div style="display:flex;justify-content:space-between;font-size:13px"><span><b>已投入 ${fmt(b.invested_pct, 0, "%")}</b> <span class="muted">= base ${b.base_pct}% + overlay ${fmt(b.overlay_pct, 0, "%")}</span></span><span><b>干火药 ${fmt(b.dry_powder_pct, 0, "%")}</b> <span class="muted">短期 TIPS / bills</span></span></div>
      <div class="bar" style="margin-top:6px"><div class="base" style="width:${b.base_pct}%">base</div>${b.overlay_pct > 0 ? `<div class="ovl" style="width:${b.overlay_pct}%">overlay</div>` : ""}<div class="dry" style="flex:1">干火药</div></div>
      <div class="muted" style="font-size:11px;margin-top:4px">分母是黄金专用资金，不是总组合。bands：${b.bands.map((x, i) => `${BAND_LABEL(i, b.bands)}→${Math.round(cfg.base_pct + x.overlay_fraction * cfg.overlay_max_pct)}%`).join("，")}</div>
    </div>
    <div class="regimes">${reg}</div>
    <div style="margin-top:10px"><div class="dim" style="font-size:12px">干火药三批触发</div>${tr}</div>
    ${r.expression_note ? `<div class="banner" style="margin-top:10px">regime 跳变概率在升但未确认——优先考虑凸性表达（长期限黄金看涨、曲线陡峭化头寸），而不是加线性仓位；付的是期权费，不是每年 2% 的 carry。</div>` : ""}`;
}

function renderSubscores(r) {
  $("#subscores").innerHTML = Object.entries(r.subscores).map(([g, s]) => `<div class="card"><div class="t">${esc(s.label_zh)}<br><span class="muted">${esc(s.label)} · ${Math.round(s.weight * 100)}%</span></div><div class="v num">${fmt(s.score, 0)}</div><div class="d num ${cls(s.week_change)}">${sgn(s.week_change, 1)} <span class="muted">周</span>${s.n_active < s.n_total ? ` <span class="wrn">${s.n_total - s.n_active} 项权重 0</span>` : ""}</div><div class="top">${s.top2.map((t) => `${esc(t.id)} ${fmt(t.value, 2)} → <b>${t.score}</b>`).join("<br>")}</div></div>`).join("");
}

function renderDecomp(r) {
  const d = r.decomposition;
  if (!d.length) { $("#chart-decomp").innerHTML = '<p class="muted">拟合窗口内数据不足</p>'; return; }
  lineChart($("#chart-decomp"), { height: 240, yFmt: (v) => fmt(v, 0), series: [
    { name: "金价 (GC=F)", color: "var(--gold)", data: d.map((p) => [p.date, p.gold]), fmt: (v) => fmt(v, 0) },
    { name: "模型价 exp(a+b·DFII10)", color: "var(--s1)", data: d.map((p) => [p.date, p.model]), fmt: (v) => fmt(v, 0) },
    { name: "溢价 (residual)", color: "var(--s2)", dash: true, data: d.map((p) => [p.date, p.premium]), fmt: (v) => fmt(v, 0) },
  ] });
  const gm = r.gold_model;
  $("#decomp-note").innerHTML = `log(gold) = ${fmt(gm.a, 3)} ${gm.b < 0 ? "−" : "+"} ${fmt(Math.abs(gm.b), 3)}·DFII10，样本 ${gm.window.start}→${gm.window.end}（n=${gm.n}，R²=${fmt(gm.r2, 2)}）。当前 DFII10 ${fmt(r.metrics.dfii10_gap_rstar.inputs.DFII10, 2)}% → 模型价 <b class="num">${fmt(r.gold.model_price, 0)}</b>，实际 <b class="num">${fmt(r.gold.spot, 0)}</b>，溢价 <b class="num">${fmt(r.gold.premium, 0)}</b>。读法：边际回撤是实际收益率的账，价格水平是溢价的账。${r.gold.ath_source === "running max of series" ? "" : "（ATH 用 config 覆盖值）"}`;
}

function renderCorr(r) {
  const s = r.series;
  lineChart($("#chart-corr"), { height: 200, yDomain: [-1, 1], yFmt: (v) => fmt(v, 1), refLines: [{ y: 0.3, label: "flip 阈值 0.3" }, { y: 0, label: "" }],
    series: [{ name: "corr_60d", color: "var(--s7)", data: s.map((p) => [p.date, p.corr]), fmt: (v) => fmt(v, 2) }],
    markers: r.flips.filter((f) => f.to === "positive").map((f) => ({ date: f.date, y: f.corr, color: "var(--s2)" })) });
  const last = r.flips.slice(-4).map((f) => `${f.date} → ${f.to === "positive" ? "翻正" : "转负"}`).join("；");
  $("#corr-note").innerHTML = `当前 <b class="num">${fmt(r.metrics.gold_real_corr_60d.value, 2)}</b>（正常为负；翻正 > 0.3 且 30y 名义上行、breakeven 上行 = 市场开始定价加息不可持续）。最近符号翻转：${last || "无"}。橙点 = 翻正日。`;
}

function renderComposite(r) {
  const s = r.series;
  const bands = [];
  for (const h of r.settlement_history) bands.push(h);
  lineChart($("#chart-comp"), { height: 200, yDomain: [0, 100], yFmt: (v) => fmt(v, 0), refLines: r.band.bands.slice(0, -1).map((b) => ({ y: b.max, label: String(b.max) })),
    series: [
      { name: "composite", color: "var(--ink)", data: s.map((p) => [p.date, p.composite]), fmt: (v) => fmt(v, 1) },
      { name: "real-rate path", color: "var(--s1)", dash: true, data: s.map((p) => [p.date, p.real_rate_path]), fmt: (v) => fmt(v, 0) },
      { name: "anchor", color: "var(--s3)", dash: true, data: s.map((p) => [p.date, p.anchor]), fmt: (v) => fmt(v, 0) },
      { name: "plumbing", color: "var(--s2)", dash: true, data: s.map((p) => [p.date, p.plumbing]), fmt: (v) => fmt(v, 0) },
    ] });
}

function renderCurve(r) {
  const c = r.curve;
  const rows = c.map((t) => `<tr><td>${t.tenor}</td><td class="num">${fmt(t.now, 2)}</td><td class="num">${fmt(t.m1, 2)}</td><td class="num">${fmt(t.m3, 2)}</td><td class="num ${cls(t.now - t.m3)}">${sgn((t.now - t.m3) * 100, 0, "bp")}</td></tr>`).join("");
  $("#curve-table").innerHTML = `<table><tr><th>TIPS</th><th>现在</th><th>1 个月前</th><th>3 个月前</th><th>3m Δ</th></tr>${rows}<tr><td class="muted">r*</td><td class="num muted">${fmt(r.r_star, 2)}</td><td colspan="3" class="muted" style="text-align:left">config.r_star；10y − r* = ${fmt(r.metrics.dfii10_gap_rstar.value, 2)}pp</td></tr></table>`;
  const el = $("#chart-curve"); el.classList.add("chart");
  const W = 360, H = 170, m = { l: 36, r: 10, t: 12, b: 22 };
  const xs = [0, 1, 2], vals = c.flatMap((t) => [t.now, t.m1, t.m3, r.r_star]).filter(isNum);
  let lo = Math.min(...vals) - 0.2, hi = Math.max(...vals) + 0.2;
  const x = (i) => m.l + (i / 2) * (W - m.l - m.r), y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  const line = (key, color, dash) => `<path class="ln" stroke="${color}" ${dash ? 'stroke-dasharray="5 4"' : ""} d="${c.map((t, i) => (i ? "L" : "M") + x(i) + " " + y(t[key])).join("")}"/>` + c.map((t, i) => `<circle cx="${x(i)}" cy="${y(t[key])}" r="3.5" fill="${color}"/>`).join("");
  let svg = `<svg viewBox="0 0 ${W} ${H}" style="height:${H}px">`;
  for (let k = 0; k <= 3; k++) { const v = lo + (k / 3) * (hi - lo); svg += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${m.l - 5}" y="${y(v) + 3}" text-anchor="end">${fmt(v, 1)}</text>`; }
  svg += `<line class="ref" x1="${m.l}" x2="${W - m.r}" y1="${y(r.r_star)}" y2="${y(r.r_star)}"/><text class="axis" x="${W - m.r}" y="${y(r.r_star) - 3}" text-anchor="end">r* ${fmt(r.r_star, 1)}</text>`;
  svg += line("m3", "var(--line-2)", true) + line("m1", "var(--s3)", true) + line("now", "var(--s1)", false);
  c.forEach((t, i) => { svg += `<text class="axis" x="${x(i)}" y="${H - 6}" text-anchor="middle">${t.tenor}</text>`; });
  svg += "</svg>";
  el.innerHTML = svg + `<div class="legend"><span><i style="border-color:var(--s1)"></i>现在</span><span><i class="dash" style="border-color:var(--s3)"></i>1 个月前</span><span><i class="dash" style="border-color:var(--line-2)"></i>3 个月前</span></div>`;
}

function renderAnchor(r) {
  $("#anchor").innerHTML = `<table><tr><th>指标</th><th>当前</th><th>20 日</th><th>60 日</th></tr>${r.anchor_panel.map((a) => `<tr><td>${esc(a.label)} <span class="muted">${a.id}</span></td><td class="num">${fmt(a.value, a.unit === "bp" ? 0 : 2)}${a.unit}</td><td class="num ${cls(a.chg20)}">${sgn(a.chg20, a.chg_unit === "%" ? 2 : 0, a.chg_unit)}</td><td class="num ${cls(a.chg60)}">${sgn(a.chg60, a.chg_unit === "%" ? 2 : 0, a.chg_unit)}</td></tr>`).join("")}</table>`;
}

function renderPlumbing(r) {
  const p = r.plumbing_panel;
  const kv = [
    ["Bills 占可流通债务", `${fmt(p.bills_share.value, 2, "%")} <span class="muted">${p.bills_share.month}</span>`],
    ["Fed 资产负债表 13 周变化", `<span class="${cls(p.walcl_chg_13w_bn)}">${sgn(p.walcl_chg_13w_bn, 0, "bn")}</span> <span class="muted">总额 ${fmt(p.walcl_bn, 0)}bn · ${p.walcl_date}</span>`],
    ["TGA 及 4 周变化", `${fmt(p.tga_bn, 0)}bn · <span class="${cls(p.tga_chg_4w_bn)}">${sgn(p.tga_chg_4w_bn, 0, "bn")}</span> <span class="muted">${p.tga_date}</span>`],
    ["SOFR − IORB（5 日均）", `<span class="${cls(p.sofr_iorb_bp)}">${sgn(p.sofr_iorb_bp, 1, "bp")}</span> <span class="muted">SOFR ${fmt(p.sofr, 2)} / IORB ${fmt(p.iorb, 2)}</span>`],
    ["ON RRP", `${fmt(p.rrp_bn, 1)}bn`],
    ["SRF 用量（5 日均）", `${fmt(p.srf_5d_avg_bn, 2)}bn`],
    ["长端 buyback 当季接受额", `${fmt(p.buyback_long_qtr_bn, 2)}bn <span class="muted">全部桶 ${fmt(p.buyback_all_qtr_bn, 1)}bn · ${(p.buyback_ops || []).length} 次长端操作</span>`],
    ["利息支出 / 收入（12 个月）", `${fmt(p.interest_to_receipts, 3)} <span class="muted">${fmt(p.interest_12m_bn, 0)} / ${fmt(p.receipts_12m_bn, 0)}bn · 至 ${p.mts_month}</span>`],
    ["外国官方持有 12 个月变化", `<span class="${cls(p.foreign_official_chg_12m_bn)}">${sgn(p.foreign_official_chg_12m_bn, 0, "bn")}</span> <span class="muted">数据月 ${p.foreign_official_month}</span>`],
  ];
  const auc = p.auctions.map((a) => `<tr><td>${a.date}<br><span class="muted">${esc(a.bucket)}${a.reopening ? " 重开" : ""}</span></td><td class="num">${fmt(a.high_yield, 3)}%</td><td class="num">${fmt(a.btc, 2)} <span class="muted">/ ${fmt(a.btc_mean, 2)}</span></td><td class="num ${cls(-a.z)}">${sgn(a.z, 2)}</td><td class="num">${sgn(a.tail_proxy_bp, 2, "bp")}</td></tr>`).join("");
  $("#plumbing").innerHTML = `<div class="kv" style="grid-template-columns:auto 1fr;gap:6px 12px">${kv.map(([k, v]) => `<span class="dim">${k}</span><span class="num">${v}</span>`).join("")}</div>
    <div class="dim" style="margin:12px 0 4px;font-size:12px">最近 3 次长端拍卖（tail 替代口径：bid-to-cover 相对该期限过去 12 次均值的 z-score × ${r.metrics.auction_tail_long.inputs.last3 ? "1" : "1"}bp/σ，取负号；没有 WI 收益率）</div>
    <div class="tbl-wrap"><table><tr><th>日期</th><th>高收益</th><th>BTC / 均值</th><th>z</th><th>tail 替代</th></tr>${auc || '<tr><td colspan="5" class="muted">无</td></tr>'}</table></div>
    ${r.cot ? `<div class="muted" style="font-size:12px;margin-top:8px">COT（仅上下文）：Managed Money 净多 ${fmt(r.cot.mm_net, 0)} 手（${r.cot.date}，多 ${fmt(r.cot.mm_long, 0)} / 空 ${fmt(r.cot.mm_short, 0)}）</div>` : ""}`;
}

function renderTriggers(r) {
  const names = { A: "A 缓慢转向", B: "B 危机 / 信用事件", C: "C 联储被俘", D: "D AI 生产率通缩" };
  const fmtV = (v) => (isNum(v) ? fmt(v, 2) : Array.isArray(v) ? v.join("–") : v == null ? "—" : String(v));
  let html = "";
  for (const k of ["A", "B", "C", "D"]) {
    const s = r.regime_state[k];
    html += `<div style="margin-bottom:10px"><div style="font-size:13px"><b>${names[k]}</b> <span class="num">${s.satisfied}/${s.total}</span>${s.near ? ` <span class="near">◐ ${s.near}</span>` : ""} <span class="muted">先验 ${Math.round((s.prior ?? 0) * 100)}% · 证据 ${Math.round((r.regime_evidence[k] ?? 0) * 100)}%</span></div>` +
      s.triggers.map((t) => `<div class="check"><span class="m ${t.ok ? "ok" : t.near ? "near" : "no"}">${t.ok ? "✓" : t.near ? "◐" : "·"}</span><span><code style="font-size:12px">${esc(t.expr)}</code> <span class="muted num">${t.lhs != null ? "= " + fmtV(t.lhs) : ""}${t.error ? ' <span class="neg">' + esc(t.error) + "</span>" : ""}</span></span></div>`).join("") + "</div>";
  }
  const fl = (title, f) => `<div style="margin-bottom:10px"><div style="font-size:13px"><b>${title}</b> <span class="${f.on ? "neg" : "muted"}">${f.on ? "ON" : "OFF"}</span></div>` + f.conditions.map((c) => `<div class="check"><span class="m ${c.ok ? "ok" : "no"}">${c.ok ? "✓" : "·"}</span><span><code style="font-size:12px">${esc(c.expr)}</code> <span class="muted num">${c.lhs != null ? "= " + fmtV(c.lhs) : ""}</span></span></div>`).join("") + "</div>";
  html += fl(`crisis_flag（≥ ${r.crisis.min_true} 条为真）`, r.crisis) + fl("intervention_flag（任一为真）", r.intervention);
  $("#triggers").innerHTML = html;
}

function renderChanged(r) {
  $("#changed").innerHTML = `<table><tr><th>指标</th><th>上周</th><th>本周</th><th>z 上周→本周</th><th>Δz</th><th>分</th></tr>${r.what_changed.map((w) => `<tr><td>${esc(w.id)}<br><span class="muted">${esc(w.name)}</span></td><td class="num">${fmt(w.value_then, 2)}</td><td class="num">${fmt(w.value_now, 2)}</td><td class="num">${fmt(w.z_then, 2)} → ${fmt(w.z_now, 2)}</td><td class="num ${cls(w.dz)}">${sgn(w.dz, 2)}</td><td class="num">${w.score_then} → ${w.score_now}</td></tr>`).join("") || '<tr><td colspan="6" class="muted">历史不足</td></tr>'}</table>`;
}

function renderStatus(r, status) {
  const rows = r.data_status.map((d) => {
    const st = d.stale ? "stale" : d.status;
    return `<tr><td>${esc(d.id)}<br><span class="muted">${esc(d.source || "")}</span></td><td><span class="pill ${st}">${d.stale ? `stale ${d.stale_rows} 天` : d.status}</span>${d.fallback_used && !d.stale ? ' <span class="pill fallback">fallback</span>' : ""}${d.manual ? ' <span class="pill manual">manual</span>' : ""}</td><td class="num">${d.last_date ?? "—"}</td><td class="num">${d.weight_used}</td><td style="text-align:left;max-width:280px"><span class="muted" style="font-size:11px">${esc(d.error || d.note || "")}</span></td></tr>`;
  }).join("");
  const run = r.last_run;
  const failed = run && run.failed && run.failed.length ? `<span class="neg">上次运行失败的源：${run.failed.join(", ")}</span>` : `<span class="pos">上次运行全部成功</span>`;
  $("#status").innerHTML = `<div class="muted" style="font-size:12px;margin-bottom:6px">history 生成于 ${r.generated_at ?? "—"} · ${run ? `run ${run.date}` : ""} · ${failed}${status && status.checked_at ? ` · endpoint_status ${status.checked_at}` : ""}</div><table><tr><th>指标</th><th>状态</th><th>最后数据</th><th>权重</th><th>备注</th></tr>${rows}</table>`;
}

function renderMetrics(r) {
  $("#metrics").innerHTML = `<table><tr><th>指标</th><th>值</th><th>分</th><th>权重</th><th>阈值 牛/中/熊</th></tr>${Object.values(r.metrics).map((m) => `<tr><td>${esc(m.id)}<br><span class="muted">${esc(m.name)}</span></td><td class="num">${fmt(m.value, m.unit === "ratio" ? 3 : 2)}${UNIT[m.unit] ?? ""}</td><td class="num"><b>${fmt(m.score, 0)}</b>${m.capped ? ' <span class="muted">cap</span>' : ""}</td><td class="num">${m.weight_used}${m.weight_used !== m.weight ? ` <span class="muted">/${m.weight}</span>` : ""}</td><td class="num muted">${m.thresholds.bullish} / ${m.thresholds.neutral} / ${m.thresholds.bearish}</td></tr>`).join("")}</table>`;
}

function renderManual(manual, cfg, rerun) {
  const local = readLocal("grm_manual", null);
  const interv = readLocal("grm_manual_intervention", null);
  $("#manual").innerHTML = `
    <div class="dim" style="font-size:12px">央行净购金（吨，WGC 月报），JSON：月份 → 吨。这里改会存在这台设备的浏览器里并立即生效；要永久生效改 repo 里的 <code>data/manual.json</code> 并 commit。</div>
    <textarea id="wgc">${esc(JSON.stringify((local && local.cb_gold_purchases_tonnes) || manual.cb_gold_purchases_tonnes || {}, null, 1))}</textarea>
    <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap"><button class="primary" id="wgc-apply">应用</button><button id="wgc-reset">恢复 repo 值</button><span id="wgc-msg" class="muted" style="font-size:12px;align-self:center"></span></div>
    <div style="margin-top:14px"><label class="sw"><input type="checkbox" id="mi" ${(interv ? interv.on : cfg.manual_intervention.on) ? "checked" : ""}> manual_intervention（联储宣布 RMP 之外的购买 / 紧急工具 / 收益率目标时打开）</label>
      <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap"><input id="mi-date" placeholder="日期 YYYY-MM-DD" value="${esc((interv && interv.date) || cfg.manual_intervention.date || "")}" style="font:13px var(--mono);padding:5px 8px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface-2);color:var(--ink)"><input id="mi-note" placeholder="备注" value="${esc((interv && interv.note) || cfg.manual_intervention.note || "")}" style="flex:1;font:13px inherit;padding:5px 8px;border:1px solid var(--line-2);border-radius:8px;background:var(--surface-2);color:var(--ink)"><button class="primary" id="mi-apply">应用</button></div>
      <div class="muted" style="font-size:11px;margin-top:4px">repo 里的开关在 <code>config.json → manual_intervention</code>；这里的开关只覆盖本设备。</div></div>`;
  $("#wgc-apply").onclick = () => { try { const v = JSON.parse($("#wgc").value); writeLocal("grm_manual", { cb_gold_purchases_tonnes: v }); $("#wgc-msg").textContent = "已应用（本设备）"; rerun(); } catch (e) { $("#wgc-msg").textContent = "JSON 无效：" + e.message; } };
  $("#wgc-reset").onclick = () => { try { localStorage.removeItem("grm_manual"); } catch { /* */ } rerun(); };
  $("#mi-apply").onclick = () => { writeLocal("grm_manual_intervention", { on: $("#mi").checked, date: $("#mi-date").value || null, note: $("#mi-note").value }); rerun(); };
}

// ---------------------------------------------------------------------------
async function main() {
  let registry, config, history, manual, status;
  try {
    [registry, config, history, manual] = await Promise.all([loadJSON("03_metrics.json"), loadJSON("config.json"), loadJSON("data/history.json"), loadJSON("data/manual.json").catch(() => ({ cb_gold_purchases_tonnes: {} }))]);
    status = await loadJSON("data/endpoint_status.json").catch(() => null);
  } catch (e) {
    $("#asof").innerHTML = `<span class="neg">加载失败：${esc(e.message)}</span>`; return;
  }
  const run = () => {
    const local = readLocal("grm_manual", null);
    const interv = readLocal("grm_manual_intervention", null);
    const cfg = interv ? { ...config, manual_intervention: interv } : config;
    const man = local || manual;
    let r;
    try { r = computeAll(history, registry, cfg, man); } catch (e) { $("#asof").innerHTML = `<span class="neg">引擎错误：${esc(e.message)}</span>`; console.error(e); return; }
    window.__result = r;
    $("#asof").innerHTML = `数据截至 <b class="num">${r.as_of}</b> · 生成 ${r.generated_at ? r.generated_at.replace("T", " ").slice(0, 16) + " UTC" : "—"} · 指标日更，仓位建议每周五结算 · 版本 ${esc(registry.version)}`;
    const banners = [];
    if (r.sample) banners.push('<div class="banner bad">当前是示例数据（sample），第一次 Actions 运行后会被真实 history.json 替换。</div>');
    if (history.bootstrap) banners.push(`<div class="banner">history.json 由浏览器抓取的原始 payload 回填（${esc(history.bootstrap)}）；ACM 期限溢价暂用 FRED THREEFYTP10 代替，第一次 Actions 运行后换成 ACM。</div>`);
    if (r.last_run && r.last_run.failed && r.last_run.failed.length) banners.push(`<div class="banner bad">上次 snapshot 有源失败：${esc(r.last_run.failed.join(", "))}（沿用最近有效值）</div>`);
    const dead = r.data_status.filter((d) => d.stale && !d.manual);
    if (dead.length) banners.push(`<div class="banner bad">stale 超过 ${cfg.stale_days_zero_weight} 个交易日、权重已归零：${esc(dead.map((d) => d.id).join(", "))}</div>`);
    if (interv) banners.push('<div class="banner">本设备上覆盖了 manual_intervention 开关（见"手动输入"）。</div>');
    $("#banners").innerHTML = banners.join("");
    renderHeader(r, cfg); renderSubscores(r); renderDecomp(r); renderCorr(r); renderComposite(r); renderCurve(r); renderAnchor(r); renderPlumbing(r); renderTriggers(r); renderChanged(r);
    $("#weekly").textContent = weeklySummary(r);
    renderManual(man, cfg, run); renderStatus(r, status); renderMetrics(r);
  };
  run();
}
main();
