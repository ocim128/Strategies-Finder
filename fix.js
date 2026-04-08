const fs = require('fs');

function replaceInFile(path, regex, repl) {
    if (!fs.existsSync(path)) return;
    let content = fs.readFileSync(path, 'utf8');
    content = content.replace(regex, repl);
    fs.writeFileSync(path, content, 'utf8');
}

// 1. backtest-executor.ts
let be = fs.readFileSync('lib/backtest-executor.ts', 'utf8');
be = be.replace(/import \{ annotateBacktestResultWithPolymarketOutcomes \} from "\.\/polymarket-trade-annotations";\\r?\\n/, '');
be = be.replace(/async function annotatePolymarketResult\\(\[\\s\\S\]*?\\): Promise<BacktestResult> \\{[\\s\\S]*?return result;\\r?\\n    \\}\\r?\\n\\}/, 
\sync function annotatePolymarketResult(
    result: BacktestResult,
    _chartData: any,
    _settings: any
): Promise<BacktestResult> {
    return result;
}\);
fs.writeFileSync('lib/backtest-executor.ts', be);

// 2. ensemble-signal-recipes.ts
replaceInFile('lib/ensemble-signal-recipes.ts', /captureSnapshots: true,?\\r?\\n/g, '');

// 3. strategy-ensemble-engine.ts
replaceInFile('lib/strategy-ensemble-engine.ts', /captureSnapshots: true,?\\r?\\n/g, '');

// 4. strategy-ensemble-service.ts
replaceInFile('lib/strategy-ensemble-service.ts', /import.*backtest-result-analysis.*;\\r?\\n/g, '');

// 5. scripts/
const scripts = fs.readdirSync('scripts');
scripts.forEach(s => {
    if (s.endsWith('.ts')) {
        replaceInFile('scripts/' + s, /captureSnapshots: true,?\\r?\\n/g, '');
    }
});

// 6. rust-settings-sanitizer.ts
let rss = fs.readFileSync('lib/rust-settings-sanitizer.ts', 'utf8');
rss = rss.replace(/\\|\\s*"snapshot\[A-Za-z0-9_\]+"/g, '');
rss = rss.replace(/\\|\\s*"captureSnapshots"/g, '');
rss = rss.replace(/"snapshot\[A-Za-z0-9_\]+"\s*:\\s*\[a-z_\]+,?\\r?\\n/g, '');
rss = rss.replace(/"captureSnapshots"\s*:\\s*\[a-z_\]+,?\\r?\\n/g, '');
fs.writeFileSync('lib/rust-settings-sanitizer.ts', rss);

// 7. strategies/backtest/backtest-utils.ts
let bu = fs.readFileSync('lib/strategies/backtest/backtest-utils.ts', 'utf8');
bu = bu.replace(/snapshot\[A-Za-z0-9_\]+:\\s*settings\\.snapshot\[A-Za-z0-9_\]+,?\\r?\\n/g, '');
fs.writeFileSync('lib/strategies/backtest/backtest-utils.ts', bu);

// 8. strategies/backtest/trade-filters.ts
replaceInFile('lib/strategies/backtest/trade-filters.ts', /import.*snapshot-derived-metrics.*;\\r?\\n/g, '');

// 9. scanner/scanner-engine.ts
replaceInFile('lib/scanner/scanner-engine.ts', /captureSnapshots: true,?\\r?\\n/g, '');

// 10. renderers/resultsRenderer.ts
replaceInFile('lib/renderers/resultsRenderer.ts', /,\\s*SnapshotProfileStats/g, '');
let rr = fs.readFileSync('lib/renderers/resultsRenderer.ts', 'utf8');
rr = rr.replace(/if \\(row\\.snapshotProfile\\) \\{[\\s\\S]*?\\}\\r?\\n/g, '');
fs.writeFileSync('lib/renderers/resultsRenderer.ts', rr);

// 11. quick-view.ts
let qv = fs.readFileSync('lib/quick-view.ts', 'utf8');
qv = qv.replace(/,\\s*TradeSnapshot/g, '');
qv = qv.replace(/import.*backtest-result-analysis.*;\\r?\\n/g, '');
qv = qv.replace(/import.*polymarket-diagnostics-utils.*;\\r?\\n/g, '');
qv = qv.replace(/this\\._renderSnapshotProfile\\(analysis\\);\\r?\\n/g, '');
qv = qv.replace(/this\\._renderFilterSuggestions\\(analysis\\);\\r?\\n/g, '');
qv = qv.replace(/private _renderSnapshotProfile\\([\\s\\S]*?\\}\\r?\\n    \\}\\r?\\n/g, '');
qv = qv.replace(/private _renderFilterSuggestions\\([\\s\\S]*?\\}\\r?\\n    \\}\\r?\\n/g, '');
qv = qv.replace(/a\\.polymarketFilterSuggestions/g, '[] /* removed */');
qv = qv.replace(/r\\.polymarketSnapshotProfile/g, 'null /* removed */');
qv = qv.replace(/const snapshot = trade\\.entrySnapshot;\\r?\\n\\s*if \\(snapshot\\) \\{[\\s\\S]*?\\}\\r?\\n/g, '');
fs.writeFileSync('lib/quick-view.ts', qv);

// 12. polymarket-panel-service.ts
let pps = fs.readFileSync('lib/polymarket-panel-service.ts', 'utf8');
pps = pps.replace(/,\\s*TradeSnapshot/g, '');
pps = pps.replace(/import.*backtest-result-analysis.*;\\r?\\n/g, '');
pps = pps.replace(/import.*polymarket-diagnostics-utils.*;\\r?\\n/g, '');
pps = pps.replace(/private _renderSnapshotProfile\\([\\s\\S]*?\\}\\r?\\n    \\}\\r?\\n/g, '');
pps = pps.replace(/private _renderFilterSuggestions\\([\\s\\S]*?\\}\\r?\\n    \\}\\r?\\n/g, '');
pps = pps.replace(/this\\._renderSnapshotProfile\\(analysis\\);\\r?\\n/g, '');
pps = pps.replace(/this\\._renderFilterSuggestions\\(analysis\\);\\r?\\n/g, '');
pps = pps.replace(/analysis\\.polymarketFilterSuggestions/g, '[] /* removed */');
pps = pps.replace(/analysis\\.polymarketSnapshotProfile/g, 'null /* removed */');
fs.writeFileSync('lib/polymarket-panel-service.ts', pps);

console.log('done');
