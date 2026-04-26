import type { MonteCarloResult, MonteCarloSimulation } from "./strategies/monte-carlo/monte-carlo-engine";
import type { MonteCarloDomElements } from "./monte-carlo-dom";
import { mean, median, percentile, sampleStdDev } from "./statistics-utils";

export interface MonteCarloMethodComparisonRow {
    label: string;
    isPrimary: boolean;
    medianNetProfit: number;
    medianMaxDrawdown: number;
    maxDrawdown95: number;
    medianSharpe: number;
    ruinProbability: number;
}

export function getMonteCarloSuccessRateLabel(result: Pick<MonteCarloResult, "successRateLabel">): string {
    return result.successRateLabel ?? "Win Rate";
}

export function formatMonteCarloMetricValue(value: number, metric: string): string {
    return formatValue(value, metric);
}

export function getMonteCarloCoverageWarnings(
    result: Pick<MonteCarloResult, "inputSource" | "coverageSummary">
): string[] {
    if (result.inputSource !== "polymarket" || !result.coverageSummary) {
        return [];
    }

    const warnings: string[] = [];
    if (result.coverageSummary.overallCoverage < 0.25) {
        warnings.push(`Low confidence: overall Polymarket coverage is ${(result.coverageSummary.overallCoverage * 100).toFixed(1)}%.`);
    }
    if (result.coverageSummary.dataCoverage < 0.6) {
        warnings.push(`Data quality warning: scorable Polymarket data coverage is ${(result.coverageSummary.dataCoverage * 100).toFixed(1)}%.`);
    }

    return warnings;
}

export function renderMonteCarloResults(
    result: MonteCarloResult,
    dom: MonteCarloDomElements,
    methodComparisons: readonly MonteCarloMethodComparisonRow[] = [],
): void {
    if (result.status === "error" || result.status === "insufficient_sample") {
        dom.emptyState.style.display = "block";
        dom.resultsContainer.style.display = "none";
        return;
    }

    dom.emptyState.style.display = "none";
    dom.resultsContainer.style.display = "block";

    const isPolymarket = result.inputSource === "polymarket";
    const multiScenario = methodComparisons.length > 1;
    const { netProfitValues, maxDrawdownPercentValues, sharpeRatioValues } = result.metricSamples;
    const primaryHistogramValues = isPolymarket
        ? netProfitValues.map((value) => result.settings.initialCapital + value)
        : netProfitValues;
    const primaryHistogramStats = computeDistributionStats(primaryHistogramValues);

    dom.sourceBadge.textContent = buildSourceBadgeText(result);
    dom.summaryProfitLabel.textContent = isPolymarket ? "Median Bankroll PnL" : "Median Net Profit";
    dom.methodProfitHeader.textContent = isPolymarket ? "Median Bankroll PnL" : "Median Net Profit";
    dom.profitDistTitle.textContent = isPolymarket ? "Final Balance Distribution" : "Net Profit Distribution";

    dom.simCountEl.textContent = multiScenario
        ? `${result.simulationsCompleted.toLocaleString()} / scenario`
        : result.simulationsCompleted.toLocaleString();
    dom.ruinProbEl.textContent = `${(result.ruinProbabilityMetrics.ruinProbability * 100).toFixed(1)}%`;
    dom.medianProfitEl.textContent = formatSignedCurrency(result.netProfitDistribution.median);
    dom.medianSharpeEl.textContent = sharpeRatioValues.length > 0 ? median(sharpeRatioValues).toFixed(3) : "0.000";
    dom.medianDdEl.textContent = `${result.ruinProbabilityMetrics.maxDrawdownDistribution.median.toFixed(1)}%`;
    dom.execTimeEl.textContent = `${(result.executionTimeMs / 1000).toFixed(2)}s`;

    renderPolymarketSummary(result, dom);
    renderRiskAssessment(result, dom);
    renderMethodComparison(dom.methodComparisonBody, methodComparisons);
    renderConfidenceIntervals(result, dom.ciBody);
    renderDrawdownPercentiles(dom.ddPercentilesBody, maxDrawdownPercentValues);
    renderHistogram(dom.profitHistogram, primaryHistogramValues);
    renderHistogram(dom.ddHistogram, maxDrawdownPercentValues);
    renderHistogram(dom.sharpeHistogram, sharpeRatioValues);

    renderDistributionStats(
        dom.profitStats,
        isPolymarket ? primaryHistogramStats : result.netProfitDistribution,
        isPolymarket ? formatDollarAmount : formatSignedCurrency,
    );
    renderDistributionStats(dom.ddStats, result.ruinProbabilityMetrics.maxDrawdownDistribution, formatPercent);
    renderDistributionStats(dom.sharpeStats, computeDistributionStats(sharpeRatioValues), formatDecimal);

    renderEquityFanChart(dom.equityFan, result.simulations);
    renderFanLegend(dom.fanLegend, result.simulations);

    dom.ruinRateEl.textContent = `${(result.ruinProbabilityMetrics.ruinRate * 100).toFixed(1)}%`;
    dom.expectedTradesToRuinEl.textContent = result.ruinProbabilityMetrics.expectedTradesToRuin?.toFixed(0) ?? "--";
    dom.medianTradesToRuinEl.textContent = result.ruinProbabilityMetrics.medianTradesToRuin?.toFixed(0) ?? "--";
    dom.dd95El.textContent = `${result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95.toFixed(1)}%`;

    dom.sensitivityHeader.style.display = "none";
    dom.sensitivitySection.style.display = "none";
}

function buildSourceBadgeText(result: MonteCarloResult): string {
    if (result.inputSource !== "polymarket") {
        return "Chart Monte Carlo";
    }

    const modeLabel = result.polymarketEvaluationMode === "signal_exit_same_event"
        ? "Signal Exit"
        : "Resolve Hold";
    const stakePerTrade = (result.settings as { polymarketStakePerTrade?: number }).polymarketStakePerTrade;
    const stakeLabel = typeof stakePerTrade === "number" && Number.isFinite(stakePerTrade)
        ? `, $${stakePerTrade.toFixed(2)} / trade`
        : "";
    return `Polymarket Monte Carlo (${modeLabel}${stakeLabel})`;
}

function renderPolymarketSummary(result: MonteCarloResult, dom: MonteCarloDomElements): void {
    if (result.inputSource !== "polymarket" || !result.coverageSummary) {
        dom.polymarketSummaryHeader.style.display = "none";
        dom.polymarketSummary.style.display = "none";
        dom.pmSkipBreakdownEl.style.display = "none";
        return;
    }

    const endingBankrollValues = result.metricSamples.netProfitValues.map(
        (value) => result.settings.initialCapital + value,
    );
    const observedFinalBalance = result.settings.initialCapital + result.inputNetProfit;
    const p5EndingBankroll = percentile(endingBankrollValues, 5);
    const medianEndingBankroll = result.settings.initialCapital + result.netProfitDistribution.median;

    dom.polymarketSummaryHeader.style.display = "";
    dom.polymarketSummary.style.display = "";
    dom.pmSkipBreakdownEl.style.display = "";
    dom.pmScoredTradesEl.textContent = result.coverageSummary.usableTrades.toLocaleString();
    dom.pmOverallCoverageEl.textContent = `${(result.coverageSummary.overallCoverage * 100).toFixed(1)}%`;
    dom.pmDataCoverageEl.textContent = `${(result.coverageSummary.dataCoverage * 100).toFixed(1)}%`;
    dom.pmObservedFinalBalanceEl.textContent = formatDollarAmount(observedFinalBalance);
    dom.pmMedianFinalBankrollEl.textContent = formatDollarAmount(medianEndingBankroll);
    dom.pmFinalBankrollP5El.textContent = formatDollarAmount(p5EndingBankroll);
    dom.pmSkipBreakdownEl.textContent = [
        `Skipped`,
        `missing outcome ${result.coverageSummary.missingOutcomeTrades}`,
        `missing price ${result.coverageSummary.missingPriceTrades}`,
        `duplicate ${result.coverageSummary.duplicateTradesIgnored}`,
        `filtered ${result.coverageSummary.filteredTradesIgnored}`,
    ].join(" | ");
}

function renderRiskAssessment(result: MonteCarloResult, dom: MonteCarloDomElements): void {
    const observedDd = Math.max(0, result.confidenceIntervals.maxDrawdown.observed);
    const dd95 = result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95;
    const medianDd = result.ruinProbabilityMetrics.maxDrawdownDistribution.median;
    const ruinProbability = result.ruinProbabilityMetrics.ruinProbability;
    const stressMultiple = observedDd > 0 ? dd95 / observedDd : null;
    const coverageWarnings = getMonteCarloCoverageWarnings(result);
    const isPolymarket = result.inputSource === "polymarket";

    let flagLabel = "Contained";
    let flagClass = "stat-value positive";
    let detail = isPolymarket
        ? "Monte Carlo bankroll stress is close to the observed Polymarket payout path."
        : "Monte Carlo drawdown stress is close to the observed backtest path.";

    if (
        ruinProbability >= 0.05 ||
        dd95 >= 25 ||
        (stressMultiple !== null && stressMultiple >= 5)
    ) {
        flagLabel = "High Path Risk";
        flagClass = "stat-value negative";
        detail = isPolymarket
            ? "Adverse sequencing can produce materially larger bankroll drawdowns than the observed Polymarket payout path."
            : "Adverse sequencing can produce materially larger drawdowns than the observed path.";
    } else if (
        ruinProbability >= 0.01 ||
        medianDd >= Math.max(observedDd * 1.5, observedDd + 2) ||
        (stressMultiple !== null && stressMultiple >= 2)
    ) {
        flagLabel = "Moderate Path Risk";
        flagClass = "stat-value";
        detail = isPolymarket
            ? "The Polymarket payout path keeps its edge, but trade order still meaningfully changes bankroll drawdown severity."
            : "The strategy keeps its edge, but path order still meaningfully changes drawdown severity.";
    }

    if (coverageWarnings.length > 0) {
        detail = `${detail} ${coverageWarnings.join(" ")}`;
    }

    dom.riskFlagEl.textContent = flagLabel;
    dom.riskFlagEl.className = flagClass;
    dom.ddStressMultipleEl.textContent = stressMultiple === null ? "N/A" : `${stressMultiple.toFixed(1)}x`;
    dom.riskDetailEl.textContent = detail;
}

function renderMethodComparison(
    tbody: HTMLTableSectionElement,
    rows: readonly MonteCarloMethodComparisonRow[],
): void {
    if (rows.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6">No comparison scenarios were run.</td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = rows.map((row) => `
        <tr>
            <td>${row.isPrimary ? `${row.label} (Primary)` : row.label}</td>
            <td>${formatSignedCurrency(row.medianNetProfit)}</td>
            <td>${formatPercent(row.medianMaxDrawdown)}</td>
            <td>${formatPercent(row.maxDrawdown95)}</td>
            <td>${formatDecimal(row.medianSharpe)}</td>
            <td>${(row.ruinProbability * 100).toFixed(1)}%</td>
        </tr>
    `).join("");
}

function renderConfidenceIntervals(
    result: MonteCarloResult,
    tbody: HTMLTableSectionElement,
): void {
    const rateLabel = getMonteCarloSuccessRateLabel(result);
    const profitLabel = result.inputSource === "polymarket" ? "Bankroll PnL" : "Net Profit";
    const ci = result.confidenceIntervals;
    const formatMetric = (
        label: string,
        observed: number,
        ciData: MonteCarloResult["confidenceIntervals"][keyof MonteCarloResult["confidenceIntervals"]],
    ) => `
        <tr>
            <td>${label}</td>
            <td>${formatMonteCarloMetricValue(observed, label)}</td>
            <td>[${formatMonteCarloMetricValue(ciData.ci50Lower, label)}, ${formatMonteCarloMetricValue(ciData.ci50Upper, label)}]</td>
            <td>[${formatMonteCarloMetricValue(ciData.ci90Lower, label)}, ${formatMonteCarloMetricValue(ciData.ci90Upper, label)}]</td>
            <td>[${formatMonteCarloMetricValue(ciData.ci95Lower, label)}, ${formatMonteCarloMetricValue(ciData.ci95Upper, label)}]</td>
        </tr>
    `;

    tbody.innerHTML = `
        ${formatMetric(profitLabel, ci.netProfit.observed, ci.netProfit)}
        ${formatMetric("Max Drawdown", ci.maxDrawdown.observed, ci.maxDrawdown)}
        ${formatMetric("Sharpe Ratio", ci.sharpeRatio.observed, ci.sharpeRatio)}
        ${formatMetric(rateLabel, ci.winRate.observed, ci.winRate)}
    `;
}

function renderDrawdownPercentiles(tbody: HTMLTableSectionElement, values: readonly number[]): void {
    const rows = [50, 90, 95, 99].map((percentileValue) => `
        <tr>
            <td>${percentileValue}th</td>
            <td>${formatPercent(percentile(values, percentileValue))}</td>
        </tr>
    `);
    tbody.innerHTML = rows.join("");
}

function renderHistogram(canvas: HTMLCanvasElement | null, values: readonly number[]): void {
    if (!canvas) {
        return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }

    canvas.width = canvas.offsetWidth || 300;
    canvas.height = 200;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (values.length === 0) {
        return;
    }

    const numBins = 30;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const binWidth = max > min ? (max - min) / numBins : 1;
    const bins = new Array<number>(numBins).fill(0);

    for (const value of values) {
        const binIndex = Math.min(numBins - 1, Math.max(0, Math.floor((value - min) / binWidth)));
        bins[binIndex]++;
    }

    const maxCount = Math.max(...bins, 0);
    const barWidth = canvas.width / numBins;
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "rgba(76, 175, 80, 0.8)");
    gradient.addColorStop(1, "rgba(76, 175, 80, 0.3)");
    ctx.fillStyle = gradient;

    for (let i = 0; i < numBins; i++) {
        const barHeight = maxCount > 0 ? (bins[i] / maxCount) * canvas.height * 0.8 : 0;
        ctx.fillRect(i * barWidth + 1, canvas.height - barHeight, Math.max(1, barWidth - 2), barHeight);
    }

    if (min < 0 && max > 0) {
        const zeroX = ((0 - min) / (max - min)) * canvas.width;
        ctx.strokeStyle = "rgba(255, 0, 0, 0.5)";
        ctx.lineWidth = 1;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(zeroX, 0);
        ctx.lineTo(zeroX, canvas.height);
        ctx.stroke();
        ctx.setLineDash([]);
    }
}

function renderDistributionStats(
    container: HTMLElement,
    distribution: { mean: number; median: number; stdDev: number; min?: number; max?: number },
    format: (value: number) => string,
): void {
    const rows = [
        `<div>Mean: ${format(distribution.mean)}</div>`,
        `<div>Median: ${format(distribution.median)}</div>`,
        `<div>Std Dev: ${format(distribution.stdDev)}</div>`,
    ];

    if (typeof distribution.min === "number") {
        rows.push(`<div>Min: ${format(distribution.min)}</div>`);
    }

    if (typeof distribution.max === "number") {
        rows.push(`<div>Max: ${format(distribution.max)}</div>`);
    }

    container.innerHTML = rows.join("");
}

function computeDistributionStats(values: readonly number[]) {
    if (values.length === 0) {
        return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0 };
    }

    return {
        mean: mean(values),
        median: median(values),
        stdDev: sampleStdDev(values),
        min: Math.min(...values),
        max: Math.max(...values),
    };
}

function renderEquityFanChart(canvas: HTMLCanvasElement | null, simulations: readonly MonteCarloSimulation[]): void {
    if (!canvas) {
        return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
        return;
    }

    canvas.width = canvas.offsetWidth || 600;
    canvas.height = 300;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (simulations.length === 0) {
        return;
    }

    const pointCount = Math.max(...simulations.map((simulation) => simulation.equityCurve.length), 0);
    if (pointCount === 0) {
        return;
    }

    const percentilesByPoint: Array<{ p5: number; p25: number; p50: number; p75: number; p95: number }> = [];

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
        const values = simulations
            .map((simulation) => simulation.equityCurve[pointIndex] ?? simulation.equityCurve[simulation.equityCurve.length - 1])
            .filter((value): value is number => typeof value === "number");

        if (values.length === 0) {
            continue;
        }

        percentilesByPoint.push({
            p5: percentile(values, 5),
            p25: percentile(values, 25),
            p50: percentile(values, 50),
            p75: percentile(values, 75),
            p95: percentile(values, 95),
        });
    }

    if (percentilesByPoint.length === 0) {
        return;
    }

    const allValues = percentilesByPoint.flatMap((entry) => [entry.p5, entry.p95]);
    const minValue = Math.min(...allValues);
    const maxValue = Math.max(...allValues);
    const range = maxValue - minValue || 1;
    const width = canvas.width;
    const height = canvas.height;
    const xScale = width / Math.max(1, percentilesByPoint.length - 1);
    const yScale = (value: number) => height - ((value - minValue) / range) * height * 0.8 - height * 0.1;

    fillBand(ctx, percentilesByPoint, xScale, yScale, "rgba(76, 175, 80, 0.1)", "p95", "p5");
    fillBand(ctx, percentilesByPoint, xScale, yScale, "rgba(76, 175, 80, 0.25)", "p75", "p25");

    ctx.strokeStyle = "#4CAF50";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, yScale(percentilesByPoint[0]?.p50 ?? minValue));
    for (let i = 0; i < percentilesByPoint.length; i++) {
        ctx.lineTo(i * xScale, yScale(percentilesByPoint[i].p50));
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 10);
    ctx.lineTo(width, height - 10);
    ctx.stroke();
}

function fillBand(
    ctx: CanvasRenderingContext2D,
    percentiles: Array<{ p5: number; p25: number; p50: number; p75: number; p95: number }>,
    xScale: number,
    yScale: (value: number) => number,
    fillStyle: string,
    upperKey: "p75" | "p95",
    lowerKey: "p25" | "p5",
): void {
    ctx.fillStyle = fillStyle;
    ctx.beginPath();
    ctx.moveTo(0, yScale(percentiles[0][upperKey]));
    for (let i = 0; i < percentiles.length; i++) {
        ctx.lineTo(i * xScale, yScale(percentiles[i][upperKey]));
    }
    for (let i = percentiles.length - 1; i >= 0; i--) {
        ctx.lineTo(i * xScale, yScale(percentiles[i][lowerKey]));
    }
    ctx.closePath();
    ctx.fill();
}

function renderFanLegend(container: HTMLElement, simulations: readonly MonteCarloSimulation[]): void {
    if (simulations.length === 0) {
        container.textContent = "";
        return;
    }

    const pointCount = simulations[0]?.equityCurve.length ?? 0;
    container.textContent = `Fan chart uses ${simulations.length} sampled paths across ${pointCount} stored curve points.`;
}

function formatValue(value: number, metric: string): string {
    if (metric.includes("Rate") || metric.includes("Drawdown")) {
        return formatPercent(value);
    }
    if (metric.includes("Profit") || metric.includes("Loss") || metric.includes("Pnl") || metric.includes("PnL")) {
        return formatSignedCurrency(value);
    }
    if (metric.includes("Bankroll")) {
        return formatDollarAmount(value);
    }
    return formatDecimal(value);
}

function formatSignedCurrency(value: number): string {
    const prefix = value >= 0 ? "+" : "-";
    return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

function formatDollarAmount(value: number): string {
    const prefix = value < 0 ? "-" : "";
    return `${prefix}$${Math.abs(value).toFixed(2)}`;
}

function formatPercent(value: number): string {
    return `${value.toFixed(2)}%`;
}

function formatDecimal(value: number): string {
    return value.toFixed(3);
}
