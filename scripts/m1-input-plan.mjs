import {verifyFeedbackDecision} from './m1-experiment-proof.mjs';
import path from 'node:path';
import fs from 'node:fs/promises';
import {assertInstallationSettled,validateInstallation,readJson,exists,check,digest,canonical} from './m1-files.mjs';
import {businessMutex} from './m1-mutex.mjs';
import {experimentStore,effectivePolicy} from './m1-experiments.mjs';
import {caseStore} from './m1-cases.mjs';

// Called only by the pinned, approved entry. No input acquisition or model call.
export async function planInputExperiment({runtimeHome,dataRoot,port,releaseId,codeRoot,baseline,input,policySha,reason}) {
 check(['derivatives','calendar'].includes(input)&&/^[a-f0-9]{64}$/.test(policySha??'')&&typeof reason==='string'&&reason.trim().length>0&&reason.length<=2000,'INPUT_PLAN_ARGUMENTS_INVALID');
 await assertInstallationSettled(runtimeHome);
 const mutex=await businessMutex({dataRoot,port,releaseId,task:'admin'});check(mutex.status==='ACQUIRED',mutex.status);
 try {
  await assertInstallationSettled(runtimeHome);
  const config=await validateInstallation(path.join(runtimeHome,'installation.local.json')),current=await readJson(runtimeHome,path.join(runtimeHome,'current.json'));
  check(config.data_root===dataRoot&&config.mutex_port===port,'INSTALLATION_CHANGED');check(current.release_id===releaseId,'PINNED_RELEASE_MISMATCH');
  const store=experimentStore(dataRoot),cases=caseStore({codeRoot,dataRoot});
  check(!(await cases.controls()).learning_disabled,'LEARNING_DISABLED');const allowance=await store.creationStatus();check(allowance==='allowed',allowance);
  const cutoff=new Date().toISOString(),policy=await effectivePolicy(dataRoot,baseline,cutoff);
  check(digest(canonical(policy))===policySha,'INPUT_PLAN_POLICY_CHANGED');
  check(policy.additional_inputs==='none','INPUT_PLAN_REQUIRES_NO_ADDITIONAL_INPUTS');
  const home=path.join(dataRoot,'m1-experiments'),plans=[];
  for(const id of await fs.readdir(home).catch(e=>{if(e.code==='ENOENT')return[];throw e;})) {
   if(!/^[a-f0-9-]{36}$/.test(id))continue;
   const plan=await readJson(dataRoot,path.join(home,id,'plan.json'));plans.push(plan);
  }
  const day=at=>new Date(Date.parse(at)+8*3600000).toISOString().slice(0,10);
  check(!plans.some(p=>day(p.created_at)===day(cutoff)),'DAILY_PLAN_LIMIT');
  check(!plans.some(p=>p.factor==='input'&&p.candidate.additional_inputs===input&&canonical(p.control)===canonical(policy)),'INPUT_PLAN_ALREADY_ATTEMPTED');
  const prerequisites=[];
  for(const plan of plans.filter(p=>p.factor==='feedback'&&p.phase==='forward'&&['model','reasoning_effort','predictor_version'].every(k=>p.control[k]===policy[k]))) {
   const file=path.join(home,plan.id,'decision.json');if(!await exists(file))continue;
   const decision=await readJson(dataRoot,file);
   if(decision.experiment_id===plan.id&&decision.complete_pairs===20&&['promote','reject'].includes(decision.decision)&&Date.parse(decision.decided_at)<Date.parse(cutoff)){await verifyFeedbackDecision({codeRoot,dataRoot,plan,decision});prerequisites.push({plan,decision});}
  }
  prerequisites.sort((a,b)=>a.decision.decided_at.localeCompare(b.decision.decided_at));
  const prerequisite=prerequisites.at(-1);check(prerequisite,'FEEDBACK_COMPARISON_REQUIRED');
  const fresh=(await cases.available(cutoff)).filter(c=>Date.parse(c.available_at)>Date.parse(prerequisite.decision.decided_at));
  check(fresh.length>0,'NEW_MATURE_CASE_REQUIRED');
  await mutex.guard();
  const plan=await store.create(policy,{...policy,additional_inputs:input},{guard:mutex.guard,trainingCutoff:cutoff,factor:'input',trainingEvidence:{schema:'MFV:INPUT_PLAN_EVIDENCE:v1',release_id:releaseId,reason:reason.trim(),policy_sha256:policySha,feedback_experiment_id:prerequisite.plan.id,feedback_decision_sha256:digest(canonical(prerequisite.decision)),case_ids:fresh.map(c=>c.id),case_revision_hashes:fresh.map(c=>c.revision_hash)}});
  return {status:'planned',plan,production_changed:false,model_called:false};
 } finally {await mutex.close();}
}
