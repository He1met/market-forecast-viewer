import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {captureSnapshot,backup,restore} from '../scripts/m1-backup.mjs';
import {digest} from '../scripts/m1-files.mjs';

async function fixture(t,count=70){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-snapshot-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dataRoot=path.join(root,'data'),runtimeHome=path.join(root,'runtime'),target=path.join(root,'backup');
 await fs.mkdir(path.join(dataRoot,'data-source'),{recursive:true});await fs.mkdir(runtimeHome);await fs.mkdir(target);
 for(let i=0;i<count;i++)await fs.writeFile(path.join(dataRoot,'data-source',String(i).padStart(4,'0')),`synthetic-${i}`);
 return{root,dataRoot,runtimeHome,target};
}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}

test('snapshot retains two safe reads per file and bounded identity checks',async t=>{
 const f=await fixture(t);let checks=0;const reads=new Map(),read=fs.readFile.bind(fs);
 t.mock.method(fs,'readFile',async(file,...args)=>{reads.set(String(file),(reads.get(String(file))??0)+1);return read(file,...args);});
 const result=await captureSnapshot({...f,mutex:{guard:async()=>{checks++;}}});
 assert.equal(result.captured.length,70);assert.equal(result.diagnostics.verified_files,70);
 assert.deepEqual(Object.keys(result.diagnostics.work_ms).sort(),['guard','metadata','safe_read_hash']);
 for(const kind of Object.keys(result.diagnostics.work_ms))assert.ok(result.diagnostics.work_ms[kind]>=0);
 assert.ok(Object.values(result.diagnostics.work_ms).reduce((a,b)=>a+b,0)<=result.diagnostics.elapsed_ms);
 for(const kind of Object.keys(result.diagnostics.work_ms))assert.ok(Math.abs(Object.values(result.diagnostics.phase_work_ms).reduce((total,phase)=>total+phase[kind],0)-result.diagnostics.work_ms[kind])<.001);
 assert.ok(checks>=7&&checks<20,`guard calls ${checks}`);
 for(const e of result.captured){assert.equal(reads.get(path.join(e.root,e.name)),2);assert.equal(digest(e.bytes),e.sha256);}
});

test('snapshot checks identity after 250ms even below the file count threshold',async t=>{
 const f=await fixture(t,16);let time=0,checks=0,reads=0,checksAfterFirst=0;
 t.mock.method(performance,'now',()=>time);
 const read=fs.readFile.bind(fs);t.mock.method(fs,'readFile',async(file,...args)=>{
  const n=++reads;if(n===9)assert.ok(checks>checksAfterFirst);
  const b=await read(file,...args);if(n===1){checksAfterFirst=checks;time+=251;}return b;
 });
 await captureSnapshot({...f,mutex:{guard:async()=>{checks++;}}});
 assert.equal(reads,32);
});

test('snapshot detects changing source, owner loss and final slow IO without success',async t=>{
 for(const mode of ['source','owner','deadline'])await t.test(mode,async t=>{
  const f=await fixture(t,1),file=path.join(f.dataRoot,'data-source','0000');let reads=0;
  const read=fs.readFile.bind(fs);t.mock.method(fs,'readFile',async(p,...args)=>{
   const bytes=await read(p,...args);if(String(p)===file&&++reads===2){
    if(mode==='source')return Buffer.from('changed');
    if(mode==='deadline')await new Promise(r=>setTimeout(r,160));
   }return bytes;
  });let calls=0;
  await assert.rejects(()=>captureSnapshot({...f,maxSnapshotMs:mode==='deadline'?150:15000,mutex:{guard:async()=>{if(mode==='owner'&&++calls===4)throw Error('MUTEX_OWNER_CHANGED');}}}),e=>{
   assert.match(e.message,new RegExp(mode==='source'?'BACKUP_SOURCE_CHANGED':mode==='owner'?'MUTEX_OWNER_CHANGED':'BACKUP_SNAPSHOT_DEADLINE'));
   assert.equal(e.snapshot_diagnostics.phase,'verify');assert.ok(e.snapshot_diagnostics.work_ms.guard>=0);assert.ok(e.snapshot_diagnostics.phase_work_ms.verify.safe_read_hash>=0);return true;
  });
  assert.deepEqual(await fs.readdir(f.target),[]);
 });
});

test('snapshot deadline covers traversal and backup never commits a failed slot',async t=>{
 const f=await fixture(t,1),p=await port();await assert.rejects(()=>backup({...f,port:p,releaseId:'SYNTHETIC',slotKey:'synthetic-day',maxSnapshotMs:0}),/BACKUP_SNAPSHOT_DEADLINE/);
 assert.deepEqual(await fs.readdir(f.target),[]);
});

test('snapshot rejects excess bytes and runtime symlinks without reducing its closure',async t=>{
 const f=await fixture(t,1);await assert.rejects(()=>captureSnapshot({...f,maxBytes:1,mutex:{guard:async()=>{}}}),/BACKUP_SNAPSHOT_SIZE/);
 await fs.symlink(path.join(f.dataRoot,'data-source'),path.join(f.runtimeHome,'linked'));
 await assert.rejects(()=>captureSnapshot({...f,mutex:{guard:async()=>{}}}),/BACKUP_SYMLINK/);
});

test('interrupted object writing leaves no success manifest or slot and can retry',async t=>{
 const f=await fixture(t,2),p=await port(),write=fs.writeFile.bind(fs);
 const mock=t.mock.method(fs,'writeFile',async(file,...args)=>{
  if(String(file).startsWith(path.join(f.target,'staging')+path.sep))throw Error('SYNTHETIC_IO_INTERRUPTED');
  return write(file,...args);
 });
 await assert.rejects(()=>backup({...f,port:p,releaseId:'SYNTHETIC',slotKey:'day'}),/SYNTHETIC_IO_INTERRUPTED/);
 for(const name of ['manifests','slots','.backup-lock'])assert.equal(await fs.stat(path.join(f.target,name)).catch(()=>null),null);
 mock.mock.restore();
 const result=await backup({...f,port:p,releaseId:'SYNTHETIC',slotKey:'day'});
 assert.equal(result.status,'completed');
 const again=await backup({...f,port:p,releaseId:'SYNTHETIC',slotKey:'day'});
 assert.equal(again.already_completed,true);assert.equal(again.manifest.id,result.manifest.id);
});

test('bounded reads drain all in-flight IO before an interrupted capture releases control',async t=>{
 const f=await fixture(t,16),read=fs.readFile.bind(fs);let active=0,maximum=0,started=0,finished=0;
 t.mock.method(fs,'readFile',async(file,...args)=>{
  const n=++started;active++;maximum=Math.max(maximum,active);
  try{await new Promise(r=>setTimeout(r,n===2?1:20));if(n===2)throw Error('SYNTHETIC_READ_INTERRUPTED');return await read(file,...args);}finally{active--;finished++;}
 });
 await assert.rejects(()=>captureSnapshot({...f,mutex:{guard:async()=>{}}}),/SYNTHETIC_READ_INTERRUPTED/);
 assert.equal(maximum,8);assert.equal(active,0);assert.equal(started,8);assert.equal(finished,8);
});

test('large declared files reduce concurrency to keep batch reservation within 256MiB',async t=>{
 const f=await fixture(t,5),stat=fs.stat.bind(fs),read=fs.readFile.bind(fs);let active=0,maximum=0;
 // Synthetic metadata sizes exercise the allocation boundary without allocating
 // gigabytes. The separate scale gate reads and restores real 208MB payloads.
 t.mock.method(fs,'stat',async(file,...args)=>{const value=await stat(file,...args);if(String(file).includes('/data-source/'))value.size=path.basename(file)==='0000'?256*1024*1024:64*1024*1024;return value;});
 t.mock.method(fs,'readFile',async(file,...args)=>{active++;maximum=Math.max(maximum,active);try{await new Promise(r=>setImmediate(r));return await read(file,...args);}finally{active--;}});
 const result=await captureSnapshot({...f,mutex:{guard:async()=>{}}});
 assert.equal(result.diagnostics.max_batch_reserved_bytes,256*1024*1024);assert.equal(result.diagnostics.max_inflight_files,4);assert.equal(maximum,4);assert.equal(active,0);assert.equal(result.diagnostics.verified_files,5);
});

test('growth beyond a reserved size fails before another batch or any publication',async t=>{
 const f=await fixture(t,16),read=fs.readFile.bind(fs);let reads=0;
 t.mock.method(fs,'readFile',async(file,...args)=>{reads++;return Buffer.concat([await read(file,...args),Buffer.from('GROWTH')]);});
 await assert.rejects(()=>captureSnapshot({...f,mutex:{guard:async()=>{}}}),/BACKUP_SOURCE_CHANGED/);
 assert.equal(reads,8);assert.deepEqual(await fs.readdir(f.target),[]);
});

test('deadline in a batch drains active reads and starts no following batch',async t=>{
 const f=await fixture(t,16),read=fs.readFile.bind(fs);let reads=0,active=0,time=0;
 t.mock.method(performance,'now',()=>time);
 t.mock.method(fs,'readFile',async(file,...args)=>{reads++;active++;try{const b=await read(file,...args);time=200;return b;}finally{active--;}});
 await assert.rejects(()=>captureSnapshot({...f,maxSnapshotMs:150,mutex:{guard:async()=>{}}}),/BACKUP_SNAPSHOT_DEADLINE/);
 assert.equal(active,0);assert.equal(reads,8);assert.deepEqual(await fs.readdir(f.target),[]);
});


test('bounded metadata drains before a failed batch starts any payload reads',async t=>{
 const f=await fixture(t,16),stat=fs.stat.bind(fs),read=fs.readFile.bind(fs);let active=0,maximum=0,started=0,finished=0,reads=0;
 t.mock.method(fs,'stat',async(file,...args)=>{
  const n=++started;active++;maximum=Math.max(maximum,active);
  try{await new Promise(r=>setTimeout(r,n===2?1:20));if(n===2)throw Error('SYNTHETIC_STAT_INTERRUPTED');return await stat(file,...args);}finally{active--;finished++;}
 });
 t.mock.method(fs,'readFile',async(...args)=>{reads++;return read(...args);});
 await assert.rejects(()=>captureSnapshot({...f,mutex:{guard:async()=>{}}}),/SYNTHETIC_STAT_INTERRUPTED/);
 assert.equal(maximum,8);assert.equal(active,0);assert.equal(started,8);assert.equal(finished,8);assert.equal(reads,0);
});

test('each read phase checks identity within 32 files and after its final batch',async t=>{
 const f=await fixture(t,97),read=fs.readFile.bind(fs);let reads=0,last=0,maximum=0;
 t.mock.method(fs,'readFile',async(...args)=>{reads++;return read(...args);});
 const result=await captureSnapshot({...f,mutex:{guard:async()=>{maximum=Math.max(maximum,reads-last);assert.ok(reads-last<=32);last=reads;}}});
 assert.equal(maximum,32);assert.equal(reads,194);assert.equal(last,reads);assert.equal(result.diagnostics.max_inflight_files,8);
});


test('metadata deadline drains its batch and never starts payload IO',async t=>{
 const f=await fixture(t,16),stat=fs.stat.bind(fs),read=fs.readFile.bind(fs);let time=0,started=0,finished=0,reads=0;
 t.mock.method(performance,'now',()=>time);
 t.mock.method(fs,'stat',async(...args)=>{started++;try{const value=await stat(...args);time=200;return value;}finally{finished++;}});
 t.mock.method(fs,'readFile',async(...args)=>{reads++;return read(...args);});
 await assert.rejects(()=>captureSnapshot({...f,maxSnapshotMs:150,mutex:{guard:async()=>{}}}),/BACKUP_SNAPSHOT_DEADLINE/);
 assert.equal(started,8);assert.equal(finished,8);assert.equal(reads,0);
});


test('slow metadata rechecks elapsed identity boundary before any payload reads',async t=>{
 const f=await fixture(t,16),stat=fs.stat.bind(fs),read=fs.readFile.bind(fs);let time=0,checks=0,started=0,finished=0,reads=0;
 t.mock.method(performance,'now',()=>time);
 t.mock.method(fs,'stat',async(...args)=>{started++;try{const value=await stat(...args);time=251;return value;}finally{finished++;}});
 t.mock.method(fs,'readFile',async(...args)=>{reads++;return read(...args);});
 await assert.rejects(()=>captureSnapshot({...f,mutex:{guard:async()=>{if(++checks===3){assert.equal(finished,8);assert.equal(reads,0);throw Error('MUTEX_OWNER_CHANGED');}}}}),/MUTEX_OWNER_CHANGED/);
 assert.equal(started,8);assert.equal(finished,8);assert.equal(reads,0);
});


test('owner loss at a completed batch boundary prevents further reads',async t=>{
 const f=await fixture(t,97),read=fs.readFile.bind(fs);let reads=0;
 t.mock.method(fs,'readFile',async(...args)=>{reads++;return read(...args);});
 await assert.rejects(()=>captureSnapshot({...f,mutex:{guard:async()=>{if(reads===32)throw Error('MUTEX_OWNER_CHANGED');}}}),/MUTEX_OWNER_CHANGED/);
 assert.equal(reads,32);
});
