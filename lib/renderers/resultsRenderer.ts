import { BacktestResult, PostEntryPathStats, TradeTimingQuality } from "../strategies/index";
import { getRequiredElement, updateTextContent, setVisible } from "../dom-utils";
import { createResultsRendererDom, type ResultsRendererDom } from "./results-renderer-dom";
import { escapeHtml } from "../html-escape";
import {
    formatNullableFixed,
    formatNullablePercentPoints,
    formatNullableSignedPercentPoints,
} from "../ui-formatters";
import {
    canComputeBacktestEdgeAnalysis,
    ensureBacktestEdgeAnalysis,
} from "../backtest-edge-analysis";

export class ResultsRenderer {
    private dom: ResultsRendererDom | null = null;
    private lastRenderedResult: BacktestResult | null = null;
    private edgeAnalysisLoadingResult: BacktestResult | null = null;

    private getDom(): ResultsRendererDom {
        return this.dom ??= createResultsRendererDom();
    }

    public render(result: BacktestResult) {
        this.lastRenderedResult = result;
        setVisible('emptyResults', false);
        setVisible('resultsContent', true);

        const isProfit = result.netProfit >= 0;
        const profitClass = isProfit ? 'positive' : 'negative';
        const dom = this.getDom();

        updateTextContent('netProfit', `${isProfit ? '+' : ''}$${result.netProfit.toFixed(2)}`, `stat-value ${profitClass}`);
        dom.netProfitCard.className = `stat-card ${profitClass}`;

        updateTextContent('netProfitPct', `${isProfit ? '+' : ''}${result.netProfitPercent.toFixed(2)}%`, `stat-value ${profitClass}`);
        dom.netProfitPctCard.className = `stat-card ${profitClass}`;

        const expectancyClass = result.expectancy >= 0 ? 'positive' : 'negative';
        updateTextContent('expectancy', `${result.expectancy >= 0 ? '+' : ''}$${result.expectancy.toFixed(2)}`, `stat-value ${expectancyClass}`);

        const avgTradeClass = result.avgTrade >= 0 ? 'positive' : 'negative';
        updateTextContent('avgTrade', `${result.avgTrade >= 0 ? '+' : ''}$${result.avgTrade.toFixed(2)}`, `stat-value ${avgTradeClass}`);

        updateTextContent('winRate', `${result.winRate.toFixed(1)}%`, `stat-value ${result.winRate >= 50 ? 'positive' : 'negative'}`);

        const pfText = result.profitFactor === Infinity ? 'INF' : result.profitFactor.toFixed(2);
        updateTextContent('profitFactor', pfText, `stat-value ${result.profitFactor >= 1 ? 'positive' : 'negative'}`);

        updateTextContent('totalTrades', result.totalTrades.toString());
        updateTextContent('maxDrawdown', `${result.maxDrawdownPercent.toFixed(2)}%`);
        updateTextContent('winningTrades', result.winningTrades.toString());
        updateTextContent('losingTrades', result.losingTrades.toString());
        updateTextContent('avgWin', `$${result.avgWin.toFixed(2)}`);
        updateTextContent('avgLoss', `$${result.avgLoss.toFixed(2)}`);

        const sharpeClass = result.sharpeRatio >= 1 ? 'positive' : result.sharpeRatio < 0 ? 'negative' : '';
        updateTextContent('sharpeRatio', result.sharpeRatio.toFixed(2), `stat-value ${sharpeClass}`);

        this.renderAdvancedAnalytics(result.performanceAnalytics);
        this.renderTradeTimingQuality(result.tradeTimingQuality);
        this.renderEdgeAnalysis(result);
        this.renderPostEntryPath(result.postEntryPath);

        const entryStats = result.entryStats;
        const hasEntryStats = Boolean(entryStats);
        setVisible('entryStatsTitle', hasEntryStats);
        setVisible('entryStatsGrid', hasEntryStats, 'grid');
        setVisible('entryStatsHint', hasEntryStats);
        setVisible('entryLevels', Boolean(entryStats?.levels?.length));

        if (entryStats) {
            const useTarget = entryStats.winDefinition === 'target' && (entryStats.targetPct ?? 0) > 0;
            updateTextContent('entryAvgRetestBarsLabel', useTarget ? 'Avg Target Bars' : 'Avg Retest Bars');
            updateTextContent('entryAvgRetestsLabel', useTarget ? 'Target %' : 'Avg Retests');
            updateTextContent('entryLevelsAvgBarsHeader', useTarget ? 'Avg Target Bars' : 'Avg Retest Bars');
            updateTextContent('entryLevelsAvgRetestsHeader', useTarget ? 'Target %' : 'Avg Retests');

            updateTextContent('entryWinRate', `${entryStats.winRate.toFixed(1)}%`, `stat-value ${entryStats.winRate >= 50 ? 'positive' : 'negative'}`);
            const avgBars = useTarget ? (entryStats.avgTargetBars ?? entryStats.avgRetestBars) : entryStats.avgRetestBars;
            updateTextContent('entryAvgRetestBars', avgBars.toFixed(1));
            if (useTarget) {
                updateTextContent('entryAvgRetests', `${(entryStats.targetPct ?? 0).toFixed(2)}%`);
            } else {
                updateTextContent('entryAvgRetests', entryStats.avgRetests.toFixed(2));
            }
            updateTextContent('entryTotalEntries', entryStats.totalEntries.toString());

            const entryMode = this.formatEntryMode(entryStats.entryMode);
            const retestMode = this.formatEntryMode(entryStats.retestMode);

            const selectedLevel = entryStats.selectedLevel ?? entryStats.levels?.[entryStats.selectedLevelIndex ?? -1]?.level;
            const selectedLevelText = selectedLevel !== undefined ? this.formatLevel(selectedLevel) : 'n/a';
            const selectedIndexText = entryStats.selectedLevelIndex !== undefined ? entryStats.selectedLevelIndex.toString() : 'n/a';
            const displayTouchMode = entryStats.useWick ? 'wick' : `close +/-${entryStats.touchTolerancePct}%`;
            const winHint = useTarget
                ? `Win: +${(entryStats.targetPct ?? 0).toFixed(2)}% within ${entryStats.maxBars} bars`
                : `Win: >=${entryStats.minRetestsForWin} retest(s) within ${entryStats.maxBars} bars`;
            const retestHint = useTarget ? '' : ` | Retest: ${retestMode}`;
            const levelHint = `Selected level: ${selectedLevelText} (index ${selectedIndexText}) | ${winHint} | Entry: ${entryMode}${retestHint} | Touch: ${displayTouchMode}`;
            updateTextContent('entryStatsHint', levelHint);

            const levelsBody = dom.entryLevelsBody;
            const levels = entryStats.levels ?? [];
            if (levels.length > 0) {
                levelsBody.innerHTML = levels
                    .map((stat, index) => {
                        const rowClass = index === entryStats.selectedLevelIndex ? 'entry-levels-row is-selected' : 'entry-levels-row';
                        const winClass = stat.winRate >= 50 ? 'positive' : 'negative';
                        const avgBarsValue = useTarget
                            ? (stat.avgTargetBars ?? stat.avgRetestBars)
                            : stat.avgRetestBars;
                        const tailValue = useTarget
                            ? `${(entryStats.targetPct ?? 0).toFixed(2)}%`
                            : stat.avgRetests.toFixed(2);
                        return `
                            <div class="${rowClass}">
                                <div class="entry-levels-cell">${this.formatLevel(stat.level)}</div>
                                <div class="entry-levels-cell ${winClass}">${stat.winRate.toFixed(1)}%</div>
                                <div class="entry-levels-cell">${stat.totalEntries}</div>
                                <div class="entry-levels-cell">${avgBarsValue.toFixed(1)}</div>
                                <div class="entry-levels-cell">${tailValue}</div>
                            </div>
                        `;
                    })
                    .join('');
            } else {
                levelsBody.innerHTML = '';
            }
        }
    }

    private formatEntryMode(mode: number): string {
        if (mode === 0) return 'cross';
        if (mode === 1) return 'close';
        return 'touch';
    }

    private formatLevel(level: number): string {
        return level.toFixed(3).replace(/\.?0+$/, '');
    }

    private renderAdvancedAnalytics(analytics: BacktestResult['performanceAnalytics']): void {
        const hasAnalytics = !!analytics;
        setVisible('advancedAnalyticsTitle', hasAnalytics);
        setVisible('advancedAnalyticsContainer', hasAnalytics, 'grid');
        setVisible('advancedAnalyticsHint', hasAnalytics);
        if (!hasAnalytics || !analytics) {
            return;
        }

        const dom = this.getDom();
        const cards = [
            this.renderAdvancedAnalyticsCard('Sortino Ratio', this.formatMetricValue(analytics.sortinoRatio, 3), analytics.sortinoRatio),
            this.renderAdvancedAnalyticsCard('Calmar Ratio', this.formatMetricValue(analytics.calmarRatio, 3), analytics.calmarRatio),
            this.renderAdvancedAnalyticsCard('Sterling Ratio', this.formatMetricValue(analytics.sterlingRatio, 3), analytics.sterlingRatio),
            this.renderAdvancedAnalyticsCard('Tail Ratio', this.formatMetricValue(analytics.tailRatio, 3), analytics.tailRatio >= 1 ? 1 : -1),
            this.renderAdvancedAnalyticsCard('Skewness', this.formatMetricValue(analytics.skewness, 3), analytics.skewness),
            this.renderAdvancedAnalyticsCard('Kurtosis (Excess)', this.formatMetricValue(analytics.kurtosis, 3), analytics.kurtosis),
            this.renderAdvancedAnalyticsCard(`VaR ${analytics.confidenceLevelPct}%`, this.formatMetricValue(analytics.valueAtRisk95, 2, '%')),
            this.renderAdvancedAnalyticsCard(`CVaR ${analytics.confidenceLevelPct}%`, this.formatMetricValue(analytics.conditionalValueAtRisk95, 2, '%')),
            this.renderAdvancedAnalyticsCard('Ulcer Index', this.formatMetricValue(analytics.ulcerIndex, 2, '%')),
            this.renderAdvancedAnalyticsCard('Serenity Index', this.formatMetricValue(analytics.serenityIndex, 3), analytics.serenityIndex),
        ];

        dom.advancedAnalyticsContainer.innerHTML = cards.join('');
        dom.advancedAnalyticsHint.textContent = `Equity-return basis | CAGR ${this.formatMetricValue(analytics.cagr, 2, '%')} | RF ${this.formatMetricValue(analytics.riskFreeRateAnnual * 100, 2, '%')} | ${analytics.confidenceLevelPct}% tail metrics | ${analytics.sampleCount} return samples.`;
    }

    private renderAdvancedAnalyticsCard(label: string, value: string, directionalValue?: number): string {
        const valueClass = Number.isFinite(directionalValue as number)
            ? directionalValue! > 0
                ? 'positive'
                : directionalValue! < 0
                    ? 'negative'
                    : ''
            : '';

        return `
            <div class="stat-card">
                <div class="stat-label">${label}</div>
                <div class="stat-value ${valueClass}">${value}</div>
            </div>
        `;
    }

    private renderTradeTimingQuality(quality: TradeTimingQuality | undefined): void {
        const hasQuality = !!quality && (quality.entryScore !== null || quality.exitScore !== null);
        setVisible('tradeTimingQualityTitle', hasQuality);
        setVisible('tradeTimingQualityContainer', hasQuality);
        const dom = this.getDom();
        if (!hasQuality || !quality) {
            dom.tradeTimingQualityContainer.innerHTML = '';
            return;
        }

        const entryRows = quality.entry.horizons.map((horizon) => `
            <div class="edge-ratio-cell value">${horizon.bars} bars</div>
            <div class="edge-ratio-cell value right ${this.scoreClass(horizon.score)}">${formatNullableFixed(horizon.score, 1)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.avgMfePct, 2)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.avgMaePct, 2)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.positiveForwardRatePct, 1)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.movementConfidencePct, 1)}</div>
            <div class="edge-ratio-cell value right">${horizon.sampleSize}</div>
        `).join('');
        const exitRows = quality.exit.horizons.map((horizon) => `
            <div class="edge-ratio-cell value">${horizon.bars} bars</div>
            <div class="edge-ratio-cell value right ${this.scoreClass(horizon.score)}">${formatNullableFixed(horizon.score, 1)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.avgAvoidedAdversePct, 2)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.avgMissedContinuationPct, 2)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.adverseAfterExitRatePct, 1)}</div>
            <div class="edge-ratio-cell value right">${formatNullablePercentPoints(horizon.movementConfidencePct, 1)}</div>
            <div class="edge-ratio-cell value right">${horizon.sampleSize}</div>
        `).join('');

        dom.tradeTimingQualityContainer.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-label">Entry Score</div>
                    <div class="stat-value ${this.scoreClass(quality.entryScore)}">${formatNullableFixed(quality.entryScore, 1)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Exit Score</div>
                    <div class="stat-value ${this.scoreClass(quality.exitScore)}">${formatNullableFixed(quality.exitScore, 1)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Capture Score</div>
                    <div class="stat-value ${this.scoreClass(quality.exit.captureScore)}">${formatNullableFixed(quality.exit.captureScore, 1)}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-label">Avg Giveback</div>
                    <div class="stat-value">${formatNullablePercentPoints(quality.exit.averageGivebackPct, 2)}</div>
                </div>
            </div>

            <div class="edge-subsection">
                <div class="edge-subsection-title">Entry Timing</div>
                <div class="edge-subsection-desc">Post-entry movement from the candle after entry.</div>
                <div class="edge-ratio-grid-shell">
                    <div class="edge-ratio-grid timing-quality-grid">
                        <div class="edge-ratio-cell header">Horizon</div>
                        <div class="edge-ratio-cell header right">Score</div>
                        <div class="edge-ratio-cell header right">Avg MFE %</div>
                        <div class="edge-ratio-cell header right">Avg MAE %</div>
                        <div class="edge-ratio-cell header right">Forward +%</div>
                        <div class="edge-ratio-cell header right">Confidence</div>
                        <div class="edge-ratio-cell header right">Samples</div>
                        ${entryRows}
                    </div>
                </div>
            </div>

            <div class="edge-subsection">
                <div class="edge-subsection-title">Exit Timing</div>
                <div class="edge-subsection-desc">Post-exit movement from the candle after exit.</div>
                <div class="edge-ratio-grid-shell">
                    <div class="edge-ratio-grid timing-quality-grid">
                        <div class="edge-ratio-cell header">Horizon</div>
                        <div class="edge-ratio-cell header right">Score</div>
                        <div class="edge-ratio-cell header right">Avoided %</div>
                        <div class="edge-ratio-cell header right">Missed %</div>
                        <div class="edge-ratio-cell header right">Adverse +%</div>
                        <div class="edge-ratio-cell header right">Confidence</div>
                        <div class="edge-ratio-cell header right">Samples</div>
                        ${exitRows}
                    </div>
                </div>
                <div class="edge-composite">Capture: <span class="${this.scoreClass(quality.exit.captureScore)}">${formatNullableFixed(quality.exit.captureScore, 1)}</span> <span class="edge-composite-hint">| Avg Giveback ${formatNullablePercentPoints(quality.exit.averageGivebackPct, 2)} | ${quality.exit.captureSampleSize} samples</span></div>
            </div>
        `;
    }

    private renderPostEntryPath(postEntryPath: PostEntryPathStats | undefined): void {
        const hasStats = !!postEntryPath
            && postEntryPath.horizonBars.length > 0
            && (
                postEntryPath.win.sampleSizeByBar.some((value) => value > 0)
                || postEntryPath.lose.sampleSizeByBar.some((value) => value > 0)
                || postEntryPath.all.sampleSizeByBar.some((value) => value > 0)
                || postEntryPath.all.avgClosedTradeTimeBars !== null
            );
        setVisible('postEntryPathTitle', hasStats);
        setVisible('postEntryPathContainer', hasStats);
        if (!hasStats || !postEntryPath) {
            setVisible('postEntryPathHint', false);
            return;
        }

        const container = getRequiredElement('postEntryPathContainer');
        const sideOrder: Array<'win' | 'lose' | 'all'> = ['win', 'lose', 'all'];
        const sideLabels: Record<'win' | 'lose' | 'all', string> = {
            win: 'Win Trades',
            lose: 'Lose Trades',
            all: 'All Trades',
        };

        const barsHeader = postEntryPath.horizonBars
            .map((bar) => `<div class="post-entry-cell header">Bar +${bar}</div>`)
            .join('');

        const renderMetricRow = (label: string, values: string[]) => {
            const cells = values.map((value) => `<div class="post-entry-cell value">${value}</div>`).join('');
            return `<div class="post-entry-cell metric">${label}</div>${cells}`;
        };

        container.innerHTML = sideOrder.map((side) => {
            const stats = postEntryPath[side];
            const avgClosedBars = formatNullableFixed(stats.avgClosedTradeTimeBars, 1);
            const avgClosedMinutes = formatNullableFixed(stats.avgClosedTradeTimeMinutes, 1);
            const timeSummary = `Avg Closed: ${avgClosedBars} bars | ${avgClosedMinutes}m`;

            const avgMoves = stats.avgSignedMovePctByBar.map((value) => formatNullableSignedPercentPoints(value, 2, "--", false));
            const medMoves = stats.medianSignedMovePctByBar.map((value) => formatNullableSignedPercentPoints(value, 2, "--", false));
            const highMoves = stats.maxSignedMovePctByBar.map((value) => formatNullableSignedPercentPoints(value, 2, "--", false));
            const lowMoves = stats.minSignedMovePctByBar.map((value) => formatNullableSignedPercentPoints(value, 2, "--", false));
            const winRates = stats.positiveRatePctByBar.map((value) => formatNullablePercentPoints(value, 1));
            const samples = stats.sampleSizeByBar.map((value) => value.toString());

            return `
                <div class="post-entry-side">
                    <div class="post-entry-side-header">
                        <div class="post-entry-side-title">${sideLabels[side]}</div>
                        <div class="post-entry-side-time">${timeSummary}</div>
                    </div>
                    <div class="post-entry-grid-shell">
                        <div class="post-entry-grid">
                            <div class="post-entry-cell header">Metric</div>
                            ${barsHeader}
                            ${renderMetricRow('Avg Move %', avgMoves)}
                            ${renderMetricRow('Median %', medMoves)}
                            ${renderMetricRow('Highest %', highMoves)}
                            ${renderMetricRow('Lowest %', lowMoves)}
                            ${renderMetricRow('Positive %', winRates)}
                            ${renderMetricRow('Samples', samples)}
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        const openTrade = postEntryPath.openTradeProbability;
        const hasOpenTrade = openTrade.hasOpenTrade;
        setVisible('postEntryPathHint', hasOpenTrade);
        if (hasOpenTrade) {
            const hint = getRequiredElement('postEntryPathHint');
            const tradeType = openTrade.tradeType ? openTrade.tradeType.toUpperCase() : 'N/A';
            const moveText = formatNullableSignedPercentPoints(openTrade.signedMovePct, 2, "--", false);
            const basisText = openTrade.basisBar === null ? 'n/a' : `+${openTrade.basisBar}`;
            const barsHeldText = openTrade.barsHeld === null ? 'n/a' : openTrade.barsHeld.toString();
            const winText = formatNullablePercentPoints(openTrade.winProbabilityPct, 1);
            const loseText = formatNullablePercentPoints(openTrade.loseProbabilityPct, 1);

            if (openTrade.winProbabilityPct === null || openTrade.loseProbabilityPct === null) {
                hint.textContent = `Open trade (${tradeType}, EOD) detected. Not enough historical samples to estimate win/lose probability yet.`;
            } else {
                hint.textContent = `Open trade (${tradeType}, EOD): held ${barsHeldText} bars | basis bar ${basisText} move ${moveText} | Estimated Win ${winText} / Lose ${loseText} (matched ${openTrade.matchedSampleSize} of ${openTrade.sampleSize} historical trades).`;
            }
        }
    }

    private renderEdgeAnalysis(result: BacktestResult): void {
        const edge = result.edgeStatistics;
        const hasEdge = !!edge;
        const canLoadEdge = canComputeBacktestEdgeAnalysis(result);
        const isLoading = this.edgeAnalysisLoadingResult === result;
        const shouldShow = hasEdge || canLoadEdge;
        setVisible('edgeAnalysisTitle', shouldShow);
        setVisible('edgeAnalysisContainer', shouldShow);
        if (!shouldShow) {
            this.getDom().edgeAnalysisContainer.innerHTML = '';
            return;
        }

        const container = getRequiredElement('edgeAnalysisContainer');
        if (!hasEdge || !edge) {
            container.innerHTML = `
                <div class="edge-subsection">
                    <div class="edge-subsection-title">Edge Analysis</div>
                    <div class="edge-subsection-desc">Deferred until requested so manual backtests can finish without this extra post-processing step.</div>
                    <button class="btn btn-secondary btn-compact" type="button" data-action="compute-edge-analysis"${isLoading ? ' disabled' : ''}>
                        ${isLoading ? 'Computing Edge Analysis...' : 'Compute Edge Analysis'}
                    </button>
                </div>
            `;

            const computeButton = container.querySelector<HTMLButtonElement>('[data-action="compute-edge-analysis"]');
            if (computeButton) {
                computeButton.addEventListener('click', () => {
                    void this.loadEdgeAnalysis(result);
                }, { once: true });
            }
            return;
        }

        // ── Verdict Badge ──
        const verdictColors: Record<string, string> = {
            strong: 'edge-verdict-strong',
            moderate: 'edge-verdict-moderate',
            weak: 'edge-verdict-weak',
            none: 'edge-verdict-none',
        };
        const verdictLabels: Record<string, string> = {
            strong: '🟢 Strong Edge',
            moderate: '🟡 Moderate Edge',
            weak: '🟠 Weak Edge',
            none: '🔴 No Edge',
        };
        const verdictClass = verdictColors[edge.verdict] ?? 'edge-verdict-none';
        const verdictLabel = verdictLabels[edge.verdict] ?? 'Unknown';

        // ── Edge Ratio Table ──
        const edgeRatioRows = edge.edgeRatios.map(er => {
            const erClass = er.edgeRatio >= 1.5 ? 'positive' : er.edgeRatio >= 1.0 ? '' : 'negative';
            return `
                <div class="edge-ratio-cell value">${er.bars} bars</div>
                <div class="edge-ratio-cell value right">${er.avgMFE.toFixed(3)}%</div>
                <div class="edge-ratio-cell value right">${er.avgMAE.toFixed(3)}%</div>
                <div class="edge-ratio-cell value right ${erClass}">${er.edgeRatio.toFixed(2)}</div>
                <div class="edge-ratio-cell value right">${er.sampleSize}</div>
            `;
        }).join('');

        const compositeClass = edge.compositeEdgeRatio >= 1.5 ? 'positive'
            : edge.compositeEdgeRatio >= 1.0 ? '' : 'negative';

        // ── T-Test Card ──
        const t = edge.tTest;
        const pClass = t.isSignificant ? 'positive' : 'negative';
        const confLabel = {
            very_high: '★★★ Very High (p < 0.01)',
            high: '★★ High (p < 0.05)',
            moderate: '★ Moderate (p < 0.10)',
            low: '— Low (p ≥ 0.10)',
        }[t.confidence];
        const pDisplay = t.pValue < 0.001 ? t.pValue.toExponential(2) : t.pValue.toFixed(4);
        const tStatisticDisplay = Number.isFinite(t.tStatistic)
            ? t.tStatistic.toFixed(3)
            : (t.tStatistic > 0 ? 'INF' : '-INF');

        // ── Streak Card ──
        const s = edge.streaks;
        const clusterLabel = s.hasWinRegimeClustering
            ? '<span class="positive">✅ Win-side clustering detected</span>'
            : s.hasLossRegimeClustering
                ? '<span class="negative">⚠ Loss-side clustering detected</span>'
                : '<span class="edge-none">— Random-like streak patterns</span>';

        container.innerHTML = `
            <div class="edge-verdict-banner ${verdictClass}">
                <div class="edge-verdict-label">${verdictLabel}</div>
                <div class="edge-verdict-summary">${escapeHtml(edge.summary)}</div>
            </div>

            <div class="edge-subsection">
                <div class="edge-subsection-title">Edge Ratio (Entry Quality Proof)</div>
                <div class="edge-subsection-desc">Measures MFE vs MAE: how far price moves <em>for</em> you vs <em>against</em> you. Exit-independent.</div>
                <div class="edge-ratio-grid-shell">
                    <div class="edge-ratio-grid">
                        <div class="edge-ratio-cell header">Horizon</div>
                        <div class="edge-ratio-cell header right">Avg MFE %</div>
                        <div class="edge-ratio-cell header right">Avg MAE %</div>
                        <div class="edge-ratio-cell header right">Edge Ratio</div>
                        <div class="edge-ratio-cell header right">Samples</div>
                        ${edgeRatioRows}
                    </div>
                </div>
                <div class="edge-composite">Composite Edge Ratio: <span class="${compositeClass}">${edge.compositeEdgeRatio.toFixed(2)}</span> <span class="edge-composite-hint">(> 1.0 = edge, > 1.5 = strong)</span></div>
            </div>

            <div class="edge-subsection">
                <div class="edge-subsection-title">T-Test on Returns (Statistical Significance)</div>
                <div class="edge-subsection-desc">Tests H₀: μ=0 (no edge). Low p-value = high confidence the returns are not random luck.</div>
                <div class="edge-ttest-grid">
                    <div class="edge-ttest-item">
                        <div class="edge-ttest-label">Mean Return</div>
                        <div class="edge-ttest-value ${t.meanReturn >= 0 ? 'positive' : 'negative'}">${t.meanReturn >= 0 ? '+' : ''}${t.meanReturn.toFixed(4)}%</div>
                    </div>
                    <div class="edge-ttest-item">
                        <div class="edge-ttest-label">T-Statistic</div>
                        <div class="edge-ttest-value">${tStatisticDisplay}</div>
                    </div>
                    <div class="edge-ttest-item">
                        <div class="edge-ttest-label">P-Value</div>
                        <div class="edge-ttest-value ${pClass}">${pDisplay}</div>
                    </div>
                    <div class="edge-ttest-item">
                        <div class="edge-ttest-label">Confidence</div>
                        <div class="edge-ttest-value">${confLabel}</div>
                    </div>
                    <div class="edge-ttest-item">
                        <div class="edge-ttest-label">Samples</div>
                        <div class="edge-ttest-value">${t.sampleSize} (df=${t.degreesOfFreedom})</div>
                    </div>
                </div>
            </div>

            <div class="edge-subsection">
                <div class="edge-subsection-title">Streak Analysis (Regime Detection)</div>
                <div class="edge-subsection-desc">Compares actual win/loss streak patterns to random Bernoulli expectations.</div>
                <div class="edge-streak-grid">
                    <div class="edge-streak-item">
                        <div class="edge-streak-label">Max Win Streak</div>
                        <div class="edge-streak-value">${s.maxWinStreak} <span class="edge-streak-expected">(expected: ${s.expectedMaxWinStreak.toFixed(1)})</span></div>
                    </div>
                    <div class="edge-streak-item">
                        <div class="edge-streak-label">Max Loss Streak</div>
                        <div class="edge-streak-value">${s.maxLossStreak} <span class="edge-streak-expected">(expected: ${s.expectedMaxLossStreak.toFixed(1)})</span></div>
                    </div>
                    <div class="edge-streak-item">
                        <div class="edge-streak-label">Avg Win Streak</div>
                        <div class="edge-streak-value">${s.avgWinStreak.toFixed(2)}</div>
                    </div>
                    <div class="edge-streak-item">
                        <div class="edge-streak-label">Avg Loss Streak</div>
                        <div class="edge-streak-value">${s.avgLossStreak.toFixed(2)}</div>
                    </div>
                    <div class="edge-streak-item">
                        <div class="edge-streak-label">Win Streak Z-Score</div>
                        <div class="edge-streak-value">${s.winStreakZScore.toFixed(2)}</div>
                    </div>
                    <div class="edge-streak-item">
                        <div class="edge-streak-label">Loss Streak Z-Score</div>
                        <div class="edge-streak-value">${s.lossStreakZScore.toFixed(2)}</div>
                    </div>
                    <div class="edge-streak-item full-width">
                        <div class="edge-streak-label">Regime Clustering</div>
                        <div class="edge-streak-value">${clusterLabel}</div>
                    </div>
                </div>
            </div>
        `;
    }

    private formatMetricValue(value: number, decimals: number, suffix = ''): string {
        if (!Number.isFinite(value)) {
            if (value === Number.POSITIVE_INFINITY) return `INF${suffix}`;
            if (value === Number.NEGATIVE_INFINITY) return `-INF${suffix}`;
            return '--';
        }
        return `${value.toFixed(decimals)}${suffix}`;
    }

    private scoreClass(value: number | null | undefined): string {
        if (typeof value !== 'number' || !Number.isFinite(value)) return '';
        if (value >= 60) return 'positive';
        if (value < 40) return 'negative';
        return '';
    }

    public clear() {
        const dom = this.getDom();
        this.lastRenderedResult = null;
        this.edgeAnalysisLoadingResult = null;
        setVisible('emptyResults', true);
        setVisible('resultsContent', false);
        setVisible('advancedAnalyticsTitle', false);
        setVisible('advancedAnalyticsContainer', false);
        setVisible('advancedAnalyticsHint', false);
        dom.advancedAnalyticsContainer.innerHTML = '';
        dom.advancedAnalyticsHint.textContent = '';
        setVisible('tradeTimingQualityTitle', false);
        setVisible('tradeTimingQualityContainer', false);
        dom.tradeTimingQualityContainer.innerHTML = '';
        setVisible('postEntryPathTitle', false);
        setVisible('postEntryPathContainer', false);
        setVisible('postEntryPathHint', false);
        dom.postEntryPathContainer.innerHTML = '';
        dom.postEntryPathHint.textContent = '';

        setVisible('snapshotProfileTitle', false);
        setVisible('snapshotProfileContainer', false);

        setVisible('exitReasonTitle', false);
        setVisible('exitReasonContainer', false);
        dom.exitReasonContainer.innerHTML = '';

        setVisible('edgeAnalysisTitle', false);
        setVisible('edgeAnalysisContainer', false);
        dom.edgeAnalysisContainer.innerHTML = '';
    }

    private async loadEdgeAnalysis(result: BacktestResult): Promise<void> {
        if (this.edgeAnalysisLoadingResult === result || result.edgeStatistics) {
            return;
        }

        this.edgeAnalysisLoadingResult = result;
        if (this.lastRenderedResult === result) {
            this.renderEdgeAnalysis(result);
        }

        try {
            await ensureBacktestEdgeAnalysis(result);
        } finally {
            if (this.edgeAnalysisLoadingResult === result) {
                this.edgeAnalysisLoadingResult = null;
            }
        }

        if (this.lastRenderedResult === result) {
            this.renderEdgeAnalysis(result);
        }
    }
}

export const resultsRenderer = new ResultsRenderer();
