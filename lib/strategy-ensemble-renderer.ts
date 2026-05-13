import type { EnsembleLabDom } from "./strategy-ensemble-dom";
import { resolveLiveRecommendation } from "./strategy-ensemble-live-context";
import { buildRadarFindings } from "./strategy-ensemble-radar";
import { describeScenarioPrimaryRow } from "./strategy-ensemble-rules";
import { escapeHtml } from "./html-escape";
import { renderEmptyTableRow, renderLabeledCard } from "./ui-render-helpers";
import { formatSignedCurrency, formatSignedPercentPoints } from "./ui-formatters";
import type {
    EnsembleBuilderRow,
    EnsembleCurrentVoteLabel,
    EnsembleRunContext,
    EnsembleVoteProfileStats,
} from "./strategy-ensemble-types";

export { escapeHtml };

export function renderStrategyEnsembleResults(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const hasTrades = context.tradeSamples.length > 0;

    dom.ensembleResults.style.display = hasTrades ? "" : "none";
    dom.ensembleCurrentContextSection.style.display = hasTrades ? "" : "none";
    dom.ensembleBuilderSection.style.display = hasTrades ? "" : "none";
    dom.ensembleHistoricalOddsSection.style.display = hasTrades ? "" : "none";
    dom.ensembleDiagnosticsSection.style.display = hasTrades ? "" : "none";
    dom.ensembleContributionSection.style.display = hasTrades ? "" : "none";
    dom.ensembleReplacementSection.style.display = hasTrades ? "" : "none";
    dom.ensembleRadarSection.style.display = hasTrades ? "" : "none";

    if (!hasTrades) {
        resetStrategyEnsembleResultPanels(dom);
        dom.ensembleResults.style.display = "";
        dom.ensembleSummary.innerHTML = card("Status", "No target trades found");
        return;
    }

    renderSummary(dom, context);
    renderCurrentContext(dom, context);
    renderBuilder(dom, context);
    renderHistoricalOdds(dom, context);
    renderContribution(dom, context);
    renderReplacement(dom, context);
    renderRadar(dom, context);
}

export function resetStrategyEnsembleResultPanels(dom: EnsembleLabDom): void {
    [
        dom.ensembleResults,
        dom.ensembleCurrentContextSection,
        dom.ensembleBuilderSection,
        dom.ensembleHistoricalOddsSection,
        dom.ensembleDiagnosticsSection,
        dom.ensembleContributionSection,
        dom.ensembleReplacementSection,
        dom.ensembleRadarSection,
    ].forEach((section) => {
        section.style.display = "none";
    });
    dom.ensembleDiagnosticsSection.open = false;

    dom.ensembleSummary.innerHTML = "";
    dom.ensembleCurrentContextSummary.innerHTML = "";
    dom.ensembleCurrentContextDetails.innerHTML = "";
    dom.ensembleHistoricalOddsSummary.innerHTML = "";
    dom.ensembleHistoricalOddsTableBody.innerHTML = renderEmptyTableRow(9, "Run Strategy Ensemble Lab to calculate conditional outcome probabilities.");
    dom.ensembleBuilderSummary.innerHTML = "";
    dom.ensembleBuilderTableBody.innerHTML = renderEmptyTableRow(10, "Run Strategy Ensemble Lab to compare ensemble filtering rules.");
    dom.ensembleContributionSummary.innerHTML = "";
    dom.ensembleContributionTableBody.innerHTML = renderEmptyTableRow(12, "Run Strategy Ensemble Lab to identify helpful and harmful context families.");
    dom.ensembleReplacementSummary.innerHTML = "";
    dom.ensembleReplacementTableBody.innerHTML = renderEmptyTableRow(9, "Run Strategy Ensemble Lab to rank candidate replacements for the weakest context family.");
    dom.ensembleRadarContent.innerHTML = "";
}

function renderSummary(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const targetResult = context.targetArtifact.result;
    dom.ensembleSummary.innerHTML = [
        card("Target Config", context.targetConfigName),
        card("Strategy", context.targetArtifact.strategy.name),
        card("Context Configs", String(context.contextConfigNames.length)),
        card("Context Families", String(context.contextFamilyCount)),
        card("Target Trades", String(targetResult.totalTrades)),
        card("Win Rate", `${targetResult.winRate.toFixed(1)}%`),
        card("Expectancy", `$${targetResult.expectancy.toFixed(2)}`),
        card("Net %", `${targetResult.netProfitPercent.toFixed(2)}%`),
        card("Engine", context.targetArtifact.engineUsed),
    ].join("");
}

function renderCurrentContext(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const liveContext = context.liveContext;

    if (liveContext.basis === "none" || !liveContext.direction) {
        dom.ensembleCurrentContextSummary.innerHTML = card("Status", "No actionable current context");
        dom.ensembleCurrentContextDetails.innerHTML = '<div class="portfolio-lab__insight">The target config has no open trade and no latest actionable signal on the loaded closed-candle window.</div>';
        return;
    }

    const cards = [
        card("Basis", liveContext.basis === "open_trade" ? "Open trade" : "Latest signal"),
        card("Direction", liveContext.direction === "long" ? "Long" : "Short"),
        card("Family Agree", String(liveContext.agreeCount)),
        card("Family Oppose", String(liveContext.opposeCount)),
        card("Neutral Families", String(liveContext.neutralCount)),
        card("Conflicted Families", String(liveContext.conflictedCount)),
    ];

    if (liveContext.openPosition) {
        cards.push(card("Bars In Trade", String(liveContext.openPosition.barsInTrade)));
        cards.push(card("uPnL %", `${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}%`));
    }
    if (liveContext.odds) {
        cards.push(card("Historical Win Rate", `${liveContext.odds.winRate.toFixed(1)}%`));
        cards.push(card("Historical Expectancy", `$${liveContext.odds.expectancy.toFixed(2)}`));
    }
    const recommendation = resolveLiveRecommendation(context, liveContext);
    if (recommendation) {
        cards.push(card("Recommended Filter", recommendation.summary));
    }

    dom.ensembleCurrentContextSummary.innerHTML = cards.join("");

    const details: string[] = [];
    details.push(
        `<div class="portfolio-lab__insight">Raw config votes: agree=${liveContext.rawAgreeCount}, oppose=${liveContext.rawOpposeCount}, neutral=${liveContext.rawNeutralCount}. Family votes: agree=${liveContext.agreeCount}, oppose=${liveContext.opposeCount}, neutral=${liveContext.neutralCount}, conflicted=${liveContext.conflictedCount}.</div>`
    );
    if (liveContext.agreeingFamilies.length > 0) {
        details.push(`<div class="portfolio-lab__insight positive">Agreeing families: <strong>${escapeHtml(liveContext.agreeingFamilies.join(", "))}</strong></div>`);
    }
    if (liveContext.opposingFamilies.length > 0) {
        details.push(`<div class="portfolio-lab__insight negative">Opposing families: <strong>${escapeHtml(liveContext.opposingFamilies.join(", "))}</strong></div>`);
    }
    if (liveContext.conflictedFamilies.length > 0) {
        details.push(`<div class="portfolio-lab__insight">Conflicted families: <strong>${escapeHtml(liveContext.conflictedFamilies.join(", "))}</strong></div>`);
    }
    if (liveContext.agreeingConfigs.length > 0) {
        details.push(`<div class="portfolio-lab__insight positive">Agreeing configs: <strong>${escapeHtml(liveContext.agreeingConfigs.join(", "))}</strong></div>`);
    }
    if (liveContext.opposingConfigs.length > 0) {
        details.push(`<div class="portfolio-lab__insight negative">Opposing configs: <strong>${escapeHtml(liveContext.opposingConfigs.join(", "))}</strong></div>`);
    }
    if (liveContext.odds) {
        details.push(
            `<div class="portfolio-lab__insight">Historical ${liveContext.odds.matchType === "exact" ? "odds" : "nearest-bucket odds"} for <strong>${escapeHtml(liveContext.odds.label)}</strong>: ${liveContext.odds.winRate.toFixed(1)}% win rate, $${liveContext.odds.expectancy.toFixed(2)} expectancy, ${liveContext.odds.sampleCount} samples.</div>`
        );
    } else {
        details.push('<div class="portfolio-lab__insight">No exact or nearby historical bucket met the minimum sample threshold for the current context.</div>');
    }
    if (recommendation) {
        details.push(`<div class="portfolio-lab__insight ${recommendation.passes ? "positive" : "negative"}">${escapeHtml(recommendation.detail)}</div>`);
    }

    dom.ensembleCurrentContextDetails.innerHTML = details.join("");
}

function renderHistoricalOdds(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const rows = [context.baselineBucket, ...context.buckets].filter(
        (bucket): bucket is NonNullable<EnsembleRunContext["baselineBucket"]> => bucket !== null
    );

    if (rows.length === 0) {
        dom.ensembleHistoricalOddsSummary.innerHTML = card("Status", "No qualifying buckets");
        dom.ensembleHistoricalOddsTableBody.innerHTML = renderEmptyTableRow(9, "Not enough samples to produce conditional odds.");
        return;
    }

    const summaryCards: string[] = [];
    if (context.bestBucket) {
        summaryCards.push(card(
            "Best Bucket",
            `${context.bestBucket.label} ($${context.bestBucket.avgExpectancy.toFixed(2)}, n=${context.bestBucket.samples})`
        ));
    }
    if (context.bestLongBucket) {
        summaryCards.push(card(
            "Best Long Bucket",
            `${context.bestLongBucket.label} (${context.bestLongBucket.longWinRate?.toFixed(1)}%, n=${context.bestLongBucket.longSamples})`
        ));
    }
    if (context.bestShortBucket) {
        summaryCards.push(card(
            "Best Short Bucket",
            `${context.bestShortBucket.label} (${context.bestShortBucket.shortWinRate?.toFixed(1)}%, n=${context.bestShortBucket.shortSamples})`
        ));
    }
    dom.ensembleHistoricalOddsSummary.innerHTML = summaryCards.join("");

    dom.ensembleHistoricalOddsTableBody.innerHTML = rows.map((bucket) => {
        const isBaseline = bucket.label === "baseline (all)";
        const isBest = context.bestBucket?.label === bucket.label;
        const rowStyle = isBaseline
            ? ' style="font-weight:600;background:var(--bg-secondary);"'
            : isBest
                ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                : "";

        return `
            <tr${rowStyle}>
                <td>${escapeHtml(bucket.label)}</td>
                <td>${bucket.samples}</td>
                <td>${bucket.winRate.toFixed(1)}%</td>
                <td>${bucket.lossRate.toFixed(1)}%</td>
                <td>$${bucket.avgExpectancy.toFixed(2)}</td>
                <td>${bucket.avgNetPct.toFixed(2)}%</td>
                <td>${bucket.avgOppose.toFixed(2)}</td>
                <td>${bucket.longWinRate === null ? "-" : `${bucket.longWinRate.toFixed(1)}%`}</td>
                <td>${bucket.shortWinRate === null ? "-" : `${bucket.shortWinRate.toFixed(1)}%`}</td>
            </tr>
        `;
    }).join("");
}

function renderBuilder(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const baselineRow = context.builderRows.find((row) => row.rule === "Baseline (target only)") ?? context.builderRows[0] ?? null;
    const conflictFilterRow = context.builderRows.find((row) => row.rule === "Conflict Filter (skip opposed/conflicted)") ?? null;
    const bestPrimaryVetoRow = context.builderRows.find((row) => row.rule.startsWith("Best Primary Veto (")) ?? null;
    const bestExplicitRow = [conflictFilterRow, bestPrimaryVetoRow]
        .filter((row): row is EnsembleBuilderRow => row !== null)
        .reduce<EnsembleBuilderRow | null>((best, row) => {
            if (!best) {
                return row;
            }
            if (row.expectancy !== best.expectancy) {
                return row.expectancy > best.expectancy ? row : best;
            }
            return row.trades > best.trades ? row : best;
        }, null);
    const nonBaselineRows = context.builderRows.filter((row) => row.rule !== "Baseline (target only)" && row.trades >= context.minSamples);
    const bestExpectancyRow = nonBaselineRows.length > 0
        ? nonBaselineRows.reduce((best, row) => row.expectancy > best.expectancy ? row : best)
        : null;
    const bestDrawdownRow = nonBaselineRows.length > 0
        ? nonBaselineRows.reduce((best, row) => Math.abs(row.maxDrawdownPercent) < Math.abs(best.maxDrawdownPercent) ? row : best)
        : null;
    const bestBalanceRow = baselineRow
        ? nonBaselineRows
            .filter((row) => row.trades >= baselineRow.trades * 0.5 && row.expectancy >= baselineRow.expectancy)
            .reduce<EnsembleBuilderRow | null>((best, row) => {
                if (!best) {
                    return row;
                }
                if (row.expectancy !== best.expectancy) {
                    return row.expectancy > best.expectancy ? row : best;
                }
                return row.trades > best.trades ? row : best;
            }, null)
        : null;

    const summaryCards: string[] = [];
    if (context.selectedRule) {
        const selectionLabel = context.selectedRule.mode === "validated" ? "Validated Filter" : "In-Sample Candidate";
        const validationTrades = context.selectedRule.mode === "validated"
            ? context.selectedRule.evaluation.validationSamples
            : context.selectedRule.evaluation.trainSamples;
        const validationExp = context.selectedRule.mode === "validated"
            ? context.selectedRule.evaluation.validationExpectancy
            : context.selectedRule.evaluation.trainExpectancy;
        summaryCards.push(card(
            selectionLabel,
            `${context.selectedRule.evaluation.rule.label} ($${validationExp.toFixed(2)}, n=${validationTrades})`
        ));
    }
    if (conflictFilterRow) {
        summaryCards.push(card(
            "Conflict Skip",
            `$${conflictFilterRow.expectancy.toFixed(2)} | ${conflictFilterRow.trades} trades`
        ));
    }
    if (bestPrimaryVetoRow) {
        summaryCards.push(card(
            "Best Primary Veto",
            `${bestPrimaryVetoRow.rule.replace("Best Primary Veto ", "")} | $${bestPrimaryVetoRow.expectancy.toFixed(2)}`
        ));
    }
    if (bestExplicitRow && (conflictFilterRow || bestPrimaryVetoRow)) {
        summaryCards.push(card(
            "Best Explicit Variant",
            `${bestExplicitRow.rule} ($${bestExplicitRow.expectancy.toFixed(2)})`
        ));
    }
    if (bestExpectancyRow) {
        summaryCards.push(card("Best Expectancy", `${bestExpectancyRow.rule} ($${bestExpectancyRow.expectancy.toFixed(2)})`));
    }
    if (bestDrawdownRow) {
        const beatsBaseline = baselineRow
            ? Math.abs(bestDrawdownRow.maxDrawdownPercent) < Math.abs(baselineRow.maxDrawdownPercent)
            : false;
        summaryCards.push(card(
            beatsBaseline ? "Best Max DD" : "Best Filtered Max DD",
            `${bestDrawdownRow.rule} (${bestDrawdownRow.maxDrawdownPercent.toFixed(1)}%)`
        ));
    }
    if (bestBalanceRow && baselineRow) {
        summaryCards.push(card(
            "Best Balance",
            `${bestBalanceRow.rule} (${((bestBalanceRow.trades / baselineRow.trades) * 100).toFixed(0)}% trades, $${bestBalanceRow.expectancy.toFixed(2)})`
        ));
    }
    dom.ensembleBuilderSummary.innerHTML = summaryCards.join("");

    dom.ensembleBuilderTableBody.innerHTML = context.builderRows.map((row) => {
        const isBaseline = row.rule === "Baseline (target only)";
        const isBest = bestExpectancyRow?.rule === row.rule;
        const isSelected = row.selectionMode !== null;
        const rowStyle = isBaseline
            ? ' style="font-weight:600;background:var(--bg-secondary);"'
            : isSelected
                ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.10));"'
                : isBest
                    ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                    : "";
        const label = row.selectionMode === "validated"
            ? `${row.rule} [Validated]`
            : row.selectionMode === "train_only"
                ? `${row.rule} [In-sample only]`
                : row.rule;

        return `
            <tr${rowStyle}>
                <td>${escapeHtml(label)}</td>
                <td>${row.signals}</td>
                <td>${row.trades}</td>
                <td>${row.winRate.toFixed(1)}%</td>
                <td>${row.netProfitPercent.toFixed(2)}%</td>
                <td>$${row.expectancy.toFixed(2)}</td>
                <td>${row.profitFactor === Infinity ? "INF" : row.profitFactor.toFixed(2)}</td>
                <td>${row.maxDrawdownPercent.toFixed(1)}%</td>
                <td>${row.engineUsed}</td>
                <td><button class="btn btn-secondary btn-compact" type="button" data-ensemble-preview-rule-id="${escapeHtml(row.ruleId)}">View</button></td>
            </tr>
        `;
    }).join("");
}

function renderContribution(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const worstContributor = context.contributionRows.find((row) => row.deltaExpectancy > 0) ?? null;
    const bestContributor = [...context.contributionRows]
        .sort((left, right) => left.deltaExpectancy - right.deltaExpectancy)
        .find((row) => row.deltaExpectancy < 0) ?? null;

    const summaryCards: string[] = [];
    if (worstContributor) {
        summaryCards.push(card(
            "Worst Contributor",
            `${worstContributor.familyLabel} (${formatSignedCurrency(worstContributor.deltaExpectancy)})`
        ));
    } else {
        summaryCards.push(card("Worst Contributor", "No clear harmful family"));
    }
    if (bestContributor) {
        summaryCards.push(card(
            "Best Contributor",
            `${bestContributor.familyLabel} (${formatSignedCurrency(bestContributor.deltaExpectancy)})`
        ));
    } else {
        summaryCards.push(card("Best Contributor", "No clear helpful family"));
    }
    if (context.contributionRows.length > 0) {
        const highestCoverage = [...context.contributionRows].sort(
            (left, right) => right.voteProfile.agreeCoverage - left.voteProfile.agreeCoverage
        )[0];
        summaryCards.push(card(
            "Highest Agree Coverage",
            `${highestCoverage.familyLabel} (${highestCoverage.voteProfile.agreeCoverage.toFixed(1)}%)`
        ));
    }
    dom.ensembleContributionSummary.innerHTML = summaryCards.join("");

    if (context.contributionRows.length === 0) {
        dom.ensembleContributionTableBody.innerHTML = renderEmptyTableRow(12, "No context family contribution data available.");
        return;
    }

    dom.ensembleContributionTableBody.innerHTML = context.contributionRows.map((row) => {
        const positiveRemoval = row.deltaExpectancy > 0;
        const negativeRemoval = row.deltaExpectancy < 0;
        const rowStyle = positiveRemoval
            ? ' style="background:var(--bg-danger-subtle,rgba(220,80,80,0.08));"'
            : negativeRemoval
                ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
                : "";

        return `
            <tr${rowStyle}>
                <td>${escapeHtml(row.familyLabel)}</td>
                <td>${escapeHtml(row.configNames.join(", "))}</td>
                <td>${escapeHtml(formatVoteLabel(row.currentVote))}</td>
                <td>${row.voteProfile.agreeCoverage.toFixed(1)}%</td>
                <td>${escapeHtml(formatOptionalExpectancy(row.voteProfile.agreeStats))}</td>
                <td>${escapeHtml(formatOptionalExpectancy(row.voteProfile.opposeStats))}</td>
                <td>${row.voteProfile.conflictCoverage.toFixed(1)}%</td>
                <td>${escapeHtml(formatSignedCurrency(row.deltaExpectancy))}</td>
                <td>${escapeHtml(formatSignedPercentPoints(row.deltaWinRate))}</td>
                <td>${row.tradeRetentionPercent.toFixed(0)}%</td>
                <td>${escapeHtml(formatSignedInteger(row.deltaTrades))}</td>
                <td>${escapeHtml(describeScenarioPrimaryRow(row.primaryRow))}</td>
            </tr>
        `;
    }).join("");
}

function renderReplacement(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const worstContributor = context.contributionRows.find((row) => row.deltaExpectancy > 0) ?? null;
    const bestReplacement = context.replacementRows[0] ?? null;

    const summaryCards: string[] = [];
    summaryCards.push(card(
        "Replacement Base",
        worstContributor
            ? `Remove ${worstContributor.familyLabel}`
            : "No clear weak family"
    ));
    if (bestReplacement) {
        summaryCards.push(card(
            "Best Replacement",
            `${bestReplacement.familyLabel} (${formatSignedCurrency(bestReplacement.deltaExpectancyVsRemoved)})`
        ));
        summaryCards.push(card("Best Candidate Config", bestReplacement.configName));
    } else {
        summaryCards.push(card("Best Replacement", "No qualifying candidate"));
    }
    dom.ensembleReplacementSummary.innerHTML = summaryCards.join("");

    if (context.replacementRows.length === 0) {
        dom.ensembleReplacementTableBody.innerHTML = renderEmptyTableRow(9, "No replacement candidates improved on the evaluated context set.");
        return;
    }

    dom.ensembleReplacementTableBody.innerHTML = context.replacementRows.map((row, index) => {
        const rowStyle = index === 0
            ? ' style="background:var(--bg-success-subtle,rgba(0,200,100,0.08));"'
            : row.deltaExpectancyVsRemoved > 0
                ? ' style="background:var(--bg-info-subtle,rgba(0,120,255,0.08));"'
                : "";

        return `
            <tr${rowStyle}>
                <td>${escapeHtml(row.familyLabel)}</td>
                <td>${escapeHtml(row.configName)}</td>
                <td>${escapeHtml(formatVoteLabel(row.currentVote))}</td>
                <td>${escapeHtml(formatSignedCurrency(row.deltaExpectancyVsRemoved))}</td>
                <td>${escapeHtml(formatSignedCurrency(row.deltaExpectancyVsCurrent))}</td>
                <td>${escapeHtml(formatSignedPercentPoints(row.deltaWinRateVsCurrent))}</td>
                <td>${row.tradeRetentionPercent.toFixed(0)}%</td>
                <td>${escapeHtml(formatSignedInteger(row.deltaTradesVsCurrent))}</td>
                <td>${escapeHtml(describeScenarioPrimaryRow(row.primaryRow))}</td>
            </tr>
        `;
    }).join("");
}

function renderRadar(dom: EnsembleLabDom, context: EnsembleRunContext): void {
    const findings = buildRadarFindings(context);
    dom.ensembleRadarContent.innerHTML = findings.map((finding) => {
        const className = finding.quality === "positive" ? "positive" : finding.quality === "negative" ? "negative" : "";
        return `<div class="portfolio-lab__insight ${className}"><strong>${escapeHtml(finding.label)}</strong>: ${escapeHtml(finding.detail)}</div>`;
    }).join("");
}

function card(label: string, value: string): string {
    return renderLabeledCard({
        label,
        value,
        cardClass: "sim-card",
        labelClass: "sim-card-label",
        valueClass: "sim-card-value",
    });
}

function formatSignedInteger(value: number): string {
    if (!Number.isFinite(value)) {
        return "-";
    }
    return `${value >= 0 ? "+" : ""}${Math.round(value)}`;
}

function formatOptionalExpectancy(stats: EnsembleVoteProfileStats | null): string {
    return stats ? `$${stats.expectancy.toFixed(2)} (n=${stats.samples})` : "-";
}

function formatVoteLabel(vote: EnsembleCurrentVoteLabel): string {
    if (vote === "n/a") {
        return "n/a";
    }
    return vote.charAt(0).toUpperCase() + vote.slice(1);
}
