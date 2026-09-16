import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs/promises';import os from'node:os';import path from'node:path';import net from'node:net';import{cycle,scheduledSlot}from'../scripts/m1-cycle.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-cycle-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return{root,port};}
test('slot identity survives release change; duplicate cannot generate twice; missed window never reanchors',async t=>{const{root,port}=await fixture(t);let calls=0;const at=Date.parse('2026-09-15T01:47:00Z'),options={dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC_A',clock:()=>at,freeze:async({slot})=>({slot}),generate:async()=>{calls++;return{forecast:{run_id:'SYNTHETIC'}};},publishIndex:async()=>{}};assert.equal((await cycle(options)).status,'completed');assert.equal((await cycle({...options,releaseId:'SYNTHETIC_B'})).reason,'duplicate_slot');assert.equal(calls,1);assert.equal((await cycle({...options,clock:()=>at+13*60000})).reason,'missed_slot');assert.equal(calls,1);assert.equal(scheduledSlot(at).slot_id,scheduledSlot(at+60000).slot_id);});
test('failed model attempt preserves slot and bounded retry, no later replacement',async t=>{const{root,port}=await fixture(t);let calls=0;const options={dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T01:47:00Z'),freeze:async()=>({}),generate:async()=>{calls++;throw Error('SYNTHETIC_FAIL');},publishIndex:async()=>assert.fail('must not publish')};assert.equal((await cycle(options)).status,'failed');assert.equal(calls,2);assert.equal((await cycle(options)).reason,'duplicate_slot');assert.equal(calls,2);});

test('policy resolves under the business mutex before slot claim; pending never consumes the slot',async t=>{
 const{businessMutex}=await import('../scripts/m1-mutex.mjs');const{root,port}=await fixture(t);let policy={feedback:'P0'},seen,resolves=0;
 const at=Date.parse('2026-09-15T01:47:00Z'),options={dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>at,
 resolvePolicy:async({mutex})=>{resolves++;await mutex.guard();assert.equal((await businessMutex({dataRoot:root,port,releaseId:'ops-interleave'})).status,'BUSY');return policy;},
 registerOpportunity:async(slot,{policy:snapshot})=>{seen=snapshot;return null;},freeze:async({policy:snapshot})=>{assert.equal(snapshot,seen);assert.equal(snapshot.feedback,'P1');return{};},generate:async()=>({forecast:{run_id:'SYNTHETIC'}}),publishIndex:async()=>{}};
 const ops=await businessMutex({dataRoot:root,port,releaseId:'ops'});assert.equal((await cycle(options)).reason,'BUSY');assert.equal(resolves,0);policy={feedback:'P1'};await ops.close();
 assert.equal((await cycle({...options,resolvePolicy:async()=>{throw Error('EXPERIMENT_TRANSITION_PENDING');}})).reason,'EXPERIMENT_TRANSITION_PENDING');
 await assert.rejects(()=>fs.stat(path.join(root,'m1-slots',scheduledSlot(at).slot_id+'.json')),/ENOENT/);
 assert.equal((await cycle(options)).status,'completed');assert.equal(resolves,1);
});

test('old-result fallback is bounded, shares writer, and preserves failure independently of a new publication',async t=>{
 const{businessMutex}=await import('../scripts/m1-mutex.mjs');const{root,port}=await fixture(t);let fallbackCalls=0,freezeCalls=0;
 const options={dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T01:47:00Z'),
 scoreOld:async({mutex,deadline,signal})=>{fallbackCalls++;await mutex.guard();assert.ok(deadline-performance.now()<=45000);assert.ok(deadline>performance.now());assert.equal(signal.aborted,false);assert.equal((await businessMutex({dataRoot:root,port,releaseId:'other'})).status,'BUSY');throw Error('SYNTHETIC_FALLBACK_FAILURE');},
 freeze:async()=>{freezeCalls++;assert.equal(fallbackCalls,1);return{};},generate:async()=>({forecast:{run_id:'SYNTHETIC_NEW'}}),publishIndex:async()=>{}};
 assert.equal((await cycle(options)).status,'completed');
 const folders=await fs.readdir(path.join(root,'m1-observations')),result=JSON.parse(await fs.readFile(path.join(root,'m1-observations',folders[0],'result.json')));
 assert.equal(result.publication_committed,true);assert.deepEqual(result.old_results,{status:'failed',reason:'SYNTHETIC_FALLBACK_FAILURE'});
 assert.deepEqual(JSON.parse(await fs.readFile(path.join(root,'m1-observations',folders[0],'old-results-failure.json'))),result.old_results);
 assert.equal((await cycle(options)).reason,'duplicate_slot');assert.equal(fallbackCalls,1);assert.equal(freezeCalls,1);
 const released=await businessMutex({dataRoot:root,port,releaseId:'after'});assert.equal(released.status,'ACQUIRED');await released.close();
});

test('experiment policy mismatch pauses candidate but still completes production publication',async t=>{
 const {experimentStore}=await import('../scripts/m1-experiments.mjs');const {root,port}=await fixture(t),store=experimentStore(root),old={feedback:'F0',additional_inputs:'none'},current={...old,additional_inputs:'calendar'};
 await store.create(old,{...old,feedback:'F1'},{guard:async()=>{}});let generated=0;
 const result=await cycle({dataRoot:root,mutexPort:port,releaseId:'SYNTHETIC',clock:()=>Date.parse('2026-09-15T17:47:00Z'),resolvePolicy:async()=>current,
 registerOpportunity:(slot,options)=>store.register(slot,options.policy,options),prepareCandidate:async registration=>{assert.equal(registration,null);return null;},
 freeze:async({policy})=>{assert.deepEqual(policy,current);return{};},generate:async()=>{generated++;return{forecast:{run_id:'SYNTHETIC'}};},publishIndex:async()=>{}});
 assert.equal(result.status,'completed');assert.equal(generated,1);assert.equal(await store.paused(),true);
});
