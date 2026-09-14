#!/usr/bin/env python3
"""
One-off bootstrap: build data/history.json from raw endpoint payloads that were fetched
elsewhere (a browser session) and saved under a dump directory.  Uses exactly the same
parsers and merge logic as snapshot.py, so the file it writes is what the daily Actions
run would produce (minus the ACM .xls, which the first Actions run adds).

  python scripts/ingest_dump.py /tmp/sample

Dump layout (all optional):
  fred*.json      {SERIES: "<raw fredgraph csv text>"}
  yahoo.json      {SYMBOL: <raw yahoo chart json>}
  fiscal.json     {bills:[rows], total:[rows], mts:[rows], dts:[rows]}
  td.json         {auctions:{Note:[..],Bond:[..],TIPS:[..]}, buybacks:{"YYYY-MM-DD": "<xml text>"}, schedule_xml: "<xml>"}
  nyfed.json      {sofr: <json>, srf: <json>}
  tic.json        {slt_table5: "<txt>"}
  cot.json        {f_disagg: "<txt>"}
"""
import datetime as dt
import glob
import json
import os
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import snapshot as S  # noqa: E402

dump = sys.argv[1]
load = lambda n: json.load(open(os.path.join(dump, n))) if os.path.exists(os.path.join(dump, n)) else None  # noqa: E731

hist = S.empty_history()
meta = {}
start = "2003-01-01"
ok, failed = [], []

def status(sid, endpoint, st, last, note="", cadence="daily", n=None):
    meta[sid] = {"endpoint": endpoint, "status": st, "last_date": last, "note": note, "error": None,
                 "checked_at": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z", "cadence": cadence, "fresh": True, "n": n}
    ok.append(sid)

fred_ep = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}"
fred = {}
for f in sorted(glob.glob(os.path.join(dump, "fred*.json"))):
    fred.update(json.load(open(f)))
for sid, txt in fred.items():
    pairs = S.parse_fred_csv(txt, sid)
    if sid in S.FRED_DAILY or sid == "THREEFYTP10":
        tbl, cad = "daily", "daily"
    elif sid in S.FRED_WEEKLY:
        tbl, cad = "weekly", "weekly"
    elif sid in S.FRED_QUARTERLY:
        tbl, cad = "monthly", "quarterly"
    elif sid in S.FRED_MONTHLY:
        tbl, cad = "monthly", "monthly"
    else:
        continue
    col = "ACMTP10" if sid == "THREEFYTP10" else sid
    last = S.merge_series(hist[tbl], col, pairs, start=(start if tbl == "daily" else "2000-01-01"), weekdays_only=(tbl == "daily"))
    if sid == "THREEFYTP10":
        status("ACMTP10", fred_ep.format(id=sid), "fallback", last, "Kim-Wright 10y term premium (FRED THREEFYTP10) used until the first Actions run parses the ACM xls", n=len(pairs))
    else:
        status(sid, fred_ep.format(id=sid), "live", last, cadence=cad, n=len(pairs))

y = load("yahoo.json") or {}
if "GC=F" in y:
    pairs = S.parse_yahoo_chart(y["GC=F"], "GC=F")
    last = S.merge_series(hist["daily"], "gold_spot", pairs, start=start, weekdays_only=True)
    status("gold_spot", "https://query1.finance.yahoo.com/v8/finance/chart/GC=F", "fallback", last, "stooq refused (Access denied); GC=F front-month futures close", n=len(pairs))
if "^MOVE" in y:
    pairs = S.parse_yahoo_chart(y["^MOVE"], "^MOVE")
    last = S.merge_series(hist["daily"], "MOVE", pairs, start=start, weekdays_only=True)
    status("MOVE", "https://query1.finance.yahoo.com/v8/finance/chart/%5EMOVE", "live", last, n=len(pairs))
sym, ym = S.fed_path_contract(6)
if sym in y:
    px = S.parse_yahoo_chart(y[sym], sym)
    effr = {d: v for d, v in zip(hist["daily"]["dates"], hist["daily"]["columns"].get("EFFR", [])) if v is not None}
    eds = sorted(effr)
    pairs = []
    for d, p in px:
        if p is None:
            continue
        e = next((effr[x] for x in reversed(eds) if x <= d), None)
        if e is not None:
            pairs.append((d, round(((100.0 - p) - e) * 100.0, 1)))
    last = S.merge_series(hist["daily"], "fed_path_6m", pairs, start=start, weekdays_only=True)
    hist["meta"]["fed_path_contract"] = {"symbol": sym, "month": ym}
    status("fed_path_6m", f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}", "live", last, f"contract {sym} ({ym}); bp vs EFFR", n=len(pairs))

fd = load("fiscal.json") or {}
if fd.get("bills") and fd.get("total"):
    pairs = S.parse_bills_share(fd["bills"], fd["total"])
    last = S.merge_series(hist["monthly"], "bills_share", pairs, start="2000-01-01")
    status("bills_share", "fiscaldata v1/debt/mspd/mspd_table_1", "live", last, "Bills / Total Marketable, %", "monthly", n=len(pairs))
if fd.get("mts"):
    rec, ni, out_ = S.parse_mts(fd["mts"])
    S.merge_series(hist["monthly"], "receipts_bn", rec, start="2000-01-01")
    S.merge_series(hist["monthly"], "net_interest_bn", ni, start="2000-01-01")
    last = S.merge_series(hist["monthly"], "net_outlays_bn", out_, start="2000-01-01")
    status("mts_receipts_interest", "fiscaldata v1/accounting/mts/mts_table_9 (lines 120/320/340)", "live", last, "USD bn per month", "monthly", n=len(rec))

td = load("td.json") or {}
if td.get("auctions"):
    aucs = S.parse_auctions(td["auctions"])
    hist["auctions"] = aucs
    status("auctions_long", "https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type={Note|Bond|TIPS}", "fallback",
           aucs[-1]["date"] if aucs else None, "no WI yield -> bid-to-cover z-score proxy", "event", n=len(aucs))
if td.get("buybacks"):
    bbs = []
    for d, xml in sorted(td["buybacks"].items()):
        try:
            bbs.append(S.parse_buyback_xml(xml, dt.date.fromisoformat(d)))
        except ET.ParseError as e:
            print("buyback xml parse error", d, e)
    hist["buybacks"] = bbs
    if td.get("schedule_xml"):
        hist["buyback_schedule"] = sorted({el.text.strip()[:10] for el in ET.fromstring(td["schedule_xml"]).iter("OperationDate") if el.text})
    status("buybacks", "treasurydirect /instit/annceresult/press/preanre/{Y}/BBR_{YYYYMMDD}{174000|184000}.xml", "live",
           bbs[-1]["date"] if bbs else None, f"{len(bbs)} operations", "event", n=len(bbs))

ny = load("nyfed.json") or {}
if ny.get("srf"):
    srf = S.parse_nyfed_srf(ny["srf"])
    hist["srf"] = [{"date": d, "accepted_bn": round(v, 3)} for d, v in srf]
    status("srf_usage", "https://markets.newyorkfed.org/api/rp/repo/all/results/last/120.json", "live", srf[-1][0] if srf else None, "USD bn per day", n=len(srf))

tic = load("tic.json") or {}
if tic.get("mfhhis01"):
    S.merge_series(hist["monthly"], "foreign_official_bn", S.parse_mfhhis(tic["mfhhis01"]), start="2000-01-01")
if tic.get("slt_table5"):
    pairs = S.parse_tic_table5(tic["slt_table5"])
    last = S.merge_series(hist["monthly"], "foreign_official_bn", pairs, start="2000-01-01")
    status("foreign_official_bn", "https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt", "live", last, "Foreign Official, USD bn", "monthly", n=len(pairs))

cot = load("cot.json") or {}
if cot.get("f_disagg"):
    c = S.parse_cot_gold(cot["f_disagg"])
    hist["cot"] = [c]
    status("cot_managed_money_net_gold", "https://www.cftc.gov/dea/newcot/f_disagg.txt", "live", c["date"], "context only", "weekly", n=1)

meta["cb_gold_purchases_3m"] = {"endpoint": "data/manual.json", "status": "manual", "last_date": None, "note": "hand-entered monthly tonnes (WGC)", "error": None, "checked_at": None, "cadence": "manual", "fresh": True}

today = dt.date.today().isoformat()
if dt.date.today().weekday() < 5:
    S.ensure_row(hist["daily"], today)
hist["meta"].update(meta)
hist["generated_at"] = dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
hist["sample"] = False
hist["bootstrap"] = "browser dump " + today
hist["runs"].append({"run_at": hist["generated_at"], "date": today, "ok": ok, "failed": failed, "note": "bootstrap from browser dump"})
os.makedirs(S.DATA_DIR, exist_ok=True)
with open(S.HISTORY_PATH, "w", encoding="utf-8") as f:
    json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))
rows = [{"id": k, **v} for k, v in meta.items()]
with open(S.STATUS_PATH, "w", encoding="utf-8") as f:
    json.dump({"checked_at": hist["generated_at"], "rows": rows, "ok": ok, "failed": failed, "note": "bootstrap from browser dump"}, f, ensure_ascii=False, indent=1)
print(f"daily rows={len(hist['daily']['dates'])} cols={sorted(hist['daily']['columns'])}")
print(f"weekly cols={sorted(hist['weekly']['columns'])} monthly cols={sorted(hist['monthly']['columns'])}")
print(f"auctions={len(hist['auctions'])} buybacks={len(hist['buybacks'])} srf={len(hist['srf'])} cot={len(hist['cot'])}")
print(f"wrote {S.HISTORY_PATH} {os.path.getsize(S.HISTORY_PATH)/1e6:.2f} MB")
