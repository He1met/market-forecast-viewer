// A reviewed, byte-bound historical disposition; never an inferred missing attempt.
import fs from 'node:fs/promises';
import path from 'node:path';
import {readBytes,readJson,safePath,exists,digest,canonical,encode,check,dataReference} from './m1-files.mjs';
import {readFrozen} from './m1-archive.mjs';
import {closureInventory} from './m1-closures.mjs';
import {scheduledSlot} from './m1-cycle.mjs';
import {runIdSchema} from '../src/m1-display.ts';
import {parseStrict,validateHistory} from '../src/contracts.ts';
import {rawOutputJsonSchema} from '../src/m1-contracts.ts';
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&canonical(Object.keys(x).sort())===canonical([...keys].sort());
const sha=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/.test(x);
const iso=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT.*Z$/.test(x)&&Number.isFinite(Date.parse(x));
const sourceNames=['m1-cycle.mjs','m1-experiments.mjs','m1-entry.mjs'];
export const candidateImplementationFiles=['scripts/m1-candidate-proof.mjs','scripts/m1-display.mjs','scripts/m1-ops.mjs','scripts/m1-archive.mjs','scripts/m1-forecast.mjs','scripts/m1-model.mjs','scripts/m1-backup.mjs','scripts/m1-compatibility.mjs','scripts/m1-restore-replay.mjs','scripts/m1-files.mjs','scripts/m1-closures.mjs','scripts/m1-index.mjs','scripts/m1-cycle.mjs','scripts/m1-experiments.mjs','scripts/m1-mutex.mjs','scripts/m1-supplementary.mjs','src/m1-display.ts','src/contracts.ts','src/m1-contracts.ts','config/m1-evidence-roots.json'];
export async function candidateImplementationHashes(codeRoot){const result={};for(const name of candidateImplementationFiles)result[name]=digest(await readBytes(codeRoot,path.join(codeRoot,name)));return result;}
export async function listCandidateProofIds(dataRoot){const dir=path.join(dataRoot,'m1-candidate-proofs');if(!await exists(dir))return[];await safePath(dataRoot,dir);const ids=await fs.readdir(dir);check(ids.length<=64,'CANDIDATE_PROOF_LIMIT');for(const id of ids)runIdSchema.parse(id);return ids;}
async function noCandidateExecution(dataRoot,id,directory,frozen){
 const allowed=new Set(['manifest.json',...Object.keys(frozen.manifest.files)]);
 for(const source of frozen.manifest.source_files){const file=dataReference(source.path,dataRoot);if(path.dirname(file)===directory){check(/^events-source-\d{3}\.raw$/.test(path.basename(file)),'CANDIDATE_SOURCE_NAME');allowed.add(path.basename(file));}}
 const inventory=await closureInventory(directory);
 check(inventory.every(x=>x.kind==='file'&&allowed.has(x.path))&&inventory.length===allowed.size,'CANDIDATE_EXECUTION_TRACE');
 for(const name of ['m1-outcomes','m1-closures','forecast-runs'])check(!await exists(path.join(dataRoot,name,id)),'CANDIDATE_SUCCESS_TRACE');
 const cases=path.join(dataRoot,'m1-cases');if(await exists(cases))for(const name of await fs.readdir(cases)){const file=path.join(cases,name,'case.json');if(await exists(file))check((await readJson(dataRoot,file)).run_id!==id,'CANDIDATE_CASE_TRACE');}
 for(const name of ['forecast','last-forecast-success']){const file=path.join(dataRoot,'m1-task-status',name+'.json');if(await exists(file))check((await readJson(dataRoot,file)).forecast_id!==id,'CANDIDATE_SUCCESS_TRACE');}
 // Mutable projections may legitimately contain our derived not-invoked row.
 for(const root of [dataRoot,path.join(dataRoot,'m1-candidates')]){
  const file=path.join(root,'m1-projections/index.json');if(await exists(file)){const value=await readJson(dataRoot,file);check(value.latest_run_id!==id&&!value.runs?.some(x=>x.run_id===id&&(x.published_at||x.projection||['valid','late'].includes(x.status))),'CANDIDATE_PROJECTION_TRACE');}
  const views=path.join(root,'m1-projections/views');if(await exists(views))for(const name of await fs.readdir(views)){const value=await readJson(dataRoot,path.join(views,name));check(value.run_id!==id&&value.run?.run_id!==id&&value.forecast?.run_id!==id,'CANDIDATE_PROJECTION_TRACE');}
 }
 const ownerFile=path.join(dataRoot,'m1-control/owner.json');if(await exists(ownerFile)){const owner=await readJson(dataRoot,ownerFile);check(!(owner.child&&(owner.run_id===id||owner.child.run_id===id)),'CANDIDATE_ACTIVE_TRACE');}
}
// Only these two known empty process workspaces are omitted from file backups.
// Nonempty, symlinked or differently typed objects are never normalized away.
async function officialInventory(directory){
 const empty=new Set(['attempt-001/model-work','attempt-002/model-work']);
 for(const name of empty){const file=path.join(directory,name);if(await exists(file)){const stat=await fs.lstat(file);check(stat.isDirectory()&&!stat.isSymbolicLink()&&(await fs.readdir(file)).length===0,'CANDIDATE_WORKSPACE_TRACE');}}
 return(await closureInventory(directory)).filter(x=>!(x.kind==='directory'&&empty.has(x.path)));
}
// The proposal builder and the reader use the same complete immutable inventory.
export async function candidateEvidence(dataRoot,id){
 runIdSchema.parse(id);const directory=path.join(dataRoot,'m1-candidates',id);await safePath(dataRoot,directory);const candidate=await readFrozen(directory),p=candidate.provenance;
 check(p.role==='candidate'&&uuid(p.experiment_id)&&sha(p.opportunity_id),'CANDIDATE_PROVENANCE');
 check(canonical(candidate.schema)===canonical(rawOutputJsonSchema),'CANDIDATE_SCHEMA');await validateHistory(candidate.input.history);await noCandidateExecution(dataRoot,id,directory,candidate);
 const experiment='m1-experiments/'+p.experiment_id,opportunity=experiment+'/opportunities/'+p.opportunity_id;
 const plan=await readJson(dataRoot,path.join(dataRoot,experiment,'plan.json')),registered=await readJson(dataRoot,path.join(dataRoot,opportunity,'registered.json')),frozen=await readJson(dataRoot,path.join(dataRoot,opportunity,'frozen.json')),generation=await readJson(dataRoot,path.join(dataRoot,opportunity,'generation.json'));
 runIdSchema.parse(frozen.official_run_id);check(frozen.official_run_id!==id&&frozen.candidate_run_id===id,'CANDIDATE_RUN_BINDING');
 const officialDirectory=path.join(dataRoot,'forecast-runs',frozen.official_run_id);await safePath(dataRoot,officialDirectory);const official=await readFrozen(officialDirectory);check(canonical(official.schema)===canonical(rawOutputJsonSchema),'CANDIDATE_SCHEMA');await validateHistory(official.input.history);
 for(const bundle of [candidate,official])check(bundle.input.anchor_time===bundle.input.history.end_time&&bundle.input.anchor_price===bundle.input.history.candles.at(-1).close&&Date.parse(bundle.input.history.downloaded_at)<=Date.parse(bundle.manifest.information_frozen_at),'CANDIDATE_INPUT_TIME');
 check(plan.schema==='MFV:EXPERIMENT:v1'&&plan.id===p.experiment_id&&iso(plan.created_at)&&iso(plan.training_cutoff)&&Date.parse(plan.training_cutoff)<=Date.parse(registered.registered_at)&&Date.parse(plan.created_at)<=Date.parse(registered.registered_at)&&registered.schema==='MFV:OPPORTUNITY:v1'&&registered.id===p.opportunity_id&&registered.experiment_id===plan.id&&canonical(registered.control)===canonical(plan.control)&&canonical(registered.candidate)===canonical(plan.candidate),'CANDIDATE_PLAN_BINDING');
 check(frozen.official_input_hash===official.manifest.files['input.json']&&frozen.candidate_input_hash===candidate.manifest.files['input.json']&&frozen.market_hash===official.input.history.dataset_id&&candidate.input.history.dataset_id===frozen.market_hash&&canonical(candidate.input.history)===canonical(official.input.history)&&registered.anchor_time===official.input.anchor_time&&registered.anchor_time===candidate.input.anchor_time,'CANDIDATE_INPUT_BINDING');
 check((official.provenance.role===undefined||official.provenance.role==='production')&&p.code_head===official.provenance.code_head&&canonical(p.code_sha256)===canonical(official.provenance.code_sha256),'CANDIDATE_SOURCE_BINDING');
 for(const [bundle,policy]of [[official,plan.control],[candidate,plan.candidate]]){const l=bundle.input.model_context?.learning;check(l&&l.feedback_mode===policy.feedback&&l.lambda===policy.lambda&&['model','reasoning_effort','predictor_version','additional_inputs'].every(k=>l.predictor_identity?.[k]===policy[k]),'CANDIDATE_POLICY_BINDING');}
 check(exact(generation,['candidate_invoked','official_run_id','candidate_run_id','candidate_status','completed_at'])&&generation.candidate_invoked===false&&generation.official_run_id===null&&generation.candidate_run_id===id&&generation.candidate_status==='preparation_or_official_failed','CANDIDATE_GENERATION_UNPROVEN');
 const slot=await readJson(dataRoot,path.join(dataRoot,'m1-slots',p.opportunity_id+'.json'));check(uuid(slot.observation_id)&&sha(slot.release_id),'CANDIDATE_SLOT');
 const observation='m1-observations/'+slot.observation_id,start=await readJson(dataRoot,path.join(dataRoot,observation,'started.json')),end=await readJson(dataRoot,path.join(dataRoot,observation,'result.json'));
 check(start.schema==='MFV:OBSERVATION:v1'&&end.schema===start.schema&&start.id===slot.observation_id&&end.id===start.id&&start.task==='forecast'&&end.task===start.task&&start.release_id===slot.release_id&&end.release_id===start.release_id&&start.slot_id===p.opportunity_id&&end.slot_id===start.slot_id&&start.status==='started'&&end.status==='failed'&&end.reason==='MODEL_ATTEMPT_REJECTED'&&!('finalization_error'in end)&&!('preparation_failure'in end)&&!end.forecast_id&&!end.publication_committed&&end.lock_acquired===true&&['manual','scheduled'].includes(start.trigger)&&end.trigger===start.trigger&&['task_id','thread_id','started_at'].every(k=>end[k]===start[k]),'CANDIDATE_OBSERVATION');
 const expected=scheduledSlot(Date.parse(start.started_at));check(Object.entries(expected).every(([k,v])=>slot[k]===v)&&slot.anchor_time===registered.anchor_time&&Date.parse(official.manifest.information_frozen_at)>=Date.parse(slot.target_at)&&Date.parse(candidate.manifest.information_frozen_at)<slot.first_node*1000,'CANDIDATE_SLOT');
 const first=await readJson(dataRoot,path.join(officialDirectory,'attempt-001/started.json')),last=await readJson(dataRoot,path.join(officialDirectory,'attempt-002/receipt.json'));
 const times=[start.started_at,slot.claimed_at,registered.registered_at,official.manifest.information_frozen_at,candidate.manifest.information_frozen_at,frozen.frozen_at,first.started_at,last.ended_at,generation.completed_at,end.completed_at];check(times.every(iso)&&times.every((x,i)=>!i||Date.parse(x)>=Date.parse(times[i-1]))&&Date.parse(end.completed_at)<=Date.now(),'CANDIDATE_TIME_ORDER');
 const files=new Set([experiment+'/plan.json',...['registered.json','frozen.json','generation.json'].map(x=>opportunity+'/'+x),'m1-slots/'+p.opportunity_id+'.json']);
 for(const dir of ['m1-candidates/'+id,'forecast-runs/'+frozen.official_run_id,observation])for(const item of await closureInventory(path.join(dataRoot,dir))){if(item.kind==='file')files.add(dir+'/'+item.path);}
 for(const bundle of [candidate,official])for(const source of bundle.manifest.source_files){const file=dataReference(source.path,dataRoot);check(digest(await readBytes(dataRoot,file))===source.sha256,'CANDIDATE_SOURCE_HASH');files.add(path.relative(dataRoot,file).split(path.sep).join('/'));}
 const inventory={};for(const name of [...files].sort()){const raw=await readBytes(dataRoot,path.join(dataRoot,name));inventory[name]={bytes:raw.length,sha256:digest(raw)};}
 const directories={candidate:await closureInventory(directory),official:await officialInventory(officialDirectory),observation:await closureInventory(path.join(dataRoot,observation)),opportunity:await closureInventory(path.join(dataRoot,opportunity))};
 return{candidate_id:id,official_id:frozen.official_run_id,experiment_id:p.experiment_id,opportunity_id:p.opportunity_id,observation_id:slot.observation_id,release_id:slot.release_id,inventory,directories,completed_at:end.completed_at,code_head:official.provenance.code_head,candidate_code_head:p.code_head,code_hashes:official.provenance.code_sha256,candidate_code_hashes:p.code_sha256};
}
export async function readCandidateProof({codeRoot,dataRoot,runId,runsRoot,readOfficial}){
 runIdSchema.parse(runId);const folder=path.join(dataRoot,'m1-candidate-proofs',runId);if(!await exists(folder))return null;
 check(path.resolve(runsRoot)===path.join(path.resolve(dataRoot),'m1-candidates'),'CANDIDATE_ROLE');await safePath(dataRoot,folder);
 const evidence=await candidateEvidence(dataRoot,runId),versions=await fs.readdir(folder);check(versions.length>0&&versions.length<=64,'CANDIDATE_PROOF_LIMIT');
 const current=digest(canonical(await candidateImplementationHashes(codeRoot)));let accepted=null;
 for(const version of versions){
  check(sha(version),'CANDIDATE_PROOF_VERSION');const dir=path.join(folder,version);await safePath(dataRoot,dir);
  check(canonical((await fs.readdir(dir)).sort())===canonical(['review.json','source-manifest.json',...sourceNames.map(x=>'source-'+x),'statement.json'].sort()),'CANDIDATE_PROOF_FILES');
  const raw=await readBytes(dataRoot,path.join(dir,'statement.json')),s=parseStrict(raw.toString('utf8')),review=await readJson(dataRoot,path.join(dir,'review.json')),manifestRaw=await readBytes(dataRoot,path.join(dir,'source-manifest.json')),manifest=parseStrict(manifestRaw.toString('utf8'));
  check(exact(s,['schema','evidence','source_manifest_sha256','proposed_at'])&&s.schema==='MFV:CANDIDATE_NONINVOCATION:v1'&&canonical(s.evidence)===canonical(evidence)&&s.source_manifest_sha256===digest(manifestRaw)&&iso(s.proposed_at)&&Date.parse(s.proposed_at)>=Date.parse(evidence.completed_at),'CANDIDATE_PROOF_STATEMENT');
  check(manifest.schema==='MFV:RUNTIME_PACKAGE:v1'&&manifest.release_id===evidence.release_id&&manifest.release_id===digest(encode({...manifest,release_id:undefined}))&&manifest.build_sha===evidence.code_head&&manifest.build_sha===evidence.candidate_code_head&&manifest.synthetic===false&&manifest.source_kind==='git_archive','CANDIDATE_SOURCE_PACKAGE');
  for(const hashes of [evidence.code_hashes,evidence.candidate_code_hashes])for(const [name,hash]of Object.entries(hashes))check(manifest.files[name]?.sha256===hash,'CANDIDATE_SOURCE_PACKAGE');
  for(const name of sourceNames){const b=await readBytes(dataRoot,path.join(dir,'source-'+name)),entry=manifest.files['scripts/'+name];check(entry?.sha256===digest(b)&&entry.bytes===b.length,'CANDIDATE_SOURCE_CODE');}
  check(review.user?.id===65616876&&review.user.login==='He1met'&&['COMMENTED','APPROVED'].includes(review.state)&&Number.isSafeInteger(review.id)&&/^[a-f0-9]{40}$/.test(review.commit_id??'')&&iso(review.submitted_at)&&Date.parse(review.submitted_at)>=Date.parse(s.proposed_at)&&Date.parse(review.submitted_at)<=Date.now()&&new RegExp('^https://github.com/He1met/market-forecast-viewer/pull/[1-9][0-9]*#pullrequestreview-'+review.id+'$').test(review.html_url??''),'CANDIDATE_PROOF_REVIEW');
  const blocks=typeof review.body==='string'?[...review.body.matchAll(/```mfv-candidate-proof-review\n([\s\S]*?)\n```/g)]:[];check(blocks.length===1,'CANDIDATE_PROOF_REVIEW');const d=parseStrict(blocks[0][1]);
  check(exact(d,['schema','decision','statement_sha256','reviewed_commit','implementation_files'])&&d.schema==='MFV:CANDIDATE_PROOF_REVIEW:v1'&&d.decision==='official_failure_prevented_candidate_invocation_confirmed'&&d.statement_sha256===digest(raw)&&d.reviewed_commit===review.commit_id&&exact(d.implementation_files,candidateImplementationFiles)&&Object.values(d.implementation_files).every(sha)&&digest(canonical(d.implementation_files))===version,'CANDIDATE_PROOF_REVIEW_BINDING');
  if(version===current)accepted=review;
 }
 check(accepted,'CANDIDATE_PROOF_CURRENT_IMPLEMENTATION_REQUIRED');
 check((await readOfficial(evidence.official_id)).status==='terminal_failed_not_scoreable','CANDIDATE_OFFICIAL_FAILURE_UNPROVEN');
 return{status:'candidate_not_invoked_not_scoreable',run_id:runId,official_run_id:evidence.official_id,review_url:accepted.html_url};
}
