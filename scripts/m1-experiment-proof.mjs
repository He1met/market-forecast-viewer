import path from 'node:path';
import fs from 'node:fs/promises';
import {readJson,exists,digest,canonical,check} from './m1-files.mjs';
import {createDisplayReader} from './m1-display.mjs';
import {createOutcomeStore} from './m1-outcome-store.mjs';
import {readFrozen} from './m1-archive.mjs';
import {experimentStore} from './m1-experiments.mjs';
import {mainScenario,evaluateExperiment} from './m1-learning.mjs';

export async function readExperimentMetrics({codeRoot,dataRoot},id,role,revisionId) {
 check(['production','candidate'].includes(role),'EXPERIMENT_ROLE_INVALID');
 const runsRoot=path.join(dataRoot,role==='production'?'forecast-runs':'m1-candidates');
 const run=await createDisplayReader({root:codeRoot,dataRoot,runsRoot}).readRun(id,{includeEvaluation:!revisionId});
 const revision=revisionId?await createOutcomeStore({root:codeRoot,dataRoot,runsRoot}).readRevision(run,revisionId):run.evaluation;
 const controlsFile=path.join(dataRoot,'m1-learning/controls.json'),controls=await exists(controlsFile)?await readJson(dataRoot,controlsFile):{};
 if(revision?.status==='available')check(!(controls.disabled_scorers??[]).includes(revision.result.evaluation_version)&&!(controls.revoked_revisions??[]).includes(revision.revision_id),'EXPERIMENT_SCORER_OR_REVISION_DISABLED');
 const f=run.forecast,e=revision?.status==='available'?revision.result.windows.h24:null,main=mainScenario(f.scenarios.map(x=>x.probability_24h));
 return {evidence:e?{run_id:id,role,revision_id:revision.revision_id,evaluation_sha256:revision.evaluation_sha256,evaluated_at:revision.result.evaluated_at,forecast_sha256:run.hashes.forecast_sha256}:null,
  valid:f.status==='valid',timely:Date.parse(f.published_at)<(f.anchor_time+900)*1000,started_at:f.generation_started_at,complete:e?.status==='mature',brier:e?.brier_score??null,path_loss:e?.scenario_errors.find(x=>x.id===main).mae_return_pct??null};
}

// Recompute only the frozen historical revisions. Never rewrite old decisions.
export async function verifyFeedbackDecision({codeRoot,dataRoot,plan,decision}) {
 const directory=path.join(dataRoot,'m1-experiments',plan.id),marker=await readJson(dataRoot,path.join(directory,'decision-commit.json'));
 check(plan.factor==='feedback'&&plan.phase==='forward'&&decision.experiment_id===plan.id&&decision.plan_sha256===digest(canonical(plan))&&marker.schema==='MFV:DECISION_COMMIT:v1'&&marker.plan_sha256===decision.plan_sha256&&marker.decision_sha256===digest(canonical(decision)),'FEEDBACK_DECISION_BINDING_INVALID');
 const proof=decision.opportunity_evidence;check(Array.isArray(proof)&&proof.length>=20&&proof.length<=30,'FEEDBACK_OPPORTUNITY_PROOF_REQUIRED');
 const entries=await fs.readdir(path.join(directory,'opportunities'));
 check(canonical(entries.sort())===canonical(proof.map(x=>x.id).sort()),'FEEDBACK_OPPORTUNITY_SET_CHANGED');
 const opportunities=[];
 for(const item of proof) {
  const folder=path.join(directory,'opportunities',item.id),registration=await readJson(dataRoot,path.join(folder,'registered.json'));
  check(registration.id===item.id&&registration.experiment_id===plan.id&&canonical(registration.control)===canonical(plan.control)&&canonical(registration.candidate)===canonical(plan.candidate)&&digest(canonical(registration))===item.registered_sha256,'FEEDBACK_REGISTRATION_CHANGED');
  check(Date.parse(registration.registered_at)<=Date.parse(decision.decided_at),'FEEDBACK_FUTURE_OPPORTUNITY');
  let control=null,candidate=null,start=null;
  if(item.frozen_sha256) {
   const frozen=await readJson(dataRoot,path.join(folder,'frozen.json'));check(digest(canonical(frozen))===item.frozen_sha256,'FEEDBACK_FROZEN_BINDING_CHANGED');
   start=await experimentStore(dataRoot).candidateStart(frozen);
   for(const [role,id,key,policy] of [['production',frozen.official_run_id,'control',plan.control],['candidate',frozen.candidate_run_id,'candidate',plan.candidate]]) {
    const saved=item[key];if(!saved?.evidence){check(saved?.complete!==true,'FEEDBACK_REVISION_REQUIRED');continue;}
    check(saved.evidence.run_id===id&&saved.evidence.role===role&&Date.parse(saved.evidence.evaluated_at)<=Date.parse(decision.decided_at),'FEEDBACK_RUN_BINDING_INVALID');
    const bundle=await readFrozen(path.join(dataRoot,role==='production'?'forecast-runs':'m1-candidates',id));
    check(bundle.manifest.files['input.json']===frozen[role==='production'?'official_input_hash':'candidate_input_hash']&&bundle.input.history.dataset_id===frozen.market_hash&&bundle.input.anchor_time===registration.anchor_time,'FEEDBACK_INPUT_BINDING_INVALID');
    const learning=bundle.input.model_context.learning;
    check(learning&&learning.feedback_mode===policy.feedback&&learning.lambda===policy.lambda&&['model','reasoning_effort','predictor_version','additional_inputs'].every(k=>learning.predictor_identity?.[k]===policy[k]),'FEEDBACK_POLICY_BINDING_INVALID');
    const actual=await readExperimentMetrics({codeRoot,dataRoot},id,role,saved.evidence.revision_id);
    check(canonical(actual)===canonical(saved),'FEEDBACK_METRICS_CHANGED');
    if(role==='production')control=actual;else candidate=actual;
   }
  }
  check(!!start===item.started&&(start?.started_at??null)===item.candidate_attempt_started_at,'FEEDBACK_START_CHANGED');
  opportunities.push({...registration,started:!!start,finished:Date.parse(decision.decided_at)/1000>=registration.anchor_time+86400,complete:!!start&&control?.complete===true&&candidate?.complete===true,control,candidate});
 }
 const result=evaluateExperiment(plan,opportunities);
 check(result.complete_pairs===20&&['promote','reject'].includes(result.decision)&&Object.entries(result).every(([k,v])=>canonical(v)===canonical(decision[k]))&&canonical(decision.production_config)===canonical(result.decision==='promote'?plan.candidate:plan.control),'FEEDBACK_DECISION_RECOMPUTE_MISMATCH');
 return {decision_sha256:digest(canonical(decision)),pair_ids:result.pair_ids};
}
