import fs from 'node:fs/promises';import path from 'node:path';import net from 'node:net';import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';
import {processIdentity} from './m1-mutex.mjs';import {readJson,atomic,exists,check,safePath} from './m1-files.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function health(port){try{const response=await fetch(`http://127.0.0.1:${port}/health`,{signal:AbortSignal.timeout(1000)});return response.ok?await response.json():null;}catch{return null;}}
// Only a refused TCP connection proves that this endpoint has no listener.
// HTTP status, malformed responses and timeouts say nothing about occupancy.
async function listener(port){return new Promise(resolve=>{
 const socket=net.createConnection({host:'127.0.0.1',port});
 const finish=state=>{socket.destroy();resolve(state);};
 socket.once('connect',()=>finish('occupied'));
 socket.once('error',error=>finish(error.code==='ECONNREFUSED'?'vacant':'unknown'));
 socket.setTimeout(1000,()=>finish('unknown'));
});}
export async function serviceStatus({runtimeHome,port}){
 const file=path.join(runtimeHome,'service/owner.json'),owner=await exists(file)?await readJson(runtimeHome,file):null,occupancy=await listener(port);
 if(!owner)return{status:occupancy==='occupied'?'unknown_listener':occupancy==='vacant'?'not_started':'listener_unverified',owner:null};
 const identity=processIdentity(owner.pid);if(identity&&identity!==owner.identity)return{status:'identity_conflict',owner};
 if(identity){const response=await health(port);return{status:response?.owner_token===owner.token&&response?.release_id===owner.release_id?'healthy':'unhealthy',owner};}
 return{status:occupancy==='occupied'?'unknown_listener':occupancy==='vacant'?'exited':'listener_unverified',owner};
}
async function startUnlocked({runtimeHome,port,releaseId,paused=true,automatic=false}){
 if(paused)return{status:'paused'};const state=await serviceStatus({runtimeHome,port});if(state.status==='healthy')return state;
 check(['not_started','exited'].includes(state.status),'SERVICE_OWNER_OR_PORT_CONFLICT');
 const code=path.join(runtimeHome,'releases',releaseId);await safePath(runtimeHome,code);
 const budgetFile=path.join(runtimeHome,'service/restarts.json'),history=await exists(budgetFile)?await readJson(runtimeHome,budgetFile):[],now=Date.now(),recent=history.filter(x=>now-x.at<1800000);
 if(automatic&&recent.length>=3)return{status:'restart_budget_exhausted'};
 await atomic(runtimeHome,budgetFile,[...recent,{at:now,release_id:releaseId,automatic}]);
 const token=randomUUID(),dir=path.join(runtimeHome,'service/logs',token);await fs.mkdir(dir,{recursive:true});const out=await fs.open(path.join(dir,'stdout.log'),'wx'),err=await fs.open(path.join(dir,'stderr.log'),'wx');let child;
 try{child=spawn(process.execPath,['--import','tsx','scripts/m1-entry.mjs','serve',runtimeHome,releaseId],{cwd:code,env:{...process.env,MFV_RUNTIME_HOME:runtimeHome,MFV_SERVICE_TOKEN:token},detached:true,stdio:['ignore',out.fd,err.fd]});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});}finally{await out.close();await err.close();}
 const identity=processIdentity(child.pid);check(identity,'SERVICE_IDENTITY_UNAVAILABLE');const owner={schema:'MFV:SERVICE_OWNER:v1',pid:child.pid,identity,token,release_id:releaseId,started_at:new Date().toISOString()};await atomic(runtimeHome,path.join(runtimeHome,'service/owner.json'),owner);child.unref();
 for(let i=0;i<20;i++){const status=await serviceStatus({runtimeHome,port});if(status.status==='healthy')return status;if(status.status==='exited')return{status:'start_failed',owner};await delay(250);}
 return{status:'start_unconfirmed',owner};
}
async function stopUnlocked({runtimeHome,port}){
 const state=await serviceStatus({runtimeHome,port});if(['not_started','exited'].includes(state.status))return{status:'stopped'};
 check(['healthy','unhealthy'].includes(state.status)&&processIdentity(state.owner.pid)===state.owner.identity,'SERVICE_IDENTITY_UNKNOWN');
 process.kill(state.owner.pid,'SIGTERM');for(let i=0;i<20;i++){if(!processIdentity(state.owner.pid))return{status:'stopped'};await delay(100);}return{status:'stop_unconfirmed'};
}

async function control(runtimeHome,action){
 await safePath(runtimeHome,runtimeHome);const directory=path.join(runtimeHome,'service/control.lock');await fs.mkdir(path.dirname(directory),{recursive:true});try{await fs.mkdir(directory);}catch(e){if(e.code==='EEXIST')return{status:'control_busy'};throw e;}
 const token=randomUUID();await atomic(runtimeHome,path.join(directory,'owner.json'),{token,pid:process.pid});try{return await action();}finally{const owner=await readJson(runtimeHome,path.join(directory,'owner.json'));check(owner.token===token,'SERVICE_CONTROL_OWNER_CHANGED');check((await fs.readdir(directory)).join(',')==='owner.json','SERVICE_CONTROL_CONTENTS_CHANGED');await fs.unlink(path.join(directory,'owner.json'));await fs.rmdir(directory);}
}
export const startService=options=>control(options.runtimeHome,()=>startUnlocked(options));
export const stopService=options=>control(options.runtimeHome,()=>stopUnlocked(options));
