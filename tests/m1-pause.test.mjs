import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {setForecastPaused} from '../scripts/m1-admin.mjs';
import {atomic,readJson} from '../scripts/m1-files.mjs';
import {publicationHealth} from '../scripts/m1-publication-health.mjs';
import {cycle} from '../scripts/m1-cycle.mjs';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-pause-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const home=path.join(root,'runtime'),data=path.join(root,'data');await fs.mkdir(home);await fs.mkdir(data);
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const file=path.join(home,'installation.local.json'),config={schema:'MFV:INSTALLATION:v1',runtime_home:home,data_root:data,http_port:port===65535?port-1:port+1,mutex_port:port,forecast_paused:true,ops_paused:true,service_paused:true};
 await atomic(home,file,config);await atomic(home,path.join(home,'current.json'),{release_id:'a'.repeat(64)});
 return{home,data,file,config,read:()=>readJson(home,file),set:(paused,at)=>setForecastPaused({runtimeHome:home,releaseId:'a'.repeat(64),paused,clock:()=>Date.parse(at)})};
}
test('pause/resume commits epoch together, excludes paused slots, repeated resume preserves misses',async t=>{
 const f=await fixture(t);await f.set(false,'2026-09-15T05:47:00Z');
 assert.equal((await f.read()).forecast_expected_since,'2026-09-15T05:47:00.000Z');
 await f.set(true,'2026-09-15T06:00:00Z');assert.equal((await f.read()).forecast_expected_since,null);
 await f.set(false,'2026-09-15T07:48:00Z');await f.set(false,'2026-09-15T08:30:00Z');
 const c=await f.read();assert.equal(c.forecast_expected_since,'2026-09-15T07:48:00.000Z');assert.equal(c.ops_paused,true);assert.equal(c.service_paused,true);
 const reader={listRunIds:async()=>[]};
 assert.equal((await publicationHealth({reader,paused:c.forecast_paused,expectedSince:c.forecast_expected_since,now:Date.parse('2026-09-15T08:02:00Z')})).status,'waiting');
 assert.equal((await publicationHealth({reader,paused:false,expectedSince:c.forecast_expected_since,now:Date.parse('2026-09-15T10:02:00Z')})).slots.length,1);
});
test('legacy active config gets a fresh epoch; wrong release and failed intent leave config intact',async t=>{
 const f=await fixture(t);await atomic(f.home,f.file,{...f.config,forecast_paused:false});await f.set(false,'2026-09-15T07:48:00Z');const before=await fs.readFile(f.file,'utf8');
 await assert.rejects(()=>setForecastPaused({runtimeHome:f.home,releaseId:'b'.repeat(64),paused:true}),/PINNED_RELEASE_MISMATCH/);assert.equal(await fs.readFile(f.file,'utf8'),before);
 await fs.rm(path.join(f.home,'changes'),{recursive:true});await fs.writeFile(path.join(f.home,'changes'),'blocked');
 await assert.rejects(()=>f.set(true,'2026-09-15T08:00:00Z'));assert.equal(await fs.readFile(f.file,'utf8'),before);
 await fs.unlink(path.join(f.home,'changes'));await f.set(true,'2026-09-15T08:00:00Z');assert.equal((await f.read()).forecast_paused,true);
});
test('forecast rechecks pause under business lock before claiming slot or calling model',async t=>{
 const f=await fixture(t);let reads=0;const result=await cycle({dataRoot:f.data,releaseId:'a'.repeat(64),mutexPort:f.config.mutex_port,paused:false,clock:()=>Date.parse('2026-09-15T07:47:00Z'),readPaused:async()=>{reads++;return true;},freeze:()=>{throw Error('MUST_NOT_FREEZE');}});
 assert.equal(result.reason,'paused');assert.equal(reads,1);await assert.rejects(()=>fs.readdir(path.join(f.data,'m1-slots')),/ENOENT/);
});
