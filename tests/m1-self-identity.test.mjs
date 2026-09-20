import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import net from 'node:net';
import {parseSelfProcStat,linuxSelfIdentity,selfIdentityGuard,processIdentity,businessMutex} from '../scripts/m1-mutex.mjs';
function record({pid=process.pid,comm='node (worker)',state='R',pgrp='123',ticks='18446744073709551610'}={}){const fields=Array(49).fill('0');fields[0]='1';fields[1]=pgrp;fields[18]=ticks;return `${pid} (${comm}) ${state} ${fields.join(' ')}\n`;}
const baseline={pid:String(process.pid),pgrp:'123',start_ticks:'9007199254740993',comm:'node',exe:'/synthetic/node',exe_device:'1',exe_inode:'2'};
test('Linux stat parser preserves large ticks and comm delimiters and rejects malformed/dead/mismatched records',()=>{
 const value=parseSelfProcStat(record(),process.pid);assert.equal(value.comm,'node (worker)');assert.equal(value.start_ticks,'18446744073709551610');assert.equal(parseSelfProcStat(record({comm:'a) b (c'}),process.pid).comm,'a) b (c');
 for(const raw of [record({pid:process.pid+1}),record({state:'Z'}),record({state:'X'}),record({ticks:'-1'}),record({pgrp:'0'}),record().slice(0,45),record().replace(/ 0\n$/,' invalid\n'),'garbage'])assert.throws(()=>parseSelfProcStat(raw,process.pid),/MUTEX_PROC_STAT_INVALID/);
});
test('fresh Linux checks detect every stable identity field change and later IO errors without fallback',async()=>{
 for(const field of Object.keys(baseline)){let value=baseline,calls=0,ps=0;const guard=await selfIdentityGuard('SYNTHETIC-PS',{platform:'linux',readPs:()=>{ps++;return'SYNTHETIC-PS';},readProc:async()=>{calls++;return value;}});await guard.check();value={...baseline,[field]:String(baseline[field])+'changed'};await assert.rejects(()=>guard.check(),/MUTEX_SELF_IDENTITY_CHANGED/);assert.equal(calls,3);assert.equal(ps,1);}
 let fail=false,ps=0;const guard=await selfIdentityGuard('SYNTHETIC-PS',{platform:'linux',readPs:()=>{ps++;return'SYNTHETIC-PS';},readProc:async()=>{if(fail)throw Object.assign(Error('gone'),{code:'ENOENT'});return baseline;}});fail=true;await assert.rejects(()=>guard.check(),/gone/);assert.equal(ps,1);
});
test('only initial unavailable capability selects fixed ps fallback; malformed content and initial identity changes reject',async()=>{
 for(const platform of ['darwin','linux']){let ps='SYNTHETIC',calls=0,proc=0;const guard=await selfIdentityGuard(ps,{platform,readPs:()=>{calls++;return ps;},readProc:async()=>{proc++;throw Object.assign(Error('unavailable'),{code:'ENOENT'});}});assert.equal(guard.kind,'ps');await guard.check();await guard.check();assert.equal(calls,3);assert.equal(proc,platform==='linux'?1:0);ps='changed';await assert.rejects(()=>guard.check(),/MUTEX_SELF_IDENTITY_CHANGED/);assert.equal(proc,platform==='linux'?1:0);}
 await assert.rejects(()=>selfIdentityGuard(null),/PROCESS_IDENTITY_UNAVAILABLE/);
 await assert.rejects(()=>selfIdentityGuard('old',{platform:'linux',readProc:async()=>baseline,readPs:()=> 'new'}),/MUTEX_SELF_IDENTITY_CHANGED/);
 await assert.rejects(()=>selfIdentityGuard('same',{platform:'linux',readProc:async()=>{throw Error('MUTEX_PROC_STAT_INVALID');},readPs:()=> 'same'}),/MUTEX_PROC_STAT_INVALID/);
});
test('proc stat and executable reads drain, reject malformed content and do not convert it to capability fallback',async t=>{
 let finished=0,malformed=false;t.mock.method(fs,'readFile',async()=>{await new Promise(r=>setTimeout(r,10));finished++;return malformed?'malformed':record();});t.mock.method(fs,'readlink',async()=>{finished++;throw Object.assign(Error('missing'),{code:'ENOENT'});});t.mock.method(fs,'stat',async()=>{await new Promise(r=>setTimeout(r,15));finished++;return{isFile:()=>true,dev:1n,ino:2n};});
 await assert.rejects(()=>linuxSelfIdentity(process.pid),/missing/);assert.equal(finished,3);
 malformed=true;await assert.rejects(()=>linuxSelfIdentity(process.pid),/MUTEX_PROC_STAT_INVALID/);
});
test('real Linux self identity is reread without spawning ps for each guard',{skip:process.platform!=='linux'},async()=>{
 const identity=processIdentity(process.pid);let ps=0,proc=0;const guard=await selfIdentityGuard(identity,{readPs:pid=>{ps++;return processIdentity(pid);},readProc:async pid=>{proc++;return linuxSelfIdentity(pid);}});assert.equal(guard.kind,'linux-proc');for(let i=0;i<40;i++)await guard.check();assert.equal(ps,1);assert.equal(proc,41);
});
test('business guard rejects owner token, pid and original identity tampering and a closed server',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-self-guard-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));const mutex=await businessMutex({dataRoot:root,port:p,releaseId:'SYNTHETIC'}),file=path.join(root,'m1-control/owner.json'),bytes=await fs.readFile(file),owner=JSON.parse(bytes);
 try{for(const [key,value]of [['token','other'],['pid',process.pid+1],['identity','other']]){await fs.writeFile(file,JSON.stringify({...owner,[key]:value}));await assert.rejects(()=>mutex.guard(),/MUTEX_OWNER_CHANGED/);await fs.writeFile(file,bytes);}await mutex.guard();}finally{await fs.writeFile(file,bytes);await mutex.close();}
 await assert.rejects(()=>mutex.guard(),/MUTEX_NOT_HELD/);
});
