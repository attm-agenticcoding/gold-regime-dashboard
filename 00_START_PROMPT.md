# Cowork 启动 prompt（整段复制贴进去，附上这个文件夹）

我要做一个自动更新的 dashboard：**Gold Regime Monitor**。它追踪实际收益率路径、通胀锚、以及 fiscal dominance 的 plumbing 指标，输出一个 0–100 的 regime score、当前所处的路径（A/B/C/D）、危机序列 flag，并映射成我专门留给黄金的那笔资金现在该投入多少、留多少干火药的建议（分母是黄金专用资金，不是总组合）。

分析框架、指标清单、数据源、仓位模型我都已经写好了，都在这个文件夹里，请先完整读一遍再开工：

- `01_BRIEF.md` — 要做什么、页面结构、架构默认值、验收标准
- `02_THESIS_AND_REGIMES.md` — 为什么这么做，四条路径和触发条件（这是整个 dashboard 的逻辑源头，UI 上的每个面板都对应这里的一条判断）
- `03_metrics.json` — 指标注册表：数据源、变换、阈值、权重、分组、危机 flag、四条路径的触发条件。这是 single source of truth，代码从它读，不要把指标定义写死在代码里
- `04_SIZING_MODEL.md` — 打分 → 仓位映射、滞回、危机序列覆盖规则，以及用 2026-09-11 数据算的示例（用来做引擎的单测基准）
- `05_DATA_SOURCES.md` — keyless 端点、fallback、已知缺口、验证步骤

## 默认决定（按这个走，不用再问我，除非遇到真正的阻碍）

1. **架构**沿用我 ETH dashboard 的模式（attm-agenticcoding.github.io/eth-capital-mandate）：GitHub Pages 静态站 + keyless API。新 repo 叫 `gold-regime-dashboard`。
2. **数据层**：GitHub Actions 每个交易日 22:00 UTC（美东 18:00）跑 `scripts/snapshot.py`，拉全部指标，把当日快照追加进 `data/history.json` 后 commit。前端只读这个文件，不让浏览器直接打十几个 API。首次运行回填至少 5 年历史（FRED 的 fredgraph.csv 直接给全历史）。
3. **打分节奏**：指标和图表日更；仓位建议按周结算（每周五收盘），滞回规则见 `04_SIZING_MODEL.md`。
4. **参数**：阈值、权重、base/overlay、四条路径的先验概率全部放在 `03_metrics.json` 和 `config.json`，我会自己调。
5. **语言**：界面中文为主，指标名保留英文。手机优先。

## 开工顺序

1. 先把 `05_DATA_SOURCES.md` 里每个端点逐个 live 验证（curl + 解析 + 打印最后 3 行和日期），给我一张"端点状态表"：live 通过 / 用了 fallback / 需要手动。不通的先标记，不要卡住。
2. 数据层 + 历史快照 + 回填。
3. 打分与仓位引擎（纯函数，输入 history.json，输出 score / subscores / state / band），用 `04_SIZING_MODEL.md` 的示例做单测。
4. UI。

每一步做完给我看一眼再继续。验收标准在 `01_BRIEF.md` 最后一节。只有真正的阻碍（比如某个关键数据源必须要 key）再来问我，其余按默认值。
