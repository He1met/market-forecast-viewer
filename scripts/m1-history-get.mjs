// Only the two M1 OKX history-candles callers use this bounded GET transport.
// Page validation stays with the callers; failed bytes never become a page.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { safePath } from './m1-files.mjs';

const exec = promisify(execFile);
const once = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2)+'\n', {flag:'wx',mode:0o600});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, reason) => { if (!ok) throw Error(reason); };

export function createHistoryGetter({execute=exec, monotonic=()=>performance.now(), now=()=>new Date().toISOString()}={}) {
 return async function getHistoryPage({url,file,signal,deadline=Infinity,kind}) {
  const u=new URL(url),root=path.dirname(file),name=path.basename(file);
  check(u.origin==='https://www.okx.com'&&u.pathname==='/api/v5/market/history-candles'&&!u.username&&!u.password&&!u.hash,'HISTORY_ENDPOINT_INVALID');
  check(['forecast','outcome'].includes(kind)&&/^page-\d{3}\.json$/.test(name),'HISTORY_REQUEST_INVALID');
  check(deadline===Infinity||Number.isFinite(deadline),'HISTORY_DEADLINE_INVALID');
  const pageDeadline=Math.min(deadline,monotonic()+(kind==='forecast'?35000:30000));
  let requestDeadline=pageDeadline;
  const remaining=()=>requestDeadline-monotonic();
  const guard=()=>{signal?.throwIfAborted();check(remaining()>=1,'HISTORY_PAGE_DEADLINE');};
  guard();await safePath(root,root);
  const parent=path.join(root,'request-attempts',name.slice(0,-5));
  // Never reuse an existing attempt directory or overwrite a prior response.
  await fs.mkdir(path.join(root,'request-attempts'),{recursive:true,mode:0o700});
  await safePath(root,path.join(root,'request-attempts'));
  await fs.mkdir(parent,{mode:0o700});
  for(let attempt=1;attempt<=2;attempt++) {
   if(attempt===2&&kind==='forecast')requestDeadline=Math.min(pageDeadline,deadline-90000);
   guard();
   const dir=path.join(parent,`attempt-00${attempt}`),response=path.join(dir,'response.bin');
   await fs.mkdir(dir,{mode:0o700});await safePath(root,dir);
   const started_at=now();
   await once(path.join(dir,'started.json'),{schema:'MFV:HISTORY_GET_ATTEMPT:v1',kind,attempt,url,started_at,local_only:true,
    page_budget_remaining_ms:remaining(),overall_budget_remaining_ms:Number.isFinite(deadline)?deadline-monotonic():null});
   let result,error,timeoutMs=null,curlSeconds=null,launched=false,requested_at=null;
   try {
    guard();
    if(attempt===2&&kind==='forecast')check(deadline-monotonic()>90000,'HISTORY_MODEL_BUDGET');
    timeoutMs=Math.floor(remaining());curlSeconds=Math.min(kind==='forecast'?30:25,timeoutMs/1000);
    requested_at=now();launched=true;
    result=await execute('curl',['--fail-with-body','--silent','--show-error','--max-time',String(curlSeconds),
     '--output',response,'--write-out','%{http_code}',url],{timeout:timeoutMs,signal,maxBuffer:1024*1024});
   } catch(e) { error=e; }
   let responseEvidence=null;
   try {const stat=await fs.lstat(response);check(stat.isFile()&&!stat.isSymbolicLink(),'HISTORY_RESPONSE_TYPE');const b=await fs.readFile(response);responseEvidence={bytes:b.length,sha256:hash(b)};}
   catch(e){if(e.code!=='ENOENT')throw e;}
   const http_code=String(result?.stdout??error?.stdout??'').trim();
   await once(path.join(dir,'result.json'),{schema:'MFV:HISTORY_GET_RESULT:v1',kind,attempt,url,started_at,completed_at:now(),local_only:true,
    launched,requested_at,timeout_ms:timeoutMs,curl_max_time_seconds:curlSeconds,exit_code:error?(Number.isInteger(error.code)?error.code:null):0,
    signal:error?.signal??null,killed:Boolean(error?.killed),http_code,stderr:String(result?.stderr??error?.stderr??'').slice(0,4000),
    error:error?String(error.message).slice(0,4000):null,response:responseEvidence});
   if(error) {
    if(attempt===1&&error.code===35&&!error.killed&&!error.signal&&!signal?.aborted&&Number.isFinite(deadline)&&remaining()>=1
     &&(kind!=='forecast'||deadline-monotonic()>90000))continue;
    throw error;
   }
   guard();check(http_code==='200','HISTORY_HTTP_FAILED');check(responseEvidence,'HISTORY_RESPONSE_MISSING');
   // A process that ignored cancellation/deadline cannot commit a usable page.
   await fs.copyFile(response,file,fs.constants.COPYFILE_EXCL);
   guard();return {http_code,requested_at};
  }
 };
}
export const getHistoryPage=createHistoryGetter();
