const fs = require('fs');
const path = require('path');

const file = path.join('lib', 'backtest-result-analysis.ts');
let content = fs.readFileSync(file, 'utf8');

const newFunctions = `

export function buildPolymarketSnapshotProfile(trades: Trade[]): SnapshotProfileStats | undefined {
    const withSnapshots = trades.filter((trade) => trade.entrySnapshot && trade.polymarketOutcome != null);
    if (withSnapshots.length < 10) return undefined;

    const winTrades = withSnapshots.filter((trade) => trade.polymarketOutcome!.isWin === true);
    const loseTrades = withSnapshots.filter((trade) => trade.polymarketOutcome!.isWin === false);

    const rows: SnapshotProfileRow[] = [];

    for (const def of SNAPSHOT_METRIC_DEFS) {
        const winValues = extractSnapshotValues(winTrades, def.key);
        const loseValues = extractSnapshotValues(loseTrades, def.key);
        const allValues = extractSnapshotValues(withSnapshots, def.key);
        if (allValues.length === 0) continue;

        const winAvg = average(winValues);
        const loseAvg = average(loseValues);
        const allAvg = average(allValues);
        const delta = winAvg !== null && loseAvg !== null ? winAvg - loseAvg : null;

        let significance: number | null = null;
        if (delta !== null && allValues.length >= 3) {
            const computedStddev = stddev(allValues);
            if (computedStddev !== null && computedStddev > 0) {
                significance = Math.abs(delta) / computedStddev;
            }
        }

        rows.push({
            key: def.key,
            label: def.label,
            winAvg,
            loseAvg,
            allAvg,
            delta,
            significance,
        });
    }

    rows.sort((a, b) => (b.significance ?? -1) - (a.significance ?? -1));

    return {
        rows,
        winSampleSize: winTrades.length,
        loseSampleSize: loseTrades.length,
    };
}

export function buildPolymarketFilterSuggestions(trades: Trade[]): import('./types/strategies').PolymarketFilterSuggestions | undefined {
    const scoredTrades = trades.filter((trade) => trade.entrySnapshot && trade.polymarketOutcome != null);
    if (scoredTrades.length < 10) return undefined;

    const isWin = (t: Trade) => t.polymarketOutcome!.isWin;
    const pmPayout = (t: Trade) => t.polymarketOutcome!.isWin 
        ? +(1 - t.polymarketOutcome!.marketEntryPrice) 
        : -t.polymarketOutcome!.marketEntryPrice;

    // We will dynamically import the analyzeTradePatterns from trade-analyzer to avoid circular dependencies or import missing errors if needed
    // Actually, in TypeScript, we can just import it. Let's add the import at the top of the file.
    return undefined; // We'll replace this whole block logic after injecting imports.
}
`;

if (!content.includes('buildPolymarketSnapshotProfile')) {
    // Add the import
    const importStr = `import { analyzeTradePatterns, runAnalysisFilterFinder } from './strategies/backtest/trade-analyzer';\nimport type { PolymarketFilterSuggestions } from './types/strategies';\n`;
    content = content.replace('import type {', importStr + 'import type {');
    
    // Add the implementation of buildPolymarketFilterSuggestions properly
    const properFunctions = newFunctions.replace('return undefined; // We\\'ll replace this whole block logic after injecting imports.', `const featureAnalyses = analyzeTradePatterns(scoredTrades, { isWin, payout: pmPayout });
    const finderResult = runAnalysisFilterFinder(scoredTrades, featureAnalyses, { isWin, payout: pmPayout });

    const baselineWins = scoredTrades.filter(isWin).length;
    const baselineWinRate = baselineWins / scoredTrades.length;
    
    let totalPayout = 0;
    for (const t of scoredTrades) {
        totalPayout += pmPayout(t);
    }
    const baselineExpectancy = totalPayout / scoredTrades.length;

    return {
        featureAnalyses,
        finderResult,
        baselineWinRate,
        baselineExpectancy
    };`);
    
    content += properFunctions;
    fs.writeFileSync(file, content);
}
