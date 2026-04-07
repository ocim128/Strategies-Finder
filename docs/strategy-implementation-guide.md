# Strategy Implementation Guide for AI Agents

This guide provides the exact context and rules required to implement a new built-in strategy correctly in this repository. 

Often, strategies generated from `archive/prompt.txt` or general AI knowledge lack the specific type safety, null-handling, and execution loop requirements of this engine. **Read and follow these rules strictly to avoid compilation and runtime errors.**

## 1. File Structure and Syncing

1. **Location:** All built-in strategies live in `lib/strategies/lib/`.
2. **Naming:** Pick a descriptive snake_case or camelCase key (e.g., `median_deviation_streak.ts`).
3. **Export:** Export a `const` matching the strategy key. 
   ```typescript
   export const median_deviation_streak: Strategy = { ... };
   ```
4. **Manifest:** **DO NOT** manually edit `lib/strategies/strategyRegistry.ts`. After creating the file, run `npm run strategies:sync-manifest`. The strategy is automatically loaded.

## 2. The Strategy Interface

Your strategy object must implement the `Strategy` interface and include:

- `name`: Human-readable name.
- `description`: Clear explanation of the logic.
- `defaultParams`: Object containing the base parameter values.
- `paramLabels`: Object mapping the parameter keys to UI-friendly labels.
- `metadata`: Needs `role` (usually `'entry'`), `direction` (e.g., `'both'`, `'long'`, `'short'`), and `walkForwardParams` (array of parameter keys that Walk Forward Analysis is allowed to optimize).
- `execute(data: OHLCVData[], params: StrategyParams)`: The core logic function.
- `normalizeParams(params)`: (Optional but highly recommended) If execution rounds, clamps, or coerces signs, you must expose those normalized values back to the engine.

### Example Skeleton

```typescript
import { Strategy, StrategyParams } from "../../types/strategies";
import { 
    createSignalLoop, 
    createBuySignal, 
    createSellSignal, 
    ensureCleanData, 
    getCloses 
} from "../strategy-helpers";
import { calculateRSI } from "../indicators";

export const my_new_strategy: Strategy = {
    name: 'My New Strategy',
    description: 'An example strategy that triggers on RSI.',
    defaultParams: { rsiPeriod: 14, overbought: 70, oversold: 30 },
    paramLabels: { rsiPeriod: 'RSI Period', overbought: 'Overbought Level', oversold: 'Oversold Level' },
    metadata: { 
        role: 'entry', 
        direction: 'both', 
        walkForwardParams: ['rsiPeriod', 'overbought', 'oversold'] 
    },
    execute: (data, params) => {
        const p = params as { rsiPeriod: number, overbought: number, oversold: number };
        const cleanData = ensureCleanData(data);
        const closes = getCloses(cleanData);
        
        const rsi = calculateRSI(closes, p.rsiPeriod);

        return createSignalLoop(cleanData, [rsi], (i) => {
            const currentRsi = rsi[i];
            const prevRsi = rsi[i-1];

            // Always check for nulls
            if (currentRsi === null || prevRsi === null) return null;

            if (prevRsi > p.oversold && currentRsi <= p.oversold) {
                return createBuySignal(cleanData, i, 'my_strategy_buy');
            }
            if (prevRsi < p.overbought && currentRsi >= p.overbought) {
                return createSellSignal(cleanData, i, 'my_strategy_sell');
            }

            return null; // No signal
        });
    }
};
```

## 3. The Signal Loop (CRITICAL AI FIXES)

AIs frequently fail to construct the execution loop properly. You **MUST** use `createSignalLoop`.

### 🚫 Anti-Patterns (DO NOT DO THIS)
```typescript
// WRONG: AIs often try to return 1 or -1 directly
return createSignalLoop(cleanData, [], (i) => {
    if (bullish) return 1;
    if (bearish) return -1;
    return 0;
});
```

### ✅ Correct Pattern
```typescript
// CORRECT: You must return a full Signal object or null
return createSignalLoop(cleanData, [], (i) => {
    if (bullish) return createBuySignal(cleanData, i, 'reason_buy');
    if (bearish) return createSellSignal(cleanData, i, 'reason_sell');
    return null;
});
```

The callback passed to `createSignalLoop` must return `Signal | null | undefined`.

## 4. Types and Null Handling

Indicators usually return arrays padded with `null` for the warmup period. 
- Types are strictly enforced as `(number | null)[]`. 
- **DO NOT** assign a `(number | null)[]` to a `number[]`. 
- If you need to strip nulls for a sub-calculation (like percentile ranks), do so explicitly (e.g., `rsi.map(x => x ?? 50) as number[]`).

### Checking for Nulls inside the Loop
Always check the current index and any lookback indices before doing math:

```typescript
const currentMACD = macd.histogram[i];
if (currentMACD === null) return null;
```

### Indicator Return Shapes
Pay attention to indicator outputs:
- **Flat Arrays:** `calculateRSI`, `calculateATR`, `calculateADX` return `(number | null)[]`.
- **Object Arrays:** `calculateMACD` returns `{ macd: (number|null)[], signal: (number|null)[], histogram: (number|null)[] }`.
- **Supertrend:** Returns `{ trendLine: (number|null)[], direction: (number|null)[] }`.

## 5. Parameter Normalization
If your strategy inherently alters a parameter (e.g., snapping a period to an integer, or forcing a threshold to be negative internally), you **must** implement `normalizeParams`. Otherwise, the Walk Forward Analysis engine and the UI will drift out of sync with the execution engine.

```typescript
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        period: Math.round(params.period),
        threshold: Math.abs(params.threshold) // e.g. enforcing positive input
    };
}
```

## 6. Common AI Pitfalls Checklist

Before completing your implementation, verify:
1. [ ] Did I export a `const` matching the file name?
2. [ ] Did I include `defaultParams`, `paramLabels`, and `metadata.walkForwardParams`?
3. [ ] Are all keys in `defaultParams` perfectly matching the keys used in `execute()`?
4. [ ] Did I use `createBuySignal()` and `createSellSignal()` instead of returning `1` and `-1`?
5. [ ] Did I return `null` (not `0`) inside the `createSignalLoop` when no signal triggers?
6. [ ] Did I typecast array math correctly when using `.map()` on `(number | null)[]`?
7. [ ] Have I handled `BarMetricType` literals exactly? (e.g. `'closeMidpointDev'` not `'closeLocation'`)
8. [ ] Did I run `npm run strategies:sync-manifest` and `npm run typecheck`?
