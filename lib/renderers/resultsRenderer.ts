import { BacktestResult } from "../../../../../src/strategies/index";
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
    }

    public clear() {
        setVisible('emptyResults', true);
        setVisible('resultsContent', false);
    }
}

export const resultsRenderer = new ResultsRenderer();
