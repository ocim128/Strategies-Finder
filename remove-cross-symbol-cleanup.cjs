const fs = require('fs');
const ts = require('typescript');
const path = require('path');
function edit(file, fn) { const old=fs.readFileSync(file,'utf8'); const next=fn(old); if(next!==old) fs.writeFileSync(file,next); }
function between(s,a,b,r='') { const i=s.indexOf(a),j=s.indexOf(b,i+a.length); if(i<0||j<0) throw Error('Missing '+a); return s.slice(0,i)+r+s.slice(j); }
function ast(file, choose) { edit(file,s=>{ const sf=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true); const edits=[]; function visit(n) { const replacement=choose(n,sf); if(replacement!==undefined) { let start=n.getStart(sf),end=n.end; if(replacement==='') { start=n.getFullStart(); if(s[end]===',')end++; } edits.push([start,end,replacement]); }else ts.forEachChild(n,visit); } visit(sf); for(const [a,b,r] of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,a)+r+s.slice(b); return s; }); }
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[]);}
for(const file of ['lib/backtest-endpoint-facade.ts','lib/backtest-service.ts'])edit(file,s=>s.replace(/^import.*dataManager.*\r?\n/gm,'').replace(file.includes('facade')?/^import.*strategyRegistry.*\r?\n/gm:/$^/,''));
for(const [file,name] of [['lib/backtest-endpoint-plugin.ts','extractDatasetFromPayload'],['lib/backtest-settings-resolver.ts','readString']])ast(file,(n,sf)=>ts.isFunctionDeclaration(n)&&n.name?.text===name?'':undefined);
edit('lib/finder/finder-asset-opportunity-runner.ts',s=>s.replace(/^.*dataFetcher: input.dataFetcher,\r?\n/gm,'').replace('const boundedNextExitOosReplayData = !input.dataFetcher\n                && ','const boundedNextExitOosReplayData = ').replace('const boundedNextExitOosReplayData = !input.dataFetcher\r\n                && ','const boundedNextExitOosReplayData = '));
ast('strategyRegistry.ts',(n,sf)=>ts.isIfStatement(n)&&n.expression.getText(sf)==='context?.crossSymbol'?'':undefined);
for(const file of ['tests/backtest-endpoint-plugin.spec.ts']){
 ast(file,(n,sf)=>{
  if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>d.name.getText(sf).startsWith('crossSymbol')))return '';
  if(ts.isExpressionStatement(n)&&n.getText(sf).startsWith('builtInStrategies[crossSymbolStrategyKey]'))return '';
 });
}
edit('scripts/audit-prepared-strategies.ts',s=>s.replace(/^.*family: "cross-symbol-relative".*\r?\n/gm,'').replace('|buildRollingPairCorrelation',''));
edit('archive/prompt.txt',s=>s.replace(/CROSS-SYMBOL STRATEGIES[\s\S]*?(?=\n[A-Z][A-Z /_-]{5,}\r?\n|$)/,''));
for(const file of ['docs/backtest-endpoint.md','docs/strategy-authoring.md'])edit(file,s=>s.replace(/^#{2,3} Cross-Symbol[^\n]*\r?\n[\s\S]*?(?=^#{1,3} |$(?![\s\S]))/gm,'').replace(/^.*[Cc]ross-symbol.*\r?\n/gm,''));
edit('docs/README.md',s=>s.replace(/^.*cross-symbol.md.*\r?\n/gm,''));
edit('docs/backtest-engines-typescript-rust.md',s=>s.replace(', cross-symbol context','').replace('handles\r\n  cross-symbol context, generates','generates').replace('handles\n  cross-symbol context, generates','generates').replace(/^.*cross-symbol data resolution.*\r?\n/gm,'').replace('  cross-symbol strategies, or exit overrides.','  or exit overrides.'));
for(const file of files('tests'))edit(file,s=>s.replaceAll('non-cross-symbol strategy','strategy'));
edit('tests/backtest-endpoint-plugin.spec.ts',s=>s.replace(/^import.*builtInStrategies.*\r?\n/gm,''));
edit('tests/strategies-lib/prepared-execution-parity.spec.ts',s=>s.replace(', StrategyExecutionContext',''));
edit('archive/prompt.txt',s=>s.replace(', or cross-symbol anchor','').replace(/^.*Cross-symbol relative alignment.*\r?\n/gm,''));
edit('docs/strategy-authoring.md',s=>s.replace(' Do not declare `crossSymbolConfig` for a synthetic-pair strategy.',''));
for(const file of files('lib')) {
 if(file.includes('strategies'+path.sep+'lib'+path.sep))continue;
 edit(file,s=>s.replace('Primary symbol name. Used for cross-symbol resolution.','Primary symbol name used by callers to identify the dataset.').replace(/     \* Closed-candle view the executor should use\. Omitted for cross-symbol\r?\n     \* strategies \(the cross-symbol runtime owns its closed view\)\./,'     * Closed-candle view the executor should use.').replace(/^.*Shared secondary-data resolver for cross-symbol replay parity.*\r?\n/gm,'').replace(/    \/\/ window\. Cross-symbol strategies stay on the exact full-data path because\r?\n    \/\/ their secondary alignment has no equivalent bounded-window contract\./,'    // window.').replace('Optional cross-symbol execution context','Optional strategy execution context').replace('config source, cross-symbol guards, polarity','config source, polarity').replace('for cross-symbol, synthetic-pair, exit-override','for synthetic-pair, exit-override').replace('pull the cross-symbol median','pull the universe median').replace(/^.*Cross-symbol resolution: resolve once.*\r?\n/gm,'').replace(/    \/\/ active sort requests it, and only for non-cross-symbol runs where we have\r?\n    \/\/ a clean closed-candle series matching what the backtest ran on\./,'    // active sort requests it, using the closed-candle series the backtest ran on.').replace('settings (with interval forced in), and the cross-symbol data fetcher','settings (with interval forced in)').replace(/    \/\/ indicator\/prepared-data caches\. Cross-symbol runs keep the raw slice\r?\n[^\n]*\n/,'    // indicator/prepared-data caches.\n'));
}
