import { BacktestResult, PostEntryPathStats } from "../strategies/index";
import { getRequiredElement, updateTextContent, setVisible } from "../dom-utils";

export class ResultsRenderer {
    public render(result: BacktestResult) {
        setVisible('emptyResults', false);
        setVisible('resultsContent', true);

        const isProfit = result.netProfit >= 0;
        const profitClass = isProfit ? 'positive' : 'negative';

        updateTextContent('netProfit', `${isProfit ? '+' : ''}$${result.netProfit.toFixed(2)}`, `stat-value ${profitClass}`);
        getRequiredElement('netProfitCard').className = `stat-card ${profitClass}`;

        updateTextContent('netProfitPct', `${isProfit ? '+' : ''}${result.netProfitPercent.toFixed(2)}%`, `stat-value ${profitClass}`);
        getRequiredElement('netProfitPctCard').className = `stat-card ${profitClass}`;

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

            const levelsBody = getRequiredElement('entryLevelsBody');
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
            const avgClosedBars = this.formatNumber(stats.avgClosedTradeTimeBars, 1);
            const avgClosedMinutes = this.formatNumber(stats.avgClosedTradeTimeMinutes, 1);
            const timeSummary = `Avg Closed: ${avgClosedBars} bars | ${avgClosedMinutes}m`;

            const avgMoves = stats.avgSignedMovePctByBar.map((value) => this.formatPercent(value, 2, true));
            const medMoves = stats.medianSignedMovePctByBar.map((value) => this.formatPercent(value, 2, true));
            const highMoves = stats.maxSignedMovePctByBar.map((value) => this.formatPercent(value, 2, true));
            const lowMoves = stats.minSignedMovePctByBar.map((value) => this.formatPercent(value, 2, true));
            const winRates = stats.positiveRatePctByBar.map((value) => this.formatPercent(value, 1));
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
            const moveText = this.formatPercent(openTrade.signedMovePct, 2, true);
            const basisText = openTrade.basisBar === null ? 'n/a' : `+${openTrade.basisBar}`;
            const barsHeldText = openTrade.barsHeld === null ? 'n/a' : openTrade.barsHeld.toString();
            const winText = this.formatPercent(openTrade.winProbabilityPct, 1);
            const loseText = this.formatPercent(openTrade.loseProbabilityPct, 1);

            if (openTrade.winProbabilityPct === null || openTrade.loseProbabilityPct === null) {
                hint.textContent = `Open trade (${tradeType}, EOD) detected. Not enough historical samples to estimate win/lose probability yet.`;
            } else {
                hint.textContent = `Open trade (${tradeType}, EOD): held ${barsHeldText} bars | basis bar ${basisText} move ${moveText} | Estimated Win ${winText} / Lose ${loseText} (matched ${openTrade.matchedSampleSize} of ${openTrade.sampleSize} historical trades).`;
            }
        }
    }

    private formatPercent(value: number | null, decimals: number, signed = false): string {
        if (value === null || !Number.isFinite(value)) return '--';
        const prefix = signed && value > 0 ? '+' : '';
        return `${prefix}${value.toFixed(decimals)}%`;
    }

    private formatNumber(value: number | null, decimals: number): string {
        if (value === null || !Number.isFinite(value)) return '--';
        return value.toFixed(decimals);
    }

    public clear() {
        setVisible('emptyResults', true);
        setVisible('resultsContent', false);
        setVisible('postEntryPathTitle', false);
        setVisible('postEntryPathContainer', false);
        setVisible('postEntryPathHint', false);
        const container = document.getElementById('postEntryPathContainer');
        if (container) container.innerHTML = '';
        const hint = document.getElementById('postEntryPathHint');
        if (hint) hint.textContent = '';
    }
}

export const resultsRenderer = new ResultsRenderer();
