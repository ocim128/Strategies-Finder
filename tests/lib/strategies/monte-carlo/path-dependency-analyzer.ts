import type { Trade } from "../../types/strategies";
import type { EquityCurvePoint, RuinProbabilityMetrics } from "./types";

/**
 * Builds equity curve from sequence of trades
 */
export function buildEquityCurve(
    trades: Trade[],
    initialCapital: number
): EquityCurvePoint[] {
    const curve: EquityCurvePoint[] = [];
    let equity = initialCapital;
    let cumulativeReturn = 0;
    
    for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        equity += trade.pnl;
        cumulativeReturn = (equity - initialCapital) / initialCapital;
        
        curve.push({
            bar: i,
            equity,
            cumulativeReturn,
        });
    }
    
    return curve;
}

/**
 * Calculates maximum drawdown from equity curve
 * Anchors peak at initialCapital to match backtest engine semantics
 */
export function calculateMaxDrawdown(equityCurve: EquityCurvePoint[], initialCapital: number): {
    maxDrawdown: number;
    maxDrawdownPercent: number;
    drawdownStart: number;
    drawdownEnd: number;
} {
    if (equityCurve.length === 0) {
        return { maxDrawdown: 0, maxDrawdownPercent: 0, drawdownStart: 0, drawdownEnd: 0 };
    }
    
    // Anchor peak at initial capital (matches backtest engine semantics)
    let peak = initialCapital;
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let drawdownStart = 0;
    let drawdownEnd = 0;
    let currentStart = 0;
    
    for (let i = 0; i < equityCurve.length; i++) {
        const point = equityCurve[i];
        
        if (point.equity > peak) {
            peak = point.equity;
            currentStart = i;
        }
        
        const drawdown = peak - point.equity;
        // Express as percentage points (×100) to match app-wide contract
        const drawdownPercent = peak > 0 ? (drawdown / peak) * 100 : 0;
        
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
            maxDrawdownPercent = drawdownPercent;
            drawdownStart = currentStart;
            drawdownEnd = i;
        }
    }
    
    return { maxDrawdown, maxDrawdownPercent, drawdownStart, drawdownEnd };
}

/**
 * Checks if ruin occurred (equity fell below threshold)
 */
export function checkRuin(
    equityCurve: EquityCurvePoint[],
    ruinThreshold: number
): {
    ruinOccurred: boolean;
    timeToRuin?: number;
    minEquity: number;
} {
    let minEquity = Infinity;
    
    for (let i = 0; i < equityCurve.length; i++) {
        const point = equityCurve[i];
        if (point.equity < minEquity) {
            minEquity = point.equity;
        }
        if (point.equity < ruinThreshold) {
            return {
                ruinOccurred: true,
                timeToRuin: i,
                minEquity,
            };
        }
    }
    
    return {
        ruinOccurred: false,
        minEquity,
    };
}

/**
 * Computes comprehensive ruin probability metrics
 */
export function computeRuinProbabilityMetrics(
    simulations: Array<{
        equityCurve: EquityCurvePoint[];
        maxDrawdown: number;
        maxDrawdownPercent: number;
        ruinOccurred: boolean;
        timeToRuin?: number;
    }>,
    _ruinThresholdPercent: number
): RuinProbabilityMetrics {
    const ruinCount = simulations.filter(s => s.ruinOccurred).length;
    const ruinRate = simulations.length > 0 ? ruinCount / simulations.length : 0;
    
    // Time to ruin for ruined simulations
    const timesToRuin = simulations
        .filter(s => s.ruinOccurred && s.timeToRuin !== undefined)
        .map(s => s.timeToRuin!);
    
    const expectedTradesToRuin = timesToRuin.length > 0
        ? timesToRuin.reduce((a, b) => a + b, 0) / timesToRuin.length
        : null;
    
    const medianTradesToRuin = timesToRuin.length > 0
        ? median(timesToRuin)
        : null;
    
    // Drawdown distribution
    const drawdowns = simulations.map(s => s.maxDrawdownPercent);
    const drawdownDistribution = {
        mean: mean(drawdowns),
        median: median(drawdowns),
        stdDev: stdDev(drawdowns),
        percentile5: percentile(drawdowns, 5),
        percentile25: percentile(drawdowns, 25),
        percentile75: percentile(drawdowns, 75),
        percentile95: percentile(drawdowns, 95),
    };
    
    return {
        ruinProbability: ruinRate,
        expectedTradesToRuin,
        medianTradesToRuin,
        ruinRate,
        maxDrawdownDistribution: drawdownDistribution,
    };
}

// Helper functions
function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stdDev(values: number[]): number {
    if (values.length < 2) return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / (values.length - 1);
    return Math.sqrt(variance);
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const index = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] * (upper - index) + sorted[upper] * (index - lower);
}
