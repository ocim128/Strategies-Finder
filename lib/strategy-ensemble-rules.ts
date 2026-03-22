import {
    countDistinctFamilies,
    filterSignalsToCandles,
    isTargetEntrySignal,
    splitCandles,
} from "./strategy-ensemble-engine";
import {
    selectEnsembleRuleSelection,
    type EnsembleRuleEvaluation,
    type EnsembleRuleSelection,
    type EnsembleRuleSpec,
} from "./strategy-ensemble-rule-selection";
import { timeKey, type OHLCVData, type Signal, type Trade } from "./strategies";
import type {
    ConfigRunArtifact,
    ConfigSignalArtifact,
    ContextCounts,
    CurrentContextReference,
    EnsembleBucketSummary,
    EnsembleBuilderPreview,
    EnsembleBuilderRow,
    EnsembleContributionRow,
    EnsembleCurrentVoteLabel,
    EnsembleReplacementRow,
    EnsembleScenarioEvaluation,
    EnsembleTradeSample,
    EnsembleVoteLabel,
    EnsembleVoteProfile,
    EnsembleVoteProfileStats,
    ProxyRuleEvaluation,
    RuleCounts,
    ScenarioPrimaryRow,
} from "./strategy-ensemble-types";

const DEFAULT_MAX_RULE_VALIDATION_CANDIDATES = 12;
const DEFAULT_MAX_RULE_BUILDER_ROWS = 10;
const DEFAULT_MAX_REPLACEMENT_ROWS = 12;

const byExpectancyThenTrades = (left: ProxyRuleEvaluation, right: ProxyRuleEvaluation): number =>
    (right.expectancy - left.expectancy) || (right.trades - left.trades);

const byExpectancyThenSamples = (
    left: { expectancy: number; samples: number },
    right: { expectancy: number; samples: number }
): number => (right.expectancy - left.expectancy) || (right.samples - left.samples);

const compareFamilyDeltaRows = <T extends { familyLabel: string }>(
    left: T,
    right: T,
    primaryMetric: (row: T) => number,
    secondaryMetric: (row: T) => number
): number => {
    const primaryDelta = primaryMetric(right) - primaryMetric(left);
    if (primaryDelta !== 0) {
        return primaryDelta;
    }

    const secondaryDelta = secondaryMetric(right) - secondaryMetric(left);
    if (secondaryDelta !== 0) {
        return secondaryDelta;
    }

    return left.familyLabel.localeCompare(right.familyLabel);
};

export interface StrategyEnsembleRulesRuntime {
    runFilteredBacktest(
        targetArtifact: ConfigRunArtifact,
        signals: Signal[],
        candles: OHLCVData[]
    ): Promise<{ result: ConfigRunArtifact["result"]; engineUsed: "rust" | "typescript" } | null>;
    yieldToUi(): Promise<void>;
    updateStatus?(message: string): void;
    maxRuleValidationCandidates?: number;
    maxRuleBuilderRows?: number;
    maxReplacementRows?: number;
}

export function buildTradeSamples(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigSignalArtifact[]
): EnsembleTradeSample[] {
    return targetArtifact.result.trades.map((trade, tradeIndex) => {
        const entryTimeKey = timeKey(trade.entryTime);
        const counts = buildContextCountsForTimeKey(trade.type, entryTimeKey, contextArtifacts);

        return {
            tradeIndex,
            direction: trade.type,
            isWin: trade.pnl > 0,
            pnl: trade.pnl,
            pnlPercent: trade.pnlPercent,
            agreeCount: counts.agreeCount,
            opposeCount: counts.opposeCount,
        };
    });
}

export function buildContextCountsForTimeKey(
    direction: Trade["type"],
    entryTimeKey: string,
    contextArtifacts: ConfigSignalArtifact[]
): ContextCounts {
    let rawAgreeCount = 0;
    let rawOpposeCount = 0;
    let rawNeutralCount = 0;
    const agreeingConfigs: string[] = [];
    const opposingConfigs: string[] = [];
    const familyVotes = new Map<string, {
        label: string;
        agreeConfigs: string[];
        opposeConfigs: string[];
    }>();

    for (const artifact of contextArtifacts) {
        const vote = resolveContextVote(direction, artifact.entryPresenceByTime.get(entryTimeKey));
        if (vote === "agree") {
            rawAgreeCount += 1;
            agreeingConfigs.push(artifact.config.name);
        } else if (vote === "oppose") {
            rawOpposeCount += 1;
            opposingConfigs.push(artifact.config.name);
        } else {
            rawNeutralCount += 1;
        }

        const family = familyVotes.get(artifact.familyKey) ?? {
            label: artifact.familyLabel,
            agreeConfigs: [],
            opposeConfigs: [],
        };

        if (vote === "agree") {
            family.agreeConfigs.push(artifact.config.name);
        } else if (vote === "oppose") {
            family.opposeConfigs.push(artifact.config.name);
        } else if (vote === "conflict") {
            family.agreeConfigs.push(artifact.config.name);
            family.opposeConfigs.push(artifact.config.name);
        }
        familyVotes.set(artifact.familyKey, family);
    }

    let agreeCount = 0;
    let opposeCount = 0;
    let neutralCount = 0;
    let conflictedCount = 0;
    const agreeingFamilies: string[] = [];
    const opposingFamilies: string[] = [];
    const neutralFamilies: string[] = [];
    const conflictedFamilies: string[] = [];

    for (const family of familyVotes.values()) {
        const hasAgree = family.agreeConfigs.length > 0;
        const hasOppose = family.opposeConfigs.length > 0;
        if (hasAgree && hasOppose) {
            conflictedCount += 1;
            conflictedFamilies.push(family.label);
        } else if (hasAgree) {
            agreeCount += 1;
            agreeingFamilies.push(family.label);
        } else if (hasOppose) {
            opposeCount += 1;
            opposingFamilies.push(family.label);
        } else {
            neutralCount += 1;
            neutralFamilies.push(family.label);
        }
    }

    return {
        agreeCount,
        opposeCount,
        neutralCount,
        conflictedCount,
        rawAgreeCount,
        rawOpposeCount,
        rawNeutralCount,
        agreeingConfigs,
        opposingConfigs,
        agreeingFamilies,
        opposingFamilies,
        neutralFamilies,
        conflictedFamilies,
    };
}

export function resolveContextVote(
    direction: Trade["type"],
    presence: ConfigSignalArtifact["entryPresenceByTime"] extends Map<string, infer T> ? T | null | undefined : never
): EnsembleVoteLabel {
    if (!presence) {
        return "neutral";
    }

    const agrees = direction === "long" ? presence.longEntry : presence.shortEntry;
    const opposes = direction === "long" ? presence.shortEntry : presence.longEntry;

    if (agrees && opposes) {
        return "conflict";
    }
    if (agrees) {
        return "agree";
    }
    if (opposes) {
        return "oppose";
    }
    return "neutral";
}

export function buildBuckets(samples: EnsembleTradeSample[], minSamples: number): EnsembleBucketSummary[] {
    if (samples.length === 0) {
        return [];
    }

    const buckets: EnsembleBucketSummary[] = [];
    const maxAgree = Math.max(0, ...samples.map((sample) => sample.agreeCount));
    const maxOppose = Math.max(0, ...samples.map((sample) => sample.opposeCount));

    for (let agree = 0; agree <= maxAgree; agree += 1) {
        const exact = samples.filter((sample) => sample.agreeCount === agree);
        if (exact.length >= minSamples) {
            buckets.push(summarizeBucket(`family agree = ${agree}`, agree, exact));
        }
    }

    for (let agree = 1; agree <= maxAgree; agree += 1) {
        const cumulative = samples.filter((sample) => sample.agreeCount >= agree);
        if (cumulative.length >= minSamples) {
            buckets.push(summarizeBucket(`family agree >= ${agree}`, 100 + agree, cumulative));
        }
    }

    for (let oppose = 0; oppose <= maxOppose; oppose += 1) {
        const exact = samples.filter((sample) => sample.opposeCount === oppose);
        if (exact.length >= minSamples) {
            buckets.push(summarizeBucket(`family oppose = ${oppose}`, -1 - oppose, exact));
        }
    }

    return buckets.sort((left, right) => left.sortValue - right.sortValue);
}

export function buildBaselineBucket(samples: EnsembleTradeSample[]): EnsembleBucketSummary | null {
    if (samples.length === 0) {
        return null;
    }
    return summarizeBucket("baseline (all)", -999, samples);
}

export function summarizeBucket(
    label: string,
    sortValue: number,
    samples: EnsembleTradeSample[]
): EnsembleBucketSummary {
    const wins = samples.filter((sample) => sample.isWin);
    const losses = samples.filter((sample) => !sample.isWin);
    const longSamples = samples.filter((sample) => sample.direction === "long");
    const shortSamples = samples.filter((sample) => sample.direction === "short");
    const longWins = longSamples.filter((sample) => sample.isWin);
    const shortWins = shortSamples.filter((sample) => sample.isWin);

    return {
        label,
        sortValue,
        samples: samples.length,
        winRate: (wins.length / samples.length) * 100,
        lossRate: (losses.length / samples.length) * 100,
        avgExpectancy: samples.reduce((sum, sample) => sum + sample.pnl, 0) / samples.length,
        avgNetPct: samples.reduce((sum, sample) => sum + sample.pnlPercent, 0) / samples.length,
        avgOppose: samples.reduce((sum, sample) => sum + sample.opposeCount, 0) / samples.length,
        longWinRate: longSamples.length >= 3 ? (longWins.length / longSamples.length) * 100 : null,
        shortWinRate: shortSamples.length >= 3 ? (shortWins.length / shortSamples.length) * 100 : null,
        longSamples: longSamples.length,
        shortSamples: shortSamples.length,
    };
}

export function findBestBucket(
    buckets: EnsembleBucketSummary[],
    metric: "expectancy" | "longWinRate" | "shortWinRate"
): EnsembleBucketSummary | null {
    if (buckets.length === 0) {
        return null;
    }

    return buckets.reduce((best, current) => {
        const bestValue = metric === "expectancy" ? best.avgExpectancy : (best[metric] ?? Number.NEGATIVE_INFINITY);
        const currentValue = metric === "expectancy" ? current.avgExpectancy : (current[metric] ?? Number.NEGATIVE_INFINITY);
        return currentValue > bestValue ? current : best;
    });
}

export async function evaluateScenario(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    candles: OHLCVData[],
    minSamples: number,
    runtime: StrategyEnsembleRulesRuntime
): Promise<EnsembleScenarioEvaluation> {
    const contextFamilyCount = countDistinctFamilies(contextArtifacts);
    const tradeSamples = buildTradeSamples(targetArtifact, contextArtifacts);
    const buckets = buildBuckets(tradeSamples, minSamples);
    const baselineBucket = buildBaselineBucket(tradeSamples);
    const bestBucket = findBestBucket(buckets, "expectancy");
    const bestLongBucket = findBestBucket(
        buckets.filter((bucket) => bucket.longSamples >= minSamples),
        "longWinRate"
    );
    const bestShortBucket = findBestBucket(
        buckets.filter((bucket) => bucket.shortSamples >= minSamples),
        "shortWinRate"
    );
    const candidateRules = buildRuleCandidates(contextFamilyCount, tradeSamples, minSamples);
    const shortlistedRules = selectShortlistedRules(candidateRules, tradeSamples, contextFamilyCount, minSamples, runtime);
    const selectedRule = await selectRuleForValidation(
        shortlistedRules,
        targetArtifact,
        contextArtifacts,
        candles,
        contextFamilyCount,
        minSamples,
        runtime
    );
    const analysisRule = resolveAnalysisRule(
        selectedRule,
        shortlistedRules,
        tradeSamples,
        contextFamilyCount,
        minSamples
    );
    const builderRows = await buildEnsembleRows(
        targetArtifact,
        contextArtifacts,
        candles,
        contextFamilyCount,
        selectBuilderRules(shortlistedRules, tradeSamples, contextFamilyCount, minSamples, selectedRule, runtime),
        selectedRule,
        runtime
    );

    return {
        contextFamilyCount,
        tradeSamples,
        buckets,
        baselineBucket,
        bestBucket,
        bestLongBucket,
        bestShortBucket,
        builderRows: builderRows.rows,
        builderPreviewByRuleId: builderRows.previewByRuleId,
        selectedRule,
        analysisRule,
    };
}

export function resolveScenarioPrimaryRow(builderRows: EnsembleBuilderRow[]): ScenarioPrimaryRow | null {
    const selected = builderRows.find((row) => row.selectionMode === "validated");
    if (selected) {
        return { row: selected, source: "validated", rule: null };
    }

    const trainOnly = builderRows.find((row) => row.selectionMode === "train_only");
    if (trainOnly) {
        return { row: trainOnly, source: "train_only", rule: null };
    }

    const baseline = builderRows.find((row) => row.rule === "Baseline (target only)") ?? builderRows[0] ?? null;
    return baseline
        ? { row: baseline, source: "baseline", rule: null }
        : null;
}

export function describeScenarioPrimaryRow(primaryRow: ScenarioPrimaryRow): string {
    if (primaryRow.source === "validated") {
        return `${primaryRow.row.rule} [Validated]`;
    }
    if (primaryRow.source === "train_only") {
        return `${primaryRow.row.rule} [In-sample only]`;
    }
    if (primaryRow.source === "heuristic") {
        return `${primaryRow.row.rule} [Heuristic]`;
    }
    return "Baseline (target only)";
}

export function resolveFamilyVoteForTimeKey(
    direction: Trade["type"],
    entryTimeKey: string,
    artifacts: ConfigSignalArtifact[]
): EnsembleVoteLabel {
    let hasAgree = false;
    let hasOppose = false;

    for (const artifact of artifacts) {
        const vote = resolveContextVote(direction, artifact.entryPresenceByTime.get(entryTimeKey));
        if (vote === "agree") {
            hasAgree = true;
        } else if (vote === "oppose") {
            hasOppose = true;
        } else if (vote === "conflict") {
            hasAgree = true;
            hasOppose = true;
        }
    }

    if (hasAgree && hasOppose) {
        return "conflict";
    }
    if (hasAgree) {
        return "agree";
    }
    if (hasOppose) {
        return "oppose";
    }
    return "neutral";
}

export function summarizeVoteProfileStats(trades: Trade[]): EnsembleVoteProfileStats | null {
    if (trades.length === 0) {
        return null;
    }

    const wins = trades.filter((trade) => trade.pnl > 0).length;
    return {
        samples: trades.length,
        winRate: (wins / trades.length) * 100,
        expectancy: trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length,
    };
}

export function buildVoteProfile(
    targetArtifact: ConfigRunArtifact,
    familyArtifacts: ConfigRunArtifact[]
): EnsembleVoteProfile {
    const agreeTrades: Trade[] = [];
    const opposeTrades: Trade[] = [];
    const conflictTrades: Trade[] = [];
    const neutralTrades: Trade[] = [];

    for (const trade of targetArtifact.result.trades) {
        const vote = resolveFamilyVoteForTimeKey(trade.type, timeKey(trade.entryTime), familyArtifacts);
        if (vote === "agree") {
            agreeTrades.push(trade);
        } else if (vote === "oppose") {
            opposeTrades.push(trade);
        } else if (vote === "conflict") {
            conflictTrades.push(trade);
        } else {
            neutralTrades.push(trade);
        }
    }

    const totalTrades = Math.max(1, targetArtifact.result.trades.length);
    return {
        totalTrades: targetArtifact.result.trades.length,
        agreeCoverage: (agreeTrades.length / totalTrades) * 100,
        opposeCoverage: (opposeTrades.length / totalTrades) * 100,
        conflictCoverage: (conflictTrades.length / totalTrades) * 100,
        neutralCoverage: (neutralTrades.length / totalTrades) * 100,
        agreeStats: summarizeVoteProfileStats(agreeTrades),
        opposeStats: summarizeVoteProfileStats(opposeTrades),
        conflictStats: summarizeVoteProfileStats(conflictTrades),
        neutralStats: summarizeVoteProfileStats(neutralTrades),
    };
}

export function resolveCurrentVoteLabel(
    currentContextReference: CurrentContextReference,
    familyArtifacts: ConfigSignalArtifact[]
): EnsembleCurrentVoteLabel {
    if (!currentContextReference.direction || !currentContextReference.timeKey) {
        return "n/a";
    }

    return resolveFamilyVoteForTimeKey(
        currentContextReference.direction,
        currentContextReference.timeKey,
        familyArtifacts
    );
}

export function resolveAnalysisRule(
    selectedRule: EnsembleRuleSelection | null,
    shortlistedRules: EnsembleRuleSpec[],
    tradeSamples: EnsembleTradeSample[],
    contextFamilyCount: number,
    minSamples: number
): ScenarioPrimaryRow | null {
    if (selectedRule) {
        return {
            row: buildProxyResultRowFromTradeSamples(
                selectedRule.evaluation.rule.label,
                filterTradeSamplesByRule(tradeSamples, contextFamilyCount, selectedRule.evaluation.rule),
                selectedRule.mode
            ),
            source: selectedRule.mode,
            rule: selectedRule.evaluation.rule,
        };
    }

    const baselineProxy = buildProxyResultRowFromTradeSamples("Baseline (target only)", tradeSamples, null);
    const proxyEvaluations = shortlistedRules
        .map((rule) => buildProxyRuleEvaluation(rule, tradeSamples, contextFamilyCount))
        .filter((evaluation) =>
            evaluation.trades >= minSamples
            && Number.isFinite(evaluation.expectancy)
        );

    const balanceCandidate = proxyEvaluations
        .filter((evaluation) =>
            evaluation.trades >= baselineProxy.trades * 0.5
            && evaluation.expectancy >= baselineProxy.expectancy
        )
        .sort(byExpectancyThenTrades)[0];

    const fallback = balanceCandidate ?? proxyEvaluations
        .slice()
        .sort(byExpectancyThenTrades)[0];

    return fallback
        ? {
            row: buildProxyResultRowFromTradeSamples(
                fallback.rule.label,
                filterTradeSamplesByRule(tradeSamples, contextFamilyCount, fallback.rule),
                null
            ),
            source: "heuristic",
            rule: fallback.rule,
        }
        : {
            row: baselineProxy,
            source: "baseline",
            rule: null,
        };
}

export async function buildEnsembleRows(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    candles: OHLCVData[],
    contextFamilyCount: number,
    candidateRules: EnsembleRuleSpec[],
    selectedRule: EnsembleRuleSelection | null,
    runtime: StrategyEnsembleRulesRuntime
): Promise<{ rows: EnsembleBuilderRow[]; previewByRuleId: Map<string, EnsembleBuilderPreview> }> {
    const baselineEvaluated = await runtime.runFilteredBacktest(
        targetArtifact,
        targetArtifact.preparedSignals,
        candles
    );
    const previewByRuleId = new Map<string, EnsembleBuilderPreview>();
    const baselineRuleId = "baseline";
    const baselineRow = buildResultRow(
        baselineRuleId,
        "Baseline (target only)",
        baselineEvaluated?.result ?? targetArtifact.result,
        targetArtifact.preparedSignals,
        baselineEvaluated?.engineUsed ?? targetArtifact.engineUsed,
        null
    );
    const rows: EnsembleBuilderRow[] = [baselineRow];
    previewByRuleId.set(baselineRuleId, {
        row: baselineRow,
        result: baselineEvaluated?.result ?? targetArtifact.result,
        filteredSignals: targetArtifact.preparedSignals,
    });

    if (contextArtifacts.length === 0 || contextFamilyCount === 0) {
        return {
            rows,
            previewByRuleId,
        };
    }

    for (const rule of candidateRules) {
        const filteredSignals = filterSignalsByRule(targetArtifact, contextArtifacts, contextFamilyCount, rule);
        const evaluated = await runtime.runFilteredBacktest(targetArtifact, filteredSignals, candles);
        if (evaluated) {
            const row = buildResultRow(
                rule.id,
                rule.label,
                evaluated.result,
                filteredSignals,
                evaluated.engineUsed,
                selectedRule?.evaluation.rule.id === rule.id ? selectedRule.mode : null
            );
            rows.push(row);
            previewByRuleId.set(rule.id, {
                row,
                result: evaluated.result,
                filteredSignals,
            });
        }
        await runtime.yieldToUi();
    }

    return {
        rows: dedupeBuilderRows(rows),
        previewByRuleId,
    };
}

export function filterSignalsByRule(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    contextFamilyCount: number,
    rule: EnsembleRuleSpec
): Signal[] {
    return targetArtifact.preparedSignals.filter((signal) => {
        if (!isTargetEntrySignal(targetArtifact, signal)) {
            return true;
        }

        const signalDirection = signal.type === "buy" ? "long" : "short";
        const counts = buildContextCountsForTimeKey(signalDirection, timeKey(signal.time), contextArtifacts);
        return rulePasses(rule, counts, contextFamilyCount);
    });
}

export function buildRuleCandidates(
    contextFamilyCount: number,
    tradeSamples: EnsembleTradeSample[],
    minSamples: number
): EnsembleRuleSpec[] {
    if (contextFamilyCount === 0) {
        return [];
    }

    const rules: EnsembleRuleSpec[] = [];

    for (let minAgree = 1; minAgree <= contextFamilyCount; minAgree += 1) {
        rules.push({
            id: `minAgree:${minAgree}`,
            label: `minFamilyAgree >= ${minAgree}`,
            minFamilyAgree: minAgree,
        });
    }

    rules.push({
        id: "veto",
        label: "Veto (no family opposition)",
        maxFamilyOppose: 0,
    });

    for (let maxOppose = 1; maxOppose <= contextFamilyCount; maxOppose += 1) {
        rules.push({
            id: `maxOppose:${maxOppose}`,
            label: `maxFamilyOppose <= ${maxOppose}`,
            maxFamilyOppose: maxOppose,
        });
    }

    const ratioThresholds = [0.25, 1 / 3, 0.5, 2 / 3, 0.75];
    for (const ratio of ratioThresholds) {
        const percent = Math.round(ratio * 100);
        rules.push({
            id: `agreePct:${percent}`,
            label: `familyAgreePct >= ${percent}%`,
            minFamilyAgreeRatio: ratio,
        });
    }

    const comboEvaluations: Array<{ rule: EnsembleRuleSpec; samples: number; expectancy: number }> = [];
    for (let minAgree = 1; minAgree <= contextFamilyCount; minAgree += 1) {
        for (let maxOppose = 0; maxOppose <= contextFamilyCount; maxOppose += 1) {
            const rule: EnsembleRuleSpec = {
                id: `combo:${minAgree}:${maxOppose}`,
                label: `familyAgree >= ${minAgree} + familyOppose <= ${maxOppose}`,
                minFamilyAgree: minAgree,
                maxFamilyOppose: maxOppose,
            };
            const matchingSamples = tradeSamples.filter((sample) => rulePasses(rule, sample, contextFamilyCount));
            comboEvaluations.push({
                rule,
                samples: matchingSamples.length,
                expectancy: matchingSamples.length > 0
                    ? matchingSamples.reduce((sum, sample) => sum + sample.pnl, 0) / matchingSamples.length
                    : Number.NEGATIVE_INFINITY,
            });
        }
    }

    comboEvaluations
        .filter((evaluation) => evaluation.samples >= minSamples)
        .sort(byExpectancyThenSamples)
        .slice(0, 12)
        .forEach((evaluation) => {
            rules.push(evaluation.rule);
        });

    return dedupeRuleSpecs(rules);
}

export function buildProxyRuleEvaluation(
    rule: EnsembleRuleSpec,
    tradeSamples: EnsembleTradeSample[],
    contextFamilyCount: number
): ProxyRuleEvaluation {
    const filteredSamples = filterTradeSamplesByRule(tradeSamples, contextFamilyCount, rule);
    const proxyRow = buildProxyResultRowFromTradeSamples(rule.label, filteredSamples, null);

    return {
        rule,
        trades: proxyRow.trades,
        expectancy: proxyRow.expectancy,
        netProfitPercent: proxyRow.netProfitPercent,
        profitFactor: proxyRow.profitFactor,
        maxDrawdownPercent: proxyRow.maxDrawdownPercent,
    };
}

export function selectShortlistedRules(
    candidateRules: EnsembleRuleSpec[],
    tradeSamples: EnsembleTradeSample[],
    contextFamilyCount: number,
    minSamples: number,
    runtime: Pick<StrategyEnsembleRulesRuntime, "maxRuleValidationCandidates">
): EnsembleRuleSpec[] {
    const maxRuleValidationCandidates = runtime.maxRuleValidationCandidates ?? DEFAULT_MAX_RULE_VALIDATION_CANDIDATES;
    if (candidateRules.length <= maxRuleValidationCandidates) {
        return candidateRules;
    }

    const baselineProxy = buildProxyResultRowFromTradeSamples("Baseline (target only)", tradeSamples, null);
    const proxyEvaluations = candidateRules
        .map((rule) => buildProxyRuleEvaluation(rule, tradeSamples, contextFamilyCount))
        .filter((evaluation) => evaluation.trades >= minSamples);

    const selected = new Map<string, EnsembleRuleSpec>();
    const takeTop = (
        evaluations: ProxyRuleEvaluation[],
        limit: number,
        compare: (left: ProxyRuleEvaluation, right: ProxyRuleEvaluation) => number
    ) => {
        evaluations
            .slice()
            .sort(compare)
            .slice(0, limit)
            .forEach((evaluation) => {
                selected.set(evaluation.rule.id, evaluation.rule);
            });
    };

    takeTop(
        proxyEvaluations,
        5,
        byExpectancyThenTrades
    );
    takeTop(
        proxyEvaluations.filter((evaluation) => Math.abs(evaluation.maxDrawdownPercent) < Math.abs(baselineProxy.maxDrawdownPercent)),
        3,
        (left, right) => Math.abs(left.maxDrawdownPercent) - Math.abs(right.maxDrawdownPercent)
    );
    takeTop(
        proxyEvaluations.filter((evaluation) => evaluation.trades >= baselineProxy.trades * 0.5),
        3,
        byExpectancyThenTrades
    );

    const baselineLikeRules = candidateRules.filter((rule) =>
        rule.id === "veto" || rule.id.startsWith("minAgree:1") || rule.id.startsWith("maxOppose:0")
    );
    for (const rule of baselineLikeRules) {
        selected.set(rule.id, rule);
    }

    return Array.from(selected.values()).slice(0, maxRuleValidationCandidates);
}

export function selectBuilderRules(
    shortlistedRules: EnsembleRuleSpec[],
    tradeSamples: EnsembleTradeSample[],
    contextFamilyCount: number,
    minSamples: number,
    selectedRule: EnsembleRuleSelection | null,
    runtime: Pick<StrategyEnsembleRulesRuntime, "maxRuleBuilderRows">
): EnsembleRuleSpec[] {
    const maxRuleBuilderRows = runtime.maxRuleBuilderRows ?? DEFAULT_MAX_RULE_BUILDER_ROWS;
    const proxyEvaluations = shortlistedRules
        .map((rule) => buildProxyRuleEvaluation(rule, tradeSamples, contextFamilyCount))
        .filter((evaluation) => evaluation.trades >= minSamples);
    const selected = new Map<string, EnsembleRuleSpec>();

    if (selectedRule) {
        selected.set(selectedRule.evaluation.rule.id, selectedRule.evaluation.rule);
    }

    proxyEvaluations
        .slice()
        .sort(byExpectancyThenTrades)
        .slice(0, maxRuleBuilderRows)
        .forEach((evaluation) => {
            selected.set(evaluation.rule.id, evaluation.rule);
        });

    return Array.from(selected.values());
}

export function rulePasses(rule: EnsembleRuleSpec, counts: RuleCounts, contextFamilyCount: number): boolean {
    if (typeof rule.minFamilyAgree === "number" && counts.agreeCount < rule.minFamilyAgree) {
        return false;
    }
    if (typeof rule.maxFamilyOppose === "number" && counts.opposeCount > rule.maxFamilyOppose) {
        return false;
    }
    if (typeof rule.minFamilyAgreeRatio === "number") {
        if (contextFamilyCount <= 0) {
            return false;
        }
        if ((counts.agreeCount / contextFamilyCount) < rule.minFamilyAgreeRatio) {
            return false;
        }
    }
    return true;
}

export function filterTradeSamplesByRule(
    tradeSamples: EnsembleTradeSample[],
    contextFamilyCount: number,
    rule: EnsembleRuleSpec | null
): EnsembleTradeSample[] {
    if (!rule) {
        return tradeSamples.slice();
    }

    return tradeSamples.filter((sample) => rulePasses(rule, sample, contextFamilyCount));
}

export function computeApproximateMaxDrawdownPercent(samples: EnsembleTradeSample[]): number {
    if (samples.length === 0) {
        return 0;
    }

    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const sample of samples) {
        cumulative += sample.pnlPercent;
        if (cumulative > peak) {
            peak = cumulative;
        }
        const drawdown = peak - cumulative;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
    }

    return -maxDrawdown;
}

export function buildProxyResultRowFromTradeSamples(
    label: string,
    tradeSamples: EnsembleTradeSample[],
    selectionMode: EnsembleBuilderRow["selectionMode"]
): EnsembleBuilderRow {
    const wins = tradeSamples.filter((sample) => sample.pnl > 0);
    const losses = tradeSamples.filter((sample) => sample.pnl < 0);
    const grossProfit = wins.reduce((sum, sample) => sum + sample.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, sample) => sum + sample.pnl, 0));
    const totalPnl = tradeSamples.reduce((sum, sample) => sum + sample.pnl, 0);
    const totalNetPct = tradeSamples.reduce((sum, sample) => sum + sample.pnlPercent, 0);

    return {
        ruleId: `proxy:${label}`,
        rule: label,
        signals: tradeSamples.length,
        trades: tradeSamples.length,
        winRate: tradeSamples.length > 0 ? (wins.length / tradeSamples.length) * 100 : 0,
        netProfitPercent: totalNetPct,
        expectancy: tradeSamples.length > 0 ? totalPnl / tradeSamples.length : 0,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
        maxDrawdownPercent: computeApproximateMaxDrawdownPercent(tradeSamples),
        engineUsed: "typescript",
        selectionMode,
    };
}

export async function evaluateRuleOnBacktests(
    rule: EnsembleRuleSpec,
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    candles: OHLCVData[],
    contextFamilyCount: number,
    minSamples: number,
    runtime: Pick<StrategyEnsembleRulesRuntime, "runFilteredBacktest">
): Promise<EnsembleRuleEvaluation | null> {
    const filteredSignals = filterSignalsByRule(targetArtifact, contextArtifacts, contextFamilyCount, rule);
    const fullResult = await runtime.runFilteredBacktest(targetArtifact, filteredSignals, candles);
    if (!fullResult) {
        return null;
    }

    const { train, validation } = splitCandles(candles);
    const baselineTrainSignals = filterSignalsToCandles(targetArtifact.preparedSignals, train);
    const baselineValidationSignals = filterSignalsToCandles(targetArtifact.preparedSignals, validation);
    const filteredTrainSignals = filterSignalsToCandles(filteredSignals, train);
    const filteredValidationSignals = filterSignalsToCandles(filteredSignals, validation);

    const [baselineTrain, baselineValidation, filteredTrain, filteredValidation] = await Promise.all([
        runtime.runFilteredBacktest(targetArtifact, baselineTrainSignals, train),
        runtime.runFilteredBacktest(targetArtifact, baselineValidationSignals, validation),
        runtime.runFilteredBacktest(targetArtifact, filteredTrainSignals, train),
        runtime.runFilteredBacktest(targetArtifact, filteredValidationSignals, validation),
    ]);

    const trainTrades = filteredTrain?.result.totalTrades ?? 0;
    const validationTrades = filteredValidation?.result.totalTrades ?? 0;
    const trainExpectancy = filteredTrain?.result.expectancy ?? Number.NEGATIVE_INFINITY;
    const validationExpectancy = filteredValidation?.result.expectancy ?? Number.NEGATIVE_INFINITY;

    return {
        rule,
        trainSamples: trainTrades,
        trainExpectancy,
        validationSamples: validationTrades,
        validationExpectancy,
        fullTrades: fullResult.result.totalTrades,
        fullExpectancy: fullResult.result.expectancy,
        validated: trainTrades >= minSamples
            && validationTrades >= minSamples
            && trainExpectancy >= (baselineTrain?.result.expectancy ?? Number.POSITIVE_INFINITY)
            && validationExpectancy >= (baselineValidation?.result.expectancy ?? Number.POSITIVE_INFINITY)
            && fullResult.result.totalTrades >= minSamples,
    };
}

export async function selectRuleForValidation(
    candidateRules: EnsembleRuleSpec[],
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    candles: OHLCVData[],
    contextFamilyCount: number,
    minSamples: number,
    runtime: Pick<StrategyEnsembleRulesRuntime, "runFilteredBacktest" | "yieldToUi">
): Promise<EnsembleRuleSelection | null> {
    const evaluations: EnsembleRuleEvaluation[] = [];
    for (let index = 0; index < candidateRules.length; index += 1) {
        const evaluation = await evaluateRuleOnBacktests(
            candidateRules[index],
            targetArtifact,
            contextArtifacts,
            candles,
            contextFamilyCount,
            minSamples,
            runtime
        );
        if (evaluation) {
            evaluations.push(evaluation);
        }
        await runtime.yieldToUi();
    }
    return selectEnsembleRuleSelection(evaluations, minSamples);
}

export function dedupeRuleSpecs(rules: EnsembleRuleSpec[]): EnsembleRuleSpec[] {
    const seen = new Set<string>();
    const deduped: EnsembleRuleSpec[] = [];

    for (const rule of rules) {
        if (seen.has(rule.id)) {
            continue;
        }
        seen.add(rule.id);
        deduped.push(rule);
    }

    return deduped;
}

export function dedupeBuilderRows(rows: EnsembleBuilderRow[]): EnsembleBuilderRow[] {
    const seen = new Set<string>();
    const deduped: EnsembleBuilderRow[] = [];

    for (const row of rows) {
        const signature = [
            row.signals,
            row.trades,
            row.winRate.toFixed(6),
            row.netProfitPercent.toFixed(6),
            row.expectancy.toFixed(6),
            row.profitFactor === Infinity ? "INF" : row.profitFactor.toFixed(6),
            row.maxDrawdownPercent.toFixed(6),
            row.engineUsed,
            row.selectionMode ?? "",
        ].join("|");

        if (seen.has(signature)) {
            continue;
        }

        seen.add(signature);
        deduped.push(row);
    }

    return deduped;
}

export function groupArtifactsByFamily<T extends ConfigSignalArtifact>(artifacts: T[]): Map<string, T[]> {
    const grouped = new Map<string, T[]>();

    for (const artifact of artifacts) {
        const existing = grouped.get(artifact.familyKey);
        if (existing) {
            existing.push(artifact);
        } else {
            grouped.set(artifact.familyKey, [artifact]);
        }
    }

    return grouped;
}

function buildFamilySweepPrimaryRow(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigSignalArtifact[],
    ruleLabel: string,
    source: ScenarioPrimaryRow["source"],
    activeRule: EnsembleRuleSpec | null
): ScenarioPrimaryRow {
    const tradeSamples = buildTradeSamples(targetArtifact, contextArtifacts);
    const contextFamilyCount = countDistinctFamilies(contextArtifacts);
    const filteredSamples = filterTradeSamplesByRule(tradeSamples, contextFamilyCount, activeRule);
    return {
        row: buildProxyResultRowFromTradeSamples(ruleLabel, filteredSamples, null),
        source,
        rule: activeRule,
    };
}

export async function buildContributionRows(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    baseScenario: EnsembleScenarioEvaluation,
    currentContextReference: CurrentContextReference,
    runtime: Pick<StrategyEnsembleRulesRuntime, "yieldToUi" | "updateStatus">
): Promise<EnsembleContributionRow[]> {
    const basePrimaryRow = baseScenario.analysisRule;
    if (!basePrimaryRow) {
        return [];
    }

    const activeRule = basePrimaryRow.rule;
    const familyGroups = groupArtifactsByFamily(contextArtifacts);
    const rows: EnsembleContributionRow[] = [];
    const entries = Array.from(familyGroups.entries());

    for (let index = 0; index < entries.length; index += 1) {
        const [familyKey, familyArtifacts] = entries[index];
        runtime.updateStatus?.(
            `Scoring leave-one-out family ${index + 1}/${entries.length}: ${familyArtifacts[0]?.familyLabel ?? familyKey}...`
        );
        const reducedArtifacts = contextArtifacts.filter((artifact) => artifact.familyKey !== familyKey);
        const primaryRow = buildFamilySweepPrimaryRow(
            targetArtifact,
            reducedArtifacts,
            basePrimaryRow.row.rule,
            basePrimaryRow.source,
            activeRule
        );

        rows.push({
            familyKey,
            familyLabel: familyArtifacts[0]?.familyLabel ?? familyKey,
            configNames: familyArtifacts.map((artifact) => artifact.config.name),
            currentVote: resolveCurrentVoteLabel(currentContextReference, familyArtifacts),
            voteProfile: buildVoteProfile(targetArtifact, familyArtifacts),
            primaryRow,
            deltaExpectancy: primaryRow.row.expectancy - basePrimaryRow.row.expectancy,
            deltaWinRate: primaryRow.row.winRate - basePrimaryRow.row.winRate,
            tradeRetentionPercent: basePrimaryRow.row.trades > 0
                ? (primaryRow.row.trades / basePrimaryRow.row.trades) * 100
                : 0,
            deltaTrades: primaryRow.row.trades - basePrimaryRow.row.trades,
        });
        await runtime.yieldToUi();
    }

    return rows.sort((left, right) =>
        compareFamilyDeltaRows(left, right, (row) => row.deltaExpectancy, (row) => row.deltaWinRate)
    );
}

export async function buildReplacementRows(
    targetArtifact: ConfigRunArtifact,
    contextArtifacts: ConfigRunArtifact[],
    baseScenario: EnsembleScenarioEvaluation,
    contributionRows: EnsembleContributionRow[],
    currentContextReference: CurrentContextReference,
    candidateArtifacts: ConfigSignalArtifact[],
    runtime: Pick<StrategyEnsembleRulesRuntime, "yieldToUi" | "updateStatus" | "maxReplacementRows">
): Promise<EnsembleReplacementRow[]> {
    const basePrimaryRow = resolveScenarioPrimaryRow(baseScenario.builderRows);
    if (!basePrimaryRow) {
        return [];
    }

    const activeRule = baseScenario.analysisRule?.rule ?? null;
    const worstContributor = contributionRows.find((row) => row.deltaExpectancy > 0) ?? null;
    const replacementBaseArtifacts = worstContributor
        ? contextArtifacts.filter((artifact) => artifact.familyKey !== worstContributor.familyKey)
        : contextArtifacts;
    const replacementBasePrimaryRow = buildFamilySweepPrimaryRow(
        targetArtifact,
        replacementBaseArtifacts,
        basePrimaryRow.row.rule,
        basePrimaryRow.source,
        activeRule
    );

    const replacementBaseFamilyKeys = new Set(contextArtifacts.map((artifact) => artifact.familyKey));
    const groupedCandidates = groupArtifactsByFamily(
        candidateArtifacts.filter((artifact) => !replacementBaseFamilyKeys.has(artifact.familyKey))
    );
    const familyBestRows = new Map<string, EnsembleReplacementRow>();
    const entries = Array.from(groupedCandidates.entries());

    for (let index = 0; index < entries.length; index += 1) {
        const [familyKey, artifactsInFamily] = entries[index];
        const familyLabel = artifactsInFamily[0]?.familyLabel ?? familyKey;
        runtime.updateStatus?.(`Ranking replacement family ${index + 1}/${entries.length}: ${familyLabel}...`);

        for (const candidateArtifact of artifactsInFamily) {
            const candidateContextArtifacts = [...replacementBaseArtifacts, candidateArtifact];
            const primaryRow = buildFamilySweepPrimaryRow(
                targetArtifact,
                candidateContextArtifacts,
                basePrimaryRow.row.rule,
                basePrimaryRow.source,
                activeRule
            );

            const row: EnsembleReplacementRow = {
                familyKey,
                familyLabel,
                configName: candidateArtifact.config.name,
                currentVote: resolveCurrentVoteLabel(currentContextReference, [candidateArtifact]),
                primaryRow,
                deltaExpectancyVsRemoved: primaryRow.row.expectancy - replacementBasePrimaryRow.row.expectancy,
                deltaExpectancyVsCurrent: primaryRow.row.expectancy - basePrimaryRow.row.expectancy,
                deltaWinRateVsCurrent: primaryRow.row.winRate - basePrimaryRow.row.winRate,
                tradeRetentionPercent: basePrimaryRow.row.trades > 0
                    ? (primaryRow.row.trades / basePrimaryRow.row.trades) * 100
                    : 0,
                deltaTradesVsCurrent: primaryRow.row.trades - basePrimaryRow.row.trades,
            };

            const bestExisting = familyBestRows.get(familyKey);
            if (!bestExisting) {
                familyBestRows.set(familyKey, row);
                continue;
            }

            if (row.deltaExpectancyVsRemoved !== bestExisting.deltaExpectancyVsRemoved) {
                if (row.deltaExpectancyVsRemoved > bestExisting.deltaExpectancyVsRemoved) {
                    familyBestRows.set(familyKey, row);
                }
                continue;
            }

            if (row.deltaWinRateVsCurrent > bestExisting.deltaWinRateVsCurrent) {
                familyBestRows.set(familyKey, row);
            }
        }
        await runtime.yieldToUi();
    }

    return Array.from(familyBestRows.values())
        .sort((left, right) =>
            compareFamilyDeltaRows(left, right, (row) => row.deltaExpectancyVsRemoved, (row) => row.deltaWinRateVsCurrent)
        )
        .slice(0, runtime.maxReplacementRows ?? DEFAULT_MAX_REPLACEMENT_ROWS);
}

export function buildResultRow(
    ruleId: string,
    rule: string,
    result: ConfigRunArtifact["result"],
    signals: Signal[],
    engineUsed: "rust" | "typescript",
    selectionMode: EnsembleBuilderRow["selectionMode"]
): EnsembleBuilderRow {
    return {
        ruleId,
        rule,
        signals: signals.length,
        trades: result.totalTrades,
        winRate: result.winRate,
        netProfitPercent: result.netProfitPercent,
        expectancy: result.expectancy,
        profitFactor: result.profitFactor,
        maxDrawdownPercent: result.maxDrawdownPercent,
        engineUsed,
        selectionMode,
    };
}
