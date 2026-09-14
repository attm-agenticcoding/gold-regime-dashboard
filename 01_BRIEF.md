# Gold Regime Monitor — 项目 Brief

## 目的

用可验证的市场与财政数据，把一个判断——**黄金是对未来实际收益率路径和货币锚可信度的 bet，不是对印钞量的 bet**——变成一个每天更新的 regime score，并映射成黄金专用资金的投入比例（投多少、留多少干火药）。目标是让加减仓有触发条件、有滞回、有顺序纪律，而不是跟着新闻情绪走。

使用者只有我一个人，手机上看为主。

## 交付物

1. 静态 dashboard（GitHub Pages），单页，移动端优先
2. 数据层：`scripts/snapshot.py` + `data/history.json`（追加式，每交易日一条）
3. 打分与仓位引擎：纯函数，输入 `history.json` + `config.json`，输出 `{composite, subscores, regime_state, regime_evidence, crisis_flag, intervention_flag, band, last_state_change}`；可单测
4. "Regime weekly" 面板：每周五结算后生成的一段文字摘要（本周分数、状态、触发条件变化、建议区间）。先做成页面面板，通知渠道以后再接

## 页面结构（自上而下）

1. **Header** — composite score（0–100）、当前 regime state（A/B/C/D 各自的先验概率 + 证据倾向）、crisis flag、Fed intervention flag、建议投入比例（占黄金专用资金）与干火药比例、三批触发的 checklist 状态、上次状态切换日期、本周结算日
2. **三个子分数卡片** — Real-rate path / Anchor / Plumbing：分数、周变化、贡献最大的两个指标
3. **Gold decomposition 图** — 金价 vs 实际收益率模型价 vs 溢价（residual）的时间序列。模型：2006–2021 区间 log(gold) 对 DFII10 的回归，系数写进页面
4. **Regime flip 图** — 黄金与 10y 实际收益率日变化的 60 日滚动相关系数，标出符号翻转的日期
5. **实际收益率曲线** — 5y/10y/30y TIPS：当前 vs 1 个月前 vs 3 个月前，画 r* 参考线（config 里默认 1.0%）
6. **Anchor 面板** — 10y breakeven、5y5y forward、ACM 10y 期限溢价、2s30s、广义美元指数，各带 20/60 日变化
7. **Plumbing 面板** — bills 占可流通债务比例、Fed 资产负债表 13 周变化、TGA 及 4 周变化、SOFR−IORB、ON RRP、最近 3 次长端拍卖的 tail 与 bid-to-cover、buyback 当季实际接受额、利息支出/收入
8. **触发条件清单** — 四条路径各自的触发条件，当前哪些已满足（勾）、哪些接近（半勾，定义为距阈值 20% 以内）
9. **What changed** — 本周与上周相比 z-score 变化最大的 5 个指标
10. **数据状态** — 每个指标的最后更新时间、来源、是否用了 fallback、是否为手动输入

## 架构默认值

- GitHub Pages + 纯前端（HTML/JS；图表库自选，轻量优先；不要引入需要 build 的框架）
- GitHub Actions cron：每个交易日 22:00 UTC 跑 `scripts/snapshot.py`；失败要在页面"数据状态"里可见，不能静默
- 所有指标定义来自 `03_metrics.json`；引擎参数来自 `config.json`（初始内容见 `04_SIZING_MODEL.md` 末尾）
- 不需要任何付费 API 或 key。若某个指标只能靠 key，用 `05_DATA_SOURCES.md` 里的 fallback，或标记为手动输入（页面上给一个可编辑的 JSON 字段）
- 缺数据的日子：该指标当日记为 `null`，打分时沿用最近一次有效值并在页面标注"stale N 天"；连续 stale 超过 10 个交易日的指标权重自动降为 0 并提示

## 非目标

- 不做自动交易、不接券商
- 不做价格预测；只做 regime 分类和仓位区间
- 不追求实时 tick，日频足够
- 不做多用户、不做登录

## 验收标准

- [ ] 端点状态表：每个指标处于 "live 验证通过 / fallback / 手动" 三种状态之一，附验证日期
- [ ] `history.json` 连续 5 个交易日正确累积；缺数据有明确 `null` 标记，不静默填 0
- [ ] 回填：DFII5/DFII10/DFII30/T10YIE/T5YIFR/金价 至少 5 年日频历史
- [ ] 引擎单测：用 `04_SIZING_MODEL.md` 的示例输入，复现示例 composite（±3 分）和 band
- [ ] 滞回单测：单周越线不切换 band，连续两个周五结算越线才切换
- [ ] 危机序列单测：`crisis_flag=ON` 且 `intervention_flag=OFF` 时 overlay 不允许增加；`intervention_flag=ON` 时 overlay 直接置满
- [ ] 手机首屏能看到 Header 全部信息，无横向滚动
- [ ] 页面底部固定一行：「参数由我自己设定，这不是投资建议」——给自己的纪律提醒
