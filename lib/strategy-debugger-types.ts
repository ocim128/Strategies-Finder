import type { BacktestResult, BacktestSettings, StrategyParams } from "./types/strategies";

export type StrategyDebuggerParamSource = "current_ui" | "strategy_default";
export type StrategyDebuggerVerdict = "better" | "worse" | "flat" | "bad coverage" | "needs data check" | "low confidence";
export type StrategyDebuggerConfidence = "low" | "medium" | "high";
export type StrategyDebuggerMatchQuality = "low" | "medium" | "high";

export interface StrategyDebuggerRunMeta {
    symbol: string;
    interval: string;
    executionModel: BacktestSettings["executionModel"];
    polymarketExitMode: BacktestSettings["polymarketExitMode"];
    riskManagement?: {
        chart: {
            riskMode?: BacktestSettings["riskMode"];
            stopLossAtr?: number;
            takeProfitAtr?: number;
            stopLossEnabled?: boolean;
            stopLossPercent?: number;
            takeProfitEnabled?: boolean;
            takeProfitPercent?: number;
            takeProfitMode?: BacktestSettings["takeProfitMode"];
            disableSignalExits?: boolean;
            riskMinHoldEnabled?: boolean;
            riskMinHoldBars?: number;
            riskMaxHoldEnabled?: boolean;
            riskMaxHoldBars?: number;
        };
        polymarketProtection: {
            takeProfitEnabled?: boolean;
            takeProfitCents?: number;
            stopLossEnabled?: boolean;
            stopLossCents?: number;
        };
    };
    generatedAtIso: string;
    singleRangeOnly: true;
}

export interface StrategyDebuggerRunInput {
    strategyKey: string;
    strategyName: string;
    params: StrategyParams;
    paramSource: StrategyDebuggerParamSource;
    result: BacktestResult;
}

export interface StrategyDebuggerMetrics {
    strategyKey: string;
    strategyName: string;
    paramSource: StrategyDebuggerParamSource;
    params: StrategyParams;
    scoredTrades: number;
    unscoredTrades: number;
    missingOutcomeTrades: number;
    missingPriceTrades: number;
    duplicateTradesIgnored: number;
    scoredTradeShare: number;
    winRate: number;
    expectancyCents: number | null;
    profitFactor: number | null;
    sizedNet: number | null;
    sizedReturnPercent: number | null;
    sizedTrades: number | null;
}

export interface StrategyDebuggerDelta {
    expectancyCents: number | null;
    winRatePoints: number;
    sizedNet: number | null;
    scoredTrades: number;
}

export interface StrategyDebuggerTradeGroupSummary {
    count: number;
    winRate: number;
    expectancyCents: number | null;
}

export interface StrategyDebuggerBothTookSummary {
    count: number;
    candidateBetterCount: number;
    baselineBetterCount: number;
    avgDeltaCents: number | null;
}

export interface StrategyDebuggerTradeOverlap {
    matchQuality: StrategyDebuggerMatchQuality;
    bothTook: StrategyDebuggerBothTookSummary;
    candidateAdded: StrategyDebuggerTradeGroupSummary;
    candidateSkipped: {
        count: number;
        baselineWinRate: number;
        baselineExpectancyCents: number | null;
    };
}

export interface StrategyDebuggerBucket {
    bucket: string;
    candidateDeltaCents: number | null;
    trades: number;
    note?: string;
}

export interface StrategyDebuggerDiagnosis {
    verdict: StrategyDebuggerVerdict;
    confidence: StrategyDebuggerConfidence;
    plainEnglish: string[];
    limitations: string[];
    nextPromptHint: string;
}

export interface StrategyDebuggerDiagnostic {
    schema: "polymarket.strategy_debugger.v1";
    run: StrategyDebuggerRunMeta;
    baseline: StrategyDebuggerMetrics;
    candidate: StrategyDebuggerMetrics;
    delta: StrategyDebuggerDelta;
    tradeOverlap: StrategyDebuggerTradeOverlap;
    helpedBuckets: StrategyDebuggerBucket[];
    hurtBuckets: StrategyDebuggerBucket[];
    diagnosis: StrategyDebuggerDiagnosis;
}

export interface StrategyDebuggerCandidateReport {
    candidateKey: string;
    candidateName: string;
    diagnostic: StrategyDebuggerDiagnostic | null;
    error: string | null;
}
