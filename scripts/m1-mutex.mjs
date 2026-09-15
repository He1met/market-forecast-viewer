import net from 'node:net';import fs from 'node:fs/promises';import path from 'node:path';import{hostname}from'node:os';import{randomUUID}from'node:crypto';import{execFileSync,spawn}from'node:child_process';
import{atomic,writeOnce,readJson,exists,check}from'./m1-files.mjs';
export function groupAlive(pgid){check(Number.isSafeInteger(pgid)&&pgid>1,'PROCESS_GROUP_INVALID');try{process.kill(-pgid,0);return true;}catch(e){return e.code!=='ESRCH';}}
export function processIdentity(pid){try{return execFileSync('ps',['-p',String(pid),'-o','lstart=,pgid=,comm='],{encoding:'utf8'}).trim()||null;}catch{return null;}}
export async function businessMutex({dataRoot,port,releaseId,task='forecast'}){
 const token=randomUUID(),dir=path.join(dataRoot,'m1-control');await fs.mkdir(dir,{recursive:true});const ownerFile=path.join(dir,'owner.json');
 const server=net.createServer(socket=>{socket.end(JSON.stringify({schema:'MFV:MUTEX:v1',token,data_root:dataRoot,release_id:releaseId,pid:process.pid})+'\n');});
 try{await new Promise((yes,no)=>{server.once('error',no);server.listen({host:'127.0.0.1',port,exclusive:true},yes);});}catch(e){if(e.code!=='EADDRINUSE')throw e;let reply=null;try{reply=await new Promise((yes,no)=>{const s=net.connect({host:'127.0.0.1',port});let text='';s.setTimeout(500,()=>{s.destroy();no(Error('TIMEOUT'));});s.on('error',no);s.on('data',b=>{text+=b;if(text.length>4096){s.destroy();no(Error('OVERSIZE'));}});s.on('end',()=>{try{yes(JSON.parse(text));}catch(e){no(e);}});});}catch{}const saved=await exists(ownerFile)?await readJson(dataRoot,ownerFile).catch(()=>null):null;return{status:reply?.schema==='MFV:MUTEX:v1'&&reply.data_root===dataRoot&&saved?.token===reply.token&&saved.pid===reply.pid&&saved.identity===processIdentity(reply.pid)?'BUSY':'MUTEX_CONFLICT'};}
 try{const previous=await exists(ownerFile)?await readJson(dataRoot,ownerFile):null;
 if(previous?.child&&groupAlive(previous.child.pid)){
  if(previous.identity===processIdentity(previous.pid)){await new Promise(r=>server.close(r));return{status:'ORPHAN_PARENT_STILL_ALIVE'};}
  const same=previous.schema==='MFV:MUTEX_OWNER:v1'&&previous.data_root===dataRoot&&previous.host===hostname()&&processIdentity(previous.child.pid)===previous.child.identity;
  if(!same){await new Promise(r=>server.close(r));return{status:'ORPHAN_IDENTITY_UNKNOWN'};}
  process.kill(-previous.child.pid,'SIGTERM');await new Promise(r=>setTimeout(r,2000));
  if(groupAlive(previous.child.pid)){
   if(processIdentity(previous.child.pid)!==previous.child.identity){await new Promise(r=>server.close(r));return{status:'ORPHAN_IDENTITY_UNKNOWN'};}
   process.kill(-previous.child.pid,'SIGKILL');
   for(let i=0;i<20&&groupAlive(previous.child.pid);i++)await new Promise(r=>setTimeout(r,100));
   if(groupAlive(previous.child.pid)){await new Promise(r=>server.close(r));return{status:'ORPHAN_TERMINATION_UNCONFIRMED'};}
  }
  await writeOnce(dataRoot,path.join(dir,'recoveries',randomUUID()+'.json'),{at:new Date().toISOString(),previous,action:'terminated_proven_orphan',success:false});
 }
 let owner={schema:'MFV:MUTEX_OWNER:v1',token,pid:process.pid,identity:processIdentity(process.pid),host:hostname(),data_root:dataRoot,release_id:releaseId,task,started_at:new Date().toISOString(),child:null};await atomic(dataRoot,ownerFile,owner);
 let closed=false;
 const guard=async()=>{check(!closed&&server.listening,'MUTEX_NOT_HELD');const found=await readJson(dataRoot,ownerFile);check(found.token===token&&found.identity===processIdentity(process.pid),'MUTEX_OWNER_CHANGED');};
 const setChild=async child=>{await guard();owner={...owner,child};await atomic(dataRoot,ownerFile,owner);};
 const close=async()=>{await guard();if(owner.child&&groupAlive(owner.child.pid))throw Error('CHILD_STILL_RUNNING');await atomic(dataRoot,ownerFile,{...owner,completed_at:new Date().toISOString(),child:null});closed=true;await new Promise(r=>server.close(r));};
 return{status:'ACQUIRED',token,guard,setChild,close};
 }catch(error){if(server.listening)await new Promise(r=>server.close(r));throw error;}
}
export async function managedProcess(command,args,{mutex,cwd,env,stdoutFile,stderrFile,timeoutMs,signal,input='',onStarted=async()=>{}}={}){
 await mutex.guard();check(Number.isFinite(timeoutMs)&&timeoutMs>0,'PROCESS_DEADLINE_REQUIRED');
 const out=await fs.open(stdoutFile,'wx',0o600);let err;
 try{err=await fs.open(stderrFile,'wx',0o600);return await new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,detached:true,stdio:['pipe',out.fd,err.fd]});let timer,killTimer,identity,timedOut=false,started=Promise.resolve(),failure;
  const kill=sig=>{if(identity&&groupAlive(child.pid)&&(!processIdentity(child.pid)||processIdentity(child.pid)===identity)){try{process.kill(-child.pid,sig);}catch(e){if(e.code!=='ESRCH')failure=e;}}};
  const stop=()=>{kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),2000);};
  child.stdin.on('error',e=>{if(e.code!=='EPIPE')failure=e;});
  child.once('spawn',()=>{identity=processIdentity(child.pid);started=(async()=>{check(identity,'PROCESS_IDENTITY_UNAVAILABLE');const execution={pid:child.pid,identity,command,started_at:new Date().toISOString()};await mutex.setChild(execution);await onStarted(execution);timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)stop();else child.stdin.end(input);})().catch(e=>{failure=e;stop();});});
  child.once('error',e=>{failure=e;});child.once('close',async(code,signalCode)=>{try{await started;if(Number.isSafeInteger(child.pid)&&groupAlive(child.pid)){kill('SIGTERM');await new Promise(r=>setTimeout(r,500));if(groupAlive(child.pid))kill('SIGKILL');await new Promise(r=>setTimeout(r,100));check(!groupAlive(child.pid),'MANAGED_GROUP_STILL_RUNNING');}clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',stop);await mutex.setChild(null);if(failure)reject(failure);else resolve({code,signal:signalCode,timedOut,pid:child.pid,identity});}catch(e){reject(e);}});
 });}finally{await out.close();await err?.close();}
}
