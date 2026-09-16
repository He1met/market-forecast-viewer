import fs from 'node:fs/promises';
import path from 'node:path';
import {safePath,check,exists,readJson,atomic} from './m1-files.mjs';
export function capacityPolicy(value={}) {
 const policy={reserve_bytes:2*1024**3,production_floor_bytes:256*1024**2,...value};
 check(Object.keys(policy).every(k=>['reserve_bytes','production_floor_bytes'].includes(k))&&Object.values(policy).every(x=>Number.isSafeInteger(x)&&x>0)&&policy.reserve_bytes>=policy.production_floor_bytes,'CAPACITY_CONFIG_INVALID');
 return policy;
}
// Filesystem availability is shared with other applications. It is not the size
// or growth of this project's archive, nor a guarantee that a future write succeeds.
export async function capacitySnapshot(root,{policy={},statfs=p=>fs.statfs(p,{bigint:true}),now=Date.now()}={}) {
 const limits=capacityPolicy(policy);await safePath(root,root);
 try {
  const s=await statfs(root),values=[s.bsize,s.blocks,s.bfree,s.bavail];
  check(values.every(x=>typeof x==='bigint'&&x>=0n)&&s.bsize>0n&&s.bfree<=s.blocks&&s.bavail<=s.bfree,'CAPACITY_STAT_INVALID');
  const total=s.blocks*s.bsize,free=s.bavail*s.bsize,used=(s.blocks-s.bfree)*s.bsize;
  check([total,free,used].every(x=>x<=BigInt(Number.MAX_SAFE_INTEGER)),'CAPACITY_STAT_OVERFLOW');
  const status=free<BigInt(limits.production_floor_bytes)?'critical':free<BigInt(limits.reserve_bytes)?'low':'ok';
  return{schema:'MFV:CAPACITY:v1',observed_at:new Date(now).toISOString(),status,filesystem_device:String((await fs.stat(root)).dev),total_bytes:Number(total),available_bytes:Number(free),filesystem_used_bytes:Number(used),policy:limits,production_write:status==='critical'?'blocked':'permitted_by_capacity_check',optional_work:status==='ok'?'allowed':'blocked'};
 } catch(e) {return{schema:'MFV:CAPACITY:v1',observed_at:new Date(now).toISOString(),status:'unknown',reason:e.code??e.message,policy:limits,production_write:'unknown',optional_work:'blocked'};}
}
export function requireCapacity(snapshot,kind='optional') {
 check(['optional','production'].includes(kind),'CAPACITY_WORK_KIND');
 check(kind==='production'?snapshot.production_write==='permitted_by_capacity_check':snapshot.optional_work==='allowed',snapshot.status==='unknown'?'CAPACITY_UNKNOWN':kind==='production'?'CAPACITY_PRODUCTION_LOW':'CAPACITY_RESERVE_LOW');
}
// Caller holds the business mutex. Save one baseline per UTC day; never infer
// archive growth from global free space, and never overwrite an earlier day.
export async function observeCapacity({dataRoot,guard,policy,now=Date.now(),statfs}) {
 const snapshot=await capacitySnapshot(dataRoot,{policy,now,statfs}),file=path.join(dataRoot,'m1-control/capacity.json');
 await guard();const prior=await exists(file)?await readJson(dataRoot,file):null;
 const day=snapshot.observed_at.slice(0,10),previous=prior?.baseline;
 check(!prior||Date.parse(snapshot.observed_at)>=Date.parse(prior.current.observed_at),'CAPACITY_TIME_REVERSED');
 const valid=snapshot.status!=='unknown';let baseline=previous??null,change=prior?.daily_change??null;
 if(valid&&(!previous||previous.observed_at.slice(0,10)!==day)){
  change=previous&&previous.filesystem_device===snapshot.filesystem_device&&previous.total_bytes===snapshot.total_bytes?{from:previous.observed_at,to:snapshot.observed_at,filesystem_used_delta_bytes:snapshot.filesystem_used_bytes-previous.filesystem_used_bytes,scope:'whole_filesystem_not_project'}:null;
  baseline=snapshot;
 }
 const state={schema:'MFV:CAPACITY_STATE:v1',current:snapshot,baseline,daily_change:change};await guard();await atomic(dataRoot,file,state);return state;
}
