import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publicationHealth,observePublicationHealth} from '../scripts/m1-publication-health.mjs';
import {scheduledSlot} from '../scripts/m1-cycle.mjs';
import {alertStore} from '../scripts/m1-alerts.mjs';
const anchor=Date.parse('2026-09-15T07:45:00Z'),due=anchor+1020000,since='2026-09-15T05:47:00.000Z';
const id=(offset=120000,n=1)=>'m1-'+new Date(anchor+offset).toISOString().replace(/[-:.]/g,'')+'-00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const make=(entries=[])=>({listRunIds:async()=>entries.map(x=>x[0]),readRun:async key=>{const value=entries.find(x=>x[0]===key)[1];if(value instanceof Error)throw value;return{forecast:value};}});
const good={anchor_time:anchor/1000,status:'valid',published_at:new Date(anchor+600000).toISOString()};
const health=(reader=make(),options={})=>publicationHealth({reader,paused:false,expectedSince:since,now:due,...options});
test('fixed Shanghai slot boundary, explicit activation and pause exclude invented historical failures',async()=>{
 const before=await health(make(),{now:due-1});assert.equal(before.slots[0].anchor_time,anchor/1000-7200);
 const at=await health();assert.equal(at.status,'stalled');assert.equal(at.slots[0].anchor_time,anchor/1000);assert.equal(at.slots.length,2);
 assert.equal(at.slots[0].slot_id,scheduledSlot(anchor).slot_id);
 assert.equal((await health(make(),{expectedSince:'2026-09-15T07:48:00.000Z'})).status,'waiting');
 assert.equal((await health(make(),{expectedSince:'2026-09-15T07:47:00.000Z'})).slots.length,1);
 assert.equal((await health(make(),{expectedSince:null})).status,'unknown');
 assert.equal((await health(make(),{expectedSince:'2026-09-16T00:00:00.000Z'})).status,'unknown');
 const reader={listRunIds:()=>{throw Error('MUST_NOT_READ');}};
 assert.equal((await health(reader,{paused:true})).status,'paused');
});
test('only verified timely production publication satisfies due slot; late, old anchor and incomplete do not',async()=>{
 assert.equal((await health(make([[id(),good]]))).status,'current');
 for(const value of [{...good,status:'late'},{...good,published_at:new Date(anchor+900000).toISOString()},{...good,anchor_time:anchor/1000-7200},new Error('PUBLICATION_MISSING')])assert.equal((await health(make([[id(),value]]))).status,'stalled');
 assert.equal((await health(make([[id(),new Error('HASH_MISMATCH')]]))).status,'unknown');
 const multiple=make([[id(),new Error('HASH_MISMATCH')],[id(121000,2),good]]);assert.equal((await health(multiple)).status,'current');
});
test('bounded per-window verification ignores unrelated history and returns unknown on exhausted bound',async()=>{
 const entries=Array.from({length:17},(_,n)=>[id(120000,n+1),new Error('PUBLICATION_MISSING')]);
 assert.equal((await health(make(entries))).status,'unknown');
 let reads=0;const reader=make([[id(-86400000),new Error('OLD')],[id(),good]]),read=reader.readRun;reader.readRun=async(...args)=>{reads++;return read(...args);};
 assert.equal((await health(reader)).status,'current');assert.equal(reads,1);
});
test('two missed slots alert once; hourly reinspection is not a second miss; unknown and pause do not recover',async t=>{
 const root=await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'mfv-publication-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=alertStore(root),guard=async()=>{};
 const single=await health(make(),{expectedSince:'2026-09-15T07:47:00.000Z'});
 for(const observationId of ['single1','single2'])assert.equal((await observePublicationHealth(store,single,{observationId,guard})).pending.length,0);
 const double=await health();const first=await observePublicationHealth(store,double,{observationId:'two',guard});assert.equal(first.pending.length,1);assert.equal(first.pending[0].severity,'warning');
 assert.equal((await observePublicationHealth(store,double,{observationId:'two',guard})).pending.length,1);
 const again={...double,checked_at:new Date(due+3600000).toISOString()};assert.equal((await observePublicationHealth(store,again,{observationId:'hourly',guard})).pending.length,1);
 for(const h of [await health(make(),{paused:true}),await health(make([[id(),new Error('HASH_MISMATCH')]]))])assert.equal((await observePublicationHealth(store,h,{observationId:'unknown',guard})).pending.length,1);
 const recovery=await health(make([[id(),good]]),{now:due+3600000});assert.equal((await observePublicationHealth(store,recovery,{observationId:'recovered',guard})).pending.at(-1).kind,'recovery');
});
