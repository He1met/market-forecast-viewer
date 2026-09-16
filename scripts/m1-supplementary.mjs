import path from'node:path';import{readJson,readBytes,exists,digest,check}from'./m1-files.mjs';import{calendarInput}from'./m1-public-data.mjs';
export async function supplementary(dataRoot,{cutoff,anchor,policy}){
 const get=async name=>await exists(path.join(dataRoot,name))?await readJson(dataRoot,path.join(dataRoot,name)):null;
 const derivatives=await get('m1-derivatives/latest.json'),calendar=await get('m1-calendar/latest.json'),sources=[];
 for(const source of [...(derivatives?.items??[]),...(calendar?.sources??[])]){if(source.status!=='collected'||!source.raw_path)continue;const bytes=await readBytes(dataRoot,path.join(dataRoot,source.raw_path));check(digest(bytes)===source.sha256,'SUPPLEMENTARY_SOURCE_CHANGED');check(Date.parse(source.received_at)<=Date.parse(cutoff),'SUPPLEMENTARY_FROM_FUTURE');sources.push({path:'artifacts/'+source.raw_path,sha256:source.sha256});}
 for(const item of calendar?.items??[]){const ref=item.first_seen_reference;if(ref&&!sources.some(x=>x.path==='artifacts/'+ref.raw_path)){const bytes=await readBytes(dataRoot,path.join(dataRoot,ref.raw_path));check(digest(bytes)===ref.sha256,'CALENDAR_FIRST_SEEN_SOURCE_CHANGED');sources.push({path:'artifacts/'+ref.raw_path,sha256:ref.sha256});}}
 const usedDerivatives=policy.additional_inputs==='derivatives'&&derivatives&&Date.parse(cutoff)-Date.parse(derivatives.created_at)<=2*3600000;
 const events=calendarInput(calendar,{cutoff,anchor,enabled:policy.additional_inputs==='calendar'});
 return{schema:'MFV:SUPPLEMENTARY:v1',frozen_at:cutoff,source_files:sources,derivatives:derivatives?{...derivatives,incorporated:!!usedDerivatives}:null,calendar:events,model_context:{...(usedDerivatives?{derivatives:derivatives.items.filter(x=>x.status==='collected').map(({kind,values})=>({kind,values}))}:{}),...(events.included.length?{calendar:events.included}: {})}};
}
export function applySupplementary(input,policy){
 const snapshot=input.supplementary;if(!snapshot)return input;const context={...input.model_context};delete context.derivatives;delete context.calendar;
 const use=policy.additional_inputs==='derivatives'&&snapshot.derivatives&&Date.parse(snapshot.frozen_at)-Date.parse(snapshot.derivatives.created_at)<=2*3600000;
 if(snapshot.derivatives)snapshot.derivatives.incorporated=!!use;
 snapshot.calendar=calendarInput({items:snapshot.calendar.items},{cutoff:snapshot.frozen_at,anchor:input.anchor_time,enabled:policy.additional_inputs==='calendar'});
 if(use)context.derivatives=snapshot.derivatives.items.filter(x=>x.status==='collected').map(({kind,values})=>({kind,values}));
 if(snapshot.calendar.included.length)context.calendar=snapshot.calendar.included;
 input.model_context=context;return input;
}
export function effectiveEvents(input){
 const calendar=input.supplementary?.calendar;if(!calendar?.event_risk_incorporated)return input.events;
 check(calendar.schema==='MFV:CALENDAR_INPUT:v1'&&calendar.mode==='official_calendar'&&calendar.included.length>0,'CALENDAR_CONTRACT_INVALID');
 for(const event of calendar.included){check(['minute','date'].includes(event.time_precision)&&Date.parse(event.first_seen_at)<=Date.parse(calendar.cutoff)&&Date.parse(event.fetched_at)<=Date.parse(calendar.cutoff),'CALENDAR_AVAILABILITY_INVALID');if(event.source_published_at!==null)check(Date.parse(event.source_published_at)<=Date.parse(calendar.cutoff),'CALENDAR_PUBLICATION_FROM_FUTURE');check(input.supplementary.source_files.some(s=>s.path==='artifacts/'+event.raw_path&&s.sha256===event.raw_sha256),'CALENDAR_SOURCE_NOT_FROZEN');}
 return{...input.events,mode:'official_calendar',information_cutoff:calendar.cutoff,event_risk_incorporated:true};
}
