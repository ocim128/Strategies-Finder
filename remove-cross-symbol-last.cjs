const fs = require('fs');
const ts = require('typescript');
const path = require('path');
function edit(file, fn) { const old=fs.readFileSync(file,'utf8'); const next=fn(old); if(next!==old) fs.writeFileSync(file,next); }
function between(s,a,b,r='') { const i=s.indexOf(a),j=s.indexOf(b,i+a.length); if(i<0||j<0) throw Error('Missing '+a); return s.slice(0,i)+r+s.slice(j); }
function ast(file, choose) { edit(file,s=>{ const sf=ts.createSourceFile(file,s,ts.ScriptTarget.Latest,true); const edits=[]; function visit(n) { const replacement=choose(n,sf); if(replacement!==undefined) { let start=n.getStart(sf),end=n.end; if(replacement==='') { start=n.getFullStart(); if(s[end]===',')end++; } edits.push([start,end,replacement]); }else ts.forEachChild(n,visit); } visit(sf); for(const [a,b,r] of edits.sort((a,b)=>b[0]-a[0]))s=s.slice(0,a)+r+s.slice(b); return s; }); }
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):x.name.endsWith('.ts')?[path.join(dir,x.name)]:[]);}
for(const file of ['lib/walk-forward-service.ts','lib/strategies/walk-forward.ts']) {
 ast(file,(n,sf)=>{
  const name=n.name?.getText(sf);
  if((ts.isPropertySignature(n)||ts.isParameter(n)||ts.isShorthandPropertyAssignment(n)||ts.isBindingElement(n))&&name==='executionContext')return '';
  if(ts.isImportSpecifier(n)&&name==='StrategyExecutionContext')return '';
  if(ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['executionContext','windowCtx'].includes(d.name.getText(sf))))return '';
  if(ts.isIdentifier(n)&&['executionContext','windowCtx'].includes(n.text)&&ts.isCallExpression(n.parent)&&n.parent.arguments.includes(n))return '';
 });
 edit(file,s=>s.replace('            const effectiveData = data;\n','').replace('data: effectiveData,','data,'));
}
edit('README.md',s=>s.replaceAll('\r\n','\n'));
