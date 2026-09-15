import path from 'node:path';
import {publicationHealth} from './m1-publication-health.mjs';
import {readJson,exists,check} from './m1-files.mjs';
export async function runtimeDisplay(dataRoot,{paused=true,opsPaused=true,expectedSince=null,reader,now=Date.now()}={}){
 check(Number.isFinite(now),'STATUS_TIME_INVALID');
 const read=async name=>{const file=path.join(dataRoot,name);return await exists(file)?readJson(dataRoot,file):null;};
 const value=await read('m1-task-status/forecast.json'),success=await read('m1-task-status/last-forecast-success.json');
 const status=value?.status==='started'?'running':value?.status;
 const latest=value?{cycle_id:value.id,trigger:value.trigger,status:['running','completed','failed','late','skipped'].includes(status)?status:'failed',stage:status==='completed'?'done':'unknown',started_at:value.started_at,updated_at:value.completed_at??value.started_at,completed_at:value.completed_at??null,reason:status==='completed'||status==='running'?null:value.reason==='paused'?'paused':'unknown',forecast_id:value.forecast_id??null}:null;
 // Only an actual inspection committed by the mutex owner refreshes this time.
 // A GET, backup, paused invocation or duplicate hourly slot does not refresh it.
 const alerts=await read('m1-control/alerts.json');
 if(alerts)check(alerts.schema==='MFV:ALERT_STATE:v1'&&alerts.tasks,'ALERT_STATE_INVALID');
 const observed=alerts?.tasks.ops,at=observed?.checked_at??null,time=at===null?NaN:Date.parse(at);
 if(at!==null)check(Number.isFinite(time),'INSPECTION_TIME_INVALID');
 const freshness=at===null?'unknown':time>now?'clock_invalid':now-time>90*60000?'stale':'fresh';
 const inspection={paused:opsPaused,freshness,last_observed_at:at,result:!observed?'unknown':Object.keys(observed.active??{}).length?'failed':'ok'};
 return{schema:'MFV:M1_RUNTIME_DISPLAY:v1',source:'installed',checked_at:new Date(now).toISOString(),configuration:null,release_integrity:'verified',paused,inspection,publication_health:await publicationHealth({reader,paused,expectedSince,now}),latest_attempt:latest,last_success:success?{cycle_id:success.id,completed_at:success.completed_at,forecast_id:success.forecast_id}:null};
}
