"""python3 -m unittest tests/test_snapshot.py — parser + merge tests for the data layer (no network)."""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))
import snapshot as S  # noqa: E402

FRED = "observation_date,DFII10\n2026-09-08,2.43\n2026-09-09,.\n2026-09-10,2.55\n"
YAHOO = {"chart": {"result": [{"timestamp": [1789344000, 1789430400], "indicators": {"quote": [{"close": [4364.5, None]}]}}]}}
BUYBACK_XML = """<buyback><operationStatus>Results</operationStatus><operationStartDTM>2026-09-10T13:40:00-04:00</operationStartDTM>
<maxParAmountRedeemed>6000000000</maxParAmountRedeemed><maturityDateRangeBegin>2037-02-15</maturityDateRangeBegin><maturityDateRangeEnd>2046-08-15</maturityDateRangeEnd>
<numberIssuesEligible>38</numberIssuesEligible><numberIssuesAccepted>4</numberIssuesAccepted><totalParAmountOffered>10489000000</totalParAmountOffered><totalParAmountAccepted>5187000000</totalParAmountAccepted></buyback>"""
TIC5 = "Table 5\t\nHoldings\t\nBillions\t\nLink\t\n\t\nCountry\t2026-06\t2026-05\nJapan\t1116.7\t1143.1\nOf Which: Foreign Official\t3778.1\t3848.0\n"
MFHHIS = "\tDec\tNov\nCountry\t2025\t2025\n------\t------\t------\nJapan\t1185.5\t1202.7\nFor. Official\t3877.7\t3912.3\n\n\tDec\tNov\nCountry\t2024\t2024\n------\nFor. Official\t3792.5\t3861.9\n"
COT = '"GOLD - COMMODITY EXCHANGE INC.",260908,2026-09-08,088691,CMX ,01,088 ,  411227,   16588,   47549,   14542,  253855,   23273,  145804,   10832,   29462\n'
MTS = [
    {"record_date": "2026-08-31", "line_code_nbr": "120", "classification_desc": "Total", "current_month_rcpt_outly_amt": "360032735841.42"},
    {"record_date": "2026-08-31", "line_code_nbr": "320", "classification_desc": "Net Interest", "current_month_rcpt_outly_amt": "85610418547.20"},
    {"record_date": "2026-08-31", "line_code_nbr": "340", "classification_desc": "Total", "current_month_rcpt_outly_amt": "526829688118.80"},
]


class Parsers(unittest.TestCase):
    def test_fred_missing_is_null_not_zero(self):
        p = S.parse_fred_csv(FRED, "DFII10")
        self.assertEqual(p, [("2026-09-08", 2.43), ("2026-09-09", None), ("2026-09-10", 2.55)])

    def test_yahoo(self):
        p = S.parse_yahoo_chart(YAHOO, "GC=F")
        self.assertEqual(p[0][1], 4364.5)
        self.assertIsNone(p[1][1])

    def test_buyback_xml_long_end(self):
        b = S.parse_buyback_xml(BUYBACK_XML, dt.date(2026, 9, 10))
        self.assertAlmostEqual(b["accepted_bn"], 5.187)
        self.assertGreater(b["years_to_begin"], 10)

    def test_buyback_url_dst(self):
        self.assertTrue(S.buyback_xml_url(dt.date(2026, 9, 10)).endswith("BBR_20260910174000.xml"))
        self.assertTrue(S.buyback_xml_url(dt.date(2025, 12, 3)).endswith("BBR_20251203184000.xml"))

    def test_tic(self):
        self.assertEqual(S.parse_tic_table5(TIC5), [("2026-05-31", 3848.0), ("2026-06-30", 3778.1)])
        h = dict(S.parse_mfhhis(MFHHIS))
        self.assertEqual(h["2025-12-31"], 3877.7)
        self.assertEqual(h["2024-11-30"], 3861.9)

    def test_cot(self):
        c = S.parse_cot_gold(COT)
        self.assertEqual(c["mm_net"], 145804 - 10832)

    def test_mts(self):
        rec, ni, out = S.parse_mts(MTS)
        self.assertAlmostEqual(rec[0][1], 360.03, places=1)
        self.assertAlmostEqual(ni[0][1], 85.61, places=1)

    def test_bills_share(self):
        p = S.parse_bills_share([{"record_date": "2026-08-31", "total_mil_amt": "7248070.0207"}], [{"record_date": "2026-08-31", "total_mil_amt": "31828001.4636"}])
        self.assertAlmostEqual(p[0][1], 22.77, places=2)


class Merge(unittest.TestCase):
    def test_five_days_accumulate_with_explicit_nulls(self):
        h = S.empty_history()
        days = ["2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]
        for i, d in enumerate(days):
            # DFII10 arrives every day, T10YIE misses day 3 (source down that day)
            S.merge_series(h["daily"], "DFII10", [(d, 2.4 + i / 100)], weekdays_only=True)
            if i != 2:
                S.merge_series(h["daily"], "T10YIE", [(d, 2.3)], weekdays_only=True)
            S.ensure_row(h["daily"], d)
        self.assertEqual(h["daily"]["dates"], days)
        self.assertEqual(len(h["daily"]["columns"]["DFII10"]), 5)
        self.assertIsNone(h["daily"]["columns"]["T10YIE"][2])          # explicit null, not 0
        self.assertEqual(h["daily"]["columns"]["T10YIE"][4], 2.3)
        # a later revision overwrites; a later null does not clobber an existing value
        S.merge_series(h["daily"], "DFII10", [("2026-09-08", 2.99), ("2026-09-09", None)], weekdays_only=True)
        self.assertEqual(h["daily"]["columns"]["DFII10"][1], 2.99)
        self.assertEqual(h["daily"]["columns"]["DFII10"][2], 2.42)
        # weekends are dropped from the daily table
        S.merge_series(h["daily"], "IORB", [("2026-09-12", 3.65), ("2026-09-14", 3.65)], weekdays_only=True)
        self.assertNotIn("2026-09-12", h["daily"]["dates"])
        self.assertIn("2026-09-14", h["daily"]["dates"])

    def test_fed_path_contract(self):
        sym, ym = S.fed_path_contract(6)
        self.assertTrue(sym.startswith("ZQ") and sym.endswith(".CBT"))


if __name__ == "__main__":
    unittest.main()
