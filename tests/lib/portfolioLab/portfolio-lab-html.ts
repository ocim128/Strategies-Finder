import type { PortfolioLabDom } from "../feature-dom-contracts";
import {
    escapeHtml,
    formatCorrelation,
    formatCurrency,
    formatDrawdownPercent,
    formatNullableRate,
    formatPercent,
    formatProfitFactor,
    getCorrelationCellColor,
    renderSummaryCard,
    toDisplaySymbol,
} from "./portfolio-lab-formatters";
import {
    collapseOppositionSweepRows,
    findSweepWinner,
    renderBestBreadthSweep,
    renderBestOppositionSweep,
} from "./portfolio-lab-sweep";
import { average, computeCloseReturnCorrelation, standardDeviation } from "./portfolio-lab-statistics";
import type {
    BreadthSweepRow,
    CachedPairData,
    ConsensusAnalysis,
    ExecutionFilterRun,
    LiveContextSnapshot,
    OpenTradeForecast,
    OppositionSweepRow,
    PairAnalysisRow,
    PairRankingRow,
    PortfolioWindowMode,
    SizingScenarioRow,
} from "./portfolio-lab-types";

type SharedBacktestMetrics = {
    totalTrades: number;
    winRate: number;
    netProfitPercent: number;
    expectancy: number;
    profitFactor: number;
    maxDrawdownPercent: number;
};

function renderSharedBacktestMetricCells(result: SharedBacktestMetrics): string {
    return `
        <td>${result.totalTrades}</td>
        <td>${result.winRate.toFixed(1)}%</td>
        <td class="${result.netProfitPercent >= 0 ? "positive" : "negative"}">${formatPercent(result.netProfitPercent)}</td>
        <td class="${result.expectancy >= 0 ? "positive" : "negative"}">${formatCurrency(result.expectancy)}</td>
        <td>${formatProfitFactor(result.profitFactor)}</td>
        <td class="negative">${formatDrawdownPercent(result.maxDrawdownPercent)}</td>
    `;
}

export function renderSummary(rows: PairAnalysisRow[], benchmarkSymbol: string): string {
    const profitablePairs = rows.filter((row) => row.result.netProfitPercent > 0).length;
    const avgNetPct = average(rows.map((row) => row.result.netProfitPercent));
    const avgTradeExpectancy = average(rows.map((row) => row.result.expectancy));
    const avgMarketCorr = average(rows.map((row) => row.marketCorrelation));
    const avgStrategyCorr = average(rows.map((row) => row.strategyCorrelation));
    const best = rows[0];
    const worst = rows[rows.length - 1];

    return [
        renderSummaryCard("Pairs", `${rows.length}`, `${profitablePairs} profitable`),
        renderSummaryCard("Avg Net", formatPercent(avgNetPct), "mean net return across pairs"),
        renderSummaryCard("Avg Expectancy", formatCurrency(avgTradeExpectancy), "mean trade expectancy"),
        renderSummaryCard("Avg Market Corr", formatCorrelation(avgMarketCorr), `vs ${benchmarkSymbol}`),
        renderSummaryCard("Avg Strategy Corr", formatCorrelation(avgStrategyCorr), `equity return corr vs ${benchmarkSymbol}`),
        renderSummaryCard("Best / Worst", `${best.displayName} / ${worst.displayName}`, `${formatPercent(best.result.netProfitPercent)} / ${formatPercent(worst.result.netProfitPercent)}`),
    ].join("");
}

export function renderExecutionSummary(
    breadthRows: BreadthSweepRow[],
    oppositionRows: OppositionSweepRow[],
    currentFilter: ExecutionFilterRun | null,
    targetSymbol: string,
    minAgree: number,
    maxOppose: number
): string {
    const bestBreadth = renderBestBreadthSweep(breadthRows);
    const bestOpposition = renderBestOppositionSweep(oppositionRows);
    const breadthNet = findSweepWinner(breadthRows, (row) => row.result.netProfitPercent, (row) => `>= ${row.minAgree} agree`);
    const breadthDd = findSweepWinner(breadthRows, (row) => -Math.abs(row.result.maxDrawdownPercent), (row) => `>= ${row.minAgree} agree`);
    const oppositionNet = findSweepWinner(oppositionRows, (row) => row.result.netProfitPercent, (row) => `<= ${row.maxOppose} oppose`);
    const oppositionDd = findSweepWinner(oppositionRows, (row) => -Math.abs(row.result.maxDrawdownPercent), (row) => `<= ${row.maxOppose} oppose`);

    return [
        renderSummaryCard("Target Pair", toDisplaySymbol(targetSymbol), "execution filters are evaluated on the benchmark/current target"),
        renderSummaryCard(
            "Breadth Best Exp",
            bestBreadth ? `>= ${bestBreadth.minAgree} agree` : "-",
            bestBreadth ? `${bestBreadth.result.winRate.toFixed(1)}% win | ${formatCurrency(bestBreadth.result.expectancy)}` : "Run produced no valid breadth thresholds"
        ),
        renderSummaryCard(
            "Breadth Best Net",
            breadthNet?.label ?? "-",
            breadthNet ? `${formatPercent(breadthNet.result.netProfitPercent)} | ${formatDrawdownPercent(breadthNet.result.maxDrawdownPercent)}` : "Run produced no valid breadth thresholds"
        ),
        renderSummaryCard(
            "Breadth Best DD",
            breadthDd?.label ?? "-",
            breadthDd ? `${formatDrawdownPercent(breadthDd.result.maxDrawdownPercent)} | ${formatCurrency(breadthDd.result.expectancy)}` : "Run produced no valid breadth thresholds"
        ),
        renderSummaryCard(
            "Oppose Best Exp",
            bestOpposition ? `<= ${bestOpposition.maxOppose} oppose` : "-",
            bestOpposition ? `${bestOpposition.result.winRate.toFixed(1)}% win | ${formatCurrency(bestOpposition.result.expectancy)}` : "Run produced no valid opposition thresholds"
        ),
        renderSummaryCard(
            "Oppose Best Net",
            oppositionNet?.label ?? "-",
            oppositionNet ? `${formatPercent(oppositionNet.result.netProfitPercent)} | ${formatDrawdownPercent(oppositionNet.result.maxDrawdownPercent)}` : "Run produced no valid opposition thresholds"
        ),
        renderSummaryCard(
            "Oppose Best DD",
            oppositionDd?.label ?? "-",
            oppositionDd ? `${formatDrawdownPercent(oppositionDd.result.maxDrawdownPercent)} | ${formatCurrency(oppositionDd.result.expectancy)}` : "Run produced no valid opposition thresholds"
        ),
        renderSummaryCard(
            "Current Filter",
            `>= ${minAgree} agree, <= ${maxOppose} oppose`,
            currentFilter ? `${currentFilter.result.winRate.toFixed(1)}% win | ${formatCurrency(currentFilter.result.expectancy)}` : "Current threshold removed all signals"
        ),
    ].join("");
}

export function renderLiveContextSummary(liveContext: LiveContextSnapshot): string {
    if (liveContext.basis === "none" || !liveContext.direction) {
        return `
            <div class="sim-card" style="grid-column: 1 / -1;">
                <div class="sim-card-label">Current Context</div>
                <div class="sim-card-value">No active setup</div>
                <div class="sim-card-delta">No open trade or recent signal was available for the target symbol.</div>
            </div>
        `;
    }

    const basisLabel = liveContext.basis === "open_trade" ? "Open Trade" : "Latest Signal";
    return [
        renderSummaryCard("Context Basis", basisLabel, toDisplaySymbol(liveContext.targetSymbol)),
        renderSummaryCard("Direction", liveContext.direction.toUpperCase(), `${liveContext.bucketLabel ?? "No bucket"} | ${liveContext.agreementCount} agree / ${liveContext.oppositionCount} oppose`),
        renderSummaryCard(
            "Historical Odds",
            liveContext.odds ? `${liveContext.odds.winRate.toFixed(1)}% win` : "Not enough samples",
            liveContext.odds ? `${liveContext.odds.label} | ${liveContext.odds.sampleCount} samples` : "Need more historical matches for this context"
        ),
        renderSummaryCard(
            "Estimated Expectancy",
            liveContext.odds ? formatCurrency(liveContext.odds.expectancy) : "-",
            liveContext.openPosition
                ? `${liveContext.openPosition.unrealizedPnlPercent >= 0 ? "+" : ""}${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}% unrealized | ${liveContext.openPosition.barsInTrade} bars held`
                : "One-shot context estimate only; no live stream"
        ),
    ].join("");
}

export function renderLiveContextDetails(liveContext: LiveContextSnapshot): string {
    if (liveContext.basis === "none" || !liveContext.direction) {
        return `<div class="portfolio-lab__insight">Run Portfolio Lab after loading enough data on the target symbol to calculate current agreement and historical odds.</div>`;
    }

    const details: string[] = [];
    const basisLabel = liveContext.basis === "open_trade" ? "open trade" : "latest signal";
    details.push(
        `<strong>Current ${basisLabel}:</strong> ${toDisplaySymbol(liveContext.targetSymbol)} ` +
        `${liveContext.direction.toUpperCase()} with ${liveContext.agreementCount} agreeing pair${liveContext.agreementCount === 1 ? "" : "s"} ` +
        `and ${liveContext.oppositionCount} opposing pair${liveContext.oppositionCount === 1 ? "" : "s"}.`
    );
    if (liveContext.agreeingSymbols.length > 0) {
        details.push(`<strong>Agreeing pairs:</strong> ${liveContext.agreeingSymbols.map(toDisplaySymbol).join(", ")}.`);
    }
    if (liveContext.opposingSymbols.length > 0) {
        details.push(`<strong>Opposing pairs:</strong> ${liveContext.opposingSymbols.map(toDisplaySymbol).join(", ")}.`);
    }
    if (liveContext.odds) {
        details.push(
            `<strong>Historical match:</strong> ${liveContext.odds.label} returned ${liveContext.odds.winRate.toFixed(1)}% win / ` +
            `${liveContext.odds.lossRate.toFixed(1)}% loss across ${liveContext.odds.sampleCount} closed trades, with ` +
            `${formatCurrency(liveContext.odds.expectancy)} average expectancy.`
        );
    } else {
        details.push(`<strong>Historical match:</strong> not enough similar closed trades yet for a reliable estimate.`);
    }
    if (liveContext.openPosition) {
        details.push(
            `<strong>Open-trade state:</strong> entry ${liveContext.openPosition.entryPrice.toFixed(4)}, current ${liveContext.openPosition.currentPrice.toFixed(4)}, ` +
            `${liveContext.openPosition.unrealizedPnlPercent >= 0 ? "+" : ""}${liveContext.openPosition.unrealizedPnlPercent.toFixed(2)}% unrealized.`
        );
    }

    return details.map((detail) => `<div class="portfolio-lab__insight">${detail}</div>`).join("");
}

export function renderForecastSummary(forecast: OpenTradeForecast): string {
    if (forecast.basis === "none" || !forecast.direction || !forecast.currentSnapshot) {
        return `
            <div class="sim-card" style="grid-column: 1 / -1;">
                <div class="sim-card-label">Open Trade Forecast</div>
                <div class="sim-card-value">No active forecast</div>
                <div class="sim-card-delta">No open trade or recent target signal was available for analog matching.</div>
            </div>
        `;
    }

    return [
        renderSummaryCard(
            "Forecast Basis",
            forecast.basis === "open_trade" ? "Open Trade" : "Latest Signal",
            `${toDisplaySymbol(forecast.targetSymbol)} vs ${toDisplaySymbol(forecast.anchorSymbol)} anchor`
        ),
        renderSummaryCard(
            "Win / Lose",
            forecast.winProbability !== null && forecast.lossProbability !== null ? `${forecast.winProbability.toFixed(1)}% / ${forecast.lossProbability.toFixed(1)}%` : "Not enough analogs",
            forecast.sampleCount > 0 ? `${forecast.sampleCount}/${forecast.candidateCount} nearest analog states` : "Need more historical analog states"
        ),
        renderSummaryCard(
            "Projected Final",
            forecast.expectedFinalPnlPercent !== null ? formatPercent(forecast.expectedFinalPnlPercent) : "-",
            forecast.expectedRemainingPnlPercent !== null ? `Remaining ${formatPercent(forecast.expectedRemainingPnlPercent)}` : "Remaining edge unavailable"
        ),
        renderSummaryCard(
            "Confidence",
            forecast.confidenceLabel ?? "-",
            forecast.confidenceScore !== null ? `${forecast.confidenceScore.toFixed(0)}/100 confidence` : "No confidence score"
        ),
        renderSummaryCard(
            "Suggested Exposure",
            forecast.suggestionLabel ?? "-",
            forecast.suggestedExposure !== null ? `${forecast.suggestedExposure.toFixed(2)}x target size` : "No sizing suggestion"
        ),
        renderSummaryCard(
            "Future Path",
            forecast.expectedMfePercent !== null ? `MFE ${formatPercent(forecast.expectedMfePercent)}` : "-",
            forecast.expectedMaePercent !== null ? `MAE ${formatPercent(forecast.expectedMaePercent)}` : "Path stats unavailable"
        ),
    ].join("");
}

export function renderForecastDetails(forecast: OpenTradeForecast): string {
    if (forecast.basis === "none" || !forecast.direction || !forecast.currentSnapshot) {
        return `<div class="portfolio-lab__insight">Run Portfolio Lab after a target open trade or fresh signal exists to build the analog forecast.</div>`;
    }

    const snapshot = forecast.currentSnapshot;
    const details: string[] = [];
    details.push(
        `<strong>Current setup:</strong> ${toDisplaySymbol(forecast.targetSymbol)} ${forecast.direction.toUpperCase()} ` +
        `with ${snapshot.agreementCount} agree / ${snapshot.oppositionCount} oppose and ` +
        `${snapshot.barsHeld} bar${snapshot.barsHeld === 1 ? "" : "s"} held.`
    );
    details.push(
        `<strong>Relative strength:</strong> vs ${toDisplaySymbol(forecast.anchorSymbol)} over 3 bars ${formatPercent(snapshot.targetVsAnchor3)}, ` +
        `vs universe over 3 bars ${formatPercent(snapshot.targetVsUniverse3)}.`
    );
    details.push(
        `<strong>Context quality:</strong> weighted breadth ${snapshot.weightedAgreementRatio.toFixed(2)} support / ` +
        `${snapshot.weightedOppositionRatio.toFixed(2)} conflict, dispersion ${snapshot.dispersion1 !== null ? snapshot.dispersion1.toFixed(2) : "-"}, ` +
        `leader gap ${formatPercent(snapshot.leaderGap1)}.`
    );
    if (forecast.winProbability !== null && forecast.baselineWinProbability !== null) {
        details.push(
            `<strong>Edge vs baseline:</strong> analog win probability ${forecast.winProbability.toFixed(1)}% vs ${forecast.baselineWinProbability.toFixed(1)}% directional baseline, ` +
            `remaining expectancy ${formatPercent(forecast.expectedRemainingPnlPercent)} vs ${formatPercent(forecast.baselineRemainingPnlPercent)} baseline.`
        );
    }
    if (forecast.rationale.length > 0) {
        details.push(`<strong>Why:</strong> ${forecast.rationale.map(escapeHtml).join(" ")}`);
    }
    if (snapshot.agreeingSymbols.length > 0) {
        details.push(`<strong>Agreeing pairs:</strong> ${snapshot.agreeingSymbols.map(toDisplaySymbol).join(", ")}.`);
    }
    if (snapshot.opposingSymbols.length > 0) {
        details.push(`<strong>Opposing pairs:</strong> ${snapshot.opposingSymbols.map(toDisplaySymbol).join(", ")}.`);
    }

    return details.map((detail) => `<div class="portfolio-lab__insight">${detail}</div>`).join("");
}

export function renderForecastTable(forecast: OpenTradeForecast): string {
    if (forecast.analogs.length === 0) {
        return `
            <tr>
                <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    No historical analog states cleared the current forecast filters yet.
                </td>
            </tr>
        `;
    }

    return forecast.analogs.map((analog, index) => `
        <tr>
            <td>#${index + 1} (${analog.distance.toFixed(2)})</td>
            <td>${analog.barsHeld}</td>
            <td>${analog.agreementCount} / ${analog.oppositionCount}</td>
            <td>${formatPercent(analog.targetVsAnchor3)}</td>
            <td>${formatPercent(analog.targetVsUniverse3)}</td>
            <td class="${analog.finalPnlPercent >= 0 ? "positive" : "negative"}">${formatPercent(analog.finalPnlPercent)}</td>
            <td class="${analog.remainingPnlPercent >= 0 ? "positive" : "negative"}">${formatPercent(analog.remainingPnlPercent)}</td>
            <td class="${(analog.futureMfePercent ?? 0) >= 0 ? "positive" : ""}">${formatPercent(analog.futureMfePercent)}</td>
            <td class="${(analog.futureMaePercent ?? 0) <= 0 ? "negative" : ""}">${formatPercent(analog.futureMaePercent)}</td>
        </tr>
    `).join("");
}

export function renderInsights(
    rows: PairAnalysisRow[],
    benchmarkSymbol: string,
    skipped: string[],
    windowMode: PortfolioWindowMode
): string {
    const profitablePairs = rows.filter((row) => row.result.netProfitPercent > 0).length;
    const avgMarketCorr = average(rows.map((row) => row.marketCorrelation));
    const avgStrategyCorr = average(rows.map((row) => row.strategyCorrelation));
    const dispersion = standardDeviation(rows.map((row) => row.result.netProfitPercent));
    const lowestCorrPositive = rows
        .filter((row) => row.result.netProfitPercent > 0 && typeof row.marketCorrelation === "number")
        .sort((a, b) => (a.marketCorrelation ?? 0) - (b.marketCorrelation ?? 0))[0];
    const highestStrategyCorr = rows
        .filter((row) => typeof row.strategyCorrelation === "number" && row.symbol !== benchmarkSymbol)
        .sort((a, b) => (b.strategyCorrelation ?? -Infinity) - (a.strategyCorrelation ?? -Infinity))[0];

    const insights: string[] = [];
    if (windowMode === "common_overlap") {
        insights.push("Common Overlap mode is active, so every pair was trimmed to the shared calendar window before backtesting and correlation analysis.");
    } else {
        insights.push("Latest N Bars mode is active, so each pair uses its own latest available history window.");
    }
    insights.push(`${profitablePairs}/${rows.length} pairs finished positive. Performance dispersion is ${dispersion.toFixed(2)} net-% points.`);

    if (avgMarketCorr !== null && avgStrategyCorr !== null) {
        if (avgMarketCorr >= 0.7 && avgStrategyCorr >= 0.7) {
            insights.push(`Both price action and strategy outcomes are tightly clustered versus ${benchmarkSymbol}. This behaves more like one market theme than a diversified basket.`);
        } else if (avgMarketCorr >= 0.7 && avgStrategyCorr < 0.4) {
            insights.push(`Pairs are still moving with ${benchmarkSymbol}, but strategy outcomes are less synchronized. The entry logic is adding selectivity beyond raw market beta.`);
        } else if (avgMarketCorr < 0.4 && avgStrategyCorr >= 0.6) {
            insights.push(`Price correlation is modest while strategy correlation stays high. The setup may be reacting to shared structural conditions across different pairs.`);
        } else {
            insights.push(`Price and strategy correlations are both moderate-to-low. This is the healthier profile if you want less redundant exposure.`);
        }
    }

    if (lowestCorrPositive) {
        insights.push(`${lowestCorrPositive.displayName} stayed profitable with only ${formatCorrelation(lowestCorrPositive.marketCorrelation)} market correlation to ${benchmarkSymbol}. That is a good diversification candidate.`);
    }
    if (highestStrategyCorr) {
        insights.push(`${highestStrategyCorr.displayName} has the closest strategy-path behavior to ${benchmarkSymbol} at ${formatCorrelation(highestStrategyCorr.strategyCorrelation)}. Treat those two as partially redundant.`);
    }
    if (skipped.length > 0) {
        insights.push(`Skipped pairs: ${skipped.join(", ")}.`);
    }

    return insights.map((item) => `<div class="portfolio-lab__insight">${item}</div>`).join("");
}

export function renderCorrelationMatrix(
    rows: PairAnalysisRow[],
    selectedSymbols: string[],
    dataCache: Map<string, CachedPairData>
): string {
    const matrixSymbols = rows
        .map((row) => row.symbol)
        .filter((symbol, index, all) => all.indexOf(symbol) === index)
        .slice(0, Math.min(8, selectedSymbols.length));

    if (matrixSymbols.length < 2) {
        return `<div class="portfolio-lab__matrix-empty">Need at least 2 completed pairs for a matrix.</div>`;
    }

    const header = matrixSymbols.map((symbol) => `<th>${toDisplaySymbol(symbol)}</th>`).join("");
    const body = matrixSymbols.map((rowSymbol) => {
        const cells = matrixSymbols.map((colSymbol) => {
            const rowData = dataCache.get(rowSymbol)?.data ?? [];
            const colData = dataCache.get(colSymbol)?.data ?? [];
            const corr = rowSymbol === colSymbol ? 1 : computeCloseReturnCorrelation(rowData, colData);
            return `<td style="background:${getCorrelationCellColor(corr)};">${formatCorrelation(corr)}</td>`;
        }).join("");

        return `
            <tr>
                <th>${toDisplaySymbol(rowSymbol)}</th>
                ${cells}
            </tr>
        `;
    }).join("");

    return `
        <table class="portfolio-lab__matrix-table">
            <thead>
                <tr>
                    <th>Pair</th>
                    ${header}
                </tr>
            </thead>
            <tbody>${body}</tbody>
        </table>
    `;
}

export function renderRow(row: PairAnalysisRow, benchmarkSymbol: string): string {
    const netClass = row.result.netProfitPercent >= 0 ? "positive" : "negative";
    const expectancyClass = row.result.expectancy >= 0 ? "positive" : "negative";
    const benchmarkBadge = row.symbol === benchmarkSymbol ? " portfolio-lab__pair-badge--benchmark" : "";
    const engineHint = row.engineUsed === "rust" ? "Rust" : "TS";

    return `
        <tr>
            <td>
                <div class="portfolio-lab__pair-cell">
                    <span>${row.displayName}</span>
                    <span class="portfolio-lab__pair-badge${benchmarkBadge}">${engineHint}</span>
                </div>
            </td>
            <td>${row.result.totalTrades}</td>
            <td class="${netClass}">${formatPercent(row.result.netProfitPercent)}</td>
            <td>${row.result.winRate.toFixed(1)}%</td>
            <td>${formatProfitFactor(row.result.profitFactor)}</td>
            <td class="negative">${formatDrawdownPercent(row.result.maxDrawdownPercent)}</td>
            <td class="${expectancyClass}">${formatCurrency(row.result.expectancy)}</td>
            <td>${formatCorrelation(row.marketCorrelation)}</td>
            <td>${formatCorrelation(row.strategyCorrelation)}</td>
            <td><button class="btn-simulate portfolio-lab__load-btn" data-symbol="${row.symbol}" type="button">Load</button></td>
        </tr>
    `;
}

export function renderConsensusSummary(consensus: ConsensusAnalysis): string {
    if (consensus.qualifyingBuckets.length === 0) {
        return `
            <div class="sim-card" style="grid-column: 1 / -1;">
                <div class="sim-card-label">Pair Context Probability</div>
                <div class="sim-card-value">Not enough samples</div>
                <div class="sim-card-delta">Raise universe size or lower min samples from ${consensus.minSamples}.</div>
            </div>
        `;
    }

    return [
        renderSummaryCard("Qualified Coverage", `${consensus.qualifyingSampleCount}/${consensus.allSamples.length}`, `lag window ${consensus.lagBars} bar${consensus.lagBars === 1 ? "" : "s"}`),
        renderSummaryCard("Best Overall", consensus.bestBucket?.label ?? "-", consensus.bestBucket ? `${consensus.bestBucket.winRate.toFixed(1)}% win | ${formatCurrency(consensus.bestBucket.avgExpectancy)}` : "No qualifying bucket"),
        renderSummaryCard("Best Long", consensus.bestLongBucket?.label ?? "-", consensus.bestLongBucket ? `${formatNullableRate(consensus.bestLongBucket.longWinRate)} | ${consensus.bestLongBucket.longSamples} samples` : "No qualifying long bucket"),
        renderSummaryCard("Best Short", consensus.bestShortBucket?.label ?? "-", consensus.bestShortBucket ? `${formatNullableRate(consensus.bestShortBucket.shortWinRate)} | ${consensus.bestShortBucket.shortSamples} samples` : "No qualifying short bucket"),
        renderSummaryCard("Baseline", consensus.baselineBucket?.label ?? "0 agree", consensus.baselineBucket ? `${consensus.baselineBucket.winRate.toFixed(1)}% win | ${formatCurrency(consensus.baselineBucket.avgExpectancy)}` : "No qualifying baseline bucket"),
    ].join("");
}

export function renderConsensusTable(consensus: ConsensusAnalysis): string {
    if (consensus.qualifyingBuckets.length === 0) {
        return `
            <tr>
                <td colspan="9" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    No agreement bucket reached the minimum sample threshold of ${consensus.minSamples}.
                </td>
            </tr>
        `;
    }

    return consensus.qualifyingBuckets.map((bucket) => `
        <tr>
            <td>${bucket.label}</td>
            <td>${bucket.samples}</td>
            <td>${bucket.winRate.toFixed(1)}%</td>
            <td>${bucket.lossRate.toFixed(1)}%</td>
            <td class="${bucket.avgExpectancy >= 0 ? "positive" : "negative"}">${formatCurrency(bucket.avgExpectancy)}</td>
            <td class="${bucket.avgNetPct >= 0 ? "positive" : "negative"}">${formatPercent(bucket.avgNetPct)}</td>
            <td>${bucket.avgOppose.toFixed(2)}</td>
            <td>${formatNullableRate(bucket.longWinRate)}</td>
            <td>${formatNullableRate(bucket.shortWinRate)}</td>
        </tr>
    `).join("");
}

export function renderBreadthSweep(dom: PortfolioLabDom, rows: BreadthSweepRow[]): void {
    dom.portfolioBreadthSweepSection.style.display = "";

    if (rows.length === 0) {
        dom.portfolioBreadthSweepTableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    No breadth thresholds produced usable filtered signals.
                </td>
            </tr>
        `;
        return;
    }

    dom.portfolioBreadthSweepTableBody.innerHTML = rows.map((row) => `
        <tr>
            <td>${row.minAgree}</td>
            <td>${row.signals}</td>
            ${renderSharedBacktestMetricCells(row.result)}
        </tr>
    `).join("");
}

export function renderOppositionSweep(dom: PortfolioLabDom, rows: OppositionSweepRow[]): void {
    dom.portfolioOppositionSweepSection.style.display = "";

    if (rows.length === 0) {
        dom.portfolioOppositionSweepTableBody.innerHTML = `
            <tr>
                <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    No opposition thresholds produced usable filtered signals.
                </td>
            </tr>
        `;
        return;
    }

    dom.portfolioOppositionSweepTableBody.innerHTML = collapseOppositionSweepRows(rows).map(({ label, row }) => `
        <tr>
            <td>${label}</td>
            <td>${row.signals}</td>
            ${renderSharedBacktestMetricCells(row.result)}
        </tr>
    `).join("");
}

export function renderRankingSummary(rows: PairRankingRow[]): string {
    if (rows.length === 0) {
        return "";
    }

    const core = rows.find((row) => row.role === "Core" || row.role === "Target") ?? rows[0];
    const diversifier = rows
        .slice()
        .sort((a, b) => {
            const corrDelta = Math.abs(a.row.marketCorrelation ?? 0) - Math.abs(b.row.marketCorrelation ?? 0);
            if (corrDelta !== 0) {
                return corrDelta;
            }
            return b.row.result.expectancy - a.row.result.expectancy;
        })[0] ?? rows[0];
    const responder = rows
        .filter((row) => typeof row.breadthExpectancyLift === "number" && row.breadthExpectancyLift > 0)
        .sort((a, b) => (b.breadthExpectancyLift ?? -Infinity) - (a.breadthExpectancyLift ?? -Infinity))[0] ?? rows[0];

    return [
        renderSummaryCard("Core Pair", core.row.displayName, `${formatCurrency(core.row.result.expectancy)} expectancy | ${formatDrawdownPercent(core.row.result.maxDrawdownPercent)} DD`),
        renderSummaryCard("Best Diversifier", diversifier.row.displayName, `${formatCorrelation(diversifier.row.marketCorrelation)} market corr | ${formatCurrency(diversifier.row.result.expectancy)}`),
        renderSummaryCard("Strongest Responder", responder.row.displayName, responder.breadthExpectancyLift !== null ? `${formatCurrency(responder.breadthExpectancyLift)} expectancy lift when breadth is strong` : "No clear breadth-response edge"),
    ].join("");
}

export function renderRankingTable(rows: PairRankingRow[], benchmarkSymbol: string): string {
    if (rows.length === 0) {
        return `
            <tr>
                <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Portfolio Lab to rank pairs by quality, diversification, and context response.
                </td>
            </tr>
        `;
    }

    return rows.map((item) => {
        const row = item.row;
        const roleClass = row.symbol === benchmarkSymbol ? " portfolio-lab__pair-badge--benchmark" : "";
        return `
            <tr>
                <td>
                    <div class="portfolio-lab__pair-cell">
                        <span>${row.displayName}</span>
                        <span class="portfolio-lab__pair-badge${roleClass}">${row.engineUsed === "rust" ? "Rust" : "TS"}</span>
                    </div>
                </td>
                <td>${item.role}</td>
                <td class="${row.result.expectancy >= 0 ? "positive" : "negative"}">${formatCurrency(row.result.expectancy)}</td>
                <td class="negative">${formatDrawdownPercent(row.result.maxDrawdownPercent)}</td>
                <td class="${(item.breadthExpectancyLift ?? 0) >= 0 ? "positive" : "negative"}">${formatCurrency(item.breadthExpectancyLift)}</td>
                <td>${formatCorrelation(row.marketCorrelation)}</td>
                <td>${formatCorrelation(row.strategyCorrelation)}</td>
                <td><button class="btn-simulate portfolio-lab__load-btn" data-symbol="${row.symbol}" type="button">Load</button></td>
            </tr>
        `;
    }).join("");
}

export function renderSizingSummary(rows: SizingScenarioRow[]): string {
    if (rows.length === 0) {
        return "";
    }

    const bestNet = rows.slice().sort((a, b) => b.result.netProfitPercent - a.result.netProfitPercent)[0];
    const bestDefensive = rows.slice().sort((a, b) => Math.abs(a.result.maxDrawdownPercent) - Math.abs(b.result.maxDrawdownPercent))[0];

    return [
        renderSummaryCard("Best Net Scenario", bestNet.name, `${formatPercent(bestNet.result.netProfitPercent)} | ${formatCurrency(bestNet.result.expectancy)}`),
        renderSummaryCard("Lowest DD Scenario", bestDefensive.name, `${formatDrawdownPercent(bestDefensive.result.maxDrawdownPercent)} | ${bestDefensive.result.winRate.toFixed(1)}% win`),
        renderSummaryCard("Sizing Note", "Context-weighted", "These scenarios scale trade size by pair context instead of filtering trades out."),
    ].join("");
}

export function renderSizingTable(rows: SizingScenarioRow[]): string {
    if (rows.length === 0) {
        return `
            <tr>
                <td colspan="8" style="text-align:center;color:var(--text-secondary);padding:16px;">
                    Run Portfolio Lab to compare context-weighted sizing scenarios.
                </td>
            </tr>
        `;
    }

    return rows.map((row) => `
        <tr>
            <td>
                <div>${row.name}</div>
                <div class="portfolio-lab__table-caption">${row.description}</div>
            </td>
            <td>${row.result.avgMultiplier.toFixed(2)}x</td>
            ${renderSharedBacktestMetricCells(row.result)}
        </tr>
    `).join("");
}
