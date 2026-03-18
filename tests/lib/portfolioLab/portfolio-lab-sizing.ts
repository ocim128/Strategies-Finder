import { timeKey, type BacktestResult, type Signal } from "../strategies";
import { buildSignalContextKey, buildSignalContexts } from "./portfolio-lab-sweep";
import type {
    PairAnalysisRow,
    PortfolioRunContext,
    ScenarioSummary,
    SignalContext,
    SizingScenarioRow,
} from "./portfolio-lab-types";

export function buildSizingScenarios(
    context: PortfolioRunContext,
    _rows: PairAnalysisRow[],
    minAgree: number,
    maxOppose: number
): SizingScenarioRow[] {
    const targetArtifacts = context.runCache.get(context.benchmarkSymbol);
    if (!targetArtifacts) {
        return [];
    }

    const signalContexts = buildSignalContexts(
        context.benchmarkSymbol,
        targetArtifacts,
        context.runCache,
        context.lagBars
    );
    const tradeContextByKey = new Map<string, SignalContext>();
    for (const trade of targetArtifacts.result.trades) {
        const signalType: Signal["type"] = trade.type === "long" ? "buy" : "sell";
        const contextKey = buildSignalContextKey(timeKey(trade.entryTime), signalType);
        const signalContext = signalContexts.get(contextKey);
        if (signalContext) {
            tradeContextByKey.set(`${timeKey(trade.entryTime)}|${trade.type}`, signalContext);
        }
    }

    const scenarios: Array<{ name: string; description: string; getMultiplier: (context: SignalContext | null) => number }> = [
        {
            name: "Base",
            description: "Current position sizing on every trade.",
            getMultiplier: () => 1,
        },
        {
            name: "Conflict Trim",
            description: `Cut size when opposition exceeds ${maxOppose}, keep normal size otherwise.`,
            getMultiplier: (signalContext) => {
                if (!signalContext) return 1;
                return signalContext.oppositeCount > maxOppose ? 0.45 : 1;
            },
        },
        {
            name: "Breadth Tilt",
            description: `Keep all trades, but reduce size below ${minAgree} agreement and stay full size on strong breadth.`,
            getMultiplier: (signalContext) => {
                if (!signalContext) return 1;
                return signalContext.sameCount >= minAgree ? 1 : 0.6;
            },
        },
        {
            name: "Clean Context",
            description: `Full size only when agree >= ${minAgree} and oppose <= ${maxOppose}; otherwise trade smaller.`,
            getMultiplier: (signalContext) => {
                if (!signalContext) return 1;
                if (signalContext.sameCount >= minAgree && signalContext.oppositeCount <= maxOppose) {
                    return 1;
                }
                if (signalContext.sameCount >= Math.max(1, minAgree - 1)) {
                    return 0.65;
                }
                return 0.35;
            },
        },
    ];

    return scenarios.map((scenario) => ({
        name: scenario.name,
        description: scenario.description,
        result: simulateScenario(
            targetArtifacts.result,
            tradeContextByKey,
            scenario.getMultiplier,
            context.capitalSettings
        ),
    }));
}

export function simulateScenario(
    result: BacktestResult,
    tradeContexts: Map<string, SignalContext>,
    getMultiplier: (context: SignalContext | null) => number,
    capitalSettings: PortfolioRunContext["capitalSettings"]
): ScenarioSummary {
    let capital = Math.max(0, capitalSettings.initialCapital);
    let peak = capital;
    let maxDrawdownPercent = 0;
    let totalProfit = 0;
    let totalLoss = 0;
    let wins = 0;
    let multiplierSum = 0;

    for (const trade of result.trades) {
        const context = tradeContexts.get(`${timeKey(trade.entryTime)}|${trade.type}`) ?? null;
        const multiplier = Math.max(0, getMultiplier(context));
        multiplierSum += multiplier;

        const baseEntryValue = trade.size * trade.entryPrice;
        const tradeReturn = baseEntryValue > 0 ? trade.pnl / baseEntryValue : 0;
        const baseAllocation = capitalSettings.sizingMode === "fixed" && capitalSettings.fixedTradeAmount > 0
            ? capitalSettings.fixedTradeAmount
            : capital * (capitalSettings.positionSize / 100);
        const allocatedCapital = Math.min(capital, Math.max(0, baseAllocation * multiplier));
        const pnl = allocatedCapital * tradeReturn;

        capital += pnl;
        if (pnl > 0) {
            totalProfit += pnl;
            wins += 1;
        } else if (pnl < 0) {
            totalLoss += Math.abs(pnl);
        }

        peak = Math.max(peak, capital);
        if (peak > 0) {
            maxDrawdownPercent = Math.max(maxDrawdownPercent, ((peak - capital) / peak) * 100);
        }
    }

    const tradeCount = result.trades.length;
    const netProfit = capital - capitalSettings.initialCapital;

    return {
        totalTrades: tradeCount,
        winRate: tradeCount > 0 ? (wins / tradeCount) * 100 : 0,
        netProfitPercent: capitalSettings.initialCapital > 0 ? (netProfit / capitalSettings.initialCapital) * 100 : 0,
        expectancy: tradeCount > 0 ? netProfit / tradeCount : 0,
        profitFactor: totalLoss === 0 ? (totalProfit > 0 ? Infinity : 0) : totalProfit / totalLoss,
        maxDrawdownPercent,
        avgMultiplier: tradeCount > 0 ? multiplierSum / tradeCount : 0,
    };
}
