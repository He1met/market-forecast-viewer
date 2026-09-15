import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{requireEvidence}from'./evidence-context.mjs';import{verifyPackage}from'./m1-package.mjs';import{buildPackage}from'./m1-package-build.mjs';import{stageRelease,activate}from'./m1-admin.mjs';
const e=requireEvidence(),target=path.join(e.evidence_root,'runtime-package');
const manifest=await buildPackage({sourceRoot:process.cwd(),destination:target,synthetic:true,buildSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()});
const syntheticHome=path.join(e.evidence_root,'synthetic-install');await stageRelease({packageRoot:target,runtimeHome:syntheticHome});await assert.rejects(()=>activate({runtimeHome:syntheticHome,releaseId:manifest.release_id,approval:{},config:{}}),/SYNTHETIC_PACKAGE_CANNOT_ACTIVATE/);
assert.equal(manifest.dependencies.tsx,JSON.parse(await fs.readFile('package-lock.json')).packages['node_modules/tsx'].version);
const result=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',"import{verifyPackage}from'./scripts/m1-package.mjs';console.log((await verifyPackage(process.cwd())).release_id)"],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root}}).trim();assert.equal(result,manifest.release_id);
const stat=await fs.stat(path.join(target,'node_modules/zod/package.json')),original=await fs.stat('node_modules/zod/package.json');assert.notEqual(stat.ino,original.ino);
const changed=path.join(target,'config/tasks.json'),before=await fs.readFile(changed);await fs.writeFile(changed,'{}');await assert.rejects(()=>verifyPackage(target),/PACKAGE_HASH_MISMATCH/);await fs.writeFile(changed,before);await verifyPackage(target);
console.log(JSON.stringify({status:'passed',release_id:manifest.release_id,file_count:Object.keys(manifest.files).length,no_git:true,independent_dependencies:true,modified_file_rejected:true}));
// Read existing portable archives with a different code root and no development dependencies.
const dataRoot=path.join(process.cwd(),'artifacts');
const smoke=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';
import{createDisplayReader}from'./scripts/m1-display.mjs';
import{projectionStore}from'./scripts/m1-index.mjs';
import{serve}from'./scripts/m1-server.mjs';
import net from'node:net';import fs from'node:fs/promises';
const reader=createDisplayReader({root:process.cwd(),dataRoot:process.env.MFV_DATA_ROOT});
await projectionStore(process.env.MFV_DATA_ROOT).update(reader);
const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
const server=await serve({codeRoot:process.cwd(),dataRoot:process.env.MFV_DATA_ROOT,port});
try{const base='http://127.0.0.1:'+port;const index=await(await fetch(base+'/api/m1/index')).json();assert.ok(index.runs.some(x=>x.status==='valid'));const id=index.runs.find(x=>x.status==='valid').run_id;const result=await(await fetch(base+'/api/m1/runs/'+id)).json();assert.equal(result.run_id,id);assert.equal((await fetch(base+'/')).status,200);const original=await fs.readFile('dist/index.html');await fs.writeFile('dist/index.html','TAMPERED');assert.equal((await fetch(base+'/')).status,404);await fs.writeFile('dist/index.html',original);assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/artifacts/forecast-runs/'+id+'/input.json')).status,404);assert.equal((await fetch(base+'/api/m1/index',{method:'POST'})).status,404);assert.equal((await fetch(base+'/api/m1/index',{headers:{Origin:'https://example.invalid'}})).status,404);console.log(JSON.stringify({status:'passed',isolated_http:true,legacy_replay:true,private_paths_rejected:true}));}finally{await new Promise(r=>server.close(r));}
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:dataRoot},timeout:30000});
console.log(smoke.trim());
const tracked='config/tasks.json',sourceBefore=await fs.readFile(tracked);try{await fs.writeFile(tracked,'{"SYNTHETIC_UNCOMMITTED_CHANGE":true}');const dirtyTarget=path.join(e.evidence_root,'runtime-package-dirty-export');const second=await buildPackage({sourceRoot:process.cwd(),destination:dirtyTarget,synthetic:true,buildSha:manifest.build_sha});assert.deepEqual(await fs.readFile(path.join(dirtyTarget,tracked)),sourceBefore);assert.equal(second.source_kind,'git_archive');console.log(JSON.stringify({dirty_checkout_export:'passed',synthetic_not_deployable:second.synthetic}));}finally{await fs.writeFile(tracked,sourceBefore);}

// Run failure/recovery entry chains from the sealed package with isolated synthetic data.
const lifecycle=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {cycle} from './scripts/m1-cycle.mjs';import {ops,scanOpsBatch} from './scripts/m1-ops.mjs';import {businessMutex} from './scripts/m1-mutex.mjs';
const data=process.env.MFV_DATA_ROOT;await fs.mkdir(data,{recursive:true});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
let calls=0;const options={dataRoot:data,mutexPort:port,releaseId:'SYNTHETIC_INSTALLED',clock:()=>Date.parse('2026-09-15T01:47:00Z'),freeze:async()=>({}),generate:async()=>{calls++;return{forecast:{run_id:'SYNTHETIC_PUBLICATION'}};},publishIndex:async()=>{throw Error('SYNTHETIC_INDEX_FAILURE');}};
const first=await cycle(options);assert.equal(first.status,'failed');assert.equal(first.publication_committed,true);assert.equal((await cycle(options)).reason,'duplicate_slot');assert.equal(calls,1);
const id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011',bad=path.join(data,'forecast-runs',id);await fs.mkdir(bad,{recursive:true});await fs.writeFile(path.join(bad,'manifest.json'),'{}');
const inspection={codeRoot:process.cwd(),dataRoot:data,port,releaseId:'SYNTHETIC_INSTALLED'};assert.equal((await ops(inspection)).status,'partial');await fs.rm(bad,{recursive:true});const missing=await ops(inspection);assert.equal(missing.status,'partial');assert.equal(missing.unresolved[0].reason,'archive_missing');
const ids=Array.from({length:16},(_,i)=>'SYNTHETIC_'+i);let repaired=false;const scan={dataRoot:data,role:'candidate',ids,guard:async()=>{},visit:async id=>id===ids[0]&&!repaired?{status:'failed',reason:'SYNTHETIC_CORRUPT'}:{status:'ok'}};assert.equal((await scanOpsBatch(scan)).unresolved.length,1);const next=await scanOpsBatch(scan);assert.ok(next.outcomes.every(x=>x.status==='ok'));assert.equal(next.unresolved.length,1);repaired=true;assert.equal((await scanOpsBatch(scan)).unresolved.length,0);
const mutex=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_PROBE'});assert.equal(mutex.status,'ACQUIRED');await mutex.close();
console.log(JSON.stringify({status:'passed',installed_failure_chains:true,publication_preserved:true,ops_partial_recovery:true,idle_mutex_released:true,model_calls:0,network_requests:0}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:path.join(e.evidence_root,'synthetic-lifecycle')},timeout:30000});
console.log(lifecycle.trim());
