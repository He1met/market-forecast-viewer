import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writePreparationFailure,readPreparationFailure,preparationInventory} from '../scripts/m1-preparation.mjs';
import {scheduledSlot} from '../scripts/m1-cycle.mjs';
import {digest} from '../scripts/m1-files.mjs';
const write=async(p,x)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,JSON.stringify(x));};
async function fixture(t,stage='history'){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'SYNTHETIC-preparation-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const started='2026-09-15T07:47:00.000Z',created='2026-09-15T07:47:00.001Z',runId='m1-20260915T074700001Z-00000000-0000-4000-8000-000000000001',observationId='00000000-0000-4000-8000-000000000002',releaseId='a'.repeat(64),slot=scheduledSlot(Date.parse(started));
 const runsRoot=path.join(root,'forecast-runs'),runDir=path.join(runsRoot,runId),obs=path.join(root,'m1-observations',observationId);
 await write(path.join(runDir,'run.json'),{schema:'MFV:M1_RUN:v1',run_id:runId,created_at:created,local_only:true});
 const context={observationId,releaseId,slotId:slot.slot_id},bound=await writePreparationFailure({dataRoot:root,runId,context,stage,startedAt:created,error:Error('SYNTHETIC download failed')});
 const start={schema:'MFV:OBSERVATION:v1',id:observationId,task:'forecast',trigger:'scheduled',release_id:releaseId,slot_id:slot.slot_id,started_at:started,status:'started'};
 const result={...start,status:'failed',reason:'SYNTHETIC download failed',preparation_failure:bound,completed_at:new Date().toISOString()};
 await write(path.join(obs,'started.json'),start);await write(path.join(obs,'result.json'),result);await write(path.join(root,'m1-slots',slot.slot_id+'.json'),{...slot,observation_id:observationId,release_id:releaseId,claimed_at:started});
 return{root,runId,runDir,obs,result,bound,read:()=>readPreparationFailure({codeRoot:process.cwd(),dataRoot:root,runsRoot,runId})};
}
test('SYNTHETIC ended bound pre-freeze failure is ineligible without rewriting failed receipt',async t=>{
 for(const stage of ['events','history','features','learning','supplementary']){const f=await fixture(t,stage),before=await fs.readFile(path.join(f.runDir,'preparation-failure.json'));assert.equal((await f.read()).status,'preparation_failed_not_scoreable');assert.equal((await f.read()).stage,stage);assert.deepEqual(await fs.readFile(path.join(f.runDir,'preparation-failure.json')),before);assert.equal(digest(before),f.bound.receipt_sha256);}
});
test('SYNTHETIC freeze-started, partial frozen files, success traces and broken binding remain unresolved',async t=>{
 const mutations=[
  f=>fs.writeFile(path.join(f.runDir,'input.json'),'{}'),
  f=>fs.mkdir(path.join(f.runDir,'attempt-001')),
  f=>fs.mkdir(path.join(f.root,'m1-outcomes',f.runId),{recursive:true}),
  f=>write(path.join(f.root,'m1-projections/index.json'),{latest_run_id:f.runId,runs:[]}),
  f=>write(path.join(f.root,'m1-task-status/last-forecast-success.json'),{forecast_id:f.runId}),
  f=>write(path.join(f.root,'m1-projections/views/synthetic.json'),{forecast:{run_id:f.runId}}),
  f=>write(path.join(f.obs,'result.json'),{...f.result,status:'completed'}),
  f=>write(path.join(f.obs,'result.json'),{...f.result,reason:'CONTRADICTORY_DIFFERENT_STAGE_ERROR'}),
  f=>write(path.join(f.obs,'result.json'),{...f.result,thread_id:'CONTRADICTORY_THREAD'}),
  f=>write(path.join(f.obs,'result.json'),{...f.result,task_id:'CONTRADICTORY_TASK'}),
  f=>write(path.join(f.obs,'result.json'),{...f.result,preparation_failure:{...f.bound,receipt_sha256:'f'.repeat(64)}}),
  f=>write(path.join(f.obs,'result.json'),{...f.result,forecast_id:f.runId}),
  f=>fs.unlink(path.join(f.obs,'result.json')),
  f=>fs.appendFile(path.join(f.runDir,'run.json'),' '),
  f=>fs.appendFile(path.join(f.runDir,'preparation-failure.json'),' '),
 ];
 for(const mutate of mutations){const f=await fixture(t);await mutate(f);await assert.rejects(f.read);}
 const frozen=await fixture(t,'freeze');await assert.rejects(frozen.read,/PREPARATION_RECEIPT_INVALID/);
});
test('SYNTHETIC original failure remains unverified without independent legacy proof; no ENOENT exemption',async t=>{
 const f=await fixture(t);await write(path.join(f.runDir,'preparation-failure.json'),{at:new Date().toISOString(),status:'failed',error:'SYNTHETIC',visibility:'LOCAL_ONLY'});
 assert.equal((await f.read()).status,'unverified_preparation_failure');await fs.unlink(path.join(f.runDir,'run.json'));await assert.rejects(f.read);
});

test('SYNTHETIC reviewed legacy proof binds all originals and current implementation; stale/corrupt proofs cannot qualify',async t=>{
 const {preparationHashes,auditPreparationProofs}=await import('../scripts/m1-preparation.mjs');const {canonical}=await import('../scripts/m1-files.mjs');const {createDisplayReader}=await import('../scripts/m1-display.mjs');
 const f=await fixture(t),failure={at:new Date().toISOString(),status:'failed',error:'SYNTHETIC download failed',visibility:'LOCAL_ONLY'};await write(path.join(f.runDir,'preparation-failure.json'),failure);
 const observation={...f.result,completed_at:new Date().toISOString(),thread_id:'SYNTHETIC'};delete observation.preparation_failure;await write(path.join(f.obs,'result.json'),observation);
 const verification={schema:'MFV:AUTOMATION_OBSERVATION:v1',run_id:f.runId,observation_id:observation.id,slot_id:observation.slot_id,business_status:'failed',failure_stage:'prepare_history_page_005',frozen_input_created:false,model_attempt_count:0,publication_count:0,same_slot_retry:false,started_at:observation.started_at,completed_at:observation.completed_at,trigger:observation.trigger,thread_id:observation.thread_id,release:{release_id:observation.release_id}};
 const map=await preparationHashes(process.cwd()),version=digest(canonical(map)),folder=path.join(f.root,'m1-preparation-proofs',f.runId,version);
 await write(path.join(folder,'verification.json'),verification);await fs.mkdir(folder,{recursive:true});await fs.copyFile(path.join(f.obs,'result.json'),path.join(folder,'observation.json'));
 const hash=async p=>digest(await fs.readFile(p));
 const statement={schema:'MFV:LEGACY_PREPARATION_PROOF:v1',run_id:f.runId,run_sha256:await hash(path.join(f.runDir,'run.json')),failure_sha256:await hash(path.join(f.runDir,'preparation-failure.json')),observation_id:observation.id,slot_id:observation.slot_id,inventory:await preparationInventory(f.root,f.runId),verification_sha256:await hash(path.join(folder,'verification.json')),observation_sha256:await hash(path.join(folder,'observation.json')),proposed_at:new Date().toISOString()};await write(path.join(folder,'statement.json'),statement);
 const decision={schema:'MFV:PREPARATION_PROOF_REVIEW:v1',decision:'unfrozen_preparation_failure_confirmed',statement_sha256:await hash(path.join(folder,'statement.json')),reviewed_commit:'b'.repeat(40),implementation_files:map};
 const review={id:15,user:{id:65616876,login:'He1met'},state:'COMMENTED',commit_id:'b'.repeat(40),submitted_at:new Date().toISOString(),html_url:'https://github.com/He1met/market-forecast-viewer/pull/29#pullrequestreview-15',body:'SYNTHETIC ONLY\n```mfv-preparation-proof-review\n'+JSON.stringify(decision)+'\n```'};await write(path.join(folder,'review.json'),review);
 assert.equal((await f.read()).status,'preparation_failed_not_scoreable');const reader=createDisplayReader({root:process.cwd(),dataRoot:f.root});assert.equal((await reader.readScoringRun(f.runId)).status,'preparation_failed_not_scoreable');assert.equal((await reader.runState(f.runId,new Date().toISOString())).status,'failed');
 const before=await fs.readFile(path.join(f.runDir,'preparation-failure.json'));
 const {scoreOldForecasts}=await import('../scripts/m1-ops.mjs');const result=await scoreOldForecasts({codeRoot:process.cwd(),dataRoot:f.root,mutex:{guard:async()=>{}},signal:AbortSignal.timeout(10000),deadline:performance.now()+10000,outcomeTransport:()=>assert.fail('NO_CAPTURE')});assert.equal(result.status,'completed');assert.equal(result.outcomes[0].reason,'preparation_failed_not_scoreable');assert.deepEqual(await fs.readFile(path.join(f.runDir,'preparation-failure.json')),before);
 const net=await import('node:net'),server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const {backup,restore}=await import('../scripts/m1-backup.mjs'),{replayRestored}=await import('../scripts/m1-restore-replay.mjs');const target=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'SYNTHETIC-preparation-backup-'));t.after(()=>fs.rm(target,{recursive:true,force:true}));
 const saved=await backup({dataRoot:f.root,target,port,releaseId:'SYNTHETIC'});assert.equal(saved.status,'completed');assert.equal(saved.manifest.files.filter(x=>x.name.startsWith('m1-preparation-proofs/')).length,4);
 const destination=path.join(f.root,'restored'),restored=await restore({target,manifestFile:path.join(target,'manifests',saved.manifest.id+'.json'),destination,verify:dataRoot=>replayRestored({codeRoot:process.cwd(),dataRoot,limit:30})});assert.equal(restored.replay.passed,true);assert.equal((await readPreparationFailure({codeRoot:process.cwd(),dataRoot:destination,runsRoot:path.join(destination,'forecast-runs'),runId:f.runId})).status,'preparation_failed_not_scoreable');
 const staleMap={...map,'scripts/m1-preparation.mjs':'f'.repeat(64)},staleFolder=path.join(path.dirname(folder),digest(canonical(staleMap)));
 await fs.rename(folder,staleFolder);await write(path.join(staleFolder,'review.json'),{...review,body:'SYNTHETIC ONLY\n```mfv-preparation-proof-review\n'+JSON.stringify({...decision,implementation_files:staleMap})+'\n```'});
 assert.equal((await f.read()).status,'unverified_preparation_failure');await assert.rejects(replayRestored({codeRoot:process.cwd(),dataRoot:f.root,limit:30}),/PREPARATION_FAILURE_UNPROVEN/);
 await fs.rename(staleFolder,folder);await write(path.join(folder,'review.json'),review);
 await write(path.join(folder,'review.json'),{...review,state:'DISMISSED'});await assert.rejects(f.read,/PREPARATION_PROOF_REVIEW/);await write(path.join(folder,'review.json'),review);
 await fs.appendFile(path.join(folder,'observation.json'),' ');await assert.rejects(auditPreparationProofs(f.root),/PREPARATION_PROOF_SOURCE_HASH/);
});
