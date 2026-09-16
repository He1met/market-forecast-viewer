import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {atomic,check,exists,readJson,writeOnce} from './m1-files.mjs';
import {businessMutex} from './m1-mutex.mjs';
import {backup,restore} from './m1-backup.mjs';
import {replayRestored} from './m1-restore-replay.mjs';
import {capacitySnapshot,requireCapacity} from './m1-capacity.mjs';

// Independent invocation records are safe without the business lock. Shared
// summaries are updated only after reacquiring it, never during object copying.
export async function backupCycle({codeRoot,config,runtimeHome,releaseId,trigger='manual',taskId=null,threadId=null,
 clock=()=>Date.now(),restoreMaxFiles=2000,restoreMaxMs=90000,verify=destination=>replayRestored({codeRoot,dataRoot:destination})}) {
 check(['manual','scheduled'].includes(trigger),'TRIGGER_INVALID');
 for(const value of [taskId,threadId])check(value===null||(typeof value==='string'&&value.length>0&&value.length<=200),'INVOCATION_ID_INVALID');
 const dataRoot=config.data_root,id=randomUUID(),folder=path.join(dataRoot,'m1-observations',id),started=performance.now();
 const observation={schema:'MFV:OBSERVATION:v1',id,task:'backup',trigger,task_id:taskId,thread_id:threadId,release_id:releaseId,started_at:new Date(clock()).toISOString(),status:'started'};
 await writeOnce(dataRoot,path.join(folder,'started.json'),observation);
 let result={status:'failed',reason:'BACKUP_INCOMPLETE'},savedBackup=null;
 try {
  const capacity=await capacitySnapshot(dataRoot,{policy:config.capacity});requireCapacity(capacity);
  const localDay=new Date(clock()+8*3600000),date=localDay.toISOString().slice(0,10);
  result=await backup({dataRoot,runtimeHome,target:config.backup.target,deviceId:config.backup.device_id,minimumFreeBytes:Math.max(config.backup.minimum_free_bytes??0,capacity.policy.reserve_bytes),port:config.mutex_port,releaseId,slotKey:'daily:'+date});
  if(result.status==='completed'){
   savedBackup=result;
   const target=config.backup.target,checksRoot=path.join(target,'restore-checks'),pending=path.join(checksRoot,'pending.json');
   await fs.mkdir(checksRoot,{recursive:true});
   let state=await exists(pending)?await readJson(target,pending):null;
   if(!state&&localDay.getUTCDay()===0){state={backup_id:result.manifest.id};await writeOnce(target,pending,state);}
   if(state){
    check(typeof state.backup_id==='string'&&/^[a-zA-Z0-9-]+$/.test(state.backup_id),'RESTORE_PENDING_INVALID');
    const destination=path.join(checksRoot,state.backup_id);
    const restored=await restore({target,manifestFile:path.join(target,'manifests',state.backup_id+'.json'),destination,resume:await exists(destination),maxMs:restoreMaxMs,maxFiles:restoreMaxFiles,verify:async root=>{
     const old=process.env.MFV_DATA_ROOT;process.env.MFV_DATA_ROOT=root;
     try{return await verify(root);}finally{if(old===undefined)delete process.env.MFV_DATA_ROOT;else process.env.MFV_DATA_ROOT=old;}
    }});
    const complete=restored.schema==='MFV:RESTORE:v1';
    if(complete)await fs.unlink(pending);
    result={...result,status:complete?'completed':'partial',...(complete?{}:{reason:'RESTORE_CHECK_INCOMPLETE'}),restore_check:restored};
   }
  }
 }catch(error){result={status:'failed',reason:error.message,...(savedBackup?{backup_status:'completed',manifest:savedBackup.manifest}:{})};}
 const final={...observation,...result,backup_id:result.manifest?.id??null,completed_at:new Date(clock()).toISOString(),elapsed_ms:performance.now()-started};
 // A failed/busy summary write does not erase the independently recorded result.
 await writeOnce(dataRoot,path.join(folder,'result.json'),final);
 let mutex;
 try {
  mutex=await businessMutex({dataRoot,port:config.mutex_port,releaseId,task:'backup-status'});
  if(mutex.status!=='ACQUIRED')return {...final,summary_status:mutex.status};
  const file=path.join(dataRoot,'m1-task-status/backup.json');
  const previous=await exists(file)?await readJson(dataRoot,file):null;
  if(!previous||Date.parse(previous.started_at)<=Date.parse(final.started_at)){
   await mutex.guard();await atomic(dataRoot,file,final);
  }
  // Only complete backup + required restore counts as overall success.
  if(final.status==='completed'){
   const successFile=path.join(dataRoot,'m1-task-status/last-backup-success.json'),prior=await exists(successFile)?await readJson(dataRoot,successFile):null;
   if(!prior||Date.parse(prior.started_at)<=Date.parse(final.started_at)){await mutex.guard();await atomic(dataRoot,successFile,final);}
  }
  return {...final,summary_status:'recorded'};
 }catch(error){return {...final,summary_status:'failed',summary_reason:error.message};}
 finally{if(mutex?.status==='ACQUIRED')await mutex.close();}
}
