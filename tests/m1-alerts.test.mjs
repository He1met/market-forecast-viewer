import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';
import {alertStore,opsAlertCondition} from '../scripts/m1-alerts.mjs';
async function fixture(t){const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-alert-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,store:alertStore(root)};}
const epoch=Date.parse('2026-09-15T00:00:00Z'),guard=async()=>{},fault={code:'OPS_RESULTS_INCOMPLETE',object:'inspection',severity:'warning'};
const obs=(id,h=0,condition=fault)=>({task:'ops',observationId:id,at:new Date(epoch+h*3600000).toISOString(),condition,guard});
test('two observations, persistent dedup, six-hour reminder, one recovery and explicit delivery receipt',async t=>{
 const{store,root}=await fixture(t);
 assert.equal((await store.observe(obs('1'))).pending.length,0);
 const second=await store.observe(obs('2',1));assert.equal(second.pending.length,1);assert.equal(second.pending[0].kind,'fault');assert.equal(second.pending[0].delivery.status,'pending');
 assert.equal((await alertStore(root).observe(obs('2',1))).status,'duplicate');
 await assert.rejects(()=>store.observe(obs('2',2)),/OBSERVATION_CHANGED/);
 assert.equal((await store.observe(obs('3',6.999))).pending.length,1);
 const repeat=await store.observe(obs('4',7));assert.equal(repeat.pending.length,2);assert.equal(repeat.pending[1].kind,'reminder');
 const recovered=await store.observe(obs('5',8,null));assert.equal(recovered.pending.length,3);assert.equal(recovered.pending[2].kind,'recovery');
 assert.equal((await store.observe(obs('6',9,null))).pending.length,3);
 await assert.rejects(()=>store.acknowledge({eventId:second.pending[0].id,guard}),/RECEIPT_REQUIRED/);
 const receipt={channel:'official-task',id:'SYNTHETIC-receipt',delivered_at:new Date(epoch+10*3600000).toISOString()};
 assert.equal((await store.acknowledge({eventId:second.pending[0].id,receipt,guard})).status,'acknowledged');
 assert.equal((await store.acknowledge({eventId:second.pending[0].id,receipt,guard})).status,'already_acknowledged');
 assert.equal((await store.pending()).length,2);
 await assert.rejects(()=>store.acknowledge({eventId:second.pending[0].id,receipt:{...receipt,id:'changed'},guard}),/DELIVERY_CHANGED/);
});
test('critical faults notify immediately, escalation bypasses throttle, pause never claims recovery',async t=>{
 const{store}=await fixture(t);await store.observe(obs('1'));await store.observe(obs('2',1));
 const high={...fault,severity:'critical'};assert.equal((await store.observe(obs('3',1.1,high))).pending.length,2);
 assert.equal((await store.observe({...obs('4',2,null),paused:true})).pending.length,2);
 assert.equal((await store.observe(obs('5',3,high))).pending.length,2);
 assert.equal((await store.observe(obs('6',4,null))).pending.at(-1).kind,'recovery');
 assert.equal((await store.observe(obs('7',5,high))).pending.at(-1).kind,'fault');
 await assert.rejects(()=>store.observe(obs('8',4)),/TIME_REVERSED/);
});
test('failed commit is retryable; uncertain successful commit is deduplicated; corrupt state fails closed',async t=>{
 const{store,root}=await fixture(t);let calls=0;
 await assert.rejects(()=>store.observe({...obs('1',0,{...fault,severity:'critical'}),guard:async()=>{if(++calls===2)throw Error('GUARD_LOST');}}),/GUARD_LOST/);
 assert.equal((await store.pending()).length,0);
 assert.equal((await store.observe(obs('1',0,{...fault,severity:'critical'}))).pending.length,1);
 assert.equal((await alertStore(root).observe(obs('1',0,{...fault,severity:'critical'}))).pending.length,1);
 await fs.writeFile(path.join(root,'m1-control/alerts.json'),'{}');await assert.rejects(()=>store.pending(),/STATE_INVALID/);
});
test('ordinary failure is deferred; storage and integrity errors are immediate without exposing raw paths',()=>{
 assert.equal(opsAlertCondition({status:'completed'}),null);
 assert.equal(opsAlertCondition({status:'failed',reason:'fetch failed'}).severity,'warning');
 assert.equal(opsAlertCondition({status:'failed',reason:'EACCES /private/file'}).code,'PERMISSION_OR_AUTH');
 assert.equal(opsAlertCondition({status:'failed',reason:'ENOSPC /private/file'}).severity,'critical');
 assert.equal(opsAlertCondition({status:'failed',reason:'PACKAGE_HASH_MISMATCH'}).severity,'critical');
});
