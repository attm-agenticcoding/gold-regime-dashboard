# Gold Regime Monitor

黄金 regime 监测：追踪实际收益率路径、通胀锚、fiscal dominance 的 plumbing 指标，输出 0–100 的 composite、四条路径（A/B/C/D）的证据倾向、crisis / Fed intervention flag，并映射成黄金专用资金的投入比例（base + overlay）。

设计文档：`00_START_PROMPT.md` → `01_BRIEF.md` → `02_THESIS_AND_REGIMES.md` → `03_metrics.json`（指标注册表，single source of truth）→ `04_SIZING_MODEL.md` → `05_DATA_SOURCES.md`。端点验证结果在 `docs/ENDPOINT_STATUS.md`。

## 结构

```
index.html / app.js      静态页（GitHub Pages，手机优先，中文；无 build）
engine.js                打分与仓位引擎：纯函数，浏览器和 node 共用
03_metrics.json          指标定义、阈值、权重、分组、flag 条件、四条路径触发条件（引擎从这里读，不写死）
config.json              r*、base/overlay、bands、滞回周数、先验、manual_intervention、stale 阈值等
data/history.json        数据层输出（追加式；日表 / 周表 / 月表 / 拍卖 / buyback / SRF / COT / 来源状态 / 运行记录）
data/endpoint_status.json 每次运行的端点状态表（页面"数据状态"读它）
data/manual.json         手动输入：央行购金（WGC，月份→吨）
scripts/snapshot.py      数据层：拉全部 keyless 源并合并进 history.json（标准库 + xlrd）
scripts/ingest_dump.py   一次性 bootstrap：从浏览器抓的原始 payload 生成 history.json（与 snapshot.py 共用解析/合并代码）
scripts/smoke.mjs        跑引擎、打印 weekly 摘要，数据层坏了就退出非零
tests/engine.test.mjs    引擎单测（04 示例、滞回、危机序列、表达式解析、stale）
.github/workflows/snapshot.yml  工作日 22:00 UTC：单测 → snapshot → smoke → commit
```

## 引擎逻辑（对应 02 / 04）

- 每个指标按 `direction` + `thresholds` 分段线性映射到 0–100；组分 = 加权均值；composite = Σ 组权重 × 组分。
- stale：指标超过 `stale_days_zero_weight`（默认 10 个交易日）没有新值 → 权重归零并在页面标注。计数按各指标 cadence 扣除正常发布间隔（月频 55 个交易日、季频 130、周频 7、拍卖/buyback 70），所以月频指标不会因为发布间隔被误判。
- 触发条件 / flag / 三批触发的表达式直接从 JSON 解析（支持 `chg_Nd(X)`、`chg_Nm(X)`、`between`、`AND/OR/NOT`）。"接近"= 距阈值 20% 以内（`near_trigger_pct`）。
- 仓位：`已投入 = base + overlay_fraction(composite) × overlay_max`。band 只在每周五结算切换，需连续 `hysteresis_weeks` 个周五落在新 band；`crisis_flag=ON 且 intervention=OFF` 冻结加仓（允许减）；`intervention=ON` overlay 直接置满，跳过滞回；退出后保留 `post_intervention_hysteresis_weeks` 周再允许下调。页面同时显示日频 composite 和结算 band，不一致标"待确认"。
- 金价分解：`log(gold) = a + b·DFII10`，样本 `gold_model_fit_window`（默认 2006-01–2021-12），系数、n、R² 显示在页面上；溢价 = 实际 − 模型价。
- Regime flip：黄金与 DFII10 日变化的 60 日滚动相关；翻转 = 符号变化且之后至少保持 5 个交易日。

## 数据源要点（详见 docs/ENDPOINT_STATUS.md）

全部 keyless。FRED fredgraph.csv 是主力；金价用 Yahoo `GC=F`（stooq 拒绝访问）；拍卖 tail 没有 WI 收益率，改用 bid-to-cover 相对同期限过去 12 次的 z-score（页面标注口径）；buyback 结果从 TreasuryDirect 可推算的 XML URL 读；TIC 用 `slt_table5.txt`（`mfh.txt` 已停更）+ `mfhhis01.txt` 补历史；ACM 期限溢价用 xlrd 解 NY Fed 的 xls，失败时用 FRED `THREEFYTP10`；央行购金手动填。

## 本地跑

```
node --test tests/engine.test.mjs
python3 -m unittest tests/test_snapshot.py
python3 -m http.server 8000   # 打开 http://localhost:8000/
python3 scripts/snapshot.py --validate-only   # 只出端点状态表
python3 scripts/snapshot.py                   # 正式拉数（需要能访问 FRED 等域名）
```

## 部署

GitHub → Settings → Pages → Source: Deploy from a branch → `main` / `/ (root)`。Actions 的 workflow 需要 `contents: write`（已在 yml 里声明）。第一次可以在 Actions 页手动 `Run workflow`。

## 参数

阈值、权重、分组在 `03_metrics.json`；base/overlay、bands、滞回、先验、r*、manual_intervention、gold ATH 覆盖值等在 `config.json`。改这两个文件不需要改代码。

参数由我自己设定，这不是投资建议。
