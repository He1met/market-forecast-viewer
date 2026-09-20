// All source manifests/reviews below are isolated SYNTHETIC fixtures, never owner evidence.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';
import {requireEvidence} from '../scripts/evidence-context.mjs';import {seal} from '../src/contracts.ts';
import {newRun,freezeInput,prepareAttempt,completeAttempt} from '../scripts/m1-archive.mjs';
import {digest,encode,canonical} from '../scripts/m1-files.mjs';import {auditCodexEvents} from '../scripts/m1-forecast.mjs';import {modelArguments} from '../scripts/m1-model.mjs';
import {cycle} from '../scripts/m1-cycle.mjs';import {experimentStore} from '../scripts/m1-experiments.mjs';import {createDisplayReader} from '../scripts/m1-display.mjs';
import {replayRestored} from '../scripts/m1-restore-replay.mjs';
import {candidateEvidence,candidateImplementationHashes,readCandidateProof} from '../scripts/m1-candidate-proof.mjs';import {scanOpsBatch} from '../scripts/m1-ops.mjs';import {backup,restore} from '../scripts/m1-backup.mjs';
const codeRoot=requireEvidence().workspace,read=async p=>JSON.parse(await fs.readFile(p)),write=async(p,v)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,encode(v));};
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function fixture(t){
 const dataRoot=await fs.mkdtemp(path.join(codeRoot,'artifacts/SYNTHETIC-candidate-proof-')),old=process.env.MFV_DATA_ROOT;process.env.MFV_DATA_ROOT=dataRoot;
 t.after(async()=>{if(old===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=old;await fs.rm(dataRoot,{recursive:true,force:true});});
 const NativeDate=Date,time=NativeDate.parse('2026-09-12T17:47:00.000Z');t.mock.method(globalThis,'Date',class extends NativeDate{constructor(...args){super(...(args.length?args:[time]));}static now(){return time;}});
 const template=path.join(codeRoot,'artifacts/forecast-runs/m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011'),input=await read(path.join(template,'input.json')),schema=await read(path.join(template,'output-schema.json'));
 const delta=-2700,h=input.history;h.start_time+=delta;h.end_time+=delta;h.source.request.requested_start_time+=delta;h.source.request.requested_end_time+=delta;h.downloaded_at='2026-09-12T17:46:00.000Z';for(const c of h.candles){c.open_time+=delta;c.close_time+=delta;}
 for(const source of h.source.raw_responses){const raw=await read(path.join(codeRoot,source.path));for(const row of raw.data)row[0]=String(Number(row[0])+delta*1000);const file=path.join(dataRoot,source.path.replace(/^artifacts\//,''));await write(file,raw);source.sha256=digest(await fs.readFile(file));source.requested_at=h.downloaded_at;if(source.params.after)source.params.after=String(Number(source.params.after)+delta*1000);}
 input.history=await seal(h);input.anchor_time=h.end_time;input.events.information_cutoff=h.downloaded_at;
 const policy={predictor_version:'m1-final-v1',feedback:'F0',lambda:0,additional_inputs:'none',model:'gpt-6-astra',reasoning_effort:'medium'},learning=p=>({feedback_mode:p.feedback,lambda:p.lambda,predictor_identity:p});input.model_context.learning=learning(policy);
 const hashes={};for(const name of ['scripts/m1-forecast.mjs','src/m1-contracts.ts','src/contracts.ts'])hashes[name]=digest(await fs.readFile(path.join(codeRoot,name)));
 const sourceFiles={};for(const name of [...Object.keys(hashes),'scripts/m1-cycle.mjs','scripts/m1-experiments.mjs','scripts/m1-entry.mjs']){const b=await fs.readFile(path.join(codeRoot,name));sourceFiles[name]={bytes:b.length,sha256:digest(b)};}
 const sourceManifest={schema:'MFV:RUNTIME_PACKAGE:v1',build_sha:'a'.repeat(40),synthetic:false,source_kind:'git_archive',files:sourceFiles};sourceManifest.release_id=digest(encode(sourceManifest));
 const store=experimentStore(dataRoot),plan=await store.create(policy,{...policy,feedback:'F1'},{guard:async()=>{}});let official,candidate,registration;
 const result=await cycle({dataRoot,clock:()=>time,mutexPort:await port(),releaseId:sourceManifest.release_id,trigger:'manual',taskId:'SYNTHETIC',threadId:'SYNTHETIC',resolvePolicy:async()=>policy,
 registerOpportunity:async(slot,{guard})=>(registration=await store.register(slot,policy,{guard})),
 freeze:async()=>{official=await newRun(path.join(dataRoot,'forecast-runs'));await freezeInput(official.runDir,input,'SYNTHETIC',schema,{code_head:sourceManifest.build_sha,code_sha256:hashes});return official;},
 prepareCandidate:async(r,o,{guard})=>(candidate=await store.freezeCandidate(r,o,{guard,learningBuilder:async(a,b,p)=>learning(p)})),
 generate:async(run)=>{const a=await prepareAttempt(run.runDir),thread='SYNTHETIC-'+a.attempt_id,cli_version='codex-cli 0.155.0-alpha.9.2',workspace=path.join(a.attemptDir,'model-work'),invocation={schema:'MFV:MODEL_INVOCATION:v1',provider:'official_codex',cli_version,requested_model:'gpt-6-astra',requested_reasoning:'medium',working_directory:workspace,frozen_input_sha256:digest(await fs.readFile(path.join(run.runDir,'input.json'))),args:modelArguments({workspace,schema:path.join(run.runDir,'output-schema.json'),output:a.rawFile})};
  await fs.mkdir(workspace);const stream=[{type:'thread.started',thread_id:thread},{type:'turn.started'},{type:'item.completed',item:{id:'bad',type:'command_execution',command:'SYNTHETIC forbidden tool'}},{type:'turn.completed'}].map(x=>JSON.stringify(x)).join('\n')+'\n';const ib=encode(invocation);await fs.writeFile(path.join(a.attemptDir,'events.jsonl'),stream);await fs.writeFile(path.join(a.attemptDir,'invocation.json'),ib);const audit=auditCodexEvents(stream,{kind:'installed_frozen_input',cli_version,args:invocation.args});
  await completeAttempt(run.runDir,a.attempt_id,{exit_code:-1,error:'MODEL_ATTEMPT_REJECTED',cli_exit_code:0,model_thread_id:thread,unexpected_tool_events:audit.unexpected_count,turn_completed:audit.turn_completed,model_config:{cli_version,startup_warning_count:audit.startup_warning_count},event_audit:{schema:'MFV:CODEX_EVENT_AUDIT:v1',events_sha256:digest(stream),invocation_sha256:digest(ib),cli_version,controlled_disabled_context:audit.controlled_disabled_context,startup_notice_count:audit.startup_notice_count,startup_notices:audit.startup_notices,unexpected_event_count:audit.unexpected_count,unexpected_tool_count:audit.unexpected_tool_count,turn_completed:audit.turn_completed,failed:audit.failed}});throw Error('MODEL_ATTEMPT_REJECTED');},
 publishIndex:async()=>assert.fail('no publication'),runCandidate:async()=>assert.fail('candidate must not be called'),finishOpportunity:(r,x)=>store.finish(r,x)});
 assert.equal(result.reason,'MODEL_ATTEMPT_REJECTED');assert.equal((await read(path.join(registration.dir,'generation.json'))).candidate_invoked,false);
 const evidence=await candidateEvidence(dataRoot,candidate.run_id),statement={schema:'MFV:CANDIDATE_NONINVOCATION:v1',evidence,source_manifest_sha256:digest(encode(sourceManifest)),proposed_at:new Date().toISOString()},map=await candidateImplementationHashes(codeRoot),dir=path.join(dataRoot,'m1-candidate-proofs',candidate.run_id,digest(canonical(map)));
 await write(path.join(dir,'statement.json'),statement);await write(path.join(dir,'source-manifest.json'),sourceManifest);for(const name of ['m1-cycle.mjs','m1-experiments.mjs','m1-entry.mjs'])await fs.copyFile(path.join(codeRoot,'scripts',name),path.join(dir,'source-'+name));
 const decision={schema:'MFV:CANDIDATE_PROOF_REVIEW:v1',decision:'official_failure_prevented_candidate_invocation_confirmed',statement_sha256:digest(encode(statement)),reviewed_commit:'b'.repeat(40),implementation_files:map},review={id:1,user:{id:65616876,login:'He1met'},state:'COMMENTED',commit_id:'b'.repeat(40),submitted_at:new Date().toISOString(),html_url:'https://github.com/He1met/market-forecast-viewer/pull/37#pullrequestreview-1',body:'SYNTHETIC ONLY\n```mfv-candidate-proof-review\n'+JSON.stringify(decision)+'\n```'};await write(path.join(dir,'review.json'),review);
 const reader=createDisplayReader({root:codeRoot,dataRoot,runsRoot:path.join(dataRoot,'m1-candidates')});return{dataRoot,official,candidate,registration,plan,dir,reader,evidence};
}
test('SYNTHETIC real cycle official failure leaves a provably uninvoked candidate, without changing its bytes or experiment counts',async t=>{
 const f=await fixture(t),before=await candidateEvidence(f.dataRoot,f.candidate.run_id);
 assert.equal((await f.reader.readScoringRun(f.candidate.run_id)).status,'candidate_not_invoked_not_scoreable');assert.equal((await f.reader.runState(f.candidate.run_id,new Date().toISOString())).status,'skipped');
 for(let i=0;i<2;i++){const result=await scanOpsBatch({dataRoot:f.dataRoot,role:'candidate',ids:[f.candidate.run_id],guard:async()=>{},visit:async id=>({status:'ok',reason:(await f.reader.readScoringRun(id)).status})});assert.deepEqual(result.unresolved,[]);}
 await write(path.join(f.dataRoot,'m1-projections/index.json'),{schema:'MFV:PROJECTIONS:v1',latest_run_id:'unrelated',runs:[{run_id:f.candidate.run_id,status:'skipped',reason:'candidate_not_invoked',projection:null,published_at:null}]});await write(path.join(f.dataRoot,'m1-task-status/last-forecast-success.json'),{forecast_id:'unrelated'});
 assert.equal((await f.reader.readScoringRun(f.candidate.run_id)).status,'candidate_not_invoked_not_scoreable');assert.deepEqual(await candidateEvidence(f.dataRoot,f.candidate.run_id),before);
 const decision=await experimentStore(f.dataRoot).review({readMetrics:async()=>null,guard:async()=>{}});assert.equal(decision.complete_pairs,0);
});
test('SYNTHETIC partial attempts, publication, changed source/binding, missing reviews and nonfailure skips stay unresolved',async t=>{
 const f=await fixture(t),id=f.candidate.run_id;
 for(const name of ['attempt-001','publication','execution-started.json'])await t.test(name,async()=>{const p=path.join(f.candidate.runDir,name);await fs.mkdir(p);await assert.rejects(()=>f.reader.readScoringRun(id));await fs.rmdir(p);});
 for(const [file,change]of [[path.join(f.registration.dir,'generation.json'),x=>({...x,candidate_status:'budget_skipped'})],[path.join(f.registration.dir,'generation.json'),x=>({...x,candidate_status:'capacity_skipped'})],[path.join(f.registration.dir,'generation.json'),x=>({...x,candidate_invoked:true})],[path.join(f.registration.dir,'frozen.json'),x=>({...x,candidate_input_hash:'0'.repeat(64)})],[path.join(f.registration.dir,'registered.json'),x=>({...x,anchor_time:x.anchor_time+900})],[path.join(f.dir,'review.json'),x=>({...x,state:'CHANGES_REQUESTED'})],[path.join(f.dir,'source-manifest.json'),x=>({...x,build_sha:'c'.repeat(40)})]]){
  const original=await fs.readFile(file);await write(file,change(JSON.parse(original)));await assert.rejects(()=>f.reader.readScoringRun(id));await fs.writeFile(file,original);
 }
 for(const name of ['attempt-001/model-work','attempt-002/model-work']){
  const workspace=path.join(f.official.runDir,name);await fs.writeFile(path.join(workspace,'trace'),'SYNTHETIC');await assert.rejects(()=>f.reader.readScoringRun(id),/CANDIDATE_WORKSPACE_TRACE/);await fs.unlink(path.join(workspace,'trace'));
  await fs.rmdir(workspace);assert.equal((await f.reader.readScoringRun(id)).status,'candidate_not_invoked_not_scoreable');
  await fs.writeFile(workspace,'SYNTHETIC');await assert.rejects(()=>f.reader.readScoringRun(id));await fs.unlink(workspace);
  await fs.symlink(f.dataRoot,workspace);await assert.rejects(()=>f.reader.readScoringRun(id));await fs.unlink(workspace);await fs.mkdir(workspace);
 }
 const extra=path.join(f.official.runDir,'extra-empty');await fs.mkdir(extra);await assert.rejects(()=>f.reader.readScoringRun(id),/CANDIDATE_PROOF_STATEMENT/);await fs.rmdir(extra);
 const source=path.join(f.dir,'source-m1-cycle.mjs'),original=await fs.readFile(source);await fs.appendFile(source,'\n// tampered');await assert.rejects(()=>f.reader.readScoringRun(id),/CANDIDATE_SOURCE_CODE/);await fs.writeFile(source,original);
 const review=path.join(f.dir,'review.json');await fs.rename(review,review+'.missing');await assert.rejects(()=>f.reader.readScoringRun(id));await fs.rename(review+'.missing',review);
 await write(path.join(f.dataRoot,'m1-outcomes',id,'unexpected.json'),{});await assert.rejects(()=>f.reader.readScoringRun(id),/CANDIDATE_SUCCESS_TRACE/);
});
test('SYNTHETIC reviewed proof and complete relationship survive byte-exact backup restore with quarantined controls',async t=>{
 const f=await fixture(t),target=path.join(f.dataRoot,'..','backup-'+path.basename(f.dataRoot));await fs.mkdir(target);t.after(()=>fs.rm(target,{recursive:true,force:true}));
 const b=await backup({dataRoot:f.dataRoot,target,port:await port(),releaseId:'SYNTHETIC'});assert.ok(b.manifest.files.some(x=>x.name.startsWith('m1-candidate-proofs/')));
 const destination=target+'/restored';await restore({target,manifestFile:target+'/manifests/'+b.manifest.id+'.json',destination,verify:async root=>{process.env.MFV_DATA_ROOT=root;const reader=createDisplayReader({root:codeRoot,dataRoot:root,runsRoot:path.join(root,'m1-candidates')});assert.equal((await reader.readScoringRun(f.candidate.run_id)).status,'candidate_not_invoked_not_scoreable');return await replayRestored({codeRoot,dataRoot:root});}});
 for(const e of b.manifest.files)if(!e.name.startsWith('m1-control/')&&!e.name.startsWith('m1-task-status/'))assert.equal(digest(await fs.readFile(path.join(destination,e.name))),e.sha256);
});
