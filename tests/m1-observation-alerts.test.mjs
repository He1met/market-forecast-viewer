import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {randomUUID} from 'node:crypto';
import {collectExecutionObservations} from '../scripts/m1-observation-alerts.mjs';import {alertStore} from '../scripts/m1-alerts.mjs';import {writeOnce,readJson} from '../scripts/m1-files.mjs';
const epoch=Date.parse('2026-09-15T00:00:00Z'),guard=async()=>{};
async function fixture(t){const dataRoot=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-observations-'));t.after(()=>fs.rm(dataRoot,{recursive:true,force:true}));const add=async(status,reason,h=1,id=randomUUID(),extra={})=>{const start={schema:'MFV:OBSERVATION:v1',id,task:'forecast',release_id:'SYNTHETIC',started_at:new Date(epoch).toISOString()},folder=path.join(dataRoot,'m1-observations',id);await writeOnce(dataRoot,path.join(folder,'started.json'),start);if(status)await writeOnce(dataRoot,path.join(folder,'result.json'),{...start,...extra,status,reason,completed_at:new Date(epoch+h*3600000).toISOString()});return id;};return{dataRoot,add,collect:(options={})=>collectExecutionObservations({dataRoot,guard,now:epoch+10*3600000,...options}),store:alertStore(dataRoot,{stream:'execution'})};}
test('bounded frozen sweep orders outcomes, persists dedup and separates publication health',async t=>{
 const f=await fixture(t);await f.add('failed','fetch failed',1,'ffffffff-ffff-ffff-ffff-ffffffffffff');await f.add('failed','fetch failed',2,'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');await f.add('completed',undefined,3,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
 assert.equal((await f.collect({limit:1})).status,'incomplete');assert.equal((await f.store.pending()).length,0);await f.collect({limit:1});let result=await f.collect({limit:1});assert.equal(result.consumed,1);await f.collect({limit:1});await f.collect({limit:1});
 assert.deepEqual((await f.store.pending()).map(x=>x.kind),['fault','recovery']);await f.collect();assert.equal((await f.store.pending()).length,2);assert.equal((await alertStore(f.dataRoot).pending()).length,0);
});
test('unknown lock immediately alerts; pause and late old success cannot recover; fresh success recovers once',async t=>{
 const f=await fixture(t);await f.add('skipped','MUTEX_CONFLICT',4);await f.collect();assert.equal((await f.store.pending())[0].code,'MUTEX_IDENTITY_UNKNOWN');
 await f.add('skipped','paused',5);await f.collect();await f.add('completed',undefined,3);await f.collect();assert.equal((await f.store.pending()).length,1);
 await f.add('completed',undefined,6);await f.collect();assert.equal((await f.store.pending()).at(-1).kind,'recovery');await f.collect();assert.equal((await f.store.pending()).length,2);
});
test('uncertain outbox commit replays durable timestamp without duplicate count',async t=>{
 const f=await fixture(t);await f.add('failed','ENOSPC',1);let rejected=false;
 await assert.rejects(()=>f.collect({guard:async()=>{if(!rejected&&await fs.stat(path.join(f.dataRoot,'m1-control/execution-alerts.json')).catch(()=>null)){rejected=true;throw Error('GUARD_LOST_AFTER_OUTBOX');}}}),/GUARD_LOST/);
 assert.equal((await f.store.pending()).length,1);await f.collect({now:epoch+11*3600000});assert.equal((await f.store.pending()).length,1);
 const state=await readJson(f.dataRoot,path.join(f.dataRoot,'m1-control/observation-alert-cursor.json'));assert.equal(Object.keys(state.seen).length,1);
});
test('started-only invocation is revisited; corrupt result blocks cursor without discarding evidence',async t=>{
 const f=await fixture(t),id=await f.add(null);await f.collect();const folder=path.join(f.dataRoot,'m1-observations',id),start=await readJson(f.dataRoot,path.join(folder,'started.json'));
 await writeOnce(f.dataRoot,path.join(folder,'result.json'),{...start,id:'wrong',status:'failed',completed_at:new Date(epoch+3600000).toISOString()});await assert.rejects(()=>f.collect(),/OBSERVATION_RESULT_INVALID/);assert.equal((await f.store.pending()).length,0);
});
test('real ops resumes both scan and replay batches within the same hour, completing only after drain',async t=>{
 const f=await fixture(t);for(let i=0;i<33;i++)await f.add('skipped','MUTEX_CONFLICT',1);
 const {default:net}=await import('node:net'),{ops}=await import('../scripts/m1-ops.mjs');const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const options={codeRoot:process.cwd(),dataRoot:f.dataRoot,port,releaseId:'SYNTHETIC'};
 let result=await ops(options),calls=1;assert.equal(result.status,'partial');assert.equal(result.reason,'observation_collection_incomplete');assert.equal(result.execution_observations.status,'incomplete');assert.equal(result.execution_observations.inspected,16);
 let replayPartial=false;
 while(result.status!=='completed'&&calls<8){result=await ops(options);calls++;assert.notEqual(result.reason,'slot_completed');if(result.status==='partial'&&result.execution_observations.consumed===16)replayPartial=true;}
 assert.equal(result.status,'completed');assert.equal(result.execution_observations.status,'completed');assert.ok(calls>=5);assert.ok(replayPartial);
 assert.equal((await f.store.pending()).length,1);assert.equal((await ops(options)).reason,'slot_completed');assert.equal((await f.store.pending()).length,1);
});

test('repeated forecast failures within one slot count once; another slot confirms warning',async t=>{
 const f=await fixture(t);await f.add('failed','fetch failed',1,randomUUID(),{slot_id:'first'});await f.add('failed','fetch failed',2,randomUUID(),{slot_id:'first'});await f.collect();assert.equal((await f.store.pending()).length,0);
 await f.add('failed','fetch failed',3,randomUUID(),{slot_id:'second'});await f.collect();assert.equal((await f.store.pending()).length,1);
});
