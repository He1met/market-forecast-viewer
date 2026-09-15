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

// Full synthetic backup -> source destruction -> bounded replay in the sealed
// package. No activation bypass and no market/model transport are used.
const restoration=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {backup,restore} from './scripts/m1-backup.mjs';import {replayRestored} from './scripts/m1-restore-replay.mjs';
import {createDisplayReader} from './scripts/m1-display.mjs';import {createOutcomeStore} from './scripts/m1-outcome-store.mjs';import {caseStore} from './scripts/m1-cases.mjs';
const root=process.env.SYNTHETIC_RESTORE_ROOT,data=path.join(root,'data'),target=path.join(root,'backup'),destination=path.join(root,'restored');
await fs.mkdir(data,{recursive:true});await fs.mkdir(target);
for(const name of ['forecast-runs','data-source','m1-outcomes'])await fs.cp(path.join(process.env.MFV_DATA_ROOT,name),path.join(data,name),{recursive:true});
process.env.MFV_DATA_ROOT=data;
const id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011',reader=createDisplayReader({root:process.cwd(),dataRoot:data}),run=await reader.readRun(id),store=createOutcomeStore({root:process.cwd(),dataRoot:data});
const capture=await store.capture(run,{transport:async({file})=>{await fs.writeFile(file,JSON.stringify({code:'0',msg:'SYNTHETIC',data:Array.from({length:96},(_,i)=>[String((run.forecast.anchor_time+i*900)*1000),...Array(4).fill(String(run.forecast.anchor_price)),'10','1','100','1']).reverse()}));return '200';}});
assert.equal(capture.status,'ok');const revision=await store.evaluateCapture(run,capture.capture_id);assert.equal(revision.result.windows.h24.status,'mature');
const originalCase=await caseStore({codeRoot:process.cwd(),dataRoot:data}).create(id,revision.revision_id);
await fs.cp(path.join(data,'forecast-runs',id),path.join(data,'m1-candidates',id),{recursive:true});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const saved=await backup({dataRoot:data,target,port,releaseId:'SYNTHETIC_INSTALLED_RESTORE',slotKey:'SYNTHETIC_WEEKLY'});assert.equal(saved.status,'completed');
const again=await backup({dataRoot:data,target,port,releaseId:'SYNTHETIC_INSTALLED_RESTORE',slotKey:'SYNTHETIC_WEEKLY'});assert.equal(again.already_completed,true);assert.equal(again.manifest.id,saved.manifest.id);
await fs.rm(path.join(data,'forecast-runs'),{recursive:true});await fs.writeFile(path.join(data,'m1-candidates',id,'manifest.json'),'SYNTHETIC_SOURCE_TAMPERED');
const args={target,manifestFile:path.join(target,'manifests',saved.manifest.id+'.json'),destination,verify:async restored=>{process.env.MFV_DATA_ROOT=restored;return replayRestored({codeRoot:process.cwd(),dataRoot:restored,limit:1});}};
const first=await restore({...args,maxFiles:1});assert.equal(first.status,'incomplete');assert.equal(await fs.stat(path.join(destination,'restore-receipt.json')).catch(()=>null),null);
let result;for(let i=0;i<20;i++){result=await restore({...args,resume:true});if(result.schema==='MFV:RESTORE:v1')break;assert.equal(result.status,'incomplete');assert.equal(await fs.stat(path.join(destination,'restore-receipt.json')).catch(()=>null),null);}
assert.equal(result.schema,'MFV:RESTORE:v1');assert.equal(result.activation_restored,false);assert.equal(result.replay.candidate_count,1);assert.equal(result.replay.case_count,1);assert.equal(result.replay.projections_complete,true);
const restoredCase=await caseStore({codeRoot:process.cwd(),dataRoot:destination}).read(originalCase.id);assert.equal(restoredCase.brier,originalCase.brier);assert.equal(restoredCase.forecast_hash,originalCase.forecast_hash);
const learning=JSON.parse(await fs.readFile(path.join(destination,'restore-derived/learning-summary.json')));assert.equal(learning.mean_brier,originalCase.brier);
const receipt=await fs.readFile(path.join(destination,'restore-receipt.json'));assert.deepEqual(await restore({...args,resume:true}),JSON.parse(receipt));assert.deepEqual(await fs.readFile(path.join(destination,'restore-receipt.json')),receipt);
console.log(JSON.stringify({status:'passed',installed_restore_chain:true,source_deleted_and_modified:true,mature_score_recomputed:true,candidate_replayed:true,learning_summary_rebuilt:true,bounded_resume:true,receipt_deduplicated:true,activation_restored:false,model_calls:0,network_requests:0}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:dataRoot,SYNTHETIC_RESTORE_ROOT:path.join(e.evidence_root,'synthetic-restore')},timeout:60000});
console.log(restoration.trim());
