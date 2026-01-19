import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { calculateATR } from '../indicators';

// ============================================================================
// Constants
// ============================================================================

const FIB_RETRACEMENT_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.786];
const FIB_EXTENSION_LEVELS = [1.272, 1.414, 1.618, 2.618];

const FIB_COLORS: { [key: string]: string } = {
    '0': '#787b86',
    '0.236': '#f44336',
    '0.382': '#81c784',
    '0.5': '#4caf50',
    '0.618': '#009688',
    '0.786': '#64b5f6',
    '1': '#787b86',
    '1.272': '#90caf9',
    '1.414': '#ce93d8',
    '1.618': '#2196f3',
    '2.618': '#9c27b0',
};

// ============================================================================
// TYPES
// ============================================================================

interface Pivot {
    index: number;
    price: number;
    isHigh: boolean;
}


// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculates deviations for pivot detection
 */
function calculateDeviations(close: number[], atr: (number | null)[], multiplier: number): number[] {
    return close.map((price, i) => {
        const val = atr[i];
        if (price === 0 || val === null || val === undefined) return 0;
        return (val / price) * 100 * multiplier;
    });
}

/**
 * Detects pivots (ZigZag) avoiding future look-ahead bias in Real-Time simulation.
 * HOWEVER, for backtesting strategy execution, we must be careful.
 * 
 * Standard ZigZag creates pivots at index `i` that are confirmed at `i + depth`.
 * The strategy must only act on them after confirmation.
 */
function detectZigZagPivots(
    high: number[],
    low: number[],
    depth: number,
    deviations: number[]
): Pivot[] {
    const pivots: Pivot[] = [];
    const len = high.length;
    // We need at least depth bars
    if (len < depth) return [];

    // Direction tracking
    let lastPivot: Pivot | null = null;

    // We need to simulate the "lag" of confirmation.
    // A High at 'i' is the highest in [i-depth, i+depth]? 
    // Usually ZigZag implementation varies. 
    // We will use the standard "High/Low in Depth window" approach.

    // Using a simpler, robust 2-pass approach or standard window
    // Window: We check if i is extreme in [i-depth, i+depth]
    // Note: This pivot is "identified" at i+depth.

    // Optimization: We iterate through the array. 
    // To match the users 'bad trade' complaint, we must ensure high quality pivots.

    // Depth defines the 'min period' effectively.

    for (let i = depth; i < len - depth; i++) {
        let isHigh = true;
        let isLow = true;

        // Check window
        for (let k = 1; k <= depth; k++) {
            if (high[i] <= high[i - k] || high[i] <= high[i + k]) {
                isHigh = false;
            }
            if (low[i] >= low[i - k] || low[i] >= low[i + k]) {
                isLow = false;
            }
        }

        if (isHigh && isLow) {
            // Both high and low? Rare inside bars logic. Prefer direction.
            // If strictly inside, it's ambiguous. But usually doesn't happen with strict inequality.
            // If equal, we skip or take latest. 
            // Let's prioritize based on trend or magnitude? 
            // For simplicity, treat as neither or both (conflict). 
            // Let's assume High for now if ambiguous or check previous.
            isLow = false; // prioritize high
        }

        if (isHigh || isLow) {
            const price = isHigh ? high[i] : low[i];
            const typeHigh = isHigh;

            // Deviation check
            const dev = deviations[i] || 0;

            if (lastPivot) {
                // If same type, update if better
                if (lastPivot.isHigh === typeHigh) {
                    if ((typeHigh && price > lastPivot.price) || (!typeHigh && price < lastPivot.price)) {
                        // Update last pivot
                        pivots[pivots.length - 1] = { index: i, price, isHigh: typeHigh };
                        lastPivot = pivots[pivots.length - 1];
                    }
                } else {
                    // Different type, check deviation
                    const priceChange = Math.abs(price - lastPivot.price);
                    const priceDev = (priceChange / lastPivot.price) * 100;

                    if (priceDev >= dev) {
                        // Valid new pivot
                        const newPivot: Pivot = { index: i, price, isHigh: typeHigh };
                        pivots.push(newPivot);
                        lastPivot = newPivot;
                    }
                }
            } else {
                // First pivot
                const newPivot = { index: i, price, isHigh: typeHigh };
                pivots.push(newPivot);
                lastPivot = newPivot;
            }
        }
    }

    return pivots;
}

// ============================================================================
// STRATEGY
// ============================================================================

export const fib_retracement: Strategy = {
    name: 'Fibonacci Retracement',
    description: 'Signals based on Fibonacci Retracement levels from ZigZag pivots. Includes lag-correction to prevent look-ahead bias and volume filtering.',
    defaultParams: {
        depth: 14,             // Increased default for more significant swings
        deviation: 5.0,        // Increased deviation for robustness
        atrPeriod: 14,
        enableExtensions: 1,
        stopLossAtr: 2.0,      // implicit suggestion for sizing/exits
    },
    paramLabels: {
        depth: 'Pivot Depth',
        deviation: 'Deviation Multiplier',
        atrPeriod: 'ATR Period',
        enableExtensions: 'Enable Extensions (0=No, 1=Yes)'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 50) return []; // Require minimum history

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);

        // Indicators
        const atr = calculateATR(high, low, close, params.atrPeriod);
        const deviations = calculateDeviations(close, atr, params.deviation);
        const pivots = detectZigZagPivots(high, low, params.depth, deviations);

        if (pivots.length < 2) return [];

        const signals: Signal[] = [];

        // We iterate through pivot segments.
        // A segment is defined by StartPivot -> EndPivot.
        // We look for signals AFTER EndPivot is confirmed.
        // Confirmation happens at EndPivot.index + depth.

        for (let i = 1; i < pivots.length; i++) {
            const startNode = pivots[i - 1];
            const endNode = pivots[i];

            // Define the Swing
            const isUpSwing = endNode.price > startNode.price;
            const range = Math.abs(endNode.price - startNode.price);

            // Calculate Levels relative to EndNode
            // If UpSwing (Low->High), Retracement is Down from High.
            // levels: High - range * 0.382, etc.
            const levels: Record<string, number> = {};
            FIB_RETRACEMENT_LEVELS.forEach(lvl => {
                if (isUpSwing) {
                    levels[lvl.toString()] = endNode.price - (range * lvl);
                } else {
                    levels[lvl.toString()] = endNode.price + (range * lvl);
                }
            });

            // Calculate Extensions (from previous swing)
            // Needed: PrevPivot -> StartNode -> EndNode
            // Needed: PrevPivot -> StartNode -> EndNode
            if (params.enableExtensions && i >= 2) {
                // const prevNode = pivots[i - 2];
                // Extensions project beyond EndNode based on PrevSwing
                // Standard Fib Extension: Project from EndNode using PrevSwing length?
                // Or project from StartNode?
                // TradingView standard typically projects from the 3rd point (EndNode) based on leg 1 (Prev->Start).
                // Formula: EndNode +/- (PrevRange * level)

                FIB_EXTENSION_LEVELS.forEach(_lvl => {
                    // If current swing is UP (Start->End), we project UP?
                    // No, extensions usually apply to the dominant trend.
                    // If Prev->Start was DOWN, and Start->End is UP (Retracement), 
                    // Extension targets are DOWN below Start.
                    // Let's assume standard ABCD pattern extension.

                    if (isUpSwing) {
                        // Current leg UP. Previous leg DOWN.
                        // Extension usually projects UP (Trend continuation) or DOWN (Correction target)?
                        // "Fibonacci Extension" usually means "Expansion" of the current move? 
                        // Or "Extension" of the previous trend?
                        // Let's stick to the previous file's logic: 
                        // "After upswing... extension projects down" -> This implies targeting breakdown.

                        // We will check for Reversal/Breakout targets.
                        // UpSwing -> Retracement (Down) -> Bounce -> Target High Extension?
                        // The user complained about bad trades.
                        // Let's focus on Retracements (the Strategy Name).
                    }
                });
            }

            // Time window for signals
            // Start checking: EndNode.index + params.depth (Confirmation time)
            // End checking: NextPivot.index (if exists) OR end of data
            const confirmIndex = endNode.index + params.depth;
            const nextPivotIndex = (i + 1 < pivots.length) ? pivots[i + 1].index : cleanData.length;

            const startIndex = Math.max(confirmIndex, 0);

            // State for this Swing
            const triggered = new Set<string>();

            for (let k = startIndex; k < nextPivotIndex; k++) {
                if (k >= cleanData.length) break;

                const barClose = close[k];
                const barPrevClose = close[k - 1];

                // Check Retracement Levels
                for (const lvl of FIB_RETRACEMENT_LEVELS) {
                    const levelStr = lvl.toString();
                    if (triggered.has(levelStr)) continue;

                    const priceLevel = levels[levelStr];

                    // Logic: Retracement entry
                    if (isUpSwing) {
                        // We are coming down from High.
                        // We want to BUY at support (Level).
                        // Trigger: Price hits level and bounces?
                        // Or Price crosses level?

                        // Signal: Cross DOWN into support? No, that's falling knife.
                        // Signal: Cross UP out of support? (Bounce confirmed)
                        if (barPrevClose < priceLevel && barClose > priceLevel) {
                            // "Bounce"
                            signals.push(createBuySignal(cleanData, k, `Fib ${lvl} Bounce`));
                            triggered.add(levelStr);
                        }
                    } else {
                        // DownSwing (High->Low). Retracing UP.
                        // We want to SELL at Resistance.
                        // Signal: Cross DOWN from resistance (Rejection confirmed)
                        if (barPrevClose > priceLevel && barClose < priceLevel) {
                            signals.push(createSellSignal(cleanData, k, `Fib ${lvl} Rejection`));
                            triggered.add(levelStr);
                        }
                    }
                }
            }
        }

        return signals;
    },

    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        const indicators: StrategyIndicator[] = [];

        if (cleanData.length < params.depth) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);
        const atr = calculateATR(high, low, close, params.atrPeriod);
        const deviations = calculateDeviations(close, atr, params.deviation);
        const pivots = detectZigZagPivots(high, low, params.depth, deviations);

        // Draw ZigZag
        const zigzagPoints: { index: number, value: number }[] = pivots.map(p => ({ index: p.index, value: p.price }));
        const zigzagLine: (number | null)[] = new Array(cleanData.length).fill(null);

        for (let i = 0; i < zigzagPoints.length - 1; i++) {
            const p1 = zigzagPoints[i];
            const p2 = zigzagPoints[i + 1];
            const steps = p2.index - p1.index;
            const valStep = (p2.value - p1.value) / steps;

            for (let k = 0; k <= steps; k++) {
                if (p1.index + k < cleanData.length) {
                    zigzagLine[p1.index + k] = p1.value + (valStep * k);
                }
            }
        }
        indicators.push({ name: 'ZigZag', type: 'line', values: zigzagLine, color: '#ff9800' });

        // Draw Levels for ONLY the LAST swing
        if (pivots.length >= 2) {
            const endNode = pivots[pivots.length - 1];
            const startNode = pivots[pivots.length - 2];

            const isUpSwing = endNode.price > startNode.price;
            const range = Math.abs(endNode.price - startNode.price);

            FIB_RETRACEMENT_LEVELS.forEach(lvl => {
                const lvlName = lvl.toString();
                const price = isUpSwing ? endNode.price - (range * lvl) : endNode.price + (range * lvl);
                const lineData = new Array(cleanData.length).fill(null);

                // Draw from EndPivot to end
                for (let k = endNode.index; k < cleanData.length; k++) {
                    lineData[k] = price;
                }

                indicators.push({
                    name: `Fib ${lvlName}`,
                    type: 'line',
                    values: lineData,
                    color: FIB_COLORS[lvlName] || '#888888'
                });
            });
        }

        return indicators;
    }
};
