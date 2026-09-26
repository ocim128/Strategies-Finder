const fs = require('fs');
const ts = require('typescript');
const path = require('path');
function edit(file, fn) { const old=fs.readFileSync(file,'utf8'); const next=fn(old); if(next!==old) fs.writeFileSync(file,next); }
function between(s,a,b,r='') { const i=s.indexOf(a),j=s.indexOf(b,i+a.length); if(i<0||j<0) throw Error('Missing '+a); return s.slice(0,i)+r+s.slice(j); }
function ast(file, choose) { edit(file,s=>{ const sf=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true); const edits=[]; function visit(n) { const replacement=choose(n,sf); if(replacement!==undefined) { let start=n.getStart(sf),end=n.end; if(replacement==='') { start=n.getFullStart(); if(s[end]===',')end++; } edits.push([start,end,replacement]); }else ts.forEachChild(n,visit); } visit(sf); for(const [a,b,r] of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,a)+r+s.slice(b); return s; }); }
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[]);}
edit('lib/finder/server/server-asset-is-search.ts',s=>s.replace(/        throw new Error\(\r?\n            `Cross-symbol strategy[\s\S]*?\n    \}\r?\n/,''));
edit('lib/backtest-executor.ts',s=>between(s,'    let alignedCrossSymbolContext','    const signalGenerationStartedAt'));
edit('lib/finder/finder-runner-genetic.ts',s=>s.replace('export async function runGeneticFinder', 'export interface GeneticFinderRunParams {\n    input: FinderRunInput;\n    callbacks: FinderRunCallbacks;\n    capitalSettings: CapitalSettings;\n}\n\nexport async function runGeneticFinder'));
edit('lib/alert-subscription-utils.ts',s=>s.replace('    if (!strategy) return false;','    return strategy !== undefined;'));
ast('strategyRegistry.ts',(n,sf)=>ts.isIfStatement(n)&&/crossSymbolConfig|kind === "cross-symbol"/.test(n.expression.getText(sf))?'':undefined);
edit('strategyRegistry.ts',s=>s.replace('"cross-symbol" | "standard"','"standard"').replace('getStrategyKind(key: string, strategy?: Strategy)','getStrategyKind(_key: string, _strategy?: Strategy)').replace('    const meta = getBuiltInStrategyMeta(key);','').replace('getStrategyKindTitle(kind: StrategyKind)','getStrategyKindTitle(_kind: StrategyKind)'));
ast('lib/backtest-endpoint-plugin.ts',(n,sf)=>ts.isIfStatement(n)&&n.expression.getText(sf)==='req.crossSymbol'?'':undefined);
edit('lib/backtest-endpoint-plugin.ts',s=>s.replace(/^.*BacktestCrossSymbolDatasetRequest,\r?\n/gm,''));
ast('lib/backtest-settings-dom-contract.ts',(n,sf)=>ts.isCallExpression(n)&&n.expression.getText(sf)==='createField'&&n.arguments[0]?.text==='crossSymbolSecondary'?'':undefined);
edit('html-partials/tab-settings-section-execution.html',s=>s.replace(/            <!-- Cross-Symbol Secondary -->[\s\S]*?            <\/div>\r?\n            <\/div>\r?\n/,''));
edit('tests/feature-dom-contracts.spec.ts',s=>s.replace(/^.*CROSS_SYMBOL.*\r?\n/gm,''));
ast('lib/finder/finder-asset-opportunity-runner.ts',(n,sf)=>{
 if((ts.isPropertySignature(n)||ts.isPropertyAssignment(n))&&['hasExternalDataFetcher','isCrossSymbolStrategy','crossSymbol'].includes(n.name?.getText(sf)))return '';
 if(ts.isIfStatement(n)&&/args\.(hasExternalDataFetcher|isCrossSymbolStrategy)/.test(n.expression.getText(sf)))return '';
});
edit('lib/finder/finder-asset-opportunity-runner.ts',s=>s.replace(/^.*\|\| args.crossSymbol.*\r?\n/gm,''));
edit('lib/strategies/walk-forward.ts',s=>s.replace(/crossSymbolCtx/g,'executionContext').replace(/    const windowCtx: StrategyExecutionContext \| undefined = context.bufferedSecondaryData[\s\S]*?: undefined;/,'    const windowCtx = executionContext;').replace(/^.*const secondaryData = executionContext.*\r?\n/gm,'').replaceAll(', executionContext?.crossSymbol?.secondaryData','').replaceAll(', secondaryData)',')').replace(/^.*secondaryData\?: OHLCVData\[\].*\r?\n/gm,'').replace(/    const bufferedSecondaryData = secondaryData[\s\S]*?: undefined;\r?\n/,'').replace(/^.*bufferedSecondaryData[?:,].*\r?\n/gm,''));
for(const file of files('tests')) {
 if(!/crossSymbol|cross-symbol|CrossSymbol/.test(fs.readFileSync(file,'utf8')))continue;
 ast(file,(n,sf)=>{
  if(ts.isExpressionStatement(n)&&ts.isCallExpression(n.expression)&&['it','test'].includes(n.expression.expression.getText(sf))&&/crossSymbol|cross-symbol|CrossSymbol/.test(n.getText(sf)))return '';
 });
 edit(file,s=>s.replace('strategyManifest.find((entry) => !entry.strategy.crossSymbolConfig)','strategyManifest[0]').replace(/^\s*!entry.strategy.crossSymbolConfig\r?\n\s*&& /gm,'    '));
}
edit('tests/strategies-lib/prepared-execution-parity.spec.ts',s=>between(s,'function buildExecutionContext','function assertPreparedParity').replace('const executionContext = buildExecutionContext(strategy, bars);','const executionContext = undefined;'));
