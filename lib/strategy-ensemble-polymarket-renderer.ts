import { setVisible } from "./dom-utils";
import type { EnsembleLabDom } from "./strategy-ensemble-dom";
import type {
    EnsemblePolymarketConfigResult,
    EnsemblePolymarketRunResult,
    EnsemblePolymarketVetoPairResult,
    EnsemblePolymarketVerdict,
} from "./strategy-ensemble-polymarket-engine";
import { escapeHtml } from "./strategy-ensemble-renderer";

const EMPTY_TABLE_ROW = `
    <tr>
        <td colspan="12" style="text-align:center;color:var(--text-secondary);padding:16px;">
            Run Ensemble Polymarket to compare individual config edge and the majority-vote overlay against Polymarket outcomes.
        </td>
    </tr>
`;

const EMPTY_VETO_TABLE_ROW = `
    <tr>
        <td colspan="12" style="text-align:center;color:var(--text-secondary);padding:16px;">
            Run Ensemble Polymarket to rank asymmetric veto pairs.
        </td>
    </tr>
`;

export function renderEnsemblePolymarketResults(
    dom: EnsembleLabDom,
    result: EnsemblePolymarketRunResult
): void {
    dom.ensemblePolymarketSection.style.display = "";
    setVisible(dom.ensemblePolymarketEmpty, false);
    const showMajorityVote = result.ensembleSummary.configsScored > 2;
    const executableConflict = result.conflictExecutableOverlay ?? null;
    const conflictFilteredConflictRate = result.conflictFilteredOverlay.evaluatedEvents > 0
        ? result.conflictFilteredOverlay.mixedDirectionEvents / result.conflictFilteredOverlay.evaluatedEvents
        : 0;
    const overlapWithSignalRate = result.conflictFilteredOverlay.evaluatedEvents > 0
        ? result.conflictFilteredOverlay.eventsWithVotes / result.conflictFilteredOverlay.evaluatedEvents
        : 0;

    const summaryCards = [
        card("Configs Scored", String(result.ensembleSummary.configsScored)),
        card("Total Scored Trades", String(result.ensembleSummary.totalScoredTrades)),
        card("Event-Level Conflict WR", formatPercent(result.conflictFilteredOverlay.winRate)),
        card("Executable Conflict WR", executableConflict ? formatPercent(executableConflict.winRate) : "-"),
        card("Executable Conflict Trades", executableConflict ? String(executableConflict.totalTrades) : "-"),
        card("Executable Retention", executableConflict ? formatPercent(executableConflict.retentionRate) : "-"),
        card("Aligned-Signal Coverage", formatPercent(result.conflictFilteredOverlay.coverage)),
        card("Overlap With Signal", formatPercent(overlapWithSignalRate)),
        card("Conflict Rate", formatPercent(conflictFilteredConflictRate)),
        card("No-Signal Rate", formatPercent(result.conflictFilteredOverlay.noSignalRate)),
        card("Pooled Config Win Rate", formatPercent(result.ensembleSummary.ensembleWinRate)),
        card(
            "Best Config Win Rate",
            `${formatPercent(result.ensembleSummary.bestConfigWinRate)} (${result.ensembleSummary.bestConfigName})`
        ),
        card("Always YES Baseline", formatPercent(result.ensembleSummary.alwaysYesBaseline)),
        card("Always NO Baseline", formatPercent(result.ensembleSummary.alwaysNoBaseline)),
        card("Best Baseline", formatPercent(result.ensembleSummary.bestBaseline)),
        card(
            "Pooled Delta vs Best Baseline",
            formatSignedPercent(result.ensembleSummary.ensembleDeltaVsBestBaseline)
        ),
    ];

    if (showMajorityVote) {
        summaryCards.splice(6, 0, card("Majority Vote Win Rate", formatPercent(result.majorityVoteOverlay.winRate)));
    }

    dom.ensemblePolymarketSummary.innerHTML = summaryCards.join("");

    const agreementInsights = [
        insight(
            "Event-Level Conflict Overlay",
            `${result.conflictFilteredOverlay.scoredEvents} scored events, ${result.conflictFilteredOverlay.wins} wins, ${result.conflictFilteredOverlay.losses} losses, ${formatPercent(result.conflictFilteredOverlay.winRate)} win rate. This is the pre-execution signal-quality read for "skip mixed-direction conflicts".`
        ),
        insight(
            "Executable Conflict Backtest",
            executableConflict
                ? `${executableConflict.totalTrades} executed trades, ${executableConflict.wins} wins, ${executableConflict.losses} losses, ${formatPercent(executableConflict.winRate)} win rate. This is the tradable backtest result after execution rules are applied to the conflict-filtered overlay.`
                : "Executable conflict backtest metrics are unavailable for this run."
        ),
        insight(
            "Execution Gap",
            executableConflict
                ? `${executableConflict.skippedByExecution} event-level overlay signals did not become scored executable trades, leaving ${formatPercent(executableConflict.retentionRate)} executable retention and ${formatPercent(executableConflict.coverage)} evaluated-event coverage after execution.`
                : "Executable retention is unavailable for this run."
        ),
        insight(
            "Conflict Skips",
            `${result.conflictFilteredOverlay.mixedDirectionEvents} mixed-direction events were skipped because selected configs disagreed. ${result.conflictFilteredOverlay.noSignalEvents} additional evaluated events had no overlay signal from the selected configs, leaving ${formatPercent(result.conflictFilteredOverlay.coverage)} coverage.`
        ),
        insight(
            "Vote Shape",
            `${result.conflictFilteredOverlay.unanimousEvents} unanimous one-side events, ${result.conflictFilteredOverlay.mixedDirectionEvents} mixed-direction events, ${result.majorityVoteOverlay.conflictedEvents} tied-majority skips.`
        ),
        insight(
            "Interpretation",
            `If the question is "short config X plus long config Y, but ignore trades when they conflict", compare Event-Level Conflict WR with Executable Conflict WR. The first measures signal quality, the second measures the actual tradable backtest after execution rules. Pooled Config Win Rate is not a tradable ensemble rule.`
        ),
    ];

    if (showMajorityVote) {
        agreementInsights.splice(2, 0, insight(
            "Majority Vote Overlay",
            `${result.majorityVoteOverlay.scoredEvents} scored events, ${result.majorityVoteOverlay.wins} wins, ${result.majorityVoteOverlay.losses} losses, ${formatPercent(result.majorityVoteOverlay.winRate)} win rate. This variant still scores non-tied mixed votes.`
        ));
    } else {
        agreementInsights.splice(2, 0, insight(
            "Two-Config Note",
            "With exactly 2 scored configs, majority vote adds no information because every disagreement is a tie. Read the conflict-filtered overlay as the practical ensemble result."
        ));
    }

    if (result.vetoScan.bestPair) {
        agreementInsights.push(insight(
            "Best Veto Pair",
            `${result.vetoScan.bestPair.primaryConfigName} improved to ${formatPercent(result.vetoScan.bestPair.postVetoWinRate)} when ${result.vetoScan.bestPair.vetoConfigName} vetoed opposite-side events, leaving ${result.vetoScan.bestPair.keptEvents} kept trades, ${result.vetoScan.bestPair.keptWins} wins, ${result.vetoScan.bestPair.keptLosses} losses, ${formatPercent(result.vetoScan.bestPair.retentionRate)} retention, and ${formatSignedPercent(result.vetoScan.bestPair.winRateLift)} win-rate lift.`
        ));
    }

    dom.ensemblePolymarketAgreement.innerHTML = agreementInsights.join("");

    dom.ensemblePolymarketTableBody.innerHTML = result.configResults.length > 0
        ? result.configResults
            .map((configResult) => renderConfigRow(configResult))
            .join("")
        : EMPTY_TABLE_ROW;

    const bestVetoPair = result.vetoScan.bestPair;
    dom.ensemblePolymarketVetoSummary.innerHTML = bestVetoPair
        ? [
            card("Best Veto Pair", `${bestVetoPair.primaryConfigName} -> ${bestVetoPair.vetoConfigName}`),
            card("Best Kept Trades", String(bestVetoPair.keptEvents)),
            card("Best Wins", String(bestVetoPair.keptWins)),
            card("Best Losses", String(bestVetoPair.keptLosses)),
            card("Best Post-Veto WR", formatPercent(bestVetoPair.postVetoWinRate)),
            card("Best WR Lift", formatSignedPercent(bestVetoPair.winRateLift)),
            card("Best Retention", formatPercent(bestVetoPair.retentionRate)),
            card("Positive Pairs", String(result.vetoScan.positivePairCount)),
        ].join("")
        : "";

    dom.ensemblePolymarketVetoTableBody.innerHTML = result.vetoScan.pairResults.length > 0
        ? result.vetoScan.pairResults.map((pairResult) => renderVetoPairRow(pairResult)).join("")
        : EMPTY_VETO_TABLE_ROW;
}

export function resetEnsemblePolymarketPanel(dom: EnsembleLabDom): void {
    dom.ensemblePolymarketSection.style.display = "";
    setVisible(dom.ensemblePolymarketEmpty, false);
    dom.ensemblePolymarketStatus.textContent = "Run Ensemble Polymarket to compare individual config edge, event-level conflict overlay quality, executable conflict backtest quality, aligned-signal coverage, true mixed-direction conflict skips, no-signal gaps, the majority-vote overlay, and asymmetric veto pairs against matched 5m Polymarket outcomes.";
    dom.ensemblePolymarketSummary.innerHTML = "";
    dom.ensemblePolymarketAgreement.innerHTML = "";
    dom.ensemblePolymarketTableBody.innerHTML = EMPTY_TABLE_ROW;
    dom.ensemblePolymarketVetoSummary.innerHTML = "";
    dom.ensemblePolymarketVetoTableBody.innerHTML = EMPTY_VETO_TABLE_ROW;
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
            <td>${formatPercent(result.evalResult.coverage)}</td>
            <td>${result.wilsonLowerBound.toFixed(3)}</td>
            <td>${formatOptionalPercent(result.evalResult.longWinRate, scoredLongPredictions)}</td>
            <td>${formatOptionalPercent(result.evalResult.shortWinRate, scoredShortPredictions)}</td>
            <td>${formatSignedPercent(result.deltaVsBestBaseline)}</td>
            <td><span class="${verdictClass}">${escapeHtml(formatVerdictLabel(result.verdict))}</span></td>
        </tr>
    `;
}

function renderVetoPairRow(result: EnsemblePolymarketVetoPairResult): string {
    const verdictClass = `ensemble-lab__polymarket-verdict ${formatVetoVerdictClass(result.verdict)}`;
    const rowStyle = result.verdict === "interesting"
        ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
        : result.verdict === "marginal"
            ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.08));"'
            : result.verdict === "neutral"
                ? ' style="background:var(--bg-danger-subtle,rgba(220,80,80,0.08));"'
                : "";

    return `
        <tr${rowStyle}>
            <td>${escapeHtml(result.primaryConfigName)}<br><span class="ensemble-lab__config-strategy">${escapeHtml(result.primaryFamilyLabel)}</span></td>
            <td>${escapeHtml(result.vetoConfigName)}<br><span class="ensemble-lab__config-strategy">${escapeHtml(result.vetoFamilyLabel)}</span></td>
            <td>${result.keptEvents}</td>
            <td>${result.keptWins}</td>
            <td>${result.keptLosses}</td>
            <td>${result.vetoedEvents}</td>
            <td>${formatPercent(result.retentionRate)}</td>
            <td>${formatPercent(result.overlapRate)}</td>
            <td>${formatPercent(result.postVetoWinRate)}</td>
            <td>${formatSignedPercent(result.winRateLift)}</td>
            <td>${formatSignedFixed(result.wilsonLift)}</td>
            <td><span class="${verdictClass}">${escapeHtml(formatVetoVerdictLabel(result.verdict))}</span></td>
        </tr>
    `;
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
