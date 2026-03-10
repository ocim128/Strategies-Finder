# 10 Unique Market Structure Exploitation Strategy Ideas

## Overview
This document presents 10 unique trading strategies that exploit market structure using only OHLC data. Each strategy:
- Uses maximum 3 parameters (simple but not saturated)
- Has no look-ahead bias (no future data)
- Has no repainting (signals based on closed bars)
- Generates frequent trades
- Exploits rare market structure patterns

---

## 1. Consecutive Equal High/Low Breakout

### Description
Detects when consecutive bars make equal highs or equal lows (double touches), then trades the breakout of that level. This captures the structural "double test" pattern where price touches the same level twice before breaking through.

### Parameters (3 max)
1. `equalBars` (default: 2) - Minimum consecutive bars with equal highs/lows
2. `breakoutBuffer` (default: 0.001) - Buffer percentage for breakout confirmation
3. `minRangePct` (default: 0.003) - Minimum range percentage to qualify as significant level

### Entry Logic
- **Long**: When N consecutive bars have equal highs AND current close breaks above that level + buffer
- **Short**: When N consecutive bars have equal lows AND current close breaks below that level - buffer

### Why It's Rare
Most traders look for higher highs/lower lows (trend continuation) or double tops/bottoms across multiple bars with a retracement in between. Consecutive equal touches without a retracement is a subtle structural pattern that indicates immediate rejection and potential breakout. It's rare because:
- Most technical analysis focuses on swing highs/lows with intervening price action
- The pattern requires exact equality (or near-equality) which is uncommon
- It's a micro-structure pattern that gets lost in higher timeframe analysis
- Most traders don't consider consecutive equal touches as a standalone signal

### Market Structure Exploited
The pattern exploits the "double rejection" structure where price tests a level, gets rejected immediately (next bar), and then breaks through on the third attempt. This indicates strong order flow imbalance at that level.

---

## 2. Open-to-High/Low Ratio Momentum

### Description
Tracks the ratio of open-to-high vs open-to-low over multiple bars, then trades when the ratio shifts direction. This measures the structural balance between upward and downward pressure originating from the open.

### Parameters (3 max)
1. `lookback` (default: 5) - Number of bars to calculate ratio average
2. `threshold` (default: 0.6) - Ratio threshold for directional bias
3. `shiftThreshold` (default: 0.3) - Minimum shift to trigger signal

### Entry Logic
- **Long**: When average (high-open)/(high-low) ratio shifts from bearish (< 1-threshold) to bullish (> threshold)
- **Short**: When average (high-open)/(high-low) ratio shifts from bullish (> threshold) to bearish (< 1-threshold)

### Why It's Rare
Most traders look at absolute price movement (close vs open) or standard indicators like RSI/MACD. The open-to-high/low ratio is a structural measure of where price spends its time relative to the open. It's rare because:
- It's a non-standard metric not found in most trading platforms
- Most traders focus on close-based analysis, ignoring intrabar structure
- The ratio concept is more common in options (delta hedging) than spot trading
- It requires understanding of order flow distribution within each bar

### Market Structure Exploited
The pattern exploits the "pressure balance" structure where price consistently favors one side of the open. When this balance shifts, it indicates a change in order flow dominance.

---

## 3. Body-to-Range Ratio Compression Expansion

### Description
Detects when body-to-range ratio compresses significantly (indicating indecision/wick dominance), then trades the expansion. This is different from standard range compression because it focuses on body size relative to total range.

### Parameters (3 max)
1. `compressionBars` (default: 5) - Number of bars showing compression
2. `bodyRatioThreshold` (default: 0.25) - Maximum body/range ratio for compression
3. `expansionBuffer` (default: 0.002) - Buffer for expansion breakout

### Entry Logic
- **Long**: When N consecutive bars have body/range < threshold AND current close breaks above compression high + buffer
- **Short**: When N consecutive bars have body/range < threshold AND current close breaks below compression low - buffer

### Why It's Rare
Most strategies look at absolute range compression (Bollinger squeeze, ATR-based) or candlestick patterns (doji, hammer). Body-to-range ratio compression is different because:
- It specifically measures indecision (small bodies) regardless of total range
- A bar can have large range but small body (large wicks), which this captures
- Most traders focus on either range OR body, not the ratio between them
- It's a micro-structure pattern that requires understanding of intrabar price distribution

### Market Structure Exploited
The pattern exploits the "indecision accumulation" structure where consecutive bars show rejection at both ends (large wicks, small bodies). This indicates a battle between buyers and sellers with no clear winner, leading to an explosive move when one side capitulates.

---

## 4. Close-to-Open Gap Persistence

### Description
Tracks the persistence of close-to-open gaps over multiple bars, then trades when the gap pattern breaks. This measures the structural tendency of price to gap in the same direction consistently.

### Parameters (3 max)
1. `gapBars` (default: 4) - Number of consecutive gaps required
2. `gapThreshold` (default: 0.002) - Minimum gap size as percentage of price
3. `breakThreshold` (default: 0.001) - Break threshold for signal

### Entry Logic
- **Long**: When N consecutive positive gaps (open > previous close) AND current close breaks above previous close + breakThreshold
- **Short**: When N consecutive negative gaps (open < previous close) AND current close breaks below previous close - breakThreshold

### Why It's Rare
Most traders look at individual gaps (gap up/down) or gap fill strategies. Tracking the persistence of gap direction is rare because:
- Most gap strategies focus on filling gaps, not following gap direction
- Consecutive gaps in the same direction are uncommon in most markets
- The pattern requires looking at gap direction as a structural trend, not individual events
- Most traders view gaps as anomalies to be faded, not trends to be followed

### Market Structure Exploited
The pattern exploits the "gap momentum" structure where price consistently gaps in one direction, indicating strong overnight/interbar sentiment. When this pattern breaks, it signals a potential reversal or exhaustion.

---

## 5. High-Low Midpoint Crossover Momentum

### Description
Uses the midpoint of each bar's high-low range as a structural trend filter, then trades when price crosses multiple consecutive midpoints in one direction. This is different from moving averages because it uses bar structure, not time-based averaging.

### Parameters (3 max)
1. `midpointBars` (default: 3) - Number of consecutive midpoint crosses required
2. `crossThreshold` (default: 0.001) - Threshold for midpoint cross confirmation
3. `minRangePct` (default: 0.003) - Minimum range to qualify bar

### Entry Logic
- **Long**: When N consecutive bars close above their respective midpoints AND current close > previous high
- **Short**: When N consecutive bars close below their respective midpoints AND current close < previous low

### Why It's Rare
Most traders use moving averages, pivot points, or price action patterns for trend filtering. Using bar midpoints as structural filters is rare because:
- Midpoints are not commonly used as technical indicators
- Most traders focus on highs/lows or closes, ignoring the midpoint
- The concept of "midpoint trend" is not found in standard technical analysis
- It's a micro-structure pattern that requires understanding of intrabar balance

### Market Structure Exploited
The pattern exploits the "midpoint gravity" structure where price consistently favors one side of the bar's range. This indicates directional control and momentum that can be traded for continuation.

---

## 6. Wick-to-Body Ratio Exhaustion

### Description
Detects when wick-to-body ratio increases significantly (indicating rejection), then trades the breakout of the rejection level. This measures structural exhaustion through increasing wick dominance.

### Parameters (3 max)
1. `exhaustionBars` (default: 3) - Number of bars showing increasing wick ratio
2. `wickRatioThreshold` (default: 0.5) - Minimum wick/range ratio for exhaustion
3. `breakoutBuffer` (default: 0.002) - Buffer for breakout confirmation

### Entry Logic
- **Long**: When N consecutive bars have upper wick/range > threshold AND current close breaks above exhaustion high + buffer
- **Short**: When N consecutive bars have lower wick/range > threshold AND current close breaks below exhaustion low - buffer

### Why It's Rare
Most traders look at individual candlestick patterns (hammer, shooting star) or wick size alone. Tracking wick-to-body ratio across multiple bars is rare because:
- Most candlestick patterns are single-bar, not multi-bar sequences
- Wick size alone doesn't account for body size (a large bar with large wick is different from a small bar with large wick)
- The ratio concept is more common in academic finance than retail trading
- It requires understanding of the relationship between rejection (wicks) and conviction (body)

### Market Structure Exploited
The pattern exploits the "exhaustion accumulation" structure where consecutive bars show increasing rejection (larger wicks) without directional progress. This indicates a battle that's about to be won by one side.

---

## 7. Consecutive Close Location Bias

### Description
Tracks whether consecutive closes are consistently in the upper or lower portion of their respective bar ranges, then trades the reversal. This measures the structural bias of close positioning.

### Parameters (3 max)
1. `biasBars` (default: 4) - Number of bars showing close location bias
2. `locationThreshold` (default: 0.7) - Close location threshold for bias (0-1, where 0 = low, 1 = high)
3. `reversalBuffer` (default: 0.002) - Buffer for reversal confirmation

### Entry Logic
- **Long**: When N consecutive bars close in upper portion (location > threshold) AND current close breaks below previous low - buffer
- **Short**: When N consecutive bars close in lower portion (location < 1-threshold) AND current close breaks above previous high + buffer

### Why It's Rare
Most traders look at individual candle close location (bullish/bearish candles) or close position relative to moving averages. Tracking close location bias across multiple bars is rare because:
- Most traders focus on candle color (close vs open), not close position within range
- Close location is a micro-structure detail often ignored in higher timeframe analysis
- The concept of "close location bias" is not found in standard technical analysis
- It requires understanding of intrabar price distribution and order flow

### Market Structure Exploited
The pattern exploits the "close location exhaustion" structure where price consistently closes at one extreme of the range. This indicates one-sided pressure that's likely to reverse when it becomes extreme.

---

## 8. Open-Close-Open Pattern Reversal

### Description
Detects when the open-close-open pattern creates a specific structure (e.g., higher open, lower close, higher open again), then trades the reversal. This captures the "failed follow-through" structure.

### Parameters (3 max)
1. `patternBars` (default: 3) - Number of bars in pattern (typically 3)
2. `followThroughThreshold` (default: 0.001) - Threshold for failed follow-through
3. `reversalBuffer` (default: 0.002) - Buffer for reversal confirmation

### Entry Logic
- **Long**: When open[0] > open[1] AND close[0] < open[0] AND open[1] > close[0] (higher open, lower close, higher open again) AND current close breaks above pattern high + buffer
- **Short**: When open[0] < open[1] AND close[0] > open[0] AND open[1] < close[0] (lower open, higher close, lower open again) AND current close breaks below pattern low - buffer

### Why It's Rare
Most traders look at 2-candle patterns (engulfing, harami) or single candle patterns. 3-candle structural patterns are rare because:
- Most candlestick analysis focuses on 1-2 bar patterns
- The open-close-open relationship is not commonly analyzed as a standalone pattern
- It's a more complex pattern that requires understanding of price sequence
- Most traders don't consider the "failed follow-through" concept

### Market Structure Exploited
The pattern exploits the "failed follow-through" structure where price makes a move (open to close), then immediately reverses direction on the next open. This indicates the initial move was rejected and the reversal is likely to continue.

---

## 9. Range Expansion-Compression Cycle

### Description
Detects the cycle of range expansion followed by range compression, then trades the next expansion. This captures the natural volatility cycle structure.

### Parameters (3 max)
1. `expansionBars` (default: 3) - Number of bars showing expansion
2. `compressionBars` (default: 3) - Number of bars showing compression
3. `cycleThreshold` (default: 0.5) - Threshold for expansion/compression ratio

### Entry Logic
- **Long**: After N expansion bars (increasing range) followed by N compression bars (decreasing range) AND current close breaks above compression high
- **Short**: After N expansion bars (increasing range) followed by N compression bars (decreasing range) AND current close breaks below compression low

### Why It's Rare
Most traders look for either expansion (breakout) or compression (squeeze), not the cycle between them. Trading the cycle is rare because:
- Most strategies are either trend-following (expansion) or mean-reversion (compression)
- The concept of volatility cycles is more common in options (VIX) than spot trading
- It requires identifying both expansion and compression phases, which is complex
- Most traders don't consider the natural rhythm of volatility

### Market Structure Exploited
The pattern exploits the "volatility cycle" structure where markets alternate between expansion (trend) and compression (consolidation). Trading the transition from compression back to expansion captures the breakout.

---

## 10. Consecutive Body Size Divergence

### Description
Detects when consecutive bars show diverging body sizes while maintaining directional bias, then trades the breakout. This captures the "weakening trend" structure before reversal.

### Parameters (3 max)
1. `divergenceBars` (default: 4) - Number of bars showing divergence
2. `divergenceThreshold` (default: 0.3) - Threshold for body size change
3. `breakoutBuffer` (default: 0.002) - Buffer for breakout confirmation

### Entry Logic
- **Long**: When N consecutive bullish bars show decreasing body size (divergence) AND current close breaks above divergence high + buffer
- **Short**: When N consecutive bearish bars show decreasing body size (divergence) AND current close breaks below divergence low - buffer

### Why It's Rare
Most traders look for consistent body size patterns (strong trend = large bodies) or candlestick patterns. Body size divergence is rare because:
- Most trend strategies assume consistent momentum, not weakening momentum
- The concept of "body divergence" is not found in standard technical analysis
- It requires comparing body sizes across multiple bars, which is not commonly done
- Most traders don't consider body size as a measure of trend strength

### Market Structure Exploited
The pattern exploits the "weakening momentum" structure where consecutive bars in the same direction show decreasing body size. This indicates the trend is losing strength and may reverse, but the final breakout before reversal can be traded.

---

## Summary Table

| Strategy | Parameters | Structure Exploited | Rarity Reason |
|----------|-----------|-------------------|---------------|
| Consecutive Equal High/Low Breakout | equalBars, breakoutBuffer, minRangePct | Double rejection structure | Most traders look for swing highs/lows with retracement |
| Open-to-High/Low Ratio Momentum | lookback, threshold, shiftThreshold | Pressure balance structure | Non-standard metric, not in most platforms |
| Body-to-Range Ratio Compression | compressionBars, bodyRatioThreshold, expansionBuffer | Indecision accumulation | Focuses on body/range ratio, not absolute range |
| Close-to-Open Gap Persistence | gapBars, gapThreshold, breakThreshold | Gap momentum structure | Most gap strategies focus on filling, not following |
| High-Low Midpoint Crossover | midpointBars, crossThreshold, minRangePct | Midpoint gravity structure | Midpoints not commonly used as indicators |
| Wick-to-Body Ratio Exhaustion | exhaustionBars, wickRatioThreshold, breakoutBuffer | Exhaustion accumulation | Multi-bar wick analysis is uncommon |
| Consecutive Close Location Bias | biasBars, locationThreshold, reversalBuffer | Close location exhaustion | Micro-structure detail often ignored |
| Open-Close-Open Pattern Reversal | patternBars, followThroughThreshold, reversalBuffer | Failed follow-through structure | 3-candle patterns are rare in analysis |
| Range Expansion-Compression Cycle | expansionBars, compressionBars, cycleThreshold | Volatility cycle structure | Most strategies focus on one phase, not cycles |
| Consecutive Body Size Divergence | divergenceBars, divergenceThreshold, breakoutBuffer | Weakening momentum structure | Body size divergence not commonly analyzed |

---

## Implementation Notes

All strategies:
1. Use only OHLC data (no volume, no indicators beyond basic calculations)
2. Generate signals on closed bars (no repainting)
3. Have maximum 3 parameters for simplicity
4. Are designed for frequent trading (not swing trading)
5. Exploit structural patterns that are rare in the trading community

When implementing, ensure:
- All calculations use only past data (no look-ahead bias)
- Signals are generated on bar close, not during the bar
- Parameters are bounded to prevent extreme values
- Edge cases are handled (zero range, missing data, etc.)
