# 数据源（全部 keyless；开工前逐个 live 验证）

原则：不用付费 API、不用 key。每个端点先 curl 验证再接入；URL 格式可能已变，以验证结果为准，不通就换 fallback 并记录。所有请求带正常的 User-Agent，加重试和超时。

## 1. FRED — 主力源（keyless CSV，不需要 API key）

格式：`https://fred.stlouisfed.org/graph/fredgraph.csv?id=SERIES`（多个 series 用逗号拼接，验证是否支持）。返回全历史日频 CSV，缺失值为 `.`。

| 用途 | Series |
|---|---|
| 5y / 10y / 30y TIPS 实际收益率 | DFII5, DFII10, DFII30 |
| 2y / 10y / 30y 名义 | DGS2, DGS10, DGS30 |
| 10y breakeven；5y5y forward | T10YIE, T5YIFR |
| 政策利率与管道 | EFFR（fallback DFF）, IORB, SOFR, RRPONTSYD |
| Fed 资产负债表；TGA；准备金 | WALCL, WTREGEN, WRESBAL |
| 广义美元指数 | DTWEXBGS |
| 通胀与就业 | CPIAUCSL, PCEPILFE, UNRATE |
| 信用利差 | BAMLH0A0HYM2 |
| 生产率（季度） | OPHNFB |
| 汇率（可选，非美元计价黄金） | DEXUSEU, DEXJPUS, DEXCHUS |
| GDP（赤字/GDP 分母） | GDP |

验证：`curl -s "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DFII10" | tail -3`，确认最后一行日期是最近的交易日。

## 2. 美国财政部 — 实际收益率曲线（FRED 的 fallback）

Daily Par Real Yield Curve：`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_real_yield_curve&field_tdr_date_value=2026`（HTML 表），同页有 XML/CSV 导出链接，验证后用导出格式。

## 3. NY Fed — ACM 期限溢价 & Markets Data API

- ACM term premium：`https://www.newyorkfed.org/research/data_indicators/term-premia-tabs`，页面有 xls 下载（历史上是 `.../medialibrary/media/research/data_indicators/ACMTermPremium.xls`），取 `ACMTP10` 列。月更或日更以文件为准。
- Markets Data API（keyless JSON）：SOFR `https://markets.newyorkfed.org/api/rates/secured/sofr/last/5.json`；回购操作（SRF 用量）`https://markets.newyorkfed.org/api/rp/all/results/latest.json`。字段名以返回为准。

## 4. Fiscal Data（财政部 API，keyless JSON）

Base：`https://api.fiscaldata.treasury.gov/services/api/fiscal_service/`

- **bills 占比**：MSPD（Monthly Statement of the Public Debt）`v1/debt/mspd/mspd_table_1`，取 Bills / Total Marketable。月更。
- **利息 / 收入**：MTS（Monthly Treasury Statement）`v1/accounting/mts/mts_table_1`（receipts）和 `mts_table_5` 或 `mts_table_9`（net interest 所在表，验证列名），做 12 个月滚动和。
- **TGA**（FRED 的 fallback）：DTS `v1/accounting/dts/operating_cash_balance`。
- 所有端点支持 `?sort=-record_date&page[size]=N`。

## 5. TreasuryDirect — 拍卖与 buyback

- 拍卖结果 JSON：`https://www.treasurydirect.gov/TA_WS/securities/auctioned?format=json&type=Note`（以及 `type=Bond`、`type=TIPS`）。字段包括 `bidToCoverRatio`、`highYield`、`auctionDate`、`securityTerm` 等，验证字段名。tail = highYield − when-issued；WI 收益率 TreasuryDirect 不给，**tail 的 fallback**：用 bidToCoverRatio 与该期限过去 12 次的均值之差做 z-score 替代，写清楚是替代口径。
- buyback 结果：`https://www.treasurydirect.gov/auctions/buybacks/`（结果公告页）。先看有没有 JSON 端点（TA_WS 可能有 buyback 相关服务），没有就解析 HTML，记录每次操作的 `offered / accepted / bucket / date`。

## 6. 金价

- 首选 stooq CSV（keyless）：`https://stooq.com/q/d/l/?s=xauusd&i=d`（全历史日频）。
- fallback Yahoo chart API：`https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=max&interval=1d`（带 User-Agent；这是半官方端点，可能限流）。
- MOVE 指数只有 Yahoo：`.../chart/%5EMOVE?range=1y&interval=1d`。

## 7. 联储路径（fed_path_6m）

- 首选：fed funds 期货（ZQ）合约，Yahoo chart API 取未来 6 个月的合约（如 `ZQH27.CBT`），隐含利率 = 100 − 价格，与 EFFR 之差即为路径。合约代码规则按月份字母（F G H J K M N Q U V X Z）+ 年份。
- fallback：`(DGS2 − EFFR) × 100` bp 作为 6 个月路径的粗代理（会高估，但方向对）。页面标注用了 fallback。
- CME FedWatch 没有 keyless API，不要去爬。

## 8. TIC — 外国官方持有

- Major Foreign Holders 文本：`https://ticdata.treasury.gov/Publish/mfh.txt`（月更，滞后约 6 周），取 "Foreign Official" 行（如果该文件不分官方/私人，改用 TIC 的 slt 表，或用 FRED `FDHBFIN` 季度序列作为"全部外国持有"的降级替代并标注）。

## 9. CFTC COT（仓位上下文，不打分）

- Disaggregated futures-only 文本：`https://www.cftc.gov/dea/newcot/f_disagg.txt`，取 `GOLD - COMMODITY EXCHANGE INC.` 的 Managed Money long − short。周更（周五发布周二数据）。

## 10. 央行购金（手动）

- WGC 的央行数据需要注册下载，没有 keyless 端点。做成页面上可编辑的 JSON 字段（月份 → 净购买吨数），我每月手动填一次；未填时该指标权重按 stale 规则降为 0。

## 已知缺口与处理

| 缺口 | 处理 |
|---|---|
| FedWatch 概率 | 用 ZQ 期货或 2y−EFFR 代理，不爬 CME |
| 拍卖 tail 需要 WI 收益率 | 用 bid-to-cover z-score 替代，标注口径 |
| 央行购金 | 手动月填 |
| buyback 接受额 | 解析 HTML，结构变了要报警 |
| 外国官方持有滞后 6 周 | 接受，页面标注数据月份 |
| 稳定币持有的 bills（captive demand 的一块） | v1 不做；以后可加 DeFiLlama 稳定币市值作为代理 |

## 验证步骤（第一步交付物：端点状态表）

对每个端点：
1. `curl -sS -A "Mozilla/5.0" -m 20 "<url>"`，记录 HTTP 状态
2. 解析，打印最后 3 条记录和最新日期
3. 判断：最新日期是否在预期 cadence 内（日频 ≤ 3 个交易日，周频 ≤ 10 天，月频 ≤ 45 天）
4. 状态：`live` / `fallback:<which>` / `manual`
5. 输出一张表：指标 id、端点、状态、最新日期、备注

任何端点验证失败先记录再往下走，不要停在一个端点上。
