import type { StrategyConfig } from "./settings-manager";
import type {
    EnsembleRuleSelection,
    EnsembleRuleSpec,
} from "./strategy-ensemble-rule-selection";
import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    Trade,
    TradeDirection,
} from "./strategies";
import type { OpenPosition } from "./strategies/backtest/signal-preparation";

export type EnsembleVoteLabel = "agree" | "oppose" | "neutral" | "conflict";
export type EnsembleCurrentVoteLabel = EnsembleVoteLabel | "n/a";

export interface EnsembleEntryPresence {
    longEntry: boolean;
    shortEntry: boolean;
}

export interface ConfigSignalArtifact {
    config: StrategyConfig;
    strategy: Strategy;
    familyKey: string;
    familyLabel: string;
    tradeDirection: TradeDirection;
    rawSignals: Signal[];
    preparedSignals: Signal[];
    entrySignals: Signal[];
    entryPresenceByTime: Map<string, EnsembleEntryPresence>;
    backtestSettings: BacktestSettings;
}

export interface ConfigRunArtifact extends ConfigSignalArtifact {
    result: BacktestResult;
    engineUsed: "rust" | "typescript";
}

export interface EnsembleTradeSample {
    tradeIndex: number;
    direction: Trade["type"];
    isWin: boolean;
    pnl: number;
    pnlPercent: number;
    agreeCount: number;
    opposeCount: number;
}

export interface EnsembleBucketSummary {
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

export interface EnsembleBuilderRow {
    ruleId: string;
    rule: string;
    signals: number;
    trades: number;
    winRate: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
    engineUsed: "rust" | "typescript";
    selectionMode: "validated" | "train_only" | null;
}

export interface EnsembleBuilderPreview {
    row: EnsembleBuilderRow;
    result: BacktestResult;
    filteredSignals: Signal[];
}

export interface ScenarioPrimaryRow {
    row: EnsembleBuilderRow;
    source: "validated" | "train_only" | "heuristic" | "baseline";
    rule: EnsembleRuleSpec | null;
}

export interface EnsembleVoteProfileStats {
    samples: number;
    winRate: number;
    expectancy: number;
}

export interface EnsembleVoteProfile {
    totalTrades: number;
    agreeCoverage: number;
    opposeCoverage: number;
    conflictCoverage: number;
    neutralCoverage: number;
    agreeStats: EnsembleVoteProfileStats | null;
    opposeStats: EnsembleVoteProfileStats | null;
    conflictStats: EnsembleVoteProfileStats | null;
    neutralStats: EnsembleVoteProfileStats | null;
}

export interface EnsembleContributionRow {
    familyKey: string;
    familyLabel: string;
    configNames: string[];
    currentVote: EnsembleCurrentVoteLabel;
    voteProfile: EnsembleVoteProfile;
    primaryRow: ScenarioPrimaryRow;
    deltaExpectancy: number;
    deltaWinRate: number;
    tradeRetentionPercent: number;
    deltaTrades: number;
}

export interface EnsembleReplacementRow {
    familyKey: string;
    familyLabel: string;
    configName: string;
    currentVote: EnsembleCurrentVoteLabel;
    primaryRow: ScenarioPrimaryRow;
    deltaExpectancyVsRemoved: number;
    deltaExpectancyVsCurrent: number;
    deltaWinRateVsCurrent: number;
    tradeRetentionPercent: number;
    deltaTradesVsCurrent: number;
}

export interface EnsembleLiveContext {
    basis: "open_trade" | "latest_signal" | "none";
    direction: Trade["type"] | null;
    agreeCount: number;
    opposeCount: number;
    neutralCount: number;
    conflictedCount: number;
    rawAgreeCount: number;
    rawOpposeCount: number;
    rawNeutralCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
    agreeingFamilies: string[];
    opposingFamilies: string[];
    neutralFamilies: string[];
    conflictedFamilies: string[];
    odds: {
        sampleCount: number;
        winRate: number;
        lossRate: number;
        expectancy: number;
        label: string;
        matchType: "exact" | "nearest";
    } | null;
    openPosition: OpenPosition | null;
}

export interface EnsembleRunContext {
    targetConfigName: string;
    contextConfigNames: string[];
    contextFamilyCount: number;
    symbol: string;
    interval: string;
    candles: OHLCVData[];
    artifacts: Map<string, ConfigRunArtifact>;
    targetArtifact: ConfigRunArtifact;
    tradeSamples: EnsembleTradeSample[];
    buckets: EnsembleBucketSummary[];
    baselineBucket: EnsembleBucketSummary | null;
    bestBucket: EnsembleBucketSummary | null;
    bestLongBucket: EnsembleBucketSummary | null;
    bestShortBucket: EnsembleBucketSummary | null;
    builderRows: EnsembleBuilderRow[];
    builderPreviewByRuleId: Map<string, EnsembleBuilderPreview>;
    selectedRule: EnsembleRuleSelection | null;
    liveContext: EnsembleLiveContext;
    minSamples: number;
    contributionRows: EnsembleContributionRow[];
    replacementRows: EnsembleReplacementRow[];
}

export interface RuleCounts {
    agreeCount: number;
    opposeCount: number;
}

export interface ContextCounts extends RuleCounts {
    neutralCount: number;
    conflictedCount: number;
    rawAgreeCount: number;
    rawOpposeCount: number;
    rawNeutralCount: number;
    agreeingConfigs: string[];
    opposingConfigs: string[];
    agreeingFamilies: string[];
    opposingFamilies: string[];
    neutralFamilies: string[];
    conflictedFamilies: string[];
}

export interface RadarFinding {
    label: string;
    detail: string;
    quality: "positive" | "negative" | "neutral";
}

export interface EnsembleScenarioEvaluation {
    contextFamilyCount: number;
    tradeSamples: EnsembleTradeSample[];
    buckets: EnsembleBucketSummary[];
    baselineBucket: EnsembleBucketSummary | null;
    bestBucket: EnsembleBucketSummary | null;
    bestLongBucket: EnsembleBucketSummary | null;
    bestShortBucket: EnsembleBucketSummary | null;
    builderRows: EnsembleBuilderRow[];
    builderPreviewByRuleId: Map<string, EnsembleBuilderPreview>;
    selectedRule: EnsembleRuleSelection | null;
    analysisRule: ScenarioPrimaryRow | null;
}

export interface CurrentContextReference {
    basis: "open_trade" | "latest_signal" | "none";
    direction: Trade["type"] | null;
    timeKey: string | null;
    openPosition: OpenPosition | null;
}

export interface ProxyRuleEvaluation {
    rule: EnsembleRuleSpec;
    trades: number;
    expectancy: number;
    netProfitPercent: number;
    profitFactor: number;
    maxDrawdownPercent: number;
}
