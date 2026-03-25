import {
    formatWalkForwardPermutationPValue,
    type WalkForwardPermutationMetric,
    type WalkForwardPermutationResult,
} from "./strategies/backtest/permutation-test";
import type { WalkForwardResult } from "./strategies/walk-forward";
import type { WalkForwardServiceDom } from "./walk-forward-dom";

type CandidateValidationDecisionReason =
    | "pass"
    | "net_loss"
    | "low_profit_factor"
    | "drawdown_breach"
    | "low_trades"
    | "run_error";

interface CandidateSeedValidationRow {
    seed: number;
    pass: boolean;
    decisionReason: CandidateValidationDecisionReason;
    netProfitPercent: number | null;
    profitFactor: number | null;
    maxDrawdownPercent: number | null;
    totalTrades: number | null;
    robustnessScore: number | null;
    testWindow: number;
    stepSize: number;
    commissionPercent: number;
    slippageBps: number;
    dataOffset: number;
    totalWindows: number | null;
    error?: string;
}

export interface CandidateValidationSummary {
    seeds: number[];
    minPasses: number;
    passCount: number;
    failCount: number;
    decision: "PASS" | "FAIL";
    maxDrawdownLimit: number;
    minTrades: number;
    rows: CandidateSeedValidationRow[];
}

export type WalkForwardLoadingMode = "analysis" | "quick" | "validation" | "permutation";

export interface WalkForwardUiHost {
    formatPermutationValue(metric: WalkForwardPermutationMetric, value: number | null): string;
    formatCandidateValidationDecision(reason: CandidateValidationDecisionReason): string;
    formatSignedPercent(value: number | null): string;
    formatNumber(value: number | null, digits?: number): string;
    formatPercent(value: number | null, digits?: number): string;
    formatBaseParamsSummary(): string | null;
    formatWindowParams(params: Record<string, number>): string;
    getPermutationTone(result: WalkForwardPermutationResult): "positive" | "negative" | "neutral";
}

export function renderWalkForwardPermutationSummary(
    dom: WalkForwardServiceDom,
    host: WalkForwardUiHost,
    result: WalkForwardPermutationResult | null,
    lastResult: WalkForwardResult | null
): void {
    const panel = dom.wfPermutationPanel;

    if (!result) {
        if (!lastResult) {
            panel.innerHTML = `
                <div class="empty-state">
                    <p>Run Walk-Forward or Quick Analysis first. This test uses the latest WFA out-of-sample trades, not the main backtest.</p>
                </div>
            `;
            return;
        }

        const tradeCount = lastResult.combinedOOSTrades.totalTrades;
        panel.innerHTML = `
            <div class="empty-state">
                <p>Latest WFA sample ready: ${tradeCount} OOS trades. Run the permutation test to estimate how often a no-edge null could score this well by chance.</p>
            </div>
        `;
        return;
    }

    const tone = host.getPermutationTone(result);
    if (result.status !== "ok") {
        panel.innerHTML = `
            <div class="wf-permutation-header">
                <div class="wf-permutation-title ${tone}">Permutation Test Unavailable</div>
                <div class="wf-permutation-note">${result.interpretation}</div>
            </div>
            <div class="wf-summary">
                <div class="wf-stat">
                    <span class="wf-label">Metric</span>
                    <span class="wf-value">${result.metricLabel}</span>
                </div>
                <div class="wf-stat">
                    <span class="wf-label">OOS Trades</span>
                    <span class="wf-value">${result.tradeCount}</span>
                </div>
                <div class="wf-stat">
                    <span class="wf-label">Min Trades</span>
                    <span class="wf-value">${result.sampleRequirement}</span>
                </div>
                <div class="wf-stat">
                    <span class="wf-label">Permutations</span>
                    <span class="wf-value">${result.permutations}</span>
                </div>
            </div>
            <div class="wf-permutation-note">${result.summary}</div>
            <div class="wf-permutation-note">${result.nullModel}</div>
        `;
        return;
    }

    panel.innerHTML = `
        <div class="wf-permutation-header">
            <div class="wf-permutation-title ${tone}">${result.interpretation}</div>
            <div class="wf-permutation-note">One-sided test on the latest walk-forward OOS sample. Robustness score remains a separate overfitting check.</div>
        </div>
        <div class="wf-summary">
            <div class="wf-stat">
                <span class="wf-label">Observed ${result.metricLabel}</span>
                <span class="wf-value">${host.formatPermutationValue(result.metric, result.observedValue)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Null Mean</span>
                <span class="wf-value">${host.formatPermutationValue(result.metric, result.nullMean)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Null Median</span>
                <span class="wf-value">${host.formatPermutationValue(result.metric, result.nullMedian)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">P-Value</span>
                <span class="wf-value ${tone}">${formatWalkForwardPermutationPValue(result.pValue)}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">OOS Trades</span>
                <span class="wf-value">${result.tradeCount}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Permutations</span>
                <span class="wf-value">${result.permutations}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Seed</span>
                <span class="wf-value">${result.seed}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Null >= Observed</span>
                <span class="wf-value">${result.betterOrEqualCount}</span>
            </div>
        </div>
        <div class="wf-permutation-note">${result.summary}</div>
        <div class="wf-permutation-note">${result.nullModel}</div>
    `;
}

export function renderWalkForwardCandidateValidationSummary(
    dom: WalkForwardServiceDom,
    host: WalkForwardUiHost,
    summary: CandidateValidationSummary | null
): void {
    const panel = dom.wfValidationPanel;

    if (!summary) {
        panel.innerHTML = `
            <div class="empty-state">
                <p>Run Validate Candidate to check 5-seed pass/fail status.</p>
            </div>
        `;
        return;
    }

    const decisionClass = summary.decision === "PASS" ? "positive" : "negative";
    const rowsHtml = summary.rows.map((row) => `
        <tr class="${row.pass ? "positive" : "negative"}">
            <td>${row.seed}</td>
            <td class="${row.pass ? "positive" : "negative"}">${host.formatCandidateValidationDecision(row.decisionReason)}</td>
            <td>${host.formatSignedPercent(row.netProfitPercent)}</td>
            <td>${host.formatNumber(row.profitFactor, 2)}</td>
            <td>${host.formatPercent(row.maxDrawdownPercent, 2)}</td>
            <td>${row.totalTrades ?? "-"}</td>
            <td>${host.formatNumber(row.robustnessScore, 0)}</td>
            <td>${row.totalWindows ?? "-"}</td>
            <td>${row.testWindow}/${row.stepSize}</td>
            <td>${row.commissionPercent.toFixed(4)}%</td>
            <td>${row.slippageBps}</td>
        </tr>
    `).join("");

    panel.innerHTML = `
        <div class="wf-validation-header">
            <div class="wf-validation-title ${decisionClass}">
                ${summary.decision} ${summary.passCount}/${summary.seeds.length} seeds
            </div>
            <div class="wf-validation-note">
                Rule: pass if >= ${summary.minPasses}/${summary.seeds.length}. Per-seed checks:
                net > 0, PF >= 1, DD <= ${summary.maxDrawdownLimit.toFixed(1)}%, trades >= ${summary.minTrades}.
            </div>
        </div>
        <div class="wf-summary">
            <div class="wf-stat">
                <span class="wf-label">Seed Passes</span>
                <span class="wf-value ${decisionClass}">${summary.passCount}/${summary.seeds.length}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Required Passes</span>
                <span class="wf-value">${summary.minPasses}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">Fail Count</span>
                <span class="wf-value negative">${summary.failCount}</span>
            </div>
            <div class="wf-stat">
                <span class="wf-label">DD Limit</span>
                <span class="wf-value">${summary.maxDrawdownLimit.toFixed(1)}%</span>
            </div>
        </div>
        <div class="wf-table-wrapper wf-validation-table-wrap">
            <table class="wf-table wf-validation-table">
                <thead>
                    <tr>
                        <th>Seed</th>
                        <th>Decision</th>
                        <th>OOS Net%</th>
                        <th>PF</th>
                        <th>Max DD%</th>
                        <th>Trades</th>
                        <th>Robust</th>
                        <th>Windows</th>
                        <th>T/S</th>
                        <th>Fee%</th>
                        <th>Slip</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml}
                </tbody>
            </table>
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
    hasLastResult: boolean
): void {
    dom.wfRunBtn.disabled = loading;
    dom.wfRunBtn.setAttribute("aria-busy", loading && mode === "analysis" ? "true" : "false");
    dom.wfQuickBtn.disabled = loading;
    dom.wfQuickBtn.setAttribute("aria-busy", loading && mode === "quick" ? "true" : "false");
    dom.wfValidateBtn.disabled = loading;
    dom.wfValidateBtn.setAttribute("aria-busy", loading && mode === "validation" ? "true" : "false");
    dom.wfPermutationBtn.disabled = loading || !hasLastResult;
    dom.wfPermutationBtn.setAttribute("aria-busy", loading && mode === "permutation" ? "true" : "false");
    dom.wfCancelBtn.style.display = loading && mode !== "permutation" ? "inline-flex" : "none";

    dom.wfSpinner.style.display = loading && mode === "analysis" ? "inline-block" : "none";
    dom.wfQuickSpinner.style.display = loading && mode === "quick" ? "inline-block" : "none";
    dom.wfValidateSpinner.style.display = loading && mode === "validation" ? "inline-block" : "none";
    dom.wfPermutationSpinner.style.display = loading && mode === "permutation" ? "inline-block" : "none";
}
