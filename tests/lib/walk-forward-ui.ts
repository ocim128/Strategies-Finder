import type { WalkForwardResult } from "./strategies/walk-forward";
import type { WalkForwardServiceDom } from "./walk-forward-dom";

export type WalkForwardLoadingMode = "analysis" | "quick";

export interface WalkForwardUiHost {
    formatSignedPercent(value: number | null): string;
    formatNumber(value: number | null, digits?: number): string;
    formatPercent(value: number | null, digits?: number): string;
    formatBaseParamsSummary(): string | null;
    formatWindowParams(params: Record<string, number>): string;
}

function formatSignedValue(value: number | null, digits = 2): string {
    if (value === null || !Number.isFinite(value)) {
        return "-";
    }
    const prefix = value > 0 ? "+" : "";
    return `${prefix}${value.toFixed(digits)}`;
}

function getAlphaDecayTone(status: "decaying" | "weakening" | "stable" | "strengthening" | "improving" | "insufficient_data"): "positive" | "negative" | "neutral" {
    if (status === "decaying" || status === "weakening") return "negative";
    if (status === "improving" || status === "strengthening") return "positive";
    return "neutral";
}

function formatTrendLabel(
    direction: "up" | "down" | "flat",
    normalizedTrendPerWindow: number | null
): string {
    if (normalizedTrendPerWindow === null || !Number.isFinite(normalizedTrendPerWindow)) {
        return direction;
    }
    const perTenWindowsPct = Math.abs(normalizedTrendPerWindow * 1000);
    if (direction === "flat" || perTenWindowsPct < 0.5) {
        return "flat";
    }
    return `${direction} (${perTenWindowsPct.toFixed(1)}%/10w)`;
}

export function renderWalkForwardDecayPanel(
    dom: WalkForwardServiceDom,
    host: WalkForwardUiHost,
    result: WalkForwardResult
): void {
    const panel = dom.wfDecayPanel;
    const decay = result.decayMonitoring;

    if (!decay) {
        panel.innerHTML = `
            <div class="empty-state">
                <p>Decay monitoring is unavailable for this result.</p>
            </div>
        `;
        return;
    }

    const alphaTone = getAlphaDecayTone(decay.alphaDecay.status);
    const cusumTone = decay.cusum.detected
        ? decay.cusum.direction === "negative_shift" ? "negative" : "positive"
        : "neutral";
    const latestRolling = decay.rollingRisk[decay.rollingRisk.length - 1] ?? null;
    const rollingSharpeVsPeak = decay.rollingComparison.sharpeLatestVsPeak;
    const rollingSortinoVsPeak = decay.rollingComparison.sortinoLatestVsPeak;
    const rollingSharpeRecentVsPrior = decay.rollingComparison.sharpeRecentVsPrior;
    const rollingSortinoRecentVsPrior = decay.rollingComparison.sortinoRecentVsPrior;
    const comparisonWindowLabel = decay.rollingComparison.comparisonWindowSize > 0
        ? String(decay.rollingComparison.comparisonWindowSize)
        : "N";
    const halfLifeLabel = decay.halfLife.halfLifeBars !== null
        ? `${decay.halfLife.halfLifeBars.toFixed(0)} bars`
        : "N/A";
    const halfLifeWindowsLabel = decay.halfLife.halfLifeWindows !== null
        ? `${decay.halfLife.halfLifeWindows.toFixed(1)} windows`
        : "N/A";
    const parameterRows = decay.parameterMetrics.length > 0
        ? decay.parameterMetrics.map((metric) => {
            const driftTone = metric.driftPercentOfRange > 0 ? "positive" : metric.driftPercentOfRange < 0 ? "negative" : "neutral";
            const stabilityTone = metric.stabilityScore >= 70 ? "positive" : metric.stabilityScore < 45 ? "negative" : "neutral";
            const trendTone = metric.trendDirection === "up" ? "positive" : metric.trendDirection === "down" ? "negative" : "neutral";
            return `
                <tr>
                    <td>${metric.name}</td>
                    <td>${host.formatNumber(metric.firstValue, 3)}</td>
                    <td>${host.formatNumber(metric.latestValue, 3)}</td>
                    <td class="${driftTone}">${formatSignedValue(metric.driftPercentOfRange, 1)}%</td>
                    <td>${host.formatNumber(metric.normalizedStdDev * 100, 1)}%</td>
                    <td class="${trendTone}">${formatTrendLabel(metric.trendDirection, metric.normalizedTrendPerWindow)}</td>
                    <td class="${stabilityTone}">${host.formatNumber(metric.stabilityScore, 0)}</td>
                </tr>
            `;
        }).join("")
        : `
            <tr>
                <td colspan="7" class="empty-cell">No tunable parameter drift to track for this run.</td>
            </tr>
        `;
    const rollingRows = decay.rollingRisk.length > 0
        ? decay.rollingRisk.map((point) => `
            <tr>
                <td>${point.windowIndex + 1}</td>
                <td>${host.formatNumber(point.sharpe, 3)}</td>
                <td>${host.formatNumber(point.sortino, 3)}</td>
            </tr>
        `).join("")
        : `
            <tr>
                <td colspan="3" class="empty-cell">Need more windows for rolling Sharpe/Sortino.</td>
            </tr>
        `;

    panel.innerHTML = `
        <div class="wf-decay-header">
            <div class="wf-decay-title">Decay Diagnostics</div>
            <div class="wf-decay-note">
                Tracks parameter drift, edge deterioration, structural change via CUSUM, rolling Sharpe/Sortino, and an estimated signal half-life.
            </div>
        </div>
        <div class="wf-summary">
            <div class="wf-stat">
                <span class="wf-label">Alpha Status</span>
                <span class="wf-value ${alphaTone}">${decay.alphaDecay.status.replace("_", " ")}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Early Edge</span>
                <span class="wf-value">${host.formatNumber(decay.alphaDecay.earlyEdge, 3)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Recent Edge</span>
                <span class="wf-value">${host.formatNumber(decay.alphaDecay.recentEdge, 3)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Edge Delta</span>
                <span class="wf-value ${alphaTone}">${formatSignedValue(decay.alphaDecay.recentVsEarlyDelta, 3)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">CUSUM</span>
                <span class="wf-value ${cusumTone}">
                    ${decay.cusum.detected ? decay.cusum.direction.replace("_", " ") : "no shift"}
                </span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Shift Window</span>
                <span class="wf-value">${decay.cusum.changeWindowIndex !== null ? decay.cusum.changeWindowIndex + 1 : "-"}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Latest Rolling Sharpe</span>
                <span class="wf-value">${latestRolling ? host.formatNumber(latestRolling.sharpe, 3) : "-"}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Latest Rolling Sortino</span>
                <span class="wf-value">${latestRolling ? host.formatNumber(latestRolling.sortino, 3) : "-"}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Sharpe vs Peak</span>
                <span class="wf-value ${rollingSharpeVsPeak !== null && rollingSharpeVsPeak < 0 ? "negative" : rollingSharpeVsPeak !== null && rollingSharpeVsPeak > 0 ? "positive" : "neutral"}">
                    ${formatSignedValue(rollingSharpeVsPeak, 3)}
                </span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Sortino vs Peak</span>
                <span class="wf-value ${rollingSortinoVsPeak !== null && rollingSortinoVsPeak < 0 ? "negative" : rollingSortinoVsPeak !== null && rollingSortinoVsPeak > 0 ? "positive" : "neutral"}">
                    ${formatSignedValue(rollingSortinoVsPeak, 3)}
                </span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Last ${comparisonWindowLabel} vs Prior ${comparisonWindowLabel} Sharpe</span>
                <span class="wf-value ${rollingSharpeRecentVsPrior !== null && rollingSharpeRecentVsPrior < 0 ? "negative" : rollingSharpeRecentVsPrior !== null && rollingSharpeRecentVsPrior > 0 ? "positive" : "neutral"}">
                    ${formatSignedValue(rollingSharpeRecentVsPrior, 3)}
                </span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Last ${comparisonWindowLabel} vs Prior ${comparisonWindowLabel} Sortino</span>
                <span class="wf-value ${rollingSortinoRecentVsPrior !== null && rollingSortinoRecentVsPrior < 0 ? "negative" : rollingSortinoRecentVsPrior !== null && rollingSortinoRecentVsPrior > 0 ? "positive" : "neutral"}">
                    ${formatSignedValue(rollingSortinoRecentVsPrior, 3)}
                </span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Half-Life</span>
                <span class="wf-value">${halfLifeLabel}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Half-Life Windows</span>
                <span class="wf-value">${halfLifeWindowsLabel}</span>
            </div>
        </div>
        <div class="wf-decay-meta">
            <span>Alpha confidence: ${decay.alphaDecay.confidence.toFixed(0)}%</span>
            <span>CUSUM threshold: ${decay.cusum.threshold.toFixed(2)}</span>
            <span>Rolling window: ${Math.max(0, decay.rollingRiskWindowSize)} WFA windows</span>
            <span>Half-life fit: ${(decay.halfLife.fitQuality * 100).toFixed(0)}%</span>
            <span>${decay.halfLife.reason}</span>
            ${decay.robustnessPenalty > 0
                ? `<span>Decay penalty: -${decay.robustnessPenalty} robustness (${decay.robustnessPenaltyReasons.join(", ")})</span>`
                : ""}
        </div>
        <div class="wf-decay-section">
            <div class="wf-decay-subtitle">Parameter Drift</div>
            <div class="wf-table-wrapper">
                <table class="wf-table">
                    <thead>
                        <tr>
                            <th>Param</th>
                            <th>First</th>
                            <th>Latest</th>
                            <th>Drift</th>
                            <th>Std/Range</th>
                            <th>Trend</th>
                            <th>Stability</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${parameterRows}
                    </tbody>
                </table>
            </div>
        </div>
        <div class="wf-decay-section">
            <div class="wf-decay-subtitle">Rolling Risk-Adjusted Returns</div>
            <div class="wf-table-wrapper">
                <table class="wf-table">
                    <thead>
                        <tr>
                            <th>Window</th>
                            <th>Rolling Sharpe</th>
                            <th>Rolling Sortino</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rollingRows}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

export function updateWalkForwardSummaryPanel(
    dom: WalkForwardServiceDom,
    host: WalkForwardUiHost,
    result: WalkForwardResult
): void {
    const panel = dom.wfSummaryPanel;
    const oos = result.combinedOOSTrades;
    const wfePercent = (result.walkForwardEfficiency * 100).toFixed(1);
    const wfeClass = result.walkForwardEfficiency >= 0.7 ? "positive" :
        result.walkForwardEfficiency >= 0.4 ? "neutral" : "negative";
    const oosNetClass = oos.netProfit > 0 ? "positive" : oos.netProfit < 0 ? "negative" : "neutral";
    const baseParamsSummary = host.formatBaseParamsSummary();

    panel.innerHTML = `
        ${baseParamsSummary ? `
        <div class="wf-stat" style="grid-column: 1 / -1;">
            <span class="wf-label">Base Params Used</span>
            <span class="wf-value">${baseParamsSummary}</span>
        </div>
        ` : ""}
        <div class="wf-stat">
            <span class="wf-label">Windows</span>
            <span class="wf-value">${result.totalWindows}</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">IS Sharpe (avg)</span>
            <span class="wf-value">${result.avgInSampleSharpe.toFixed(3)}</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">OOS Sharpe (avg)</span>
            <span class="wf-value">${result.avgOutOfSampleSharpe.toFixed(3)}</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">WF Efficiency</span>
            <span class="wf-value ${wfeClass}">${wfePercent}%</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">OOS Net Profit</span>
            <span class="wf-value ${oosNetClass}">
                $${oos.netProfit.toFixed(2)} (${oos.netProfitPercent.toFixed(1)}%)
            </span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">OOS Win Rate</span>
            <span class="wf-value">${oos.winRate.toFixed(1)}%</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">OOS Profit Factor</span>
            <span class="wf-value">${oos.profitFactor.toFixed(2)}</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">OOS Max DD</span>
            <span class="wf-value negative">${oos.maxDrawdownPercent.toFixed(1)}%</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">Param Stability</span>
            <span class="wf-value">${result.parameterStability.toFixed(0)}%</span>
        </div>
        <div class="wf-stat">
            <span class="wf-label">Time</span>
            <span class="wf-value">${(result.optimizationTimeMs / 1000).toFixed(2)}s</span>
        </div>
    `;
}

export function updateWalkForwardWindowTable(
    dom: WalkForwardServiceDom,
    host: WalkForwardUiHost,
    result: WalkForwardResult
): void {
    dom.wfWindowTableBody.innerHTML = result.windows.map((windowResult) => {
        const oos = windowResult.outOfSampleResult;
        const hasTrades = oos.totalTrades > 0;
        const displayedOosNetPercent = Number(oos.netProfitPercent.toFixed(1));
        const isProfit = displayedOosNetPercent > 0;
        const isLoss = displayedOosNetPercent < 0;
        const rowClass = isProfit ? "positive" : isLoss ? "negative" : "";
        const statusIcon = !hasTrades ? "No trades" : isProfit ? "OK" : isLoss ? "X" : "Flat";
        const statusClass = isProfit ? "positive" : isLoss ? "negative" : "";
        const paramsStr = host.formatWindowParams(windowResult.optimizedParams);

        return `
            <tr class="${rowClass}">
                <td>${windowResult.windowIndex + 1}</td>
                <td>${windowResult.inSampleResult.netProfitPercent.toFixed(1)}%</td>
                <td>${displayedOosNetPercent.toFixed(1)}%</td>
                <td>${windowResult.performanceDegradationPercent.toFixed(0)}%</td>
                <td>${windowResult.inSampleResult.sharpeRatio.toFixed(2)}</td>
                <td>${oos.sharpeRatio.toFixed(2)}</td>
                <td title="${JSON.stringify(windowResult.optimizedParams)}">${paramsStr}</td>
                <td class="${statusClass}">${statusIcon}</td>
            </tr>
        `;
    }).join("");
}

export function updateWalkForwardRobustnessGauge(dom: WalkForwardServiceDom, score: number): void {
    dom.wfRobustnessScore.textContent = `${score}`;
    dom.wfRobustnessGauge.style.setProperty("--score", `${score}`);
    if (score >= 80) dom.wfRobustnessGauge.className = "wf-gauge excellent";
    else if (score >= 60) dom.wfRobustnessGauge.className = "wf-gauge good";
    else if (score >= 40) dom.wfRobustnessGauge.className = "wf-gauge moderate";
    else if (score >= 20) dom.wfRobustnessGauge.className = "wf-gauge poor";
    else dom.wfRobustnessGauge.className = "wf-gauge critical";

    if (score >= 80) dom.wfRobustnessDesc.textContent = "Strong robustness. Low overfitting risk.";
    else if (score >= 60) dom.wfRobustnessDesc.textContent = "Reasonably robust. Monitor for degradation.";
    else if (score >= 40) dom.wfRobustnessDesc.textContent = "Some overfitting. Consider parameter constraints.";
    else if (score >= 20) dom.wfRobustnessDesc.textContent = "Significant overfitting. May not perform forward.";
    else dom.wfRobustnessDesc.textContent = "Severe overfitting. Strategy is curve-fitted.";
}

export function setWalkForwardLoading(
    dom: WalkForwardServiceDom,
    loading: boolean,
    mode: WalkForwardLoadingMode,
): void {
    dom.wfRunBtn.disabled = loading;
    dom.wfRunBtn.setAttribute("aria-busy", loading && mode === "analysis" ? "true" : "false");
    dom.wfQuickBtn.disabled = loading;
    dom.wfQuickBtn.setAttribute("aria-busy", loading && mode === "quick" ? "true" : "false");
    dom.wfCancelBtn.style.display = loading ? "inline-flex" : "none";

    dom.wfSpinner.style.display = loading && mode === "analysis" ? "inline-block" : "none";
    dom.wfQuickSpinner.style.display = loading && mode === "quick" ? "inline-block" : "none";
}
