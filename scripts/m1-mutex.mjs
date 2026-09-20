import net from 'node:net';import fs from 'node:fs/promises';import path from 'node:path';import{hostname}from'node:os';import{randomUUID}from'node:crypto';import{execFileSync,spawn}from'node:child_process';
import{atomic,writeOnce,readJson,exists,check}from'./m1-files.mjs';
export function groupAlive(pgid){check(Number.isSafeInteger(pgid)&&pgid>1,'PROCESS_GROUP_INVALID');try{process.kill(-pgid,0);return true;}catch(e){return e.code!=='ESRCH';}}
export function processIdentity(pid){try{return execFileSync('ps',['-p',String(pid),'-o','lstart=,pgid=,comm='],{encoding:'utf8'}).trim()||null;}catch{return null;}}
// Linux self guards read kernel identity afresh, without spawning ps per batch.
// Cross-process identity and orphan recovery deliberately keep processIdentity.
export function parseSelfProcStat(text,pid){
 check(typeof text==='string'&&Buffer.byteLength(text)<=4096,'MUTEX_PROC_STAT_INVALID');
 const match=/^([1-9]\d*) \(([\s\S]+)\) ([A-Za-z]) ([^\n]+)\n?$/.exec(text);
 check(match&&match[1]===String(pid)&&'RSDTtIWKP'.includes(match[3]),'MUTEX_PROC_STAT_INVALID');
 const fields=match[4].trim().split(/\s+/);
 check(fields.length>=49&&fields.length<=64&&fields.every(x=>/^-?(?:0|[1-9]\d*)$/.test(x))&&/^[1-9]\d*$/.test(fields[1])&&/^[1-9]\d*$/.test(fields[18]),'MUTEX_PROC_STAT_INVALID');
 return{pid:match[1],pgrp:BigInt(fields[1]).toString(),start_ticks:BigInt(fields[18]).toString(),comm:match[2]};
}
export async function linuxSelfIdentity(pid){
 const base='/proc/'+pid,results=await Promise.allSettled([fs.readFile(base+'/stat','utf8'),fs.readlink(base+'/exe'),fs.stat(base+'/exe',{bigint:true})]);
 const identity=results[0].status==='fulfilled'?parseSelfProcStat(results[0].value,pid):null;
 if(results[1].status==='fulfilled')check(typeof results[1].value==='string'&&path.isAbsolute(results[1].value)&&results[1].value.length<=4096,'MUTEX_PROC_EXE_INVALID');
 if(results[2].status==='fulfilled')check(results[2].value.isFile(),'MUTEX_PROC_EXE_INVALID');
 const failed=results.find(x=>x.status==='rejected');if(failed)throw failed.reason;
 const exe=results[1].value,stat=results[2].value;
 return{...identity,exe,exe_device:stat.dev.toString(),exe_inode:stat.ino.toString()};
}
// Dependency injection is for isolated tests. businessMutex exposes no switch;
// its platform and readers always come from this process and the OS.
export async function selfIdentityGuard(identity,{platform=process.platform,pid=process.pid,readProc=linuxSelfIdentity,readPs=processIdentity}={}){
 check(typeof identity==='string'&&identity.trim().length>0,'PROCESS_IDENTITY_UNAVAILABLE');
 let baseline=null;
 if(platform==='linux')try{baseline=await readProc(pid);check(baseline&&typeof baseline==='object','MUTEX_PROC_STAT_INVALID');}catch(error){if(!['ENOENT','ENOTDIR','ENOSYS','EACCES','EPERM'].includes(error.code))throw error;}
 check(readPs(pid)===identity,'MUTEX_SELF_IDENTITY_CHANGED');
 if(baseline){const expected=JSON.stringify(baseline);return{kind:'linux-proc',check:async()=>{check(JSON.stringify(await readProc(pid))===expected,'MUTEX_SELF_IDENTITY_CHANGED');}};}
 return{kind:'ps',check:async()=>{check(readPs(pid)===identity,'MUTEX_SELF_IDENTITY_CHANGED');}};
}
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
 const identity=processIdentity(process.pid),self=await selfIdentityGuard(identity);
 let owner={schema:'MFV:MUTEX_OWNER:v1',token,pid:process.pid,identity,host:hostname(),data_root:dataRoot,release_id:releaseId,task,started_at:new Date().toISOString(),child:null};await atomic(dataRoot,ownerFile,owner);
 let closed=false;
 const guard=async()=>{check(!closed&&server.listening,'MUTEX_NOT_HELD');const found=await readJson(dataRoot,ownerFile);check(found.token===token&&found.pid===process.pid&&found.identity===identity,'MUTEX_OWNER_CHANGED');await self.check();check(!closed&&server.listening,'MUTEX_NOT_HELD');};
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
