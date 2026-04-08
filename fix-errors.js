const fs = require('fs');

// 1. Fix lib/quick-view.ts
let qv = fs.readFileSync('lib/quick-view.ts', 'utf8');

// Remove QuickViewPolymarketSummary unused type
qv = qv.replace(/type QuickViewPolymarketSummary = \{[\s\S]*?\n\};\n/m, '');

// Fix 'result' in resolveSelectedPolymarketEntryOffset
qv = qv.replace(/private resolveSelectedPolymarketEntryOffset\(result: BacktestResult\): number \{/, 'private resolveSelectedPolymarketEntryOffset(_result: BacktestResult): number {');

// Remove the void this.xxx lines
qv = qv.replace(/        void this\.buildPolymarketSnapshotSection;\n/g, '');
qv = qv.replace(/        void this\.buildPolymarketFilterSection;\n/g, '');
qv = qv.replace(/        void this\.formatSignedCurrency;\n/g, '');
qv = qv.replace(/        void this\.formatPolymarketPrice;\n/g, '');

// Fix buildPolymarketSection
qv = qv.replace(
    /private buildPolymarketSection\(_result: BacktestResult\): string \{\n\s+const summary = this\.getPolymarketSummary\(result\);/m,
    `private buildPolymarketSection(result: BacktestResult): string {\n        const summary = result.polymarketTradeSummary;`
);

// Fix timingProfileSection
qv = qv.replace(
    /const timingProfileSection = summary\.timingProfile && summary\.timingProfile\.length > 0\n\s+\? this\.buildPolymarketTimingProfileSection\(summary\)\n\s+: '';/m,
    `const timingProfileSection = '';`
);

fs.writeFileSync('lib/quick-view.ts', qv);

// 2. Fix lib/strategy-ensemble-service.ts
let se = fs.readFileSync('lib/strategy-ensemble-service.ts', 'utf8');

se = se.replace(
    /const totalTrades = result\.totalTrades > 0 \? result\.totalTrades : result\.trades\.length;\n\n\s+return \{\n\s+\.\.\.result,\n\s+trades: annotatedTrades,\n\s+polymarketTradeSummary: \{\n\s+seriesId: getPolymarket5mSeriesIdForSymbol\(resultContext\.symbol\) \|\| outcomes\[0\]\?\.series_id \|\| "",/m,
    `const totalTrades = result.totalTrades > 0 ? result.totalTrades : result.trades.length;\n        const existingSummary = result.polymarketTradeSummary;\n\n        return {\n            ...result,\n            trades: annotatedTrades,\n            polymarketTradeSummary: {\n                seriesId: outcomes[0]?.series_id || "",`
);

fs.writeFileSync('lib/strategy-ensemble-service.ts', se);
