import {buildPackage} from './m1-package-build.mjs';
import fs from'node:fs/promises';import path from'node:path';import assert from'node:assert/strict';import{execFileSync}from'node:child_process';import{requireEvidence}from'./evidence-context.mjs';import{verifyPackage}from'./m1-package.mjs';import{stageRelease,activate}from'./m1-admin.mjs';
import {verifyTargetArchives,archiveSnapshot} from './m1-compatibility.mjs';
import {verifyDeploymentHealth} from './m1-deploy-health.mjs';
import net from 'node:net';
const e=requireEvidence(),target=path.join(e.evidence_root,'runtime-package');
const releaseResult=JSON.parse(execFileSync(process.execPath,['scripts/m1-release.mjs','--commit',execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),'--destination',target],{encoding:'utf8'}));
assert.equal(releaseResult.synthetic,true);assert.equal(releaseResult.activated,false);assert.equal(releaseResult.maintainer_approval,false);const manifest=await verifyPackage(target);assert.equal(releaseResult.release_id,manifest.release_id);
const syntheticHome=path.join(e.evidence_root,'synthetic-install');await stageRelease({packageRoot:target,runtimeHome:syntheticHome});await assert.rejects(()=>activate({runtimeHome:syntheticHome,releaseId:manifest.release_id,approval:{},config:{}}),/SYNTHETIC_PACKAGE_CANNOT_ACTIVATE/);
// Replay every historical revision with the sealed target's own readers.
const compatData=path.join(e.evidence_root,'compatibility-data');await fs.cp('artifacts',compatData,{recursive:true});
const compatBefore=await archiveSnapshot(compatData);
const compatible=await verifyTargetArchives({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id});
assert.equal(compatible.status,'compatible');assert.ok(compatible.runs>0);assert.ok(compatible.revisions>0);assert.ok(compatible.failed_runs>0);
await assert.rejects(()=>verifyTargetArchives({packageRoot:target,dataRoot:compatData,releaseId:'0'.repeat(64)}),/COMPATIBILITY_TARGET_MISMATCH/);
const outcomeIds=await fs.readdir(path.join(compatData,'m1-outcomes')),revDir=path.join(compatData,'m1-outcomes',outcomeIds[0],'evaluations'),rev=(await fs.readdir(revDir))[0];
const revisionFile=path.join(revDir,rev,'result.json'),originalRevision=await fs.readFile(revisionFile);
await fs.writeFile(revisionFile,'{}');await assert.rejects(()=>verifyTargetArchives({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id}));assert.equal(await fs.readFile(revisionFile,'utf8'),'{}');await fs.writeFile(revisionFile,originalRevision);
const unknown=path.join(compatData,'m1-outcomes','UNKNOWN');await fs.mkdir(unknown);await assert.rejects(()=>verifyTargetArchives({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id}));await fs.rmdir(unknown);
assert.deepEqual(await archiveSnapshot(compatData),compatBefore);
const healthSocket=net.createServer();await new Promise(r=>healthSocket.listen(0,'127.0.0.1',r));const healthPort=healthSocket.address().port;
await assert.rejects(()=>verifyDeploymentHealth({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id,port:healthPort}),/EADDRINUSE/);
assert.equal(healthSocket.listening,true);await new Promise(r=>healthSocket.close(r));
const healthResult=await verifyDeploymentHealth({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id,port:healthPort});
assert.equal(healthResult.status,'healthy');assert.equal(healthResult.scope,'pre_activation_target_http');assert.equal(healthResult.service_left_running,false);
assert.equal(healthResult.index_status,'not_initialized');
const {projectionStore:healthProjections}=await import('./m1-index.mjs'),{createDisplayReader:healthReader}=await import('./m1-display.mjs');
await healthProjections(compatData).update(healthReader({root:process.cwd(),dataRoot:compatData}));
assert.equal((await verifyDeploymentHealth({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id,port:healthPort})).index_status,'passed');
const projectionFile=path.join(compatData,'m1-projections/index.json'),projectionBytes=await fs.readFile(projectionFile);await fs.writeFile(projectionFile,'{}');
await assert.rejects(()=>verifyDeploymentHealth({packageRoot:target,dataRoot:compatData,releaseId:manifest.release_id,port:healthPort}),/DEPLOY_HTTP_FAILED/);await fs.writeFile(projectionFile,projectionBytes);
await new Promise((resolve,reject)=>{healthSocket.once('error',reject);healthSocket.listen(healthPort,'127.0.0.1',resolve);});await new Promise(r=>healthSocket.close(r));
await assert.rejects(()=>verifyDeploymentHealth({packageRoot:target,dataRoot:compatData,releaseId:'0'.repeat(64),port:healthPort}),/DEPLOY_TARGET_MISMATCH/);
assert.deepEqual(await archiveSnapshot(compatData),compatBefore);
console.log(JSON.stringify({target_http_health:'passed',unknown_listener_untouched:true,probe_port_released:true,archive_unchanged:true,activation_tested:false}));
console.log(JSON.stringify({compatibility:'passed',exact_target:true,all_revisions:true,corruption_rejected:true,orphan_rejected:true,archive_unchanged:true,activation_tested:false}));
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
import{runtimeDisplaySchema}from'./src/m1-display.ts';
import{doctor}from'./scripts/m1-doctor.mjs';
import{entry}from'./scripts/m1-entry.mjs';
import net from'node:net';import fs from'node:fs/promises';
const reader=createDisplayReader({root:process.cwd(),dataRoot:process.env.MFV_DATA_ROOT});
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const probePort=probe.address().port;await new Promise(r=>probe.close(r));
const doctorOptions={codeRoot:process.cwd(),config:{data_root:process.env.MFV_DATA_ROOT,runtime_home:process.env.MFV_RUNTIME_HOME,mutex_port:probePort},manifest:JSON.parse(await fs.readFile('manifest.json'))};
const diagnostic=await doctor(doctorOptions);assert.equal(diagnostic.tasks.official_current,'unknown');assert.equal(diagnostic.audit.status,'not_requested');assert.equal(diagnostic.mutex.status,'vacant');
const audited=await doctor({...doctorOptions,fullAudit:true});assert.ok(audited.audit.checked>0);assert.notEqual(audited.audit.status,'incomplete');assert.equal(audited.audit.backup_restore_verified,false);
await assert.rejects(()=>entry('learning',process.env.MFV_RUNTIME_HOME,doctorOptions.manifest.release_id,['disable','--reason','']),/LEARNING_ARGUMENTS_INVALID/);
await assert.rejects(()=>entry('doctor',process.env.MFV_RUNTIME_HOME,doctorOptions.manifest.release_id,['--bad']),/ENTRY_ARGUMENTS_INVALID/);
console.log(JSON.stringify({doctor_package_modules:true,audit_status:audited.audit.status,audited:audited.audit.checked,installed_approval_bypass:false}));
await projectionStore(process.env.MFV_DATA_ROOT).update(reader);
const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
let paused=true;const server=await serve({codeRoot:process.cwd(),dataRoot:process.env.MFV_DATA_ROOT,port,readStatusOptions:async()=>({paused,opsPaused:paused})});
try{const base='http://127.0.0.1:'+port;const runtime=runtimeDisplaySchema.parse(await(await fetch(base+'/api/m1/runtime')).json());assert.equal(runtime.source,'installed');assert.equal(runtime.paused,true);assert.equal(runtime.inspection.freshness,'unknown');paused=false;const resumed=runtimeDisplaySchema.parse(await(await fetch(base+'/api/m1/runtime')).json());assert.equal(resumed.paused,false);assert.equal(resumed.inspection.paused,false);const index=await(await fetch(base+'/api/m1/index')).json();assert.ok(index.runs.some(x=>x.status==='valid'));const id=index.runs.find(x=>x.status==='valid').run_id;const result=await(await fetch(base+'/api/m1/runs/'+id)).json();assert.equal(result.run_id,id);assert.equal((await fetch(base+'/')).status,200);const original=await fs.readFile('dist/index.html');await fs.writeFile('dist/index.html','TAMPERED');assert.equal((await fetch(base+'/')).status,404);await fs.writeFile('dist/index.html',original);assert.equal((await fetch(base+'/')).status,200);assert.equal((await fetch(base+'/artifacts/forecast-runs/'+id+'/input.json')).status,404);assert.equal((await fetch(base+'/api/m1/index',{method:'POST'})).status,404);assert.equal((await fetch(base+'/api/m1/index',{headers:{Origin:'https://example.invalid'}})).status,404);console.log(JSON.stringify({status:'passed',isolated_http:true,legacy_replay:true,private_paths_rejected:true}));}finally{await new Promise(r=>server.close(r));}
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
const {backupCycle}=await import('./scripts/m1-backup-cycle.mjs');
const cycleOptions={codeRoot:process.cwd(),config:{data_root:data,mutex_port:port,backup:{target}},releaseId:'SYNTHETIC_INSTALLED_RESTORE',trigger:'scheduled',taskId:'synthetic-backup-task',threadId:'synthetic-backup-thread',clock:()=>Date.parse('2026-09-20T00:00:00Z')};
const cyclePartial=await backupCycle({...cycleOptions,restoreMaxFiles:1});assert.equal(cyclePartial.status,'partial');assert.equal(cyclePartial.trigger,'scheduled');assert.equal(await fs.stat(path.join(data,'m1-task-status/last-backup-success.json')).catch(()=>null),null);
const cycleComplete=await backupCycle(cycleOptions);assert.equal(cycleComplete.status,'completed');assert.equal(cycleComplete.restore_check.replay.candidate_count,1);assert.equal(cycleComplete.restore_check.replay.case_count,1);
const cycleStatus=JSON.parse(await fs.readFile(path.join(data,'m1-task-status/backup.json')));assert.equal(cycleStatus.task_id,'synthetic-backup-task');assert.equal(cycleStatus.thread_id,'synthetic-backup-thread');
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

// Sealed-package outbox/ops chain: unavailable delivery stays pending, including
// recovery; a failed outbox write cannot certify an hourly slot as completed.
const alertChain=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {ops} from './scripts/m1-ops.mjs';import {alertStore} from './scripts/m1-alerts.mjs';
const root=process.env.SYNTHETIC_ALERT_ROOT;await fs.mkdir(root,{recursive:true});
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
let failed=true;const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',refreshInputs:async()=>{if(failed)throw Error('SYNTHETIC_NETWORK');}};
assert.equal((await ops(options)).alerts.event_ids.length,0);
assert.equal((await ops(options)).alerts.event_ids.length,1);
assert.equal((await ops(options)).alerts.event_ids.length,1);
failed=false;assert.equal((await ops(options)).status,'completed');
const store=alertStore(root),pending=await store.pending();assert.deepEqual(pending.map(x=>x.kind),['fault','recovery']);assert.ok(pending.every(x=>x.delivery.status==='pending'));
assert.equal((await ops(options)).reason,'slot_completed');
const broken=path.join(root,'broken');await fs.mkdir(path.join(broken,'m1-control/alerts.json'),{recursive:true});
const partial=await ops({...options,dataRoot:broken});assert.equal(partial.status,'partial');assert.equal(partial.primary_status,'completed');assert.ok(partial.alert_error);
await fs.rmdir(path.join(broken,'m1-control/alerts.json'));assert.equal((await ops({...options,dataRoot:broken})).status,'completed');
console.log(JSON.stringify({status:'passed',installed_alert_outbox:true,two_failures:true,deduplicated:true,recovery_pending:true,outbox_failure_blocks_completion:true,network_requests:0,model_calls:0}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',SYNTHETIC_ALERT_ROOT:path.join(e.evidence_root,'synthetic-alerts')},timeout:60000});
console.log(alertChain.trim());
console.log(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {ops} from './scripts/m1-ops.mjs';import {alertStore} from './scripts/m1-alerts.mjs';
const root=process.env.SYNTHETIC_UNOWNED_ROOT;await fs.mkdir(root,{recursive:true});
const foreign=net.createServer(socket=>socket.end('{}'));await new Promise(r=>foreign.listen(0,'127.0.0.1',r));const port=foreign.address().port;
const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC'};
try{assert.equal((await ops(options)).reason,'MUTEX_CONFLICT');assert.equal((await alertStore(root,{stream:'execution'}).pending()).length,0);}finally{await new Promise(r=>foreign.close(r));}
const recovered=await ops(options);assert.equal(recovered.status,'completed');assert.equal(recovered.execution_observations.consumed,1);
const pending=await alertStore(root,{stream:'execution'}).pending();assert.equal(pending.length,1);assert.equal(pending[0].code,'MUTEX_IDENTITY_UNKNOWN');assert.equal(pending[0].delivery.status,'pending');assert.ok(recovered.alerts.event_ids.includes(pending[0].id));
assert.equal((await ops(options)).reason,'slot_completed');assert.equal((await alertStore(root,{stream:'execution'}).pending()).length,1);
console.log(JSON.stringify({status:'passed',installed_unknown_mutex_observation:true,unowned_log_preserved:true,locked_aggregation:true,pending_not_delivered:true,model_calls:0,network_requests:0}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',SYNTHETIC_UNOWNED_ROOT:path.join(e.evidence_root,'synthetic-unowned')},timeout:60000}).trim());


console.log(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import fs from 'node:fs/promises';import path from 'node:path';import assert from 'node:assert/strict';import net from 'node:net';
import {ops} from './scripts/m1-ops.mjs';import {alertStore} from './scripts/m1-alerts.mjs';
const root=process.env.SYNTHETIC_MISSING_ROOT;await fs.mkdir(root,{recursive:true});process.env.MFV_DATA_ROOT=root;
const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC_MISSING',forecastPaused:false,expectedSince:new Date(Date.now()-86400000).toISOString()};
const result=await ops(options);assert.equal(result.status,'completed');assert.equal(result.publication_health.status,'stalled');assert.equal(result.publication_health.slots.length,2);
const pending=await alertStore(root).pending();assert.equal(pending.length,1);assert.equal(pending[0].code,'FORECAST_OUTPUT_MISSING');assert.equal(pending[0].severity,'warning');assert.equal((await ops(options)).reason,'slot_completed');assert.equal((await alertStore(root).pending()).length,1);
console.log(JSON.stringify({installed_missing_output:'passed',actual_prediction_invocations:0,delivery:'pending'}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',SYNTHETIC_MISSING_ROOT:path.join(e.evidence_root,'synthetic-missing')},timeout:30000}));
// Installed pause lifecycle uses the sealed package helper and real local config;
// synthetic packages remain forbidden at the official activation/entry boundary.
console.log(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {setForecastPaused,disableLearning} from './scripts/m1-admin.mjs';
import {learningArguments} from './scripts/m1-admin-args.mjs';import {atomic,validateInstallation} from './scripts/m1-files.mjs';import {publicationHealth} from './scripts/m1-publication-health.mjs';
const home=path.join(process.env.MFV_RUNTIME_HOME,'pause-home'),data=path.join(process.env.MFV_RUNTIME_HOME,'pause-data');await fs.mkdir(home);await fs.mkdir(data);
const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
const file=path.join(home,'installation.local.json'),releaseId='a'.repeat(64);await atomic(home,file,{schema:'MFV:INSTALLATION:v1',runtime_home:home,data_root:data,http_port:port===65535?port-1:port+1,mutex_port:port,forecast_paused:true,ops_paused:true});await atomic(home,path.join(home,'current.json'),{release_id:releaseId});
const change=(paused,at)=>setForecastPaused({runtimeHome:home,releaseId,paused,clock:()=>Date.parse(at)});
await change(false,'2026-09-15T05:47:00Z');await change(true,'2026-09-15T06:00:00Z');assert.equal((await validateInstallation(file)).forecast_expected_since,null);
await change(false,'2026-09-15T07:48:00Z');await change(false,'2026-09-15T08:00:00Z');const config=await validateInstallation(file);assert.equal(config.forecast_expected_since,'2026-09-15T07:48:00.000Z');assert.equal(config.ops_paused,true);
const health=await publicationHealth({reader:{listRunIds:async()=>[]},paused:false,expectedSince:config.forecast_expected_since,now:Date.parse('2026-09-15T08:02:00Z')});assert.equal(health.status,'waiting');assert.equal(health.slots.length,0);
const disabled=await disableLearning({runtimeHome:home,dataRoot:data,port,releaseId,...learningArguments(['disable','--reason','SYNTHETIC regression'])});assert.equal(disabled.status,'applied');assert.equal(disabled.controls.learning_disabled,true);assert.equal((await disableLearning({runtimeHome:home,dataRoot:data,port,releaseId,reason:'retry'})).status,'unchanged');assert.equal((await validateInstallation(file)).forecast_expected_since,config.forecast_expected_since);
console.log(JSON.stringify({status:'passed',installed_learning_disable:true,installed_pause_epoch:true,paused_history_excluded:true,repeated_resume_idempotent:true,official_activation:false}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root},timeout:30000}));

// Compose the real experiment/archive/model modules inside the sealed package.
// Publication input/output is synthetic; no CLI model or market transport is used.
const candidateChain=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {experimentStore} from './scripts/m1-experiments.mjs';import {businessMutex} from './scripts/m1-mutex.mjs';
import {newRun,readFrozen,freezeInput,prepareAttempt,completeAttempt,publishRun,readPublished} from './scripts/m1-archive.mjs';
import {generateCandidate} from './scripts/m1-model.mjs';import {digest} from './scripts/m1-files.mjs';
const data=process.env.MFV_DATA_ROOT,fixture=process.env.MFV_FIXTURE_ROOT;
await fs.mkdir(data,{recursive:true});await fs.cp(path.join(fixture,'data-source'),path.join(data,'data-source'),{recursive:true});
const fixtureId='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
const input=JSON.parse(await fs.readFile(path.join(fixture,'forecast-runs',fixtureId,'input.json')));
const raw=await fs.readFile(path.join(fixture,'forecast-runs',fixtureId,'attempt-001/raw-output.json'));
const schema=JSON.parse(await fs.readFile(path.join(fixture,'forecast-runs',fixtureId,'output-schema.json')));
const source=path.resolve('scripts/m1-model.mjs'),provenance={code_sha256:{[source]:digest(await fs.readFile(source))}};
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const mutex=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_CANDIDATE_CHAIN'});assert.equal(mutex.status,'ACQUIRED');
try{
 const store=experimentStore(data),baseline={predictor_version:'SYNTHETIC',model:'SYNTHETIC',reasoning_effort:'medium',additional_inputs:'none',feedback:'F0',lambda:0};
 const plan=await store.create(baseline,{...baseline,lambda:.5},{guard:mutex.guard,factor:'probability'});
 const registration=await store.register({slot_id:'SYNTHETIC_DAILY',anchor_time:Date.parse('2026-09-15T17:45:00Z')/1000},baseline,{guard:mutex.guard});assert.ok(registration);
 const official=await newRun(path.join(data,'forecast-runs'));
 const learning={lambda:0,base:{probabilities:Array(6).fill(1/6)},synthetic:true};input.model_context.learning=learning;
 await freezeInput(official.runDir,input,'SYNTHETIC shared snapshot',schema,provenance);
 const before=await readFrozen(official.runDir);let learningCalls=0;
 const candidate=await store.freezeCandidate(registration,official,{guard:mutex.guard,learningBuilder:async(features,cutoff,policy)=>{learningCalls++;assert.deepEqual(features,input.features);assert.equal(cutoff,before.manifest.information_frozen_at);assert.deepEqual(policy,plan.candidate);return{...learning,lambda:policy.lambda};}});
 assert.equal(candidate.probabilityOnly,true);assert.equal(learningCalls,1);
 const frozen=await readFrozen(candidate.runDir);assert.deepEqual(frozen.input.history,before.input.history);assert.deepEqual(frozen.manifest.source_files,before.manifest.source_files);assert.deepEqual(frozen.input.events,before.input.events);
 assert.equal((await readFrozen(official.runDir)).manifest.files['input.json'],before.manifest.files['input.json']);
 const binding=JSON.parse(await fs.readFile(path.join(registration.dir,'frozen.json')));assert.equal(binding.official_input_hash,before.manifest.files['input.json']);assert.equal(binding.candidate_input_hash,frozen.manifest.files['input.json']);assert.equal(binding.market_hash,input.history.dataset_id);
 await assert.rejects(()=>generateCandidate(candidate,{mutex,beforePublish:mutex.guard}),/PROBABILITY_SOURCE_NOT_PUBLISHED/);
 await assert.rejects(()=>fs.stat(path.join(candidate.runDir,'attempt-001')),/ENOENT/);
 const attempt=await prepareAttempt(official.runDir);await fs.writeFile(attempt.rawFile,raw);await completeAttempt(official.runDir,attempt.attempt_id,{exit_code:0,model_config:{synthetic:true}});const published=await publishRun(official.runDir,attempt.rawFile,{attempt_id:attempt.attempt_id});
 // A missing CLI makes accidental model invocation fail, rather than use a real login.
 for(const bin of ['/usr/bin/codex','/bin/codex'])await assert.rejects(()=>fs.stat(bin),/ENOENT/);
 process.env.PATH='/usr/bin:/bin';
 const result=await generateCandidate(candidate,{mutex,beforePublish:mutex.guard});
 assert.deepEqual(result.forecast.scenarios.map(x=>x.prices),published.forecast.scenarios.map(x=>x.prices));
 for(let i=0;i<6;i++)assert.ok(Math.abs(result.forecast.scenarios[i].probability_24h-(published.forecast.scenarios[i].probability_24h*.5+1/12))<1e-12);
 assert.equal(result.receipt.raw_output_sha256,published.receipt.raw_output_sha256);
 const execution=JSON.parse(await fs.readFile(path.join(candidate.runDir,'attempt-001/execution-started.json')));assert.equal(execution.mode,'deterministic_probability_postprocess');assert.equal(execution.process,null);
 await store.finish(registration,{candidate_invoked:true,official_run_id:official.run_id,candidate_run_id:candidate.run_id,candidate_status:'published'});
 assert.equal(await store.register({slot_id:'SYNTHETIC_DAILY',anchor_time:registration.opportunity.anchor_time},baseline,{guard:mutex.guard}),null);
 assert.equal((await readPublished(candidate.runDir)).forecast.run_id,candidate.run_id);
 console.log(JSON.stringify({status:'passed',installed_candidate_chain:true,common_market_hash_verified:true,frozen_binding_verified:true,unpublished_source_rejected:true,paths_unchanged:true,probability_transform_verified:true,actual_start_recorded:true,opportunity_deduplicated:true,model_calls:0,market_requests:0,real_timeliness_verified:false}));
}finally{await mutex.close();}
// Exercise the actual cycle callbacks with real archive/experiment/model modules.
// The clock and official output are synthetic: this checks orchestration only.
const {cycle}=await import('./scripts/m1-cycle.mjs');
const baseline={predictor_version:'SYNTHETIC',model:'SYNTHETIC',reasoning_effort:'medium',additional_inputs:'none',feedback:'F0',lambda:0};
for(const [index,mode] of ['published','budget_skipped','failed'].entries()){
 const store=experimentStore(data),order=[];let registration,official,candidate,elapsed=0,officialCalls=0,candidateCalls=0,finalizations=0;
 const now=Date.parse('2026-09-16T17:47:00Z')+index*86400000;
 const options={dataRoot:data,releaseId:'SYNTHETIC_CYCLE',mutexPort:port,trigger:'manual',clock:()=>now,monotonic:()=>elapsed,
  resolvePolicy:async({mutex})=>{await mutex.guard();order.push('policy');return baseline;},
  registerOpportunity:async(slot,{guard,policy})=>{order.push('register');registration=await store.register(slot,policy,{guard});assert.ok(registration);return registration;},
  freeze:async()=>{order.push('freeze');official=await newRun(path.join(data,'forecast-runs'));await freezeInput(official.runDir,input,'SYNTHETIC cycle snapshot',schema,provenance);return official;},
  prepareCandidate:async(r,frozen,{guard})=>{order.push('candidate_freeze');candidate=await store.freezeCandidate(r,frozen,{guard,learningBuilder:async(features,cutoff,policy)=>{const original=await readFrozen(frozen.runDir);assert.equal(cutoff,original.manifest.information_frozen_at);return{...input.model_context.learning,lambda:policy.lambda};}});return candidate;},
  generate:async(frozen,{beforePublish})=>{order.push('official_publish');officialCalls++;const attempt=await prepareAttempt(frozen.runDir);await fs.writeFile(attempt.rawFile,raw);await completeAttempt(frozen.runDir,attempt.attempt_id,{exit_code:0,model_config:{synthetic:true}});await beforePublish();return publishRun(frozen.runDir,attempt.rawFile,{attempt_id:attempt.attempt_id});},
  publishIndex:async({published})=>{order.push('index');assert.equal(published.forecast.run_id,official.run_id);if(mode==='budget_skipped')elapsed=520000;},
  runCandidate:async(frozen,context)=>{order.push('candidate_run');candidateCalls++;assert.equal((await readPublished(official.runDir)).forecast.run_id,official.run_id);if(mode==='failed')throw Error('SYNTHETIC_CANDIDATE_FAILURE');return generateCandidate(frozen,context);},
  finishOpportunity:async(r,result)=>{order.push('finish');finalizations++;await store.finish(r,result);}
 };
 const result=await cycle(options);assert.equal(result.status,'completed');assert.equal(result.forecast_id,official.run_id);
 const finish=JSON.parse(await fs.readFile(path.join(registration.dir,'generation.json')));
 assert.equal(finish.candidate_status,mode);assert.equal(finish.candidate_invoked,mode!=='budget_skipped');assert.equal(finish.official_run_id,official.run_id);assert.equal(finish.candidate_run_id,candidate.run_id);
 assert.deepEqual(order,['policy','register','freeze','candidate_freeze','official_publish','index',...(mode==='budget_skipped'?[]:['candidate_run']),'finish']);
 assert.equal(officialCalls,1);assert.equal(candidateCalls,mode==='budget_skipped'?0:1);assert.equal(finalizations,1);
 if(mode==='published'){
  const a=await readPublished(official.runDir),b=await readPublished(candidate.runDir);assert.deepEqual(a.forecast.scenarios.map(x=>x.prices),b.forecast.scenarios.map(x=>x.prices));assert.equal(a.receipt.raw_output_sha256,b.receipt.raw_output_sha256);
  for(let i=0;i<6;i++)assert.ok(Math.abs(b.forecast.scenarios[i].probability_24h-(a.forecast.scenarios[i].probability_24h*.5+1/12))<1e-12);
 }else await assert.rejects(()=>fs.stat(path.join(candidate.runDir,'attempt-001')),/ENOENT/);
 const bytes=await fs.readFile(path.join(registration.dir,'generation.json'));order.length=0;
 assert.equal((await cycle(options)).reason,'duplicate_slot');assert.equal(officialCalls,1);assert.equal(candidateCalls,mode==='budget_skipped'?0:1);assert.equal(finalizations,1);assert.deepEqual(await fs.readFile(path.join(registration.dir,'generation.json')),bytes);
 const released=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_RELEASE_CHECK'});assert.equal(released.status,'ACQUIRED');await released.close();
}
console.log(JSON.stringify({status:'passed',installed_real_cycle_orchestration:true,candidate_outcomes:['published','budget_skipped','failed'],official_publication_preserved:true,duplicate_slot_no_callbacks:true,mutex_released:true,model_calls:0,market_requests:0,entry_wiring_verified:false,real_timeliness_verified:false}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:path.join(e.evidence_root,'synthetic-candidate-chain'),MFV_FIXTURE_ROOT:dataRoot},timeout:30000});
console.log(candidateChain.trim());

console.log(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {ops} from './scripts/m1-ops.mjs';import {alertStore} from './scripts/m1-alerts.mjs';import {capacitySnapshot,requireCapacity} from './scripts/m1-capacity.mjs';
const root=process.env.SYNTHETIC_CAPACITY_ROOT;await fs.mkdir(root,{recursive:true});const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
let free=100n,refresh=0;const policy={reserve_bytes:200,production_floor_bytes:50},statfs=async()=>({bsize:1n,blocks:1000n,bfree:free,bavail:free}),options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',capacityPolicy:policy,capacityStatfs:statfs,refreshInputs:async()=>{refresh++;}};
const low=await ops(options);assert.equal(low.status,'completed');assert.equal(low.capacity.current.status,'low');assert.equal(refresh,0);assert.equal((await alertStore(root,{stream:'capacity'}).pending()).length,1);assert.throws(()=>requireCapacity(low.capacity.current),/CAPACITY_RESERVE_LOW/);requireCapacity(low.capacity.current,'production');
// Clear only this synthetic slot to exercise another invocation in the same test.
await fs.rm(path.join(root,'m1-control/ops-slots'),{recursive:true});free=300n;const recovered=await ops(options);assert.equal(recovered.capacity.current.status,'ok');assert.equal(refresh,1);assert.deepEqual((await alertStore(root,{stream:'capacity'}).pending()).map(x=>x.kind),['fault','recovery']);
free=49n;const critical=await capacitySnapshot(root,{policy,statfs});assert.throws(()=>requireCapacity(critical,'production'),/CAPACITY_PRODUCTION_LOW/);
console.log(JSON.stringify({status:'passed',installed_capacity:true,optional_suppression:true,production_floor:true,pending_recovery:true,network_requests:0,model_calls:0}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',SYNTHETIC_CAPACITY_ROOT:path.join(e.evidence_root,'synthetic-capacity')},timeout:60000}).trim());

// Sealed package read-only notification projection, without activation or transport.
const notifications=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {alertStore} from './scripts/m1-alerts.mjs';import {notificationSummary} from './scripts/m1-notifications.mjs';
const data=process.env.MFV_DATA_ROOT;await fs.mkdir(data,{recursive:true});
for(const stream of ['default','execution','capacity','service'])await alertStore(data,{stream}).observe({task:'ops',observationId:'SYNTHETIC_'+stream,at:'2026-09-15T00:00:00Z',condition:{code:'STORAGE_UNWRITABLE',object:'inspection',severity:'critical'},guard:async()=>{}});
const names=await fs.readdir(path.join(data,'m1-control'));const before=await Promise.all(names.map(n=>fs.readFile(path.join(data,'m1-control',n))));
const first=await notificationSummary(data);assert.equal(first.pending_count,4);assert.equal(first.transport,'not_configured');assert.equal(first.delivery,'pending');assert.equal((await notificationSummary(data)).event_set_id,first.event_set_id);
assert.deepEqual(await Promise.all(names.map(n=>fs.readFile(path.join(data,'m1-control',n)))),before);
console.log(JSON.stringify({status:'passed',installed_notification_projection:true,outbox_unchanged:true,transport_configured:false,delivery_verified:false}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:path.join(e.evidence_root,'synthetic-notifications')},timeout:30000});
console.log(notifications.trim());

// Forecast fallback in the sealed package uses real archives/outcome storage and
// a held business mutex. Only the public-data transport is synthetic.
const fallback=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {scoreOldForecasts,ops} from './scripts/m1-ops.mjs';import {businessMutex} from './scripts/m1-mutex.mjs';import {createDisplayReader} from './scripts/m1-display.mjs';
const data=process.env.SYNTHETIC_FALLBACK_ROOT;await fs.mkdir(data,{recursive:true});
for(const name of ['forecast-runs','data-source'])await fs.cp(path.join(process.env.MFV_DATA_ROOT,name),path.join(data,name),{recursive:true});
process.env.MFV_DATA_ROOT=data;
const id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011',reader=createDisplayReader({root:process.cwd(),dataRoot:data}),run=await reader.readRun(id);
// Retain one eligible archive so the assertions identify the exact object.
for(const other of await reader.listRunIds())if(other!==id)await fs.rm(path.join(data,'forecast-runs',other),{recursive:true});
const original=await fs.readFile(path.join(data,'forecast-runs',id,'manifest.json'));
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
let mutex=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_FALLBACK'});assert.equal(mutex.status,'ACQUIRED');
let requests=0;
const args={codeRoot:process.cwd(),dataRoot:data,mutex,deadline:performance.now()+45000,signal:AbortSignal.timeout(45000),outcomeTransport:async({file,signal,deadline})=>{
 requests++;assert.equal(signal,args.signal);assert.equal(deadline,args.deadline);await mutex.guard();
 assert.equal((await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_OTHER'})).status,'BUSY');
 await fs.writeFile(file,JSON.stringify({code:'0',msg:'SYNTHETIC',data:Array.from({length:96},(_,i)=>[String((run.forecast.anchor_time+i*900)*1000),...Array(4).fill(String(run.forecast.anchor_price)),'10','1','100','1']).reverse()}));return '200';}};
try{
 const opsCursor=path.join(data,'m1-control/ops-production-cursor.json'),ownCursor=path.join(data,'m1-control/forecast-fallback-production-cursor.json');
 const failed=await scoreOldForecasts({...args,outcomeTransport:async()=>{throw Error('SYNTHETIC_HTTP_FAILURE');}});assert.equal(failed.status,'partial');assert.equal(failed.unresolved[0].run_id,id);
 assert.equal(JSON.parse(await fs.readFile(ownCursor)).unresolved[0].run_id,id);assert.equal(await fs.stat(opsCursor).catch(()=>null),null);
 const done=await scoreOldForecasts(args);assert.equal(done.status,'completed');assert.equal(done.outcomes[0].window_status,'mature');assert.equal(done.unresolved.length,0);assert.equal(requests,1);
 const revision=(await reader.readRun(id)).evaluation.revision_id;
 assert.equal(JSON.parse(await fs.readFile(ownCursor)).unresolved.length,0);assert.equal(await fs.stat(opsCursor).catch(()=>null),null);
 await mutex.close();await fs.writeFile(path.join(data,'m1-cases'),'SYNTHETIC_CASE_WRITE_FAILURE');
 const inspection=await ops({codeRoot:process.cwd(),dataRoot:data,port,releaseId:'SYNTHETIC_OPS',outcomeTransport:async()=>assert.fail('mature must not redownload')});
 assert.equal(inspection.status,'partial');assert.equal(inspection.unresolved[0].run_id,id);assert.match(inspection.unresolved[0].reason,/ENOTDIR|EEXIST|NOT_DIRECTORY/);
 const opsBefore=await fs.readFile(opsCursor);
 mutex=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_FALLBACK'});assert.equal(mutex.status,'ACQUIRED');args.mutex=mutex;
 const again=await scoreOldForecasts(args);assert.equal(again.outcomes[0].reason,'already_mature');assert.equal(requests,1);assert.equal((await reader.readRun(id)).evaluation.revision_id,revision);
 assert.deepEqual(await fs.readFile(opsCursor),opsBefore);assert.equal(JSON.parse(opsBefore).unresolved[0].run_id,id);
 await assert.rejects(()=>scoreOldForecasts({...args,signal:AbortSignal.abort(Error('SYNTHETIC_ABORT'))}),/SYNTHETIC_ABORT/);
 await assert.rejects(()=>scoreOldForecasts({...args,deadline:performance.now()-1}),/FALLBACK_DEADLINE/);assert.equal(requests,1);
 assert.deepEqual(await fs.readFile(path.join(data,'forecast-runs',id,'manifest.json')),original);
 assert.equal(await fs.stat(path.join(data,'m1-learning')).catch(()=>null),null);
}finally{await mutex.close();}
const released=await businessMutex({dataRoot:data,port,releaseId:'SYNTHETIC_AFTER'});assert.equal(released.status,'ACQUIRED');await released.close();
console.log(JSON.stringify({status:'passed',installed_forecast_fallback:true,failed_capture_preserved:true,mature_no_redownload:true,shared_mutex:true,ops_case_failure_preserved:true,budget_checked:true,original_manifest_unchanged:true,model_calls:0,market_requests:0,activated_entry_verified:false}));
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:dataRoot,SYNTHETIC_FALLBACK_ROOT:path.join(e.evidence_root,'synthetic-fallback')},timeout:60000});
console.log(fallback.trim());

// Sealed ops/service composition: a real unknown listener is never controlled.
console.log(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {ops} from './scripts/m1-ops.mjs';import {inspectService} from './scripts/m1-service.mjs';import {notificationSummary} from './scripts/m1-notifications.mjs';
const data=process.env.MFV_DATA_ROOT;await fs.mkdir(data,{recursive:true});const home=path.join(data,'runtime');await fs.mkdir(home);
const server=net.createServer(s=>s.end());await new Promise(r=>server.listen(0,'127.0.0.1',r));
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
try{const options={codeRoot:process.cwd(),dataRoot:data,port,releaseId:'SYNTHETIC',inspectService:()=>inspectService({runtimeHome:home,port:server.address().port,releaseId:'SYNTHETIC',paused:false})};
const result=await ops(options);assert.equal(result.status,'partial');assert.equal(result.service.status,'unknown_listener');
await ops(options);const summary=await notificationSummary(data);assert.equal(summary.events.filter(x=>x.stream==='service').length,1);assert.equal(summary.events.find(x=>x.stream==='service').code,'SERVICE_UNKNOWN_LISTENER');assert.equal(server.listening,true);assert.equal(await fs.stat(path.join(home,'service/restarts.json')).catch(()=>null),null);
console.log(JSON.stringify({status:'passed',service_alert_integration:true,unknown_listener_preserved:true,delivery_verified:false}));
}finally{await new Promise(r=>server.close(r));}
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_DATA_ROOT:path.join(e.evidence_root,'synthetic-service-alert')},timeout:30000}).trim());

// Real synthetic forward archive/score/decision pipeline, not a hand-written summary.
const inputPlanCheck=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {pathToFileURL} from 'node:url';
import {planInputExperiment} from './scripts/m1-input-plan.mjs';import {verifyFeedbackDecision} from './scripts/m1-experiment-proof.mjs';
import {learningArguments} from './scripts/m1-admin-args.mjs';import {atomic,readJson} from './scripts/m1-files.mjs';
const {withFeedbackFixture}=await import(pathToFileURL(process.env.MFV_FORWARD_FIXTURE).href);
const data=process.env.MFV_DATA_ROOT,home=process.env.MFV_RUNTIME_HOME;await fs.mkdir(home,{recursive:true});
const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const releaseId='b'.repeat(64),config={schema:'MFV:INSTALLATION:v1',runtime_home:home,data_root:data,http_port:port===65535?port-1:port+1,mutex_port:port,forecast_paused:true,ops_paused:true,service_paused:true};
await atomic(home,path.join(home,'installation.local.json'),config);await atomic(home,path.join(home,'current.json'),{release_id:releaseId});
await withFeedbackFixture({codeRoot:process.cwd(),dataRoot:data,fixtureRoot:process.env.MFV_FIXTURE_ROOT},async({store,plan,decision,baseline,pairs,advance,digest,canonical})=>{
 const verify=()=>verifyFeedbackDecision({codeRoot:process.cwd(),dataRoot:data,plan,decision});assert.equal((await verify()).pair_ids.length,20);
 const dir=path.join(data,'m1-experiments',plan.id),marker=path.join(dir,'decision-commit.json'),originalMarker=await fs.readFile(marker);
 await fs.writeFile(marker,'{}');await assert.rejects(verify,/FEEDBACK_DECISION_BINDING_INVALID/);await fs.writeFile(marker,originalMarker);
 await assert.rejects(()=>verifyFeedbackDecision({codeRoot:process.cwd(),dataRoot:data,plan:{...plan,training_cutoff:'changed'},decision}),/FEEDBACK_DECISION_BINDING_INVALID/);
 await assert.rejects(()=>verifyFeedbackDecision({codeRoot:process.cwd(),dataRoot:data,plan,decision:{...decision,complete_pairs:21}}),/FEEDBACK_DECISION_BINDING_INVALID/);
 const registered=path.join(pairs[0].registration.dir,'registered.json'),bytes=await fs.readFile(registered);await fs.unlink(registered);await assert.rejects(verify,/ENOENT/);await fs.writeFile(registered,bytes);
 const revisionFile=path.join(data,'m1-outcomes',pairs[0].official.run_id,'evaluations',pairs[0].scored.production.revision_id,'manifest.json'),revisionBytes=await fs.readFile(revisionFile),revision=JSON.parse(revisionBytes);
 await fs.writeFile(revisionFile,JSON.stringify({...revision,evaluation_code_sha256:'0'.repeat(64)}));await assert.rejects(verify);await fs.writeFile(revisionFile,revisionBytes);
 const args=['plan-input','--input','calendar','--policy-sha',digest(canonical(baseline)),'--reason','SYNTHETIC controlled input comparison'];
 const options={runtimeHome:home,dataRoot:data,port,releaseId,codeRoot:process.cwd(),baseline,...learningArguments(args)};
 const result=await planInputExperiment(options);assert.equal(result.status,'planned');assert.equal(result.production_changed,false);assert.equal(result.model_called,false);assert.deepEqual(result.plan.candidate,{...baseline,additional_inputs:'calendar'});assert.ok(result.plan.training_evidence.case_ids.length>0);
 await assert.rejects(()=>planInputExperiment(options),/EXPERIMENT_ALREADY_ACTIVE/);
 // Mixed manual/automatic creation paths share the same allowance. Simulate a closed plan.
 const activeFile=path.join(data,'m1-experiments/active.json'),active=await fs.readFile(activeFile);await atomic(data,activeFile,{id:result.plan.id,status:'decided'});
 assert.equal(await store.creationStatus(),'DAILY_PLAN_LIMIT');await assert.rejects(()=>store.create(baseline,{...baseline,lambda:.1},{guard:async()=>{},factor:'probability'}),/DAILY_PLAN_LIMIT/);await fs.writeFile(activeFile,active);
 await store.pauseChanged({...baseline,model:'SYNTHETIC_CHANGED'},{guard:async()=>{}});const paused=await fs.readFile(activeFile);advance(86400000);
 await assert.rejects(()=>planInputExperiment({...options,input:'derivatives'}),/EXPERIMENT_PAUSED/);assert.deepEqual(await fs.readFile(activeFile),paused);
 assert.deepEqual(await readJson(home,path.join(home,'installation.local.json')),config);
 console.log(JSON.stringify({status:'passed',controlled_input_plan:true,real_synthetic_forward_pairs:20,exact_revision_replay:true,corrupt_prerequisites_rejected:true,shared_daily_limit:true,next_day_pause_preserved:true,official_activation:false,model_calls:0}));
});
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:path.join(e.evidence_root,'synthetic-input-plan-home'),MFV_DATA_ROOT:path.join(e.evidence_root,'synthetic-input-plan-data'),MFV_FIXTURE_ROOT:dataRoot,MFV_FORWARD_FIXTURE:path.join(process.cwd(),'tests/fixtures/forward-feedback.mjs')},timeout:120000});
console.log(inputPlanCheck.trim());
