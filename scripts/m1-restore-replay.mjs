import fs from 'node:fs/promises';
import path from 'node:path';
import { atomic, readJson, exists, check, canonical } from './m1-files.mjs';
import { createDisplayReader } from './m1-display.mjs';
import { caseStore } from './m1-cases.mjs';
import { projectionStore } from './m1-index.mjs';
import {listClosureIds,auditClosureImplementations} from './m1-closures.mjs';
import {auditPreparationProofs} from './m1-preparation.mjs';
import {listCandidateProofIds} from './m1-candidate-proof.mjs';

// Rebuilt views are separate from the backed-up bytes. A copied index is not
// evidence that every restored archive has been read by the installed code.
export async function replayRestored({codeRoot, dataRoot, limit=16, maxMs=15000,
 readers, cases}={}) {
 check(Number.isSafeInteger(limit)&&limit>0&&Number.isFinite(maxMs)&&maxMs>0,'RESTORE_REPLAY_BUDGET_INVALID');
 for(const id of await listCandidateProofIds(dataRoot)){const result=await createDisplayReader({root:codeRoot,dataRoot,runsRoot:path.join(dataRoot,'m1-candidates')}).readScoringRun(id);check(result.status==='candidate_not_invoked_not_scoreable','RESTORE_CANDIDATE_PROOF_INVALID');}
 await auditClosureImplementations(dataRoot);
 const preparationProofs=await auditPreparationProofs(dataRoot);
 for(const id of new Set([...preparationProofs.keys()].map(x=>x.split('/')[0]))){
  const result=await createDisplayReader({root:codeRoot,dataRoot}).readScoringRun(id);
  check(result.status==='preparation_failed_not_scoreable','RESTORE_PREPARATION_PROOF_INVALID');
 }
 // Revalidate closure evidence on every continuation, including already replayed
 // runs. A stale replay cursor cannot certify newly corrupted closure bytes.
 for(const id of await listClosureIds(dataRoot)){
  const result=await createDisplayReader({root:codeRoot,dataRoot}).readScoringRun(id);
  check(result.status==='historical_unpublished_closed_not_scoreable','RESTORE_CLOSURE_INVALID');
 }
 readers??={production:createDisplayReader({root:codeRoot,dataRoot}),
  candidate:createDisplayReader({root:codeRoot,dataRoot,runsRoot:path.join(dataRoot,'m1-candidates')})};
 cases??=caseStore({codeRoot,dataRoot});
 const file=path.join(dataRoot,'restore-replay-v2.json'),derived=path.join(dataRoot,'restore-derived');
 const ids={production:await readers.production.listRunIds(),candidate:await readers.candidate.listRunIds(),
  cases:(await fs.readdir(path.join(dataRoot,'m1-cases')).catch(e=>{if(e.code==='ENOENT')return [];throw e;})).filter(x=>/^[a-f0-9]{64}$/.test(x)).sort()};
 const state=await exists(file)?await readJson(dataRoot,file):{
  schema:'MFV:RESTORE_REPLAY:v2',ids,checked_at:new Date().toISOString(),
  production:[],candidate:[],cases:[],projections:{production:false,candidate:false}};
 check(state.schema==='MFV:RESTORE_REPLAY:v2'&&canonical(state.ids)===canonical(ids),'RESTORE_REPLAY_OBJECTS_CHANGED');
 const deadline=performance.now()+maxMs;let visited=0;
 const save=()=>atomic(dataRoot,file,state);
 const incomplete=async()=>{await save();return{status:'incomplete',phase:'replay',
  production:state.production.length,candidate:state.candidate.length,cases:state.cases.length,projections:state.projections};};
 await save();
 for(const role of ['production','candidate']) {
  for(let offset=state[role].length;offset<ids[role].length;offset++) {
   if(visited>=limit||performance.now()>=deadline)return incomplete();
   const id=ids[role][offset],reader=readers[role],item=await reader.runState(id,state.checked_at);
   check(item.status!=='invalid','RESTORE_ARCHIVE_INVALID:'+role);
   let hashes=null,evaluation=null;
   if(item.status==='valid'||item.status==='late') {
    const run=await reader.readRun(id);check(run.evaluation.status!=='failed','RESTORE_EVALUATION_INVALID:'+role);
    hashes=run.hashes;evaluation=run.evaluation.status;
   }
   state[role].push({run_id:id,status:item.status,hashes,evaluation});visited++;await save();
  }
 }
 for(let offset=state.cases.length;offset<ids.cases.length;offset++) {
  if(visited>=limit||performance.now()>=deadline)return incomplete();
  const id=ids.cases[offset];let item;
  try{const value=await cases.read(id);item={id,status:'verified',brier:value.brier,revision_id:value.revision_id};}
  catch(e){check(e.message==='SCORER_OR_REVISION_DISABLED','RESTORE_CASE_INVALID');item={id,status:'excluded',reason:e.message};}
  state.cases.push(item);visited++;await save();
 }
 for(const role of ['production','candidate']) {
  if(state.projections[role])continue;
  if(visited>=limit||performance.now()>=deadline)return incomplete();
  const root=path.join(derived,role);await fs.mkdir(root,{recursive:true});
  const progress=await projectionStore(root).update(readers[role],{limit:limit-visited,deadline});visited+=progress.verified;
  const index=await readJson(root,path.join(root,'m1-projections/index.json'));
  check(index.runs.every(x=>x.status!=='invalid'&&(!['valid','late'].includes(x.status)||!x.verification_error)),'RESTORE_PROJECTION_INVALID:'+role);
  state.projections[role]=index.runs.length===ids[role].length&&ids[role].every(id=>index.runs.some(x=>x.run_id===id));
  await save();if(!state.projections[role])return incomplete();
 }
 const control=await cases.controls(),verified=state.cases.filter(x=>x.status==='verified');
 const learning={schema:'MFV:RESTORED_LEARNING_SUMMARY:v1',checked_at:state.checked_at,
  learning_disabled:control.learning_disabled,verified_cases:verified.length,excluded_cases:state.cases.length-verified.length,
  mean_brier:verified.length?verified.reduce((sum,x)=>sum+x.brier,0)/verified.length:null,cases:state.cases};
 await atomic(dataRoot,path.join(derived,'learning-summary.json'),learning);
 return{passed:true,forecast_count:state.production.length,candidate_count:state.candidate.length,
  case_count:verified.length,excluded_case_count:learning.excluded_cases,projections_complete:true,
  forecasts:state.production,candidates:state.candidate,derived_directory:'restore-derived'};
}
