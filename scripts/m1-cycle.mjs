import path from'node:path';import{randomUUID}from'node:crypto';
import{writeOnce,atomic,exists,readJson,digest,check}from'./m1-files.mjs';import{businessMutex}from'./m1-mutex.mjs';
export function scheduledSlot(now=Date.now()){
 const anchor=Math.floor((now/1000-6300)/7200)*7200+6300;
 return{schema:'MFV:SLOT:v1',slot_id:digest(`BTC-USDT-SWAP:900:86400:${anchor}`),instrument:'BTC-USDT-SWAP',bar_seconds:900,horizon_seconds:86400,anchor_time:anchor,target_at:new Date((anchor+120)*1000).toISOString(),first_node:anchor+900};
}
export async function cycle({dataRoot,releaseId,mutexPort,trigger='manual',paused=false,freeze,generate,publishIndex,scoreOld=async()=>{},registerOpportunity=async()=>null,prepareCandidate=async()=>null,runCandidate=async()=>{},finishOpportunity=async()=>{},clock=()=>Date.now(),monotonic=()=>performance.now()}){
 check(['manual','scheduled'].includes(trigger),'TRIGGER_INVALID');const started=monotonic(),slot=scheduledSlot(clock()),id=randomUUID(),folder=path.join(dataRoot,'m1-observations',id);
 const observation={schema:'MFV:OBSERVATION:v1',id,task:'forecast',trigger,slot_id:slot.slot_id,release_id:releaseId,started_at:new Date(clock()).toISOString(),status:'started'};await writeOnce(dataRoot,path.join(folder,'started.json'),observation);
 let mutex,claim,registration,candidate,official,result={status:'failed',reason:'incomplete'};const publishDeadline=Math.min(started+600000,started+(slot.first_node*1000-clock())-30000),writeDeadline=publishDeadline-15000;
 try{
  if(paused){result={status:'skipped',reason:'paused'};return result;}
  if(clock()<Date.parse(slot.target_at)||publishDeadline-started<90000){result={status:'skipped',reason:'missed_slot'};return result;}
  mutex=await businessMutex({dataRoot,port:mutexPort,releaseId,task:'forecast'});if(mutex.status!=='ACQUIRED'){result={status:'skipped',reason:mutex.status};return result;}
  await atomic(dataRoot,path.join(dataRoot,'m1-task-status/forecast.json'),observation);
  claim=path.join(dataRoot,'m1-slots',slot.slot_id+'.json');if(await exists(claim)){result={status:'skipped',reason:'duplicate_slot',original:await readJson(dataRoot,claim)};return result;}
  await writeOnce(dataRoot,claim,{...slot,observation_id:id,release_id:releaseId,claimed_at:new Date(clock()).toISOString()});
  const guard=async()=>{await mutex.guard();check(monotonic()<writeDeadline,'PUBLICATION_DEADLINE');check(clock()<slot.first_node*1000-30000,'FIRST_NODE_DEADLINE');};
  registration=await registerOpportunity(slot,{guard:mutex.guard});
  const oldBudget=Math.min(45000,Math.max(0,writeDeadline-monotonic()-90000));if(oldBudget>0)await scoreOld({signal:AbortSignal.timeout(Math.floor(oldBudget)),deadline:monotonic()+oldBudget,mutex}).catch(async e=>writeOnce(dataRoot,path.join(folder,'old-results-failure.json'),{reason:e.message}));
  await guard();const input=await freeze({slot,deadline:writeDeadline,signal:AbortSignal.timeout(Math.max(1,Math.floor(writeDeadline-monotonic()))),mutex});
  candidate=await prepareCandidate(registration,input,{guard:mutex.guard,deadline:writeDeadline});
  let published,lastError;for(let attempt=1;attempt<=2;attempt++){const remaining=writeDeadline-monotonic();if(remaining<90000)break;await guard();try{published=await generate(input,{attempt,timeoutMs:Math.min(240000,remaining),mutex,beforePublish:guard});break;}catch(e){lastError=e.message;await writeOnce(dataRoot,path.join(folder,`attempt-${attempt}-failure.json`),{at:new Date(clock()).toISOString(),error:lastError});}}
  if(!published)throw Error(lastError??'INSUFFICIENT_MODEL_BUDGET');await guard();await publishIndex({published,mutex,deadline:writeDeadline});
  official=published;result={status:'completed',forecast_id:published.forecast.run_id,slot_id:slot.slot_id};
  let candidateStatus='not_registered';if(registration){candidateStatus='budget_skipped';const remaining=writeDeadline-monotonic();if(candidate&&remaining>=90000){try{await runCandidate(candidate,{mutex,timeoutMs:Math.min(240000,remaining),beforePublish:guard});candidateStatus='published';}catch{candidateStatus='failed';}}await finishOpportunity(registration,{started:true,official_run_id:published.forecast.run_id,candidate_run_id:candidate?.run_id??null,candidate_status:candidateStatus});registration=null;}return result;
 }catch(e){result={status:'failed',reason:e.message,slot_id:slot.slot_id};return result;}
 finally{if(registration)await finishOpportunity(registration,{started:true,official_run_id:official?.forecast?.run_id??null,candidate_run_id:candidate?.run_id??null,candidate_status:'preparation_or_official_failed'});const final={...observation,...result,completed_at:new Date(clock()).toISOString(),elapsed_ms:monotonic()-started};await writeOnce(dataRoot,path.join(folder,'result.json'),final);if(mutex?.status==='ACQUIRED'){await mutex.guard();await atomic(dataRoot,path.join(dataRoot,'m1-task-status/forecast.json'),final);if(final.status==='completed')await atomic(dataRoot,path.join(dataRoot,'m1-task-status/last-forecast-success.json'),final);await mutex.close();}}
}
