import path from 'node:path';
import {alertStore} from './m1-alerts.mjs';
import {readJson,exists,check,canonical,digest} from './m1-files.mjs';

// Read-only projection for the official task's final response. No transport or
// acknowledgement is inferred from reading, printing, or presenting this data.
export async function notificationSummary(dataRoot,{limit=20}={}) {
 check(Number.isSafeInteger(limit)&&limit>=1&&limit<=100,'NOTIFICATION_LIMIT_INVALID');
 const events=[];
 for(const stream of ['default','execution','capacity','service']) {
  for(const event of await alertStore(dataRoot,{stream}).pending()) {
   check(event.schema==='MFV:ALERT_EVENT:v1'&&/^[a-f0-9]{64}$/.test(event.id)&&
    ['forecast','ops','backup'].includes(event.task)&&['fault','reminder','recovery'].includes(event.kind)&&
    ['warning','critical'].includes(event.severity)&&/^[A-Z][A-Z0-9_]{0,79}$/.test(event.code)&&
    /^[a-zA-Z0-9:_-]{1,128}$/.test(event.object)&&Number.isFinite(Date.parse(event.at)), 'NOTIFICATION_EVENT_INVALID');
   events.push({stream,event_id:event.id,task:event.task,kind:event.kind,severity:event.severity,code:event.code,object:event.object,at:new Date(event.at).toISOString()});
  }
 }
 events.sort((a,b)=>a.at.localeCompare(b.at)||a.stream.localeCompare(b.stream)||a.event_id.localeCompare(b.event_id));
 const selected=events.slice(-limit),lastFile=path.join(dataRoot,'m1-task-status/last-forecast-success.json');
 // This is a recorded publication time, not a new archive integrity inspection.
 // A missing/malformed success summary must not hide otherwise readable alerts.
 let lastPublication={status:'unknown',at:null,source:'recorded_summary'};
 try{if(await exists(lastFile)){const value=await readJson(dataRoot,lastFile);if(value.status==='completed'&&Number.isFinite(Date.parse(value.completed_at)))lastPublication={status:'recorded',at:new Date(value.completed_at).toISOString(),source:'recorded_summary'};}}
 catch{lastPublication={status:'unreadable',at:null,source:'recorded_summary'};}
 const eventSetId=digest(canonical(events));
 return {schema:'MFV:NOTIFICATION_SUMMARY:v1',channel:'official-task',delivery:events.length?'pending':'none',
  transport:'not_configured',event_set_id:eventSetId,pending_count:events.length,omitted_count:events.length-selected.length,
  events:selected,last_publication:lastPublication,
  next_action:events.length?'查看本地巡检与任务状态，按最新事件核对受影响对象。':'无需处理。',
  limitations:['历史待发送事件不代表当前故障仍存在。','摘要生成及任务呈现均不是送达回执。','各告警流独立读取，不保证同一时刻的跨流快照。']};
}
