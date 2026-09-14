# 仓位模型（打分 → 黄金专用资金的投入比例）

## 结构

    已投入比例 = base + overlay_fraction(composite) × overlay_max

- **分母是黄金专用资金**（dedicated gold capital），不是总组合。模型回答的问题是：这笔钱现在该投进去多少、留多少干火药。
- **base**：永远在场的部分，对尾部（锚丢失、CPI 口径被动手脚、储备货币地位受损、资本管制）的保险，不参与打分。默认 40%。
- **overlay**：0 到 overlay_max（默认 60%）之间，由 composite score 驱动。
- **干火药的停放处**：未投入部分放短期 TIPS 或 bills，不放活期。2%+ 的实际收益率本身就是 A 路径的 hedge，实际收益率下行时它自己会涨，不是死钱。
- 所以默认区间是 40%–100% 已投入。base 和 overlay_max 是我的参数，不是模型输出。

## Composite → overlay_fraction（默认 bands）

| composite | overlay_fraction | 已投入比例 | 干火药 |
|---|---|---|---|
| 0–30 | 0 | 40% | 60% |
| 30–60 | 1/3 | 60% | 40% |
| 60–80 | 2/3 | 80% | 20% |
| 80–100 | 1 | 100% | 0 |

## 干火药的三批触发（页面上做成 checklist）

1. **价格批（约 15%）**：金价到 $3,800–4,000（从 ATH 回撤约 30%，牛市中典型的调整深度），不看信号直接加。
2. **信号批（约 15%）**：任一触发即加——60 日相关系数翻正 > 0.3；10y breakeven 站上 2.6；实际政策利率转负；联储在核心 PCE > 3 时路径转为降息。
3. **危机批（剩余）**：只在 `intervention_flag = ON` 后加，流动性阶段（`crisis_flag = ON` 且未介入）一律不动。
4. 三批之外，如果只是实际收益率慢慢下行（A 路径），composite 自己会爬，按周结算换档时加。

## 滞回（防止来回打脸）

- 仓位建议只在**每周五收盘结算**时更新；日频只更新指标和图表
- band 切换需要**连续两个周五结算**都落在新 band（`hysteresis_weeks = 2`），上下对称
- 页面同时显示"日频 composite"和"结算 band"，两者不一致时标注"待确认"

## 危机序列覆盖（引擎必须实现，优先级高于 bands）

1. `crisis_flag = ON` 且 `intervention_flag = OFF`：**冻结 overlay 的增加**——允许减、不允许加，不管 composite 多高。这是 B 路径"先痛后涨"的纪律：流动性阶段黄金通常先跌 15–30%。
2. `intervention_flag = ON`：**overlay 直接置满**，跳过滞回。联储回到长端就是 debasement 分支确认。
3. `intervention_flag` 由 ON 回到 OFF 后，恢复正常 bands 逻辑，但保留 4 周滞回再允许下调。
4. crisis / intervention 两个 flag 的定义见 `03_metrics.json`。`manual_intervention` 是我手动设的开关（联储宣布 RMP 之外的购买、紧急工具、收益率目标时我会打开并填日期）。

## 表达方式提示（只显示，不自动执行）

当 composite 在 30–60 且 C 路径已满足触发条件 ≥ 2/6，或 B 路径已满足 ≥ 2/4 时，页面显示一条提示：「regime 跳变概率在升但未确认——优先考虑凸性表达（长期限黄金看涨、曲线陡峭化头寸），而不是加线性仓位；付的是期权费，不是每年 2% 的 carry。」

## 示例：2026-09-11 收盘（引擎单测基准）

下面的输入是从公开来源估的，标 `≈` 的是估计值，Cowork 用 live 数据重算后以 live 为准；单测只要求复现 composite ±3 分和同一个 band。

### Real-rate path（权重 0.40）

| 指标 | 输入 | 分 | 权重 |
|---|---|---|---|
| dfii5_level | ≈2.30 | 0 | 1.0 |
| dfii5_chg_60d | ≈+0.45 | 5 | 1.0 |
| dfii10_gap_rstar | 2.59 − 1.0 = 1.59 | 0 | 1.0 |
| dfii30_level | 3.05 | 0 | 0.5 |
| real_policy_rate | 3.63 − 3.3 = +0.33 | 56 | 1.0 |
| fed_path_6m | ≈+30bp | 20 | 1.0 |

组分 ≈ **15**

### Anchor（权重 0.35）

| 指标 | 输入 | 分 | 权重 |
|---|---|---|---|
| t10yie_level | 2.38 | 48 | 1.0 |
| t5yifr_level | ≈2.30 | 50 | 1.0 |
| acm_tp10_level | ≈1.25 | 83 | 0.75 |
| curve_2s30s_chg_20d | ≈−5bp | 38 | 0.75 |
| dollar_broad_chg_60d | ≈−1.5% | 69 | 0.75 |
| gold_real_corr_60d | ≈−0.45 | 19 | 1.5 |

组分 ≈ **47**

### Plumbing（权重 0.25）

| 指标 | 输入 | 分 | 权重 |
|---|---|---|---|
| bills_share | ≈22.5% | 75 | 1.0 |
| walcl_chg_13w | ≈+80bn | 70 | 1.0 |
| tga_chg_4w | ≈+50bn | 38 | 0.5 |
| sofr_iorb_spread | ≈+5bp | 67 | 0.75 |
| rrp_level | ≈20bn | 90 | 0.25 |
| buyback_actual_qtr | ≈12bn | 35 | 0.5 |
| auction_tail_long | ≈+1.0bp | 67 | 0.75 |
| interest_to_receipts | ≈0.21 | 60 | 0.75 |
| foreign_official_chg_12m | ≈−80bn | 70 | 0.5 |
| cb_gold_purchases_3m | ≈180t | 60 | 0.5 |

组分 ≈ **64**

### 结果

- composite ≈ 0.40×15 + 0.35×47 + 0.25×64 ≈ **38**
- crisis_flag：OFF（MOVE 未破 120，HY 未走阔 100bp，30y 实际收益率 20 日涨幅 < 40bp 且 breakeven 未跌，无融资压力）
- intervention_flag：OFF
- 路径证据：A 1/4，B 0–1/4，C 0/6，D 0–1/3 → 证据弱倾向 A，与先验一致
- band：30–60 → base + 1/3 overlay → **已投入约 60%**（40% + 20%），干火药 40% 停在短期 TIPS/bills，按上面三批触发释放
- 读法：real-rate path 极低（市场信联储），plumbing 偏高（管道在铺），anchor 中性——这就是"趋势对、时点早"的量化版本。
- 如果 9/16 加息 25bp：real_policy_rate 升到 +0.58（分 ≈ 47），fed_path_6m 因一次加息已兑现而略降（分略升），composite 大约 36–37，同一 band。

## config.json 初始内容

```json
{
  "r_star": 1.0,
  "base_pct": 40.0,
  "overlay_max_pct": 60.0,
  "denominator": "dedicated gold capital (the sleeve set aside for gold), not total portfolio",
  "dry_powder_parking": "short TIPS or T-bills",
  "tranches": {
    "price": { "pct": 15, "trigger": "gold_spot <= 4000" },
    "signal": { "pct": 15, "trigger": "gold_real_corr_60d > 0.3 OR t10yie_level > 2.6 OR real_policy_rate < 0 OR (fed_path_6m < 0 AND PCEPILFE_yoy > 3.0)" },
    "crisis": { "pct": "remaining", "trigger": "intervention_flag == ON" }
  },
  "bands": [
    { "max": 30, "overlay_fraction": 0.0 },
    { "max": 60, "overlay_fraction": 0.3333 },
    { "max": 80, "overlay_fraction": 0.6667 },
    { "max": 100, "overlay_fraction": 1.0 }
  ],
  "settlement_day": "Friday",
  "hysteresis_weeks": 2,
  "post_intervention_hysteresis_weeks": 4,
  "crisis_min_true": 2,
  "crisis_rule": "freeze_overlay_adds",
  "intervention_rule": "overlay_to_max",
  "regime_priors": { "A": 0.45, "B": 0.25, "C": 0.20, "D": 0.10 },
  "manual_intervention": { "on": false, "date": null, "note": "" },
  "stale_days_zero_weight": 10,
  "near_trigger_pct": 0.20,
  "expression_note": { "score_min": 30, "score_max": 60, "c_min_true": 2, "b_min_true": 2 },
  "gold_model_fit_window": { "start": "2006-01-01", "end": "2021-12-31" },
  "corr_window_days": 60
}
```

参数由我自己设定；模型输出是区间建议，不是投资建议。
