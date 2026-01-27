import { BacktestResult } from "../strategies/index";
import { getRequiredElement, updateTextContent, setVisible } from "../domUtils";

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

        const pfText = result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2);
        updateTextContent('profitFactor', pfText, `stat-value ${result.profitFactor >= 1 ? 'positive' : 'negative'}`);

        updateTextContent('totalTrades', result.totalTrades.toString());
        updateTextContent('maxDrawdown', `${result.maxDrawdownPercent.toFixed(2)}%`);
        updateTextContent('winningTrades', result.winningTrades.toString());
        updateTextContent('losingTrades', result.losingTrades.toString());
        updateTextContent('avgWin', `$${result.avgWin.toFixed(2)}`);
        updateTextContent('avgLoss', `$${result.avgLoss.toFixed(2)}`);

        const sharpeClass = result.sharpeRatio >= 1 ? 'positive' : result.sharpeRatio < 0 ? 'negative' : '';
        updateTextContent('sharpeRatio', result.sharpeRatio.toFixed(2), `stat-value ${sharpeClass}`);

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

    public clear() {
        setVisible('emptyResults', true);
        setVisible('resultsContent', false);
    }
}

export const resultsRenderer = new ResultsRenderer();
