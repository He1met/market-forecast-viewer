import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,readBytes,readJson,writeOnce,atomic,check,safePath,exists,within} from './m1-files.mjs';
import {businessMutex} from './m1-mutex.mjs';
const roots=['forecast-runs','data-source','m1-candidates','m1-outcomes','m1-runtime','m1-control','m1-slots','m1-observations','m1-task-status','m1-cases','m1-learning','m1-experiments','m1-derivatives','m1-calendar','m1-projections','m1-closures','m1-closure-implementations','m1-preparation-proofs'];
// stat.dev identifies a filesystem, not a physical disk or independent failure
// domain (two APFS volumes on one disk can have different device numbers).
export function backupFaultDomain(sourceDevice,targetDevice){return{
 kind:String(sourceDevice)===String(targetDevice)?'local-recovery':'unverified-target',
 fault_domain_verified:false,
 fault_domain_reason:String(sourceDevice)===String(targetDevice)?'same_filesystem':'physical_device_or_approved_remote_evidence_missing',
};}
async function files(root,dir='',budget=()=>{},visit=async()=>{}) {
 budget();
 const result=[],present=await exists(path.join(root,dir));budget();if(!present)return result;
 await safePath(root,path.join(root,dir));budget();
 const entries=await fs.readdir(path.join(root,dir),{withFileTypes:true});budget();
 for(const e of entries) {
  budget();await visit();budget();
  check(!e.isSymbolicLink(),'BACKUP_SYMLINK');const name=path.posix.join(dir,e.name);
  if(e.isDirectory())result.push(...await files(root,name,budget,visit));else if(e.isFile())result.push(name);else throw Error('BACKUP_FILE_TYPE');
 }return result.sort();
}
export async function verifyBackupTarget({dataRoot,runtimeHome,target,deviceId,minimumFreeBytes=0}) {
 check(typeof target==='string'&&path.isAbsolute(target),'BACKUP_ABSOLUTE_TARGET');
 await safePath(target,target);const stat=await fs.stat(target);check(stat.isDirectory(),'BACKUP_TARGET_MISSING');
 for(const root of [dataRoot,runtimeHome].filter(Boolean))check(!within(root,target)&&!within(target,root),'BACKUP_TARGET_OVERLAPS_SOURCE');
 if(deviceId!==undefined&&deviceId!==null)check(String(stat.dev)===String(deviceId),'BACKUP_DEVICE_MISMATCH');
 check(Number.isSafeInteger(minimumFreeBytes)&&minimumFreeBytes>=0,'BACKUP_SPACE_CONFIG_INVALID');
 const space=await fs.statfs(target);check(space.bavail*space.bsize>=minimumFreeBytes,'BACKUP_FREE_SPACE_LOW');return stat;
}
// This lock covers copying after the short business capture. Unknown abandoned locks
// require inspection; neither age nor a dead PID authorizes removing another owner.
async function backupLock(target,work) {
 const dir=path.join(target,'.backup-lock'),token=randomUUID();
 try{await fs.mkdir(dir);}catch(e){if(e.code==='EEXIST')return{status:'skipped',reason:'BACKUP_BUSY'};throw e;}
 await writeOnce(target,path.join(dir,'owner.json'),{token,pid:process.pid,started_at:new Date().toISOString()});
 const guard=async()=>{const owner=await readJson(target,path.join(dir,'owner.json'));check(owner.token===token,'BACKUP_OWNER_CHANGED');};
 try{return await work(guard);}finally{const owner=await readJson(target,path.join(dir,'owner.json'));check(owner.token===token,'BACKUP_OWNER_CHANGED');check((await fs.readdir(dir)).sort().join(',')==='owner.json','BACKUP_LOCK_CONTENTS_CHANGED');await fs.unlink(path.join(dir,'owner.json'));await fs.rmdir(dir);}
}
// Every file keeps safe-path validation and two byte/hash reads. The business
// mutex stays held across both passes; expensive identity checks are bounded by
// 32 files or 250 ms between checks, plus every phase boundary. A slow await can
// exceed that scheduling interval; budget checks after it reject the snapshot.
export async function captureSnapshot({dataRoot,runtimeHome,mutex,maxSnapshotMs=15000,maxBytes=1024**3}) {
 const start=performance.now(),captured=[],sources=[];
 const diagnostics={phase:'scan',source_files:0,captured_files:0,verified_files:0,total_bytes:0,guard_checks:0,max_batch_reserved_bytes:0,max_inflight_files:0,phase_ms:{},work_ms:{guard:0,metadata:0,safe_read_hash:0},phase_work_ms:{}};
 let phaseStart=start,lastGuard=start,sinceGuard=0;
 const budget=()=>check(performance.now()-start<maxSnapshotMs,'BACKUP_SNAPSHOT_DEADLINE');
 // Batch wall times do not sum per-file concurrent timings. Measurement stays
 // inside the unchanged deadline; phase totals additionally include traversal/bookkeeping.
 const measured=(kind,at)=>{const elapsed=performance.now()-at;diagnostics.work_ms[kind]+=elapsed;const bucket=diagnostics.phase_work_ms[diagnostics.phase]??={guard:0,metadata:0,safe_read_hash:0};bucket[kind]+=elapsed;};
 const guard=async(force=false,upcoming=1)=>{budget();if(force||sinceGuard+upcoming>32||performance.now()-lastGuard>=250){const at=performance.now();try{await mutex.guard();diagnostics.guard_checks++;}finally{measured('guard',at);}budget();lastGuard=performance.now();sinceGuard=0;}};
 const phase=name=>{const now=performance.now();diagnostics.phase_ms[diagnostics.phase]=now-phaseStart;diagnostics.phase=name;phaseStart=now;};
 try {
  await guard(true);
  for(const dir of roots)for(const name of await files(dataRoot,dir,budget,async()=>{await guard();sinceGuard++;}))sources.push({root:dataRoot,name,archive:name});
  if(runtimeHome)for(const name of await files(runtimeHome,'',budget,async()=>{await guard();sinceGuard++;}))sources.push({root:runtimeHome,name,archive:'runtime-snapshot/'+name});
  diagnostics.source_files=sources.length;await guard(true);phase('capture');
  // At most eight metadata requests or reads and 256 MiB of declared source bytes are in flight. Drain all of them on failure before the
  // mutex can be released. Every file still validates its complete path twice.
  const readBatch=async (list,startIndex)=>{
   const batch=[];let reserved=0;
   // Metadata is also bounded and drained before failure. No payload read starts
   // until every selected file has a validated size and the batch is reserved.
   const metadataAt=performance.now();
   const sized=await Promise.allSettled(list.slice(startIndex,startIndex+8).map(async source=>{
    budget();const stat=await fs.stat(path.join(source.root,source.name));budget();
    check(stat.isFile()&&stat.size<=256*1024*1024,'FILE_SIZE_OR_TYPE');return{source,limit:stat.size};
   }));
   measured('metadata',metadataAt);budget();const sizeFailure=sized.find(x=>x.status==='rejected');if(sizeFailure)throw sizeFailure.reason;
   for(const entry of sized){const item=entry.value;if(batch.length&&reserved+item.limit>256*1024*1024)break;batch.push(item);reserved+=item.limit;}
   // Metadata can cross the time-based identity boundary before payload IO.
   await guard(false,batch.length);
   diagnostics.max_batch_reserved_bytes=Math.max(diagnostics.max_batch_reserved_bytes,reserved);
   diagnostics.max_inflight_files=Math.max(diagnostics.max_inflight_files,batch.length);
   const readAt=performance.now();
   const settled=await Promise.allSettled(batch.map(async ({source,limit})=>{
    budget();const bytes=await readBytes(source.root,path.join(source.root,source.name),limit);budget();
    check(bytes.length<=limit,'BACKUP_SOURCE_CHANGED');const sha256=digest(bytes);budget();return{...source,bytes,sha256};
   }));
   measured('safe_read_hash',readAt);budget();const failed=settled.find(x=>x.status==='rejected');if(failed)throw failed.reason;
   return settled.map(x=>x.value);
  };
  for(let i=0;i<sources.length;){
   await guard(false,Math.min(8,sources.length-i));const batch=await readBatch(sources,i);
   for(const source of batch){diagnostics.total_bytes+=source.bytes.length;check(diagnostics.total_bytes<=maxBytes,'BACKUP_SNAPSHOT_SIZE');captured.push(source);diagnostics.captured_files++;sinceGuard++;}
   i+=batch.length;budget();
  }
  await guard(true);phase('verify');
  for(let i=0;i<captured.length;){
   await guard(false,Math.min(8,captured.length-i));const batch=await readBatch(captured,i);
   for(let j=0;j<batch.length;j++){check(batch[j].sha256===captured[i+j].sha256,'BACKUP_SOURCE_CHANGED');diagnostics.verified_files++;sinceGuard++;}
   i+=batch.length;budget();
  }
  await guard(true);phase('completed');diagnostics.elapsed_ms=performance.now()-start;
  return{captured,size:diagnostics.total_bytes,diagnostics};
 }catch(error){diagnostics.phase_ms[diagnostics.phase]=performance.now()-phaseStart;diagnostics.elapsed_ms=performance.now()-start;error.snapshot_diagnostics={...diagnostics};throw error;}
}
export async function backup({dataRoot,runtimeHome,target,deviceId,minimumFreeBytes=0,port,releaseId,slotKey,maxSnapshotMs=15000,maxBytes=1024**3}) {
 const targetStat=await verifyBackupTarget({dataRoot,runtimeHome,target,deviceId,minimumFreeBytes}),sourceStat=await fs.stat(dataRoot);
 return backupLock(target,async backupGuard=>{
  const slotFile=slotKey?path.join(target,'slots',digest(slotKey)+'.json'):null;if(slotFile&&await exists(slotFile)){const prior=await readJson(target,slotFile);const manifest=await readJson(target,path.join(target,'manifests',prior.id+'.json'));return{status:'completed',already_completed:true,manifest};}
  const mutex=await businessMutex({dataRoot,port,releaseId,task:'backup'});if(mutex.status!=='ACQUIRED')return{status:'skipped',reason:mutex.status};
  let snapshot;
  try {snapshot=await captureSnapshot({dataRoot,runtimeHome,mutex,maxSnapshotMs,maxBytes});}
  finally{await mutex.close();}
  const {captured,size,diagnostics}=snapshot;
  await verifyBackupTarget({dataRoot,runtimeHome,target,deviceId:targetStat.dev,minimumFreeBytes:minimumFreeBytes+size});
  const id=new Date().toISOString().replace(/[-:.]/g,'')+'-'+randomUUID();
  const manifest={schema:'MFV:BACKUP:v1',id,release_id:releaseId,captured_at:new Date().toISOString(),device_id:String(targetStat.dev),...backupFaultDomain(sourceStat.dev,targetStat.dev),runtime_included:Boolean(runtimeHome),snapshot_diagnostics:diagnostics,files:captured.map(({archive,sha256,bytes})=>({name:archive,sha256,bytes:bytes.length})),total_bytes:size};
  for(const entry of captured){const object=path.join(target,'objects',entry.sha256);if(!await exists(object)){const temp=path.join(target,'staging',randomUUID());await writeOnce(target,temp,entry.bytes);check(digest(await readBytes(target,temp,256*1024*1024))===entry.sha256,'BACKUP_OBJECT_MISMATCH');await fs.mkdir(path.dirname(object),{recursive:true});await fs.rename(temp,object);}check(digest(await readBytes(target,object,256*1024*1024))===entry.sha256,'BACKUP_OBJECT_MISMATCH');}
  await backupGuard();await writeOnce(target,path.join(target,'manifests',id+'.json'),manifest);if(slotFile){await backupGuard();await writeOnce(target,slotFile,{id,slot_key:slotKey});}return{status:'completed',manifest};
 });
}
function validateManifest(m){check(m.schema==='MFV:BACKUP:v1'&&typeof m.id==='string'&&Array.isArray(m.files),'BACKUP_MANIFEST_INVALID');const names=new Set();for(const e of m.files){check(typeof e.name==='string'&&e.name&&!path.isAbsolute(e.name)&&!e.name.includes('\\')&&!e.name.split('/').some(p=>!p||p==='..'||p==='.')&&!names.has(e.name),'RESTORE_PATH_ESCAPE');check(/^[a-f0-9]{64}$/.test(e.sha256)&&Number.isSafeInteger(e.bytes)&&e.bytes>=0,'RESTORE_ENTRY_INVALID');names.add(e.name);}}
const inactive=name=>/(?:^|\/)(?:owner\.json|writer\.lock|current\.json|activation\.json|configuration\.json|installation\.local\.json)$/.test(name)||name.startsWith('m1-task-status/');
export async function restore({target,manifestFile,destination,verify,resume=false,maxMs=120000,maxFiles=Infinity}) {
 await safePath(target,target);return backupLock(target,async()=>{
  const raw=await readBytes(target,manifestFile),m=JSON.parse(raw);validateManifest(m);const manifestSha=digest(raw),stateFile=path.join(destination,'restore-state.json');
  let state;if(await exists(destination)){check(resume,'RESTORE_NEW_DIRECTORY_REQUIRED');state=await readJson(destination,stateFile);check(state.manifest_sha256===manifestSha&&state.backup_id===m.id,'RESTORE_RESUME_MISMATCH');if(state.status==='completed')return readJson(destination,path.join(destination,'restore-receipt.json'));}else{await fs.mkdir(destination,{mode:0o700});state={schema:'MFV:RESTORE_STATE:v1',backup_id:m.id,manifest_sha256:manifestSha,cursor:0,restored:[],skipped:[],status:'incomplete'};await atomic(destination,stateFile,state);}
  const start=performance.now();let count=0;
  for(;state.cursor<m.files.length;state.cursor++){
   if(performance.now()-start>=maxMs||count>=maxFiles){await atomic(destination,stateFile,state);return{status:'incomplete',backup_id:m.id,cursor:state.cursor,activation_restored:false};}
   const entry=m.files[state.cursor],bytes=await readBytes(target,path.join(target,'objects',entry.sha256),256*1024*1024);check(digest(bytes)===entry.sha256&&bytes.length===entry.bytes,'RESTORE_HASH_MISMATCH');
   if(inactive(entry.name)){state.skipped.push(entry.name);}else{const file=path.join(destination,entry.name);if(await exists(file))check(digest(await readBytes(destination,file,256*1024*1024))===entry.sha256,'RESTORE_DESTINATION_CHANGED');else await writeOnce(destination,file,bytes);state.restored.push(entry.name);}count++;
   // Persist after each object, including skips. An interruption can only replay the
   // current exact object, never overwrite a modified destination.
   await atomic(destination,stateFile,{...state,cursor:state.cursor+1});
  }
  check(typeof verify==='function','RESTORE_REPLAY_REQUIRED');const replay=await verify(destination);if(replay?.status==='incomplete'){await atomic(destination,stateFile,{...state,status:'incomplete'});return{status:'incomplete',backup_id:m.id,cursor:state.cursor,replay,activation_restored:false};}check(replay?.passed===true,'RESTORE_REPLAY_FAILED');
  const receipt={schema:'MFV:RESTORE:v1',backup_id:m.id,manifest_sha256:manifestSha,restored:state.restored,skipped:state.skipped,replay,completed_at:new Date().toISOString(),activation_restored:false};
  const receiptFile=path.join(destination,'restore-receipt.json');if(!await exists(receiptFile))await writeOnce(destination,receiptFile,receipt);await atomic(destination,stateFile,{...state,status:'completed'});return receipt;
 });
}
