import path from'node:path';import{readJson,exists}from'./m1-files.mjs';
export async function runtimeDisplay(dataRoot,{paused=true}={}){
 const file=path.join(dataRoot,'m1-task-status/forecast.json'),value=await exists(file)?await readJson(dataRoot,file):null,successFile=path.join(dataRoot,'m1-task-status/last-forecast-success.json'),success=await exists(successFile)?await readJson(dataRoot,successFile):null;
 const status=value?.status==='started'?'running':value?.status;
 const latest=value?{cycle_id:value.id,trigger:value.trigger,status:['running','completed','failed','late','skipped'].includes(status)?status:'failed',stage:status==='completed'?'done':'unknown',started_at:value.started_at,updated_at:value.completed_at??value.started_at,completed_at:value.completed_at??null,reason:status==='completed'||status==='running'?null:value.reason==='paused'?'paused':'unknown',forecast_id:value.forecast_id??null}:null;
 return{schema:'MFV:M1_RUNTIME_DISPLAY:v1',checked_at:new Date().toISOString(),configuration:null,release_integrity:'verified',paused,latest_attempt:latest,last_success:success?{cycle_id:success.id,completed_at:success.completed_at,forecast_id:success.forecast_id}:null};
}
