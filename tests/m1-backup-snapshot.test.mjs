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
 assert.ok(checks>=7&&checks<20,`guard calls ${checks}`);
 for(const e of result.captured){assert.equal(reads.get(path.join(e.root,e.name)),2);assert.equal(digest(e.bytes),e.sha256);}
});

test('snapshot checks identity after 250ms even below the file count threshold',async t=>{
 const f=await fixture(t,4);let time=0,checks=0,reads=0,checksAfterFirst=0;
 t.mock.method(performance,'now',()=>time);
 const read=fs.readFile.bind(fs);t.mock.method(fs,'readFile',async(file,...args)=>{
  if(++reads===2)assert.ok(checks>checksAfterFirst);
  const b=await read(file,...args);if(reads===1){checksAfterFirst=checks;time+=251;}return b;
 });
 await captureSnapshot({...f,mutex:{guard:async()=>{checks++;}}});
 assert.equal(reads,8);
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
   assert.equal(e.snapshot_diagnostics.phase,'verify');return true;
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
