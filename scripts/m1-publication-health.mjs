import {scheduledSlot} from './m1-cycle.mjs';
import {check} from './m1-files.mjs';

// Local schedule expectation, never evidence that the official task ran. An
// explicit activation epoch excludes all paused/pre-installation history.
export async function publicationHealth({reader,paused=true,expectedSince=null,now=Date.now()}){
 check(Number.isFinite(now),'STATUS_TIME_INVALID');
 const base={basis:'local_schedule',expected_since:expectedSince,checked_at:new Date(now).toISOString(),slots:[]};
 if(paused)return{...base,status:'paused'};
 const since=Date.parse(expectedSince);
 if(!Number.isFinite(since)||since>now)return{...base,expected_since:null,status:'unknown'};
 const latest=scheduledSlot(now-1020000),slots=[latest,scheduledSlot(latest.anchor_time*1000-1)].filter(s=>Date.parse(s.target_at)>=since);
 if(!slots.length)return{...base,status:'waiting'};
 let ids;try{ids=await reader.listRunIds();}catch{return{...base,status:'unknown'};}
 for(const slot of slots){
  // Installed freeze creates the run ID within this fixed generation window.
  // Do not scan all historical raw archives on every status GET.
  const stamp=t=>new Date(t).toISOString().replace(/[-:.]/g,'');
  const lower='m1-'+stamp(Date.parse(slot.target_at))+'-',upper='m1-'+stamp(slot.first_node*1000)+'-';
  const candidates=ids.filter(id=>id>=lower&&id<upper);
  let status=candidates.length>16?'unknown':'missing',forecastId=null;
  for(const id of candidates.slice(0,16)){
   try{
    const {forecast:f}=await reader.readRun(id,{includeEvaluation:false});
    if(f.anchor_time===slot.anchor_time&&f.status==='valid'&&Date.parse(f.published_at)<slot.first_node*1000&&Date.parse(f.published_at)<=now){status='present';forecastId=id;break;}
   }catch(e){if(e.message!=='PUBLICATION_MISSING')status='unknown';}
  }
  base.slots.push({slot_id:slot.slot_id,anchor_time:slot.anchor_time,deadline_at:new Date((slot.first_node+120)*1000).toISOString(),status,forecast_id:forecastId});
 }
 return{...base,status:base.slots[0].status==='present'?'current':base.slots[0].status==='missing'?'stalled':'unknown'};
}

// Count distinct missed slots, not two hourly observations of the same miss.
export async function observePublicationHealth(store,health,{observationId,guard}){
 if(health.status==='current')return store.observe({task:'forecast',observationId,at:health.checked_at,condition:null,guard});
 if(health.slots.length===2&&health.slots.every(s=>s.status==='missing'))return store.observe({task:'forecast',observationId,at:health.checked_at,condition:{code:'FORECAST_OUTPUT_MISSING',object:'scheduled_publication',severity:'warning'},confirmed:true,guard});
 return{status:'not_confirmed',pending:await store.pending()};
}
