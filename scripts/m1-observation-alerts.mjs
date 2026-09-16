import fs from 'node:fs/promises';
import path from 'node:path';
import {atomic,readJson,exists,check,safePath,digest,canonical} from './m1-files.mjs';
import {alertStore,opsAlertCondition} from './m1-alerts.mjs';

export function executionCondition(result){
 if(result.status==='completed')return {condition:null,paused:false};
 if(result.status==='skipped'&&['paused','duplicate_slot','slot_completed'].includes(result.reason))return {condition:null,paused:true};
 const base=opsAlertCondition(result);
 if(result.task==='ops'&&result.lock_acquired!==false&&!/BUSY|MUTEX_CONFLICT|ORPHAN_/.test(result.reason??''))return {condition:null,paused:true};
 if(/MUTEX_CONFLICT|ORPHAN_/.test(result.reason??''))return {condition:{code:'MUTEX_IDENTITY_UNKNOWN',object:'business_mutex',severity:'critical'},paused:false};
 return {condition:{...base,code:base.code==='OPS_RESULTS_INCOMPLETE'?'EXECUTION_INCOMPLETE':base.code,object:'invocation'},paused:false};
}

// A frozen sweep reads at most 16 invocation results per call, then replays them
// in completion order. The queue is durable before any outbox write. Independent
// invocation logs are never modified, and the caller must own the business lock.
export async function collectExecutionObservations({dataRoot,guard,limit=16,now=Date.now()}){
 check(typeof guard==='function'&&Number.isInteger(limit)&&limit>0&&limit<=16,'OBSERVATION_COLLECTOR_INVALID');await guard();
 const file=path.join(dataRoot,'m1-control/observation-alert-cursor.json'),root=path.join(dataRoot,'m1-observations');
 const state=await exists(file)?await readJson(dataRoot,file):{schema:'MFV:OBSERVATION_ALERT_CURSOR:v1',seen:{},latest:{},scan:null,queue:[]};
 check(state.schema==='MFV:OBSERVATION_ALERT_CURSOR:v1'&&state.seen&&state.latest&&Array.isArray(state.queue),'OBSERVATION_CURSOR_INVALID');
 state.warning_slots??={};
 const save=async()=>{await guard();await atomic(dataRoot,file,state);};
 if(!state.scan&&!state.queue.length){
  let ids=[];if(await exists(root)){await safePath(dataRoot,root);ids=(await fs.readdir(root)).filter(x=>/^[a-f0-9-]{36}$/.test(x)&&!state.seen[x]).sort();}
  state.scan={ids,offset:0,results:[]};await save();
 }
 let inspected=0,consumed=0;
 if(state.scan){
  while(state.scan.offset<state.scan.ids.length&&inspected<limit){
   const id=state.scan.ids[state.scan.offset],resultFile=path.join(root,id,'result.json');inspected++;
   if(await exists(resultFile)){
    const start=await readJson(dataRoot,path.join(root,id,'started.json')),result=await readJson(dataRoot,resultFile);
    check(result.schema==='MFV:OBSERVATION:v1'&&result.id===id&&start.id===id&&result.task===start.task&&result.release_id===start.release_id&&result.started_at===start.started_at&&['forecast','ops','backup'].includes(result.task)&&['completed','failed','partial','skipped'].includes(result.status),'OBSERVATION_RESULT_INVALID');
    check(Number.isFinite(Date.parse(result.started_at))&&Date.parse(result.completed_at)>=Date.parse(result.started_at)&&Date.parse(result.completed_at)<=now,'OBSERVATION_TIME_INVALID');
    state.scan.results.push({id,task:result.task,completed_at:result.completed_at,hash:digest(canonical(result)),slot_id:result.slot_id??null,...executionCondition(result)});
   }
   state.scan.offset++;await save();
  }
  if(state.scan.offset===state.scan.ids.length){
   state.queue=state.scan.results.sort((a,b)=>Date.parse(a.completed_at)-Date.parse(b.completed_at)||a.id.localeCompare(b.id));state.scan=null;await save();
  }
 }
 const store=alertStore(dataRoot,{stream:'execution'});
 while(state.queue.length&&consumed<limit){
  const item=state.queue[0],latest=state.latest[item.task];
  // A late-arriving old success cannot recover a newer failure. Old faults stay
  // visible conservatively. Persist the ingestion timestamp for uncertain retries.
  if(!item.at){item.at=new Date(now).toISOString();item.paused=item.paused||(!item.condition&&latest&&Date.parse(item.completed_at)<Date.parse(latest));await save();}
  const slotKey=item.task==='forecast'&&item.slot_id&&item.condition?.severity==='warning'?item.slot_id+':'+item.condition.code:null;
  if(!slotKey||!state.warning_slots[slotKey])await store.observe({task:item.task,observationId:item.id,at:item.at,condition:item.condition,paused:Boolean(item.paused),guard});
  if(slotKey)state.warning_slots[slotKey]=item.id;
  state.seen[item.id]=item.hash;state.latest[item.task]=!latest||Date.parse(item.completed_at)>Date.parse(latest)?item.completed_at:latest;
  state.queue.shift();consumed++;await save();
 }
 return {status:state.scan||state.queue.length?'incomplete':'completed',inspected,consumed,pending:(await store.pending()).map(x=>x.id)};
}
