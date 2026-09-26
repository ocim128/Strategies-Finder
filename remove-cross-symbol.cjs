const fs = require('fs');
const ts = require('typescript');
const path = require('path');
function edit(file, fn) { const old=fs.readFileSync(file,'utf8'); const next=fn(old); if(next!==old) fs.writeFileSync(file,next); }
function between(s,a,b,r='') { const i=s.indexOf(a),j=s.indexOf(b,i+a.length); if(i<0||j<0) throw Error('Missing '+a); return s.slice(0,i)+r+s.slice(j); }
function ast(file, choose) { edit(file,s=>{ const sf=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true); const edits=[]; function visit(n) { const replacement=choose(n,sf); if(replacement!==undefined) { let start=n.getStart(sf),end=n.end; if(replacement==='') { start=n.getFullStart(); if(s[end]===',')end++; } edits.push([start,end,replacement]); }else ts.forEachChild(n,visit); } visit(sf); for(const [a,b,r] of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,a)+r+s.slice(b); return s; }); }
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[]);}
const removedProperties=new Set(['crossSymbolConfig','crossSymbolSecondary','crossSymbol','crossSymbolInput','crossSymbolDataset','secondaryDatasetRef','secondaryCandleCount']);
const removedFunctions=new Set(['extractCrossSymbolInput','resolveEndpointCrossSymbolDataset','mergeStrategyExecutionContext']);
for(const file of [...files('lib'),...files('tests'), 'strategyRegistry.ts']) {
 if(/cross-symbol-(runtime|helpers|ui|dom)/.test(file))continue;
 ast(file,(n,sf)=>{
  const name=n.name?.getText(sf);
  if(ts.isImportDeclaration(n)&&/cross-symbol-(runtime|ui|dom)/.test(n.moduleSpecifier.text))return '';
  if(ts.isInterfaceDeclaration(n)&&['CrossSymbolConfig','CrossSymbolRuntimeContext','BacktestCrossSymbolDatasetRequest'].includes(name))return '';
  if(ts.isFunctionDeclaration(n)&&removedFunctions.has(name))return '';
  if((ts.isPropertySignature(n)||ts.isPropertyAssignment(n))&&removedProperties.has(name))return '';
  if(ts.isParameter(n)&&['crossSymbolInput','crossSymbolDataset','crossSymbolContextMap'].includes(name))return '';
  if(ts.isIfStatement(n)&&/^(strategy|exitStrategy)\??\.crossSymbolConfig$/.test(n.expression.getText(sf)))return '';
 });
}
edit('lib/backtest-executor.ts',s=>between(s,'    // --- Cross-symbol resolution ---','    const backtestData', '    const effectiveData = ohlcvData;\n    const executionContext = req.strategyExecutionContext;\n\n').replaceAll('crossSymbolContext','executionContext'));
for(const file of ['lib/finder/server/server-asset-is-search.ts','lib/finder/finder-asset-opportunity-runner.ts','lib/finder/finder-asset-candidate-execution.ts','lib/backtest-executor.ts']) {
 edit(file,s=>s.replace(/^.*(?:&& !.*crossSymbolConfig|&& !.*dataFetcher|&& !req.crossSymbolInput|dataFetcher\?: CrossSymbolDataFetcher|dataFetcher: args.dataFetcher|\.\.\.\(args.dataFetcher|\.\.\.\(input.dataFetcher).*\r?\n/gm,''));
}
ast('lib/finder/server/server-asset-is-search.ts',(n,sf)=>ts.isIfStatement(n)&&n.expression.getText(sf).includes('selectedStrategy.strategy.crossSymbolConfig')?'':undefined);
edit('lib/finder/finder-asset-opportunity-runner.ts',s=>s.replace('isCrossSymbolStrategy: Boolean(selectedStrategy.strategy.crossSymbolConfig),','isCrossSymbolStrategy: false,').replace('crossSymbol: Boolean(input.dataFetcher || selectedStrategy.strategy.crossSymbolConfig),','crossSymbol: false,').replace('hasExternalDataFetcher: Boolean(input.dataFetcher),','hasExternalDataFetcher: false,').replace('...(args.strategy.crossSymbolConfig ? {} : { closedCandleDataOverride: args.data }),','closedCandleDataOverride: args.data,'));
edit('lib/finder/server/asset-opportunity-iteration.ts',s=>between(s,'    const secondaryDataCache =','    // Server-safe IS search.', '    const rustCapabilities = input.rustCapabilities;\n\n').replace(/^.*\.\.\.\(assetDataFetcher.*\r?\n/gm,''));
edit('lib/finder/finder-strategy-quality.ts',s=>between(s,'    const dataFetcher:','    let loadedSymbols'));
edit('lib/finder/finder-universe-oos.ts',s=>between(s,'        const crossSymbolDataFetcher =','        for (const symbolResult').replaceAll('crossSymbolDataFetcher ? undefined : ','').replace(/^.*dataFetcher: crossSymbolDataFetcher,\r?\n/gm,''));
edit('lib/finder/finder-runner-universe.ts',s=>between(s,'    let crossSymbolDataFetcher:','    callbacks.setProgress').replace('    const hasCrossSymbol = Boolean(input.selectedStrategy.strategy.crossSymbolConfig);','').replace('if (!hasCrossSymbol) {','{').replace('const requiresCompositeEdgeRatio = !hasCrossSymbol\n        && ','const requiresCompositeEdgeRatio = ').replace('const requiresCompositeEdgeRatio = !hasCrossSymbol\r\n        && ','const requiresCompositeEdgeRatio = ').replace(/^.*&& !hasCrossSymbol\r?\n/gm,'').replaceAll('hasCrossSymbol ? undefined : ','').replace(/^.*dataFetcher: crossSymbolDataFetcher,\r?\n/gm,''));
for(const file of ['lib/finder/finder-runner-single.ts','lib/finder/finder-runner-genetic.ts']) {
 edit(file,s=>between(s,'let dataManagerModulePromise:',file.includes('single')?'type FinderCandidateForEnrichment':'export async function'));
}
edit('lib/finder/finder-runner-genetic.ts',s=>between(s,'        // Resolve cross-symbol context','        let optimization;', '        const geneticData = closedData;\n        const geneticCtx: StrategyExecutionContext | undefined = undefined;\n\n'));
edit('lib/finder/finder-runner-single.ts',s=>between(s,'    const crossSymbolFailedKeys =','    callbacks.setProgress(10',`    const getJobData = (_job: ParamJob, defaultData: OHLCVData[]): OHLCVData[] => defaultData;
    const getJobCtx = (_job: ParamJob): StrategyExecutionContext | undefined => undefined;
    const getJobPrecomputed = (_job: ParamJob, defaultPrecomputed: ReturnType<typeof precomputeIndicators>): ReturnType<typeof precomputeIndicators> => defaultPrecomputed;

`).replace('crossSymbolContextMap.get(candidate.key)?.data ?? closedData','closedData').replace(/^.*isCrossSymbolJobSkipped.*\r?\n/gm,'').replace(/^\s*crossSymbolContextMap\r?\n/gm,'').replace('const csEntry = crossSymbolContextMap?.get(candidate.key);','').replace('csEntry?.data ?? closedData','closedData').replace('csEntry?.ctx','undefined').replace('csEntry?.precomputed ?? precomputed','precomputed'));
edit('lib/walk-forward-service.ts',s=>s.replace('let effectiveData = data;','const effectiveData = data;').replace(/crossSymbolCtx/g,'executionContext'));
edit('lib/finder/finder-runner-core.ts',s=>between(s,'    const cacheParts = [strategyKey];','    if (!byStrategy.has(cacheKey))', '    const cacheKey = strategyKey;\n'));
for(const file of ['lib/backtest-service.ts','lib/backtest-endpoint-facade.ts','lib/finder/finder-strategy-quality.ts']) edit(file,s=>s.replace(/^\s*dataFetcher(?:: dataManager)?,\r?\n/gm,''));
for(const file of ['lib/backtest-endpoint-plugin.ts','lib/backtest-endpoint-facade.ts']){
 ast(file,(n,sf)=>{
  if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>/^(crossSymbolInput|crossSymbolDataset)$/.test(d.name.getText(sf))))return '';
  if(ts.isIfStatement(n)&&n.expression.getText(sf).startsWith('crossSymbolInput &&'))return '';
 });
 edit(file,s=>s.replace(/^\s*crossSymbolInput \?\? undefined,\r?\n/gm,'').replace('snapshot, baseUrl, candles, crossSymbolDataset','snapshot, baseUrl, candles').replace(/snapshot, candles, crossSymbolDataset \? \{[\s\S]*?\} : undefined\)/,'snapshot, candles)'));
}
edit('lib/backtest-endpoint-execution.ts',s=>s.replace(/^\s*crossSymbolInput\r?\n/gm,''));
edit('lib/backtest-endpoint-copy.ts',s=>s.replace(/^.*let secondaryUpload:.*\r?\n/gm,'').replace(/        if \(crossSymbolDataset\) \{[\s\S]*?\n        \}\r?\n/,'').replace(/,\r?\n\s*(?:secondaryUpload && crossSymbolDataset|crossSymbolDataset)\r?\n\s*\? \{[\s\S]*?: undefined/g,'').replace('datasetUploaded: !crossSymbolDataset || secondaryUpload !== null,','datasetUploaded: true,'));
for(const file of ['lib/alert-subscription-utils.ts','lib/confirmation-signal-filter.ts'])edit(file,s=>s.replace(/^.*crossSymbolConfig.*\r?\n/gm,''));
edit('lib/app-bootstrap.ts',s=>s.replace(/^.*initCrossSymbolUI.*\r?\n/gm,''));
edit('lib/settings-model.ts',s=>s.replace(/    \/\/ Cross-symbol\r?\n/g,'').replace(/    normalized\.crossSymbolSecondary =[\s\S]*?: '';\r?\n/,''));
edit('lib/rust-settings-sanitizer.ts',s=>s.replace(/^.*"crossSymbolSecondary".*\r?\n/gm,''));
edit('scripts/strategy-manifest-generator.ts',s=>s.replace(/^.*crossSymbolConfig.*\r?\n/gm,''));
for(const file of ['lib/finder-manager.ts']){
 ast(file,(n,sf)=>ts.isForOfStatement(n)&&n.getText(sf).includes('resolveCrossSymbolSecondaryForStrategy')?'':undefined);
 edit(file,s=>s.replace(/^.*const allStrategies = \[\.\.\.selectedStrategies.*\r?\n/gm,''));
}
for(const file of ['lib/cross-symbol-runtime.ts','lib/cross-symbol-ui.ts','lib/cross-symbol-dom.ts','lib/strategies/lib/cross-symbol-helpers.ts','tests/cross-symbol-runtime.spec.ts','tests/cross-symbol-helpers.spec.ts','docs/cross-symbol.md'])fs.unlinkSync(file);
