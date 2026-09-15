import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { cycle } from '../scripts/m1-cycle.mjs';
import { ops, scanOpsBatch } from '../scripts/m1-ops.mjs';
import { businessMutex } from '../scripts/m1-mutex.mjs';

async function fixture(t) {
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-finalization-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port;await new Promise(r=>server.close(r));
 return {root,port};
}
async function free(root,port) {
 const mutex=await businessMutex({dataRoot:root,port,releaseId:'SYNTHETIC_PROBE'});
 assert.equal(mutex.status,'ACQUIRED');await mutex.close();
}
async function sabotageResult(root) {
 const ids=await fs.readdir(path.join(root,'m1-observations'));
 await fs.mkdir(path.join(root,'m1-observations',ids.at(-1),'result.json'));
}
const forecastOptions=(root,port)=>({dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',
 clock:()=>Date.parse('2026-09-15T01:47:00Z'),freeze:async()=>({}),
 generate:async()=>({forecast:{run_id:'SYNTHETIC_PUBLISHED',published_at:'2026-09-15T01:48:00Z'}}),publishIndex:async()=>{}});

test('forecast publication survives index failure, retains success and never regenerates the slot',async t=>{
 const {root,port}=await fixture(t);let calls=0;
 const options={...forecastOptions(root,port),generate:async()=>{calls++;return {forecast:{run_id:'SYNTHETIC_PUBLISHED'}};},publishIndex:async()=>{throw Error('SYNTHETIC_INDEX_FAILURE');}};
 const result=await cycle(options);assert.equal(result.status,'failed');assert.equal(result.reason,'SYNTHETIC_INDEX_FAILURE');
 assert.equal(result.publication_committed,true);assert.equal(result.forecast_id,'SYNTHETIC_PUBLISHED');
 const last=JSON.parse(await fs.readFile(path.join(root,'m1-task-status/last-forecast-success.json')));
 assert.equal(last.forecast_id,'SYNTHETIC_PUBLISHED');assert.equal(last.status,'completed');
 assert.equal((await cycle(options)).reason,'duplicate_slot');assert.equal(calls,1);await free(root,port);
});

test('opportunity finalization failure remains visible and releases idle forecast mutex',async t=>{
 const {root,port}=await fixture(t);
 const result=await cycle({...forecastOptions(root,port),registerOpportunity:async()=>({id:'SYNTHETIC'}),
 freeze:async()=>{throw Error('SYNTHETIC_FREEZE_FAILURE');},finishOpportunity:async()=>{throw Error('SYNTHETIC_FINISH_FAILURE');}});
 assert.equal(result.status,'failed');assert.equal(result.reason,'SYNTHETIC_FREEZE_FAILURE');
 assert.equal(result.finalization_error,'SYNTHETIC_FINISH_FAILURE');
 const saved=JSON.parse(await fs.readFile(path.join(root,'m1-task-status/forecast.json')));
 assert.equal(saved.finalization_error,'SYNTHETIC_FINISH_FAILURE');await free(root,port);
});

test('forecast result and summary filesystem failures still close their own mutex',async t=>{
 for(const target of ['result','summary']){
  const {root,port}=await fixture(t);
  await assert.rejects(()=>cycle({...forecastOptions(root,port),publishIndex:async()=>{
   if(target==='result')await sabotageResult(root);
   else await fs.mkdir(path.join(root,'m1-task-status/last-forecast-success.json'));
  }}),/EEXIST|EISDIR|ENOTEMPTY/);await free(root,port);
 }
});

test('ops result and summary filesystem failures still close their own mutex',async t=>{
 for(const target of ['result','summary']){
  const {root,port}=await fixture(t);
  await assert.rejects(()=>ops({codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',refreshInputs:async()=>{
   if(target==='result')await sabotageResult(root);
   else await fs.mkdir(path.join(root,'m1-task-status/ops.json'),{recursive:true});
  }}),/EEXIST|EISDIR|ENOTEMPTY/);await free(root,port);
 }
});

test('ops missing formerly failed archive remains unresolved and never deduplicates as success',async t=>{
 const {root,port}=await fixture(t);
 const id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
 // An incomplete SYNTHETIC archive must be surfaced, not silently accepted as an empty history.
 await fs.mkdir(path.join(root,'forecast-runs',id),{recursive:true});
 await fs.writeFile(path.join(root,'forecast-runs',id,'manifest.json'),'{}');
 const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC'};
 const first=await ops(options);assert.equal(first.status,'partial');assert.equal(first.reason,'outcome_incomplete');
 assert.ok(first.outcomes.some(x=>x.run_id===id&&x.status==='failed'));await free(root,port);
 // Repair only this test's corrupt object, not a production archive.
 await fs.rm(path.join(root,'forecast-runs',id),{recursive:true});
 const missing=await ops(options);assert.equal(missing.status,'partial');assert.equal(missing.unresolved[0].reason,'archive_missing');
 assert.equal((await ops(options)).status,'partial');await free(root,port);
});


test('uncertain opportunity completion is attempted once and cannot erase committed publication',async t=>{
 const {root,port}=await fixture(t);let finishes=0;
 const result=await cycle({...forecastOptions(root,port),registerOpportunity:async()=>({id:'SYNTHETIC'}),
 finishOpportunity:async()=>{finishes++;throw Error('SYNTHETIC_AFTER_COMMIT');}});
 assert.equal(finishes,1);assert.equal(result.status,'failed');assert.equal(result.reason,'SYNTHETIC_AFTER_COMMIT');
 assert.equal(result.publication_committed,true);await free(root,port);
});


test('rotating ops batches retain prior failures until actual successful reinspection',async t=>{
 const {root}=await fixture(t),ids=Array.from({length:16},(_,i)=>'SYNTHETIC_'+i);let repaired=false,visited=[];
 const options={dataRoot:root,role:'production',ids,guard:async()=>{},visit:async id=>{visited.push(id);return id===ids[0]&&!repaired?{status:'failed',reason:'SYNTHETIC_CORRUPT'}:{status:'ok'};}};
 const first=await scanOpsBatch(options);assert.equal(first.visited,8);assert.equal(first.unresolved.length,1);
 visited=[];const second=await scanOpsBatch(options);assert.deepEqual(visited,ids.slice(8));assert.ok(second.outcomes.every(x=>x.status==='ok'));assert.equal(second.unresolved.length,1);
 repaired=true;const third=await scanOpsBatch(options);assert.equal(third.unresolved.length,0);assert.ok(third.outcomes.some(x=>x.run_id===ids[0]));
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'m1-control/ops-production-cursor.json'))).unresolved,[]);
});

test('ops inspection interrupted before cursor commit retains the in-flight object',async t=>{
 const {root}=await fixture(t);let rejectSave=false;
 await assert.rejects(()=>scanOpsBatch({dataRoot:root,role:'candidate',ids:['SYNTHETIC'],guard:async()=>{if(rejectSave)throw Error('SYNTHETIC_INTERRUPT');},visit:async()=>{rejectSave=true;return{status:'ok'};}}),/SYNTHETIC_INTERRUPT/);
 const file=path.join(root,'m1-control/ops-candidate-cursor.json'),saved=JSON.parse(await fs.readFile(file));
 assert.equal(saved.offset,0);assert.equal(saved.unresolved[0].reason,'inspection_incomplete');
 const recovered=await scanOpsBatch({dataRoot:root,role:'candidate',ids:['SYNTHETIC'],guard:async()=>{},visit:async()=>({status:'ok'})});assert.deepEqual(recovered.unresolved,[]);
});


test('ops repaired archive clears persisted failure through real validation and scoring before slot completion',async t=>{
 const {root,port}=await fixture(t),id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
 const dir=path.join(root,'forecast-runs',id);await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'manifest.json'),'{}');
 const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',outcomeTransport:async({file})=>{
  const input=JSON.parse(await fs.readFile(path.join(dir,'input.json'))),anchor=input.anchor_time,price=input.anchor_price;
  await fs.writeFile(file,JSON.stringify({code:'0',msg:'SYNTHETIC',data:Array.from({length:96},(_,i)=>[String((anchor+i*900)*1000),...Array(4).fill(String(price)),'10','1','100','1']).reverse()}));return '200';
 }};
 assert.equal((await ops(options)).status,'partial');
 await fs.rm(dir,{recursive:true});await fs.cp(path.resolve('artifacts/forecast-runs',id),dir,{recursive:true});
 await fs.cp(path.resolve('artifacts/data-source'),path.join(root,'data-source'),{recursive:true});
 const fixed=await ops(options);assert.equal(fixed.status,'completed');assert.deepEqual(fixed.unresolved,[]);
 assert.equal((await ops(options)).reason,'slot_completed');await free(root,port);
});
