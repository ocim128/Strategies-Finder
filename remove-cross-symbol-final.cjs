const fs = require('fs');
const ts = require('typescript');
const path = require('path');
function edit(file, fn) { const old=fs.readFileSync(file,'utf8'); const next=fn(old); if(next!==old) fs.writeFileSync(file,next); }
function between(s,a,b,r='') { const i=s.indexOf(a),j=s.indexOf(b,i+a.length); if(i<0||j<0) throw Error('Missing '+a); return s.slice(0,i)+r+s.slice(j); }
function ast(file, choose) { edit(file,s=>{ const sf=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true); const edits=[]; function visit(n) { const replacement=choose(n,sf); if(replacement!==undefined) { let start=n.getStart(sf),end=n.end; if(replacement==='') { start=n.getFullStart(); if(s[end]===',')end++; } edits.push([start,end,replacement]); }else ts.forEachChild(n,visit); } visit(sf); for(const [a,b,r] of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,a)+r+s.slice(b); return s; }); }
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[]);}
const targets=['lib/finder/server/asset-opportunity-iteration.ts','lib/finder/server/finder-vite-plugin.ts','lib/finder/server/finder-asset-opportunity-batch-worker.ts','lib/finder/server/finder-universe-strategy-worker.ts','lib/finder/finder-universe-oos.ts','lib/finder/finder-runner-universe.ts','lib/finder-manager.ts'];
for(const file of targets){
 ast(file,(n,sf)=>{
  const name=n.name?.getText(sf);
  if((ts.isPropertySignature(n)||ts.isPropertyAssignment(n)||ts.isShorthandPropertyAssignment(n))&&(['providerBySymbol','loadSecondaryDataset'].includes(name)||(name==='getProvider'&&!file.endsWith('finder-manager.ts'))))return '';
  if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['providerBySymbol','providerRecord',...(file.endsWith('worker.ts')?['getProvider']:[])].includes(d.name.getText(sf))))return '';
  if(ts.isForOfStatement(n)&&n.statement.getText(sf).includes('providerBySymbol[symbol]'))return '';
  if(ts.isSpreadAssignment(n)&&n.getText(sf).includes('getProvider ?'))return '';
  if(ts.isFunctionDeclaration(n)&&['parseProviderBySymbol','resolveServerProvider'].includes(name))return '';
 });
 edit(file,s=>s.replace(/^.*(?:Mirrors the plugin.s resolveServerProvider|with a binance default|binance default instead of disabling cross-symbol fetch|worker-side getProvider mirrors|cross the worker boundary.*resolveServerProvider|Send a symbol -> provider map so|guard matches the browser.s.*classification|meaningful special-state kinds \(cross-symbol\)).*\r?\n/gm,''));
}
edit('lib/ui-manager.ts',s=>s.replace('// meaningful special-state kinds (cross-symbol); for','// special-state kinds; for'));
// Normalize edited source files to the repository's committed line endings.
const cp=require('child_process');
for(const file of cp.execFileSync('git',['diff','--name-only']).toString().trim().split('\n')) {
 if(!fs.existsSync(file)||file.includes('lib/strategies/lib/'))continue;
 const old=cp.execFileSync('git',['show','HEAD:'+file]).toString();
 if(!old.includes('\r\n'))edit(file,s=>s.replaceAll('\r\n','\n').replaceAll('\r','\n'));
}
