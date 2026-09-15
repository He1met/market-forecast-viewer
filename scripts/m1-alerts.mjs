import path from 'node:path';
import {atomic,readJson,exists,check,digest,canonical} from './m1-files.mjs';

const reminderMs=6*3600000;
const rank={warning:1,critical:2};
// The caller owns the business mutex. State, deduplication and pending events
// commit together: retrying an uncertain write cannot manufacture another alert.
export function alertStore(dataRoot,{stream='default'}={}){
 check(['default','execution'].includes(stream),'ALERT_STREAM_INVALID');
 const file=path.join(dataRoot,stream==='default'?'m1-control/alerts.json':'m1-control/execution-alerts.json');
 const load=async()=>{
  const state=await exists(file)?await readJson(dataRoot,file):{schema:'MFV:ALERT_STATE:v1',tasks:{},observations:{},events:[]};
  check(state.schema==='MFV:ALERT_STATE:v1'&&state.tasks&&state.observations&&Array.isArray(state.events),'ALERT_STATE_INVALID');return state;
 };
 const pending=async()=> (await load()).events.filter(x=>x.delivery.status==='pending');
 async function observe({task,observationId,at,condition=null,paused=false,confirmed=false,guard}){
  check(typeof guard==='function','ALERT_GUARD_REQUIRED');await guard();
  check(['forecast','ops','backup'].includes(task)&&typeof observationId==='string'&&observationId.length>0&&observationId.length<=128,'ALERT_OBSERVATION_INVALID');
  const time=Date.parse(at);check(Number.isFinite(time),'ALERT_TIME_INVALID');
  if(condition)check(/^[A-Z][A-Z0-9_]{0,79}$/.test(condition.code)&&typeof condition.object==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(condition.object)&&rank[condition.severity],'ALERT_CONDITION_INVALID');
  const state=await load(),identity=(stream==='default'?'':stream+':')+task+':'+observationId,hash=digest(canonical({task,observationId,at,condition,paused,...(confirmed?{confirmed:true}:{})}));
  if(state.observations[identity]){check(state.observations[identity]===hash,'ALERT_OBSERVATION_CHANGED');return{status:'duplicate',pending:state.events.filter(x=>x.delivery.status==='pending')};}
  const prior=state.tasks[task];check(!prior||time>=Date.parse(prior.checked_at),'ALERT_TIME_REVERSED');
  const active=prior?.active??{},key=condition?task+':'+condition.code+':'+condition.object:null;
  const emit=(kind,fault)=>state.events.push({schema:'MFV:ALERT_EVENT:v1',id:digest(identity+':'+kind+':'+fault.key),task,kind,at,observation_id:observationId,key:fault.key,code:fault.code,object:fault.object,severity:fault.severity,delivery:{status:'pending'}});
  // Pause is neither another failure nor proof that a previous fault recovered.
  let current={...active};
  if(!paused){
   if(!condition){for(const fault of Object.values(active))if(fault.notified_at)emit('recovery',fault);current={};}
   else{
    // A different error does not prove recovery of the previous one. Preserve
    // the transition in history, without emitting a false recovery notification.
    const previous=active[key],fault={key,...condition,count:prior?.last_key===key?(previous?.count??0)+1:1,first_seen_at:previous?.first_seen_at??at,notified_at:previous?.notified_at??null,notified_severity:previous?.notified_severity??null};
    const due=confirmed||condition.severity==='critical'||fault.count>=2;
    if(due&&(!fault.notified_at||time-Date.parse(fault.notified_at)>=reminderMs||rank[condition.severity]>rank[fault.notified_severity])){
     emit(fault.notified_at?'reminder':'fault',fault);fault.notified_at=at;fault.notified_severity=condition.severity;
    }
    current[key]=fault;
   }
  }
  state.tasks[task]={checked_at:at,paused,last_key:paused?null:key,active:current};state.observations[identity]=hash;
  await guard();await atomic(dataRoot,file,state);
  return{status:'recorded',pending:state.events.filter(x=>x.delivery.status==='pending')};
 }
 // No transport is configured here. Only an externally verified delivery receipt
 // may acknowledge an event; writing the outbox never implies delivery.
 async function acknowledge({eventId,receipt,guard}){
  check(typeof guard==='function','ALERT_GUARD_REQUIRED');await guard();
  check(receipt?.channel==='official-task'&&typeof receipt.id==='string'&&receipt.id.length>0&&Number.isFinite(Date.parse(receipt.delivered_at)),'ALERT_DELIVERY_RECEIPT_REQUIRED');
  const state=await load(),event=state.events.find(x=>x.id===eventId);check(event,'ALERT_EVENT_UNKNOWN');
  if(event.delivery.status==='delivered'){check(canonical(event.delivery.receipt)===canonical(receipt),'ALERT_DELIVERY_CHANGED');return{status:'already_acknowledged'};}
  check(Date.parse(receipt.delivered_at)>=Date.parse(event.at),'ALERT_DELIVERY_TIME_INVALID');
  event.delivery={status:'delivered',receipt};await guard();await atomic(dataRoot,file,state);return{status:'acknowledged'};
 }
 return{observe,pending,acknowledge};
}

export function opsAlertCondition(result){
 if(result.status==='completed')return null;
 const reason=[result.reason,...(result.unresolved??[]).map(x=>x.reason)].filter(Boolean).join(' ');
 let code='OPS_RESULTS_INCOMPLETE',severity='warning';
 if(/(?:INTEGRITY|HASH_MISMATCH|TAMPER|SYMLINK|PATH_ESCAPE)/.test(reason)){code='CONTENT_INTEGRITY';severity='critical';}
 else if(/(?:EACCES|EPERM|AUTHENTICATION|UNAUTHORIZED)/.test(reason)){code='PERMISSION_OR_AUTH';severity='critical';}
 else if(/(?:ENOSPC|EROFS|EIO)/.test(reason)){code='STORAGE_UNWRITABLE';severity='critical';}
 return{code,object:'inspection',severity};
}
