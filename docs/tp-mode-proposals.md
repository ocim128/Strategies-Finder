# Take-Profit Mode Proposals: Revealing True Strategy Edge

## Executive Summary

This document proposes novel take-profit (TP) modes designed to reveal **true strategy edge** in parameter space, analogous to how Kelly Criterion sizing reveals edge through optimal bet sizing. The key insight is that TP modes should not just maximize profit—they should **expose whether a strategy's parameters capture genuine market inefficiency** versus curve-fit noise.

## The Kelly Criterion Analogy

### Why Kelly Reveals Edge

Kelly Criterion sizing is valuable not because it produces the highest returns—it often doesn't. Its value comes from:

1. **Mathematical grounding**: Kelly fraction `f* = W - (1-W)/R` derives from first principles (win rate W, payoff ratio R)
2. **Edge sensitivity**: Small changes in win rate or payoff ratio produce measurable changes in optimal fraction
3. **Overfitting penalty**: Curve-fit strategies show unstable Kelly fractions across parameter perturbations
4. **Capital efficiency signal**: High Kelly fraction = high confidence in edge; low fraction = questionable edge

### The TP Problem

Current TP modes fall into two categories:

| Category | Modes | Problem |
|----------|-------|---------|
| **Static** | `fixed` | No adaptation to market regime or strategy behavior |
| **Descriptive** | `shrinkage`, `mfe_bootstrap` | Tell you what worked historically, not what the strategy *deserves* |
| **Mechanistic** | `atr_scaled`, `range_scaled`, `median_bar` | Scale to volatility, but don't measure edge |
| **Behavioral** | `momentum_gated`, `velocity` | Optimize exit timing, not edge revelation |

**Gap**: No TP mode answers: *"Given this strategy's signal quality and market context, what TP reveals whether the parameters are capturing real edge?"*

---

## Proposed TP Modes

### 1. `edge-weighted` — Signal Quality Adaptive TP

**Core Insight**: A strategy's take-profit should scale with the **statistical quality of the entry signal**, not just volatility or historical MFE.

**Mechanism**:
```
TP% = BaseTP% × SignalQualityMultiplier

SignalQualityMultiplier = f(signal_strength, confirmation_count, regime_fit)
```

**Signal Quality Components**:

1. **Signal Strength**: How extreme is the entry indicator vs. its recent distribution?
   - Z-score of entry trigger (e.g., RSI 25 when mean=50, std=10 → z=-2.5)
   - Percentile rank of entry metric

2. **Confirmation Count**: How many independent indicators agree?
   - Strategy fires on RSI < 30 AND MACD histogram positive AND volume > SMA
   - Each confirmation adds to multiplier

3. **Regime Fit**: Does this market regime match the strategy's design?
   - Trending strategy in trending market → multiplier > 1
   - Mean-reversion in choppy market → multiplier > 1
   - Mismatch → multiplier < 1

**Edge Revelation**:
- High-quality signals getting stopped at tight TP = strategy has **specific, exploitable edge**
- High-quality signals needing wide TP = edge is **noisy or timing is off**
- Low-quality signals working = strategy may be **lucky, not skilled**

**Implementation Notes**:
- Requires strategy to optionally expose signal metadata (strength, confirmations)
- Can be computed causally from entry-bar context
- Finder-optimized: precompute signal quality scores per bar

---

### 2. `expectancy-optimal` — Kelly-Inspired TP

**Core Insight**: Apply Kelly-like optimization to TP% itself, finding the TP that maximizes **geometric growth rate** given the strategy's historical trade distribution.

**Mechanism**:
```
For each candidate TP% in a grid:
  1. Simulate what trades would have closed at this TP%
  2. Compute growth rate: G = Σ log(1 + pnl_i / capital)
  3. Select TP% that maximizes G

TP%_optimal = argmax_TP% (geometric_mean_return)
```

**Key Difference from MFE Bootstrap**:
- MFE bootstrap asks: *"What was the typical favorable excursion?"*
- Expectancy-optimal asks: *"What TP% would have produced the best compounding?"*

**Edge Revelation**:
- Sharp optimum (narrow peak in G vs TP%) = strategy has **specific, repeatable profit pattern**
- Flat optimum (wide plateau) = strategy is **robust to TP choice** (good for deployment)
- Multiple local optima = strategy may be **regime-dependent or curve-fit**
- Optimum at very tight TP = strategy captures **quick inefficiencies** (scalping edge)
- Optimum at very wide TP = strategy needs **large moves** (may be trend-following)

**Regularization Options**:
- Penalize TP% that produces too few trades (overfitting risk)
- Constrain TP% to be within N% of current BaseTP%
- Use cross-validation: optimize on walk-forward windows, measure stability

**Implementation Notes**:
- Computationally expensive for Finder; best for single-strategy analysis
- Could precompute a lookup table: BaseTP% → OptimalMultiplier
- Consider caching per-strategy for repeated runs

---

### 3. `regime-calibrated` — Market State Adaptive TP

**Core Insight**: A strategy's edge is not constant—it varies with market regime. TP should adapt to **current regime** based on **historical regime-specific performance**.

**Mechanism**:
```
TP% = Σ (RegimeWeight_i × OptimalTP%_i)

where:
  RegimeWeight_i = Probability current market is in regime i
  OptimalTP%_i = Best TP% for this strategy in regime i (from history)
```

**Regime Dimensions**:
1. **Volatility**: Low / Medium / High (ATR percentile)
2. **Trend**: Strong up / Weak up / Neutral / Weak down / Strong down (ADX + DI)
3. **Mean-Reversion Tendency**: High / Low (efficiency ratio, autocorrelation)

**Example**:
- Strategy historically performs best with TP=8% in low-vol + ranging markets
- Strategy performs best with TP=15% in high-vol + trending markets
- Current market: low-vol + ranging → TP = 8%

**Edge Revelation**:
- Strategy shows consistent edge across regimes = **robust, generalizable**
- Strategy only works in one regime = **specialized edge** (deployable with regime filter)
- Strategy shows no regime differentiation = may be **random noise**

**Implementation Notes**:
- Requires regime classification at entry time (causal)
- Store regime-labeled trade history for each strategy
- Can combine with shrinkage: blend regime-specific with global estimate

---

### 4. `information-coefficient` — Predictive Power TP

**Core Insight**: Use the **correlation between signal strength and subsequent returns** to set TP. High IC = strategy has genuine predictive power = deserves wider TP.

**Mechanism**:
```
1. For recent N trades, correlate:
   - X = signal strength at entry (e.g., how extreme RSI was)
   - Y = actual favorable excursion (MFE%)

2. Information Coefficient (IC) = correlation(X, Y)

3. TP% = BaseTP% × (1 + IC × ScalingFactor)

   IC = -1 → TP% = BaseTP% × (1 - ScalingFactor)  [tighter]
   IC = 0  → TP% = BaseTP%                        [baseline]
   IC = +1 → TP% = BaseTP% × (1 + ScalingFactor)  [wider]
```

**Edge Revelation**:
- High positive IC = strategy's signal extremity **predicts** move size = **genuine edge**
- Low/negative IC = signal strength doesn't predict outcomes = **strategy may be curve-fit**
- Rising IC over time = strategy edge is **strengthening**
- Falling IC over time = edge is **decaying** (market adapted)

**Advanced Variant**: Compute IC separately for long/short, as strategies often have asymmetric edge.

**Implementation Notes**:
- Need to store signal strength metadata per trade
- Rolling window (e.g., last 50 trades) for recency
- Fisher z-transform for correlation stability

---

### 5. `path-efficiency` — Trade Quality TP

**Core Insight**: Not all wins are equal. A trade that goes straight to TP shows **cleaner edge** than one that meanders. TP should adapt to **how efficiently** the strategy's trades reach profit.

**Mechanism**:
```
Path Efficiency = MFE% / Close%  (for winners)
                = Average(MFE_to_Close_Ratio)

- Efficiency = 1.0: Trade went straight to exit, no drawdown
- Efficiency = 2.0: Trade had 2× MFE before closing (left money on table or survived drawdown)

TP Adjustment:
  - High efficiency (clean paths) → widen TP (strategy "deserves" more)
  - Low efficiency (messy paths) → tighten TP (cut winners sooner)
```

**Edge Revelation**:
- High efficiency + high win rate = **clean, exploitable edge**
- Low efficiency + high win rate = strategy survives noise but **leaves profit**
- High efficiency + low win rate = strategy times well but **wrong direction**
- Low efficiency + low win rate = **no edge** (curve-fit)

**Variant: Pain-Weighted TP**
```
Pain Ratio = Average(MAE% / MFE%) for recent trades

High pain ratio → tighten TP (strategy experiences lots of drawdown)
Low pain ratio → widen TP (smooth equity curve)
```

**Implementation Notes**:
- Track MFE and MAE (maximum adverse excursion) per trade
- Causal: only use closed trades
- Can combine with win rate for composite quality score

---

### 6. `serial-dependency` — Streak-Aware TP

**Core Insight**: Strategies often have **serial correlation** in outcomes (hot/cold streaks). TP should adapt to **current streak state**.

**Mechanism**:
```
Current Streak State:
  - Win streak length, Loss streak length
  - Recent N-trade win rate vs. long-term win rate

TP Adjustment:
  - Hot streak (recent WR > long-term WR) → widen TP (confidence high)
  - Cold streak (recent WR < long-term WR) → tighten TP (preserve capital)
  - Mean-reverting strategies: opposite logic
```

**Edge Revelation**:
- Positive serial correlation = strategy has **momentum in edge** (regime-dependent)
- Negative serial correlation = strategy **mean-reverts** (good for sizing, bad for TP)
- No serial correlation = outcomes are **independent** (stable edge)

**Advanced: Gambler's Fallacy Correction**
```
If strategy shows NO serial correlation:
  → Disable streak-based TP adjustment (outcomes are independent)
```

**Implementation Notes**:
- Track closed trade sequence
- Statistical test for serial correlation (e.g., runs test)
- Can combine with Kelly-style fraction for position sizing synergy

---

### 7. `minimum-surprisal` — Robustness-Focused TP

**Core Insight**: Inspired by information theory. Set TP% to the value that **minimizes surprisal** (maximizes likelihood) of observed trade outcomes.

**Mechanism**:
```
For candidate TP% values:
  1. For each historical trade, compute "surprisal":
     - If trade would win at this TP: surprisal = -log(P(win))
     - If trade would lose: surprisal = -log(1 - P(win))
  
  2. Total Surprisal = Σ surprisal_i
  
  3. Select TP% that minimizes total surprisal

This is equivalent to Maximum Likelihood Estimation of optimal TP%.
```

**Edge Revelation**:
- Sharp minimum in surprisal curve = **clear signal** in data (strong edge)
- Flat surprisal curve = **no information** in TP choice (weak/no edge)
- Minimum at extreme TP% = strategy may be **overfit to outliers**

**Connection to Kelly**:
- Both optimize logarithmic objectives
- Kelly: maximize log(wealth)
- Minimum surprisal: maximize log(likelihood of outcomes)

**Implementation Notes**:
- Similar computational cost to expectancy-optimal
- Can add regularization (penalize extreme TP%)
- More statistically principled than simple grid search

---

## Comparison Matrix

| TP Mode | Computation | Edge Signal | Finder-Safe | Rust-Compatible |
|---------|-------------|-------------|-------------|-----------------|
| `edge-weighted` | Low | Signal quality | ✅ (with precompute) | ⚠️ (needs metadata) |
| `expectancy-optimal` | High | Growth optimum | ⚠️ (expensive) | ✅ |
| `regime-calibrated` | Medium | Regime specificity | ✅ | ✅ |
| `information-coefficient` | Low | Predictive power | ✅ | ✅ |
| `path-efficiency` | Low | Trade quality | ✅ | ✅ |
| `serial-dependency` | Low | Streak behavior | ✅ | ✅ |
| `minimum-surprisal` | High | Statistical confidence | ⚠️ (expensive) | ✅ |

---

## Recommended Implementation Priority

### Phase 1: Quick Wins (Low Computation, High Insight)
1. **`path-efficiency`** — Simple MFE/MAE tracking, immediate edge insight
2. **`information-coefficient`** — Correlation-based, reveals predictive power

### Phase 2: Moderate Complexity
3. **`serial-dependency`** — Streak tracking, synergizes with Kelly sizing
4. **`regime-calibrated`** — Requires regime classification infrastructure

### Phase 3: High Value, Higher Cost
5. **`expectancy-optimal`** — Kelly for TP, computationally intensive
6. **`minimum-surprisal`** — Statistically principled, similar cost to #5

### Phase 4: Requires Strategy Integration
7. **`edge-weighted`** — Needs strategy signal metadata exposure

---

## Integration with Existing Modes

### Mode Blending
Consider allowing blends:
```
TP% = α × shrinkage_estimate + β × path_efficiency + γ × information_coefficient

where α + β + γ = 1
```

### Cascade Approach
```
1. Start with `shrinkage` (historical pair-specific baseline)
2. Adjust by `path-efficiency` (trade quality modifier)
3. Gate by `information-coefficient` (reduce if IC is low/negative)
```

---

## New Metrics to Display

When using edge-revealing TP modes, show:

1. **TP Optimization Curve** (for expectancy-optimal/minimum-surprisal)
   - X-axis: TP%
   - Y-axis: Growth rate / Surprisal
   - Shows sharpness of optimum

2. **Information Coefficient Chart**
   - Rolling IC over time
   - Shows edge decay/strengthening

3. **Path Efficiency Distribution**
   - Histogram of MFE/Close ratios
   - Shows how "cleanly" strategy wins

4. **Regime Heatmap**
   - Performance by regime bucket
   - Shows where edge concentrates

---

## Validation Protocol

For each new TP mode:

1. **Baseline Comparison**: Run same strategy with `fixed` TP at multiple levels
2. **Edge Injection Test**: Create synthetic strategies with known edge properties
   - Verify TP mode responds appropriately
3. **Overfitting Stress Test**: Compare in-sample vs. out-of-sample TP optima
   - Stable = good; wildly different = overfitting-prone
4. **Finder Convergence**: Does Finder with this TP mode find similar params across seeds?
   - Convergence = robust; divergence = noise-sensitive

---

## Conclusion

The key insight from Kelly Criterion is that **sizing reveals edge through optimization**. These proposed TP modes apply the same philosophy: instead of treating TP as a mere exit mechanic, use it as a **diagnostic tool** that reveals whether a strategy's parameters capture genuine, exploitable market inefficiency.

**Best candidates for initial implementation**:
1. `path-efficiency` — Simple, intuitive, immediate insight
2. `information-coefficient` — Statistically grounded, low cost
3. `expectancy-optimal` — Kelly for TP, highest conceptual alignment

These modes will help distinguish strategies that **deserve** their parameters from those that merely **survived** optimization.
