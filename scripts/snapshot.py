#!/usr/bin/env python3
"""
Gold Regime Monitor — data layer.

Pulls every raw series the engine needs (all keyless), merges them into
data/history.json (append-only daily table + weekly/monthly tables + event
lists), and writes data/endpoint_status.json so the page can show what is
live / fallback / manual / failed.  Never hard-fails on one source: each
source is wrapped, errors are recorded, the rest continues.

Usage:
  python scripts/snapshot.py                # normal daily run (backfills on first run)
  python scripts/snapshot.py --validate-only # endpoint status table only, no history write
  python scripts/snapshot.py --dry-run       # fetch + merge, print summary, do not write

Stdlib only, plus xlrd for the NY Fed ACM .xls (pip install xlrd).
"""
import argparse
import csv
import datetime as dt
import io
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")
STATUS_PATH = os.path.join(DATA_DIR, "endpoint_status.json")
CONFIG_PATH = os.path.join(ROOT, "config.json")
METRICS_PATH = os.path.join(ROOT, "03_metrics.json")

UA = "Mozilla/5.0 (compatible; gold-regime-dashboard/1.0; +https://github.com)"
TIMEOUT = 30
RETRIES = 3

TODAY = dt.date.today()

# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

def http_get(url, *, timeout=TIMEOUT, retries=RETRIES, binary=False, headers=None):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                return body if binary else body.decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            last = e
            if e.code in (404, 400, 403):
                raise
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(1.5 * (attempt + 1))
    raise last


def http_status(url):
    """HEAD-ish probe: returns HTTP status without raising for 404."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception:  # noqa: BLE001
        return 0, b""


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def parse_float(s):
    if s is None:
        return None
    s = str(s).strip()
    if s in ("", ".", "null", "None", "NA", "n/a"):
        return None
    try:
        v = float(s.replace(",", ""))
    except ValueError:
        return None
    if math.isnan(v):
        return None
    return v


def iso(d):
    return d.isoformat() if isinstance(d, dt.date) else str(d)[:10]


def business_days(start, end):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += dt.timedelta(days=1)


def us_dst(d):
    """US daylight saving time in effect on date d (2nd Sunday March .. 1st Sunday November)."""
    y = d.year
    march = dt.date(y, 3, 1)
    second_sun_mar = march + dt.timedelta(days=(6 - march.weekday()) % 7 + 7)
    nov = dt.date(y, 11, 1)
    first_sun_nov = nov + dt.timedelta(days=(6 - nov.weekday()) % 7)
    return second_sun_mar <= d < first_sun_nov


class Status:
    """Collects per-source status for endpoint_status.json."""

    def __init__(self):
        self.rows = []

    def add(self, sid, *, endpoint, status, last_date=None, note="", error=None, cadence="daily", n=None):
        self.rows.append({
            "id": sid,
            "endpoint": endpoint,
            "status": status,           # live | fallback | manual | error
            "cadence": cadence,
            "last_date": iso(last_date) if last_date else None,
            "n": n,
            "note": note,
            "error": (str(error)[:300] if error else None),
            "checked_at": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        })

    def within_cadence(self, row):
        if not row["last_date"]:
            return False
        age = (TODAY - dt.date.fromisoformat(row["last_date"])).days
        lim = {"daily": 5, "weekly": 10, "monthly": 45, "quarterly": 120, "event": 60, "manual": 10 ** 6}
        return age <= lim.get(row["cadence"], 45)


# --------------------------------------------------------------------------
# Fetchers — each returns a list of (date_iso, value) sorted ascending
# --------------------------------------------------------------------------

def parse_fred_csv(txt, series="?"):
    out = []
    rdr = csv.reader(io.StringIO(txt))
    header = next(rdr, None)
    if not header or header[0].lower() not in ("observation_date", "date"):
        raise ValueError(f"FRED {series}: unexpected header {header!r}")
    for row in rdr:
        if len(row) < 2:
            continue
        out.append((row[0], parse_float(row[1])))
    return out


def fetch_fred(series):
    return parse_fred_csv(http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}"), series)


def parse_yahoo_chart(body, symbol="?"):
    if isinstance(body, str):
        body = json.loads(body)
    res = body.get("chart", {}).get("result")
    if not res:
        raise ValueError(f"yahoo {symbol}: {json.dumps(body)[:200]}")
    res = res[0]
    ts = res.get("timestamp") or []
    closes = res["indicators"]["quote"][0].get("close") or []
    out = {}
    for t, c in zip(ts, closes):
        d = dt.datetime.utcfromtimestamp(t).date().isoformat()
        if c is not None:
            out[d] = float(c)          # last value wins for duplicate days
        elif d not in out:
            out[d] = None
    return sorted(out.items())


def fetch_yahoo(symbol, start=dt.date(2005, 1, 1)):
    p1 = int(dt.datetime(start.year, start.month, start.day).timestamp())
    p2 = int(time.time()) + 86400
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?period1={p1}&period2={p2}&interval=1d")
    return parse_yahoo_chart(http_get(url), symbol)


def parse_nyfed_sofr(body):
    if isinstance(body, str):
        body = json.loads(body)
    out = [(r["effectiveDate"], parse_float(r.get("percentRate"))) for r in body.get("refRates", [])]
    return sorted(out)


def fetch_nyfed_sofr(n=60):
    return parse_nyfed_sofr(http_get(f"https://markets.newyorkfed.org/api/rates/secured/sofr/last/{n}.json"))


def parse_nyfed_srf(body):
    """Standing Repo Facility usage per operation date, USD bn (sum of repo ops that day)."""
    if isinstance(body, str):
        body = json.loads(body)
    per_day = {}
    for op in body.get("repo", {}).get("operations", []):
        d = op.get("operationDate")
        amt = parse_float(op.get("totalAmtAccepted")) or 0.0
        per_day[d] = per_day.get(d, 0.0) + amt / 1e9
    return sorted(per_day.items())


def fetch_nyfed_srf(n=120):
    return parse_nyfed_srf(http_get(f"https://markets.newyorkfed.org/api/rp/repo/all/results/last/{n}.json"))


def fetch_acm():
    """NY Fed ACM term premium, 10y column, daily. Needs xlrd."""
    import xlrd  # noqa: PLC0415
    url = "https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls"
    raw = http_get(url, binary=True, timeout=120)
    book = xlrd.open_workbook(file_contents=raw)
    best = None
    for sh in book.sheets():
        hdr_row = None
        for r in range(min(sh.nrows, 10)):
            vals = [str(sh.cell_value(r, c)).strip() for c in range(sh.ncols)]
            if "ACMTP10" in vals:
                hdr_row = r
                col = vals.index("ACMTP10")
                dcol = vals.index("DATE") if "DATE" in vals else 0
                break
        if hdr_row is None:
            continue
        out = []
        for r in range(hdr_row + 1, sh.nrows):
            dv = sh.cell_value(r, dcol)
            ct = sh.cell_type(r, dcol)
            if ct == xlrd.XL_CELL_DATE:
                d = xlrd.xldate_as_datetime(dv, book.datemode).date()
            else:
                s = str(dv).strip()
                d = None
                for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%m/%d/%Y", "%d%b%Y"):
                    try:
                        d = dt.datetime.strptime(s, fmt).date()
                        break
                    except ValueError:
                        pass
                if d is None:
                    continue
            v = parse_float(sh.cell_value(r, col))
            out.append((d.isoformat(), v))
        if out and (best is None or len(out) > len(best)):
            best = out
    if not best:
        raise ValueError("ACM xls: ACMTP10 column not found")
    return sorted(best)


def fiscaldata(path, params):
    base = "https://api.fiscaldata.treasury.gov/services/api/fiscal_service/"
    q = "&".join(f"{k}={urllib.parse.quote(str(v), safe='(),:=-')}" for k, v in params.items())
    body = json.loads(http_get(base + path + "?" + q, timeout=90))
    return body.get("data", [])


def parse_bills_share(bills, total):
    tot = {r["record_date"]: parse_float(r["total_mil_amt"]) for r in total}
    out = []
    for r in bills:
        d = r["record_date"]
        b, t = parse_float(r["total_mil_amt"]), tot.get(d)
        out.append((d, (100.0 * b / t) if (b is not None and t) else None))
    return sorted(out)


def fetch_bills_share():
    """Bills / Total Marketable (%), monthly, from MSPD table 1."""
    # NB: multi-field filters and values with spaces ("Total Marketable") stall the API -> filter one field, refine locally
    bills = [r for r in fiscaldata("v1/debt/mspd/mspd_table_1", {
        "filter": "security_class_desc:eq:Bills", "sort": "record_date", "page[size]": 2000,
        "fields": "record_date,security_type_desc,total_mil_amt"}) if r.get("security_type_desc") == "Marketable"]
    total = [r for r in fiscaldata("v1/debt/mspd/mspd_table_1", {
        "filter": "security_class_desc:eq:_", "sort": "record_date", "page[size]": 2000,
        "fields": "record_date,security_type_desc,total_mil_amt"}) if r.get("security_type_desc") == "Total Marketable"]
    return parse_bills_share(bills, total)


def parse_mts(rows):
    """Monthly receipts (line 120), net interest (320), net outlays (340) from MTS table 9, USD bn."""
    rec, ni, out_ = {}, {}, {}
    for r in rows:
        d = r["record_date"]
        v = parse_float(r.get("current_month_rcpt_outly_amt"))
        v = v / 1e9 if v is not None else None
        lc = str(r.get("line_code_nbr"))
        if lc == "120":
            rec[d] = v
        elif lc == "320":
            ni[d] = v
        elif lc == "340":
            out_[d] = v
    dates = sorted(set(rec) | set(ni) | set(out_))
    return ([(d, rec.get(d)) for d in dates], [(d, ni.get(d)) for d in dates], [(d, out_.get(d)) for d in dates])


def fetch_mts():
    rows = fiscaldata("v1/accounting/mts/mts_table_9", {
        "filter": "line_code_nbr:in:(120,320,340)",
        "sort": "record_date", "page[size]": 10000,
        "fields": "record_date,line_code_nbr,classification_desc,current_month_rcpt_outly_amt"})
    return parse_mts(rows)


def parse_dts_tga(rows):
    out = []
    for r in rows:
        v = parse_float(r.get("close_today_bal"))
        if v is None:
            v = parse_float(r.get("open_today_bal"))   # observed: value lives here, close_today_bal is null
        out.append((r["record_date"], v))
    return sorted(out)


def fetch_dts_tga(n=400):
    rows = [r for r in fiscaldata("v1/accounting/dts/operating_cash_balance", {
        "sort": "-record_date", "page[size]": n * 4, "fields": "record_date,account_type,open_today_bal,close_today_bal"})
            if "Closing Balance" in (r.get("account_type") or "")]
    return parse_dts_tga(rows)


def parse_auctions(rows_by_type):
    """10y/30y nominal and TIPS auctions from TreasuryDirect. rows_by_type: {type: [rows]}"""
    out = []
    for typ, rows in rows_by_type.items():
        if isinstance(rows, str):
            rows = json.loads(rows)
        for r in rows:
            term = (r.get("securityTerm") or "").strip()
            orig = (r.get("originalSecurityTerm") or term).strip()
            base = orig.split("-")[0]
            if base not in ("10", "30", "29", "9"):
                continue
            bucket = "10" if base in ("10", "9") else "30"
            key = f"{bucket}y_{'tips' if typ == 'TIPS' else 'nominal'}"
            out.append({
                "date": (r.get("auctionDate") or "")[:10],
                "cusip": r.get("cusip"),
                "type": typ,
                "term": term,
                "bucket": key,
                "high_yield": parse_float(r.get("highYield")),
                "btc": parse_float(r.get("bidToCoverRatio")),
                "reopening": (r.get("reopening") == "Yes"),
                "offering_bn": (parse_float(r.get("offeringAmount")) or 0) / 1e9,
                "accepted_bn": (parse_float(r.get("totalAccepted")) or 0) / 1e9,
                "indirect_bn": (parse_float(r.get("indirectBidderAccepted")) or 0) / 1e9,
                "dealer_bn": (parse_float(r.get("primaryDealerAccepted")) or 0) / 1e9,
            })
    out = [a for a in out if a["date"] and a["btc"] is not None]
    out.sort(key=lambda a: (a["date"], a["cusip"] or ""))
    return out


def fetch_auctions(days=2500):
    rows_by_type = {}
    for typ in ("Note", "Bond", "TIPS"):
        url = f"https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type={typ}&days={days}"
        rows_by_type[typ] = json.loads(http_get(url, timeout=90))
    return parse_auctions(rows_by_type)


def buyback_xml_url(d):
    suffix = "174000" if us_dst(d) else "184000"   # 13:40 ET expressed in UTC
    return f"https://www.treasurydirect.gov/instit/annceresult/press/preanre/{d.year}/BBR_{d.strftime('%Y%m%d')}{suffix}.xml"


def parse_buyback_xml(raw, d):
    root = ET.fromstring(raw)
    g = lambda k: (root.findtext(k) or "").strip()  # noqa: E731
    acc = parse_float(g("totalParAmountAccepted")) or 0.0
    off = parse_float(g("totalParAmountOffered")) or 0.0
    mx = parse_float(g("maxParAmountRedeemed")) or 0.0
    mb, me = g("maturityDateRangeBegin"), g("maturityDateRangeEnd")
    years_to_begin = None
    if mb:
        try:
            years_to_begin = (dt.date.fromisoformat(mb) - d).days / 365.25
        except ValueError:
            pass
    return {
        "date": d.isoformat(), "accepted_bn": acc / 1e9, "offered_bn": off / 1e9, "max_bn": mx / 1e9,
        "maturity_begin": mb or None, "maturity_end": me or None,
        "years_to_begin": (round(years_to_begin, 2) if years_to_begin is not None else None),
        "n_eligible": parse_float(g("numberIssuesEligible")), "n_accepted": parse_float(g("numberIssuesAccepted")),
    }


def fetch_buybacks(known_dates, lookback_days=130):
    """Probe deterministic results-XML URLs for each business day; plus the tentative schedule."""
    sched_dates = set()
    try:
        raw = http_get("https://home.treasury.gov/system/files/221/Tentative-Buyback-Schedule.xml")
        for el in ET.fromstring(raw).iter("OperationDate"):
            if el.text:
                sched_dates.add(el.text.strip()[:10])
    except Exception:  # noqa: BLE001
        pass
    start = TODAY - dt.timedelta(days=lookback_days)
    found = []
    probes = 0
    for d in business_days(start, TODAY):
        if d.isoformat() in known_dates:
            continue
        # try both suffixes only on DST boundary weeks; otherwise the computed one
        urls = [buyback_xml_url(d)]
        code, raw = http_status(urls[0])
        probes += 1
        if code == 200 and raw:
            try:
                found.append(parse_buyback_xml(raw, d))
            except ET.ParseError:
                pass
        time.sleep(0.15)
    return found, sorted(sched_dates), probes


def parse_tic_table5(txt):
    lines = [l.rstrip("\n").split("\t") for l in txt.splitlines()]
    header = next((l for l in lines if l and l[0].strip() == "Country"), None)
    row = next((l for l in lines if l and l[0].strip() == "Of Which: Foreign Official"), None)
    if not header or not row:
        raise ValueError("TIC slt_table5: header/row not found")
    out = []
    for ym, v in zip(header[1:], row[1:]):
        ym = ym.strip()
        if re.match(r"^\d{4}-\d{2}$", ym):
            y, m = int(ym[:4]), int(ym[5:7])
            # month-end date
            last = (dt.date(y + (m // 12), (m % 12) + 1, 1) - dt.timedelta(days=1))
            out.append((last.isoformat(), parse_float(v)))
    return sorted(out)


def parse_mfhhis(txt):
    """TIC mfhhis01.txt: yearly blocks (Dec..Jan columns) with a 'For. Official' row. Returns month-end (date, $bn)."""
    months = {"Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6, "Jul": 7, "Aug": 8, "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12}
    lines = [l.rstrip("\r\n").split("\t") for l in txt.splitlines()]
    out = {}
    for i, l in enumerate(lines):
        if not l or l[0].strip() != "Country":
            continue
        hdr_m = lines[i - 1] if i >= 1 else []
        years = [c.strip() for c in l[1:]]
        mons = [c.strip() for c in hdr_m[1:]]
        row = next((r for r in lines[i:i + 60] if r and r[0].strip() == "For. Official"), None)
        if not row:
            continue
        for y, m, v in zip(years, mons, row[1:]):
            if y.isdigit() and m in months:
                yy, mm = int(y), months[m]
                last = dt.date(yy + (mm // 12), (mm % 12) + 1, 1) - dt.timedelta(days=1)
                val = parse_float(v)
                if val is not None:
                    out[last.isoformat()] = val
    return sorted(out.items())


def fetch_tic_foreign_official():
    return parse_tic_table5(http_get("https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt"))


def parse_cot_gold(txt):
    for row in csv.reader(io.StringIO(txt)):
        if row and row[0].strip().startswith("GOLD - COMMODITY EXCHANGE INC"):
            d = row[2].strip()
            mm_long, mm_short = parse_float(row[13]), parse_float(row[14])
            return {"date": d, "open_interest": parse_float(row[7]), "mm_long": mm_long, "mm_short": mm_short,
                    "mm_net": (mm_long - mm_short) if (mm_long is not None and mm_short is not None) else None}
    raise ValueError("COT: GOLD row not found")


def fetch_cot_gold():
    return parse_cot_gold(http_get("https://www.cftc.gov/dea/newcot/f_disagg.txt"))


MONTH_CODES = "FGHJKMNQUVXZ"


def fed_path_contract(months_ahead):
    y, m = TODAY.year, TODAY.month + months_ahead
    while m > 12:
        m -= 12
        y += 1
    return f"ZQ{MONTH_CODES[m - 1]}{str(y)[-2:]}.CBT", f"{y}-{m:02d}"


def fetch_fed_path(effr_series, months_ahead):
    sym, ym = fed_path_contract(months_ahead)
    px = fetch_yahoo(sym, start=TODAY - dt.timedelta(days=200))
    effr = {d: v for d, v in effr_series if v is not None}
    effr_dates = sorted(effr)
    out = []
    for d, p in px:
        if p is None:
            continue
        # EFFR as of d (last available on/before d)
        e = None
        for ed in reversed(effr_dates):
            if ed <= d:
                e = effr[ed]
                break
        if e is None:
            continue
        out.append((d, round(((100.0 - p) - e) * 100.0, 1)))   # bp
    return sorted(out), sym, ym


# --------------------------------------------------------------------------
# History tables
# --------------------------------------------------------------------------

def empty_history():
    return {
        "version": 1, "sample": False, "generated_at": None,
        "daily": {"dates": [], "columns": {}},
        "weekly": {"dates": [], "columns": {}},
        "monthly": {"dates": [], "columns": {}},
        "auctions": [], "buybacks": [], "buyback_schedule": [], "srf": [], "cot": [],
        "meta": {}, "runs": [],
    }


def load_history():
    if os.path.exists(HISTORY_PATH):
        with open(HISTORY_PATH, encoding="utf-8") as f:
            h = json.load(f)
        if h.get("sample"):
            print("existing history.json is a SAMPLE file; starting fresh")
            return empty_history()
        return h
    return empty_history()


def merge_series(table, col, pairs, *, start=None, weekdays_only=False):
    """Merge (date, value) pairs into a date-aligned table. New dates are inserted; existing
    values are overwritten by fresh non-null values (revisions); existing non-null values are
    kept when the fresh pull has null/missing for that date."""
    dates = table["dates"]
    cols = table["columns"]
    idx = {d: i for i, d in enumerate(dates)}
    fresh = {d: v for d, v in pairs if (start is None or d >= start)
             and not (weekdays_only and dt.date.fromisoformat(d[:10]).weekday() >= 5)}
    new_dates = sorted(set(fresh) - set(idx))
    if new_dates:
        all_dates = sorted(set(dates) | set(new_dates))
        remap = {d: i for i, d in enumerate(all_dates)}
        for c, arr in cols.items():
            new_arr = [None] * len(all_dates)
            for d, v in zip(dates, arr):
                new_arr[remap[d]] = v
            cols[c] = new_arr
        table["dates"] = all_dates
        dates = all_dates
        idx = remap
    if col not in cols:
        cols[col] = [None] * len(dates)
    arr = cols[col]
    for d, v in fresh.items():
        i = idx[d]
        if v is not None or arr[i] is None:
            arr[i] = v
    last = max((d for d, v in fresh.items() if v is not None), default=None)
    return last


def ensure_row(table, date_iso):
    """Guarantee a row for date_iso exists (nulls) — the explicit 'no data today' marker."""
    if date_iso in table["dates"]:
        return
    merge_series(table, "_placeholder", [(date_iso, None)])
    table["columns"].pop("_placeholder", None)
    if not table["columns"]:
        table["dates"] = [d for d in table["dates"]]


def last_valid(table, col):
    arr = table["columns"].get(col) or []
    for d, v in zip(reversed(table["dates"]), reversed(arr)):
        if v is not None:
            return d
    return None


# --------------------------------------------------------------------------
# Main pull
# --------------------------------------------------------------------------

FRED_DAILY = ["DFII5", "DFII10", "DFII30", "DGS2", "DGS10", "DGS30", "T10YIE", "T5YIFR",
              "EFFR", "IORB", "SOFR", "RRPONTSYD", "DTWEXBGS", "BAMLH0A0HYM2",
              "DEXUSEU", "DEXJPUS", "DEXCHUS"]
FRED_WEEKLY = ["WALCL", "WTREGEN", "WRESBAL"]
FRED_MONTHLY = ["CPIAUCSL", "PCEPILFE", "UNRATE"]
FRED_QUARTERLY = ["GDP", "OPHNFB", "FDHBFIN"]


def run(validate_only=False, dry_run=False):
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    hist = load_history()
    st = Status()
    start = cfg.get("history_start", "2003-01-01")
    today = TODAY.isoformat()
    ok, failed = [], []

    def record(sid, fn, *, table=None, col=None, endpoint="", cadence="daily", note="", fallback=None, start_=None):
        """Run fn(); merge result; record status. fallback: (fn2, endpoint2, note2)."""
        try:
            pairs = fn()
            last = merge_series(hist[table], col or sid, pairs, start=start_ or start, weekdays_only=(table == "daily")) if table else None
            st.add(sid, endpoint=endpoint, status="live", last_date=last, cadence=cadence, note=note, n=len(pairs))
            ok.append(sid)
            return pairs
        except Exception as e:  # noqa: BLE001
            if fallback:
                fn2, ep2, note2 = fallback
                try:
                    pairs = fn2()
                    last = merge_series(hist[table], col or sid, pairs, start=start_ or start, weekdays_only=(table == "daily")) if table else None
                    st.add(sid, endpoint=ep2, status="fallback", last_date=last, cadence=cadence,
                           note=f"primary failed ({str(e)[:80]}); {note2}", n=len(pairs))
                    ok.append(sid)
                    return pairs
                except Exception as e2:  # noqa: BLE001
                    st.add(sid, endpoint=endpoint, status="error", cadence=cadence, note=note,
                           error=f"primary: {e}; fallback: {e2}", last_date=last_valid(hist[table], col or sid) if table else None)
            else:
                st.add(sid, endpoint=endpoint, status="error", cadence=cadence, note=note, error=e,
                       last_date=last_valid(hist[table], col or sid) if table else None)
            failed.append(sid)
            return None

    fred_ep = "https://fred.stlouisfed.org/graph/fredgraph.csv?id={id}"

    # --- FRED daily
    fred_daily = {}
    for s in FRED_DAILY:
        fb = None
        if s == "EFFR":
            fb = (lambda: fetch_fred("DFF"), fred_ep.format(id="DFF"), "DFF used for EFFR")
        if s == "SOFR":
            fb = (lambda: fetch_nyfed_sofr(400), "https://markets.newyorkfed.org/api/rates/secured/sofr/last/400.json", "NY Fed API")
        fred_daily[s] = record(s, lambda s=s: fetch_fred(s), table="daily", endpoint=fred_ep.format(id=s), fallback=fb)
    # --- FRED weekly / monthly / quarterly
    for s in FRED_WEEKLY:
        fb = None
        if s == "WTREGEN":
            fb = (fetch_dts_tga, "fiscaldata dts/operating_cash_balance", "DTS TGA closing balance (USD mn) used")
        record(s, lambda s=s: fetch_fred(s), table="weekly", endpoint=fred_ep.format(id=s), cadence="weekly", fallback=fb)
    for s in FRED_MONTHLY:
        record(s, lambda s=s: fetch_fred(s), table="monthly", endpoint=fred_ep.format(id=s), cadence="monthly", start_="2000-01-01")
    for s in FRED_QUARTERLY:
        record(s, lambda s=s: fetch_fred(s), table="monthly", endpoint=fred_ep.format(id=s), cadence="quarterly", start_="2000-01-01")

    # --- Gold (stooq primary per spec, yahoo fallback; stooq often 'Access denied')
    def stooq_gold():
        txt = http_get("https://stooq.com/q/d/l/?s=xauusd&i=d")
        if not txt.lower().startswith("date"):
            raise ValueError(f"stooq: {txt[:60]!r}")
        out = []
        for row in csv.DictReader(io.StringIO(txt)):
            out.append((row["Date"], parse_float(row.get("Close"))))
        return out
    record("gold_spot", stooq_gold, table="daily", endpoint="https://stooq.com/q/d/l/?s=xauusd&i=d",
           fallback=(lambda: fetch_yahoo("GC=F", dt.date(2005, 1, 1)),
                     "https://query1.finance.yahoo.com/v8/finance/chart/GC=F", "GC=F front-month futures close"))
    # --- MOVE
    record("MOVE", lambda: fetch_yahoo("^MOVE", TODAY - dt.timedelta(days=5 * 366)), table="daily",
           endpoint="https://query1.finance.yahoo.com/v8/finance/chart/%5EMOVE")
    # --- ACM
    record("ACMTP10", fetch_acm, table="daily",
           endpoint="https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls", note="xlrd parse, ACMTP10 column",
           fallback=(lambda: fetch_fred("THREEFYTP10"), fred_ep.format(id="THREEFYTP10"), "Kim-Wright 10y term premium (FRED THREEFYTP10) used instead of ACM"))
    # --- fed path (ZQ)
    effr_pairs = [(d, v) for d, v in zip(hist["daily"]["dates"], hist["daily"]["columns"].get("EFFR", [])) if v is not None]
    try:
        pairs, sym, ym = fetch_fed_path(effr_pairs, cfg.get("fed_path_months_ahead", 6))
        last = merge_series(hist["daily"], "fed_path_6m", pairs, start=start, weekdays_only=True)
        st.add("fed_path_6m", endpoint=f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}", status="live",
               last_date=last, note=f"contract {sym} ({ym}); bp vs EFFR; fallback (DGS2-EFFR) computed in engine when null", n=len(pairs))
        hist["meta"]["fed_path_contract"] = {"symbol": sym, "month": ym}
        ok.append("fed_path_6m")
    except Exception as e:  # noqa: BLE001
        st.add("fed_path_6m", endpoint="yahoo ZQ futures", status="fallback", note="engine uses (DGS2-EFFR)*100 bp", error=e,
               last_date=last_valid(hist["daily"], "fed_path_6m"))
        failed.append("fed_path_6m")

    # --- Fiscal Data
    record("bills_share", fetch_bills_share, table="monthly", endpoint="fiscaldata v1/debt/mspd/mspd_table_1", cadence="monthly",
           note="Bills total_mil_amt / Total Marketable total_mil_amt, %", start_="2000-01-01")
    try:
        rec, ni, out_ = fetch_mts()
        merge_series(hist["monthly"], "receipts_bn", rec, start="2000-01-01")
        merge_series(hist["monthly"], "net_interest_bn", ni, start="2000-01-01")
        last = merge_series(hist["monthly"], "net_outlays_bn", out_, start="2000-01-01")
        st.add("mts_receipts_interest", endpoint="fiscaldata v1/accounting/mts/mts_table_9 (lines 120/320/340)", status="live",
               last_date=last, cadence="monthly", note="USD bn per month; engine builds trailing-12m ratio", n=len(rec))
        ok.append("mts_receipts_interest")
    except Exception as e:  # noqa: BLE001
        st.add("mts_receipts_interest", endpoint="fiscaldata mts_table_9", status="error", cadence="monthly", error=e,
               last_date=last_valid(hist["monthly"], "net_interest_bn"))
        failed.append("mts_receipts_interest")

    # --- TreasuryDirect auctions
    try:
        aucs = fetch_auctions()
        known = {(a["date"], a["cusip"]) for a in hist["auctions"]}
        for a in aucs:
            if (a["date"], a["cusip"]) not in known:
                hist["auctions"].append(a)
        hist["auctions"].sort(key=lambda a: (a["date"], a["cusip"] or ""))
        st.add("auctions_long", endpoint="https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type={Note|Bond|TIPS}",
               status="fallback", cadence="event", last_date=hist["auctions"][-1]["date"] if hist["auctions"] else None,
               note="no when-issued yield available -> tail proxied by bid-to-cover z-score (see docs)", n=len(aucs))
        ok.append("auctions_long")
    except Exception as e:  # noqa: BLE001
        st.add("auctions_long", endpoint="treasurydirect TA_WS", status="error", cadence="event", error=e,
               last_date=hist["auctions"][-1]["date"] if hist["auctions"] else None)
        failed.append("auctions_long")

    # --- Buybacks
    try:
        known = {b["date"] for b in hist["buybacks"]}
        found, sched, probes = fetch_buybacks(known, lookback_days=(130 if not hist["buybacks"] else 45))
        hist["buybacks"].extend(found)
        hist["buybacks"].sort(key=lambda b: b["date"])
        if sched:
            hist["buyback_schedule"] = sched
        st.add("buybacks", endpoint="treasurydirect /instit/annceresult/press/preanre/{Y}/BBR_{YYYYMMDD}{174000|184000}.xml",
               status="live", cadence="event", last_date=hist["buybacks"][-1]["date"] if hist["buybacks"] else None,
               note=f"probed {probes} business days, found {len(found)} new; schedule dates {len(sched)}", n=len(hist["buybacks"]))
        ok.append("buybacks")
    except Exception as e:  # noqa: BLE001
        st.add("buybacks", endpoint="treasurydirect buyback XML", status="error", cadence="event", error=e,
               last_date=hist["buybacks"][-1]["date"] if hist["buybacks"] else None)
        failed.append("buybacks")

    # --- SRF usage
    try:
        srf = fetch_nyfed_srf(120)
        known = {s["date"]: s for s in hist["srf"]}
        for d, v in srf:
            known[d] = {"date": d, "accepted_bn": round(v, 3)}
        hist["srf"] = [known[d] for d in sorted(known)]
        st.add("srf_usage", endpoint="https://markets.newyorkfed.org/api/rp/repo/all/results/last/120.json", status="live",
               last_date=hist["srf"][-1]["date"] if hist["srf"] else None, note="sum of repo ops accepted per day, USD bn", n=len(srf))
        ok.append("srf_usage")
    except Exception as e:  # noqa: BLE001
        st.add("srf_usage", endpoint="nyfed markets api rp/repo", status="error", error=e,
               last_date=hist["srf"][-1]["date"] if hist["srf"] else None)
        failed.append("srf_usage")

    # --- TIC foreign official
    try:  # long history (yearly blocks) first, then the 13-month current table on top
        merge_series(hist["monthly"], "foreign_official_bn", parse_mfhhis(http_get("https://ticdata.treasury.gov/Publish/mfhhis01.txt")), start="2000-01-01")
    except Exception as e:  # noqa: BLE001
        print("mfhhis01 history skipped:", e)
    record("foreign_official_bn", fetch_tic_foreign_official, table="monthly", cadence="monthly",
           endpoint="https://ticdata.treasury.gov/resource-center/data-chart-center/tic/Documents/slt_table5.txt",
           note="row 'Of Which: Foreign Official', USD bn, month-end dates; mfh.txt is stale (2023-01) so not used", start_="2000-01-01")

    # --- COT
    try:
        c = fetch_cot_gold()
        known = {x["date"]: x for x in hist["cot"]}
        known[c["date"]] = c
        hist["cot"] = [known[d] for d in sorted(known)]
        st.add("cot_managed_money_net_gold", endpoint="https://www.cftc.gov/dea/newcot/f_disagg.txt", status="live",
               last_date=c["date"], cadence="weekly", note="context only, not scored", n=len(hist["cot"]))
        ok.append("cot_managed_money_net_gold")
    except Exception as e:  # noqa: BLE001
        st.add("cot_managed_money_net_gold", endpoint="cftc f_disagg.txt", status="error", cadence="weekly", error=e,
               last_date=hist["cot"][-1]["date"] if hist["cot"] else None)
        failed.append("cot_managed_money_net_gold")

    # --- manual
    st.add("cb_gold_purchases_3m", endpoint="data/manual.json (WGC, hand-entered monthly tonnes)", status="manual", cadence="manual",
           note="no keyless endpoint; weight -> 0 under stale rule when empty")

    # --- today's row: explicit null markers for anything missing today
    if TODAY.weekday() < 5:
        ensure_row(hist["daily"], today)

    hist["generated_at"] = dt.datetime.utcnow().isoformat(timespec="seconds") + "Z"
    hist["runs"].append({"run_at": hist["generated_at"], "date": today, "ok": ok, "failed": failed})
    hist["runs"] = hist["runs"][-400:]
    for row in st.rows:
        hist["meta"][row["id"]] = {k: row[k] for k in ("endpoint", "status", "last_date", "note", "error", "checked_at", "cadence")}
        hist["meta"][row["id"]]["fresh"] = st.within_cadence(row)

    # --- print table
    print(f"\n{'id':28} {'status':9} {'last':11} fresh  note")
    for r in st.rows:
        print(f"{r['id']:28} {r['status']:9} {str(r['last_date']):11} {'Y' if st.within_cadence(r) else 'N':5}  {(r['note'] or r['error'] or '')[:90]}")
    print(f"\nok={len(ok)} failed={len(failed)} daily_rows={len(hist['daily']['dates'])} cols={len(hist['daily']['columns'])}")

    os.makedirs(DATA_DIR, exist_ok=True)
    status_doc = {"checked_at": hist["generated_at"], "rows": [dict(r, fresh=st.within_cadence(r)) for r in st.rows],
                  "ok": ok, "failed": failed}
    if validate_only:
        with open(STATUS_PATH, "w", encoding="utf-8") as f:
            json.dump(status_doc, f, ensure_ascii=False, indent=1)
        print(f"wrote {STATUS_PATH} (validate-only; history untouched)")
        return 0
    if dry_run:
        print("dry run; nothing written")
        return 0
    with open(STATUS_PATH, "w", encoding="utf-8") as f:
        json.dump(status_doc, f, ensure_ascii=False, indent=1)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(hist, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {HISTORY_PATH} ({os.path.getsize(HISTORY_PATH) / 1e6:.2f} MB)")
    # exit non-zero only if the core daily series all failed (so Actions shows red, page shows the error)
    core = ["DFII10", "T10YIE", "gold_spot"]
    if all(c in failed for c in core):
        print("ALL core series failed", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--validate-only", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    sys.exit(run(validate_only=a.validate_only, dry_run=a.dry_run))
