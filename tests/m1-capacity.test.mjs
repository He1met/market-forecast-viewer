import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import net from 'node:net';
import {capacitySnapshot,capacityPolicy,requireCapacity,observeCapacity} from '../scripts/m1-capacity.mjs';
import {cycle} from '../scripts/m1-cycle.mjs';import {ops} from '../scripts/m1-ops.mjs';import {alertStore} from '../scripts/m1-alerts.mjs';
const limits={reserve_bytes:200,production_floor_bytes:50},guard=async()=>{};
const statfs=available=>async()=>({bsize:1n,blocks:1000n,bfree:BigInt(available),bavail:BigInt(available)});
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-capacity-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return{root,port};}
test('capacity exact thresholds, unknown and invalid configuration fail closed',async t=>{
 const {root}=await fixture(t);for(const [n,status,production,optional]of[[200,'ok',true,true],[199,'low',true,false],[50,'low',true,false],[49,'critical',false,false]]){const x=await capacitySnapshot(root,{policy:limits,statfs:statfs(n)});assert.equal(x.status,status);if(production)requireCapacity(x,'production');else assert.throws(()=>requireCapacity(x,'production'),/PRODUCTION_LOW/);if(optional)requireCapacity(x);else assert.throws(()=>requireCapacity(x),/RESERVE_LOW/);}
 for(const reader of [async()=>{throw Error('disk unavailable');},async()=>({bsize:1n,blocks:1n,bfree:2n,bavail:2n}),async()=>({bsize:2n**60n,blocks:100n,bfree:1n,bavail:1n})]){const x=await capacitySnapshot(root,{policy:limits,statfs:reader});assert.equal(x.status,'unknown');assert.throws(()=>requireCapacity(x,'production'),/CAPACITY_UNKNOWN/);assert.throws(()=>requireCapacity(x),/CAPACITY_UNKNOWN/);}
 assert.throws(()=>capacityPolicy({reserve_bytes:1,production_floor_bytes:2}),/CONFIG/);assert.throws(()=>capacityPolicy({reserve_bytes:NaN}),/CONFIG/);
});
test('daily baseline, same-day idempotence, unknown preservation and whole-filesystem growth',async t=>{
 const {root}=await fixture(t),base=Date.parse('2026-09-15T00:00:00Z');const run=(now,n)=>observeCapacity({dataRoot:root,guard,policy:limits,now,statfs:statfs(n)});
 await run(base,400);let x=await run(base+1000,300);assert.equal(x.baseline.available_bytes,400);assert.equal(x.daily_change,null);
 x=await run(base+86400000,250);assert.equal(x.daily_change.filesystem_used_delta_bytes,150);assert.equal(x.daily_change.scope,'whole_filesystem_not_project');
 x=await observeCapacity({dataRoot:root,guard,policy:limits,now:base+2*86400000,statfs:async()=>{throw Error('unavailable');}});assert.equal(x.current.status,'unknown');assert.equal(x.baseline.available_bytes,250);
 await assert.rejects(()=>run(base,300),/TIME_REVERSED/);
});
test('critical forecast capacity refuses before claiming slot or invoking model',async t=>{
 const {root,port}=await fixture(t);let calls=0;const result=await cycle({dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T01:47:00Z'),readCapacity:()=>capacitySnapshot(root,{policy:limits,statfs:statfs(49)}),freeze:async()=>{calls++;},generate:async()=>{calls++;}});
 assert.equal(result.reason,'CAPACITY_PRODUCTION_LOW');assert.equal(calls,0);await assert.rejects(()=>fs.stat(path.join(root,'m1-slots')),/ENOENT/);
});
test('low capacity keeps official result and candidate denominator without optional preparation',async t=>{
 const {root,port}=await fixture(t);let prepared=0,models=0,finished;const result=await cycle({dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T01:47:00Z'),readCapacity:()=>capacitySnapshot(root,{policy:limits,statfs:statfs(100)}),registerOpportunity:async()=>({id:'SYNTHETIC'}),freeze:async()=>({}),generate:async()=>{models++;return{forecast:{run_id:'SYNTHETIC'}};},publishIndex:guard,prepareCandidate:async()=>{prepared++;return{};},runCandidate:async()=>{throw Error('must not run');},finishOpportunity:async(_r,x)=>{finished=x;}});
 assert.equal(result.status,'completed');assert.equal(models,1);assert.equal(prepared,0);assert.equal(finished.candidate_status,'capacity_skipped');assert.equal(finished.candidate_invoked,false);assert.equal(finished.official_run_id,'SYNTHETIC');
});
test('real ops records capacity and separate pending warning, suppresses optional refresh',async t=>{
 const {root,port}=await fixture(t);let refresh=0;const result=await ops({codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',capacityPolicy:limits,capacityStatfs:statfs(100),refreshInputs:async()=>{refresh++;}});
 assert.equal(result.status,'completed');assert.equal(result.capacity.current.status,'low');assert.equal(refresh,0);const events=await alertStore(root,{stream:'capacity'}).pending();assert.equal(events.length,1);assert.equal(events[0].code,'CAPACITY_RESERVE_LOW');assert.ok(result.alerts.event_ids.includes(events[0].id));
});
test('fresh drop after official publication suppresses candidate model, preserving publication',async t=>{
 const {root,port}=await fixture(t);let reads=0,invoked=0,finished;const result=await cycle({dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T01:47:00Z'),readCapacity:()=>capacitySnapshot(root,{policy:limits,statfs:statfs(++reads<=2?300:100)}),registerOpportunity:async()=>({id:'SYNTHETIC'}),freeze:async()=>({}),generate:async()=>({forecast:{run_id:'SYNTHETIC'}}),publishIndex:guard,prepareCandidate:async()=>({run_id:'CANDIDATE'}),runCandidate:async()=>{invoked++;},finishOpportunity:async(_r,x)=>{finished=x;}});
 assert.equal(result.status,'completed');assert.equal(invoked,0);assert.equal(finished.candidate_status,'capacity_skipped');assert.equal(finished.official_run_id,'SYNTHETIC');
});

test('fresh capacity after freeze controls preparation; later recovery preserves skip cause',async t=>{
 for(const [sequence,expectedPrepare,expectedStatus] of [[[300,100,300],0,'capacity_skipped'],[[100,300,300],1,'published']]){
  const {root,port}=await fixture(t);let reads=0,prepared=0,finished;
  const result=await cycle({dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T01:47:00Z'),readCapacity:()=>capacitySnapshot(root,{policy:limits,statfs:statfs(sequence[reads++])}),registerOpportunity:async()=>({id:'SYNTHETIC'}),freeze:async()=>({}),generate:async()=>({forecast:{run_id:'SYNTHETIC'}}),publishIndex:guard,prepareCandidate:async()=>{prepared++;return{run_id:'CANDIDATE'};},runCandidate:guard,finishOpportunity:async(_r,x)=>{finished=x;}});
  assert.equal(result.status,'completed');assert.equal(prepared,expectedPrepare);assert.equal(finished.candidate_status,expectedStatus);assert.equal(finished.candidate_invoked,expectedPrepare===1);
 }
});
test('real ops retains unresolved candidate through capacity deferral until successful reinspection',async t=>{
 const {requireEvidence}=await import('../scripts/evidence-context.mjs');requireEvidence();
 const {root,port}=await fixture(t),id='m1-20260912T183644170Z-00000000-0000-4000-8000-000000000011';
 const source=path.join(process.cwd(),'artifacts/forecast-runs',id),dest=path.join(root,'m1-candidates',id);
 const input=JSON.parse(await fs.readFile(path.join(source,'input.json')));assert.equal(input.features.synthetic,true);
 await fs.cp(source,dest,{recursive:true});await fs.cp(path.join(process.cwd(),'artifacts/data-source'),path.join(root,'data-source'),{recursive:true});
 const file=path.join(dest,'input.json'),original=await fs.readFile(file);await fs.writeFile(file,'{}');
 let available=300;const options={codeRoot:process.cwd(),dataRoot:root,port,releaseId:'SYNTHETIC',capacityPolicy:limits,capacityStatfs:async()=>statfs(available)(),outcomeTransport:async({file})=>{await fs.writeFile(file,JSON.stringify({code:'0',msg:'SYNTHETIC',data:Array.from({length:96},(_,i)=>[String((input.anchor_time+i*900)*1000),...Array(4).fill(String(input.anchor_price)),'10','1','100','1']).reverse()}));return '200';}};
 assert.equal((await ops(options)).status,'partial');assert.equal((await ops(options)).status,'partial');const before=await alertStore(root).pending();assert.ok(before.some(x=>x.kind==='fault'));
 available=100;const low=await ops(options);assert.equal(low.status,'partial');assert.equal(low.unresolved[0].role,'candidate');assert.equal(low.unresolved[0].deferred,'capacity');assert.equal((await alertStore(root).pending()).filter(x=>x.kind==='recovery').length,0);assert.equal(await fs.readFile(file,'utf8'),'{}');
 available=300;assert.equal((await ops(options)).status,'partial');assert.equal((await alertStore(root).pending()).filter(x=>x.kind==='recovery').length,0);
 await fs.writeFile(file,original);const fixed=await ops(options);assert.equal(fixed.status,'completed');assert.equal(fixed.unresolved.length,0);assert.equal((await alertStore(root).pending()).filter(x=>x.kind==='recovery').length,1);
});
