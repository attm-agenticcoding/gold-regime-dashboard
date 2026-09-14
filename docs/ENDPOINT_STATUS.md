# 端点状态表（Step 1 交付物）

验证日期：2026-09-14（美东上午）。验证方式：在浏览器里对每个端点做 fetch + 解析 + 打印最后 3 条记录（云端沙箱和本机 VM 的出网策略都封了这些域名，所以用浏览器做的验证；GitHub Actions 出网不受限，`scripts/validate_endpoints.py` 会在每次 snapshot 前重跑同样的检查并把结果写进 `data/endpoint_status.json`，页面"数据状态"面板直接读它）。

cadence 判定：日频 ≤ 3 个交易日、周频 ≤ 10 天、月频 ≤ 45 天。

## 汇总

| 指标 id | 端点 | 状态 | 最新日期 | 备注 |
|---|---|---|---|---|
| dfii5_level / dfii5_chg_60d | FRED `fredgraph.csv?id=DFII5` | **live** | 2026-09-10 | 2.29；全历史自 2003-01-02 |
| dfii10_gap_rstar（DFII10） | FRED `DFII10` | **live** | 2026-09-10 | 2.55；2003 起 |
| dfii30_level | FRED `DFII30` | **live** | 2026-09-10 | 3.05；2010-02 起 |
| real_policy_rate（EFFR） | FRED `EFFR` | **live** | 2026-09-11 | 3.63；DFF 作 fallback 也通（2026-09-10） |
| real_policy_rate（PCEPILFE） | FRED `PCEPILFE` | **live** | 2026-07-01 | 月频，滞后约 6 周，属正常 |
| fed_path_6m | Yahoo chart `ZQH27.CBT` 等 | **live** | 2026-09-14 | ZQZ26 95.90 / ZQH27 95.70 / ZQJ27 95.625 → 隐含 4.10 / 4.30 / 4.375%，对 EFFR 3.63 约 +67bp（6 个月）。fallback `(DGS2−EFFR)×100` 也通 |
| t10yie_level | FRED `T10YIE` | **live** | 2026-09-11 | 2.36 |
| t5yifr_level | FRED `T5YIFR` | **live** | 2026-09-11 | 2.32 |
| acm_tp10_level | NY Fed `ACMTermPremium.xls` | **live（下载通，解析在 Actions）** | 文件 10.1MB，HTTP 200 | 浏览器里没法解 .xls；`snapshot.py` 用 xlrd 取 `ACMTP10` 列，首跑后把最新日期写进状态文件 |
| curve_2s30s_chg_20d（DGS2/DGS30） | FRED `DGS2`, `DGS30` | **live** | 2026-09-10 | 4.56 / 5.37 |
| dollar_broad_chg_60d | FRED `DTWEXBGS` | **live** | 2026-09-04 | 118.07；FRED 该序列滞后约一周，属正常 |
| gold_real_corr_60d（gold_spot） | Yahoo chart `GC=F` | **fallback: yahoo**（stooq 拒绝） | 2026-09-14 | stooq `q/d/l/?s=xauusd` 返回 "Access denied"。Yahoo 用 `period1/period2&interval=1d` 拿到 2005-01-03 起 5,484 个日频收盘（`range=max` 会被降成月频，别用）。GC=F 是近月期货收盘，不是 spot；收盘 ATH 5,318（2026-01），你说的 $5,589 是盘中/现货，config 里留了 `gold_ath_override` |
| bills_share | Fiscal Data `v1/debt/mspd/mspd_table_1` | **live** | 2026-08-31 | Bills 7,248,070 / Total Marketable 31,828,001 = **22.77%**（用 `total_mil_amt`） |
| walcl_chg_13w | FRED `WALCL` | **live** | 2026-09-09 | 6,740,619（百万美元） |
| tga_chg_4w | FRED `WTREGEN` | **live** | 2026-09-09 | 883,335；Fiscal Data DTS fallback 也通（2026-09-10 收盘 818,110；注意 DTS 的 `close_today_bal` 全是 null，实际值在 `open_today_bal` 那一列，行 `account_type = "Treasury General Account (TGA) Closing Balance"`） |
| sofr_iorb_spread | FRED `SOFR`, `IORB` | **live** | 2026-09-11 / 2026-09-14 | SOFR 3.62、IORB 3.65 → −3bp。NY Fed Markets API `rates/secured/sofr/last/N.json` 作 fallback 也通 |
| rrp_level | FRED `RRPONTSYD` | **live** | 2026-09-11 | 5.255（十亿）；NY Fed `rp/reverserepo/all/results/last/N.json` 一致（5,255,000,000 美元） |
| buyback_actual_qtr | TreasuryDirect 结果 XML | **live（结构已摸清）** | 2026-09-10 | 文档里的 `/auctions/buybacks/` 是 404，真实页面 `/auctions/announcements-data-results/buy-backs/`，表格由带 client_id 的内部 API 填充（不用它）。**keyless 路径**：结果 XML 在 `/instit/annceresult/press/preanre/{YYYY}/BBR_{YYYYMMDD}{HHMMSS}.xml`，HHMMSS 是美东 13:40 换算成 UTC（夏令时 174000、冬令时 184000），已用 2025-12-03（184000）和 2026-08-25 / 09-03 / 09-09 / 09-10（174000）验证。XML 含 `totalParAmountAccepted`、`maturityDateRangeBegin/End`，用后者判定长端（≥10y）。操作日期来自 `home.treasury.gov/system/files/221/Tentative-Buyback-Schedule.xml`（live，当季日程）+ 对过去 120 个交易日逐日探测。最近长端：9/10（10–20Y）接受 5.187bn |
| auction_tail_long | TreasuryDirect `TA_WS/securities/auctioned?type=Bond/Note/TIPS` | **fallback: bid-to-cover z-score** | 2026-09-10 | 端点 live，字段 `highYield`、`bidToCoverRatio`、`securityTerm`、`reopening`、`auctionDate` 确认。没有 WI 收益率，tail 按文档改用 BTC 相对该期限过去 12 次均值的 z-score（页面标注口径）。最近：9/10 30y 重开 5.308% BTC 2.61；8/20 30y TIPS 重开 2.973% BTC 2.82；8/13 30y 5.216% BTC 2.39；8/12 10y 4.683% BTC 2.53；7/23 10y TIPS 2.438% BTC 2.30 |
| interest_to_receipts | Fiscal Data `v1/accounting/mts/mts_table_9` | **live** | 2026-08-31 | 用 `line_code_nbr=120`（Receipts Total）和 `320`（Net Interest）的 `current_month_rcpt_outly_amt` 做 12 个月滚动和：2025-09→2026-08 净利息 ≈ 1,054bn / 收入 ≈ 5,389bn = **0.196** |
| foreign_official_chg_12m | TIC `slt_table5.txt` | **live（换了文件）** | 2026-06 | 文档里的 `Publish/mfh.txt` 已停更（停在 2023-01）。改用 `/resource-center/data-chart-center/tic/Documents/slt_table5.txt`（tab 分隔，13 个月），行 `Of Which: Foreign Official`：2026-06 3,778.1 vs 2025-06 3,892.5 → **−114bn**。滞后约 2.5 个月 |
| cb_gold_purchases_3m | WGC | **manual** | — | 页面上可编辑 JSON（月份 → 吨），未填时按 stale 规则权重归零 |
| crisis: move_high | Yahoo chart `^MOVE` | **live** | 2026-09-11 | 82.21（9/14 当日为 null，取最近有效值） |
| crisis: hy_widening | FRED `BAMLH0A0HYM2` | **live** | 2026-09-11 | 2.65；注意 FRED 只给最近 3 年（2023-09 起），够用 |
| crisis: funding_stress（SRF） | NY Fed `rp/repo/all/results/last/N.json` | **live** | 2026-09-14 | 文档里的 `rp/all/results/latest.json` 是 400，正确路径要带 method 段：`/api/rp/{repo|reverserepo|all}/all/results/{latest|last/N}.json`。`totalAmtAccepted` 单位是美元（不是百万）。当前 SRF 用量 0 |
| regime A: UNRATE / CPIAUCSL | FRED | **live** | 2026-08-01 | 4.1 / 334.131 |
| regime D: OPHNFB / GDP | FRED | **live** | 2026-04-01（Q2） | 季频 |
| context: DEXUSEU / DEXJPUS / DEXCHUS | FRED | **live** | 2026-09-04 | 可选 |
| context: FDHBFIN | FRED | **live** | 2025-10-01 | 季频，作 TIC 的降级替代 |
| context: cot_managed_money_net_gold | CFTC `dea/newcot/f_disagg.txt` | **live** | 2026-09-08 | 无表头 CSV，GOLD 行第 14/15 列 = Managed Money long/short：145,804 − 10,832 = **+134,972** 手 |
| fallback: Treasury real yield curve | `home.treasury.gov/.../pages/xml?data=daily_treasury_real_yield_curve&field_tdr_date_value=2026` | **live** | 2026-09-11 | Atom XML，`TC_5YEAR/10YEAR/30YEAR` = 2.38 / 2.60 / 3.07；比 FRED 新一天 |

## 与文档不一致、已处理的地方

1. stooq 拒绝 → 金价主源改 Yahoo `GC=F`（近月期货收盘）。
2. `Publish/mfh.txt` 停更 → 改 `slt_table5.txt`。
3. NY Fed repo 结果 API 路径要带 `/all/` method 段。
4. TreasuryDirect buyback 页面靠内部 API，但结果 XML 有可推算的 keyless URL，走 XML。
5. DTS 的 TGA 值在 `open_today_bal` 列（`close_today_bal` 全 null）。
6. Yahoo `range=max` 是月频，必须用 `period1/period2`。
7. FRED 多 series 合并（`id=A,B`）可用，但缺失值会错位成空串，snapshot 仍按单 series 拉。

## 需要你决定的（不阻塞，先按默认走）

- **gold ATH 口径**：用 GC=F 收盘的 running max（5,318）还是你记的 $5,589？默认 config `gold_ath_override: null`（用 running max），价格批触发（≤ $4,000）不受影响。
- **fed_path_6m 用哪个合约**：默认取"今天 + 6 个月"所在月份的 ZQ 合约（现在是 2027-03 = ZQH27），隐含 = 100 − 价格 − EFFR。

## 搭建过程中追加的发现（2026-09-14）

- Fiscal Data API：`filter` 里同时给两个字段、或值里带空格（`Total Marketable`）会让请求挂住不返回；改成单字段过滤（`security_class_desc:eq:Bills` / `:eq:_`）再在本地筛 `security_type_desc`，1 秒内返回。
- TreasuryDirect `TA_WS/securities/auctioned` 每次最多返回 250 行（不管 `days` 给多大）：Note 回到 2021-05、Bond 2019-12、TIPS 2019-11，够 12 次同期限均值用。
- ACM xls 的 keyless 降级：FRED `THREEFYTP10`（Kim-Wright 10y 期限溢价，日频）；回填时先用它，Actions 首跑换成 ACM。
- TIC `mfhhis01.txt`（按年分块、tab 分隔）有 2000 年起的 `For. Official` 行，用来补 `foreign_official_bn` 的历史。
- Yahoo `^MOVE` 用 `period1` 可拿 5 年；ZQ 合约各约 140 个交易日历史。
- 回填实际怎么做的：沙箱和本机 VM 都出不了网，所以用桌面 App 内置浏览器逐个源 fetch → gzip+base64 → 存进沙箱 → `scripts/ingest_dump.py` 用与 `snapshot.py` 相同的解析/合并代码生成 `data/history.json`。
