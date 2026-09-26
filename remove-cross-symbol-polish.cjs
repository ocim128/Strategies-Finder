const fs = require('fs');
const ts = require('typescript');
const path = require('path');
function edit(file, fn) { const old=fs.readFileSync(file,'utf8'); const next=fn(old); if(next!==old) fs.writeFileSync(file,next); }
function between(s,a,b,r='') { const i=s.indexOf(a),j=s.indexOf(b,i+a.length); if(i<0||j<0) throw Error('Missing '+a); return s.slice(0,i)+r+s.slice(j); }
function ast(file, choose) { edit(file,s=>{ const sf=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true); const edits=[]; function visit(n) { const replacement=choose(n,sf); if(replacement!==undefined) { let start=n.getStart(sf),end=n.end; if(replacement==='') { start=n.getFullStart(); if(s[end]===',')end++; } edits.push([start,end,replacement]); }else ts.forEachChild(n,visit); } visit(sf); for(const [a,b,r] of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,a)+r+s.slice(b); return s; }); }
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[]);}
for(const file of ['tests/finder-asset-opportunity-batch-parallel.spec.ts','tests/finder-date-range.spec.ts'])edit(file,s=>s.replace(/^.*providerBySymbol: null,\r?\n/gm,''));
ast('lib/finder/finder-runner-single.ts',(n,sf)=>{
 const names=['getJobData','getJobCtx','getJobPrecomputed'];
 const name=n.name?.getText(sf);
 if((ts.isPropertySignature(n)||ts.isShorthandPropertyAssignment(n)||ts.isPropertyAssignment(n))&&names.includes(name))return '';
 if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>names.includes(d.name.getText(sf))))return '';
 if(ts.isCallExpression(n)){
  const callName=ts.isPropertyAccessExpression(n.expression)?n.expression.name.text:n.expression.getText(sf);
  if(names.includes(callName))return callName==='getJobCtx'?'undefined':n.arguments[1].getText(sf);
 }
});
edit('lib/finder/server/finder-vite-plugin.ts',s=>s.replace(/                \/\/ the FINDER_ASSET_BATCH_WORKERS override\)\. The plain provider[\s\S]*?(?=                batchTaskRunnerFactory)/,'                // the FINDER_ASSET_BATCH_WORKERS override).\n').replace(/        \/\/.*provider.*\n(?=        const tasks)/,''));
for(const file of require('child_process').execFileSync('git',['-c','core.autocrlf=false','diff','--name-only']).toString().trim().split('\n')) {
 if(!fs.existsSync(file)||file.includes('lib/strategies/lib/'))continue;
 edit(file,s=>s.replaceAll('\r\n','\n').replace(/^[ \t]+$/gm,''));
}
