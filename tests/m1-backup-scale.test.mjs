import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {captureSnapshot,backup,restore} from '../scripts/m1-backup.mjs';
import {digest} from '../scripts/m1-files.mjs';

async function fixture(t,count=70){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-snapshot-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dataRoot=path.join(root,'data'),runtimeHome=path.join(root,'runtime'),target=path.join(root,'backup');
 await fs.mkdir(path.join(dataRoot,'data-source'),{recursive:true});await fs.mkdir(runtimeHome);await fs.mkdir(target);
 for(let i=0;i<count;i++)await fs.writeFile(path.join(dataRoot,'data-source',String(i).padStart(4,'0')),`synthetic-${i}`);
 return{root,dataRoot,runtimeHome,target};
}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('8500-file 208MB complete backup and quarantined restore meet unchanged snapshot budget',async t=>{
 const f=await fixture(t,0),expected=new Map(),bytes=Buffer.alloc(24576,83);
 for(let i=0;i<8500;i++){
  const runtime=i>=1700,name=runtime?`releases/p${i%9}/f${i}`:`data-source/f${i}`;
  const file=path.join(runtime?f.runtimeHome:f.dataRoot,name);await fs.mkdir(path.dirname(file),{recursive:true});bytes.writeUInt32BE(i,0);await fs.writeFile(file,bytes);
  expected.set((runtime?'runtime-snapshot/':'')+name,digest(bytes));
 }
 let result;try{result=await backup({...f,port:await port(),releaseId:'SYNTHETIC-SCALE'});}catch(error){t.diagnostic(JSON.stringify({synthetic:true,failure:error.message,snapshot:error.snapshot_diagnostics}));throw error;}const d=result.manifest.snapshot_diagnostics;
 assert.equal(result.status,'completed');assert.equal(d.source_files,8501);assert.equal(d.captured_files,8501);assert.equal(d.verified_files,8501);
 assert.ok(d.total_bytes>=208896000);assert.ok(d.elapsed_ms<15000);assert.ok(d.guard_checks<1000);
 for(const e of result.manifest.files)if(expected.has(e.name))assert.equal(e.sha256,expected.get(e.name));
 const destination=path.join(f.root,'restored');
 const restored=await restore({target:f.target,manifestFile:path.join(f.target,'manifests',result.manifest.id+'.json'),destination,maxMs:120000,verify:async root=>{
  for(const[name,sha]of expected)assert.equal(digest(await fs.readFile(path.join(root,name))),sha);
  return{passed:true};
 }});
 assert.equal(restored.activation_restored,false);assert.equal(restored.restored.length,8500);assert.equal(restored.skipped.length,1);
 t.diagnostic(JSON.stringify({synthetic:true,snapshot:d,restored:restored.restored.length}));
});
