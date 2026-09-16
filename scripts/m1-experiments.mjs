import fs from'node:fs/promises';import path from'node:path';import{randomUUID}from'node:crypto';import{readJson,readBytes,writeOnce,atomic,exists,digest,canonical,check}from'./m1-files.mjs';import{evaluateExperiment}from'./m1-learning.mjs';import{newRun,readFrozen,freezeInput,readPublished}from'./m1-archive.mjs';import{buildPrompt}from'./m1-input.mjs';import{applySupplementary}from'./m1-supplementary.mjs';
export function experimentStore(dataRoot,{afterTransitionWrite=async()=>{}}={}){
 const home=path.join(dataRoot,'m1-experiments'),activeFile=path.join(home,'active.json');
 async function active(){await assertTransitionComplete(dataRoot);if(!await exists(activeFile))return null;const a=await readJson(dataRoot,activeFile);if(a.status!=='active')return null;const plan=await readJson(dataRoot,path.join(home,a.id,'plan.json'));check(digest(canonical(plan))===a.plan_hash,'EXPERIMENT_PLAN_CHANGED');return plan;}
 async function creationStatus(){
  if(await active())return 'EXPERIMENT_ALREADY_ACTIVE';if(await paused())return 'EXPERIMENT_PAUSED';
  const day=x=>new Date(Date.parse(x)+8*3600000).toISOString().slice(0,10),today=day(new Date().toISOString());
  for(const id of await fs.readdir(home).catch(e=>{if(e.code==='ENOENT')return[];throw e;})){if(!/^[a-f0-9-]{36}$/.test(id))continue;const p=await readJson(dataRoot,path.join(home,id,'plan.json'));if(day(p.created_at)===today)return 'DAILY_PLAN_LIMIT';}return 'allowed';
 }
 async function create(control,candidate,{guard,trainingCutoff=new Date().toISOString(),factor='feedback',phase='forward',trainingEvidence=null}={}){await guard();const allowance=await creationStatus();check(allowance==='allowed',allowance);const keys=new Set([...Object.keys(control),...Object.keys(candidate)]);const changed=[...keys].filter(k=>canonical(control[k])!==canonical(candidate[k]));check(changed.length===1&&changed[0]===({feedback:'feedback',probability:'lambda',input:'additional_inputs'})[factor],'SINGLE_FACTOR_REQUIRED');const id=randomUUID(),plan={schema:'MFV:EXPERIMENT:v1',id,created_at:new Date().toISOString(),control,candidate,factor,phase,training_cutoff:trainingCutoff,training_evidence:trainingEvidence,opportunity:'01:47 Asia/Shanghai daily',minimum_pairs:20,maximum_finished:30,primary_improvement:.05,timely_valid_minimum:.9};await writeOnce(dataRoot,path.join(home,id,'plan.json'),plan);await atomic(dataRoot,activeFile,{id,status:'active',plan_hash:digest(canonical(plan))});return plan;}
 // A single durable intent freezes the decision and rollback identity before any projection changes.
 async function recoverTransition({guard}){
  const file=path.join(home,'transition.json');if(!await exists(file))return null;
  const tx=await readJson(dataRoot,file);if(tx.status==='completed')return null;
  check(tx.schema==='MFV:EXPERIMENT_TRANSITION:v1'&&tx.status==='pending','EXPERIMENT_TRANSITION_INVALID');
  const plan=await readJson(dataRoot,path.join(home,tx.decision.experiment_id,'plan.json'));
  check(digest(canonical(plan))===tx.plan_hash,'EXPERIMENT_PLAN_CHANGED');
  const put=async(name,target,value,immutable=false)=>{await guard();if(immutable&&await exists(target)){check(canonical(await readJson(dataRoot,target))===canonical(value),'EXPERIMENT_TRANSITION_CONFLICT');return;}await atomic(dataRoot,target,value);await afterTransitionWrite(name);};
  await put('decision',path.join(home,plan.id,'decision.json'),tx.decision,true);
  await put('decision_commit',path.join(home,plan.id,'decision-commit.json'),{schema:'MFV:DECISION_COMMIT:v1',plan_sha256:tx.plan_hash,decision_sha256:digest(canonical(tx.decision))},true);
  await put('policy',path.join(dataRoot,'m1-learning/production-policy.json'),tx.policy);
  if(tx.rollback)await put('rollback_plan',path.join(home,tx.rollback.id,'plan.json'),tx.rollback,true);
  await put('active',activeFile,tx.active);
  await put('completed',file,{...tx,status:'completed'});
  return tx.decision;
 }
 async function pauseChanged(policy,{guard}){const plan=await active();if(!plan||canonical(plan.control)===canonical(policy))return null;await guard();const state={id:plan.id,status:'paused',reason:'production_configuration_changed',plan_hash:digest(canonical(plan)),observed_policy:policy,paused_at:new Date().toISOString()};await atomic(dataRoot,activeFile,state);return state;}
 async function register(slot,policy,{guard}){if(await pauseChanged(policy,{guard}))return null;const plan=await active();if(!plan)return null;const date=new Date(slot.anchor_time*1000+8*3600000);if(date.getUTCHours()!==1||date.getUTCMinutes()!==45)return null;await guard();check(canonical(plan.control)===canonical(policy),'EXPERIMENT_PRODUCTION_CONFIGURATION_CHANGED');const id=slot.slot_id,file=path.join(home,plan.id,'opportunities',id,'registered.json');if(await exists(file))return null;const o={schema:'MFV:OPPORTUNITY:v1',id,experiment_id:plan.id,anchor_time:slot.anchor_time,registered_at:new Date().toISOString(),control:plan.control,candidate:plan.candidate};await writeOnce(dataRoot,file,o);return{plan,opportunity:o,dir:path.dirname(file)};}
 async function freezeCandidate(registration,official,{learningBuilder,guard}){if(!registration)return null;await guard();const original=await readFrozen(official.runDir),candidate=await newRun(path.join(dataRoot,'m1-candidates'));const input=applySupplementary(structuredClone(original.input),registration.plan.candidate);input.model_context.learning=await learningBuilder(input.features,original.manifest.information_frozen_at,registration.plan.candidate);
  for(const source of input.events.sources??[]){const old=path.join(dataRoot,source.raw_path.replace(/^artifacts\//,'')),name=path.basename(old),dest=path.join(candidate.runDir,name);await writeOnce(dataRoot,dest,await readBytes(dataRoot,old));const ref='artifacts/'+path.relative(dataRoot,dest).split(path.sep).join('/');for(const item of input.events.items??[])if(item.raw_path===source.raw_path)item.raw_path=ref;source.raw_path=ref;}
  const manifest=await freezeInput(candidate.runDir,input,buildPrompt(input.model_context),original.schema,{...original.provenance,role:'candidate',experiment_id:registration.plan.id,opportunity_id:registration.opportunity.id});
  await writeOnce(dataRoot,path.join(registration.dir,'frozen.json'),{frozen_at:new Date().toISOString(),official_run_id:official.run_id,candidate_run_id:candidate.run_id,official_input_hash:original.manifest.files['input.json'],candidate_input_hash:manifest.files['input.json'],market_hash:original.input.history.dataset_id});return{...candidate,probabilityOnly:registration.plan.factor==='probability',sourceRun:official};
 }
 async function candidateStart(frozen){
  if(!frozen)return null;const runDir=path.join(dataRoot,'m1-candidates',frozen.candidate_run_id);
  for(const id of ['attempt-001','attempt-002']){const dir=path.join(runDir,id),file=path.join(dir,'started.json');if(!await exists(file))continue;
   const start=await readJson(dataRoot,file);check(start.schema==='MFV:M1_ATTEMPT_START:v1'&&start.run_id===frozen.candidate_run_id&&start.attempt_id===id&&start.input_sha256===frozen.candidate_input_hash&&Number.isFinite(Date.parse(start.started_at)),'CANDIDATE_START_INVALID');
   const executionFile=path.join(dir,'execution-started.json');if(!await exists(executionFile))continue;
   const execution=await readJson(dataRoot,executionFile);
   check(execution.schema==='MFV:EXECUTION_START:v1'&&execution.run_id===start.run_id&&execution.attempt_id===start.attempt_id&&execution.input_sha256===start.input_sha256&&execution.reservation_sha256===digest(await readBytes(dataRoot,file))&&Date.parse(execution.started_at)>=Date.parse(start.started_at),'CANDIDATE_EXECUTION_INVALID');
   check(execution.mode==='managed_process'?Number.isSafeInteger(execution.process?.pid)&&!!execution.process?.identity:execution.mode==='deterministic_probability_postprocess','CANDIDATE_EXECUTION_INVALID');
   return execution;
  }return null;
 }
 async function finish(registration,result){if(!registration)return;await writeOnce(dataRoot,path.join(registration.dir,'generation.json'),{...result,completed_at:new Date().toISOString()});}
 async function review({readMetrics,guard,policy}){const recovered=await recoverTransition({guard});if(recovered)return recovered;if(policy){const paused=await pauseChanged(policy,{guard});if(paused)return{decision:'paused_version_changed',...paused};}const plan=await active();if(!plan)return null;const directory=path.join(home,plan.id),decisionFile=path.join(directory,'decision.json');const savedDecision=await exists(decisionFile)?await readJson(dataRoot,decisionFile):null;const entries=savedDecision?[]:await fs.readdir(path.join(directory,'opportunities')).catch(e=>{if(e.code==='ENOENT')return[];throw e;}),opportunities=[];
  for(const id of entries){const dir=path.join(directory,'opportunities',id),r=await readJson(dataRoot,path.join(dir,'registered.json')),g=await exists(path.join(dir,'generation.json'))?await readJson(dataRoot,path.join(dir,'generation.json')):null,f=await exists(path.join(dir,'frozen.json'))?await readJson(dataRoot,path.join(dir,'frozen.json')):null;const start=await candidateStart(f);const control=f?await readMetrics(f.official_run_id,'production'):null,candidate=f?await readMetrics(f.candidate_run_id,'candidate'):null;opportunities.push({...r,registered_sha256:digest(canonical(r)),frozen_sha256:f?digest(canonical(f)):null,started:!!start,candidate_attempt_started_at:start?.started_at??null,generation_status:g?.candidate_status??'interrupted_or_pending',finished:Date.now()/1000>=r.anchor_time+86400,complete:!!start&&control?.complete===true&&candidate?.complete===true,control,candidate});}
  const result=savedDecision??evaluateExperiment(plan,opportunities);if(result.decision==='waiting')return result;await guard();
  const decision=savedDecision??{...result,experiment_id:plan.id,plan_sha256:digest(canonical(plan)),opportunity_evidence:opportunities,decided_at:new Date().toISOString(),effective_after:new Date().toISOString(),production_config:result.decision==='promote'?plan.candidate:plan.control};
  // Recover legacy decision-first interruptions too, without rerunning the scorer.
  const rollback=result.decision==='promote'&&plan.phase!=='rollback'?{...plan,id:randomUUID(),created_at:decision.decided_at,control:plan.candidate,candidate:plan.control,phase:'rollback',training_cutoff:decision.decided_at,training_evidence:null}:null;
  const tx={schema:'MFV:EXPERIMENT_TRANSITION:v1',status:'pending',plan_hash:digest(canonical(plan)),decision,rollback,
   policy:{schema:'MFV:PRODUCTION_POLICY:v1',policy:decision.production_config,decision_id:plan.id,decision_hash:digest(canonical(decision)),effective_after:decision.effective_after,rollback_completed:plan.phase==='rollback'},
   active:rollback?{id:rollback.id,status:'active',plan_hash:digest(canonical(rollback))}:{id:plan.id,status:'decided',decision_hash:digest(canonical(decision))}};
  await atomic(dataRoot,path.join(home,'transition.json'),tx);await afterTransitionWrite('intent');
  return recoverTransition({guard});
 }
 async function paused(){return await exists(activeFile)&&(await readJson(dataRoot,activeFile)).status==='paused';}
 return{candidateStart,active,paused,creationStatus,create,pauseChanged,register,freezeCandidate,finish,review,recoverTransition};
}

async function assertTransitionComplete(dataRoot){const file=path.join(dataRoot,'m1-experiments/transition.json');if(await exists(file))check((await readJson(dataRoot,file)).status==='completed','EXPERIMENT_TRANSITION_PENDING');}

export async function effectivePolicy(dataRoot,baseline,cutoff=new Date().toISOString()){
 await assertTransitionComplete(dataRoot);const file=path.join(dataRoot,'m1-learning/production-policy.json');if(!await exists(file))return baseline;const state=await readJson(dataRoot,file);check(state.schema==='MFV:PRODUCTION_POLICY:v1'&&/^[a-f0-9-]{36}$/.test(state.decision_id),'POLICY_STATE_INVALID');const decision=await readJson(dataRoot,path.join(dataRoot,'m1-experiments',state.decision_id,'decision.json'));check(digest(canonical(decision))===state.decision_hash&&canonical(decision.production_config)===canonical(state.policy),'POLICY_DECISION_CHANGED');if(Date.parse(cutoff)<=Date.parse(state.effective_after))return baseline;if(state.policy.model!==baseline.model||state.policy.reasoning_effort!==baseline.reasoning_effort||state.policy.predictor_version!==baseline.predictor_version)return baseline;return state.policy;
}
