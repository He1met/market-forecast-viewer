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
import{runtimeDisplaySchema}from'./src/m1-display.ts';
import net from'node:net';import fs from'node:fs/promises';
const reader=createDisplayReader({root:process.cwd(),dataRoot:process.env.MFV_DATA_ROOT});
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
import {setForecastPaused} from './scripts/m1-admin.mjs';import {atomic,validateInstallation} from './scripts/m1-files.mjs';import {publicationHealth} from './scripts/m1-publication-health.mjs';
const home=path.join(process.env.MFV_RUNTIME_HOME,'pause-home'),data=path.join(process.env.MFV_RUNTIME_HOME,'pause-data');await fs.mkdir(home);await fs.mkdir(data);
const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));
const file=path.join(home,'installation.local.json'),releaseId='a'.repeat(64);await atomic(home,file,{schema:'MFV:INSTALLATION:v1',runtime_home:home,data_root:data,http_port:port===65535?port-1:port+1,mutex_port:port,forecast_paused:true,ops_paused:true});await atomic(home,path.join(home,'current.json'),{release_id:releaseId});
const change=(paused,at)=>setForecastPaused({runtimeHome:home,releaseId,paused,clock:()=>Date.parse(at)});
await change(false,'2026-09-15T05:47:00Z');await change(true,'2026-09-15T06:00:00Z');assert.equal((await validateInstallation(file)).forecast_expected_since,null);
await change(false,'2026-09-15T07:48:00Z');await change(false,'2026-09-15T08:00:00Z');const config=await validateInstallation(file);assert.equal(config.forecast_expected_since,'2026-09-15T07:48:00.000Z');assert.equal(config.ops_paused,true);
const health=await publicationHealth({reader:{listRunIds:async()=>[]},paused:false,expectedSince:config.forecast_expected_since,now:Date.parse('2026-09-15T08:02:00Z')});assert.equal(health.status,'waiting');assert.equal(health.slots.length,0);
console.log(JSON.stringify({status:'passed',installed_pause_epoch:true,paused_history_excluded:true,repeated_resume_idempotent:true,official_activation:false}));
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
`],{cwd:target,encoding:'utf8',env:{...process.env,NODE_PATH:'',MFV_RUNTIME_HOME:e.evidence_root,MFV_DATA_ROOT:path.join(e.evidence_root,'synthetic-candidate-chain'),MFV_FIXTURE_ROOT:dataRoot},timeout:30000});
console.log(candidateChain.trim());
