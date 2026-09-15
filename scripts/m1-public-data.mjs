import path from'node:path';import{randomUUID}from'node:crypto';import{writeOnce,digest,check}from'./m1-files.mjs';
const hosts=new Set(['www.okx.com','www.bls.gov','www.federalreserve.gov']);
export async function publicGet(url,{timeoutMs=10000,maxBytes=2*1024*1024,signal}={}){
 const target=new URL(url);check(target.protocol==='https:'&&hosts.has(target.hostname)&&!target.username&&!target.password&&!target.port,'PUBLIC_SOURCE_FORBIDDEN');
 const started_at=new Date().toISOString(),response=await fetch(url,{redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])])});
 check(response.ok,'PUBLIC_HTTP_'+response.status);check(Number(response.headers.get('content-length')??0)<=maxBytes,'PUBLIC_RESPONSE_OVERSIZE');
 const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;check(size<=maxBytes,'PUBLIC_RESPONSE_OVERSIZE');chunks.push(chunk);}return{bytes:Buffer.concat(chunks),started_at,received_at:new Date().toISOString(),status:response.status};
}
const numeric=(x,{nonnegative=false}={})=>{if(typeof x!=='string'||!x.trim()||!Number.isFinite(Number(x))||nonnegative&&Number(x)<0)return null;return Number(x);};
export function parseDerivatives(kind,body,receivedAt){
 check(body.code==='0'&&Array.isArray(body.data),'DERIVATIVE_RESPONSE_INVALID');
 return body.data.map(row=>{check(row.instId==='BTC-USDT-SWAP','DERIVATIVE_INSTRUMENT_MISMATCH');const provider=numeric(kind==='funding-rate-history'?row.fundingTime:row.ts,{nonnegative:true});check(provider!==null&&provider<=Date.parse(receivedAt)+5000,'DERIVATIVE_TIME_UNKNOWN');
  if(kind==='open-interest')return{instrument:row.instId,provider_timestamp:new Date(provider).toISOString(),oi_contracts:numeric(row.oi,{nonnegative:true}),oi_base:numeric(row.oiCcy,{nonnegative:true}),oi_usd:numeric(row.oiUsd,{nonnegative:true}),units:{oi_contracts:'contracts',oi_base:'BTC',oi_usd:'USD'}};
  return{instrument:row.instId,provider_timestamp:new Date(provider).toISOString(),funding_rate:numeric(row.fundingRate),realized_rate:numeric(row.realizedRate),funding_time:numeric(row.fundingTime,{nonnegative:true}),next_funding_time:numeric(row.nextFundingTime,{nonnegative:true}),rate_unit:'ratio',interval_assumed:false};
 });
}
export async function collectDerivatives(dataRoot,{transport=publicGet,signal}={}){
 const id=randomUUID(),folder=path.join(dataRoot,'m1-derivatives',id),items=[];
 for(const kind of ['open-interest','funding-rate','funding-rate-history']){const url='https://www.okx.com/api/v5/public/'+kind+'?'+new URLSearchParams(kind==='open-interest'?{instType:'SWAP',instId:'BTC-USDT-SWAP'}:{instId:'BTC-USDT-SWAP',...(kind.endsWith('history')?{limit:'100'}:{})});
  try{const r=await transport(url,{timeoutMs:8000,signal});const raw_path=`m1-derivatives/${id}/${kind}.json`;await writeOnce(dataRoot,path.join(dataRoot,raw_path),r.bytes.toString());items.push({kind,status:'collected',url,raw_path,sha256:digest(r.bytes),received_at:r.received_at,values:parseDerivatives(kind,JSON.parse(r.bytes),r.received_at),incorporated:false});}
  catch(e){items.push({kind,status:'missing',reason:e.message,values:null,incorporated:false});}
 }
 const result={schema:'MFV:DERIVATIVES:v1',id,created_at:new Date().toISOString(),items};await writeOnce(dataRoot,path.join(folder,'manifest.json'),result);const{atomic}=await import('./m1-files.mjs');await atomic(dataRoot,path.join(dataRoot,'m1-derivatives/latest.json'),result);return result;
}
/** Resolve wall time by finding exactly one UTC instant that formats to it; DST gaps/folds reject. */
export function newYorkTime(year,month,day,hour,minute){
 const expected=[year,month,day,hour,minute],formatter=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),matches=[];
 for(const offset of [4,5]){const epoch=Date.UTC(year,month-1,day,hour+offset,minute);const fields=Object.fromEntries(formatter.formatToParts(epoch).map(x=>[x.type,x.value]));if(['year','month','day','hour','minute'].every((k,i)=>Number(fields[k])===expected[i]))matches.push(epoch);}
 check(matches.length===1,'CALENDAR_WALL_TIME_AMBIGUOUS_OR_INVALID');return new Date(matches[0]).toISOString();
}
export function calendarInput(cache,{cutoff,anchor,horizon=86400,enabled=false}){
 const localDate=seconds=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(seconds*1000));
 const items=[],included=[];for(const item of cache?.items??[]){let reason=null;if(!enabled)reason='method_input_disabled';else if(!Number.isFinite(Date.parse(item.first_seen_at))||Date.parse(item.first_seen_at)>Date.parse(cutoff))reason='not_available_at_freeze';else if(!Number.isFinite(Date.parse(item.fetched_at))||Date.parse(item.fetched_at)>Date.parse(cutoff))reason='fetch_time_invalid';else if(item.source_published_at!==null&&(!Number.isFinite(Date.parse(item.source_published_at))||Date.parse(item.source_published_at)>Date.parse(cutoff)))reason='publication_time_invalid';else if(Date.parse(cutoff)-Date.parse(item.fetched_at)>12*3600000)reason='cache_expired';else if(item.time_precision==='minute'&&(Date.parse(item.event_time)<anchor*1000||Date.parse(item.event_time)>=(anchor+horizon)*1000))reason='outside_window';else if(item.time_precision==='date'&&(item.end_date<localDate(anchor)||item.start_date>localDate(anchor+horizon-1)))reason='outside_window';else if(!['minute','date'].includes(item.time_precision))reason='precision_unknown';
  const value={...item,incorporated:reason===null,exclusion_reason:reason};items.push(value);if(!reason)included.push(value);
 }
 return{schema:'MFV:CALENDAR_INPUT:v1',mode:included.length?'official_calendar':'market_only',cutoff,items,included,event_risk_incorporated:included.length>0,reason:included.length?null:!cache?'source_unavailable':items.length?'no_included_events':'parse_empty'};
}
const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
const plain=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&ndash;|&#8211;/g,'-').replace(/\s+/g,' ').trim();
export function parseCalendar(kind,html,{fetchedAt,sourceUrl,previous=[],timezoneEvidence='' }){
 const items=[],previousIds=new Map(previous.map(x=>[x.id,x]));
 const add=details=>{const id=digest(JSON.stringify({kind,...details}));items.push({id,kind,...details,source_url:sourceUrl,source_published_at:null,first_seen_at:previousIds.get(id)?.first_seen_at??fetchedAt,first_seen_reference:previousIds.get(id)?.first_seen_reference??(previousIds.get(id)?.raw_path?{raw_path:previousIds.get(id).raw_path,sha256:previousIds.get(id).raw_sha256}:null),fetched_at:fetchedAt,parser_version:'official-calendar-v1'});};
 if(kind==='CPI'){
  check(/Eastern Time/i.test(plain(html+' '+timezoneEvidence)),'CALENDAR_TIMEZONE_UNCONFIRMED');
  for(const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){const text=plain(row[1]),date=text.match(/([A-Za-z]+)\.?\s+(\d{1,2}),\s*(20\d{2})/),hour=text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);if(!date||!hour)continue;
   const month=months.findIndex(x=>x.toLowerCase().startsWith(date[1].toLowerCase()));check(month>=0,'CALENDAR_MONTH_INVALID');const h=Number(hour[1])%12+(hour[3].toUpperCase()==='PM'?12:0);add({title:'Consumer Price Index',event_time:newYorkTime(Number(date[3]),month+1,Number(date[2]),h,Number(hour[2])),time_precision:'minute',timezone:'America/New_York'});
  }
 }else if(kind==='FOMC'){
  for(const block of html.split(/(?=<h[234][^>]*>(?:\s*<[^>]+>)*\s*20\d{2}\s+FOMC Meetings)/i)){const year=plain(block.slice(0,500)).match(/(20\d{2}) FOMC Meetings/);if(!year)continue;
   const pattern=/fomc-meeting__month[^>]*>([\s\S]*?)<\/div>[\s\S]*?fomc-meeting__date[^>]*>([\s\S]*?)<\/div>/gi;
   for(const match of block.matchAll(pattern)){const month=months.indexOf(plain(match[1])),days=plain(match[2]).match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\*?$/);if(month<0||!days)continue;const date=d=>`${year[1]}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;add({title:'FOMC meeting',start_date:date(days[1]),end_date:date(days[2]??days[1]),time_precision:'date',timezone:'America/New_York'});}
  }
 }else throw Error('CALENDAR_KIND_INVALID');
 check(items.length>0,'CALENDAR_PARSE_EMPTY');return items;
}
export async function collectCalendar(dataRoot,{transport=publicGet,signal}={}){
 const{readJson,exists,atomic}=await import('./m1-files.mjs');const latest=path.join(dataRoot,'m1-calendar/latest.json'),prior=await exists(latest)?await readJson(dataRoot,latest):null;
 if(prior&&Date.now()-Date.parse(prior.fetched_at)<6*3600000)return{...prior,cache_reused:true};
 const id=randomUUID(),items=[],sources=[];let timezoneEvidence='';
 try{const url=`https://www.bls.gov/schedule/${new Date().getUTCFullYear()}/home.htm`,r=await transport(url,{timeoutMs:8000,signal}),raw_path=`m1-calendar/${id}/BLS-timezone.html`;await writeOnce(dataRoot,path.join(dataRoot,raw_path),r.bytes);timezoneEvidence=r.bytes.toString();sources.push({kind:'BLS_TIMEZONE',url,raw_path,sha256:digest(r.bytes),status:'collected',received_at:r.received_at});}catch(e){sources.push({kind:'BLS_TIMEZONE',status:'missing',reason:e.message});}
 for(const[kind,url]of[['CPI','https://www.bls.gov/schedule/news_release/cpi.htm'],['FOMC','https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm']]){
  try{const r=await transport(url,{timeoutMs:8000,signal}),raw_path=`m1-calendar/${id}/${kind}.html`;await writeOnce(dataRoot,path.join(dataRoot,raw_path),r.bytes);const parsed=parseCalendar(kind,r.bytes.toString(),{fetchedAt:r.received_at,sourceUrl:url,previous:prior?.items??[],timezoneEvidence});items.push(...parsed.map(x=>({...x,raw_path,raw_sha256:digest(r.bytes)})));sources.push({kind,url,raw_path,sha256:digest(r.bytes),status:'collected',received_at:r.received_at});}catch(e){sources.push({kind,url,status:'missing',reason:e.message});}
 }
 const result={schema:'MFV:CALENDAR:v1',id,fetched_at:new Date().toISOString(),items,sources};await writeOnce(dataRoot,path.join(dataRoot,'m1-calendar',id,'manifest.json'),result);await atomic(dataRoot,latest,result);return result;
}
