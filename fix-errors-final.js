const fs = require('fs');

let qv = fs.readFileSync('lib/quick-view.ts', 'utf8');

// The file might contain multiple occurrences of things I failed to replace
qv = qv.replace(/        void this\.buildPolymarketSnapshotSection;\n/g, '');
qv = qv.replace(/        void this\.buildPolymarketFilterSection;\n/g, '');
qv = qv.replace(/        void this\.formatSignedCurrency;\n/g, '');
qv = qv.replace(/        void this\.formatPolymarketPrice;\n/g, '');

qv = qv.replace(
    /private buildPolymarketSection\(_result: BacktestResult\): string \{\n\s+const summary = this\.getPolymarketSummary\(result\);/gm,
    `private buildPolymarketSection(result: BacktestResult): string {\n        const summary = result.polymarketTradeSummary;`
);

qv = qv.replace(
    /const timingProfileSection = summary\.timingProfile && summary\.timingProfile\.length > 0\n\s+\? this\.buildPolymarketTimingProfileSection\(summary\)\n\s+: '';/gm,
    `const timingProfileSection = '';`
);

// Formatters unused:
qv = qv.replace(/    private formatSignedCurrency\(value: number\): string \{[\s\S]*?\}\n\n/m, '');
qv = qv.replace(/    private formatPolymarketPrice\(value: number\): string \{[\s\S]*?\}\n\n/m, '');
// Type imports unused
qv = qv.replace(/import type \{ BacktestPolymarketTimingProfileEntry \} from "\.\/types\/polymarket-outcomes";\n/, '');

// Fix 'result' in resolveSelectedPolymarketEntryOffset
qv = qv.replace(/private resolveSelectedPolymarketEntryOffset\(result: BacktestResult\): number \{/, 'private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {');

fs.writeFileSync('lib/quick-view.ts', qv);

let se = fs.readFileSync('lib/strategy-ensemble-service.ts', 'utf8');
se = se.replace(
    /const totalTrades = result\.totalTrades > 0 \? result\.totalTrades : result\.trades\.length;\n\n\s+return \{\n\s+\.\.\.result,\n\s+trades: annotatedTrades,\n\s+polymarketTradeSummary: \{\n\s+seriesId: getPolymarket5mSeriesIdForSymbol\(resultContext\.symbol\) \|\| outcomes\[0\]\?\.series_id \|\| "",/m,
    `const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;\n        const existingSummary = result.polymarketTradeSummary;\n\n        return {\n            ...result,\n            trades: annotatedTrades,\n            polymarketTradeSummary: {\n                seriesId: outcomes[0]?.series_id || "",`
);
fs.writeFileSync('lib/strategy-ensemble-service.ts', se);
