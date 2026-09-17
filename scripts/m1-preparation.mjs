// A preparation failure is not a failed model attempt or a missing publication.
// Only a completed, bound pre-freeze receipt can establish scoring ineligibility.
import fs from 'node:fs/promises';
import path from 'node:path';
import {check,digest,canonical,readBytes,readJson,exists,safePath} from './m1-files.mjs';
import {closureInventory,closureImplementationFiles} from './m1-closures.mjs';
import {runIdSchema} from '../src/m1-display.ts';
import {parseStrict} from '../src/contracts.ts';
import {scheduledSlot} from './m1-cycle.mjs';
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&canonical(Object.keys(x).sort())===canonical([...fields].sort());
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT.*Z$/.test(x)&&Number.isFinite(Date.parse(x));
const prefreeze=['events','history','features','learning','supplementary'];
export const preparationImplementationFiles=[...closureImplementationFiles,'scripts/m1-preparation.mjs','scripts/m1-publication-health.mjs','scripts/m1-input.mjs','scripts/m1-cycle.mjs','scripts/m1-entry.mjs'];
export async function preparationHashes(codeRoot){const result={};for(const f of preparationImplementationFiles)result[f]=digest(await readBytes(codeRoot,path.join(codeRoot,f)));return result;}
export async function preparationInventory(dataRoot,runId){
 const dir=path.join(dataRoot,'forecast-runs',runId);const run=(await closureInventory(dir)).filter(x=>x.path!=='preparation-failure.json');
 const source=path.join(dataRoot,'data-source',runId);return{run,source:await exists(source)?await closureInventory(source):null};
}
async function noSuccess(dataRoot,runId,inventory){
 check(inventory.run.every(x=>x.kind==='file'&&(x.path==='run.json'||/^events-source-\d{3}\.raw$/.test(x.path))),'PREPARATION_FROZEN_OR_LATER_TRACE');
 for(const root of ['m1-outcomes','m1-closures','m1-candidates'])check(!await exists(path.join(dataRoot,root,runId)),'PREPARATION_SUCCESS_TRACE');
 const cases=path.join(dataRoot,'m1-cases');if(await exists(cases)){await safePath(dataRoot,cases);for(const id of await fs.readdir(cases)){const f=path.join(cases,id,'case.json');if(await exists(f))check((await readJson(dataRoot,f)).run_id!==runId,'PREPARATION_CASE_TRACE');}}
 for(const name of ['forecast','last-forecast-success']){const f=path.join(dataRoot,'m1-task-status',name+'.json');if(await exists(f))check((await readJson(dataRoot,f)).forecast_id!==runId,'PREPARATION_SUCCESS_TRACE');}
 const index=path.join(dataRoot,'m1-projections/index.json');if(await exists(index)){const x=await readJson(dataRoot,index);check(x.latest_run_id!==runId&&!x.runs?.some(r=>r.run_id===runId&&(r.published_at||['valid','late'].includes(r.status))),'PREPARATION_INDEX_TRACE');}
 const views=path.join(dataRoot,'m1-projections/views');if(await exists(views)){await safePath(dataRoot,views);for(const file of await fs.readdir(views)){const x=await readJson(dataRoot,path.join(views,file));check(x.run_id!==runId&&x.run?.run_id!==runId&&x.forecast?.run_id!==runId,'PREPARATION_INDEX_TRACE');}}
}
async function metadata(dataRoot,runId){const b=await readBytes(dataRoot,path.join(dataRoot,'forecast-runs',runId,'run.json')),r=parseStrict(b.toString('utf8'));check(exact(r,['schema','run_id','created_at','local_only'])&&r.schema==='MFV:M1_RUN:v1'&&r.run_id===runId&&r.local_only===true&&iso(r.created_at)&&runId.startsWith('m1-'+r.created_at.replace(/[-:.]/g,'')+'-'),'PREPARATION_RUN_IDENTITY');return{r,sha:digest(b)};}
export async function writePreparationFailure({dataRoot,runId,context,stage,startedAt,error}){
 const file=path.join(dataRoot,'forecast-runs',runId,'preparation-failure.json'),base={at:new Date().toISOString(),status:'failed',error:String(error.message),visibility:'LOCAL_ONLY'};
 if(!context){await fs.writeFile(file,JSON.stringify(base,null,2)+'\n',{flag:'wx',mode:0o600});return null;}
 check(uuid(context.observationId)&&sha(context.slotId)&&sha(context.releaseId),'PREPARATION_CONTEXT_INVALID');
 const m=await metadata(dataRoot,runId),receipt={...base,schema:'MFV:PREPARATION_FAILURE:v1',run_id:runId,run_sha256:m.sha,observation_id:context.observationId,slot_id:context.slotId,release_id:context.releaseId,started_at:startedAt,stage,freeze_started:stage==='freeze',prepared_inventory:await preparationInventory(dataRoot,runId)};
 const bytes=JSON.stringify(receipt,null,2)+'\n';await fs.writeFile(file,bytes,{flag:'wx',mode:0o600});return{run_id:runId,receipt_sha256:digest(bytes)};
}
async function readBoundFailure(dataRoot,runId,m,f,raw,inventory){
 check(exact(f,['schema','run_id','run_sha256','observation_id','slot_id','release_id','started_at','at','status','error','visibility','stage','freeze_started','prepared_inventory'])&&f.schema==='MFV:PREPARATION_FAILURE:v1'&&f.run_id===runId&&f.run_sha256===m.sha&&uuid(f.observation_id)&&sha(f.slot_id)&&sha(f.release_id)&&iso(f.started_at)&&Date.parse(f.started_at)>=Date.parse(m.r.created_at)&&Date.parse(f.started_at)<=Date.parse(f.at)&&prefreeze.includes(f.stage)&&f.freeze_started===false&&canonical(f.prepared_inventory)===canonical(inventory),'PREPARATION_RECEIPT_INVALID');
 const dir=path.join(dataRoot,'m1-observations',f.observation_id),start=await readJson(dataRoot,path.join(dir,'started.json')),end=await readJson(dataRoot,path.join(dir,'result.json')),slot=await readJson(dataRoot,path.join(dataRoot,'m1-slots',f.slot_id+'.json'));
 check(start.schema==='MFV:OBSERVATION:v1'&&end.schema===start.schema&&start.id===f.observation_id&&end.id===start.id&&start.task==='forecast'&&end.task===start.task&&start.release_id===f.release_id&&end.release_id===start.release_id&&start.slot_id===f.slot_id&&end.slot_id===start.slot_id&&end.started_at===start.started_at&&['manual','scheduled'].includes(start.trigger)&&end.trigger===start.trigger&&iso(start.started_at)&&iso(end.completed_at)&&Date.parse(start.started_at)<=Date.parse(m.r.created_at)&&Date.parse(end.completed_at)>=Date.parse(f.at)&&Date.parse(end.completed_at)<=Date.now()&&end.status==='failed'&&!end.forecast_id&&!end.publication_committed&&exact(end.preparation_failure,['run_id','receipt_sha256'])&&end.preparation_failure.run_id===runId&&end.preparation_failure.receipt_sha256===digest(raw),'PREPARATION_OBSERVATION_MISMATCH');
 const expected=scheduledSlot(Date.parse(start.started_at));
 check(slot.schema==='MFV:SLOT:v1'&&slot.slot_id===f.slot_id&&slot.observation_id===f.observation_id&&slot.release_id===f.release_id&&
  Object.entries(expected).every(([key,value])=>slot[key]===value)&&Date.parse(m.r.created_at)>=Date.parse(slot.target_at)&&Date.parse(m.r.created_at)<slot.first_node*1000,'PREPARATION_SLOT_MISMATCH');
 return{status:'preparation_failed_not_scoreable',run_id:runId,stage:f.stage,observation_id:f.observation_id,slot_id:f.slot_id,receipt_sha256:digest(raw)};
}
export async function readPreparationFailure({codeRoot,dataRoot,runId,runsRoot}){
 runIdSchema.parse(runId);const file=path.join(runsRoot,runId,'preparation-failure.json');if(!await exists(file))return null;
 check(path.resolve(runsRoot)===path.join(path.resolve(dataRoot),'forecast-runs'),'PREPARATION_ROLE_UNSUPPORTED');
 const m=await metadata(dataRoot,runId),raw=await readBytes(dataRoot,file),f=parseStrict(raw.toString('utf8'));
 check(f.status==='failed'&&f.visibility==='LOCAL_ONLY'&&typeof f.error==='string'&&iso(f.at)&&Date.parse(f.at)>=Date.parse(m.r.created_at)&&Date.parse(f.at)<=Date.now(),'PREPARATION_FAILURE_INVALID');
 const inventory=await preparationInventory(dataRoot,runId);await noSuccess(dataRoot,runId,inventory);
 if(f.schema)return readBoundFailure(dataRoot,runId,m,f,raw,inventory);
 check(exact(f,['at','status','error','visibility']),'PREPARATION_LEGACY_INVALID');
 const records=await auditPreparationProofs(dataRoot),key=runId+'/'+digest(canonical(await preparationHashes(codeRoot)));
 const record=records.get(key);if(!record)return{status:'unverified_preparation_failure',run_id:runId};
 check(record.statement.run_sha256===m.sha&&record.statement.failure_sha256===digest(raw)&&canonical(record.statement.inventory)===canonical(inventory),'PREPARATION_PROOF_ARCHIVE_CHANGED');
 return{status:'preparation_failed_not_scoreable',run_id:runId,stage:'history',observation_id:record.statement.observation_id,slot_id:record.statement.slot_id,receipt_sha256:digest(raw),review_url:record.review.html_url};
}
// Legacy proof is a current reviewed disposition. It never rewrites the old
// receipt or invents missing execution fields. All historical versions are read.
export async function auditPreparationProofs(dataRoot){
 const root=path.join(dataRoot,'m1-preparation-proofs'),records=new Map();if(!await exists(root))return records;await safePath(dataRoot,root);
 const ids=await fs.readdir(root);check(ids.length<=64,'PREPARATION_PROOF_LIMIT');
 for(const id of ids){runIdSchema.parse(id);const dir=path.join(root,id);await safePath(dataRoot,dir);const versions=await fs.readdir(dir);check(versions.length>0&&versions.length<=64,'PREPARATION_PROOF_LIMIT');const m=await metadata(dataRoot,id);const inventory=await preparationInventory(dataRoot,id);await noSuccess(dataRoot,id,inventory);
  for(const version of versions){check(sha(version),'PREPARATION_PROOF_VERSION');const folder=path.join(dir,version);await safePath(dataRoot,folder);check(canonical((await fs.readdir(folder)).sort())===canonical(['observation.json','review.json','statement.json','verification.json']),'PREPARATION_PROOF_FILES');
   const bytes=await readBytes(dataRoot,path.join(folder,'statement.json')),s=parseStrict(bytes.toString('utf8')),review=await readJson(dataRoot,path.join(folder,'review.json'));
   check(exact(s,['schema','run_id','run_sha256','failure_sha256','observation_id','slot_id','inventory','verification_sha256','observation_sha256','proposed_at'])&&s.schema==='MFV:LEGACY_PREPARATION_PROOF:v1'&&s.run_id===id&&s.run_sha256===m.sha&&s.failure_sha256===digest(await readBytes(dataRoot,path.join(dataRoot,'forecast-runs',id,'preparation-failure.json')))&&canonical(s.inventory)===canonical(inventory)&&uuid(s.observation_id)&&sha(s.slot_id)&&iso(s.proposed_at),'PREPARATION_PROOF_STATEMENT');
   const vb=await readBytes(dataRoot,path.join(folder,'verification.json')),ob=await readBytes(dataRoot,path.join(folder,'observation.json'));check(digest(vb)===s.verification_sha256&&digest(ob)===s.observation_sha256,'PREPARATION_PROOF_SOURCE_HASH');const v=parseStrict(vb.toString('utf8')),o=parseStrict(ob.toString('utf8')),failure=await readJson(dataRoot,path.join(dataRoot,'forecast-runs',id,'preparation-failure.json'));
   check(exact(failure,['at','status','error','visibility'])&&failure.status==='failed'&&failure.visibility==='LOCAL_ONLY'&&typeof failure.error==='string'&&iso(failure.at)&&Date.parse(failure.at)>=Date.parse(m.r.created_at)&&o.reason===failure.error&&iso(o.started_at)&&iso(o.completed_at)&&Date.parse(o.started_at)<=Date.parse(m.r.created_at)&&Date.parse(o.completed_at)>=Date.parse(failure.at)&&v.started_at===o.started_at&&v.trigger===o.trigger&&v.thread_id===o.thread_id&&v.release?.release_id===o.release_id,'PREPARATION_PROOF_IDENTITY');
   check(v.schema==='MFV:AUTOMATION_OBSERVATION:v1'&&v.run_id===id&&v.observation_id===s.observation_id&&v.slot_id===s.slot_id&&v.business_status==='failed'&&v.failure_stage==='prepare_history_page_005'&&v.frozen_input_created===false&&v.model_attempt_count===0&&v.publication_count===0&&v.same_slot_retry===false&&o.schema==='MFV:OBSERVATION:v1'&&o.id===s.observation_id&&o.slot_id===s.slot_id&&o.task==='forecast'&&o.status==='failed'&&!o.forecast_id&&!o.publication_committed&&v.completed_at===o.completed_at&&Date.parse(o.completed_at)<=Date.parse(s.proposed_at)&&digest(await readBytes(dataRoot,path.join(dataRoot,'m1-observations',s.observation_id,'result.json')))===s.observation_sha256,'PREPARATION_PROOF_SOURCE');
   check(review.user?.id===65616876&&review.user.login==='He1met'&&['COMMENTED','APPROVED'].includes(review.state)&&Number.isSafeInteger(review.id)&&/^[a-f0-9]{40}$/.test(review.commit_id??'')&&iso(review.submitted_at)&&Date.parse(review.submitted_at)>=Date.parse(s.proposed_at)&&Date.parse(review.submitted_at)<=Date.now()&&new RegExp('^https://github.com/He1met/market-forecast-viewer/pull/[1-9][0-9]*#pullrequestreview-'+review.id+'$').test(review.html_url??''),'PREPARATION_PROOF_REVIEW');
   const blocks=typeof review.body==='string'?[...review.body.matchAll(/```mfv-preparation-proof-review\n([\s\S]*?)\n```/g)]:[];check(blocks.length===1,'PREPARATION_PROOF_REVIEW');const d=parseStrict(blocks[0][1]);
   check(exact(d,['schema','decision','statement_sha256','reviewed_commit','implementation_files'])&&d.schema==='MFV:PREPARATION_PROOF_REVIEW:v1'&&d.decision==='unfrozen_preparation_failure_confirmed'&&d.statement_sha256===digest(bytes)&&d.reviewed_commit===review.commit_id&&exact(d.implementation_files,preparationImplementationFiles)&&Object.values(d.implementation_files).every(sha)&&digest(canonical(d.implementation_files))===version,'PREPARATION_PROOF_REVIEW_BINDING');
   records.set(id+'/'+version,{statement:s,review});
  }
 }
 return records;
}
