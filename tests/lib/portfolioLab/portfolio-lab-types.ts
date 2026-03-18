import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Trade,
} from "../strategies";
import type { OpenPosition } from "../strategies/backtest/signal-preparation";
import type { PortfolioSignalPresence } from "./portfolio-lab-helpers";

export const MIN_LOOKBACK_BARS = 200;
export const MAX_LOOKBACK_BARS = 20000;
export const MAX_PORTFOLIO_SYMBOLS = 12;
export const DEFAULT_LOOKBACK_BARS = 1500;
export const DEFAULT_FORECAST_ANCHOR = "ETHUSDT";
export const MAJOR_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"] as const;

export type DataSource = "mock" | "local" | "network";
export type PortfolioWindowMode = "latest_bars" | "common_overlap";
export type PortfolioEngineUsed = "rust" | "typescript";

export interface PortfolioCapitalSettings {
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
    fixedTradeToggle?: boolean;
}

export interface CachedPairData {
    rawData: OHLCVData[];
    data: OHLCVData[];
    source: DataSource;
}

export interface PairRunArtifacts {
    result: BacktestResult;
    engineUsed: PortfolioEngineUsed;
    fullSignals: Signal[];
    signalPresenceByTime: Map<string, PortfolioSignalPresence>;
    timeKeys: string[];
    timeIndex: Map<string, number>;
    tradeRanges: TradeRange[];
}

export interface TradeRange {
    trade: Trade;
    entryIndex: number;
    exitIndex: number;
}

export interface PairAnalysisRow {
    symbol: string;
    displayName: string;
    bars: number;
    source: DataSource;
    result: BacktestResult;
    engineUsed: PortfolioEngineUsed;
    marketCorrelation: number | null;
    strategyCorrelation: number | null;
}

export interface ConsensusTradeSample {
    symbol: string;
    direction: Trade["type"];
    isWin: boolean;
    pnl: number;
    pnlPercent: number;
    sameCount: number;
    oppositeCount: number;
}

export interface ConsensusBucketSummary {
    label: string;
    sortValue: number;
    samples: number;
    winRate: number;
    lossRate: number;
    avgExpectancy: number;
    avgNetPct: number;
    avgOppose: number;
    longWinRate: number | null;
    shortWinRate: number | null;
    longSamples: number;
    shortSamples: number;
}

export interface ConsensusAnalysis {
    qualifyingBuckets: ConsensusBucketSummary[];
    allSamples: ConsensusTradeSample[];
    samplesBySymbol: Map<string, ConsensusTradeSample[]>;
    qualifyingSampleCount: number;
    lagBars: number;
    minSamples: number;
    bestBucket: ConsensusBucketSummary | null;
    bestLongBucket: ConsensusBucketSummary | null;
    bestShortBucket: ConsensusBucketSummary | null;
    baselineBucket: ConsensusBucketSummary | null;
    profilesBySymbol: Map<string, PairConsensusProfile>;
}

export interface PortfolioRunContext {
    strategy: Strategy;
    params: StrategyParams;
    settings: BacktestSettings;
    capitalSettings: PortfolioCapitalSettings;
    interval: string;
    selectedSymbols: string[];
    benchmarkSymbol: string;
    lagBars: number;
    windowMode: PortfolioWindowMode;
    dataCache: Map<string, CachedPairData>;
    runCache: Map<string, PairRunArtifacts>;
}

export interface PairConsensusProfile {
    symbol: string;
    qualifyingBuckets: ConsensusBucketSummary[];
    baselineBucket: ConsensusBucketSummary | null;
    strongestBucket: ConsensusBucketSummary | null;
    bestBucket: ConsensusBucketSummary | null;
}

export interface BreadthSweepRow {
    minAgree: number;
    signals: number;
    result: BacktestResult;
    engineUsed: PortfolioEngineUsed;
}

export interface OppositionSweepRow {
    maxOppose: number;
    signals: number;
    result: BacktestResult;
    engineUsed: PortfolioEngineUsed;
}

export interface SignalContext {
    timeKey: string;
    signalType: Signal["type"];
    sameCount: number;
    oppositeCount: number;
    agreeingSymbols: string[];
    opposingSymbols: string[];
}

export interface ExecutionFilter {
    minAgree: number;
    maxOppose: number | null;
}

export interface ExecutionFilterRun {
    filter: ExecutionFilter;
    signals: number;
    result: BacktestResult;
    engineUsed: PortfolioEngineUsed;
}

export interface PairRankingRow {
    row: PairAnalysisRow;
    role: string;
    breadthLift: number | null;
    breadthExpectancyLift: number | null;
}

export interface ScenarioSummary {
    totalTrades: number;
    winRate: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    avgMultiplier: number;
}

export interface SizingScenarioRow {
    name: string;
    description: string;
    result: ScenarioSummary;
}

export interface LiveContextOdds {
    sampleCount: number;
    winRate: number;
    lossRate: number;
    expectancy: number;
    label: string;
}

export interface LiveContextSnapshot {
    basis: "open_trade" | "latest_signal" | "none";
    targetSymbol: string;
    direction: Trade["type"] | null;
    agreementCount: number;
    oppositionCount: number;
    agreeingSymbols: string[];
    opposingSymbols: string[];
    bucketLabel: string | null;
    odds: LiveContextOdds | null;
    openPosition: OpenPosition | null;
}

export interface ForecastBreadthSnapshot {
    sameCount: number;
    oppositeCount: number;
    activePeerCount: number;
    weightedSame: number;
    weightedOpposite: number;
    totalPeerWeight: number;
    agreeingSymbols: string[];
    opposingSymbols: string[];
}

export interface ForecastSnapshot {
    basis: "open_trade" | "latest_signal";
    targetSymbol: string;
    anchorSymbol: string;
    direction: Trade["type"];
    timeKey: string;
    barIndex: number;
    entryIndex: number;
    barsHeld: number;
    currentPrice: number;
    entryPrice: number;
    currentPnlPercent: number;
    openPnlAtr: number;
    distanceFromEntryAtr: number;
    adverseExcursionAtr: number;
    agreementCount: number;
    oppositionCount: number;
    activePeerCount: number;
    weightedAgreementRatio: number;
    weightedOppositionRatio: number;
    breadthRatio: number;
    breadthPersistence: number;
    targetVsAnchor1: number | null;
    targetVsAnchor3: number | null;
    targetVsAnchor5: number | null;
    targetVsUniverse1: number | null;
    targetVsUniverse3: number | null;
    targetVsUniverse5: number | null;
    dispersion1: number | null;
    leaderGap1: number | null;
    agreeingSymbols: string[];
    opposingSymbols: string[];
}

export interface ForecastAnalogSample {
    timeKey: string;
    direction: Trade["type"];
    barsHeld: number;
    distance: number;
    agreementCount: number;
    oppositionCount: number;
    targetVsAnchor3: number | null;
    targetVsUniverse3: number | null;
    finalIsWin: boolean;
    finalPnlPercent: number;
    remainingPnlPercent: number;
    futureMfePercent: number | null;
    futureMaePercent: number | null;
}

export interface ForecastCandidateSample {
    snapshot: ForecastSnapshot;
    finalIsWin: boolean;
    finalPnlPercent: number;
    remainingPnlPercent: number;
    futureMfePercent: number | null;
    futureMaePercent: number | null;
}

export interface OpenTradeForecast {
    basis: "open_trade" | "latest_signal" | "none";
    matchType: "nearest" | "fallback" | "none";
    targetSymbol: string;
    anchorSymbol: string;
    direction: Trade["type"] | null;
    confidenceLabel: "Low" | "Medium" | "High" | null;
    confidenceScore: number | null;
    sampleCount: number;
    candidateCount: number;
    winProbability: number | null;
    lossProbability: number | null;
    expectedFinalPnlPercent: number | null;
    expectedRemainingPnlPercent: number | null;
    expectedMaePercent: number | null;
    expectedMfePercent: number | null;
    baselineWinProbability: number | null;
    baselineRemainingPnlPercent: number | null;
    suggestedExposure: number | null;
    suggestionLabel: string | null;
    avgDistance: number | null;
    currentSnapshot: ForecastSnapshot | null;
    analogs: ForecastAnalogSample[];
    rationale: string[];
}
