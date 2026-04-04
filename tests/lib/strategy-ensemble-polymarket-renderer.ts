import { setVisible } from "./dom-utils";
import type { EnsembleLabDom } from "./strategy-ensemble-dom";
import type {
    EnsemblePolymarketConfigResult,
    EnsemblePolymarketConflictPolicy,
    EnsemblePolymarketDirectionSlice,
    EnsemblePolymarketOverridePairResult,
    EnsemblePolymarketRunResult,
    EnsemblePolymarketVetoPairResult,
    EnsemblePolymarketVerdict,
} from "./strategy-ensemble-polymarket-engine";
import { escapeHtml } from "./strategy-ensemble-renderer";

const EMPTY_TABLE_ROW = `
    <tr>
        <td colspan="14" style="text-align:center;color:var(--text-secondary);padding:16px;">
            Run Ensemble Polymarket to compare executable config edge against Polymarket outcomes.
        </td>
    </tr>
`;

const EMPTY_VETO_TABLE_ROW = `
    <tr>
        <td colspan="14" style="text-align:center;color:var(--text-secondary);padding:16px;">
            Run Ensemble Polymarket to rank asymmetric veto pairs.
        </td>
    </tr>
`;

const EMPTY_OVERRIDE_TABLE_ROW = `
    <tr>
        <td colspan="14" style="text-align:center;color:var(--text-secondary);padding:16px;">
            Run Ensemble Polymarket to rank secondary-override pairs.
        </td>
    </tr>
`;

export function renderEnsemblePolymarketResults(
    dom: EnsembleLabDom,
    result: EnsemblePolymarketRunResult
): void {
    dom.ensemblePolymarketSection.style.display = "";
    setVisible(dom.ensemblePolymarketEmpty, false);

    const selectedPolicyResult = result.selectedPolicyResult;
    const showMajorityVote = result.ensembleSummary.configsScored > 2;
    const executableConflict = result.conflictExecutableOverlay ?? null;
    const conflictFilteredConflictRate = result.conflictFilteredOverlay.evaluatedEvents > 0
        ? result.conflictFilteredOverlay.mixedDirectionEvents / result.conflictFilteredOverlay.evaluatedEvents
        : 0;
    const overlapWithSignalRate = result.conflictFilteredOverlay.evaluatedEvents > 0
        ? result.conflictFilteredOverlay.eventsWithVotes / result.conflictFilteredOverlay.evaluatedEvents
        : 0;
    const skipConflictReplayLabel = result.selectedPolicy === "skip_conflicts"
        ? "Selected Policy Replay WR"
        : "Skip-Conflicts WR";
    const skipConflictInsightLabel = result.selectedPolicy === "skip_conflicts"
        ? "Selected Policy Replay"
        : "Skip-Conflicts Replay Reference";

    const summaryCards = [
        card("Selected Policy", describeConflictPolicy(result.selectedPolicy)),
        card("Direction Slice", describeDirectionSlice(result.directionSlice)),
        card("Policy Win Rate", selectedPolicyResult ? formatPercent(selectedPolicyResult.winRate) : "-"),
        card("Policy Exp / Trade", formatPolymarketExpectancy(selectedPolicyResult?.expectancy, selectedPolicyResult?.pricedTrades)),
        card("Policy Backtest Trades", selectedPolicyResult ? String(selectedPolicyResult.totalTrades) : "-"),
        card("Policy Scored Trades", selectedPolicyResult ? String(selectedPolicyResult.scoredTrades) : "-"),
        card("Policy Wilson LB", selectedPolicyResult ? selectedPolicyResult.wilsonLowerBound.toFixed(3) : "-"),
        card("Policy Δ vs Baseline", selectedPolicyResult ? formatSignedPercent(selectedPolicyResult.deltaVsBaseline) : "-"),
        card(
            "Policy Retention",
            selectedPolicyResult?.retentionRate != null ? formatPercent(selectedPolicyResult.retentionRate) : "-"
        ),
        card("Configs Scored", String(result.ensembleSummary.configsScored)),
        card("Total Scored Trades", String(result.ensembleSummary.totalScoredTrades)),
        card("Event-Level Conflict WR", formatPercent(result.conflictFilteredOverlay.winRate)),
        card(skipConflictReplayLabel, executableConflict ? formatPercent(executableConflict.winRate) : "-"),
        card("Conflict Rate", formatPercent(conflictFilteredConflictRate)),
        card("No-Signal Rate", formatPercent(result.conflictFilteredOverlay.noSignalRate)),
        card("Overlap With Signal", formatPercent(overlapWithSignalRate)),
        card(
            "Best Config",
            `${formatPercent(result.ensembleSummary.bestConfigWinRate)} (${result.ensembleSummary.bestConfigName})`
        ),
        card("Best Baseline", formatPercent(result.ensembleSummary.bestBaseline)),
    ];

    if (showMajorityVote) {
        summaryCards.push(card("Majority Vote WR", formatPercent(result.majorityVoteOverlay.winRate)));
    }

    dom.ensemblePolymarketSummary.innerHTML = summaryCards.join("");

    const agreementInsights = [
        selectedPolicyResult
            ? insight(
                "Selected Policy",
                `${selectedPolicyResult.label}: ${selectedPolicyResult.description} It produced ${formatTradeVsScoreSummary(selectedPolicyResult.totalTrades, selectedPolicyResult.scoredTrades)}, ${selectedPolicyResult.wins} wins, ${selectedPolicyResult.losses} losses, ${formatPercent(selectedPolicyResult.winRate)} win rate, ${formatPolymarketExpectancy(selectedPolicyResult.expectancy, selectedPolicyResult.pricedTrades)} expectancy, Wilson ${selectedPolicyResult.wilsonLowerBound.toFixed(3)}, and ${formatSignedPercent(selectedPolicyResult.deltaVsBaseline)} versus the baseline.`
            )
            : insight(
                "Selected Policy",
                `No executable result is available for ${describeConflictPolicy(result.selectedPolicy)} on the current ${describeDirectionSlice(result.directionSlice)} slice. Try another policy or widen the context set.`
            ),
        insight(
            "Direction Slice",
            result.directionSlice === "all"
                ? "Both long and short trades are included in this run."
                : `Only ${describeDirectionSlice(result.directionSlice).toLowerCase()} trades are included in this run. This helps expose configs that only carry edge on one side.`
        ),
        insight(
            "Conflict Overlay",
            `${result.conflictFilteredOverlay.scoredEvents} scored overlay events, ${result.conflictFilteredOverlay.wins} wins, ${result.conflictFilteredOverlay.losses} losses, ${formatPercent(result.conflictFilteredOverlay.winRate)} win rate, ${formatPercent(result.conflictFilteredOverlay.coverage)} coverage, and ${result.conflictFilteredOverlay.mixedDirectionEvents} mixed-direction conflicts skipped before execution.`
        ),
        insight(
            skipConflictInsightLabel,
            executableConflict
                ? result.selectedPolicy === "skip_conflicts"
                    ? `${executableConflict.totalTrades} executed trades, ${formatPercent(executableConflict.winRate)} win rate, ${formatPercent(executableConflict.retentionRate)} retention from event-level conflict signals, and ${executableConflict.skippedByExecution} overlay signals lost in execution.`
                    : `${executableConflict.totalTrades} executed trades, ${formatPercent(executableConflict.winRate)} win rate, ${formatPercent(executableConflict.retentionRate)} retention from event-level conflict signals, and ${executableConflict.skippedByExecution} overlay signals lost in execution. This remains the skip-conflicts reference, not the selected ${describeConflictPolicy(result.selectedPolicy).toLowerCase()} replay.`
                : "Executable conflict replay metrics are unavailable for this run."
        ),
    ];

    if (showMajorityVote) {
        agreementInsights.push(insight(
            "Majority Vote Overlay",
            `${result.majorityVoteOverlay.scoredEvents} scored events, ${result.majorityVoteOverlay.wins} wins, ${result.majorityVoteOverlay.losses} losses, and ${formatPercent(result.majorityVoteOverlay.winRate)} win rate.`
        ));
    } else {
        agreementInsights.push(insight(
            "Two-Config Note",
            "With exactly 2 scored configs, majority vote adds no information because every disagreement becomes a tie."
        ));
    }

    if (result.policyResults.bestSideOwner) {
        const policy = result.policyResults.bestSideOwner;
        const ownerLabel = [
            policy.longOwnerConfigName ? `long ${policy.longOwnerConfigName}` : "",
            policy.shortOwnerConfigName ? `short ${policy.shortOwnerConfigName}` : "",
        ].filter((part) => part.length > 0).join(" + ");
        agreementInsights.push(insight(
            "Best-Side Owner",
            `${ownerLabel || "No owner pair"} produced ${policy.scoredTrades} scored trades at ${formatPercent(policy.winRate)} win rate, ${formatPolymarketExpectancy(policy.expectancy, policy.pricedTrades)} expectancy, and ${formatSignedPercent(policy.deltaVsBaseline)} versus the baseline.`
        ));
    }

    if (result.vetoScan.bestPair) {
        agreementInsights.push(insight(
            "Best Veto Pair",
            `${result.vetoScan.bestPair.primaryConfigName} improved to ${formatPercent(result.vetoScan.bestPair.postVetoWinRate)} when ${result.vetoScan.bestPair.vetoConfigName} vetoed opposite-side events, leaving ${result.vetoScan.bestPair.keptEvents} kept trades, ${formatPolymarketExpectancy(result.vetoScan.bestPair.expectancy, result.vetoScan.bestPair.pricedTrades)} expectancy, and ${formatSignedPercent(result.vetoScan.bestPair.winRateLift)} win-rate lift.`
        ));
    }

    if (result.overrideScan.bestPair) {
        agreementInsights.push(insight(
            "Best Override Pair",
            `${result.overrideScan.bestPair.primaryConfigName} improved to ${formatPercent(result.overrideScan.bestPair.postOverrideWinRate)} when ${result.overrideScan.bestPair.secondaryConfigName} overrode opposite-side conflicts, leaving ${result.overrideScan.bestPair.keptEvents} kept trades, ${formatPolymarketExpectancy(result.overrideScan.bestPair.expectancy, result.overrideScan.bestPair.pricedTrades)} expectancy, and ${formatSignedPercent(result.overrideScan.bestPair.winRateLift)} win-rate lift.`
        ));
    }

    dom.ensemblePolymarketAgreement.innerHTML = agreementInsights.join("") + renderSelectedActionBar(result);

    dom.ensemblePolymarketTableBody.innerHTML = result.configResults.length > 0
        ? result.configResults.map((configResult) => renderConfigRow(configResult)).join("")
        : EMPTY_TABLE_ROW;

    const bestVetoPair = result.vetoScan.bestPair;
    dom.ensemblePolymarketVetoSummary.innerHTML = bestVetoPair
        ? [
            card("Best Veto Pair", `${bestVetoPair.primaryConfigName} -> ${bestVetoPair.vetoConfigName}`),
            card("Best Kept Trades", String(bestVetoPair.keptEvents)),
            card("Best Wins", String(bestVetoPair.keptWins)),
            card("Best Losses", String(bestVetoPair.keptLosses)),
            card("Best Post-Veto WR", formatPercent(bestVetoPair.postVetoWinRate)),
            card("Best Exp / Trade", formatPolymarketExpectancy(bestVetoPair.expectancy, bestVetoPair.pricedTrades)),
            card("Best WR Lift", formatSignedPercent(bestVetoPair.winRateLift)),
            card("Best Retention", formatPercent(bestVetoPair.retentionRate)),
            card("Positive Pairs", String(result.vetoScan.positivePairCount)),
        ].join("")
        : "";

    dom.ensemblePolymarketVetoTableBody.innerHTML = result.vetoScan.pairResults.length > 0
        ? result.vetoScan.pairResults.map((pairResult) => renderVetoPairRow(pairResult)).join("")
        : EMPTY_VETO_TABLE_ROW;

    const bestOverridePair = result.overrideScan.bestPair;
    dom.ensemblePolymarketOverrideSummary.innerHTML = bestOverridePair
        ? [
            card("Best Override Pair", `${bestOverridePair.primaryConfigName} -> ${bestOverridePair.secondaryConfigName}`),
            card("Best Kept Trades", String(bestOverridePair.keptEvents)),
            card("Best Wins", String(bestOverridePair.keptWins)),
            card("Best Losses", String(bestOverridePair.keptLosses)),
            card("Best Post-Override WR", formatPercent(bestOverridePair.postOverrideWinRate)),
            card("Best Exp / Trade", formatPolymarketExpectancy(bestOverridePair.expectancy, bestOverridePair.pricedTrades)),
            card("Best WR Lift", formatSignedPercent(bestOverridePair.winRateLift)),
            card("Best Retention", formatPercent(bestOverridePair.retentionRate)),
            card("Positive Pairs", String(result.overrideScan.positivePairCount)),
        ].join("")
        : "";

    dom.ensemblePolymarketOverrideTableBody.innerHTML = result.overrideScan.pairResults.length > 0
        ? result.overrideScan.pairResults.map((pairResult) => renderOverridePairRow(pairResult)).join("")
        : EMPTY_OVERRIDE_TABLE_ROW;
}

export function resetEnsemblePolymarketPanel(dom: EnsembleLabDom): void {
    dom.ensemblePolymarketSection.style.display = "";
    setVisible(dom.ensemblePolymarketEmpty, false);
    dom.ensemblePolymarketStatus.textContent = "Run Ensemble Polymarket to compare executable config edge, policy recipes, veto pairs, and override pairs against matched 5m Polymarket outcomes.";
    dom.ensemblePolymarketSummary.innerHTML = "";
    dom.ensemblePolymarketAgreement.innerHTML = "";
    dom.ensemblePolymarketTableBody.innerHTML = EMPTY_TABLE_ROW;
    dom.ensemblePolymarketVetoSummary.innerHTML = "";
    dom.ensemblePolymarketVetoTableBody.innerHTML = EMPTY_VETO_TABLE_ROW;
    dom.ensemblePolymarketOverrideSummary.innerHTML = "";
    dom.ensemblePolymarketOverrideTableBody.innerHTML = EMPTY_OVERRIDE_TABLE_ROW;
}

function renderConfigRow(result: EnsemblePolymarketConfigResult): string {
    const scoredLongPredictions = result.evalResult.rows.filter((row) => row.prediction === "yes").length;
    const scoredShortPredictions = result.evalResult.rows.filter((row) => row.prediction === "no").length;
    const verdictClass = `ensemble-lab__polymarket-verdict ensemble-lab__polymarket-verdict--${result.verdict}`;
    const rowStyle = result.verdict === "edge"
        ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
        : result.verdict === "marginal"
            ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.08));"'
            : result.verdict === "no_edge"
                ? ' style="background:var(--bg-danger-subtle,rgba(220,80,80,0.08));"'
                : "";

    return `
        <tr${rowStyle}>
            <td>${escapeHtml(result.configName)}</td>
            <td>${escapeHtml(result.familyLabel)}</td>
            <td>${result.evalResult.scoredPredictions}</td>
            <td>${result.evalResult.wins}</td>
            <td>${result.evalResult.losses}</td>
            <td>${formatPercent(result.evalResult.winRate)}</td>
            <td>${formatPolymarketExpectancy(result.evalResult.expectancy, result.evalResult.pricedPredictions)}</td>
            <td>${formatPercent(result.evalResult.coverage)}</td>
            <td>${result.wilsonLowerBound.toFixed(3)}</td>
            <td>${formatOptionalPercent(result.evalResult.longWinRate, scoredLongPredictions)}</td>
            <td>${formatOptionalPercent(result.evalResult.shortWinRate, scoredShortPredictions)}</td>
            <td>${formatSignedPercent(result.deltaVsBestBaseline)}</td>
            <td><span class="${verdictClass}">${escapeHtml(formatVerdictLabel(result.verdict))}</span></td>
            <td><button class="btn btn-secondary btn-compact" type="button" data-ensemble-polymarket-config-backtest="${escapeHtml(result.configName)}">View Backtest</button></td>
        </tr>
    `;
}

function renderVetoPairRow(result: EnsemblePolymarketVetoPairResult): string {
    return renderPairRow({
        primaryConfigName: result.primaryConfigName,
        primaryFamilyLabel: result.primaryFamilyLabel,
        secondaryConfigName: result.vetoConfigName,
        secondaryFamilyLabel: result.vetoFamilyLabel,
        keptEvents: result.keptEvents,
        keptWins: result.keptWins,
        keptLosses: result.keptLosses,
        expectancy: result.expectancy,
        pricedTrades: result.pricedTrades,
        changedEvents: result.vetoedEvents,
        retentionRate: result.retentionRate,
        overlapRate: result.overlapRate,
        postWinRate: result.postVetoWinRate,
        winRateLift: result.winRateLift,
        wilsonLift: result.wilsonLift,
        verdict: result.verdict,
        actionDataset: `data-ensemble-polymarket-veto-backtest="${escapeHtml(result.primaryConfigName)}" data-ensemble-polymarket-veto-config="${escapeHtml(result.vetoConfigName)}"`,
    });
}

function renderOverridePairRow(result: EnsemblePolymarketOverridePairResult): string {
    return renderPairRow({
        primaryConfigName: result.primaryConfigName,
        primaryFamilyLabel: result.primaryFamilyLabel,
        secondaryConfigName: result.secondaryConfigName,
        secondaryFamilyLabel: result.secondaryFamilyLabel,
        keptEvents: result.keptEvents,
        keptWins: result.keptWins,
        keptLosses: result.keptLosses,
        expectancy: result.expectancy,
        pricedTrades: result.pricedTrades,
        changedEvents: result.overriddenEvents,
        retentionRate: result.retentionRate,
        overlapRate: result.overlapRate,
        postWinRate: result.postOverrideWinRate,
        winRateLift: result.winRateLift,
        wilsonLift: result.wilsonLift,
        verdict: result.verdict,
        actionDataset: `data-ensemble-polymarket-override-backtest="${escapeHtml(result.primaryConfigName)}" data-ensemble-polymarket-secondary-config="${escapeHtml(result.secondaryConfigName)}"`,
    });
}

function renderPairRow(args: {
    primaryConfigName: string;
    primaryFamilyLabel: string;
    secondaryConfigName: string;
    secondaryFamilyLabel: string;
    keptEvents: number;
    keptWins: number;
    keptLosses: number;
    expectancy: number | null;
    pricedTrades: number;
    changedEvents: number;
    retentionRate: number;
    overlapRate: number;
    postWinRate: number;
    winRateLift: number;
    wilsonLift: number;
    verdict: EnsemblePolymarketVetoPairResult["verdict"];
    actionDataset: string;
}): string {
    const verdictClass = `ensemble-lab__polymarket-verdict ${formatVetoVerdictClass(args.verdict)}`;
    const rowStyle = args.verdict === "interesting"
        ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
        : args.verdict === "marginal"
            ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.08));"'
            : args.verdict === "neutral"
                ? ' style="background:var(--bg-danger-subtle,rgba(220,80,80,0.08));"'
                : "";

    return `
        <tr${rowStyle}>
            <td>${escapeHtml(args.primaryConfigName)}<br><span class="ensemble-lab__config-strategy">${escapeHtml(args.primaryFamilyLabel)}</span></td>
            <td>${escapeHtml(args.secondaryConfigName)}<br><span class="ensemble-lab__config-strategy">${escapeHtml(args.secondaryFamilyLabel)}</span></td>
            <td>${args.keptEvents}</td>
            <td>${args.keptWins}</td>
            <td>${args.keptLosses}</td>
            <td>${formatPolymarketExpectancy(args.expectancy, args.pricedTrades)}</td>
            <td>${args.changedEvents}</td>
            <td>${formatPercent(args.retentionRate)}</td>
            <td>${formatPercent(args.overlapRate)}</td>
            <td>${formatPercent(args.postWinRate)}</td>
            <td>${formatSignedPercent(args.winRateLift)}</td>
            <td>${formatSignedFixed(args.wilsonLift)}</td>
            <td><span class="${verdictClass}">${escapeHtml(formatVetoVerdictLabel(args.verdict))}</span></td>
            <td><button class="btn btn-secondary btn-compact" type="button" ${args.actionDataset}>View Backtest</button></td>
        </tr>
    `;
}

function renderSelectedActionBar(result: EnsemblePolymarketRunResult): string {
    const buttons: string[] = [];

    if (result.selectedPolicyResult) {
        buttons.push(
            '<button class="btn btn-secondary btn-compact" type="button" data-ensemble-polymarket-selected-policy-backtest="true">View Selected Policy Backtest</button>'
        );
    }

    if (result.vetoScan.bestPair) {
        buttons.push(
            '<button class="btn btn-secondary btn-compact" type="button" data-ensemble-polymarket-best-veto-backtest="true">View Best Veto Backtest</button>'
        );
    }

    return buttons.length > 0
        ? `<div class="finder-strategy-actions ensemble-lab__actions" role="group" aria-label="Selected Polymarket replay actions">${buttons.join("")}</div>`
        : "";
}

function card(label: string, value: string): string {
    return `
        <div class="sim-card">
            <div class="sim-card-label">${escapeHtml(label)}</div>
            <div class="sim-card-value">${escapeHtml(value)}</div>
        </div>
    `;
}

function insight(label: string, detail: string): string {
    return `<div class="portfolio-lab__insight"><strong>${escapeHtml(label)}</strong>: ${escapeHtml(detail)}</div>`;
}

function formatPercent(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatOptionalPercent(value: number, sampleCount: number): string {
    return sampleCount > 0 ? formatPercent(value) : "-";
}

function formatSignedPercent(value: number): string {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${Math.abs(value * 100).toFixed(1)}%`;
}

function formatSignedFixed(value: number): string {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${Math.abs(value).toFixed(3)}`;
}

function formatTradeVsScoreSummary(totalTrades: number, scoredTrades: number): string {
    if (totalTrades === scoredTrades) {
        return `${scoredTrades} scored trades`;
    }

    return `${totalTrades} executed backtest trades with ${scoredTrades} scored against Polymarket outcomes`;
}

function formatPolymarketExpectancy(value: number | null | undefined, pricedTrades: number | null | undefined): string {
    if (!Number.isFinite(value as number) || (pricedTrades ?? 0) <= 0) {
        return "-";
    }

    const expectancy = value as number;
    const sign = expectancy > 0 ? "+" : expectancy < 0 ? "-" : "";
    return `${sign}${(Math.abs(expectancy) * 100).toFixed(1)}c`;
}

function describeConflictPolicy(policy: EnsemblePolymarketConflictPolicy): string {
    switch (policy) {
        case "primary_veto":
            return "Primary + Secondary Veto";
        case "secondary_override":
            return "Secondary Override";
        case "best_side_owner":
            return "Best-Side Owner";
        case "skip_conflicts":
        default:
            return "Skip Conflicts";
    }
}

function describeDirectionSlice(directionSlice: EnsemblePolymarketDirectionSlice): string {
    switch (directionSlice) {
        case "long_only":
            return "Long Only";
        case "short_only":
            return "Short Only";
        case "all":
        default:
            return "All";
    }
}

function formatVerdictLabel(verdict: EnsemblePolymarketVerdict): string {
    if (verdict === "no_edge") {
        return "No Edge";
    }

    if (verdict === "insufficient") {
        return "Insufficient";
    }

    return verdict.charAt(0).toUpperCase() + verdict.slice(1);
}

function formatVetoVerdictLabel(verdict: EnsemblePolymarketVetoPairResult["verdict"]): string {
    if (verdict === "neutral") {
        return "Neutral";
    }

    if (verdict === "insufficient") {
        return "Insufficient";
    }

    return verdict.charAt(0).toUpperCase() + verdict.slice(1);
}

function formatVetoVerdictClass(verdict: EnsemblePolymarketVetoPairResult["verdict"]): string {
    switch (verdict) {
        case "interesting":
            return "ensemble-lab__polymarket-verdict--edge";
        case "marginal":
            return "ensemble-lab__polymarket-verdict--marginal";
        case "neutral":
            return "ensemble-lab__polymarket-verdict--no_edge";
        default:
            return "ensemble-lab__polymarket-verdict--insufficient";
    }
}
