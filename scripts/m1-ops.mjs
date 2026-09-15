import {alertStore,opsAlertCondition} from './m1-alerts.mjs';
import path from'node:path';import{randomUUID}from'node:crypto';import{writeOnce,atomic,readJson,exists,check}from'./m1-files.mjs';import{businessMutex}from'./m1-mutex.mjs';import{createDisplayReader}from'./m1-display.mjs';import{createOutcomeStore}from'./m1-outcome-store.mjs';import{projectionStore}from'./m1-index.mjs';import{caseStore}from'./m1-cases.mjs';import{experimentStore,effectivePolicy}from'./m1-experiments.mjs';import{mainScenario,fitLambda}from'./m1-learning.mjs';import fs from'node:fs/promises';
// Persist unresolved objects independently of the rotating scan position. A crash
// after selecting an object cannot make its failure disappear on the next batch.
export async function scanOpsBatch({dataRoot,role,ids,visit,guard,limit=8,shouldStop=()=>false}) {
 check(['production','candidate'].includes(role),'OPS_ROLE_INVALID');
 const file=path.join(dataRoot,'m1-control/ops-'+role+'-cursor.json');
 const prior=await exists(file)?await readJson(dataRoot,file):{offset:0,unresolved:[]};
 check(Number.isSafeInteger(prior.offset)&&prior.offset>=0&&Array.isArray(prior.unresolved??[]),'OPS_CURSOR_INVALID');
 const unresolved=new Map((prior.unresolved??[]).map(x=>[x.run_id,x]));
 const offset=ids.length?prior.offset%ids.length:0,ordered=[...ids.slice(offset),...ids.slice(0,offset)];
 let visited=0;const outcomes=[];
 const save=async()=>{await guard();await atomic(dataRoot,file,{offset:offset+visited,unresolved:[...unresolved.values()]});};
 const known=new Set(ids);for(const [id,value] of unresolved)if(!known.has(id))unresolved.set(id,{...value,reason:'archive_missing'});
 await save();
 for(const runId of ordered){
  if(visited>=limit||shouldStop())break;
  unresolved.set(runId,{run_id:runId,reason:'inspection_incomplete'});await save();
  let outcome;
  try{outcome=await visit(runId);check(outcome?.status==='ok'||outcome?.status==='failed','OPS_OUTCOME_INVALID');}
  catch(e){outcome={status:'failed',reason:e.message};}
  if(outcome.status==='ok')unresolved.delete(runId);
  else unresolved.set(runId,{run_id:runId,reason:outcome.reason??'capture_failed'});
  outcomes.push({role,run_id:runId,...outcome});visited++;await save();
 }
 return{visited,outcomes,unresolved:[...unresolved.values()].map(x=>({role,...x}))};
}
export async function ops({codeRoot,dataRoot,port,releaseId,policy,paused=false,outcomeTransport,refreshInputs=async()=>{}}){
 const slotHour=new Date().toISOString().slice(0,13),slotFile=path.join(dataRoot,'m1-control/ops-slots',slotHour.replace(/[^0-9]/g,'')+'.json');
 const start=performance.now(),id=randomUUID(),folder=path.join(dataRoot,'m1-observations',id),observation={schema:'MFV:OBSERVATION:v1',id,task:'ops',release_id:releaseId,started_at:new Date().toISOString()};await writeOnce(dataRoot,path.join(folder,'started.json'),observation);let mutex,result={status:'failed',reason:'incomplete'};
 try{if(paused){result={status:'skipped',reason:'paused'};return result;}mutex=await businessMutex({dataRoot,port,releaseId,task:'ops'});if(mutex.status!=='ACQUIRED'){result={status:'skipped',reason:mutex.status};return result;}
  if(await exists(slotFile)&&(await readJson(dataRoot,slotFile)).status==='completed'){result={status:'skipped',reason:'slot_completed'};return result;}
  await atomic(dataRoot,slotFile,{schema:'MFV:OPS_SLOT:v1',slot_hour:slotHour,status:'running',observation_id:id,started_at:observation.started_at});
  const guard=async()=>{await mutex.guard();check(performance.now()-start<120000,'OPS_WRITE_DEADLINE');};
  const experiment=experimentStore(dataRoot);const recoveredDecision=await experiment.recoverTransition({guard});
  const readers={production:createDisplayReader({root:codeRoot,dataRoot}),candidate:createDisplayReader({root:codeRoot,dataRoot,runsRoot:path.join(dataRoot,'m1-candidates')})};
  const outcomes=[],unresolved=[];let processed=0;
  for(const role of ['production','candidate']){
   const reader=readers[role],runsRoot=path.join(dataRoot,role==='production'?'forecast-runs':'m1-candidates'),store=createOutcomeStore({root:codeRoot,dataRoot,runsRoot});
   const batch=await scanOpsBatch({dataRoot,role,ids:await reader.listRunIds(),guard,limit:Math.min(8,16-processed),shouldStop:()=>performance.now()-start>85000,visit:async runId=>{
    const run=await reader.readRun(runId);
    if(run.forecast.status!=='valid')return{status:'ok',reason:'ineligible_forecast'};
    if(run.evaluation.status==='available'&&run.evaluation.result.windows.h24.status==='mature'){
     if(role==='production')await caseStore({codeRoot,dataRoot}).create(run.run_id,run.evaluation.revision_id);
     return{status:'ok',reason:'already_mature'};
    }
    const capture=await store.capture(run,{transport:outcomeTransport,signal:AbortSignal.timeout(Math.max(1,Math.floor(115000-(performance.now()-start)))),deadline:start+115000});
    if(capture.status==='ok'){await guard();const revision=await store.evaluateCapture(run,capture.capture_id);if(role==='production'&&revision.result.windows.h24.status==='mature')await caseStore({codeRoot,dataRoot}).create(run.run_id,revision.revision_id);}
    return capture;
   }});
   processed+=batch.visited;outcomes.push(...batch.outcomes);unresolved.push(...batch.unresolved);
  }
  let decision=recoveredDecision;
  if(performance.now()-start<100000){await guard();decision=recoveredDecision??((await caseStore({codeRoot,dataRoot}).controls()).learning_disabled?{decision:'paused_learning_disabled'}:await experiment.review({guard,readMetrics:async(id,role)=>{try{const run=await readers[role].readRun(id),f=run.forecast,e=run.evaluation.status==='available'?run.evaluation.result.windows.h24:null,main=mainScenario(f.scenarios.map(x=>x.probability_24h));return{valid:f.status==='valid',timely:Date.parse(f.published_at)<(f.anchor_time+900)*1000,started_at:f.generation_started_at,complete:e?.status==='mature',brier:e?.brier_score??null,path_loss:e?.scenario_errors.find(x=>x.id===main).mae_return_pct??null};}catch{return null;}}}));
   if(policy)policy=await effectivePolicy(dataRoot,policy);
   if(policy&&!await experiment.active()){
    const control=await caseStore({codeRoot,dataRoot}).controls();
    if(!control.learning_disabled){const cutoff=new Date().toISOString(),cases=await caseStore({codeRoot,dataRoot}).available(cutoff),used=new Set();
     for(const id of await fs.readdir(path.join(dataRoot,'m1-experiments')).catch(e=>{if(e.code==='ENOENT')return[];throw e;})){if(!/^[a-f0-9-]{36}$/.test(id))continue;const file=path.join(dataRoot,'m1-experiments',id,'plan.json');if(await exists(file))used.add((await readJson(dataRoot,file)).factor);}
     if(!used.has('feedback')&&policy.feedback==='F0'&&cases.length>=2)await experiment.create(policy,{...policy,feedback:'F1'},{guard,trainingCutoff:cutoff});
     else if(used.has('feedback')&&!used.has('probability')){const identity={predictor_version:policy.predictor_version,model:policy.model,reasoning_effort:policy.reasoning_effort,additional_inputs:policy.additional_inputs,feedback:policy.feedback},fit=fitLambda(cases,cutoff,identity);if(fit.n>=20&&fit.lambda!==policy.lambda)await experiment.create(policy,{...policy,lambda:fit.lambda},{guard,trainingCutoff:cutoff,factor:'probability',trainingEvidence:fit});}
    }
   }
  }
  if(performance.now()-start<95000)await refreshInputs({signal:AbortSignal.timeout(Math.max(1,Math.floor(115000-(performance.now()-start))))});
  const projection=await projectionStore(dataRoot).update(readers.production,{limit:16,guard,deadline:start+120000});const incomplete=unresolved.length>0;result={status:incomplete?'partial':'completed',...(incomplete?{reason:'outcome_incomplete'}:{}),outcomes,unresolved,projection,decision};return result;
 }catch(e){result={status:'failed',reason:e.message};return result;}finally{
  try{
   if(mutex?.status==='ACQUIRED'&&result.status!=='skipped'){
    try{const alerts=await alertStore(dataRoot).observe({task:'ops',observationId:id,at:new Date().toISOString(),condition:opsAlertCondition(result),guard:mutex.guard});result.alerts={delivery:alerts.pending.length?'pending':'none',event_ids:alerts.pending.map(x=>x.id)};}
    catch(e){Object.assign(result,{primary_status:result.status,status:'partial',alert_error:e.message,reason:result.reason??'alert_record_failed'});}
    await mutex.guard();await atomic(dataRoot,slotFile,{schema:'MFV:OPS_SLOT:v1',slot_hour:slotHour,status:result.status,observation_id:id,completed_at:new Date().toISOString()});
   }
   const final={...observation,...result,completed_at:new Date().toISOString(),elapsed_ms:performance.now()-start};
   await writeOnce(dataRoot,path.join(folder,'result.json'),final);
   if(mutex?.status==='ACQUIRED'){await mutex.guard();await atomic(dataRoot,path.join(dataRoot,'m1-task-status/ops.json'),final);}
  }finally{if(mutex?.status==='ACQUIRED')await mutex.close();}
 }
}
