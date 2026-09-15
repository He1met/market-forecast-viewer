import path from 'node:path';import{atomic,writeOnce,readJson,readBytes,digest,encode,check,exists}from'./m1-files.mjs';
/** Only the ops/cycle writer verifies archives and commits read models. GETs read bounded projections. */
export function projectionStore(dataRoot,{reader,ttlMs=60000,clock=()=>Date.now()}={}){
 const home=path.join(dataRoot,'m1-projections'),head=path.join(home,'index.json');
 async function update(reader,{limit=16,guard=async()=>{},deadline=Infinity}={}){
  const now=new Date().toISOString(),prior=await exists(head)?await readJson(dataRoot,head):null,ids=await reader.listRunIds(),entries=new Map((prior?.runs??[]).map(x=>[x.run_id,x]));let verified=0;
  const pending=ids.slice().sort((a,b)=>(Date.parse(entries.get(a)?.verified_at??'1970-01-01')-Date.parse(entries.get(b)?.verified_at??'1970-01-01'))||b.localeCompare(a));
  for(const id of pending){if(verified>=limit||performance.now()>=deadline)break;await guard();const item=await reader.runState(id,now);
   let view=null,error=null;try{view=await reader.readRun(id);}catch{error='archive_invalid';}
   const at=new Date().toISOString();let ref=null;
   if(view){const bytes=encode(view),hash=digest(bytes);ref={file:`m1-projections/views/${hash}.json`,sha256:hash};if(!await exists(path.join(dataRoot,ref.file)))await writeOnce(dataRoot,path.join(dataRoot,ref.file),bytes);}
   entries.set(id,{...item,verified_at:at,projection:ref,verification_error:error,mature_24h:view?.evaluation?.status==='available'&&view.evaluation.result.windows.h24.status==='mature'});verified++;
  }
  const runs=ids.filter(id=>entries.has(id)).map(id=>entries.get(id)).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at)||b.run_id.localeCompare(a.run_id));
  const latest=runs[0],valid=runs.filter(x=>x.status==='valid'&&x.reason===null).sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at))[0];
  const index={latest_run_id:valid?.run_id??null,latest_attempt:latest?{run_id:latest.run_id,status:latest.status,created_at:latest.created_at,reason:latest.reason}:null};
  const summary={total_runs:ids.length,verified_mature_runs:runs.filter(x=>x.mature_24h&&!x.verification_error).length,valid_runs:runs.filter(x=>x.status==='valid').length,late_runs:runs.filter(x=>x.status==='late').length,failed_runs:runs.filter(x=>['failed','invalid'].includes(x.status)).length};
  const result={summary,schema:'MFV:PROJECTIONS:v1',updated_at:new Date().toISOString(),latest_run_id:index.latest_run_id,latest_attempt:index.latest_attempt,runs};
  await guard();await atomic(dataRoot,head,result);return{verified,total:runs.length};
 }
 async function page(cursor=0){check(Number.isSafeInteger(cursor)&&cursor>=0,'CURSOR_INVALID');const value=await readJson(dataRoot,head);return{schema:'MFV:M1_INDEX:v1',checked_at:value.updated_at,latest_run_id:value.latest_run_id,latest_attempt:value.latest_attempt,summary:value.summary,runs:value.runs.slice(cursor,cursor+30).map(({projection,verification_error,verified_at,mature_24h,...x})=>x),page_offset:cursor,next_cursor:cursor+30<value.runs.length?cursor+30:null,verified_at:value.updated_at};}
 const cache=new Map();
 async function run(id){const index=await readJson(dataRoot,head);const row=index.runs.find(x=>x.run_id===id);check(row?.projection&&!row.verification_error,'RUN_UNAVAILABLE');const ref=row.projection;check(/^m1-projections\/views\/[a-f0-9]{64}\.json$/.test(ref.file),'PROJECTION_REF_INVALID');const bytes=await readBytes(dataRoot,path.join(dataRoot,ref.file));check(digest(bytes)===ref.sha256,'PROJECTION_HASH_MISMATCH');let saved=cache.get(ref.sha256);if(!saved||clock()-saved.verifiedAt>=ttlMs){const value=reader?await reader.readRun(id):JSON.parse(bytes);check(value.hashes.forecast_sha256===JSON.parse(bytes).hashes.forecast_sha256,'ORIGINAL_FORECAST_CHANGED');saved={value,verifiedAt:clock()};cache.set(ref.sha256,saved);while(cache.size>8)cache.delete(cache.keys().next().value);}return saved.value;}
 return{update,page,run};
}
